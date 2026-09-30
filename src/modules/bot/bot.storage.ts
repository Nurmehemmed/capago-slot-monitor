import postgres from 'postgres';
import { UserBotSession, ApplicantProfile } from '../../types/index.js';

/**
 * BotStorage backed by Neon Postgres.
 * Sessions survive server restarts and redeployments.
 * Falls back to in-memory cache if DB is unavailable.
 */
export class BotStorage {
  private sql: ReturnType<typeof postgres> | null = null;
  private cache: Record<string, UserBotSession> = {};

  constructor() {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      console.warn('[BotStorage] DATABASE_URL not set — using in-memory storage (profiles lost on restart).');
      return;
    }

    try {
      this.sql = postgres(dbUrl, {
        ssl: 'require',
        max: 3,
        idle_timeout: 20,
        connect_timeout: 10,
      });
      this.init().catch((err) => {
        console.error('[BotStorage] DB init failed, falling back to in-memory:', err);
        this.sql = null;
      });
    } catch (err) {
      console.error('[BotStorage] Failed to create DB client:', err);
    }
  }

  private async init(): Promise<void> {
    if (!this.sql) return;

    await this.sql`
      CREATE TABLE IF NOT EXISTS capago_sessions (
        chat_id BIGINT PRIMARY KEY,
        session_data JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;

    // Load all sessions from DB into the in-memory cache
    const rows = await this.sql`SELECT chat_id, session_data FROM capago_sessions`;
    for (const row of rows) {
      // IMPORTANT: postgres JSONB comes back as a parsed object, but if it was
      // accidentally stored as a JSON-string-in-JSONB, we must parse it here.
      let data = row.session_data;
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch { /* leave as-is */ }
      }
      if (data && typeof data === 'object') {
        this.cache[String(row.chat_id)] = data as UserBotSession;
      }
    }
    console.log(`[BotStorage] Loaded ${rows.length} session(s) from database.`);
    console.log('[BotStorage] Connected to Neon Postgres — sessions will persist across restarts.');
  }

  private async persist(chatId: number): Promise<void> {
    if (!this.sql) return;
    const session = this.cache[String(chatId)];
    if (!session) return;
    try {
      // Pass the plain object — postgres lib serializes it correctly for JSONB
      // DO NOT JSON.stringify() here — that causes double-encoding
      await this.sql`
        INSERT INTO capago_sessions (chat_id, session_data, updated_at)
        VALUES (${chatId}, ${session as any}, NOW())
        ON CONFLICT (chat_id)
        DO UPDATE SET session_data = EXCLUDED.session_data, updated_at = NOW()
      `;
    } catch (err) {
      console.error(`[BotStorage] Failed to persist session for chat ${chatId}:`, err);
    }
  }

  public getSession(chatId: number): UserBotSession {
    const key = String(chatId);
    if (!this.cache[key]) {
      this.cache[key] = {
        chatId,
        monitoringActive: true,
        savedProfile: undefined,
      };
      this.persist(chatId).catch(() => {});
    }
    return this.cache[key];
  }

  public updateSession(chatId: number, data: Partial<UserBotSession>): UserBotSession {
    const session = this.getSession(chatId);
    Object.assign(session, data);
    this.cache[String(chatId)] = session;
    this.persist(chatId).catch(() => {});
    return session;
  }

  public getAllActiveSubscribers(): UserBotSession[] {
    return Object.values(this.cache).filter((s) => s.monitoringActive);
  }

  public getActiveProfile(chatId: number): ApplicantProfile | undefined {
    return this.getSession(chatId).savedProfile;
  }
}

export const botStorage = new BotStorage();
