import type { BotCall, ChatLine, Outcome, Phase, SeatKind } from './protocol';
import { makeAliases, seededRng, shuffle } from './aliases';
import { pickWord, validateClue } from './words';
import { chooseImposter, DURATIONS, isStealCorrect, resolveVote, roundPoints, type RoundPoints } from './rules';

export const SEAT_COUNT = 6;
export const MAX_CHAT_LENGTH = 280;
export const MAX_TRANSCRIPT = 200;
const MAX_NAME_LENGTH = 20;
export const MAX_STEAL_LENGTH = 40;

export interface Seat {
  index: number;
  kind: SeatKind;
  alias: string | null;
  playerId?: string;
  displayName?: string;
  /** Bots are always connected. */
  connected: boolean;
  isImposter: boolean;
  /** One entry per clue pass; '' means the turn passed with no clue. */
  clues: string[];
  vote: number | null;
  /** The human's Human/Bot call per seat index, locked in during the bot-call phase; null until then and for bots. */
  botCalls: BotCall[] | null;
  /** Round points, computed at the reveal; null before it. */
  score: number | null;
  /** How the round points break down; null before the reveal. */
  points: RoundPoints | null;
  /** Running total across rounds in this room. Bots are recreated each round, so only humans carry one. */
  total: number;
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
  /** Seats with the highest round score, set at the reveal; null before it. */
  winners: number[] | null;
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
  | { type: 'botcall'; playerId: string; calls: BotCall[]; at: number }
  | { type: 'again'; playerId: string; at: number }
  | { type: 'timeout'; at: number }
  /** Bot events are produced by the Durable Object from botTurn effects; `pass` guards against a clue from the previous pass. */
  | { type: 'botClue'; seat: number; pass: 1 | 2; word: string; at: number }
  | { type: 'botChat'; seat: number; text: string; at: number }
  | { type: 'botVote'; seat: number; target: number; at: number }
  | { type: 'botSteal'; seat: number; word: string; at: number };

export type BotAction = 'clue' | 'chat' | 'vote' | 'steal';
/**
 * What a bot is trying to do with one chat line, so bots open threads and
 * push back instead of only echoing the latest line (spec 5.5).
 */
export type BotMove = 'open' | 'question' | 'disagree' | 'defend' | 'aside' | 'react';
/** Asks the Durable Object to run one bot action after `delayMs`. A turn that arrives late is ignored by the reducer. `move` is set for chat turns. */
export type BotTurn = { type: 'botTurn'; seat: number; action: BotAction; delayMs: number; move?: BotMove };
export type Effect = { type: 'error'; to: string; code: string; message: string } | BotTurn;

export interface Result {
  state: RoomState;
  effects: Effect[];
}

const CHAT_PHASES: readonly Phase[] = ['lobby', 'chat', 'reveal'];

export function createRoom(code: string, at: number): RoomState {
  return { code, phase: 'lobby', phaseEndsAt: null, seats: [], transcript: [], round: null, createdAt: at };
}

export function apply(state: RoomState, event: Event): Result {
  const result = applyEvent(state, event);
  return { state: result.state, effects: [...result.effects, ...botEffects(state, result.state)] };
}

function applyEvent(state: RoomState, event: Event): Result {
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
    case 'botcall':
      return botcall(state, event);
    case 'again':
      return again(state, event);
    case 'timeout':
      return timeout(state, event);
    case 'botClue':
      return botClue(state, event);
    case 'botChat':
      return botChat(state, event);
    case 'botVote':
      return botVote(state, event);
    case 'botSteal':
      return botSteal(state, event);
  }
}

/**
 * Bot turns owed by the transition from `prev` to `next`: the bot whose clue
 * turn just opened, every bot's chat ticks when the chat opens, replies to a
 * line posted during the chat, every bot's vote when the vote opens, and the
 * steal of an ejected bot imposter. Timing jitter derives from the round seed
 * so a round is reproducible.
 */
