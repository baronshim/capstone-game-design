import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';

export const FEEDBACK_MAX_CHARS = 2000;
const CONTACT_MAX_CHARS = 200;

export interface FeedbackEntry {
  id: number;
  /** Unix milliseconds. */
  at: number;
  text: string;
  contact: string;
  userAgent: string;
}

/** A single Durable Object (always addressed by the name "feedback") that appends player feedback to its SQLite store. */
export class FeedbackObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        text TEXT NOT NULL,
        contact TEXT NOT NULL,
        user_agent TEXT NOT NULL
      )`,
    );
  }

  add(entry: Omit<FeedbackEntry, 'id'>): void {
    this.ctx.storage.sql.exec(
      'INSERT INTO feedback (at, text, contact, user_agent) VALUES (?, ?, ?, ?)',
      entry.at,
      entry.text,
      entry.contact,
      entry.userAgent,
    );
  }

  /** Every entry, newest first. */
  list(): FeedbackEntry[] {
    const rows = this.ctx.storage.sql
      .exec<{ id: number; at: number; text: string; contact: string; user_agent: string }>(
        'SELECT id, at, text, contact, user_agent FROM feedback ORDER BY id DESC',
      )
      .toArray();
    return rows.map((r) => ({ id: r.id, at: r.at, text: r.text, contact: r.contact, userAgent: r.user_agent }));
  }
}

/** Validates a POST /feedback body. Returns the clean fields, or a reason it was refused. */
export function parseFeedback(body: unknown): { text: string; contact: string } | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Expected a JSON object' };
  const { text, contact } = body as { text?: unknown; contact?: unknown };
  if (typeof text !== 'string' || text.trim().length === 0) return { error: 'Feedback text is required' };
  if (text.length > FEEDBACK_MAX_CHARS) return { error: `Feedback is limited to ${FEEDBACK_MAX_CHARS} characters` };
  if (contact !== undefined && typeof contact !== 'string') return { error: 'Contact must be text' };
  return { text: text.trim(), contact: (contact ?? '').trim().slice(0, CONTACT_MAX_CHARS) };
}
