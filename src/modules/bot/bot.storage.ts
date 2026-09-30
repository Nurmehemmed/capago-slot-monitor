import fs from 'node:fs';
import path from 'node:path';
import { UserBotSession, ApplicantProfile } from '../../types/index.js';
import { env } from '../../config/env.js';

export class BotStorage {
  private readonly filePath: string;
  private sessions: Record<string, UserBotSession> = {};

  constructor(filePath?: string) {
    this.filePath = filePath || path.resolve(process.cwd(), 'storage/bot_sessions.json');
    this.ensureStorageDir();
    this.load();
  }

  private ensureStorageDir(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private load(): void {
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        this.sessions = JSON.parse(raw);
      } catch (err) {
        console.warn(`[BotStorage] Could not parse sessions file, starting fresh:`, err);
        this.sessions = {};
      }
    }
  }

  private save(): void {
    try {
      this.ensureStorageDir();
      fs.writeFileSync(this.filePath, JSON.stringify(this.sessions, null, 2), 'utf-8');
    } catch (err) {
      console.error(`[BotStorage] Failed to save sessions:`, err);
    }
  }

  public getSession(chatId: number): UserBotSession {
    const key = String(chatId);
    if (!this.sessions[key]) {
      this.sessions[key] = {
        chatId,
        monitoringActive: true,
        savedProfile: undefined, // Only populated when user completes /new_application
      };
      this.save();
    }
    return this.sessions[key];
  }

  public updateSession(chatId: number, data: Partial<UserBotSession>): UserBotSession {
    const session = this.getSession(chatId);
    Object.assign(session, data);
    this.sessions[String(chatId)] = session;
    this.save();
    return session;
  }

  public getAllActiveSubscribers(): UserBotSession[] {
    return Object.values(this.sessions).filter((s) => s.monitoringActive);
  }

  public getActiveProfile(chatId: number): ApplicantProfile | undefined {
    return this.getSession(chatId).savedProfile;
  }
}

export const botStorage = new BotStorage();
