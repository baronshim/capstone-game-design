import type { Env } from './env';
import { RoomObject } from './room';
import { RateLimiter } from './ratelimit';

export { RoomObject };

let limiter: RateLimiter | null = null;

// No I, O, 0, 1 so codes are easy to read aloud.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function newCode(): string {
  let code = '';
  for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return code;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    if (parts[0] === 'rooms' && parts.length === 1 && request.method === 'POST') {
      if (!limiter) {
        const configured = Number(env.ROOM_RATE_LIMIT);
        limiter = new RateLimiter(Number.isFinite(configured) ? configured : 5);
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

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
