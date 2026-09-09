import type { Env } from './env';
import { RoomObject } from './room';

export { RoomObject };

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
      const code = newCode();
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      await stub.fetch(new Request(`${url.origin}/create?code=${code}`, { method: 'POST' }));
      return Response.json({ code });
    }

    if (parts[0] === 'rooms' && parts.length === 3 && parts[2] === 'ws') {
      const code = parts[1].toUpperCase();
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
