import { Page, Locator } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { env } from '../../config/env.js';
import { humanClick, humanDelay, humanType } from '../../core/browser.js';
import { NavigationStep, StepNavigationResult, ApplicantProfile } from '../../types/index.js';

function normalizeDate(raw: string): string {
  const trimmed = raw.trim();
  // If YYYY-MM-DD
  const isoMatch = trimmed.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (isoMatch && isoMatch[1] && isoMatch[2] && isoMatch[3]) {
    const y = isoMatch[1];
    const m = isoMatch[2].padStart(2, '0');
    const d = isoMatch[3].padStart(2, '0');
    return `${d}/${m}/${y}`;
  }
  // If D/M/YYYY or DD.MM.YYYY
  const dmMatch = trimmed.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (dmMatch && dmMatch[1] && dmMatch[2] && dmMatch[3]) {
    const d = dmMatch[1].padStart(2, '0');
    const m = dmMatch[2].padStart(2, '0');
    const y = dmMatch[3];
    return `${d}/${m}/${y}`;
  }
  return trimmed;
}

export class FormStepper {
  private readonly page: Page;
  private readonly profile?: Partial<ApplicantProfile>;

  constructor(page: Page, profile?: Partial<ApplicantProfile>) {
    this.page = page;
    this.profile = profile;
  }

  private async captureStepSnapshot(stepName: string): Promise<string | undefined> {
    if (!env.DEBUG_SCREENSHOTS) return undefined;
    const screenshotDir = path.resolve(process.cwd(), 'screenshots');
    if (!fs.existsSync(screenshotDir)) {
      fs.mkdirSync(screenshotDir, { recursive: true });
    }
    const filename = path.join(screenshotDir, `${Date.now()}_step_${stepName.toLowerCase()}.png`);
    await this.page.screenshot({ path: filename, fullPage: false }).catch(() => {});
    return filename;
  }

  /**
   * Identifies the current step in the booking wizard based on page DOM selectors.
   */
  public async detectCurrentStep(): Promise<NavigationStep> {
    // 1. Step 1: Prerequisites (Has unique "I accept, continue" button)
    if (
      await this.page
        .locator('button:has-text("I accept, continue"), button:has-text("accept, continue")')
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false)
    ) {
      return 'PREREQUISITES';
    }

    // 2. Step 6: Calendar (Has unique date selection or available slots panel)
    const isCalendar =
      (await this.page.locator('text="Select a date", text="Available time slots", button:has-text("Confirm Appointment")').count()) > 0;
    if (isCalendar) {
      return 'CALENDAR_ROUTE';
    }

