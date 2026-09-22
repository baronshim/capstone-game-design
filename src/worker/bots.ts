import type { Env } from './env';
import type { BotTurn, Event, RoomState } from '../game/state';
import { MAX_STEAL_LENGTH } from '../game/state';
import { isSecretWord, validateClue } from '../game/words';
import { type BotContext, type BotInputs, MAX_BOT_LINE, personaFor, type Read, styleSheet } from './prompts';
import { ScriptedBackend } from './backends/scripted';
import { FakeBackend } from './backends/fake';
import { DEFAULT_MODEL, WorkersAiBackend, type AiLike } from './backends/workersAi';

/** One bot action through one backend (spec 5.2). */
export interface BotBackend {
  /** Resolves with the raw reply for validation. A null reply or a throw is a failed call. */
  run(inputs: BotInputs): Promise<unknown>;
}


/** What the bot may know for this turn: never another seat's identity, never the word for the imposter. `read` is its own last theory. */
export function buildInputs(state: RoomState, turn: BotTurn, read: Read | null = null): BotInputs {
  const round = state.round!;
  const seat = state.seats[turn.seat];
  const humanSeats = new Set(state.seats.filter((s) => s.kind === 'human').map((s) => s.index));
  const name = (i: number) => state.seats[i].alias ?? `Seat ${i + 1}`;
  const ctx: BotContext = {
    seat: seat.index,
    alias: name(seat.index),
    aliases: state.seats.map((s) => name(s.index)),
    category: round.category,
    word: seat.isImposter ? null : round.word,
    isImposter: seat.isImposter,
    cluesBySeat: state.seats.map((s) => s.clues),
    transcript: state.transcript,
    style: styleSheet(state.transcript.filter((l) => humanSeats.has(l.seat)).map((l) => l.text)),
    persona: personaFor(round.seed, seat.index),
    read,
  };
  if (turn.action === 'clue') return { action: 'clue', pass: round.cluePass, ...ctx };
  if (turn.action === 'chat') return { action: 'chat', ...ctx, move: turn.move ?? 'react' };
  return { action: turn.action, ...ctx };
}

/** True when any token of `text` is the secret word or a plural or stem of it (spec 5.7). */
export function mentionsWord(text: string, word: string): boolean {
  if (!word) return false;
  return text.split(/[^A-Za-z]+/).some((token) => token !== '' && isSecretWord(token, word));
}

export type Validated = { ok: true; event: Event | null } | { ok: false; reason: string };

/** The theory a chat reply carries, or null when it names an invalid seat or the bot itself. Silence still carries one. */
export function readFrom(inputs: BotInputs, raw: unknown): Read | null {
  if (inputs.action !== 'chat' || raw === null || typeof raw !== 'object') return null;
  const out = raw as Record<string, unknown>;
  const suspect = out.suspect;
  if (typeof suspect !== 'number' || !Number.isInteger(suspect) || suspect < 0 || suspect >= inputs.aliases.length || suspect === inputs.seat) return null;
  const reason = typeof out.reason === 'string' ? out.reason.trim().slice(0, 80) : '';
  return { suspect, reason: reason || 'gut feeling' };
}

/** Chat lines a bot may post per round; a talkative human manages about this many in 150 seconds. */
export const MAX_BOT_LINES_PER_ROUND = 7;
/** A bot never posts two lines closer together than this; people do not double-post seconds apart. */
export const MIN_BOT_GAP_MS = 6000;

/** True when the seat is still under its line cap and its last line is old enough (spec 5.5). */
export function canSpeak(state: RoomState, seat: number, now: number): boolean {
  const mine = state.transcript.filter((l) => l.seat === seat);
  if (mine.length >= MAX_BOT_LINES_PER_ROUND) return false;
  const last = mine[mine.length - 1];
  return !last || now - last.at >= MIN_BOT_GAP_MS;
}

/**
 * Re-runs the chat checks against the current room right before a line is
 * posted. Turns run concurrently and the typing delay sits between validation
 * and dispatch, so a line that was fine when the model answered may since have
 * been said by someone else, or the bot may have just spoken.
 */
export function recheckChat(state: RoomState, turn: BotTurn, text: string, now: number): boolean {
  if (state.phase !== 'chat' || !state.round) return false;
  if (!canSpeak(state, turn.seat, now)) return false;
  const inputs = buildInputs(state, { ...turn, action: 'chat' });
  if (inputs.action !== 'chat') return false;
  return chatLineProblem(text, inputs) === null;
}

/** Openers of a line that only agrees with someone. */
const AGREE = /^(yeah|yep|yea|ya|yup|same|agreed?|true|exactly|right|this|facts|i agree|i think so too|good point|fair)\b/i;

