import { Bot, InlineKeyboard, InputFile } from 'grammy';
import fs from 'node:fs';
import { env } from '../../config/env.js';
import { ScrapeRunReport, ApplicantProfile } from '../../types/index.js';
import { botStorage } from './bot.storage.js';

export interface CheckResult {
  report: ScrapeRunReport | null;
  screenshotPath?: string;
  nextIntervalMinutes?: number;
}

export type CheckHandler = (
  chatId: number,
  profile?: ApplicantProfile
) => Promise<CheckResult | ScrapeRunReport | null>;

export function getCategoryDisplay(cat?: string): string {
  if (cat === 'Business') return 'Biznes';
  if (cat === 'Study') return 'Təhsil';
  return 'Turizm / Şəxsi Səfər';
}

export function getTitleDisplay(title?: string): string {
  if (title === 'Mrs') return 'Xanım (Mrs)';
  if (title === 'Miss') return 'Xanım / Qız (Miss)';
  return 'Cənab (Mr)';
}

export class TelegramBotService {
  private bot: Bot | null = null;
  private isRunning = false;
  private checkInProgress = false;
  private onTriggerCheck?: CheckHandler;

  // Ring buffer: last 20 activity log entries
  private activityLog: { ts: string; msg: string }[] = [];

  public logActivity(msg: string): void {
    const ts = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    this.activityLog.push({ ts, msg });
    if (this.activityLog.length > 20) this.activityLog.shift();
    console.log(`[Monitor] ${msg}`);
  }

  public isBusy(): boolean {
    return this.checkInProgress;
  }

  public setBusy(busy: boolean): void {
    this.checkInProgress = busy;
  }

  constructor() {
    if (this.isConfigured()) {
      this.bot = new Bot(env.TELEGRAM_BOT_TOKEN as string);
      this.setupHandlers();
      // Global error handler — prevents any single message error from crashing the bot
      this.bot.catch((err) => {
        console.error(`[Bot] Middleware error (recovered):`, err.message || err);
      });
    }
  }

  public isConfigured(): boolean {
    return Boolean(
      env.TELEGRAM_BOT_TOKEN &&
      env.TELEGRAM_BOT_TOKEN.length > 20 &&
      !env.TELEGRAM_BOT_TOKEN.startsWith('123456789')
    );
  }

  public setCheckHandler(handler: CheckHandler): void {
    this.onTriggerCheck = handler;
  }

  private setupHandlers(): void {
    if (!this.bot) return;

    // --- /start command ---
    this.bot.command('start', async (ctx) => {
      const chatId = ctx.chat.id;
      const session = botStorage.getSession(chatId);
      session.username = ctx.from?.username || ctx.from?.first_name || 'İstifadəçi';
      botStorage.updateSession(chatId, { username: session.username });

      const welcomeText = [
        `👋 *Capago Viza Slot Monitor Botuna Xoş Gəlmisiniz!*`,
        ``,
        `Mən Bakıdakı Fransa Şengen vizası üçün Capago Azərbaycan portalını (*https://appointment-az.capago.eu/*) 24/7 rejimində izləyirəm.`,
        ``,
        `🔔 Boş yer (slot) açılan kimi sizə dərhal dəqiq tarix, saat və portal linki ilə bildiriş göndərəcəyəm.`,
        ``,
        `*Əsas Komandalar:*`,
        `📝 /new\\_application - Viza müraciət profilini yaratmaq`,
        `🔍 /check\\_now - İndi dərhal yerləri yoxlamaq`,
        `📅 /set\\_months - Baxılacaq ayların sayını seçmək (1-6)`,
        `📊 /status - Monitorinqin cari vəziyyəti`,
        `👤 /profile - Yadda saxlanmış müraciət məlumatları`,
        `❌ /cancel - Cari formu və ya əməliyyatı ləğv etmək`,
        `🗑️ /delete\\_profile - Məlumatlarınızı botdan birdəfəlik silmək`,
        `⏸️ /stop\\_monitor - Avtomatik bildirişləri dayandırmaq`,
        `▶️ /start\\_monitor - Avtomatik bildirişləri davam etdirmək`,
        `❓ /help - Kömək və istifadə təlimatı`,
      ].join('\n');

      const keyboard = new InlineKeyboard()
        .text('📝 Profili Doldur', 'cmd_new_app')
        .text('🔍 İndi Yoxla', 'cmd_check_now')
        .row()
        .text('📅 Baxış Müddəti', 'cmd_set_months')
        .text('📊 Status', 'cmd_status')
        .text('👤 Profilim', 'cmd_profile');

      await ctx.reply(welcomeText, { parse_mode: 'Markdown', reply_markup: keyboard });
    });

    // --- /help command ---
    this.bot.command('help', async (ctx) => {
      const helpText = [
        `📖 *Capago Slot Monitor Təlimatı*`,
        ``,
        `1️⃣ *Profili Doldurun*: /new\\_application komandası ilə məlumatlarınızı addım-addım daxil edin.`,
        `2️⃣ *Baxış Müddəti*: /set\\_months komandası ilə neçə ay irəliyə axtarış aparılacağını (1-6 ay) seçin.`,
        `3️⃣ *Avtomatik İzləmə*: Bot arxa fonda hər ${env.MIN_CHECK_INTERVAL_MINUTES}-${env.MAX_CHECK_INTERVAL_MINUTES} dəqiqədən bir avtomatik yoxlayır.`,
        `4️⃣ *İstənilən Vaxt Ləğv Edin*: /cancel yazaraq cari form doldurma prosesini dayandıra bilərsiniz.`,
        `5️⃣ *Məlumatları Silin*: /delete\\_profile komandası ilə pasport və şəxsi məlumatlarınızı botdan birdəfəlik silə bilərsiniz.`,
        `6️⃣ *Dərhal Bildiriş*: Boş yer açılan kimi ekran şəkli və mövcud saatlarla dərhal bildiriş alacaqsınız.`,
        `7️⃣ *Fəaliyyət Qeydləri*: /logs komandası ilə son monitorinq fəaliyyətlərini buradan izləyə bilərsiniz.`,
      ].join('\n');
      await ctx.reply(helpText, { parse_mode: 'Markdown' });
    });

    // --- /logs command ---
    this.bot.command('logs', async (ctx) => {
      if (this.activityLog.length === 0) {
        await ctx.reply(
          `📋 *Hələ fəaliyyət qeydi yoxdur.*\n\nBot işə düşəndən bəri hələ yoxlama dövrü baş verməyib.\nDərhal yoxlamaq üçün /check\\_now komandasını göndərin.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const lines = [
        `📋 *Son Monitorinq Qeydləri (son ${this.activityLog.length} hadisə):*`,
        ``,
        ...this.activityLog.map((e) => `\`${e.ts}\` ${e.msg}`),
        ``,
        `_Dərhal yoxlamaq üçün /check\\_now komandasından istifadə edin._`,
      ];

      await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
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
        await ctx.reply(`❌ *Form ləğv edildi.* Doldurulmaqda olan qaralama məlumatlar silindi.`, {
          parse_mode: 'Markdown',
        });
      } else {
        await ctx.reply(`ℹ️ Hal-hazırda ləğv ediləcək aktiv əməliyyat yoxdur. /new\\_application və ya /check\\_now istifadə edə bilərsiniz.`, {
          parse_mode: 'Markdown',
        });
      }
    });

