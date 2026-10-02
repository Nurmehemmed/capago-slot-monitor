import { chromium } from 'playwright-extra';
import stealthPlugin from 'puppeteer-extra-plugin-stealth';
import { Browser, BrowserContext, Page } from 'playwright';
import fs from 'node:fs';
import { env } from '../config/env.js';

// Apply stealth plugin evasions
chromium.use(stealthPlugin());

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
];

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1920, height: 1080 },
];

/**
 * Generates a random integer between min and max inclusive.
 */
export function getRandomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Natural pause to emulate human processing time.
 */
export async function humanDelay(minMs = 800, maxMs = 2200): Promise<void> {
  const delay = getRandomInt(minMs, maxMs);
  await new Promise((resolve) => setTimeout(resolve, delay));
}

/**
 * Types text with realistic human keystroke intervals and occasional micro-pauses.
 */
export async function humanType(page: Page, selector: string, text: string): Promise<void> {
  const element = page.locator(selector).first();
  await element.scrollIntoViewIfNeeded();
  await humanDelay(300, 600);
  await element.click();

  for (const char of text) {
    await element.pressSequentially(char, { delay: getRandomInt(45, 135) });
    if (Math.random() < 0.08) {
      await humanDelay(150, 350); // slight hesitation
    }
  }
}

/**
 * Clicks an element with mouse hover and human micro-delays.
 */
export async function humanClick(page: Page, selector: string): Promise<void> {
  const element = page.locator(selector).first();
  await element.scrollIntoViewIfNeeded();
  await element.hover();
  await humanDelay(250, 500);
  await element.click();
}

/**
 * Initializes a stealth Playwright session reusing saved storage state if available.
 */
export async function initStealthBrowser(): Promise<BrowserSession> {
  const browser = await chromium.launch({
    headless: env.HEADLESS,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--no-zygote',
      '--renderer-process-limit=1',
      '--js-flags=--max-old-space-size=128',
      '--window-position=0,0',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-breakpad',
      '--disable-component-extensions-with-background-pages',
      '--disable-extensions',
      '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints',
      '--disable-ipc-flooding-protection',
      '--mute-audio',
      '--no-default-browser-check',
      '--no-first-run',
    ],
  });

  const hasStorageState = fs.existsSync(env.STORAGE_STATE_PATH);
  const randomUserAgent = USER_AGENTS[getRandomInt(0, USER_AGENTS.length - 1)];
  const randomViewport = VIEWPORTS[getRandomInt(0, VIEWPORTS.length - 1)];

  const contextOptions: Parameters<typeof browser.newContext>[0] = {
    userAgent: randomUserAgent,
    viewport: randomViewport,
    locale: 'en-US',
    timezoneId: 'Europe/Paris',
    colorScheme: 'light',
    deviceScaleFactor: 1,
    hasTouch: false,
    permissions: ['geolocation'],
    geolocation: { latitude: 48.8566, longitude: 2.3522 }, // Paris default
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9,fr;q=0.8',
    },
  };

  if (hasStorageState) {
    contextOptions.storageState = env.STORAGE_STATE_PATH;
  }

  const context = await browser.newContext(contextOptions);

  // Block heavy assets (images, media, fonts, analytics) to strictly cap Chromium memory under 150MB
  await context.route('**/*', (route) => {
    const req = route.request();
    const type = req.resourceType();
    const url = req.url().toLowerCase();

    if (
      type === 'image' ||
      type === 'media' ||
      type === 'font' ||
      url.includes('google-analytics') ||
      url.includes('googletagmanager') ||
      url.includes('doubleclick') ||
      url.includes('hotjar') ||
      url.includes('facebook') ||
      url.includes('sentry')
    ) {
      return route.abort();
    }
    return route.continue();
  });

  const page = await context.newPage();

  // Override webdriver property explicitly
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
  });

  return { browser, context, page };
}