/** Model-speak that reads as a bot in this game's chat (seen live 2026-09-16). Matched as whole words, case-insensitive. */
export const FILLER = /\b(definitely|sus|vibes|for real|honestly|tbh|lol|haha|let'?s go+|hyped?|ready to (win|play|go))\b/i;

const EMOJI = /\p{Extended_Pictographic}/u;

/** Words that carry no point of their own, ignored when comparing lines. */
const STOP = new Set(
  (
    'a an the i im is it its so to of and or but at all on in for with that this be was were do does did dont doesnt didnt ' +
    'not no yeah yes ok okay u ur you your we they he she me my just like really kinda sorta maybe think also too very ' +
    'what who why how hmm hm oh well wait'
  ).split(' '),
);

/** The content words of a line, lowercased, punctuation stripped, stop words dropped. */
function wordSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );
}

/** True when `text` opens by agreeing and adds at most a name or two of its own, like "yeah same" or "agree with fox". */
export function pureAgreement(text: string): boolean {
  return AGREE.test(text.trim()) && wordSet(text).size <= 3;
}

/** True when `text` makes the point `prior` made: at least three quarters of the shorter line's content words are in the other. */
export function nearDuplicate(text: string, prior: string): boolean {
  const a = wordSet(text);
  const b = wordSet(prior);
  if (a.size < 2 || b.size < 2) return false;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / Math.min(a.size, b.size) >= 0.75;
}

/** Why a chat line would read as a bot, or null when it passes (spec 5.7 plus the live tells). */
export function chatLineProblem(text: string, inputs: Extract<BotInputs, { action: 'chat' }>): string | null {
  if (FILLER.test(text)) return 'say-filler';
  if (EMOJI.test(text) && inputs.style.emojiRate === 0) return 'say-emoji';
  if (inputs.transcript.some((l) => nearDuplicate(text, l.text))) return 'say-duplicate';
  if (pureAgreement(text)) return 'say-agree';
  return null;
}

/** Checks a raw reply against the game (spec 5.7). `ok` with a null event is a valid silence. */
export function validateOutput(state: RoomState, inputs: BotInputs, raw: unknown, at: number): Validated {
  if (raw === null || typeof raw !== 'object') return { ok: false, reason: 'not-an-object' };
  const out = raw as Record<string, unknown>;
  const word = state.round?.word ?? '';
  switch (inputs.action) {
    case 'clue': {
      if (typeof out.clue !== 'string') return { ok: false, reason: 'clue-missing' };
      const check = validateClue(out.clue, word, inputs.cluesBySeat.flat());
      if (!check.ok) return { ok: false, reason: check.code };
      return { ok: true, event: { type: 'botClue', seat: inputs.seat, pass: inputs.pass, word: check.clue, at } };
    }
    case 'chat': {
      if (out.say === null) return { ok: true, event: null };
      if (typeof out.say !== 'string') return { ok: false, reason: 'say-missing' };
      const text = out.say.trim();
      if (!text) return { ok: true, event: null };
      if (!canSpeak(state, inputs.seat, at)) return { ok: true, event: null };
      if (text.length > MAX_BOT_LINE) return { ok: false, reason: 'say-too-long' };
      if (mentionsWord(text, word)) return { ok: false, reason: 'say-leaks-word' };
      const problem = chatLineProblem(text, inputs);
      if (problem) return { ok: false, reason: problem };
      return { ok: true, event: { type: 'botChat', seat: inputs.seat, text, at } };
    }
    case 'vote': {
      const target = out.vote;
      if (typeof target !== 'number' || !Number.isInteger(target) || target < 0 || target >= state.seats.length || target === inputs.seat) {
        return { ok: false, reason: 'bad-vote' };
      }
      return { ok: true, event: { type: 'botVote', seat: inputs.seat, target, at } };
    }
    case 'steal': {
      if (typeof out.word !== 'string' || !out.word.trim()) return { ok: false, reason: 'word-missing' };
      return { ok: true, event: { type: 'botSteal', seat: inputs.seat, word: out.word.trim().slice(0, MAX_STEAL_LENGTH), at } };
    }
  }
}

/** What to tell the model when its chat line was rejected, or null when the failure is not one a rewrite would fix. */
export function retryNote(reason: string): string | null {
  const why: Record<string, string> = {
    'say-filler': 'it leaned on filler words',
    'say-emoji': 'it used an emoji and nobody here does',
    'say-duplicate': 'it made a point someone already made',
    'say-agree': 'it only agreed with someone',
    'say-leaks-word': 'it contained the secret word',
    'say-too-long': 'it was too long',
  };
  const w = why[reason];
  return w ? `Your last line was rejected because ${w}. Write a different line, or reply null.` : null;
}