    // --- /delete_profile command ---
    this.bot.command('delete_profile', async (ctx) => {
      const chatId = ctx.chat.id;
      const session = botStorage.getSession(chatId);

      if (!session.savedProfile) {
        await ctx.reply(`ℹ️ Silinəcək yadda saxlanmış profil tapılmadı.`, { parse_mode: 'Markdown' });
        return;
      }

      const kb = new InlineKeyboard()
        .text('⚠️ Bəli, Bütün Məlumatlarımı Sil', 'confirm_delete_profile')
        .text('❌ Ləğv et', 'cmd_profile');

      await ctx.reply(
        `⚠️ *Profili Silmək və Məlumatları Təmizləmək?*\n\nProfilinizi silmək istədiyinizdən əminsiniz?\n\n• Ad: *${session.savedProfile.firstName} ${session.savedProfile.lastName}*\n• Pasport: \`${session.savedProfile.passportNumber}\`\n\nBütün şəxsi məlumatlarınız serverdən *birdəfəlik silinəcək* və avtomatik yer axtarışı dərhal dayandırılacaq.`,
        { parse_mode: 'Markdown', reply_markup: kb }
      );
    });

    // --- /start_monitor command ---
    this.bot.command('start_monitor', async (ctx) => {
      botStorage.updateSession(ctx.chat.id, { monitoringActive: true });
      await ctx.reply(`✅ *Avtomatik monitorinq AKTİVDİR.* Boş yer açılan kimi dərhal bildiriş alacaqsınız.`, {
        parse_mode: 'Markdown',
      });
    });

