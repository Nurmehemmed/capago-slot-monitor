import { Bot, InlineKeyboard, InputFile } from 'grammy';
import fs from 'node:fs';
import { env } from '../../config/env.js';
import { ScrapeRunReport, ApplicantProfile } from '../../types/index.js';
import { botStorage } from './bot.storage.js';

export class TelegramBotService {
  private bot: Bot | null = null;
  private isRunning = false;
  private checkInProgress = false;
  private onTriggerCheck?: (chatId: number, profile?: ApplicantProfile) => Promise<ScrapeRunReport | null>;

  constructor() {
    if (this.isConfigured()) {
      this.bot = new Bot(env.TELEGRAM_BOT_TOKEN as string);
      this.setupHandlers();
    }
  }

  public isConfigured(): boolean {
    return Boolean(
      env.TELEGRAM_BOT_TOKEN &&
      env.TELEGRAM_BOT_TOKEN.length > 20 &&
      !env.TELEGRAM_BOT_TOKEN.startsWith('123456789')
    );
  }

  public setCheckHandler(
    handler: (chatId: number, profile?: ApplicantProfile) => Promise<ScrapeRunReport | null>
  ): void {
    this.onTriggerCheck = handler;
  }

  private setupHandlers(): void {
    if (!this.bot) return;

    // --- /start command ---
    this.bot.command('start', async (ctx) => {
      const chatId = ctx.chat.id;
      const session = botStorage.getSession(chatId);
      session.username = ctx.from?.username || ctx.from?.first_name || 'User';
      botStorage.updateSession(chatId, { username: session.username });

      const welcomeText = [
        `👋 *Welcome to Capago Visa Slot Monitor Bot!*`,
        ``,
        `I monitor the Capago Azerbaijan portal (*https://appointment-az.capago.eu/*) 24/7 for French Schengen visa appointments in Baku.`,
        ``,
        `🔔 When slots appear, I will alert you *instantly* with exact dates, times, and direct portal links.`,
        ``,
        `*Quick Commands:*`,
        `📝 /new\\_application - Setup your visa application profile`,
        `🔍 /check\\_now - Trigger an instant check right now`,
        `📅 /set\\_months - Change how many months forward to monitor (1-6)`,
        `📊 /status - Check current monitor status`,
        `👤 /profile - View your saved applicant info`,
        `❌ /cancel - Cancel any ongoing wizard or form`,
        `🗑️ /delete\\_profile - Permanently delete your data from the bot`,
        `⏸️ /stop\\_monitor - Pause automatic notifications`,
        `▶️ /start\\_monitor - Resume automatic notifications`,
        `❓ /help - Help and usage guide`,
      ].join('\n');

      const keyboard = new InlineKeyboard()
        .text('📝 Setup Application', 'cmd_new_app')
        .text('🔍 Check Slots Now', 'cmd_check_now')
        .row()
        .text('📅 Scan Horizon', 'cmd_set_months')
        .text('📊 Status', 'cmd_status')
        .text('👤 Profile', 'cmd_profile');

      await ctx.reply(welcomeText, { parse_mode: 'Markdown', reply_markup: keyboard });
    });

    // --- /help command ---
    this.bot.command('help', async (ctx) => {
      const helpText = [
        `📖 *Capago Slot Monitor Guide*`,
        ``,
        `1️⃣ *Configure Application*: Use /new\\_application to enter your details step-by-step.`,
        `2️⃣ *Custom Horizon*: Choose how many months ahead to scan (1 to 6 months) via /set\\_months.`,
        `3️⃣ *Automatic Monitoring*: Runs in the background every ${env.MIN_CHECK_INTERVAL_MINUTES}-${env.MAX_CHECK_INTERVAL_MINUTES} mins.`,
        `4️⃣ *Cancel at Any Time*: Send /cancel to immediately abort an ongoing form or wizard.`,
        `5️⃣ *Delete Your Data*: Send /delete\\_profile to permanently wipe your passport and personal data from the bot.`,
        `6️⃣ *Instant Alert*: When slots open, you get a notification with the screenshot and exact times.`,
      ].join('\n');
      await ctx.reply(helpText, { parse_mode: 'Markdown' });
    });

    // --- /status command ---
    this.bot.command('status', async (ctx) => {
      await this.replyStatus(ctx);
    });

    // --- /profile command ---
    this.bot.command('profile', async (ctx) => {
      await this.replyProfile(ctx);
    });

    // --- /set_months command ---
    this.bot.command('set_months', async (ctx) => {
      await this.replySetMonths(ctx);
    });

    // --- /cancel command ---
    this.bot.command('cancel', async (ctx) => {
      const chatId = ctx.chat.id;
      const session = botStorage.getSession(chatId);
      const hadActiveStep = Boolean(session.step || session.profileDraft);
      session.step = undefined;
      session.profileDraft = undefined;
      botStorage.updateSession(chatId, session);

      if (hadActiveStep) {
        await ctx.reply(`❌ *Form cancelled.* Your in-progress application draft has been discarded.`, {
          parse_mode: 'Markdown',
        });
      } else {
        await ctx.reply(`ℹ️ There is no active operation to cancel. You can use /new\\_application or /check\\_now.`, {
          parse_mode: 'Markdown',
        });
      }
    });

    // --- /delete_profile command ---
    this.bot.command('delete_profile', async (ctx) => {
      const chatId = ctx.chat.id;
      const session = botStorage.getSession(chatId);

      if (!session.savedProfile) {
        await ctx.reply(`ℹ️ You don't have any saved application profile to delete.`, { parse_mode: 'Markdown' });
        return;
      }

      const kb = new InlineKeyboard()
        .text('⚠️ Yes, Delete All My Data', 'confirm_delete_profile')
        .text('❌ Cancel', 'cmd_profile');

      await ctx.reply(
        `⚠️ *Delete Profile & Wipe Data?*\n\nAre you sure you want to delete your profile?\n\n• Name: *${session.savedProfile.firstName} ${session.savedProfile.lastName}*\n• Passport: \`${session.savedProfile.passportNumber}\`\n\nAll personal data will be *permanently erased* from the server, and automatic slot monitoring will stop immediately.`,
        { parse_mode: 'Markdown', reply_markup: kb }
      );
    });

    // --- /start_monitor command ---
    this.bot.command('start_monitor', async (ctx) => {
      botStorage.updateSession(ctx.chat.id, { monitoringActive: true });
      await ctx.reply(`✅ *Continuous monitoring is ACTIVE.* You will receive instant notifications when slots open.`, {
        parse_mode: 'Markdown',
      });
    });

    // --- /stop_monitor command ---
    this.bot.command('stop_monitor', async (ctx) => {
      botStorage.updateSession(ctx.chat.id, { monitoringActive: false });
      await ctx.reply(`⏸️ *Continuous monitoring is PAUSED.* Use /start\\_monitor to resume.`, {
        parse_mode: 'Markdown',
      });
    });

    // --- /new_application wizard command ---
    this.bot.command('new_application', async (ctx) => {
      const chatId = ctx.chat.id;
      botStorage.updateSession(chatId, {
        step: 'AWAITING_TITLE',
        profileDraft: {},
      });

      const keyboard = new InlineKeyboard()
        .text('👨 Mr', 'title_mr')
        .text('👩 Mrs', 'title_mrs')
        .text('👧 Miss', 'title_miss')
        .row()
        .text('❌ Cancel', 'cancel_wizard');

      await ctx.reply(`📝 *New Application Profile Setup (1/10)*\n\nPlease select your title:\n_(Type /cancel at any time to abort)_`, {
        parse_mode: 'Markdown',
        reply_markup: keyboard,
      });
    });

    // --- /check_now on-demand command ---
    this.bot.command('check_now', async (ctx) => {
      await this.triggerOnDemandCheck(ctx.chat.id);
    });

    // --- Callback query routing ---
    this.bot.on('callback_query:data', async (ctx) => {
      const data = ctx.callbackQuery.data;
      const chatId = ctx.chat?.id;
      if (!chatId) return;

      await ctx.answerCallbackQuery().catch(() => {});

      if (data === 'cmd_new_app') {
        botStorage.updateSession(chatId, { step: 'AWAITING_TITLE', profileDraft: {} });
        const keyboard = new InlineKeyboard()
          .text('👨 Mr', 'title_mr')
          .text('👩 Mrs', 'title_mrs')
          .text('👧 Miss', 'title_miss');
        await ctx.reply(`📝 *New Application Profile Setup (1/9)*\n\nPlease select your title:`, {
          parse_mode: 'Markdown',
          reply_markup: keyboard,
        });
        return;
      }

      if (data === 'cmd_check_now') {
        await this.triggerOnDemandCheck(chatId);
        return;
      }

      if (data === 'cmd_status') {
        await this.replyStatus(ctx);
        return;
      }

      if (data === 'cmd_profile') {
        await this.replyProfile(ctx);
        return;
      }

      if (data === 'cmd_set_months') {
        await this.replySetMonths(ctx);
        return;
      }

      if (data === 'cmd_stop') {
        botStorage.updateSession(chatId, { monitoringActive: false });
        await ctx.reply(`⏸️ *Monitoring PAUSED.* Use /start\\_monitor or the Resume button to reactivate.`, {
          parse_mode: 'Markdown',
        });
        return;
      }

      if (data === 'cmd_start') {
        const session = botStorage.getSession(chatId);
        if (!session.savedProfile) {
          await ctx.reply(
            `⚠️ *No profile configured.* Use /new\\_application first to enter your real application details.`,
            { parse_mode: 'Markdown' }
          );
          return;
        }
        botStorage.updateSession(chatId, { monitoringActive: true });
        await ctx.reply(`✅ *Monitoring RESUMED.* You will receive instant alerts when slots open.`, {
          parse_mode: 'Markdown',
        });
        return;
      }

      if (data === 'cancel_wizard') {
        const session = botStorage.getSession(chatId);
        session.step = undefined;
        session.profileDraft = undefined;
        botStorage.updateSession(chatId, session);
        await ctx.reply(`❌ *Application setup cancelled.* Your in-progress draft was discarded.`, { parse_mode: 'Markdown' });
        return;
      }

      if (data === 'cmd_delete_profile') {
        const session = botStorage.getSession(chatId);
        if (!session.savedProfile) {
          await ctx.reply(`ℹ️ You don't have any saved application profile to delete.`, { parse_mode: 'Markdown' });
          return;
        }
        const kb = new InlineKeyboard()
          .text('⚠️ Yes, Delete All My Data', 'confirm_delete_profile')
          .text('❌ Cancel', 'cmd_profile');
        await ctx.reply(
          `⚠️ *Delete Profile & Wipe Data?*\n\nAre you sure you want to delete your profile?\n\n• Name: *${session.savedProfile.firstName} ${session.savedProfile.lastName}*\n• Passport: \`${session.savedProfile.passportNumber}\`\n\nAll personal data will be *permanently erased* from the server, and automatic slot monitoring will stop immediately.`,
          { parse_mode: 'Markdown', reply_markup: kb }
        );
        return;
      }

      if (data === 'confirm_delete_profile') {
        const session = botStorage.getSession(chatId);
        session.savedProfile = undefined;
        session.profileDraft = undefined;
        session.step = undefined;
        session.monitoringActive = false;
        botStorage.updateSession(chatId, session);

        await ctx.reply(
          `🗑️ *Profile Deleted Successfully.*\n\nAll your personal details have been permanently erased from the server. Background monitoring is now stopped.\n\nUse /new\\_application if you wish to set up a new profile in the future.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Title selection
      if (data.startsWith('title_')) {
        const title = data.replace('title_', '').toUpperCase() === 'MR' ? 'Mr' : data.replace('title_', '').toUpperCase() === 'MRS' ? 'Mrs' : 'Miss';
        const session = botStorage.getSession(chatId);
        session.profileDraft = { ...(session.profileDraft || {}), title };
        session.step = 'AWAITING_FIRSTNAME';
        botStorage.updateSession(chatId, session);

        await ctx.reply(`✅ Title set to *${title}*.\n\n*Step 2/10:* Please enter your *First Name* (as in passport):`, {
          parse_mode: 'Markdown',
        });
        return;
      }

      // Category selection -> Step 10: Horizon
      if (data.startsWith('cat_')) {
        const catMap: Record<string, string> = {
          cat_tourism: 'Tourism',
          cat_business: 'Business',
          cat_student: 'Study',
        };
        const category = catMap[data] || 'Tourism';
        const session = botStorage.getSession(chatId);
        session.profileDraft = { ...(session.profileDraft || {}), category, center: 'Baku', visaVariation: 'Schengen' };
        session.step = 'AWAITING_MONTHS';
        botStorage.updateSession(chatId, session);

        const keyboard = new InlineKeyboard()
          .text('1 Month', 'months_1')
          .text('2 Months', 'months_2')
          .row()
          .text('3 Months', 'months_3')
          .text('4 Months (Recommended)', 'months_4')
          .row()
          .text('5 Months', 'months_5')
          .text('6 Months (Max Schengen)', 'months_6');

        await ctx.reply(
          `📅 *Step 10/10: Monitoring Horizon*\n\nHow many months forward would you like me to monitor for available appointment slots?\n\n_Note: Schengen regulations allow booking appointments up to 6 months in advance._`,
          { parse_mode: 'Markdown', reply_markup: keyboard }
        );
        return;
      }

      // Scan Horizon callback
      if (data.startsWith('months_')) {
        const count = parseInt(data.replace('months_', ''), 10) || env.MONTHS_TO_SCAN;
        const session = botStorage.getSession(chatId);

        // If in setup wizard:
        if (session.profileDraft) {
          session.profileDraft.monthsToScan = count;
          session.step = 'CONFIRMATION';
          botStorage.updateSession(chatId, session);

          const draft = session.profileDraft;
          const fvDisplay = draft.needsFranceVisasAssistance
            ? '💼 Capago Assistance (+24 AZN)'
            : draft.franceVisasRef
            ? `\`${draft.franceVisasRef}\``
            : '💼 Capago Assistance (+24 AZN)';

          const summary = [
            `📋 *Review Your Visa Application Details:*`,
            ``,
            `• *Title:* ${draft.title || 'Mr'}`,
            `• *Name:* ${draft.firstName} ${draft.lastName}`,
            `• *Passport:* \`${draft.passportNumber}\``,
            `• *Date of Birth:* ${draft.dob}`,
            `• *Phone:* ${draft.phone}`,
            `• *Departure Date:* ${draft.departureDate}`,
            `• *France-Visas Form:* ${fvDisplay}`,
            `• *Center:* Baku`,
            `• *Category:* ${draft.category}`,
            `• *Visa Type:* Schengen (EU Agreement)`,
            `• *Scan Horizon:* ${draft.monthsToScan} month(s) ahead`,
            ``,
            `⚠️ *Please verify:* Details must match your passport exactly to prevent consular rejection!`,
            ``,
            `Confirm these details to begin automated monitoring:`,
          ].join('\n');

          const keyboard = new InlineKeyboard()
            .text('✅ Confirm & Save', 'confirm_save')
            .text('❌ Cancel', 'confirm_cancel');

          await ctx.reply(summary, { parse_mode: 'Markdown', reply_markup: keyboard });
          return;
        }

        // If updating an existing profile:
        if (session.savedProfile) {
          session.savedProfile.monthsToScan = count;
          botStorage.updateSession(chatId, session);
          await ctx.reply(
            `✅ *Scan horizon updated!* The monitor will now scan *${count} month(s) ahead* on Capago portal.`,
            { parse_mode: 'Markdown' }
          );
        } else {
          await ctx.reply(`⚠️ No saved profile found. Use /new\\_application to setup.`, { parse_mode: 'Markdown' });
        }
        return;
      }

      // France-Visas Option Callbacks
      if (data === 'fv_need_assist') {
        const session = botStorage.getSession(chatId);
        session.profileDraft = {
          ...(session.profileDraft || {}),
          needsFranceVisasAssistance: true,
          franceVisasRef: undefined,
        };
        session.step = 'AWAITING_CATEGORY';
        botStorage.updateSession(chatId, session);

        const keyboard = new InlineKeyboard()
          .text('🏖️ Tourism / Private', 'cat_tourism')
          .text('💼 Business', 'cat_business')
          .row()
          .text('🎓 Study', 'cat_student');

        await ctx.reply(
          `💼 *Capago Assistance Selected (+24 AZN)*\n\nNo France-Visas reference number is required now. Capago staff will assist you with completing the official form at the Baku center.\n\n*Step 9/9:* Please select your *Visa Category*:`,
          { parse_mode: 'Markdown', reply_markup: keyboard }
        );
        return;
      }

      if (data === 'fv_has_number') {
        const session = botStorage.getSession(chatId);
        session.step = 'AWAITING_FRA_NUMBER';
        botStorage.updateSession(chatId, session);

        await ctx.reply(
          `📝 *Step 8b:* Please enter your official *France-Visas Application Reference* (starts with \`FRA...\`, e.g. \`FRA12345678901234567\`):\n\n_Note: You must have obtained this on https://france-visas.gouv.fr/en/._`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      // Save confirmation
      if (data === 'confirm_save') {
        const session = botStorage.getSession(chatId);
        const draft = session.profileDraft;

        if (
          !draft ||
          !draft.firstName?.trim() ||
          !draft.lastName?.trim() ||
          !draft.passportNumber?.trim() ||
          !draft.dob?.trim() ||
          !draft.phone?.trim() ||
          !draft.departureDate?.trim()
        ) {
          await ctx.reply(
            `❌ *Incomplete Application Details!*\n\nSome required fields are missing. To protect against visa cancellation, we cannot proceed without your complete real details.\n\nPlease start over with /new\\_application.`,
            { parse_mode: 'Markdown' }
          );
          return;
        }

        session.savedProfile = {
          title: draft.title || 'Mr',
          firstName: draft.firstName.trim(),
          lastName: draft.lastName.trim(),
          passportNumber: draft.passportNumber.replace(/\s+/g, '').toUpperCase(),
          dob: draft.dob.trim(),
          phone: draft.phone.trim(),
          email: draft.email?.trim().toLowerCase() || undefined,
          departureDate: draft.departureDate.trim(),
          needsFranceVisasAssistance: draft.needsFranceVisasAssistance ?? (draft.franceVisasRef ? false : true),
          franceVisasRef: draft.franceVisasRef?.trim().toUpperCase(),
          category: draft.category || 'Tourism',
          center: 'Baku',
          visaVariation: 'Schengen',
          monthsToScan: draft.monthsToScan || 4,
        };
        session.step = undefined;
        session.profileDraft = undefined;
        session.monitoringActive = true;
        botStorage.updateSession(chatId, session);

        await ctx.reply(
          `🎉 *Profile saved successfully!*\n\nAutomated background monitoring is now ACTIVE with your real application details.\n\n• *Applicant:* ${session.savedProfile.title} ${session.savedProfile.firstName} ${session.savedProfile.lastName}\n• *Passport:* \`${session.savedProfile.passportNumber}\`\n• *Scan Horizon:* ${session.savedProfile.monthsToScan} month(s) ahead\n\nYou will receive instant alerts the moment a matching slot opens.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      if (data === 'confirm_cancel') {
        botStorage.updateSession(chatId, { step: undefined, profileDraft: undefined });
        await ctx.reply(`❌ Setup cancelled. Kept previous profile.`, { parse_mode: 'Markdown' });
        return;
      }

      // Slot tap handling (Human-in-the-loop confirmation)
      if (data.startsWith('slot:')) {
        const slotPayload = data.replace('slot:', '');
        const [date, time] = slotPayload.split('_');

        const responseMsg = [
          `🎯 *Slot Selected: ${date} at ${time || 'Available time'}*`,
          ``,
          `To finalize your appointment:`,
          `1️⃣ Click the link below to open the portal.`,
          `2️⃣ Confirm your selected time (*${time || 'Slot'}*).`,
          `3️⃣ Complete the security verification checkbox.`,
          `4️⃣ Click *Confirm Appointment*.`,
          ``,
          `🔗 [Open Capago Portal](${env.CAPAGO_PORTAL_URL})`,
        ].join('\n');

        const kb = new InlineKeyboard().url('🚀 Go to Capago Portal', env.CAPAGO_PORTAL_URL);
        await ctx.reply(responseMsg, { parse_mode: 'Markdown', reply_markup: kb });
        return;
      }
    });

    // --- Message router for interactive text inputs ---
    this.bot.on('message:text', async (ctx) => {
      const chatId = ctx.chat.id;
      const session = botStorage.getSession(chatId);
      const text = ctx.message.text.trim();

      if (!session.step) return;

      // Handle cancel requests
      if (text.toLowerCase() === '/cancel' || text.toLowerCase() === 'cancel' || text.toLowerCase() === '/abort') {
        session.step = undefined;
        session.profileDraft = undefined;
        botStorage.updateSession(chatId, session);
        await ctx.reply(`❌ *Form cancelled.* Your application draft was discarded. Send /new\\_application when ready to start again.`, {
          parse_mode: 'Markdown',
        });
        return;
      }

      // If user typed any other slash command, exit form mode immediately
      if (text.startsWith('/')) {
        session.step = undefined;
        session.profileDraft = undefined;
        botStorage.updateSession(chatId, session);
        return;
      }

      switch (session.step) {
        case 'AWAITING_FIRSTNAME':
          session.profileDraft = { ...(session.profileDraft || {}), firstName: text.trim() };
          session.step = 'AWAITING_LASTNAME';
          botStorage.updateSession(chatId, session);
          await ctx.reply(`*Step 3/9:* Please enter your *Last Name* (as in passport):`, {
            parse_mode: 'Markdown',
          });
          break;

        case 'AWAITING_LASTNAME':
          session.profileDraft = { ...(session.profileDraft || {}), lastName: text.trim() };
          session.step = 'AWAITING_PASSPORT';
          botStorage.updateSession(chatId, session);
          await ctx.reply(
            `*Step 4/9:* Please enter your *Passport Number* (e.g. \`A81242122\`):`,
            { parse_mode: 'Markdown' }
          );
          break;

        case 'AWAITING_PASSPORT': {
          const cleanPassport = text.replace(/\s+/g, '').toUpperCase();
          session.profileDraft = { ...(session.profileDraft || {}), passportNumber: cleanPassport };
          session.step = 'AWAITING_DOB';
          botStorage.updateSession(chatId, session);
          await ctx.reply(
            `*Step 5/9:* Please enter your *Date of Birth* in \`dd/mm/yyyy\` format (e.g. \`15/05/1990\`):`,
            { parse_mode: 'Markdown' }
          );
          break;
        }

        case 'AWAITING_DOB': {
          const cleanDob = text.trim();
          session.profileDraft = { ...(session.profileDraft || {}), dob: cleanDob };
          session.step = 'AWAITING_PHONE';
          botStorage.updateSession(chatId, session);
          await ctx.reply(
            `*Step 6/9:* Please enter your *Mobile Phone Number* (e.g. \`0517111589\`):`,
            { parse_mode: 'Markdown' }
          );
          break;
        }

        case 'AWAITING_PHONE':
          session.profileDraft = { ...(session.profileDraft || {}), phone: text.trim() };
          session.step = 'AWAITING_DEPARTURE_DATE';
          botStorage.updateSession(chatId, session);
          await ctx.reply(
            `*Step 7/9:* Please enter your *Estimated Departure Date* in \`dd/mm/yyyy\` format (e.g. \`01/12/2026\`):`,
            { parse_mode: 'Markdown' }
          );
          break;

        case 'AWAITING_DEPARTURE_DATE': {
          session.profileDraft = { ...(session.profileDraft || {}), departureDate: text.trim() };
          session.step = 'AWAITING_FRANCE_VISAS_CHOICE';
          botStorage.updateSession(chatId, session);

          const keyboard = new InlineKeyboard()
            .text('📝 I have my FRA Reference Number', 'fv_has_number')
            .row()
            .text('💼 Capago Form Assistance (+24 AZN)', 'fv_need_assist');

          const promptText = [
            `*Step 8/9: France-Visas Form Option*`,
            ``,
            `*Do you need help with your France-Visas form?*`,
            `1️⃣ *I have my France-Visas number:* You completed your registration on https://france-visas.gouv.fr/en/ and have an official reference number starting with \`FRA...\`.`,
            ``,
            `2️⃣ *Capago Assistance (24 AZN):* Capago staff will assist you with filling out and validating your official form at the Baku center. *No FRA number required.*`,
            ``,
            `⚠️ *Consular Notice:* Never enter a fake or placeholder reference number! The French consulate checks the number against the official visa database, and an invalid number causes automatic appointment cancellation.`,
          ].join('\n');

          await ctx.reply(promptText, {
            parse_mode: 'Markdown',
            reply_markup: keyboard,
          });
          break;
        }

        case 'AWAITING_FRA_NUMBER': {
          const rawRef = text.trim().toUpperCase();
          if (!rawRef.startsWith('FRA') || rawRef.length < 10) {
            const kb = new InlineKeyboard()
              .text('💼 Switch to Capago Assistance (24 AZN)', 'fv_need_assist');
            await ctx.reply(
              `⚠️ *Invalid France-Visas Reference Number!*\n\nOfficial references start with \`FRA\` and have at least 10 characters (e.g. \`FRA12345678901234567\`).\n\nIf you have not registered on france-visas.gouv.fr yet, do NOT enter a fake number as it will cause visa refusal/cancellation! Choose Capago assistance instead:`,
              { parse_mode: 'Markdown', reply_markup: kb }
            );
            return;
          }

          session.profileDraft = {
            ...(session.profileDraft || {}),
            franceVisasRef: rawRef,
            needsFranceVisasAssistance: false,
          };
          session.step = 'AWAITING_CATEGORY';
          botStorage.updateSession(chatId, session);

          const keyboard = new InlineKeyboard()
            .text('🏖️ Tourism / Private', 'cat_tourism')
            .text('💼 Business', 'cat_business')
            .row()
            .text('🎓 Study', 'cat_student');

          await ctx.reply(
            `✅ *France-Visas Reference Recorded:* \`${rawRef}\`\n\n*Step 9/9:* Please select your *Visa Category*:`,
            { parse_mode: 'Markdown', reply_markup: keyboard }
          );
          break;
        }

        default:
          break;
      }
    });
  }

  private async replyStatus(ctx: any): Promise<void> {
    const session = botStorage.getSession(ctx.chat.id);
    const profile = session.savedProfile;
    const monthsAhead = profile?.monthsToScan || env.MONTHS_TO_SCAN;

    const statusText = [
      `📊 *Capago Slot Monitor Status*`,
      ``,
      `• *Monitoring:* ${session.monitoringActive ? '🟢 ACTIVE' : '🔴 PAUSED'}`,
      `• *Target Center:* Baku`,
      `• *Visa Category:* ${profile?.category || env.CAPAGO_CATEGORY}`,
      `• *Visa Variation:* Standard Schengen (EU Agreement)`,
      `• *Scan Horizon:* ${monthsAhead} month(s) ahead`,
      `• *Interval:* Every ${env.MIN_CHECK_INTERVAL_MINUTES}-${env.MAX_CHECK_INTERVAL_MINUTES} mins (randomized)`,
      `• *Portal:* ${env.CAPAGO_PORTAL_URL}`,
      ``,
      profile
        ? `👤 *Configured Applicant:* ${profile.title} ${profile.firstName} ${profile.lastName} (\`${profile.passportNumber}\`)`
        : `⚠️ *No custom profile configured.* Using default config.`,
    ].join('\n');

    const keyboard = new InlineKeyboard()
      .text('🔍 Check Now', 'cmd_check_now')
      .text('📅 Scan Horizon', 'cmd_set_months')
      .row()
      .text(session.monitoringActive ? '⏸️ Pause' : '▶️ Resume', session.monitoringActive ? 'cmd_stop' : 'cmd_start');

    await ctx.reply(statusText, { parse_mode: 'Markdown', reply_markup: keyboard });
  }

  private async replySetMonths(ctx: any): Promise<void> {
    const session = botStorage.getSession(ctx.chat.id);
    const current = session.savedProfile?.monthsToScan || env.MONTHS_TO_SCAN;

    const keyboard = new InlineKeyboard()
      .text(current === 1 ? '✅ 1 Month' : '1 Month', 'months_1')
      .text(current === 2 ? '✅ 2 Months' : '2 Months', 'months_2')
      .row()
      .text(current === 3 ? '✅ 3 Months' : '3 Months', 'months_3')
      .text(current === 4 ? '✅ 4 Months' : '4 Months (Recommended)', 'months_4')
      .row()
      .text(current === 5 ? '✅ 5 Months' : '5 Months', 'months_5')
      .text(current === 6 ? '✅ 6 Months' : '6 Months (Max Schengen)', 'months_6');

    await ctx.reply(
      `📅 *Set Monitoring Horizon*\n\nSelect how many months forward you want the bot to scan on the Capago calendar:\n_(Currently: *${current} month(s) ahead*. Schengen rules allow booking up to 6 months in advance)_`,
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
  }

  private async replyProfile(ctx: any): Promise<void> {
    const session = botStorage.getSession(ctx.chat.id);
    const p = session.savedProfile;

    if (!p) {
      await ctx.reply(`⚠️ No profile configured. Run /new\\_application to set up.`, {
        parse_mode: 'Markdown',
      });
      return;
    }

    const fvText = p.needsFranceVisasAssistance
      ? '💼 Capago Assistance (+24 AZN)'
      : p.franceVisasRef
      ? `\`${p.franceVisasRef}\``
      : '💼 Capago Assistance (+24 AZN)';

    const monthsAhead = p.monthsToScan || env.MONTHS_TO_SCAN;

    const text = [
      `👤 *Saved Applicant Profile:*`,
      ``,
      `• *Title:* ${p.title}`,
      `• *Full Name:* ${p.firstName} ${p.lastName}`,
      `• *Passport Number:* \`${p.passportNumber}\``,
      `• *Date of Birth:* ${p.dob}`,
      `• *Phone:* ${p.phone}`,
      `• *Departure Date:* ${p.departureDate}`,
      `• *France-Visas Form:* ${fvText}`,
      `• *Center:* ${p.center || 'Baku'}`,
      `• *Category:* ${p.category || 'Tourism'}`,
      `• *Visa Variation:* Schengen (EU Agreement)`,
      `• *Scan Horizon:* ${monthsAhead} month(s) ahead`,
      ``,
      `_To modify details, send /new\\_application or /set\\_months._`,
    ].join('\n');

    const keyboard = new InlineKeyboard()
      .text('📅 Change Horizon', 'cmd_set_months')
      .text('📝 Edit Profile', 'cmd_new_app');

    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
  }

  public async triggerOnDemandCheck(chatId: number): Promise<void> {
    if (!this.bot) return;

    if (this.checkInProgress) {
      await this.bot.api.sendMessage(
        chatId,
        `⏳ *A check is currently in progress.* Please wait a moment for it to complete.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (!this.onTriggerCheck) {
      await this.bot.api.sendMessage(
        chatId,
        `⚠️ Monitor engine is not attached to the bot.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    this.checkInProgress = true;
    const session = botStorage.getSession(chatId);
    const profile = session.savedProfile;

    if (!profile) {
      this.checkInProgress = false;
      await this.bot.api.sendMessage(
        chatId,
        `⚠️ *No Application Profile Found!*\n\nTo prevent visa cancellation and portal errors, we *strictly* avoid checking with dummy or placeholder data.\n\nPlease enter your real application details using /new\\_application before checking slots.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const monthsAhead = profile.monthsToScan || env.MONTHS_TO_SCAN;

    await this.bot.api.sendMessage(
      chatId,
      `🔍 *Starting on-demand check on Capago portal...*\nScanning across ${monthsAhead} month(s) ahead for *Baku / ${profile.category || 'Tourism'}* (${profile.firstName} ${profile.lastName}).\n_This takes ~60-90s to navigate stealthily._`,
      { parse_mode: 'Markdown' }
    );

    try {
      const report = await this.onTriggerCheck(chatId, profile);
      if (report) {
        await this.sendReportToChat(chatId, report);
      } else {
        await this.bot.api.sendMessage(
          chatId,
          `⚠️ Check encountered an issue or could not complete navigation. Will retry in next scheduled cycle.`,
          { parse_mode: 'Markdown' }
        );
      }
    } catch (err) {
      await this.bot.api.sendMessage(
        chatId,
        `❌ Error running check: ${err instanceof Error ? err.message : String(err)}`,
        { parse_mode: 'Markdown' }
      );
    } finally {
      this.checkInProgress = false;
    }
  }

  public async sendReportToChat(
    chatId: number,
    report: ScrapeRunReport,
    screenshotPath?: string
  ): Promise<void> {
    if (!this.bot) return;

    const session = botStorage.getSession(chatId);
    const monthsAhead = session.savedProfile?.monthsToScan || env.MONTHS_TO_SCAN;

    if (!report.hasAvailableSlots) {
      await this.bot.api.sendMessage(
        chatId,
        `📅 *Check Complete: No Available Slots Found*\n\nEvaluated ${report.totalDaysScanned} day tiles across ${monthsAhead} month(s) for *${report.center} - ${report.category}*.\n\n🟢 Continuous monitoring is active and will alert you the moment a slot opens.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Slots found! Build rich alert with inline buttons
    const lines: string[] = [
      `🚨 *CAPAGO VISA APPOINTMENT SLOTS AVAILABLE!* 🚨`,
      ``,
      `📍 *Center:* ${report.center}`,
      `🏷️ *Category:* ${report.category}`,
      `📅 *Days with Slots:* ${report.availableDays.length}`,
      `⏰ *Total Detected Slots:* ${report.availableSlots.length}`,
      ``,
      `*Available Dates:*`,
    ];

    const keyboard = new InlineKeyboard();

    for (const day of report.availableDays.slice(0, 6)) {
      const slotTexts = day.slots.map((s) => s.time || '').filter(Boolean);
      const textList = slotTexts.length > 0 ? slotTexts.slice(0, 5).join(', ') : 'Open';
      lines.push(`• 📅 *${day.date}*: \`${textList}\``);

      // Add clickable buttons for slots
      for (const slot of day.slots.slice(0, 4)) {
        if (slot.time) {
          const payload = `slot:${day.date}_${slot.time}`;
          keyboard.text(`📅 ${day.date.split('-')[1]?.trim() || day.date}: ${slot.time}`, payload).row();
        }
      }
    }

    lines.push(``);
    lines.push(`🔗 [Open Capago Portal](${env.CAPAGO_PORTAL_URL})`);
    lines.push(`⏱️ *Detected:* ${new Date().toLocaleTimeString()}`);

    keyboard.url('🚀 Open Capago Booking Portal', env.CAPAGO_PORTAL_URL);

    // Send screenshot if exists
    if (screenshotPath && fs.existsSync(screenshotPath)) {
      try {
        await this.bot.api.sendPhoto(chatId, new InputFile(screenshotPath), {
          caption: `📸 *Live Slot Proof on Capago Portal*`,
          parse_mode: 'Markdown',
        });
      } catch (err) {
        console.warn(`[Bot] Could not send screenshot:`, err);
      }
    }

    await this.bot.api.sendMessage(chatId, lines.join('\n'), {
      parse_mode: 'Markdown',
      reply_markup: keyboard,
    });
  }

  public async broadcastAlert(report: ScrapeRunReport, screenshotPath?: string): Promise<void> {
    if (!this.bot || !report.hasAvailableSlots) return;

    const subscribers = botStorage.getAllActiveSubscribers();

    // If env.TELEGRAM_CHAT_ID is set and not already in subscribers, add it
    if (env.TELEGRAM_CHAT_ID && !subscribers.some((s) => String(s.chatId) === env.TELEGRAM_CHAT_ID)) {
      const envChatId = parseInt(env.TELEGRAM_CHAT_ID, 10);
      if (!isNaN(envChatId)) {
        subscribers.push({ chatId: envChatId, monitoringActive: true });
      }
    }

    console.log(`[Bot] Broadcasting slot alert to ${subscribers.length} subscriber(s)...`);

    for (const sub of subscribers) {
      try {
        await this.sendReportToChat(sub.chatId, report, screenshotPath);
      } catch (err) {
        console.warn(`[Bot] Failed to send alert to chat ${sub.chatId}:`, err);
      }
    }
  }

  public async start(): Promise<void> {
    if (!this.bot) {
      console.log(`[Bot] Telegram Bot Token not set. Bot service will not start.`);
      return;
    }

    if (this.isRunning) return;
    this.isRunning = true;

    console.log(`[Bot] Starting Telegram bot listener (polling)...`);
    this.bot.start({
      onStart: (info) => {
        console.log(`[Bot] Telegram bot @${info.username} is ONLINE and ready!`);
      },
    }).catch((err) => {
      console.error(`[Bot] Telegram bot error:`, err);
      this.isRunning = false;
    });
  }

  public stop(): void {
    if (this.bot && this.isRunning) {
      this.bot.stop();
      this.isRunning = false;
      console.log(`[Bot] Telegram bot stopped.`);
    }
  }
}

export const telegramBotService = new TelegramBotService();
