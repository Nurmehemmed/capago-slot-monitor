import dotenv from 'dotenv';
import path from 'node:path';
import { z } from 'zod';

// Load .env relative to current working directory or project root
dotenv.config();

const envSchema = z.object({
  // Capago Portal Credentials
  CAPAGO_PORTAL_URL: z
    .string()
    .url()
    .default('https://appointment-az.capago.eu/'),
  CAPAGO_EMAIL: z.string().email().default('applicant@example.com'),
  CAPAGO_PASSWORD: z.string().default(''),

  // Target Center & Category
  CAPAGO_CENTER: z.string().default('Baku'),
  CAPAGO_CATEGORY: z.string().default('Tourism'),
  CAPAGO_PURPOSE: z.string().default('Tourism / Private visit'),
  CAPAGO_VARIATION: z.string().default('Schengen'),
  CAPAGO_SITUATION: z.string().default('Tourism / Private visit - Adult'),

  // Applicant Profile (Required for Step 3 Form)
  APPLICANT_TITLE: z.string().default('Mr'),
  APPLICANT_FIRSTNAME: z.string().default('Nurmahammad'),
  APPLICANT_LASTNAME: z.string().default('Nabiyev'),
  APPLICANT_PASSPORT: z.string().default('A81242122'),
  APPLICANT_DOB: z.string().default('01/01/1995'),
  APPLICANT_PHONE: z.string().default('0517111589'),
  APPLICANT_EMAIL: z.string().optional(),
  APPLICANT_DEPARTURE_DATE: z.string().default('01/12/2026'),
  APPLICANT_NEEDS_FRANCE_VISAS_ASSISTANCE: z
    .string()
    .optional()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),
  APPLICANT_FRANCE_VISAS_REF: z.string().optional(),

  // Telegram Alerting (Optional in local dev/dry-run)
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),

  // Anti-Detection Randomized Execution Intervals (Minutes)
  MIN_CHECK_INTERVAL_MINUTES: z.coerce.number().min(1).default(10),
  MAX_CHECK_INTERVAL_MINUTES: z.coerce.number().min(2).default(25),

  // Calendar Scan Range (Number of months to inspect ahead)
  MONTHS_TO_SCAN: z.coerce.number().min(1).max(12).default(4),

  // Browser Execution Options
  HEADLESS: z
    .string()
    .default('true')
    .transform((val) => val.toLowerCase() === 'true'),
  DEBUG_SCREENSHOTS: z
    .string()
    .default('false')
    .transform((val) => val.toLowerCase() === 'true'),
  STORAGE_STATE_PATH: z
    .string()
    .default(path.resolve(process.cwd(), 'storage/auth_state.json')),
});

export type EnvConfig = z.infer<typeof envSchema>;

function loadConfig(): EnvConfig {
  const result = envSchema.safeParse(process.cwd() ? process.env : {});

  if (!result.success) {
    const formattedErrors = result.error.errors
      .map((err) => `  - ${err.path.join('.')}: ${err.message}`)
      .join('\n');
    console.error(`[Config] Invalid environment configuration:\n${formattedErrors}`);
    console.warn(`[Config] Hint: Copy .env.example to .env and provide your Capago credentials.`);
    
    // Provide sensible fallback for initialization or development validation
    return envSchema.parse({
      ...process.env,
      CAPAGO_EMAIL: process.env['CAPAGO_EMAIL'] || 'placeholder@example.com',
      CAPAGO_PASSWORD: process.env['CAPAGO_PASSWORD'] || 'placeholder_pass',
    });
  }

  return result.data;
}

export const env = loadConfig();