    // --- /stop_monitor command ---
    this.bot.command('stop_monitor', async (ctx) => {
      botStorage.updateSession(ctx.chat.id, { monitoringActive: false });
      await ctx.reply(`⏸️ *Avtomatik monitorinq DAYANDIRILDI.* Yenidən aktivləşdirmək üçün /start\\_monitor göndərin.`, {
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
        .text('👨 Cənab (Mr)', 'title_mr')
        .text('👩 Xanım (Mrs)', 'title_mrs')
        .text('👧 Xanım / Qız (Miss)', 'title_miss')
        .row()
        .text('❌ Ləğv et', 'cancel_wizard');

      await ctx.reply(`📝 *Yeni Müraciət Profilinin Yaradılması (1/10)*\n\nZəhmət olmasa müraciət formasını seçin:\n_(İstənilən vaxt dayandırmaq üçün /cancel yaza bilərsiniz)_`, {
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
          .text('👨 Cənab (Mr)', 'title_mr')
          .text('👩 Xanım (Mrs)', 'title_mrs')
          .text('👧 Xanım / Qız (Miss)', 'title_miss')
          .row()
          .text('❌ Ləğv et', 'cancel_wizard');
        await ctx.reply(`📝 *Yeni Müraciət Profilinin Yaradılması (1/10)*\n\nZəhmət olmasa müraciət formasını seçin:\n_(İstənilən vaxt dayandırmaq üçün /cancel yaza bilərsiniz)_`, {
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
        await ctx.reply(`⏸️ *Monitorinq DAYANDIRILDI.* Yenidən aktivləşdirmək üçün /start\\_monitor və ya "Davam et" düyməsindən istifadə edin.`, {
          parse_mode: 'Markdown',
        });
        return;
      }

      if (data === 'cmd_start') {
        const session = botStorage.getSession(chatId);
        if (!session.savedProfile) {
          await ctx.reply(
            `⚠️ *Profil quraşdırılmayıb.* Əvvəlcə /new\\_application komandası ilə real müraciət məlumatlarınızı daxil edin.`,
            { parse_mode: 'Markdown' }
          );
          return;
        }
        botStorage.updateSession(chatId, { monitoringActive: true });
        await ctx.reply(`✅ *Monitorinq DAVAM ETDİRİLDİ.* Boş yer açılan kimi dərhal bildiriş alacaqsınız.`, {
          parse_mode: 'Markdown',
        });
        return;
      }

      if (data === 'cancel_wizard') {
        const session = botStorage.getSession(chatId);
        session.step = undefined;
        session.profileDraft = undefined;
        botStorage.updateSession(chatId, session);
        await ctx.reply(`❌ *Müraciət formasının doldurulması ləğv edildi.* Qaralama məlumatlar silindi.`, { parse_mode: 'Markdown' });
        return;
      }

      if (data === 'cmd_delete_profile') {
        const session = botStorage.getSession(chatId);
        if (!session.savedProfile) {
          await ctx.reply(`ℹ️ Silinəcək yadda saxlanmış profil tapılmadı.`, { parse_mode: 'Markdown' });
          return;
        }
        const kb = new InlineKeyboard()
          .text('⚠️ Bəli, Bütün Məlumatlarımı Sil', 'confirm_delete_profile')
          .text('❌ Ləğv et', 'cmd_profile');
        await ctx.reply(
          `⚠️ *Profili Silmək və Məlumatları Təmizləmək?*\n\nProfilinizi silmək istədiyinizdən əminsiniz?\n\n• Ad: *${session.savedProfile.firstName} ${session.savedProfile.lastName}*\n• Pasport: \`${session.savedProfile.passportNumber}\`\n\nBütün şəxsi məlumatlarınız serverdən *birdəfəlik silinəcək* və avtomatik yer axtarışı dərhal dayandırılacaq.`,
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
          `🗑️ *Profil Uğurla Silindi.*\n\nBütün şəxsi məlumatlarınız serverdən birdəfəlik silindi. Arxa plan monitorinqi dayandırıldı.\n\nGələcəkdə yeni profil quraşdırmaq üçün /new\\_application istifadə edə bilərsiniz.`,
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

        await ctx.reply(`✅ Müraciət forması seçildi: *${getTitleDisplay(title)}*.\n\n*Addım 2/10:* Zəhmət olmasa xarici pasportdakı *Adınızı* daxil edin:`, {
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
          .text('1 Ay', 'months_1')
          .text('2 Ay', 'months_2')
          .row()
          .text('3 Ay', 'months_3')
          .text('4 Ay (Tövsiyə olunur)', 'months_4')
          .row()
          .text('5 Ay', 'months_5')
          .text('6 Ay (Maksimum Şengen)', 'months_6');

        await ctx.reply(
          `📅 *Addım 10/10: Axtarış Müddəti*\n\nPortalda neçə ay irəliyə qədər boş yerlərin axtarılmasını istəyirsiniz?\n\n_Qeyd: Şengen qaydalarına əsasən, ən çox 6 ay irəliyə görüş götürmək mümkündür._`,
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
            ? '💼 Capago Köməkliyi (+24 AZN)'
            : draft.franceVisasRef
            ? `\`${draft.franceVisasRef}\``
            : '💼 Capago Köməkliyi (+24 AZN)';

          const summary = [
            `📋 *Viza Müraciəti Məlumatlarınızı Yoxlayın:*`,
            ``,
            `• *Müraciət:* ${getTitleDisplay(draft.title)}`,
            `• *Ad və Soyad:* ${draft.firstName} ${draft.lastName}`,
            `• *Pasport:* \`${draft.passportNumber}\``,
            `• *Doğum Tarixi:* ${draft.dob}`,
            `• *Telefon:* ${draft.phone}`,
            `• *Səfər Tarixi:* ${draft.departureDate}`,
            `• *France-Visas Forması:* ${fvDisplay}`,
            `• *Mərkəz:* Bakı`,
            `• *Kateqoriya:* ${getCategoryDisplay(draft.category)}`,
            `• *Viza Növü:* Şengen (Aİ Qaydaları)`,
            `• *Axtarış Müddəti:* ${draft.monthsToScan} ay irəli`,
            ``,
            `⚠️ *Diqqət:* Konsulluq tərəfindən imtinanın qarşısını almaq üçün məlumatlar pasportunuzla tam eyni olmalıdır!`,
            ``,
            `Avtomatik axtarışı başlatmaq üçün bu məlumatları təsdiqləyin:`,
          ].join('\n');

          const keyboard = new InlineKeyboard()
            .text('✅ Təsdiqlə və Saxla', 'confirm_save')
            .text('❌ Ləğv et', 'confirm_cancel');

          await ctx.reply(summary, { parse_mode: 'Markdown', reply_markup: keyboard });
          return;
        }

        // If updating an existing profile:
        if (session.savedProfile) {
          session.savedProfile.monthsToScan = count;
          botStorage.updateSession(chatId, session);
          await ctx.reply(
            `✅ *Axtarış müddəti yeniləndi!* Bot artıq Capago portalında *${count} ay irəli* axtarış aparacaq.`,
            { parse_mode: 'Markdown' }
          );
        } else {
          await ctx.reply(`⚠️ Yadda saxlanmış profil tapılmadı. Quraşdırmaq üçün /new\\_application istifadə edin.`, { parse_mode: 'Markdown' });
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
          .text('🏖️ Turizm / Şəxsi Səfər', 'cat_tourism')
          .text('💼 Biznes', 'cat_business')
          .row()
          .text('🎓 Təhsil', 'cat_student');

        await ctx.reply(
          `💼 *Capago Köməkliyi Seçildi (+24 AZN)*\n\nİndi France-Visas nömrəsi daxil etməyə ehtiyac yoxdur. Bakı mərkəzində Capago əməkdaşları rəsmi formanı doldurmaqda sizə kömək edəcəklər.\n\n*Addım 9/10:* Zəhmət olmasa *Viza Kateqoriyasını* seçin:`,
          { parse_mode: 'Markdown', reply_markup: keyboard }
        );
        return;
      }

      if (data === 'fv_has_number') {
        const session = botStorage.getSession(chatId);
        session.step = 'AWAITING_FRA_NUMBER';
        botStorage.updateSession(chatId, session);

        await ctx.reply(
          `📝 *Addım 8b:* Zəhmət olmasa rəsmi *France-Visas Ərizə Nömrənizi* daxil edin (\`FRA\` ilə başlayır, məsələn: \`FRA12345678901234567\`):\n\n_Qeyd: Bu nömrəni https://france-visas.gouv.fr/ saytında qeydiyyatdan keçdikdən sonra əldə etməlisiniz._`,
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
            `❌ *Məlumatlar Tam Deyil!*\n\nBəzi vacib sahələr doldurulmayıb. Görüşün ləğv edilməsinin qarşısını almaq üçün real məlumatlar olmadan davam etmək mümkün deyil.\n\nZəhmət olmasa /new\\_application ilə yenidən başlayın.`,
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
          `🎉 *Profil uğurla yadda saxlanıldı!*\n\nAvtomatik arxa plan monitorinqi real məlumatlarınızla AKTİVLƏŞDİRİLDİ.\n\n• *Müraciətçi:* ${getTitleDisplay(session.savedProfile.title)} ${session.savedProfile.firstName} ${session.savedProfile.lastName}\n• *Pasport:* \`${session.savedProfile.passportNumber}\`\n• *Axtarış Müddəti:* ${session.savedProfile.monthsToScan} ay irəli\n\n🔍 *İlk yoxlama indi başladılır...*`,
          { parse_mode: 'Markdown' }
        );

        // Immediately trigger the first slot check after submit
        setTimeout(() => {
          this.triggerOnDemandCheck(chatId, { isInitialCheck: true }).catch((err) => {
            console.error(`[Bot] Error running initial check after submit:`, err);
          });
        }, 1200);
        return;
      }

      if (data === 'confirm_cancel') {
        botStorage.updateSession(chatId, { step: undefined, profileDraft: undefined });
        await ctx.reply(`❌ Quraşdırma ləğv edildi. Əvvəlki profil saxlanıldı.`, { parse_mode: 'Markdown' });
        return;
      }

      // Slot tap handling (Human-in-the-loop confirmation)
      if (data.startsWith('slot:')) {
        const slotPayload = data.replace('slot:', '');
        const [date, time] = slotPayload.split('_');

        const responseMsg = [
          `🎯 *Seçilmiş Vaxt: ${date}, saat ${time || 'Mövcud saat'}*`,
          ``,
          `Görüşünüzü rəsmiləşdirmək üçün:`,
          `1️⃣ Aşağıdakı düyməyə klikləyərək portalı açın.`,
          `2️⃣ Seçdiyiniz saatı təsdiqləyin (*${time || 'Slot'}*).`,
          `3️⃣ Təhlükəsizlik yoxlama qutusunu ("I am not a robot") işarələyin.`,
          `4️⃣ *Confirm Appointment* (Görüşü Təsdiqlə) düyməsinə klikləyin.`,
          ``,
          `🔗 [Capago Portalına Keçid](${env.CAPAGO_PORTAL_URL})`,
        ].join('\n');

        const kb = new InlineKeyboard().url('🚀 Capago Portalına Keçid', env.CAPAGO_PORTAL_URL);
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
        await ctx.reply(`❌ *Form ləğv edildi.* Qaralama məlumatlar silindi. Hazır olduqda /new\\_application göndərə bilərsiniz.`, {
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
          await ctx.reply(`*Addım 3/10:* Zəhmət olmasa xarici pasportdakı *Soyadınızı* daxil edin:`, {
            parse_mode: 'Markdown',
          });
          break;

        case 'AWAITING_LASTNAME':
          session.profileDraft = { ...(session.profileDraft || {}), lastName: text.trim() };
          session.step = 'AWAITING_PASSPORT';
          botStorage.updateSession(chatId, session);
          await ctx.reply(
            `*Addım 4/10:* Zəhmət olmasa *Pasport Nömrənizi* daxil edin (məsələn: \`C03783829\`):`,
            { parse_mode: 'Markdown' }
          );
          break;

        case 'AWAITING_PASSPORT': {
          const cleanPassport = text.replace(/\s+/g, '').toUpperCase();
          session.profileDraft = { ...(session.profileDraft || {}), passportNumber: cleanPassport };
          session.step = 'AWAITING_DOB';
          botStorage.updateSession(chatId, session);
          await ctx.reply(
            `*Addım 5/10:* Zəhmət olmasa *Doğum Tarixinizi* \`gg/aa/iiii\` formatında daxil edin (məsələn: \`15/09/1999\`):`,
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
            `*Addım 6/10:* Zəhmət olmasa *Mobil Telefon Nömrənizi* daxil edin (məsələn: \`0517111589\`):`,
            { parse_mode: 'Markdown' }
          );
          break;
        }

        case 'AWAITING_PHONE':
          session.profileDraft = { ...(session.profileDraft || {}), phone: text.trim() };
          session.step = 'AWAITING_DEPARTURE_DATE';
          botStorage.updateSession(chatId, session);
          await ctx.reply(
            `*Addım 7/10:* Zəhmət olmasa *Təxmini Səfər Tarixinizi* \`gg/aa/iiii\` formatında daxil edin (məsələn: \`21/11/2026\`):`,
            { parse_mode: 'Markdown' }
          );
          break;

        case 'AWAITING_DEPARTURE_DATE': {
          session.profileDraft = { ...(session.profileDraft || {}), departureDate: text.trim() };
          session.step = 'AWAITING_FRANCE_VISAS_CHOICE';
          botStorage.updateSession(chatId, session);

          const keyboard = new InlineKeyboard()
            .text('📝 Məndə FRA nömrəsi var', 'fv_has_number')
            .row()
            .text('💼 Capago Köməkliyi (+24 AZN)', 'fv_need_assist');

          const promptText = [
            `*Addım 8/10: France-Visas Ərizə Forması*`,
            ``,
            `*France-Visas forması üçün kömək lazımdırmı?*`,
            `1️⃣ *Məndə France-Visas nömrəsi var:* Siz https://france-visas.gouv.fr/ saytında qeydiyyatdan keçmisiniz və \`FRA...\` ilə başlayan rəsmi nömrəniz var.`,
            ``,
            `2️⃣ *Capago Köməkliyi (24 AZN):* Bakı mərkəzində Capago əməkdaşları rəsmi formanı doldurmağa və yoxlamağa kömək edəcək. *FRA nömrəsi tələb olunmur.*`,
            ``,
            `⚠️ *Konsulluq Qaydası:* Heç vaxt saxta və ya təsadüfi nömrə daxil etməyin! Fransa konsulluğu nömrəni rəsmi viza bazasından yoxlayır və səhv nömrə görüşün avtomatik ləğvinə səbəb olur.`,
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
              .text('💼 Capago Köməkliyinə Keç (+24 AZN)', 'fv_need_assist');
            await ctx.reply(
              `⚠️ *Yanlış France-Visas Nömrəsi!*\n\nRəsmi nömrələr \`FRA\` ilə başlayır və ən az 10 simvoldan ibarət olur (məsələn: \`FRA12345678901234567\`).\n\nƏgər hələ france-visas.gouv.fr saytında qeydiyyatdan keçməmisinizsə, əsla saxta nömrə yazmayın (vizanın ləğvinə səbəb olur)! Bunun əvəzinə Capago köməkliyini seçin:`,
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
            .text('🏖️ Turizm / Şəxsi Səfər', 'cat_tourism')
            .text('💼 Biznes', 'cat_business')
            .row()
            .text('🎓 Təhsil', 'cat_student');

          await ctx.reply(
            `✅ *France-Visas Nömrəsi Qeydə Alındı:* \`${rawRef}\`\n\n*Addım 9/10:* Zəhmət olmasa *Viza Kateqoriyasını* seçin:`,
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
      `📊 *Capago Slot Monitor Vəziyyəti*`,
      ``,
      `• *Monitorinq:* ${session.monitoringActive ? '🟢 AKTİVDİR' : '🔴 DAYANDIRILIB'}`,
      `• *Mərkəz:* Bakı`,
      `• *Viza Kateqoriyası:* ${getCategoryDisplay(profile?.category || env.CAPAGO_CATEGORY)}`,
      `• *Viza Növü:* Standart Şengen (Aİ Qaydaları)`,
      `• *Axtarış Müddəti:* ${monthsAhead} ay irəli`,
      `• *Yoxlama İntervalı:* Hər ${env.MIN_CHECK_INTERVAL_MINUTES}-${env.MAX_CHECK_INTERVAL_MINUTES} dəqiqədən bir (təsadüfi)`,
      `• *Portal:* ${env.CAPAGO_PORTAL_URL}`,
      ``,
      profile
        ? `👤 *Qeydiyyatdan Keçən Şəxs:* ${getTitleDisplay(profile.title)} ${profile.firstName} ${profile.lastName} (\`${profile.passportNumber}\`)`
        : `⚠️ *Xüsusi profil daxil edilməyib.* Standart tənzimləmələrdən istifadə olunur.`,
    ].join('\n');

    const keyboard = new InlineKeyboard()
      .text('🔍 İndi Yoxla', 'cmd_check_now')
      .text('📅 Baxış Müddəti', 'cmd_set_months')
      .row()
      .text(session.monitoringActive ? '⏸️ Dayandır' : '▶️ Davam et', session.monitoringActive ? 'cmd_stop' : 'cmd_start');

    await ctx.reply(statusText, { parse_mode: 'Markdown', reply_markup: keyboard });
  }

  private async replySetMonths(ctx: any): Promise<void> {
    const session = botStorage.getSession(ctx.chat.id);
    const current = session.savedProfile?.monthsToScan || env.MONTHS_TO_SCAN;

    const keyboard = new InlineKeyboard()
      .text(current === 1 ? '✅ 1 Ay' : '1 Ay', 'months_1')
      .text(current === 2 ? '✅ 2 Ay' : '2 Ay', 'months_2')
      .row()
      .text(current === 3 ? '✅ 3 Ay' : '3 Ay', 'months_3')
      .text(current === 4 ? '✅ 4 Ay' : '4 Ay (Tövsiyə olunur)', 'months_4')
      .row()
      .text(current === 5 ? '✅ 5 Ay' : '5 Ay', 'months_5')
      .text(current === 6 ? '✅ 6 Ay' : '6 Ay (Maksimum Şengen)', 'months_6');

    await ctx.reply(
      `📅 *Axtarış Müddətini Təyin Edin*\n\nBotun Capago təqvimində neçə ay irəli axtarış aparmasını istədiyinizi seçin:\n_(Hazırda: *${current} ay irəli*. Şengen qaydalarına əsasən, ən çox 6 ay irəliyə görüş götürmək olar)_`,
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
  }

  private async replyProfile(ctx: any): Promise<void> {
    const session = botStorage.getSession(ctx.chat.id);
    const p = session.savedProfile;

    if (!p) {
      await ctx.reply(`⚠️ Profil quraşdırılmayıb. Məlumatları daxil etmək üçün /new\\_application işə salın.`, {
        parse_mode: 'Markdown',
      });
      return;
    }

    const fvText = p.needsFranceVisasAssistance
      ? '💼 Capago Köməkliyi (+24 AZN)'
      : p.franceVisasRef
      ? `\`${p.franceVisasRef}\``
      : '💼 Capago Köməkliyi (+24 AZN)';

    const monthsAhead = p.monthsToScan || env.MONTHS_TO_SCAN;

    const text = [
      `👤 *Yadda Saxlanmış Müraciət Profili:*`,
      ``,
      `• *Müraciət Forması:* ${getTitleDisplay(p.title)}`,
      `• *Ad və Soyad:* ${p.firstName} ${p.lastName}`,
      `• *Pasport Nömrəsi:* \`${p.passportNumber}\``,
      `• *Doğum Tarixi:* ${p.dob}`,
      `• *Telefon:* ${p.phone}`,
      `• *Səfər Tarixi:* ${p.departureDate}`,
      `• *France-Visas Forması:* ${fvText}`,
      `• *Mərkəz:* Bakı`,
      `• *Kateqoriya:* ${getCategoryDisplay(p.category)}`,
      `• *Viza Növü:* Standart Şengen (Aİ Qaydaları)`,
      `• *Axtarış Müddəti:* ${monthsAhead} ay irəli`,
      ``,
      `_Məlumatları dəyişmək üçün /new\\_application və ya /set\\_months istifadə edə bilərsiniz._`,
    ].join('\n');

    const keyboard = new InlineKeyboard()
      .text('📅 Müddəti Dəyiş', 'cmd_set_months')
      .text('📝 Profili Redaktə Et', 'cmd_new_app');

    await ctx.reply(text, { parse_mode: 'Markdown', reply_markup: keyboard });
  }

  public async triggerOnDemandCheck(
    chatId: number,
    options?: { isInitialCheck?: boolean }
  ): Promise<void> {
    if (!this.bot) return;

    if (this.checkInProgress) {
      await this.bot.api.sendMessage(
        chatId,
        `⏳ *Hal-hazırda yoxlama aparılır.* Zəhmət olmasa bitməsini gözləyin.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (!this.onTriggerCheck) {
      await this.bot.api.sendMessage(
        chatId,
        `⚠️ Monitorinq modulu bota qoşulmayıb.`,
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
        `⚠️ *Müraciət Profili Tapılmadı!*\n\nViza müraciətinin ləğv edilməsinin və portal xətalarının qarşısını almaq üçün saxta və ya boş məlumatlarla yoxlama aparılmır.\n\nZəhmət olmasa yerləri yoxlamazdan əvvəl /new\\_application ilə real məlumatlarınızı daxil edin.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const monthsAhead = profile.monthsToScan || env.MONTHS_TO_SCAN;
    const headerMsg = options?.isInitialCheck
      ? `🔍 *Capago portalında ilk yoxlama başladılır...*`
      : `🔍 *Capago portalında yoxlama başladılır...*`;

    await this.bot.api.sendMessage(
      chatId,
      `${headerMsg}\n*Bakı / ${getCategoryDisplay(profile.category)}* (${profile.firstName} ${profile.lastName}) üçün ${monthsAhead} ay irəli axtarılır.\n_Təhlükəsiz keçid üçün təxminən 60-90 saniyə çəkir._`,
      { parse_mode: 'Markdown' }
    );

    try {
      const result = await this.onTriggerCheck(chatId, profile);
      const report =
        result && typeof result === 'object' && 'report' in result
          ? result.report
          : (result as ScrapeRunReport | null);
      const nextIntervalMinutes =
        result && typeof result === 'object' && 'nextIntervalMinutes' in result
          ? result.nextIntervalMinutes
          : undefined;
      const screenshotPath =
        result && typeof result === 'object' && 'screenshotPath' in result
          ? result.screenshotPath
          : undefined;

      if (report) {
        await this.sendReportToChat(chatId, report, screenshotPath, nextIntervalMinutes);
      } else {
        const nextMsg = nextIntervalMinutes
          ? ` Növbəti qrafik üzrə (~${nextIntervalMinutes} dəqiqəyə) təkrar cəhd ediləcək.`
          : ` Növbəti qrafik üzrə təkrar cəhd ediləcək.`;
        await this.bot.api.sendMessage(
          chatId,
          `⚠️ Yoxlama zamanı xəta baş verdi və ya səhifə açılmadı.${nextMsg}`,
          { parse_mode: 'Markdown' }
        );
      }
    } catch (err) {
      await this.bot.api.sendMessage(
        chatId,
        `❌ Yoxlama zamanı xəta baş verdi: ${err instanceof Error ? err.message : String(err)}`,
        { parse_mode: 'Markdown' }
      );
    } finally {
      this.checkInProgress = false;
    }
  }

  public async sendReportToChat(
    chatId: number,
    report: ScrapeRunReport,
    screenshotPath?: string,
    nextIntervalMinutes?: number
  ): Promise<void> {
    if (!this.bot) return;

    const session = botStorage.getSession(chatId);
    const profile = session.savedProfile;
    const monthsAhead = profile?.monthsToScan || env.MONTHS_TO_SCAN;

    if (!report.hasAvailableSlots) {
      const scheduleNotice = nextIntervalMinutes
        ? `\n\n🟢 Avtomatik monitorinq aktivdir. Növbəti yoxlama *~${nextIntervalMinutes} dəqiqə* sonra planlaşdırılıb.`
        : `\n\n🟢 Avtomatik monitorinq aktivdir və yer açılan kimi dərhal bildiriş göndərəcək.`;

      await this.bot.api.sendMessage(
        chatId,
        `📅 *Yoxlama Tamamlandı: Boş Yer Tapılmadı*\n\n*${report.center === 'Baku' ? 'Bakı' : report.center} - ${getCategoryDisplay(report.category)}* üzrə ${monthsAhead} ay ərzində cəmi ${report.totalDaysScanned} gün yoxlandı.${scheduleNotice}`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Slots found! Send visual screenshot proof first if available
    if (screenshotPath && fs.existsSync(screenshotPath)) {
      try {
        await this.bot.api.sendPhoto(chatId, new InputFile(screenshotPath), {
          caption: `📸 *Canlı Capago Sübutu: Boş Viza Yerləri Aşkar Edildi!*`,
          parse_mode: 'Markdown',
        });
      } catch (err) {
        console.warn(`[Bot] Could not send screenshot:`, err);
      }
    }

    // Slots found! Build rich alert with fast-track booking instructions
    const lines: string[] = [
      `🚨 *CAPAGO VİZA ÜÇÜN BOŞ YERLƏR TAPILDI!* 🚨`,
      ``,
      `📍 *Mərkəz:* ${report.center === 'Baku' ? 'Bakı' : report.center}`,
      `🏷️ *Kateqoriya:* ${getCategoryDisplay(report.category)}`,
      `📅 *Yer Olan Günlərin Sayı:* ${report.availableDays.length}`,
      `⏰ *Ümumi Tapılan Boş Saatlar:* ${report.availableSlots.length}`,
      ``,
      `*Mövcud Tarixlər:*`,
    ];

    const keyboard = new InlineKeyboard();

    for (const day of report.availableDays.slice(0, 6)) {
      const slotTexts = day.slots.map((s) => s.time || '').filter(Boolean);
      const textList = slotTexts.length > 0 ? slotTexts.slice(0, 5).join(', ') : 'Açıq';
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
    lines.push(`⚡ *Sürətli Qeydiyyat Təlimatı:*`);
    lines.push(`_Capago portalı addım-addım işləyir — 6-cı addıma (Təqvim) birbaşa link yoxdur, çünki hər bir şəxs 1-5-ci addımları öz cihazında təsdiqləməlidir. Yeri dərhal götürmək üçün bu 30 saniyəlik təlimata əməl edin:_`);
    lines.push(``);
    lines.push(`1️⃣ Aşağıdakı *🚀 Capago Portalına Keçid* düyməsinə klikləyin.`);
    lines.push(`2️⃣ *Addım 1 və 2:* Razılıq qutularını işarələyin ➔ *Bakı* mərkəzini seçin.`);
    lines.push(`3️⃣ *Addım 3:* 1 Müraciətçi ➔ Məlumatları köçürmək üçün aşağıdakı sətirlərə toxunaraq kopyalayın:`);
    if (profile) {
      lines.push(`   • Ad və Soyad: \`${profile.firstName} ${profile.lastName}\``);
      lines.push(`   • Pasport: \`${profile.passportNumber}\``);
      lines.push(`   • Doğum Tarixi: \`${profile.dob}\``);
      lines.push(`   • Telefon: \`${profile.phone}\``);
      lines.push(`   • Səfər Tarixi: \`${profile.departureDate}\``);
      lines.push(`   • Köməkçi Xidmət: *${profile.needsFranceVisasAssistance ? 'Bəli (+24 AZN)' : 'Xeyr'}*`);
    }
    lines.push(`4️⃣ *Addım 4 və 5:* *Turizm / Şengen* seçin ➔ Əlavə xidmətləri keçin.`);
    lines.push(`5️⃣ *Addım 6 (Təqvim):* Yaşıl tarixi seçin ➔ saatı seçin ➔ təhlükəsizlik qutusunu ("I am not a robot") işarələyin ➔ *Confirm Appointment* (Görüşü Təsdiqlə) düyməsinə klikləyin!`);
    lines.push(``);
    lines.push(`⏱️ *Aşkar Edildi:* ${new Date().toLocaleTimeString('az-AZ')}`);

    keyboard.url('🚀 Capago Portalına Keçid', env.CAPAGO_PORTAL_URL);

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

    // Register commands with Telegram so they appear in the '/' autocomplete menu
    try {
      await this.bot.api.setMyCommands([
        { command: 'start',           description: '👋 Xoş gəlmisiniz & Əsas menyu' },
        { command: 'new_application', description: '📝 Viza müraciət profilini yaratmaq' },
        { command: 'check_now',       description: '🔍 İndi dərhal yerləri yoxlamaq' },
        { command: 'status',          description: '📊 Monitorinqin cari vəziyyəti' },
        { command: 'profile',         description: '👤 Yadda saxlanmış müraciət məlumatları' },
        { command: 'set_months',      description: '📅 Baxılacaq ayların sayını seçmək (1-6)' },
        { command: 'start_monitor',   description: '▶️ Avtomatik monitorinqi aktivləşdirmək' },
        { command: 'stop_monitor',    description: '⏸️ Avtomatik monitorinqi dayandırmaq' },
        { command: 'cancel',          description: '❌ Cari əməliyyatı ləğv etmək' },
        { command: 'delete_profile',  description: '🗑️ Bütün məlumatları birdəfəlik silmək' },
        { command: 'help',            description: '❓ Kömək və istifadə təlimatı' },
        { command: 'logs',            description: '📋 Son monitorinq fəaliyyətlərini göstərmək' },
      ]);
      console.log(`[Bot] Commands registered with Telegram (/ autocomplete enabled).`);
    } catch (err) {
      console.warn(`[Bot] Could not register commands:`, err);
    }

    const startWithRetry = async () => {
      console.log(`[Bot] Starting Telegram bot listener (polling)...`);
      try {
        await this.bot!.start({
          onStart: (info) => {
            console.log(`[Bot] Telegram bot @${info.username} is ONLINE and ready!`);
          },
        });
      } catch (err: any) {
        this.isRunning = false;
        // 409 = another instance is polling (e.g. stray local process)
        // Wait 20s and retry — the other instance will time out
        if (err?.error_code === 409 || String(err?.message).includes('409')) {
          console.warn(`[Bot] 409 Conflict — another bot instance is running. Waiting 20s then retrying...`);
          await new Promise((r) => setTimeout(r, 20000));
          this.isRunning = true;
          return startWithRetry();
        }
        console.error(`[Bot] Telegram bot error (unrecoverable):`, err);
      }
    };

    startWithRetry().catch((err) => console.error(`[Bot] Fatal bot error:`, err));
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
