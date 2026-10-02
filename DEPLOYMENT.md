# Deployment & Telegram Bot Guide

## 1. Setup Telegram Bot (60 seconds)

1. Open Telegram and search for [@BotFather](https://t.me/BotFather).
2. Send `/newbot`.
3. Choose a name for your bot (e.g., `Capago Baku Visa Monitor`).
4. Choose a username ending in `bot` (e.g., `capago_baku_slot_bot`).
5. Copy the generated **HTTP API Token** (format: `1234567890:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`).
6. Paste the token into your `.env` file:
   ```env
   TELEGRAM_BOT_TOKEN=1234567890:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
   ```
7. *(Optional)* Set commands in @BotFather by sending `/setcommands`:
   ```text
   start - Start bot and show quick menu
   new_application - Setup your visa application profile step-by-step
   check_now - Trigger an instant check right now
   status - Check monitor status and current settings
   profile - View your saved applicant info
   start_monitor - Resume continuous background alerts
   stop_monitor - Pause automatic alerts
   help - Help and usage guide
   ```

---

## 2. Running Locally (Development)

```bash
# Install dependencies
npm install

# Run monitor with live Telegram bot
npm run dev
```

Open your Telegram bot and click **Start** or send `/start`!

---

## 3. Deploying to a Server / VPS

### Option A: Docker (Recommended - Single Command)

The provided `Dockerfile` and `docker-compose.yml` use the official Microsoft Playwright image with all required Linux browser libraries pre-installed.

```bash
# 1. Clone repository to your server
git clone <your-repo-url> /opt/capago-slot-monitor
cd /opt/capago-slot-monitor

# 2. Configure .env
cp .env.example .env
nano .env  # set your TELEGRAM_BOT_TOKEN

# 3. Start container in background
docker compose up -d --build

# 4. View live logs
docker compose logs -f
```

---

### Option B: PM2 (Node.js Process Manager)

```bash
# 1. Install dependencies & build
npm install
npx playwright install --with-deps chromium
npm run build

# 2. Install PM2 globally
npm install -g pm2

# 3. Start process with automatic restart
pm2 start pm2.config.cjs

# 4. Save PM2 state for system reboot
pm2 save
pm2 startup

# 5. Check logs
pm2 logs capago-slot-monitor
```

---

### Option C: Fly.io (Cloud MicroVM Deployment)

Fly.io runs real Linux microVMs with dedicated memory and supports persistent storage volumes.

```bash
# 1. Sign in to Fly.io
fly auth login

# 2. Set your Telegram Bot secret
fly secrets set TELEGRAM_BOT_TOKEN="your_bot_token_from_botfather"

# 3. Create persistent storage volume (1GB) for session data
fly volumes create capago_storage --size 1 --region fra

# 4. Deploy app
fly deploy

# 5. View live logs from your phone
```

---

### Option D: Render.com (Docker Web Service)

1. Connect your GitHub repository to Render as a **Web Service** using the Docker runtime.
2. In the Render Environment tab, configure:
   * `TELEGRAM_BOT_TOKEN`: Your bot token from @BotFather.
   * `DATABASE_URL`: Your Neon Postgres connection string (required to save sessions across restarts).
   * `HEADLESS`: `true`
   * `PORT`: `8080`
3. **Prevent Inactivity Sleep (Spin-Down):**
   * The app includes an automatic internal self-ping on Render (`RENDER_EXTERNAL_URL`).
   * For 100% guarantee, create a free monitor at [UptimeRobot.com](https://uptimerobot.com) targeting `https://<your-service>.onrender.com/` with a 5-minute interval. This keeps the health-check port alive 24/7.


## 4. Telegram Bot User Guide

| Command | Action |
| :--- | :--- |
| `/start` | Welcomes the applicant and displays quick action buttons |
| `/new_application` | Interactive wizard to input Name, Passport, DOB, Phone, Departure Date, Category |
| `/check_now` | Runs an immediate live check on the Capago portal and sends results |
| `/status` | Shows current monitoring state, active profile, check interval, scan range |
| `/profile` | Displays the saved applicant information used in wizard |
| `/start_monitor` | Enables instant push alerts for newly opened dates |
| `/stop_monitor` | Pauses notifications |
| `/help` | Explains how the bot works |

### When Slots Open:
- The bot broadcasts an immediate alert to all registered subscribers.
- Attaches the live **screenshot proof** of the open calendar.
- Generates **interactive inline buttons** for each available slot time.
- Clicking a slot provides the direct portal link for the applicant to verify reCAPTCHA and finalize their booking in seconds.