export function botEffects(prev: RoomState, next: RoomState): BotTurn[] {
  const round = next.round;
  if (!round) return [];
  const out: BotTurn[] = [];
  if (next.phase === 'clue') {
    const seat = next.seats[round.clueSeat!];
    const newTurn = prev.phase !== 'clue' || prev.round?.clueSeat !== round.clueSeat || prev.round?.cluePass !== round.cluePass;
    if (newTurn && seat.kind === 'bot') {
      const rng = seededRng(round.seed + round.cluePass * 100 + seat.index);
      out.push({ type: 'botTurn', seat: seat.index, action: 'clue', delayMs: 1500 + Math.floor(rng() * 4500) });
    }
  } else if (next.phase === 'chat' && prev.phase !== 'chat') {
    out.push(...chatTicks(next));
  } else if (next.phase === 'chat' && prev.phase === 'chat' && next.transcript.length > prev.transcript.length) {
    out.push(...replyTicks(next));
  } else if (next.phase === 'vote' && prev.phase !== 'vote') {
    const rng = seededRng(round.seed ^ 0x9e3779b9);
    for (const seat of next.seats) {
      if (seat.kind !== 'bot') continue;
      out.push({ type: 'botTurn', seat: seat.index, action: 'vote', delayMs: 3000 + Math.floor(rng() * 9000) });
    }
  } else if (next.phase === 'steal' && prev.phase !== 'steal') {
    const ejected = next.seats[round.ejected!];
    if (ejected.kind === 'bot') {
      const rng = seededRng(round.seed ^ 0x27d4eb2f);
      out.push({ type: 'botTurn', seat: ejected.index, action: 'steal', delayMs: 2000 + Math.floor(rng() * 6000) });
    }
  }
  return out;
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
    botCalls: null,
    score: null,
    points: null,
    total: 0,
  };
  return ok({ ...state, seats: [...state.seats, seat] });
}

function disconnect(state: RoomState, event: Extract<Event, { type: 'disconnect' }>): Result {
  const seats = state.seats.map((s) => (s.playerId === event.playerId ? { ...s, connected: false } : s));
  return ok({ ...state, seats });
}

/** Moves a bot may draw for a scheduled chat tick, weighted; the round's first tick is always an `open`. */
const MOVE_POOL: BotMove[] = ['open', 'question', 'question', 'disagree', 'disagree', 'aside', 'react', 'react', 'react'];

/** Chat ticks for the phase (spec 5.5): 3 to 5 per bot, two bots open within 2 to 6s, the rest spread to 80s. */
function chatTicks(next: RoomState): BotTurn[] {
  const round = next.round!;
  const rng = seededRng(round.seed ^ 0x5bd1e995);
  const bots = next.seats.filter((s) => s.kind === 'bot').map((s) => s.index);
  for (let i = bots.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [bots[i], bots[j]] = [bots[j], bots[i]];
  }
  const out: BotTurn[] = [];
  bots.forEach((seat, order) => {
    const ticks = 3 + Math.floor(rng() * 3);
    const delays: number[] = [];
    if (order < 2) delays.push(2000 + Math.floor(rng() * 4000));
    while (delays.length < ticks) delays.push(8000 + Math.floor(rng() * 72_000));
    delays.sort((a, b) => a - b);
    for (const delayMs of delays) {
      const move = MOVE_POOL[Math.floor(rng() * MOVE_POOL.length)];
      out.push({ type: 'botTurn', seat, action: 'chat', delayMs, move });
    }
  });
  const first = out.reduce((a, b) => (b.delayMs < a.delayMs ? b : a), out[0]);
  if (first) first.move = 'open';
  return out;
}

/** True when `text` names the seat by any word of its call sign. */
export function namesSeat(text: string, alias: string | null): boolean {
  if (!alias) return false;
  const words = text.toLowerCase().split(/[^a-z]+/);
  return alias
    .toLowerCase()
    .split(/\s+/)
    .some((w) => w.length > 1 && words.includes(w));
}

