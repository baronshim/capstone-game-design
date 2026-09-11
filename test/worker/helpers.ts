import { afterEach, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import type { ServerMessage, Snapshot } from '../../src/game/protocol';

const openSockets: WebSocket[] = [];

afterEach(() => {
  for (const ws of openSockets.splice(0)) {
    try {
      ws.close(1000, 'test done');
    } catch {
      // already closed
    }
  }
});

export async function createRoom(): Promise<string> {
  const res = await SELF.fetch('http://room.test/rooms', { method: 'POST' });
  expect(res.status).toBe(200);
  const { code } = (await res.json()) as { code: string };
  return code;
}

export interface Client {
  ws: WebSocket;
  send(msg: unknown): void;
  /** Resolves with the first message matching `pred`, discarding everything received before it. */
  next(pred: (m: ServerMessage) => boolean): Promise<ServerMessage>;
  /** Resolves with the first state snapshot matching `pred`. */
  state(pred?: (snap: Snapshot) => boolean): Promise<Snapshot>;
  /** Resolves with the code of the next error message. */
  error(): Promise<string>;
}

export async function connect(code: string): Promise<Client> {
  const res = await SELF.fetch(`http://room.test/rooms/${code}/ws`, { headers: { Upgrade: 'websocket' } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const inbox: ServerMessage[] = [];
  ws.addEventListener('message', (ev: MessageEvent) => {
    inbox.push(JSON.parse(ev.data as string) as ServerMessage);
  });
  ws.accept();
  openSockets.push(ws);

  const next = async (pred: (m: ServerMessage) => boolean): Promise<ServerMessage> => {
    for (let i = 0; i < 300; i++) {
      const idx = inbox.findIndex(pred);
      if (idx >= 0) return inbox.splice(0, idx + 1)[idx];
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out after 3s; inbox=${JSON.stringify(inbox)}`);
  };

  return {
    ws,
    send: (msg) => ws.send(JSON.stringify(msg)),
    next,
    state: async (pred = () => true) => {
      const m = await next((x) => x.type === 'state' && pred(x.snapshot));
      return (m as Extract<ServerMessage, { type: 'state' }>).snapshot;
    },
    error: async () => {
      const m = await next((x) => x.type === 'error');
      return (m as Extract<ServerMessage, { type: 'error' }>).code;
    },
  };
}