export interface RunnerOptions {
  /** Primary-backend calls allowed per round (spec 4.5). */
  budgetPerRound: number;
  /** Milliseconds before a primary call is abandoned (spec 4.5). */
  timeoutMs: number;
  /** Clock, injectable for tests. */
  now: () => number;
  /** Called once when the primary reports the daily quota is gone; `until` is the next UTC midnight. */
  onAutopilot?: (until: number) => void;
  /** Called whenever an action is routed to the fallback, with the reason. */
  onFallback?: (action: string, reason: string) => void;
}

export const DEFAULT_BUDGET = 60;
export const DEFAULT_TIMEOUT_MS = 5000;

/** Runs bot turns: primary backend first, scripted fallback on any failure, per-round budget, daily autopilot. */
export class BotRunner {
  private primaryCalls = 0;
  private roundSeed: number | null = null;
  /** Each bot's latest theory this round, by seat. Lives with the object, like its pending timers. */
  private reads = new Map<number, Read>();
  autopilotUntil = 0;

  constructor(
    private readonly primary: BotBackend,
    private readonly fallback: BotBackend,
    private readonly opts: RunnerOptions,
  ) {}

  get autopilot(): boolean {
    return this.opts.now() < this.autopilotUntil;
  }

  /** What a seat currently thinks, for tests and logs. */
  readOf(seat: number): Read | null {
    return this.reads.get(seat) ?? null;
  }

  /** The event to dispatch for this turn, or null when the bot stays silent or nothing valid came back. */
  async turn(state: RoomState, turn: BotTurn): Promise<Event | null> {
    if (!state.round) return null;
    if (state.round.seed !== this.roundSeed) {
      this.roundSeed = state.round.seed;
      this.primaryCalls = 0;
      this.reads.clear();
    }
    // A bot that cannot post anyway does not spend a model call.
    if (turn.action === 'chat' && !canSpeak(state, turn.seat, this.opts.now())) return null;
    const inputs = buildInputs(state, turn, this.reads.get(turn.seat) ?? null);
    if (this.primary !== this.fallback && !this.autopilot && this.primaryCalls < this.opts.budgetPerRound) {
      let attempt = inputs;
      for (let tries = 0; tries < 2 && this.primaryCalls < this.opts.budgetPerRound; tries++) {
        this.primaryCalls++;
        const result = await this.callPrimary(attempt);
        if (!result.ok) {
          this.opts.onFallback?.(inputs.action, result.reason);
          break;
        }
        const read = readFrom(attempt, result.raw);
        if (read) this.reads.set(turn.seat, read);
        const v = validateOutput(state, attempt, result.raw, this.opts.now());
        if (v.ok) return v.event;
        const note = attempt.action === 'chat' && tries === 0 ? retryNote(v.reason) : null;
        if (!note) {
          this.opts.onFallback?.(inputs.action, v.reason);
          break;
        }
        attempt = { ...attempt, retry: note };
      }
    }
    const raw = await this.fallback.run(inputs).catch(() => null);
    const v = validateOutput(state, inputs, raw, this.opts.now());
    return v.ok ? v.event : null;
  }

  private async callPrimary(inputs: BotInputs): Promise<{ ok: true; raw: unknown } | { ok: false; reason: string }> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('bot-timeout')), this.opts.timeoutMs);
    });
    try {
      const raw = await Promise.race([this.primary.run(inputs), timeout]);
      return raw === null || raw === undefined ? { ok: false, reason: 'empty' } : { ok: true, raw };
    } catch (err) {
      if (isQuotaError(err)) {
        this.autopilotUntil = nextUtcMidnight(this.opts.now());
        this.opts.onAutopilot?.(this.autopilotUntil);
      }
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Workers AI reports an exhausted daily allocation as a quota error; treat rate limiting the same way. */
export function isQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /quota|neuron|allocation|limit exceeded|\b429\b|too many requests/i.test(msg);
}

export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** Picks the primary backend from BOT_MODE: `fake` canned, `live` Workers AI (scripted if the binding is missing), anything else scripted. */
export function makeRunner(env: Env, hooks: Pick<RunnerOptions, 'onAutopilot' | 'onFallback'> = {}): BotRunner {
  const scripted = new ScriptedBackend();
  let primary: BotBackend = scripted;
  if (env.BOT_MODE === 'fake') {
    primary = new FakeBackend();
  } else if (env.BOT_MODE === 'live') {
    if (env.AI) primary = new WorkersAiBackend(env.AI as AiLike, env.BOT_MODEL ?? DEFAULT_MODEL);
    else console.warn('BOT_MODE=live but there is no AI binding; bots run scripted');
  }
  return new BotRunner(primary, scripted, { budgetPerRound: DEFAULT_BUDGET, timeoutMs: DEFAULT_TIMEOUT_MS, now: Date.now, ...hooks });
}
