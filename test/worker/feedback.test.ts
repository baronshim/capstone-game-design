import { describe, it, expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';

const BASE = 'http://room.test/feedback';
/** Whatever key the test environment carries (wrangler vars, or .dev.vars when present). */
const KEY = env.FEEDBACK_KEY!;
let ipCounter = 0;

/** Each test posts from its own address so the per-IP limiter does not bleed between tests. */
function post(body: unknown, ip = `10.0.0.${++ipCounter}`): Promise<Response> {
  return SELF.fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, 'User-Agent': 'vitest' },
    body: JSON.stringify(body),
  });
}

function list(key?: string): Promise<Response> {
  return SELF.fetch(BASE, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
}

interface Entry {
  id: number;
  at: number;
  text: string;
  contact: string;
  userAgent: string;
}

describe('POST /feedback', () => {
  it('stores a submission and the key holder can read it back, newest first', async () => {
    const first = await post({ text: 'first note', contact: 'a@example.com' });
    expect(first.status).toBe(200);
    const second = await post({ text: 'second note' });
    expect(second.status).toBe(200);

    const res = await list(KEY);
    expect(res.status).toBe(200);
    const entries = (await res.json()) as Entry[];
    const texts = entries.map((e) => e.text);
    expect(texts.indexOf('second note')).toBeLessThan(texts.indexOf('first note'));
    const stored = entries.find((e) => e.text === 'first note')!;
    expect(stored.contact).toBe('a@example.com');
    expect(stored.userAgent).toBe('vitest');
    expect(typeof stored.at).toBe('number');
  });

  it('rejects empty or whitespace-only text', async () => {
    expect((await post({ text: '   ' })).status).toBe(400);
    expect((await post({})).status).toBe(400);
  });

  it('rejects text over 2000 characters', async () => {
    expect((await post({ text: 'x'.repeat(2001) })).status).toBe(400);
    expect((await post({ text: 'x'.repeat(2000) })).status).toBe(200);
  });

  it('rejects a body that is not JSON', async () => {
    const res = await SELF.fetch(BASE, { method: 'POST', body: 'not json', headers: { 'CF-Connecting-IP': '10.9.9.9' } });
    expect(res.status).toBe(400);
  });

  it('limits one address to a few submissions a minute', async () => {
    const ip = '10.1.1.1';
    expect((await post({ text: 'one' }, ip)).status).toBe(200);
    expect((await post({ text: 'two' }, ip)).status).toBe(200);
    expect((await post({ text: 'three' }, ip)).status).toBe(429);
  });
});

describe('GET /feedback', () => {
  it('refuses without the key', async () => {
    expect((await list()).status).toBe(401);
    expect((await list('wrong')).status).toBe(401);
  });
});
