import http from 'node:http';
import { env } from './config/env.js';
import { initStealthBrowser } from './core/browser.js';
import { calculateNextInterval, sleepWithSignal } from './core/scheduler.js';
import { SessionManager } from './modules/auth/session.manager.js';
import { FormStepper } from './modules/navigation/form.stepper.js';
import { CalendarParser } from './modules/scraper/calendar.parser.js';
import { telegramNotifier } from './modules/notifier/telegram.js';
import { telegramBotService } from './modules/bot/telegram.bot.js';
import { botStorage } from './modules/bot/bot.storage.js';
import { ApplicantProfile, ScrapeRunReport } from './types/index.js';

class CapagoMonitor {
  private readonly abortController = new AbortController();
  private isRunning = false;
  private readonly sessionManager = new SessionManager();

  constructor() {
    this.registerSignalHandlers();
  }

  private registerSignalHandlers(): void {
    const shutdown = async (signal: string) => {
      console.log(`\n[Monitor] Received ${signal}. Initiating graceful shutdown...`);
      this.isRunning = false;
      this.abortController.abort();
      telegramBotService.stop();
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  }

  /**
   * Performs an isolated scraping iteration using fresh stealth context with saved session.
   */
  public async executeCycle(profile?: ApplicantProfile): Promise<ScrapeRunReport | null> {
    const cycleStart = Date.now();
    const targetCategory = profile?.category || env.CAPAGO_CATEGORY;
    const targetCenter = profile?.center || env.CAPAGO_CENTER;
    const who = profile ? `${profile.firstName} ${profile.lastName}` : 'default';

    telegramBotService.logActivity(`🔄 Cycle started for *${who}* (${targetCenter} / ${targetCategory})`);

    const { browser, context, page } = await initStealthBrowser();

    try {
      // 1. Session verification & authentication
      const authResult = await this.sessionManager.ensureAuthenticated(page, context);
      if (!authResult.authenticated) {
        telegramBotService.logActivity(`❌ Authentication failed — check Capago credentials`);
        return null;
      }
      telegramBotService.logActivity(`✅ Authenticated on Capago portal`);

      // 2. Navigate 6-step form progression to Calendar
      const formStepper = new FormStepper(page, profile);
      const navResult = await formStepper.navigateToCalendar();

      if (!navResult.success) {
        telegramBotService.logActivity(`⚠️ Could not reach Calendar — will retry next cycle`);
        return null;
      }
      telegramBotService.logActivity(`📅 Calendar reached — scanning ${profile?.monthsToScan || env.MONTHS_TO_SCAN} month(s)`);

      // 3. Parse Calendar DOM for slots
      const monthsAhead = profile?.monthsToScan || env.MONTHS_TO_SCAN;
      const calendarParser = new CalendarParser(page);
      const report = await calendarParser.scanCalendar(monthsAhead);

      // 4. Alerting via Telegram Bot & Notifier
      const elapsedSec = Math.round((Date.now() - cycleStart) / 1000);
      if (report.hasAvailableSlots) {
        telegramBotService.logActivity(`🚨 SLOTS FOUND! ${report.availableSlots.length} slot(s) on ${report.availableDays.length} day(s) — alerts dispatched!`);
        const screenshotPath = await calendarParser.captureSlotFoundScreenshot();
        await telegramBotService.broadcastAlert(report, screenshotPath);
        await telegramNotifier.sendAlert(report);
      } else {
        telegramBotService.logActivity(`✅ Cycle done in ${elapsedSec}s — no slots found (${report.totalDaysScanned} days scanned)`);
      }

      return report;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      telegramBotService.logActivity(`❌ Cycle error: ${msg.slice(0, 80)}`);
      console.error(`[Monitor] Error during cycle:`, msg);
      return null;
    } finally {
      // Clean up browser context after each iteration to prevent fingerprint tracking & memory leaks
      await page.close().catch(() => {});
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }


  /**
   * Main continuous monitoring loop with randomized intervals.
   */
  public async start(): Promise<void> {
    this.isRunning = true;

    // Attach bot on-demand check handler
    telegramBotService.setCheckHandler(async (_chatId, profile) => {
      return await this.executeCycle(profile);
    });

    // Start Telegram bot listener if configured
    if (telegramBotService.isConfigured()) {
      await telegramBotService.start();
    }

    // Start lightweight health-check server for cloud hosts (Render, Koyeb, Railway, Fly.io)
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
    const healthServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          service: 'capago-slot-monitor',
          activeSubscribers: botStorage.getAllActiveSubscribers().filter((s) => s.savedProfile).length,
          timestamp: new Date().toISOString(),
        })
      );
    });
    healthServer.listen(port, () => {
      console.log(`[Server] Health-check endpoint listening on port ${port}`);
    });

    console.log(`======================================================`);
    console.log(`  CAPAGO VISA SLOT MONITOR (STEALTH AUTOMATION)       `);
    console.log(`======================================================`);
    console.log(`Portal URL:       ${env.CAPAGO_PORTAL_URL}`);
    console.log(`Target Center:    ${env.CAPAGO_CENTER}`);
    console.log(`Target Category:  ${env.CAPAGO_CATEGORY}`);
    console.log(`Check Interval:   ${env.MIN_CHECK_INTERVAL_MINUTES} - ${env.MAX_CHECK_INTERVAL_MINUTES} mins (randomized)`);
    console.log(`Months Ahead:     ${env.MONTHS_TO_SCAN} month(s)`);
    console.log(`Headless:         ${env.HEADLESS}`);
    console.log(`Telegram Bot:     ${telegramBotService.isConfigured() ? 'Active (Commands & Alerts)' : 'Disabled (Set TELEGRAM_BOT_TOKEN)'}`);
    console.log(`======================================================\n`);

    let cycleCount = 0;

    while (this.isRunning && !this.abortController.signal.aborted) {
      cycleCount++;
      console.log(`[Loop] >>> Execution Cycle #${cycleCount} <<<`);

      // Retrieve all active users who entered real application profiles via Telegram
      const activeSubscribers = botStorage.getAllActiveSubscribers().filter((s) => s.savedProfile);

      if (activeSubscribers.length === 0) {
        console.log(
          `[Monitor] ⏳ No applicant profiles configured yet via Telegram bot.\n` +
          `[Monitor] Standing by. Send /new_application to the Telegram bot to configure your real passport details.`
        );
      } else {
        for (const sub of activeSubscribers) {
          if (!this.isRunning || this.abortController.signal.aborted) break;
          const profile = sub.savedProfile!;
          console.log(
            `[Monitor] Running cycle for ${sub.username || sub.chatId} (${profile.title} ${profile.firstName} ${profile.lastName} - Passport: ${profile.passportNumber})...`
          );
          const report = await this.executeCycle(profile);
          if (report && report.hasAvailableSlots) {
            console.log(`[Monitor] Sending slot alert directly to user ${sub.chatId}...`);
            await telegramBotService.sendReportToChat(sub.chatId, report);
          }
        }
      }

      if (!this.isRunning || this.abortController.signal.aborted) {
        break;
      }

      const interval = calculateNextInterval();
      console.log(
        `[Scheduler] Next check in ${interval.minutes}m ${interval.seconds}s (scheduled for: ${interval.nextExecutionTime.toLocaleTimeString()}). Sleeping...`
      );

      try {
        await sleepWithSignal(interval.totalMs, this.abortController.signal);
      } catch {
        break; // Aborted
      }
    }

    console.log(`[Monitor] Monitoring loop terminated cleanly.`);
  }
}

// Bootstrap
const monitor = new CapagoMonitor();
monitor.start().catch((err) => {
  console.error(`[Fatal] Monitor crashed:`, err);
  process.exit(1);
});