/**
 * Ticks owed to the line just posted (spec 5.5): a bot it names replies to
 * defend itself, otherwise one bot may react, more often to a human than to
 * another bot so bot-to-bot chains stay short.
 */
function replyTicks(next: RoomState): BotTurn[] {
  const round = next.round!;
  const line = next.transcript[next.transcript.length - 1];
  const speaker = next.seats[line.seat];
  if (!speaker) return [];
  const rng = seededRng((round.seed ^ Math.imul(next.transcript.length, 0x9e3779b1)) >>> 0);
  const bots = next.seats.filter((s) => s.kind === 'bot' && s.index !== line.seat);
  const out: BotTurn[] = [];
  const named = bots.filter((s) => namesSeat(line.text, s.alias));
  for (const s of named) {
    if (rng() < 0.9) out.push({ type: 'botTurn', seat: s.index, action: 'chat', delayMs: 2500 + Math.floor(rng() * 4500), move: 'defend' });
  }
  if (named.length === 0 && bots.length > 0 && rng() < (speaker.kind === 'human' ? 0.6 : 0.3)) {
    const s = bots[Math.floor(rng() * bots.length)];
    out.push({ type: 'botTurn', seat: s.index, action: 'chat', delayMs: 2500 + Math.floor(rng() * 4500), move: 'react' });
  }
  return out;
}

/** Appends a chat line for a seat, trimmed and capped; an empty line is a no-op. */
function appendLine(state: RoomState, seat: number, raw: string, at: number): RoomState {
  const text = raw.trim().slice(0, MAX_CHAT_LENGTH);
  if (!text) return state;
  const line: ChatLine = { seat, text, at };
  return { ...state, transcript: [...state.transcript, line].slice(-MAX_TRANSCRIPT) };
}

function chat(state: RoomState, event: Extract<Event, { type: 'chat' }>): Result {
  const seat = seatOf(state, event.playerId);
  if (!seat) return fail(state, event.playerId, 'not-seated', 'Join the room first');
  if (!CHAT_PHASES.includes(state.phase)) return fail(state, event.playerId, 'chat-closed', 'Chat opens after the clues');
  return ok(appendLine(state, seat.index, event.text, event.at));
}

function botChat(state: RoomState, event: Extract<Event, { type: 'botChat' }>): Result {
  if (state.phase !== 'chat') return ok(state);
  const seat = state.seats[event.seat];
  if (!seat || seat.kind !== 'bot') return ok(state);
  return ok(appendLine(state, seat.index, event.text, event.at));
}

function start(state: RoomState, event: Extract<Event, { type: 'start' }>): Result {
  const seat = seatOf(state, event.playerId);
  if (!seat) return fail(state, event.playerId, 'not-seated', 'Join the room first');
  if (state.phase !== 'lobby') return fail(state, event.playerId, 'already-started', 'The round already started');

  const rng = seededRng(event.seed);
  const filled: Seat[] = [...state.seats];
  while (filled.length < SEAT_COUNT) {
    filled.push({
      index: filled.length,
      kind: 'bot',
      alias: null,
      connected: true,
      isImposter: false,
      clues: [],
      vote: null,
      botCalls: null,
      score: null,
      points: null,
      total: 0,
    });
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
    botCalls: null,
    score: null,
    points: null,
  }));
  const { category, word } = pickWord(rng);
  const imposter = chooseImposter(seats, rng);
  seats[imposter] = { ...seats[imposter], isImposter: true };

  const round: Round = { seed: event.seed, category, word, clueSeat: 0, cluePass: 1, ejected: null, stealGuess: null, result: null, winners: null };
  // Lobby chat referenced old seat indices, and the round is a fresh transcript anyway.
  // The deal: everyone reads their card for a few seconds before the first clue turn opens.
  return ok({ ...state, phase: 'deal', phaseEndsAt: event.at + DURATIONS.deal, seats, transcript: [], round });
}