    // 3. Step 3a: Applicant Count (Has unique "Save and continue" button)
    if (
      await this.page
        .locator('button:has-text("Save and continue")')
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false)
    ) {
      return 'APPLICANT_COUNT';
    }

    // 4. Step 3b: Applicant Details Form (Has passport placeholder Ex: AB1234567)
    if (
      await this.page
        .locator('input[placeholder*="AB1234567" i]')
        .first()
        .isVisible({ timeout: 500 })
        .catch(() => false)
    ) {
      return 'APPLICANT_DETAILS';
    }

    const mainText = (await this.page.locator('main, #root, #app, form').first().textContent().catch(() => '')) || '';

    // 5. Step 4b: Travel Project Review Summary
    if (mainText.includes('Visa Type :') || (await this.page.locator('text="Visa Type :"').count()) > 0) {
      return 'TRAVEL_PROJECT_REVIEW';
    }

    // 6. Step 4a: Travel Project Selection Form (Duration of stay)
    if (
      mainText.includes('Duration of stay') ||
      (await this.page.locator('text="Duration of stay", text="Short stay"').count()) > 0
    ) {
      return 'TRAVEL_PROJECT';
    }

    // 7. Step 2: Submission Location
    if (
      mainText.includes('Capago Center - Baku') ||
      mainText.includes('Centre Capago - Baku') ||
      (await this.page.locator('text="Selected center", text="Centre Capago"').count()) > 0
    ) {
      return 'SUBMISSION_LOCATION';
    }

    // 8. Step 5: Additional Services sub-screens
    if (mainText.includes('Schengen Travel Insurance') || (await this.page.locator('text="Schengen Travel Insurance"').count()) > 0) {
      return 'SERVICE_INSURANCE';
    }
    if (
      mainText.includes('Choose the All-Inclusive Service') ||
      mainText.includes('Prepare your visa application with full peace of mind') ||
      (await this.page.locator('button:has-text("Continue without this service")').count()) > 0
    ) {
      return 'SERVICE_ALL_INCLUSIVE';
    }
    if (mainText.includes('Discover Capago services to facilitate your application')) {
      return 'SERVICE_OVERVIEW';
    }
    if (
      mainText.includes('Additional services') ||
      mainText.includes('Additional Services Cart') ||
      mainText.includes('Service ')
    ) {
      return 'SERVICE_OPTIONS';
    }

    return 'DASHBOARD';
  }

  /**
   * Step 1: Handle Prerequisites (Accept terms & all 6 checkboxes)
   */
  public async handlePrerequisites(): Promise<StepNavigationResult> {
    const start = Date.now();
    console.log(`[Navigation] Step 1: Handling Prerequisites & Consent Checkboxes...`);

    try {
      const checkboxes = this.page.locator('input[type="checkbox"]');
      const count = await checkboxes.count();
      console.log(`[Navigation] Step 1: Clicking ${count} consent checkboxes...`);

      for (let i = 0; i < count; i++) {
        const cb = checkboxes.nth(i);
        const isChecked = await cb.isChecked().catch(() => false);
        if (!isChecked) {
          await cb.click({ force: true }).catch(() => {});
          await humanDelay(100, 200);
        }
      }

      await humanDelay(400, 800);

      const acceptBtn = this.page.locator('button:has-text("I accept, continue"), button:has-text("accept, continue")').first();
      await acceptBtn.waitFor({ state: 'visible', timeout: 5000 });
      await acceptBtn.click();

      await this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await humanDelay(1000, 2000);
      await this.captureStepSnapshot('prerequisites_accepted');

      return {
        step: 'PREREQUISITES',
        success: true,
        url: this.page.url(),
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        step: 'PREREQUISITES',
        success: false,
        url: this.page.url(),
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Step 2: Handle Submission Location (Verify Baku center & Next step)
   */
  public async handleSubmissionLocation(): Promise<StepNavigationResult> {
    const start = Date.now();
    console.log(`[Navigation] Step 2: Confirming Submission Location: "${env.CAPAGO_CENTER}"...`);

    try {
      const nextBtn = this.page.locator('button:has-text("Next step")').first();
      await nextBtn.waitFor({ state: 'visible', timeout: 5000 });
      await nextBtn.click();

      await this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await humanDelay(1000, 2000);
      await this.captureStepSnapshot('location_confirmed');

      return {
        step: 'SUBMISSION_LOCATION',
        success: true,
        url: this.page.url(),
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        step: 'SUBMISSION_LOCATION',
        success: false,
        url: this.page.url(),
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Step 3a: Handle Number of Applicants (Set count to 1 & Save and continue)
   */
  public async handleApplicantCount(): Promise<StepNavigationResult> {
    const start = Date.now();
    console.log(`[Navigation] Step 3a: Setting Applicant Count to 1...`);

    try {
      const saveBtn = this.page.locator('button:has-text("Save and continue")').first();
      await saveBtn.waitFor({ state: 'visible', timeout: 5000 });
      await saveBtn.click();

      await this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await humanDelay(1000, 2000);
      await this.captureStepSnapshot('applicant_count_saved');

      return {
        step: 'APPLICANT_COUNT',
        success: true,
        url: this.page.url(),
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        step: 'APPLICANT_COUNT',
        success: false,
        url: this.page.url(),
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Step 3b: Handle Main Applicant Form Details
   */
  public async handleApplicantDetails(): Promise<StepNavigationResult> {
    const start = Date.now();
    console.log(`[Navigation] Step 3b: Filling Main Applicant Form with verified user data...`);

    try {
      if (
        !this.profile ||
        !this.profile.firstName?.trim() ||
        !this.profile.lastName?.trim() ||
        !this.profile.passportNumber?.trim() ||
        !this.profile.dob?.trim() ||
        !this.profile.phone?.trim() ||
        !this.profile.departureDate?.trim()
      ) {
        throw new Error(
          `[FormStepper] ABORTED: Missing required applicant details. To prevent visa rejection/cancellation, Capago portal navigation strictly requires real user data entered via Telegram (/new_application).`
        );
      }

      // 1. Title dropdown (mr / miss / mrs / ms)
      const titleValue = (this.profile.title || 'mr').trim().toLowerCase();
      const titleSelect = this.page.locator('select:not([aria-label*="lang" i])').first();
      if (await titleSelect.isVisible({ timeout: 2000 }).catch(() => false)) {
        await titleSelect.selectOption({ value: titleValue }).catch(async () => {
          await titleSelect.selectOption({ index: 1 });
        });
      }

      // 2. Date of Birth (normalized dd/mm/yyyy)
      const rawDob = this.profile.dob.trim();
      const dobInput = this.page.locator('input[placeholder="dd/mm/yyyy"]').first();
      await dobInput.click();
      await dobInput.fill(normalizeDate(rawDob));

      // 3. First name (trimmed as on passport)
      const rawFirstName = this.profile.firstName.trim();
      const fnInput = this.page.locator('input[placeholder="As it appears on the passport"]').first();
      await fnInput.click();
      await fnInput.fill(rawFirstName);

      // 4. Surname (trimmed as on passport)
      const rawLastName = this.profile.lastName.trim();
      const snInput = this.page.locator('input[placeholder="As it appears on the passport"]').nth(1);
      await snInput.click();
      await snInput.fill(rawLastName);

      // 5. Passport number (trimmed & uppercase, no spaces)
      const rawPassport = this.profile.passportNumber.replace(/\s+/g, '').toUpperCase();
      const passInput = this.page.locator('input[placeholder="Ex: AB1234567"]').first();
      await passInput.click();
      await passInput.fill(rawPassport);

      // 6. France-Visas Radio ("Do you need help with your France-Visas form?")
      // Option 1: Already have official FRA reference number (france-visas.gouv.fr)
      // Option 2: Need Capago assistance (24 AZN / applicant) - prevents consular rejection from invalid FRA numbers
      const radios = this.page.locator('input[name="franceVisasChoice-0"]');
      const needsAssistance = Boolean(
        this.profile.needsFranceVisasAssistance || !this.profile.franceVisasRef
      );

      if (needsAssistance) {
        console.log('[Navigation] Step 3b: Selecting Option 2: Assistance with France-Visas form (24 AZN)...');
        await radios.nth(1).click({ force: true });
        await humanDelay(300, 500);
      } else {
        console.log('[Navigation] Step 3b: Selecting Option 1: Already have official France-Visas reference number...');
        await radios.nth(0).click({ force: true });
        await humanDelay(300, 500);

        const fraRef = (this.profile.franceVisasRef || '').trim().toUpperCase();
        if (fraRef) {
          const fraInput = this.page.locator('input[placeholder*="FRA"]');
          if (await fraInput.isVisible({ timeout: 2500 }).catch(() => false)) {
            await fraInput.click();
            await fraInput.fill(fraRef);
          }
        }
      }

      // 8. Email and Confirm Email (identical & trimmed)
      const emailValue = (this.profile.email || env.CAPAGO_EMAIL).trim().toLowerCase();
      await this.page.locator('input[type="email"]').first().fill(emailValue);
      await this.page.locator('input[type="email"]').nth(1).fill(emailValue);

      // 9. Mobile Phone (trimmed)
      const rawPhone = this.profile.phone.trim();
      await this.page.locator('input[type="tel"]').first().fill(rawPhone);

      // 10. Departure Date (normalized dd/mm/yyyy)
      const rawDeparture = this.profile.departureDate.trim();
      const depInput = this.page.locator('input[placeholder="dd/mm/yyyy"]').nth(1);
      await depInput.click();
      await depInput.fill(normalizeDate(rawDeparture));

      await humanDelay(500, 1000);

      // Click "Next step >"
      const nextBtn = this.page.locator('button:has-text("Next step")').first();
      await nextBtn.click();

      await this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await humanDelay(1200, 2500);
      await this.captureStepSnapshot('applicant_details_submitted');

      return {
        step: 'APPLICANT_DETAILS',
        success: true,
        url: this.page.url(),
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        step: 'APPLICANT_DETAILS',
        success: false,
        url: this.page.url(),
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Step 4a: Handle Travel Project (Duration card + cascading dropdowns)
   */
  public async handleTravelProject(): Promise<StepNavigationResult> {
    const start = Date.now();
    console.log(`[Navigation] Step 4a: Selecting Travel Project Options...`);

    try {
      // 1. Duration card: Short stay (<= 90 days)
      const shortStayCard = this.page.locator('text="Short stay"').first();
      if (await shortStayCard.isVisible({ timeout: 3000 }).catch(() => false)) {
        await shortStayCard.click();
        await humanDelay(600, 1200);
      }

      // 2. Cascading native selects (Your project, Purpose of stay, Visa variation, Situation)
      const categoryValue = this.profile?.category || env.CAPAGO_CATEGORY;
      const targetValues = [
        categoryValue.toLowerCase(),
        (this.profile?.purpose || env.CAPAGO_PURPOSE).toLowerCase(),
        (this.profile?.visaVariation || env.CAPAGO_VARIATION || 'Schengen').toLowerCase(),
        (this.profile?.situation || env.CAPAGO_SITUATION || 'Adult').toLowerCase(),
      ];

      for (let i = 0; i < 4; i++) {
        const selects = this.page.locator('select.border-gray-300, select:not([aria-label*="lang" i])');
        const count = await selects.count();
        if (count === 0) break;

        const currentSelect = selects.nth(count - 1);
        const options = await currentSelect.evaluate((s) =>
          Array.from((s as HTMLSelectElement).options).map((o) => ({ text: o.text, value: o.value }))
        );

        if (options.length > 1) {
          // Look for match with desired target
          const target = targetValues[i] || '';
          const match = options.find(
            (o) => o.text.toLowerCase().includes(target) || o.value.toLowerCase().includes(target)
          );

          if (match && match.value) {
            await currentSelect.selectOption({ value: match.value });
          } else {
            // Select index 1 fallback
            await currentSelect.selectOption({ index: 1 });
          }

          await currentSelect.dispatchEvent('change');
          await humanDelay(500, 1000);
        }
      }

      await humanDelay(600, 1200);

      // Click "Next step >"
      const nextBtn = this.page.locator('button:has-text("Next step")').first();
      await nextBtn.click();

      await this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await humanDelay(1200, 2500);
      await this.captureStepSnapshot('travel_project_submitted');

      return {
        step: 'TRAVEL_PROJECT',
        success: true,
        url: this.page.url(),
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        step: 'TRAVEL_PROJECT',
        success: false,
        url: this.page.url(),
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Step 4b: Handle Travel Project Review / Summary
   */
  public async handleTravelProjectReview(): Promise<StepNavigationResult> {
    const start = Date.now();
    console.log(`[Navigation] Step 4b: Confirming Travel Project Review Summary...`);

    try {
      const nextBtn = this.page.locator('button:has-text("Next step")').first();
      await nextBtn.waitFor({ state: 'visible', timeout: 5000 });
      await nextBtn.click();

      await this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await humanDelay(1000, 2000);
      await this.captureStepSnapshot('travel_project_reviewed');

      return {
        step: 'TRAVEL_PROJECT_REVIEW',
        success: true,
        url: this.page.url(),
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        step: 'TRAVEL_PROJECT_REVIEW',
        success: false,
        url: this.page.url(),
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Step 5a: Additional Services Overview
   */
  public async handleServiceOverview(): Promise<StepNavigationResult> {
    const start = Date.now();
    console.log(`[Navigation] Step 5a: Passing Services Overview screen...`);

    try {
      const nextBtn = this.page.locator('button:has-text("Next step")').first();
      await nextBtn.waitFor({ state: 'visible', timeout: 5000 });
      await nextBtn.click();

      await this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await humanDelay(1000, 2000);

      return {
        step: 'SERVICE_OVERVIEW',
        success: true,
        url: this.page.url(),
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        step: 'SERVICE_OVERVIEW',
        success: false,
        url: this.page.url(),
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Step 5b: All-Inclusive Package Upsell (Skip without purchasing)
   */
  public async handleServiceAllInclusive(): Promise<StepNavigationResult> {
    const start = Date.now();
    console.log(`[Navigation] Step 5b: Skipping All-Inclusive Service upsell...`);

    try {
      const skipLink = this.page.locator(
        'button:has-text("Continue without this service"), a:has-text("Continue without this service"), text="Continue without this service"'
      ).first();

      if (await skipLink.isVisible({ timeout: 3000 }).catch(() => false)) {
        await skipLink.click();
      } else {
        const forwardBtn = this.page.locator('button:has-text("Next"), button:has-text("Continue")').first();
        await forwardBtn.click();
      }

      await this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await humanDelay(1000, 2000);

      return {
        step: 'SERVICE_ALL_INCLUSIVE',
        success: true,
        url: this.page.url(),
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        step: 'SERVICE_ALL_INCLUSIVE',
        success: false,
        url: this.page.url(),
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Step 5c: Schengen Travel Insurance Upsell (Decline & proceed)
   */
  public async handleServiceInsurance(): Promise<StepNavigationResult> {
    const start = Date.now();
    console.log(`[Navigation] Step 5c: Declining optional Insurance and proceeding...`);

    try {
      const declineInsuranceLink = this.page.locator(
        'text="No, I will provide my own Schengen travel insurance", a:has-text("provide my own Schengen travel insurance")'
      ).first();

      if (await declineInsuranceLink.isVisible({ timeout: 3000 }).catch(() => false)) {
        await declineInsuranceLink.click({ force: true });
        await humanDelay(400, 800);
      }

      const nextBtn = this.page.locator('button:has-text("Next"):not(:has-text("Next step")), button:has-text("Next step")').first();
      await nextBtn.click();

      await this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await humanDelay(1200, 2500);

      return {
        step: 'SERVICE_INSURANCE',
        success: true,
        url: this.page.url(),
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        step: 'SERVICE_INSURANCE',
        success: false,
        url: this.page.url(),
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Generic Step 5 fallback for Services Carousel (Service 1/8 .. 8/8)
   */
  public async handleGenericServices(): Promise<StepNavigationResult> {
    const start = Date.now();
    console.log(`[Navigation] Step 5: Handling Additional Services Carousel...`);

    try {
      // 1. Check for Schengen Travel Insurance disclaimer link
      const insuranceOptOut = this.page.locator(
        'text="No, I will provide my own Schengen travel insurance", a:has-text("provide my own Schengen travel insurance")'
      ).first();
      if (await insuranceOptOut.isVisible({ timeout: 1000 }).catch(() => false)) {
        console.log('[Navigation] Opting out of Schengen Travel Insurance...');
        await insuranceOptOut.click({ force: true }).catch(() => {});
        await humanDelay(300, 600);
      }

      // 2. Check for Continue without this service
      const continueWithout = this.page.locator('button:has-text("Continue without this service")').first();
      if (await continueWithout.isVisible({ timeout: 1000 }).catch(() => false)) {
        console.log('[Navigation] Clicking Continue without this service...');
        await continueWithout.click().catch(() => {});
        await this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        return {
          step: 'SERVICE_OPTIONS',
          success: true,
          url: this.page.url(),
          durationMs: Date.now() - start,
        };
      }

      // 3. Click Next button in carousel
      const nextBtn = this.page.locator('button:has-text("Next"):not(:has-text("Next step"))').first();
      const nextStepBtn = this.page.locator('button:has-text("Next step")').first();

      if (await nextBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        const isDisabled = await nextBtn.isDisabled().catch(() => false);
        if (!isDisabled) {
          await nextBtn.click();
        }
      } else if (await nextStepBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await nextStepBtn.click();
      }

      await this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await humanDelay(800, 1500);

      return {
        step: 'SERVICE_OPTIONS',
        success: true,
        url: this.page.url(),
        durationMs: Date.now() - start,
      };
    } catch (err) {
      return {
        step: 'SERVICE_OPTIONS',
        success: false,
        url: this.page.url(),
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Step 6: Calendar Route Verification
   */
  public async verifyCalendarArrival(): Promise<boolean> {
    const calendarIndicators = [
      'h2:has-text("Select a date")',
      'text="Select a date"',
      'text="Available time slots"',
      'button:has-text("Confirm Appointment")',
    ];

    for (const selector of calendarIndicators) {
      if (await this.page.locator(selector).first().isVisible({ timeout: 1500 }).catch(() => false)) {
        console.log(`[Navigation] Successfully landed on Calendar route (matched: ${selector})`);
        return true;
      }
    }

    return await this.page.locator('text="Select a date", text="Available time slots"').first().isVisible({ timeout: 1000 }).catch(() => false);
  }

  /**
   * Orchestrates full multi-step navigation from dashboard to the Calendar view.
   */
  public async navigateToCalendar(): Promise<{ success: boolean; steps: StepNavigationResult[] }> {
    const executedSteps: StepNavigationResult[] = [];
    const maxIterations = 25;
    let iteration = 0;

    while (iteration < maxIterations) {
      iteration++;

      if (await this.verifyCalendarArrival()) {
        return { success: true, steps: executedSteps };
      }

      const current = await this.detectCurrentStep();
      console.log(`[Navigation] Step detector: current location is [${current}] (iteration ${iteration})`);

      let stepResult: StepNavigationResult;

      switch (current) {
        case 'PREREQUISITES':
          stepResult = await this.handlePrerequisites();
          break;
        case 'SUBMISSION_LOCATION':
          stepResult = await this.handleSubmissionLocation();
          break;
        case 'APPLICANT_COUNT':
          stepResult = await this.handleApplicantCount();
          break;
        case 'APPLICANT_DETAILS':
          stepResult = await this.handleApplicantDetails();
          break;
        case 'TRAVEL_PROJECT':
          stepResult = await this.handleTravelProject();
          break;
        case 'TRAVEL_PROJECT_REVIEW':
          stepResult = await this.handleTravelProjectReview();
          break;
        case 'SERVICE_OVERVIEW':
          stepResult = await this.handleServiceOverview();
          break;
        case 'SERVICE_ALL_INCLUSIVE':
          stepResult = await this.handleServiceAllInclusive();
          break;
        case 'SERVICE_INSURANCE':
          stepResult = await this.handleServiceInsurance();
          break;
        case 'SERVICE_OPTIONS':
          stepResult = await this.handleGenericServices();
          break;
        case 'DASHBOARD':
        default: {
          const bookBtnSelector = 'a:has-text("Book an appointment"), button:has-text("Book an appointment"), a[href*="booking"], button:has-text("New appointment")';
          const bookBtn = this.page.locator(bookBtnSelector).first();
          if (await bookBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
            console.log(`[Navigation] Clicking "Book an appointment" trigger...`);
            await bookBtn.click();
            await this.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
            await humanDelay(1500, 2500);
            stepResult = {
              step: 'DASHBOARD',
              success: true,
              url: this.page.url(),
              durationMs: 2000,
            };
          } else {
            const forwardBtn = this.page.locator('button:has-text("Next step"), button:has-text("Continue")').first();
            if (await forwardBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
              await forwardBtn.click();
            }
            stepResult = {
              step: 'DASHBOARD',
              success: true,
              url: this.page.url(),
              durationMs: 1000,
            };
          }
          break;
        }
      }

      executedSteps.push(stepResult);

      if (!stepResult.success) {
        console.warn(`[Navigation] Step ${stepResult.step} reported warning/error: ${stepResult.error}`);
      }

      await humanDelay(1000, 2500);
    }

    const finalArrival = await this.verifyCalendarArrival();
    return { success: finalArrival, steps: executedSteps };
  }
}
