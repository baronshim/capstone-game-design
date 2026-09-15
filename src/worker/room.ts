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
      const created = !this.state;
      if (!this.state) {
        this.state = createRoom(url.searchParams.get('code') ?? '????', Date.now());
        await this.save();
      }
      await this.syncAlarm();
      return Response.json({ created });
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

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.send(ws, { type: 'error', code: 'bad-json', message: 'Malformed message' });
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.send(ws, { type: 'error', code: 'bad-json', message: 'Malformed message' });
      return;
    }
    const msg = parsed as ClientMessage;
    const att = ws.deserializeAttachment() as Attachment;
    const at = Date.now();
    let event: Event;

    if (msg.type === 'join') {
      if (typeof msg.playerId !== 'string' || msg.playerId.length === 0 || msg.playerId.length > 64) {
        this.send(ws, { type: 'error', code: 'bad-join', message: 'Missing playerId' });
        return;
      }
      ws.serializeAttachment({ playerId: msg.playerId } satisfies Attachment);
      event = { type: 'join', playerId: msg.playerId, displayName: String(msg.displayName ?? ''), at };
    } else if (!att.playerId) {
      this.send(ws, { type: 'error', code: 'not-joined', message: 'Send join first' });
      return;
    } else if (msg.type === 'chat') {
      event = { type: 'chat', playerId: att.playerId, text: String(msg.text ?? ''), at };
    } else if (msg.type === 'start') {
      event = { type: 'start', playerId: att.playerId, at, seed: crypto.getRandomValues(new Uint32Array(1))[0] };
    } else if (msg.type === 'clue') {
      event = { type: 'clue', playerId: att.playerId, word: String(msg.word ?? ''), at };
    } else if (msg.type === 'vote') {
      event = { type: 'vote', playerId: att.playerId, seat: Number(msg.seat), at };
    } else if (msg.type === 'steal') {
      event = { type: 'steal', playerId: att.playerId, word: String(msg.word ?? ''), at };
    } else if (msg.type === 'again') {
      event = { type: 'again', playerId: att.playerId, at };
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
    await this.syncAlarm();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, 'error');
  }

  /**
   * One alarm slot, two jobs. During a timed phase the alarm is the phase
   * deadline and fires a `timeout` event. Otherwise it is the empty-room TTL:
   * with nobody connected the room deletes itself.
   */
  async alarm(): Promise<void> {
    // The DO has exactly one alarm slot, and syncAlarm() overwrites it after every
    // dispatch to mirror the reducer's current phaseEndsAt (or the empty-room TTL
    // when idle). The input gate also serialises this handler with message
    // handlers, so an alarm that fires always belongs to the phase that is still
    // current when it runs. Tests rely on this to fire phases early with
    // runDurableObjectAlarm instead of waiting out the real deadline.
    if (this.state && this.state.phaseEndsAt !== null) {
      await this.dispatch({ type: 'timeout', at: Date.now() });
      return;
    }
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.deleteAll();
      this.state = null;
    } else {
      // Untimed phase with sockets still connected: nothing to fire and no TTL to
      // arm, but re-arm anyway so the DO is never left without a live alarm.
      await this.syncAlarm();
    }
  }

  private async dispatch(event: Event): Promise<void> {
    if (!this.state) return;
    const result = apply(this.state, event);
    this.state = result.state;
    await this.save();
    await this.syncAlarm();

    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment;
      for (const effect of result.effects) {
        if (effect.type === 'error' && effect.to === att.playerId) {
          this.send(ws, { type: 'error', code: effect.code, message: effect.message });
        }
      }
      const seated = att.playerId !== null && this.state.seats.some((s) => s.playerId === att.playerId);
      if (!seated) continue;
      this.send(ws, { type: 'state', snapshot: redact(this.state, att.playerId) });
    }
  }

  /** Mirrors the reducer's deadline into the DO alarm, or arms the deletion TTL when idle and empty. */
  private async syncAlarm(): Promise<void> {
    if (!this.state) return;
    if (this.state.phaseEndsAt !== null) {
      await this.ctx.storage.setAlarm(this.state.phaseEndsAt);
    } else if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.setAlarm(Date.now() + EMPTY_ROOM_TTL_MS);
    } else {
      await this.ctx.storage.deleteAlarm();
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
