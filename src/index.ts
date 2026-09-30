import http from 'node:http';
import { env } from './config/env.js';
import { initStealthBrowser } from './core/browser.js';
import { calculateNextInterval, JitterInterval } from './core/scheduler.js';
import { SessionManager } from './modules/auth/session.manager.js';
import { FormStepper } from './modules/navigation/form.stepper.js';
import { CalendarParser } from './modules/scraper/calendar.parser.js';
import { telegramNotifier } from './modules/notifier/telegram.js';
import { telegramBotService } from './modules/bot/telegram.bot.js';
import { botStorage } from './modules/bot/bot.storage.js';
import { ApplicantProfile, ScrapeRunReport, UserBotSession } from './types/index.js';

class CapagoMonitor {
  private readonly abortController = new AbortController();
  private isRunning = false;
  private isCycleRunning = false;
  private readonly sessionManager = new SessionManager();
  private nextScheduledRunTime: number | null = null;
  private wakeSchedulerResolver: (() => void) | null = null;
  private cycleCount = 0;

  constructor() {
    this.registerSignalHandlers();
  }

  private registerSignalHandlers(): void {
    const shutdown = async (signal: string) => {
      console.log(`\n[Monitor] Received ${signal}. Initiating graceful shutdown...`);
      this.isRunning = false;
      this.abortController.abort();
      this.wakeScheduler();
      telegramBotService.stop();
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  }

  /**
   * Calculates and schedules the next monitoring interval.
   * This interval starts strictly AFTER a monitoring check completes.
   */
  public scheduleNextCheck(): JitterInterval {
    const interval = calculateNextInterval();
    this.nextScheduledRunTime = Date.now() + interval.totalMs;
    console.log(
      `[Scheduler] Next check in ${interval.minutes}m ${interval.seconds}s (scheduled for: ${interval.nextExecutionTime.toLocaleTimeString()}).`
    );
    this.wakeScheduler();
    return interval;
  }

  public wakeScheduler(): void {
    if (this.wakeSchedulerResolver) {
      this.wakeSchedulerResolver();
      this.wakeSchedulerResolver = null;
    }
  }

  private sleepOrWake(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = null;

      const onWake = () => {
        if (timer) clearTimeout(timer);
        this.wakeSchedulerResolver = null;
        resolve();
      };

      this.wakeSchedulerResolver = onWake;

      timer = setTimeout(() => {
        this.wakeSchedulerResolver = null;
        resolve();
      }, ms);

      this.abortController.signal.addEventListener(
        'abort',
        () => {
          if (timer) clearTimeout(timer);
          this.wakeSchedulerResolver = null;
          resolve();
        },
        { once: true }
      );
    });
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

  private async runScheduledCycle(subscribers: UserBotSession[]): Promise<void> {
    if (this.isCycleRunning || telegramBotService.isBusy()) {
      return;
    }

    this.isCycleRunning = true;
    telegramBotService.setBusy(true);

    try {
      this.cycleCount++;
      console.log(`[Loop] >>> Execution Cycle #${this.cycleCount} <<<`);

      for (const sub of subscribers) {
        if (!this.isRunning || this.abortController.signal.aborted) break;
        const profile = sub.savedProfile;
        if (!profile) continue;

        console.log(
          `[Monitor] Running cycle for ${sub.username || sub.chatId} (${profile.title} ${profile.firstName} ${profile.lastName} - Passport: ${profile.passportNumber})...`
        );
        const report = await this.executeCycle(profile);
        if (report && report.hasAvailableSlots) {
          console.log(`[Monitor] Sending slot alert directly to user ${sub.chatId}...`);
          await telegramBotService.sendReportToChat(sub.chatId, report);
        }
      }

      // Start next interval countdown strictly AFTER this monitoring cycle completes!
      this.scheduleNextCheck();
    } finally {
      this.isCycleRunning = false;
      telegramBotService.setBusy(false);
    }
  }

  /**
   * Main continuous monitoring loop with randomized intervals.
   */
  public async start(): Promise<void> {
    this.isRunning = true;

    // Attach bot on-demand and post-submit check handler
    telegramBotService.setCheckHandler(async (_chatId, profile) => {
      if (this.isCycleRunning) {
        console.log(`[Monitor] Check requested, but cycle already in progress.`);
        return { report: null };
      }

      this.isCycleRunning = true;
      telegramBotService.setBusy(true);

      try {
        const report = await this.executeCycle(profile);
        // Interval countdown begins strictly AFTER this first / on-demand monitoring check completes!
        const interval = this.scheduleNextCheck();
        return { report, nextIntervalMinutes: interval.minutes };
      } finally {
        this.isCycleRunning = false;
        telegramBotService.setBusy(false);
      }
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

    let loggedNoSubscribers = false;

    while (this.isRunning && !this.abortController.signal.aborted) {
      // Retrieve all active users who entered real application profiles via Telegram
      const activeSubscribers = botStorage.getAllActiveSubscribers().filter((s) => s.savedProfile);

      if (activeSubscribers.length === 0) {
        if (!loggedNoSubscribers) {
          console.log(
            `[Monitor] ⏳ No applicant profiles configured yet via Telegram bot.\n` +
            `[Monitor] Standing by. Send /new_application to the Telegram bot to configure your real passport details.`
          );
          loggedNoSubscribers = true;
        }
        // Sleep in short 5s increments so a newly submitted application is detected immediately
        await this.sleepOrWake(5000);
        continue;
      }

      loggedNoSubscribers = false;

      // If active subscribers exist but no check has run yet and none is scheduled (e.g. startup):
      if (this.nextScheduledRunTime === null) {
        console.log(`[Scheduler] Active subscriber detected on startup. Initiating first monitoring cycle...`);
        await this.runScheduledCycle(activeSubscribers);
        continue;
      }

      const now = Date.now();
      if (now < this.nextScheduledRunTime) {
        // Interval is actively running countdown after the previous monitoring finished
        const waitMs = Math.min(this.nextScheduledRunTime - now, 10000);
        await this.sleepOrWake(waitMs);
        continue;
      }

      // Interval has elapsed! Execute scheduled monitoring cycle:
      if (!this.isCycleRunning && !telegramBotService.isBusy()) {
        await this.runScheduledCycle(activeSubscribers);
      } else {
        await this.sleepOrWake(3000);
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
