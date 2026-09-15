import type { ChatLine, Outcome, Phase, SeatKind } from './protocol';
import { makeAliases, seededRng, shuffle } from './aliases';
import { pickWord, validateClue } from './words';
import { chooseImposter, DURATIONS, isStealCorrect, resolveVote } from './rules';

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
  isImposter: boolean;
  /** One entry per clue pass; '' means the turn passed with no clue. */
  clues: string[];
  vote: number | null;
}

export interface Round {
  seed: number;
  category: string;
  word: string;
  /** Whose turn it is during the clue phase; null in every other phase. */
  clueSeat: number | null;
  cluePass: 1 | 2;
  ejected: number | null;
  stealGuess: string | null;
  result: Outcome | null;
}

export interface RoomState {
  code: string;
  phase: Phase;
  /** Deadline of the current phase on the server clock; null when untimed. The DO mirrors it into its alarm. */
  phaseEndsAt: number | null;
  seats: Seat[];
  transcript: ChatLine[];
  round: Round | null;
  createdAt: number;
}

export type Event =
  | { type: 'join'; playerId: string; displayName: string; at: number }
  | { type: 'disconnect'; playerId: string }
  | { type: 'chat'; playerId: string; text: string; at: number }
  | { type: 'start'; playerId: string; at: number; seed: number }
  | { type: 'clue'; playerId: string; word: string; at: number }
  | { type: 'vote'; playerId: string; seat: number; at: number }
  | { type: 'steal'; playerId: string; word: string; at: number }
  | { type: 'again'; playerId: string; at: number }
  | { type: 'timeout'; at: number };

export type Effect = { type: 'error'; to: string; code: string; message: string };

export interface Result {
  state: RoomState;
  effects: Effect[];
}

const CHAT_PHASES: readonly Phase[] = ['lobby', 'chat', 'reveal'];

export function createRoom(code: string, at: number): RoomState {
  return { code, phase: 'lobby', phaseEndsAt: null, seats: [], transcript: [], round: null, createdAt: at };
}

