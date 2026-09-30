import { Page, Locator } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { env } from '../../config/env.js';
import { humanClick, humanDelay } from '../../core/browser.js';
import { AppointmentSlot, CalendarDayInfo, ScrapeRunReport } from '../../types/index.js';

export class CalendarParser {
  private readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /**
   * Captures a screenshot when slots are found for immediate verification.
   */
  public async captureSlotFoundScreenshot(): Promise<string | undefined> {
    const screenshotDir = path.resolve(process.cwd(), 'screenshots');
    if (!fs.existsSync(screenshotDir)) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }
    const filename = path.join(screenshotDir, `slot_found_${Date.now()}.png`);
    await this.page.screenshot({ path: filename, fullPage: false }).catch(() => {});
    return filename;
  }

  /**
   * Identifies the current month and year displayed on the calendar header.
   */
  public async getCalendarHeader(): Promise<string> {
    // 1. Look for month year pattern in calendar container
    const monthRegex = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/i;

    const calendarHeaderCandidates = [
      'div:has(> h2:has-text("Select a date")) span',
      'div:has(> h2:has-text("Select a date")) div',
      'div:has-text("Select a date") span',
      'div:has-text("Select a date") h2',
      'div:has-text("Select a date") h3',
      '.fc-toolbar-title',
      '.calendar-header',
      '.month-title',
    ];

    for (const selector of calendarHeaderCandidates) {
      const locators = this.page.locator(selector);
      const count = await locators.count();
      for (let i = 0; i < count; i++) {
        const text = (await locators.nth(i).textContent().catch(() => ''))?.trim() || '';
        const match = text.match(monthRegex);
        if (match) {
          return match[0];
        }
      }
    }

    // Direct text search in main container rather than entire page body
    const mainText = (await this.page.locator('main, #root, #app, [class*="calendar"]').first().textContent().catch(() => '')) || '';
    const match = mainText.match(monthRegex);
    if (match) {
      return match[0];
    }

    return 'Current Month';
  }

  /**
   * Evaluates if a day card/tile is available or disabled based on Capago's DOM attributes and styling.
   */
  private async evaluateDayCell(cell: Locator): Promise<{ isAvailable: boolean; dateStr: string; dayNum: number }> {
    return await cell.evaluate((el) => {
      const text = el.textContent?.trim() || '';
      const classList = el.className.toLowerCase();

      // Extract day number (e.g. from "Tue1Sep" or "Tue 22 Dec")
      const dayMatch = text.match(/[A-Za-z]{3}(\d{1,2})/) || text.match(/\b([1-9]|[12]\d|3[01])\b/);
      const dayNum = dayMatch && dayMatch[1] ? parseInt(dayMatch[1], 10) : 0;

      if (dayNum === 0) {
        return { isAvailable: false, dateStr: '', dayNum: 0 };
      }

      // Check standard disabled markers
      const isDisabledAttr = el.hasAttribute('disabled') || (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true';
      const hasDisabledClass =
        classList.includes('opacity-40') ||
        classList.includes('cursor-not-allowed') ||
        classList.includes('disabled') ||
        classList.includes('is-disabled') ||
        classList.includes('past') ||
        classList.includes('booked');

      // Available check: not explicitly disabled, pointer cursor or has active class/border
      const isAvailable = !isDisabledAttr && !hasDisabledClass;
      const dateAttr = el.getAttribute('data-date') || el.getAttribute('aria-label') || `${dayNum}`;

      return {
        isAvailable,
        dateStr: dateAttr,
        dayNum,
      };
    });
  }

  /**
   * Scans the "Available time slots" side panel for concrete hours (Classic and Prime Time slots).
   */
  public async extractTimeSlotsForSelectedDay(dateStr: string): Promise<AppointmentSlot[]> {
    const slots: AppointmentSlot[] = [];

    // Check if "Available time slots" panel is visible
    const panelLocator = this.page.locator('text="Available time slots"').first();
    if (!(await panelLocator.isVisible({ timeout: 2500 }).catch(() => false))) {
      return slots;
    }

    // Process all slot cards in panel
    // As seen in screenshot: e.g. "09:00\nMorning", "14:00\nAfternoon"
    const slotCardSelectors = [
      'div:has-text("Classic Slots") ~ div button',
      'div:has-text("Available time slots") button:has-text(":")',
      'div:has-text("Available time slots") [class*="slot"]',
      'button:has-text("Morning"), button:has-text("Afternoon")',
      'div[class*="slot"]:has-text(":")',
    ];

    const scrapeCurrentSlotPage = async () => {
      for (const sel of slotCardSelectors) {
        const items = this.page.locator(sel);
        const count = await items.count();
        if (count > 0) {
          for (let i = 0; i < count; i++) {
            const item = items.nth(i);
            const text = (await item.textContent().catch(() => ''))?.trim() || '';
            const timeMatch = text.match(/\b([01]?\d|2[0-3]):[0-5]\d\b/);

            if (timeMatch) {
              const time = timeMatch[0];
              const period = text.includes('Morning') ? 'Morning' : text.includes('Afternoon') ? 'Afternoon' : undefined;
              const isDisabled =
                (await item.getAttribute('disabled')) !== null ||
                (await item.getAttribute('aria-disabled')) === 'true' ||
                (await item.evaluate((el) => el.classList.contains('disabled')));

              // Avoid duplicate timestamps
              if (!slots.some((s) => s.time === time)) {
                slots.push({
                  date: dateStr,
                  time,
                  period,
                  slotType: 'classic',
                  isAvailable: !isDisabled,
                  status: !isDisabled ? 'available' : 'disabled',
                  rawText: text,
                });
              }
            }
          }
          break;
        }
      }
    };

    // Scrape first page of slots
    await scrapeCurrentSlotPage();

    // Check if slot pagination exists: e.g. < 1/2 >
    const nextSlotPageBtn = this.page.locator('div:has-text("Classic Slots") button:has-text(">")').first();
    if (await nextSlotPageBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      const isDisabled = (await nextSlotPageBtn.getAttribute('disabled')) !== null;
      if (!isDisabled) {
        await nextSlotPageBtn.click().catch(() => {});
        await humanDelay(400, 800);
        await scrapeCurrentSlotPage();
      }
    }

    return slots;
  }

  /**
   * Advances the calendar view to the next month using the header navigation button.
   */
  public async paginateNextMonth(): Promise<boolean> {
    const calendarCard = this.page.locator('div:has(> h2:has-text("Select a date"))').first();
    const svgButtons = calendarCard.locator('button:has(svg)');
    const svgCount = await svgButtons.count();

    if (svgCount >= 2) {
      const nextBtn = svgButtons.nth(1); // second button is next month chevron >
      if (await nextBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
        const isDisabled = await nextBtn.isDisabled().catch(() => false);
        if (!isDisabled) {
          console.log(`[Calendar] Paginating to next month via chevron button...`);
          await nextBtn.click();
          await this.page.waitForLoadState('networkidle').catch(() => {});
          await humanDelay(1200, 2200);
          return true;
        }
      }
    }

    // Fallback selectors
    const nextButtons = [
      'div:has-text("Select a date") button:has-text(">")',
      'div:has-text("December") ~ button',
      'div:has-text("September") ~ button',
      'button:has-text(">")',
      '.fc-next-button',
      'button[aria-label*="next" i]',
    ];

    for (const selector of nextButtons) {
      const btn = this.page.locator(selector).first();
      if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
        console.log(`[Calendar] Paginating to next month via: ${selector}`);
        await humanClick(this.page, selector);
        await humanDelay(1200, 2200);
        return true;
      }
    }

    return false;
  }

  /**
   * Core parsing method: Scans current and upcoming months for available appointment slots.
   */
  public async scanCalendar(monthsToScan = 2): Promise<ScrapeRunReport> {
    const report: ScrapeRunReport = {
      timestamp: new Date().toISOString(),
      center: env.CAPAGO_CENTER,
      category: env.CAPAGO_CATEGORY,
      totalDaysScanned: 0,
      availableDays: [],
      availableSlots: [],
      hasAvailableSlots: false,
    };

    console.log(`[Calendar] Initiating calendar scan (scanning up to ${monthsToScan} months)...`);

    for (let monthIndex = 0; monthIndex < monthsToScan; monthIndex++) {
      const headerTitle = await this.getCalendarHeader();
      console.log(`[Calendar] Scanning month view [${headerTitle}] (Month ${monthIndex + 1}/${monthsToScan})...`);

      // Match all day cells / tiles in the "Select a date" calendar grid
      const dayCellSelectors = [
        'button:has-text("Mon"), button:has-text("Tue"), button:has-text("Wed"), button:has-text("Thu"), button:has-text("Fri"), button:has-text("Sat"), button:has-text("Sun")',
        'div:has-text("Select a date") ~ div button',
        'div:has-text("Select a date") div[class*="day"]',
        'div:has-text("Select a date") button',
      ];

      let cellLocator: Locator | null = null;
      for (const sel of dayCellSelectors) {
        const loc = this.page.locator(sel);
        const count = await loc.count();
        if (count >= 20) {
          // A full month grid has 28-35 cells
          cellLocator = loc;
          break;
        }
      }

      if (cellLocator) {
        const cellCount = await cellLocator.count();
        report.totalDaysScanned += cellCount;
        console.log(`[Calendar] Inspecting ${cellCount} day tiles in current view...`);

        for (let i = 0; i < cellCount; i++) {
          const cell = cellLocator.nth(i);
          const evaluation = await this.evaluateDayCell(cell);

          if (evaluation.isAvailable && evaluation.dayNum > 0) {
            console.log(`[Calendar] >> AVAILABLE DAY DETECTED: Day ${evaluation.dayNum} (${headerTitle})!`);

            // Click the available day to open the "Available time slots" sidebar
            await cell.click({ delay: 100 }).catch(() => {});
            await humanDelay(800, 1500);

            const timeSlots = await this.extractTimeSlotsForSelectedDay(`${headerTitle} - Day ${evaluation.dayNum}`);

            const dayInfo: CalendarDayInfo = {
              date: `${headerTitle} - Day ${evaluation.dayNum}`,
              dayNumber: evaluation.dayNum,
              month: monthIndex + 1,
              year: new Date().getFullYear(),
              isAvailable: true,
              slots: timeSlots,
            };

            report.availableDays.push(dayInfo);

            if (timeSlots.length > 0) {
              const availableTimeSlots = timeSlots.filter((s) => s.isAvailable);
              report.availableSlots.push(...availableTimeSlots);
              console.log(`[Calendar] Extracted ${availableTimeSlots.length} available time slots for Day ${evaluation.dayNum}.`);
            } else {
              report.availableSlots.push({
                date: `${headerTitle} - Day ${evaluation.dayNum}`,
                isAvailable: true,
                status: 'available',
                rawText: `Day ${evaluation.dayNum} open`,
              });
            }
          }
        }
      } else {
        console.warn(`[Calendar] No standard day grid matched. Checking page for slot text indicators...`);
      }

      // Paginate to next month if requested
      if (monthIndex < monthsToScan - 1) {
        const paginated = await this.paginateNextMonth();
        if (!paginated) {
          console.log(`[Calendar] Next month pagination not available. Ending calendar scan.`);
          break;
        }
      }
    }

    report.hasAvailableSlots = report.availableSlots.length > 0 || report.availableDays.length > 0;

    if (report.hasAvailableSlots) {
      console.log(`[Calendar] !!! SLOTS FOUND: ${report.availableSlots.length} slot(s) across ${report.availableDays.length} day(s) !!!`);
      await this.captureSlotFoundScreenshot();
    } else {
      console.log(`[Calendar] Scan completed: 0 available slots found (${report.totalDaysScanned} day tiles evaluated).`);
    }

    return report;
  }
}
