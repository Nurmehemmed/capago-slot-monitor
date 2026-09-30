import fs from 'node:fs';
import path from 'node:path';
import { BrowserContext, Page } from 'playwright';
import { env } from '../../config/env.js';
import { humanClick, humanDelay, humanType } from '../../core/browser.js';

export interface AuthManagerResult {
  authenticated: boolean;
  reusedSession: boolean;
  error?: string;
}

export class SessionManager {
  private readonly storagePath: string;

  constructor(storagePath = env.STORAGE_STATE_PATH) {
    this.storagePath = storagePath;
    this.ensureStorageDir();
  }

  private ensureStorageDir(): void {
    const dir = path.dirname(this.storagePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  public hasStoredSession(): boolean {
    if (!fs.existsSync(this.storagePath)) {
      return false;
    }
    try {
      const stats = fs.statSync(this.storagePath);
      return stats.size > 20; // verify non-empty JSON
    } catch {
      return false;
    }
  }

  /**
   * Attempts to dismiss common GDPR/Cookie banners if present.
   */
  public async dismissConsentIfPresent(page: Page): Promise<void> {
    const consentSelectors = [
      '#onetrust-accept-btn-handler',
      'button:has-text("Accept all")',
      'button:has-text("Accept")',
      'button:has-text("Accepter")',
      'button[id*="cookie"]',
      'button[class*="cookie"]',
    ];

    for (const selector of consentSelectors) {
      try {
        const btn = page.locator(selector).first();
        if (await btn.isVisible({ timeout: 1500 })) {
          await btn.click({ delay: 100 });
          await humanDelay(400, 800);
          break;
        }
      } catch {
        // Ignored if cookie banner is not present
      }
    }
  }

  /**
   * Checks whether the current page/context already has an active, authenticated session.
   */
  public async isSessionValid(page: Page): Promise<boolean> {
    try {
      console.log(`[Auth] Checking session validity at ${env.CAPAGO_PORTAL_URL}...`);
      await page.goto(env.CAPAGO_PORTAL_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      await this.dismissConsentIfPresent(page);
      await humanDelay(1000, 2000);

      // Indicators of an authenticated user
      const authenticatedIndicators = [
        'a[href*="logout"]',
        'button:has-text("Log out")',
        'button:has-text("Déconnexion")',
        'a:has-text("My applications")',
        'a:has-text("Mes dossiers")',
        '.user-profile',
        '#user-menu',
      ];

      for (const selector of authenticatedIndicators) {
        if (await page.locator(selector).first().isVisible({ timeout: 1000 })) {
          return true;
        }
      }

      // If login inputs are visible, session is not authenticated
      const loginInput = page.locator('input[type="password"], input[type="email"], input[name="email"]').first();
      if (await loginInput.isVisible({ timeout: 1500 })) {
        return false;
      }

      // Check current URL: if we are not on /login or /auth, we may still be logged in
      const currentUrl = page.url().toLowerCase();
      if (!currentUrl.includes('login') && !currentUrl.includes('signin') && !currentUrl.includes('auth')) {
        return true;
      }

      return false;
    } catch (err) {
      console.warn(`[Auth] Error validating session:`, err instanceof Error ? err.message : err);
      return false;
    }
  }

  /**
   * Authenticates against the portal and saves the session storage state.
   */
  public async login(page: Page, context: BrowserContext): Promise<boolean> {
    console.log(`[Auth] Performing fresh authentication for ${env.CAPAGO_EMAIL}...`);

    try {
      await page.goto(env.CAPAGO_PORTAL_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      await this.dismissConsentIfPresent(page);
      await humanDelay(800, 1500);

      // Navigate to login if not already on the login form
      const emailFieldSelector = 'input[type="email"], input[name="email"], input[name="username"], #email';
      const passwordFieldSelector = 'input[type="password"], input[name="password"], #password';

      const emailField = page.locator(emailFieldSelector).first();
      if (!(await emailField.isVisible({ timeout: 3000 }))) {
        // Try clicking a login button if visible
        const loginLink = page.locator('a:has-text("Log in"), button:has-text("Log in"), a[href*="login"]').first();
        if (await loginLink.isVisible({ timeout: 2000 })) {
          await humanClick(page, 'a:has-text("Log in"), button:has-text("Log in"), a[href*="login"]');
          await humanDelay(1000, 2000);
        }
      }

      await emailField.waitFor({ state: 'visible', timeout: 10000 });
      await humanType(page, emailFieldSelector, env.CAPAGO_EMAIL);
      await humanDelay(500, 1000);

      const passwordField = page.locator(passwordFieldSelector).first();
      await passwordField.waitFor({ state: 'visible', timeout: 5000 });
      await humanType(page, passwordFieldSelector, env.CAPAGO_PASSWORD);
      await humanDelay(600, 1200);

      // Submit credentials
      const submitSelector = 'button[type="submit"], input[type="submit"], button:has-text("Sign in"), button:has-text("Log in")';
      await humanClick(page, submitSelector);

      // Wait for navigation after login
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await humanDelay(2000, 3500);

      // Persist session storage state
      await context.storageState({ path: this.storagePath });
      console.log(`[Auth] Session state saved successfully to ${this.storagePath}`);

      return true;
    } catch (err) {
      console.error(`[Auth] Login failed:`, err instanceof Error ? err.message : err);
      return false;
    }
  }

  /**
   * High-level entrypoint: reuses existing session or performs fresh login if required.
   */
  public async ensureAuthenticated(page: Page, context: BrowserContext): Promise<AuthManagerResult> {
    console.log(`[Auth] Navigating to portal at ${env.CAPAGO_PORTAL_URL}...`);
    try {
      await page.goto(env.CAPAGO_PORTAL_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await this.dismissConsentIfPresent(page);
      await humanDelay(800, 1500);

      // Check if page opened directly into the booking wizard (Step 1 Prerequisites or Calendar)
      const bodyText = (await page.textContent('body').catch(() => '')) || '';
      const isBookingWizardDirect =
        bodyText.includes('Prerequisites') ||
        bodyText.includes('Information on booking an appointment') ||
        bodyText.includes('Submission location') ||
        bodyText.includes('Select a date') ||
        (await page.locator('button:has-text("I accept, continue")').count()) > 0;

      if (isBookingWizardDirect) {
        console.log(`[Auth] Direct booking portal detected (no pre-login required). Ready to navigate.`);
        return { authenticated: true, reusedSession: true };
      }

      // If an explicit login password input is present, authenticate
      const passwordField = page.locator('input[type="password"]').first();
      if (await passwordField.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log(`[Auth] Login form detected. Authenticating credentials...`);
        const success = await this.login(page, context);
        return { authenticated: success, reusedSession: false };
      }

      // Default: session is ready
      return { authenticated: true, reusedSession: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('closed') || msg.includes('Target page') || msg.includes('Browser has been closed')) {
        console.log(`[Auth] Portal navigation cancelled (browser closed per user request).`);
      } else {
        console.error(`[Auth] Error accessing portal:`, msg);
      }
      return { authenticated: false, reusedSession: false, error: msg };
    }
  }
}