export function apply(state: RoomState, event: Event): Result {
  switch (event.type) {
    case 'join':
      return join(state, event);
    case 'disconnect':
      return disconnect(state, event);
    case 'chat':
      return chat(state, event);
    case 'start':
      return start(state, event);
    case 'clue':
      return clue(state, event);
    case 'vote':
      return vote(state, event);
    case 'steal':
      return steal(state, event);
    case 'again':
      return again(state, event);
    case 'timeout':
      return timeout(state, event);
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
    isImposter: false,
    clues: [],
    vote: null,
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
  if (!CHAT_PHASES.includes(state.phase)) return fail(state, event.playerId, 'chat-closed', 'Chat opens after the clues');
  const text = event.text.trim().slice(0, MAX_CHAT_LENGTH);
  if (!text) return ok(state);
  const line: ChatLine = { seat: seat.index, text, at: event.at };
  return ok({ ...state, transcript: [...state.transcript, line].slice(-MAX_TRANSCRIPT) });
}

function start(state: RoomState, event: Extract<Event, { type: 'start' }>): Result {
  const seat = seatOf(state, event.playerId);
  if (!seat) return fail(state, event.playerId, 'not-seated', 'Join the room first');
  if (state.phase !== 'lobby') return fail(state, event.playerId, 'already-started', 'The round already started');

  const rng = seededRng(event.seed);
  const filled: Seat[] = [...state.seats];
  while (filled.length < SEAT_COUNT) {
    filled.push({ index: filled.length, kind: 'bot', alias: null, connected: true, isImposter: false, clues: [], vote: null });
  }
  const aliases = makeAliases(SEAT_COUNT, rng);
  const order = shuffle(filled.map((_, i) => i), rng);
  const seats: Seat[] = order.map((from, index) => ({
    ...filled[from],
    index,
    alias: aliases[index],
    isImposter: false,
    clues: [],
    vote: null,
  }));
  const { category, word } = pickWord(rng);
  const imposter = chooseImposter(seats, rng);
  seats[imposter] = { ...seats[imposter], isImposter: true };

  const round: Round = { seed: event.seed, category, word, clueSeat: 0, cluePass: 1, ejected: null, stealGuess: null, result: null };
  // Lobby chat referenced old seat indices, and the round is a fresh transcript anyway.
  const next: RoomState = { ...state, phase: 'clue', phaseEndsAt: event.at + DURATIONS.clueTurn, seats, transcript: [], round };
  return ok(skipBotClues(next, event.at));
}

/** Records a clue ('' for a passed turn) for the seat whose turn it is, then moves to the next turn or opens the chat. */
function recordClue(state: RoomState, clueText: string, at: number): RoomState {
  const round = state.round!;
  const current = round.clueSeat!;
  const seats = state.seats.map((s) => (s.index === current ? { ...s, clues: [...s.clues, clueText] } : s));
  if (current < SEAT_COUNT - 1) {
    return { ...state, seats, phaseEndsAt: at + DURATIONS.clueTurn, round: { ...round, clueSeat: current + 1 } };
  }
  if (round.cluePass === 1) {
    return { ...state, seats, phaseEndsAt: at + DURATIONS.clueTurn, round: { ...round, clueSeat: 0, cluePass: 2 } };
  }
  return { ...state, seats, phase: 'chat', phaseEndsAt: at + DURATIONS.chat, round: { ...round, clueSeat: null } };
}

/** M2 has no bot brains: a bot's clue turn passes immediately. M3 replaces this with a botTurn effect. */
function skipBotClues(state: RoomState, at: number): RoomState {
  while (state.phase === 'clue' && state.seats[state.round!.clueSeat!].kind === 'bot') {
    state = recordClue(state, '', at);
  }
  return state;
}

function clue(state: RoomState, event: Extract<Event, { type: 'clue' }>): Result {
  const seat = seatOf(state, event.playerId);
  if (!seat) return fail(state, event.playerId, 'not-seated', 'Join the room first');
  if (state.phase !== 'clue' || !state.round) return fail(state, event.playerId, 'wrong-phase', 'Clues are closed');
  if (state.round.clueSeat !== seat.index) return fail(state, event.playerId, 'not-your-turn', 'Wait for your turn');
  const prior = state.seats.flatMap((s) => s.clues);
  const check = validateClue(event.word, state.round.word, prior);
  if (!check.ok) return fail(state, event.playerId, check.code, check.message);
  return ok(skipBotClues(recordClue(state, check.clue, event.at), event.at));
}

function enterVote(state: RoomState, at: number): RoomState {
  return { ...state, phase: 'vote', phaseEndsAt: at + DURATIONS.vote, seats: state.seats.map((s) => ({ ...s, vote: null })) };
}

function finish(state: RoomState, result: Outcome): RoomState {
  return { ...state, phase: 'reveal', phaseEndsAt: null, round: { ...state.round!, result } };
}

function closeVote(state: RoomState, at: number): RoomState {
  const ejected = resolveVote(state.seats.map((s) => s.vote));
  const withEjected: RoomState = { ...state, round: { ...state.round!, ejected } };
  if (ejected === null || !state.seats[ejected].isImposter) return finish(withEjected, 'imposter');
  // A bot imposter has nobody to make the steal guess (M3 gives bots one).
  if (state.seats[ejected].kind === 'bot') return finish(withEjected, 'crew');
  return { ...withEjected, phase: 'steal', phaseEndsAt: at + DURATIONS.steal };
}

function vote(state: RoomState, event: Extract<Event, { type: 'vote' }>): Result {
  const seat = seatOf(state, event.playerId);
  if (!seat) return fail(state, event.playerId, 'not-seated', 'Join the room first');
  if (state.phase !== 'vote') return fail(state, event.playerId, 'wrong-phase', 'Voting is closed');
  if (!Number.isInteger(event.seat) || event.seat < 0 || event.seat >= state.seats.length || event.seat === seat.index) {
    return fail(state, event.playerId, 'bad-vote', 'Vote for another seat');
  }
  const seats = state.seats.map((s) => (s.index === seat.index ? { ...s, vote: event.seat } : s));
  const next = { ...state, seats };
  const allIn = seats.every((s) => s.kind !== 'human' || s.vote !== null);
  return ok(allIn ? closeVote(next, event.at) : next);
}

function steal(state: RoomState, event: Extract<Event, { type: 'steal' }>): Result {
  const seat = seatOf(state, event.playerId);
  if (!seat) return fail(state, event.playerId, 'not-seated', 'Join the room first');
  if (state.phase !== 'steal') return fail(state, event.playerId, 'wrong-phase', 'No steal in progress');
  if (!seat.isImposter) return fail(state, event.playerId, 'not-imposter', 'Only the imposter can steal');
  const guess = event.word.trim().slice(0, 40);
  const result: Outcome = isStealCorrect(guess, state.round!.word) ? 'imposter' : 'crew';
  return ok(finish({ ...state, round: { ...state.round!, stealGuess: guess } }, result));
}

function again(state: RoomState, event: Extract<Event, { type: 'again' }>): Result {
  const seat = seatOf(state, event.playerId);
  if (!seat) return fail(state, event.playerId, 'not-seated', 'Join the room first');
  if (state.phase !== 'reveal') return fail(state, event.playerId, 'wrong-phase', 'The round is still going');
  const seats = state.seats
    .filter((s) => s.kind === 'human')
    .map((s, index) => ({ ...s, index, alias: null, isImposter: false, clues: [], vote: null }));
  return ok({ ...state, phase: 'lobby', phaseEndsAt: null, seats, transcript: [], round: null });
}

function timeout(state: RoomState, event: Extract<Event, { type: 'timeout' }>): Result {
  switch (state.phase) {
    case 'clue':
      return ok(skipBotClues(recordClue(state, '', event.at), event.at));
    case 'chat':
      return ok(enterVote(state, event.at));
    case 'vote':
      return ok(closeVote(state, event.at));
    case 'steal':
      return ok(finish(state, 'crew'));
    default:
      return ok(state);
  }
}
