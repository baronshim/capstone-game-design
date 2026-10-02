import type { Env } from './env';
import { FeedbackObject, parseFeedback } from './feedback';
import { RoomObject } from './room';
import { RateLimiter } from './ratelimit';

export { RoomObject, FeedbackObject };

let limiter: RateLimiter | null = null;
let feedbackLimiter: RateLimiter | null = null;

// No I, O, 0, 1 so codes are easy to read aloud.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function newCode(): string {
  let code = '';
  for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return code;
}

/** Reads a numeric limit var; undefined or garbage falls back to `fallback`. */
function limitFrom(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function handleFeedback(request: Request, env: Env): Promise<Response> {
  const stub = env.FEEDBACK.get(env.FEEDBACK.idFromName('feedback'));

  if (request.method === 'GET') {
    const auth = request.headers.get('Authorization') ?? '';
    const key = env.FEEDBACK_KEY;
    if (!key || auth !== `Bearer ${key}`) return new Response('Unauthorized', { status: 401 });
    return Response.json(await stub.list());
  }

  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  if (!feedbackLimiter) feedbackLimiter = new RateLimiter(limitFrom(env.FEEDBACK_RATE_LIMIT, 5));
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (!feedbackLimiter.allow(ip, Date.now())) {
    return new Response('That is plenty of feedback for one minute; thank you', { status: 429 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response('Expected JSON', { status: 400 });
  }
  const parsed = parseFeedback(body);
  if ('error' in parsed) return new Response(parsed.error, { status: 400 });

  await stub.add({ at: Date.now(), ...parsed, userAgent: request.headers.get('User-Agent') ?? '' });
  return Response.json({ ok: true });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    if (parts[0] === 'rooms' && parts.length === 1 && request.method === 'POST') {
      if (!limiter) {
        limiter = new RateLimiter(limitFrom(env.ROOM_RATE_LIMIT, 5));
      }
      const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
      if (!limiter.allow(ip, Date.now())) {
        return new Response('Too many rooms from this address; try again in a minute', { status: 429 });
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const code = newCode();
        const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
        const res = await stub.fetch(new Request(`${url.origin}/create?code=${code}`, { method: 'POST' }));
        const { created } = (await res.json()) as { created: boolean };
        if (created) return Response.json({ code });
      }
      return new Response('Could not allocate a room code', { status: 503 });
    }

    if (parts[0] === 'rooms' && parts.length === 3 && parts[2] === 'ws') {
      const code = parts[1].toUpperCase();
      if (!/^[A-Z]{4}$/.test(code)) return new Response('Not found', { status: 404 });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(request);
    }

    if (parts[0] === 'feedback' && parts.length === 1) {
      return handleFeedback(request, env);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
