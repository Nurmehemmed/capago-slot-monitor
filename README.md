# Capago Baku Visa Appointment Slot Monitor & Telegram Bot

A stealth Playwright scraper and interactive Telegram Bot in TypeScript to continuously monitor the Capago Azerbaijan portal (`https://appointment-az.capago.eu/`) for French Schengen visa appointments in Baku, alerting users the second slots open.

## Key Features

- **6-Step Automated Progression**: Seamless state machine that navigates Steps 1 through 5 (Prerequisites consent, Baku submission location, Applicant profile with France-Visas reference, Travel project cascading dropdowns, Additional services carousel & Insurance opt-out) directly to the Step 6 Calendar.
- **Interactive Telegram Bot (`grammy`)**:
  - `/new_application` - Conversational 10-step wizard to set up applicant data directly inside Telegram (Title, Name, Passport, DOB, Phone, Departure Date, France-Visas Choice, Category, Horizon).
  - `/check_now` - Trigger on-demand instant check across upcoming months.
  - `/set_months` - Choose how many months forward to monitor (1 to 6 months) with 1-tap inline buttons.
  - `/status` & `/profile` - View monitoring status, scan range, and saved applicant profile.
  - Rich notifications with calendar screenshot proofs and interactive inline buttons for available slots.
- **Customizable Multi-Month Horizon**: Scan 1 to 6 months ahead (default 4 months, up to full Schengen limit) and extract individual morning/afternoon slot times.
- **Anti-Bot Stealth**: Powered by `playwright-extra` + `puppeteer-extra-plugin-stealth` with randomized user agents, realistic viewports, humanized typing speed, and cursor hesitation.
- **Jitter Scheduling**: Randomized execution intervals (10 to 25 minutes) with second-level jitter to defeat bot fingerprinting.
- **Production Ready**: Includes `Dockerfile`, `docker-compose.yml`, and `pm2.config.cjs` for 1-click cloud deployment.

## Quick Start

1. **Configure `.env`**:
   ```env
   CAPAGO_PORTAL_URL=https://appointment-az.capago.eu/
   CAPAGO_CENTER=Baku
   CAPAGO_CATEGORY=Tourism
   MONTHS_TO_SCAN=4
   TELEGRAM_BOT_TOKEN=your_bot_token_from_botfather
   ```

2. **Run Locally**:
   ```bash
   npm install
   npm run dev
   ```

3. **Deploy with Docker**:
   ```bash
   docker compose up -d --build
   ```

See [DEPLOYMENT.md](DEPLOYMENT.md) for full deployment instructions and the Telegram Bot guide.

