import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { apply, createRoom, type Event, type RoomState } from '../game/state';
import { redact } from '../game/redact';
import type { ClientMessage, ServerMessage } from '../game/protocol';

const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;

interface Attachment {
  playerId: string | null;
}

export class RoomObject extends DurableObject<Env> {
  private state: RoomState | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get<RoomState>('state')) ?? null;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/create' && request.method === 'POST') {
      if (!this.state) {
        this.state = createRoom(url.searchParams.get('code') ?? '????', Date.now());
        await this.save();
      }
      await this.ctx.storage.setAlarm(Date.now() + EMPTY_ROOM_TTL_MS);
      return Response.json({ ok: true });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.serializeAttachment({ playerId: null } satisfies Attachment);
    this.ctx.acceptWebSocket(server);

    if (!this.state) {
      // Accept so the browser gets a readable error instead of a bare connection failure.
      this.send(server, { type: 'error', code: 'room-not-found', message: 'No room with that code' });
      server.close(4004, 'room-not-found');
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string' || !this.state) return;

    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      this.send(ws, { type: 'error', code: 'bad-json', message: 'Malformed message' });
      return;
    }

    const att = ws.deserializeAttachment() as Attachment;
    let event: Event;

    if (msg.type === 'join') {
      if (typeof msg.playerId !== 'string' || msg.playerId.length === 0 || msg.playerId.length > 64) {
        this.send(ws, { type: 'error', code: 'bad-join', message: 'Missing playerId' });
        return;
      }
      ws.serializeAttachment({ playerId: msg.playerId } satisfies Attachment);
      event = { type: 'join', playerId: msg.playerId, displayName: String(msg.displayName ?? ''), at: Date.now() };
    } else if (!att.playerId) {
      this.send(ws, { type: 'error', code: 'not-joined', message: 'Send join first' });
      return;
    } else if (msg.type === 'chat') {
      event = { type: 'chat', playerId: att.playerId, text: String(msg.text ?? ''), at: Date.now() };
    } else if (msg.type === 'start') {
      event = { type: 'start', playerId: att.playerId };
    } else {
      this.send(ws, { type: 'error', code: 'unknown-type', message: 'Unknown message type' });
      return;
    }

    await this.dispatch(event);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
    const att = ws.deserializeAttachment() as Attachment;
    const others = this.ctx.getWebSockets().filter((o) => o !== ws);
    if (att.playerId && this.state) {
      const stillOpen = others.some((o) => (o.deserializeAttachment() as Attachment).playerId === att.playerId);
      if (!stillOpen) await this.dispatch({ type: 'disconnect', playerId: att.playerId });
    }
    if (others.length === 0) {
      await this.ctx.storage.setAlarm(Date.now() + EMPTY_ROOM_TTL_MS);
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, 'error');
  }

  /** Fires 10 minutes after the last socket closed. Deletes the room if still empty. */
  async alarm(): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.deleteAll();
      this.state = null;
    }
  }

  private async dispatch(event: Event): Promise<void> {
    if (!this.state) return;
    const result = apply(this.state, event);
    this.state = result.state;
    await this.save();

    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment;
      for (const effect of result.effects) {
        if (effect.to === att.playerId) {
          this.send(ws, { type: 'error', code: effect.code, message: effect.message });
        }
      }
      this.send(ws, { type: 'state', snapshot: redact(this.state, att.playerId) });
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // socket already gone; close handler will clean up
    }
  }

  private async save(): Promise<void> {
    if (this.state) await this.ctx.storage.put('state', this.state);
  }
}
