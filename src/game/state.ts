import type { ChatLine, Phase, SeatKind } from './protocol';
import { makeAliases, shuffle, type Rng } from './aliases';

export const SEAT_COUNT = 6;
export const MAX_CHAT_LENGTH = 280;
export const MAX_TRANSCRIPT = 200;
const MAX_NAME_LENGTH = 20;

export interface Seat {
  index: number;
  kind: SeatKind;
  alias: string | null;
  playerId?: string;
  displayName?: string;
  connected: boolean;
}

export interface RoomState {
  code: string;
  phase: Phase;
  seats: Seat[];
  transcript: ChatLine[];
  createdAt: number;
}

export type Event =
  | { type: 'join'; playerId: string; displayName: string; at: number }
  | { type: 'disconnect'; playerId: string }
  | { type: 'chat'; playerId: string; text: string; at: number }
  | { type: 'start'; playerId: string };

export type Effect = { type: 'error'; to: string; code: string; message: string };

export interface Result {
  state: RoomState;
  effects: Effect[];
}

export function createRoom(code: string, at: number): RoomState {
  return { code, phase: 'lobby', seats: [], transcript: [], createdAt: at };
}

export function apply(state: RoomState, event: Event, rng: Rng = Math.random): Result {
  switch (event.type) {
    case 'join':
      return join(state, event);
    case 'disconnect':
      return disconnect(state, event);
    case 'chat':
      return chat(state, event);
    case 'start':
      return start(state, event, rng);
  }
}

function ok(state: RoomState): Result {
  return { state, effects: [] };
}

function fail(state: RoomState, to: string, code: string, message: string): Result {
  return { state, effects: [{ type: 'error', to, code, message }] };
}

function seatOf(state: RoomState, playerId: string): Seat | undefined {
  return state.seats.find((s) => s.playerId === playerId);
}

function join(state: RoomState, event: Extract<Event, { type: 'join' }>): Result {
  const existing = seatOf(state, event.playerId);
  if (existing) {
    const seats = state.seats.map((s) => (s === existing ? { ...s, connected: true } : s));
    return ok({ ...state, seats });
  }
  if (state.phase !== 'lobby') return fail(state, event.playerId, 'room-started', 'This round already started');
  if (state.seats.length >= SEAT_COUNT) return fail(state, event.playerId, 'room-full', 'This room is full');
  const displayName = event.displayName.trim().slice(0, MAX_NAME_LENGTH) || `Player ${state.seats.length + 1}`;
  const seat: Seat = {
    index: state.seats.length,
    kind: 'human',
    alias: null,
    playerId: event.playerId,
    displayName,
    connected: true,
  };
  return ok({ ...state, seats: [...state.seats, seat] });
}

function disconnect(state: RoomState, event: Extract<Event, { type: 'disconnect' }>): Result {
  const seats = state.seats.map((s) => (s.playerId === event.playerId ? { ...s, connected: false } : s));
  return ok({ ...state, seats });
}

function chat(state: RoomState, event: Extract<Event, { type: 'chat' }>): Result {
  const seat = seatOf(state, event.playerId);
  if (!seat) return fail(state, event.playerId, 'not-seated', 'Join the room first');
  const text = event.text.trim().slice(0, MAX_CHAT_LENGTH);
  if (!text) return ok(state);
  const line: ChatLine = { seat: seat.index, text, at: event.at };
  return ok({ ...state, transcript: [...state.transcript, line].slice(-MAX_TRANSCRIPT) });
}

function start(state: RoomState, event: Extract<Event, { type: 'start' }>, rng: Rng): Result {
  const seat = seatOf(state, event.playerId);
  if (!seat) return fail(state, event.playerId, 'not-seated', 'Join the room first');
  if (state.phase !== 'lobby') return fail(state, event.playerId, 'already-started', 'The round already started');

  const filled: Seat[] = [...state.seats];
  while (filled.length < SEAT_COUNT) {
    filled.push({ index: filled.length, kind: 'bot', alias: null, connected: true });
  }
  const aliases = makeAliases(SEAT_COUNT, rng);
  const order = shuffle(filled.map((_, i) => i), rng);
  const seats: Seat[] = order.map((from, index) => ({ ...filled[from], index, alias: aliases[index] }));

  // Lobby chat referenced old seat indices, and the round is a fresh transcript anyway.
  return ok({ ...state, phase: 'chat', seats, transcript: [] });
}