/** Opens the first clue turn once the deal has been read. */
function enterClue(state: RoomState, at: number): RoomState {
  return { ...state, phase: 'clue', phaseEndsAt: at + DURATIONS.clueTurn };
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

function clue(state: RoomState, event: Extract<Event, { type: 'clue' }>): Result {
  const seat = seatOf(state, event.playerId);
  if (!seat) return fail(state, event.playerId, 'not-seated', 'Join the room first');
  if (state.phase !== 'clue' || !state.round) return fail(state, event.playerId, 'wrong-phase', 'Clues are closed');
  if (state.round.clueSeat !== seat.index) return fail(state, event.playerId, 'not-your-turn', 'Wait for your turn');
  const prior = state.seats.flatMap((s) => s.clues);
  // An imposter's clue skips the secret-word check: the check exists to stop the
  // imposter from probing the category for free, and an imposter who says the
  // word has simply outed themselves rather than exploited anything.
  const check = validateClue(event.word, state.round.word, prior, !seat.isImposter);
  if (!check.ok) return fail(state, event.playerId, check.code, check.message);
  return ok(recordClue(state, check.clue, event.at));
}

/** A bot's clue never skips the secret-word check (spec 5.7); anything invalid passes the turn silently. */
function botClue(state: RoomState, event: Extract<Event, { type: 'botClue' }>): Result {
  const round = state.round;
  if (state.phase !== 'clue' || !round || round.clueSeat !== event.seat || round.cluePass !== event.pass) return ok(state);
  const seat = state.seats[event.seat];
  if (!seat || seat.kind !== 'bot') return ok(state);
  const prior = state.seats.flatMap((s) => s.clues);
  const check = validateClue(event.word, round.word, prior);
  return ok(recordClue(state, check.ok ? check.clue : '', event.at));
}

function enterVote(state: RoomState, at: number): RoomState {
  return { ...state, phase: 'vote', phaseEndsAt: at + DURATIONS.vote, seats: state.seats.map((s) => ({ ...s, vote: null })) };
}

/** Every seat that can still vote has: bots always vote, humans only while connected (spec 4.5). */
function votesComplete(seats: Seat[]): boolean {
  return seats.every((s) => s.vote !== null || (s.kind === 'human' && !s.connected));
}

/** The round is decided: humans get 20s to call every seat Human or Bot before the reveal (spec 2.3.5). */
function finish(state: RoomState, result: Outcome, at: number): RoomState {
  return { ...state, phase: 'botcall', phaseEndsAt: at + DURATIONS.botcall, round: { ...state.round!, result } };
}

/** Scores every seat for the round, adds it to the running totals, names the winners, and opens the untimed reveal. */
function reveal(state: RoomState): RoomState {
  const round = state.round!;
  const outcome = { ejected: round.ejected, stealCorrect: round.stealGuess !== null && isStealCorrect(round.stealGuess, round.word) };
  const seats = state.seats.map((s) => {
    const points = roundPoints(s, state.seats, outcome);
    return { ...s, score: points.total, points, total: s.total + points.total };
  });
  const best = Math.max(...seats.map((s) => s.score));
  const winners = seats.filter((s) => s.score === best).map((s) => s.index);
  return { ...state, phase: 'reveal', phaseEndsAt: null, seats, round: { ...round, winners } };
}

/** True once every connected human has locked in their calls; a disconnected human does not hold the phase open. */
function callsComplete(seats: Seat[]): boolean {
  return seats.every((s) => s.kind !== 'human' || !s.connected || s.botCalls !== null);
}

function closeVote(state: RoomState, at: number): RoomState {
  const ejected = resolveVote(state.seats.map((s) => s.vote));
  const withEjected: RoomState = { ...state, round: { ...state.round!, ejected } };
  if (ejected === null || !state.seats[ejected].isImposter) return finish(withEjected, 'imposter', at);
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
  return ok(votesComplete(seats) ? closeVote(next, event.at) : next);
}

/** A bot votes once; a second or malformed vote is ignored rather than rejected. */
function botVote(state: RoomState, event: Extract<Event, { type: 'botVote' }>): Result {
  if (state.phase !== 'vote') return ok(state);
  const seat = state.seats[event.seat];
  if (!seat || seat.kind !== 'bot' || seat.vote !== null) return ok(state);
  const target = event.target;
  if (!Number.isInteger(target) || target < 0 || target >= state.seats.length || target === seat.index) return ok(state);
  const seats = state.seats.map((s) => (s.index === seat.index ? { ...s, vote: target } : s));
  const next = { ...state, seats };
  return ok(votesComplete(seats) ? closeVote(next, event.at) : next);
}

function resolveSteal(state: RoomState, word: string, at: number): RoomState {
  const guess = word.trim().slice(0, MAX_STEAL_LENGTH);
  const result: Outcome = isStealCorrect(guess, state.round!.word) ? 'imposter' : 'crew';
  return finish({ ...state, round: { ...state.round!, stealGuess: guess } }, result, at);
}

function steal(state: RoomState, event: Extract<Event, { type: 'steal' }>): Result {
  const seat = seatOf(state, event.playerId);
  if (!seat) return fail(state, event.playerId, 'not-seated', 'Join the room first');
  if (state.phase !== 'steal') return fail(state, event.playerId, 'wrong-phase', 'No steal in progress');
  if (!seat.isImposter) return fail(state, event.playerId, 'not-imposter', 'Only the imposter can steal');
  return ok(resolveSteal(state, event.word, event.at));
}

function botSteal(state: RoomState, event: Extract<Event, { type: 'botSteal' }>): Result {
  if (state.phase !== 'steal') return ok(state);
  const seat = state.seats[event.seat];
  if (!seat || seat.kind !== 'bot' || !seat.isImposter) return ok(state);
  return ok(resolveSteal(state, event.word, event.at));
}

function botcall(state: RoomState, event: Extract<Event, { type: 'botcall' }>): Result {
  const seat = seatOf(state, event.playerId);
  if (!seat) return fail(state, event.playerId, 'not-seated', 'Join the room first');
  if (state.phase !== 'botcall') return fail(state, event.playerId, 'wrong-phase', 'Bot calls are closed');
  const valid =
    Array.isArray(event.calls) &&
    event.calls.length === state.seats.length &&
    event.calls.every((c) => c === 'human' || c === 'bot' || c === null);
  if (!valid) return fail(state, event.playerId, 'bad-botcall', 'Call every seat Human, Bot, or leave it blank');
  const calls = event.calls.map((c, i) => (i === seat.index ? null : c));
  const seats = state.seats.map((s) => (s.index === seat.index ? { ...s, botCalls: calls } : s));
  const next = { ...state, seats };
  return ok(callsComplete(seats) ? reveal(next) : next);
}

function again(state: RoomState, event: Extract<Event, { type: 'again' }>): Result {
  const seat = seatOf(state, event.playerId);
  if (!seat) return fail(state, event.playerId, 'not-seated', 'Join the room first');
  if (state.phase !== 'reveal') return fail(state, event.playerId, 'wrong-phase', 'The round is still going');
  const seats = state.seats
    .filter((s) => s.kind === 'human' && s.connected)
    .map((s, index) => ({ ...s, index, alias: null, isImposter: false, clues: [], vote: null, botCalls: null, score: null, points: null }));
  return ok({ ...state, phase: 'lobby', phaseEndsAt: null, seats, transcript: [], round: null });
}

function timeout(state: RoomState, event: Extract<Event, { type: 'timeout' }>): Result {
  switch (state.phase) {
    case 'deal':
      return ok(enterClue(state, event.at));
    case 'clue':
      return ok(recordClue(state, '', event.at));
    case 'chat':
      return ok(enterVote(state, event.at));
    case 'vote':
      return ok(closeVote(state, event.at));
    case 'steal':
      return ok(finish(state, 'crew', event.at));
    case 'botcall':
      return ok(reveal(state));
    default:
      return ok(state);
  }
}
