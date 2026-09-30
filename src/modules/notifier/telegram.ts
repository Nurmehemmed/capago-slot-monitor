import fs from 'node:fs';
import { env } from '../../config/env.js';
import { ScrapeRunReport } from '../../types/index.js';

export class TelegramNotifier {
  private readonly botToken?: string;
  private readonly chatId?: string;
  private readonly apiUrl: string;

  constructor() {
    this.botToken = env.TELEGRAM_BOT_TOKEN;
    this.chatId = env.TELEGRAM_CHAT_ID;
    this.apiUrl = `https://api.telegram.org/bot${this.botToken}`;
  }

  public isConfigured(): boolean {
    return Boolean(this.botToken && this.chatId && !this.botToken.startsWith('123456789'));
  }

  /**
   * Formats a clear, scannable Markdown alert message.
   */
  public formatAlertMessage(report: ScrapeRunReport): string {
    const daysSummary = report.availableDays
      .map((day) => {
        const slotsList = day.slots.length > 0 
          ? day.slots.map((s) => s.time || 'Mövcud').join(', ') 
          : 'Boş yerlər var (saatları görmək üçün seçin)';
        return `• 📅 *${day.date}*: \`${slotsList}\``;
      })
      .slice(0, 10) // Limit to top 10 days to keep message concise
      .join('\n');

    return [
      `🚨 *CAPAGO VİZA ÜÇÜN BOŞ YERLƏR TAPILDI!* 🚨`,
      ``,
      `📍 *Mərkəz:* ${report.center}`,
      `🏷️ *Kateqoriya:* ${report.category}`,
      `📊 *Yer Olan Günlərin Sayı:* ${report.availableDays.length}`,
      `⏰ *Ümumi Tapılan Boş Saatlar:* ${report.availableSlots.length}`,
      ``,
      `*Mövcud Tarixlər:*`,
      daysSummary || '• Təqvimdə boş yerlər aşkar edildi.',
      ``,
      `🔗 [Capago Portalına Keçid](${env.CAPAGO_PORTAL_URL})`,
      `⏱️ *Aşkar Edildi:* ${new Date().toLocaleString('az-AZ')}`,
    ].join('\n');
  }

  /**
   * Dispatches a text alert via the Telegram Bot API.
   */
  public async sendAlert(report: ScrapeRunReport): Promise<boolean> {
    if (!this.isConfigured()) {
      console.warn(`[Notifier] Telegram credentials not configured. Skipping remote alert.`);
      return false;
    }

    const text = this.formatAlertMessage(report);

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`[Notifier] Dispatching Telegram alert (Attempt ${attempt}/3)...`);
        const response = await fetch(`${this.apiUrl}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.chatId,
            text,
            parse_mode: 'Markdown',
            disable_web_page_preview: false,
          }),
        });

        const data = (await response.json()) as { ok: boolean; description?: string };
        if (data.ok) {
          console.log(`[Notifier] Telegram alert sent successfully.`);
          return true;
        }

        console.error(`[Notifier] Telegram API error: ${data.description || 'Unknown error'}`);
      } catch (err) {
        console.error(`[Notifier] Network error sending Telegram message:`, err instanceof Error ? err.message : err);
      }

      await new Promise((res) => setTimeout(res, attempt * 1500));
    }

    return false;
  }

  /**
   * Optionally sends the proof screenshot directly to the chat.
   */
  public async sendPhoto(photoPath: string, caption?: string): Promise<boolean> {
    if (!this.isConfigured() || !fs.existsSync(photoPath)) {
      return false;
    }

    try {
      const fileBuffer = fs.readFileSync(photoPath);
      const blob = new Blob([fileBuffer], { type: 'image/png' });
      const formData = new FormData();
      formData.append('chat_id', this.chatId as string);
      formData.append('photo', blob, 'slot_proof.png');
      if (caption) {
        formData.append('caption', caption);
        formData.append('parse_mode', 'Markdown');
      }

      const res = await fetch(`${this.apiUrl}/sendPhoto`, {
        method: 'POST',
        body: formData,
      });

      const json = (await res.json()) as { ok: boolean };
      return json.ok;
    } catch (err) {
      console.warn(`[Notifier] Failed to send proof screenshot:`, err instanceof Error ? err.message : err);
      return false;
    }
  }
}

export const telegramNotifier = new TelegramNotifier();
