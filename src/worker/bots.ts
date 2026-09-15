import type { Env } from './env';
import type { BotTurn, Event, RoomState } from '../game/state';
import { isSecretWord, validateClue } from '../game/words';
import { type BotContext, type BotInputs, MAX_BOT_LINE, personaFor, styleSheet } from './prompts';
import { ScriptedBackend } from './backends/scripted';
import { FakeBackend } from './backends/fake';
import { DEFAULT_MODEL, WorkersAiBackend, type AiLike } from './backends/workersAi';

/** One bot action through one backend (spec 5.2). */
export interface BotBackend {
  /** Resolves with the raw reply for validation. A null reply or a throw is a failed call. */
  run(inputs: BotInputs): Promise<unknown>;
}

const MAX_STEAL_LENGTH = 40;

/** What the bot may know for this turn: never another seat's identity, never the word for the imposter. */
export function buildInputs(state: RoomState, turn: BotTurn): BotInputs {
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
  };
  return turn.action === 'clue' ? { action: 'clue', pass: round.cluePass, ...ctx } : { action: turn.action, ...ctx };
}

/** True when any token of `text` is the secret word or a plural or stem of it (spec 5.7). */
export function mentionsWord(text: string, word: string): boolean {
  if (!word) return false;
  return text.split(/[^A-Za-z]+/).some((token) => token !== '' && isSecretWord(token, word));
}

export type Validated = { ok: true; event: Event | null } | { ok: false; reason: string };

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
      if (text.length > MAX_BOT_LINE) return { ok: false, reason: 'say-too-long' };
      if (mentionsWord(text, word)) return { ok: false, reason: 'say-leaks-word' };
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

export const DEFAULT_BUDGET = 40;
export const DEFAULT_TIMEOUT_MS = 5000;

/** Runs bot turns: primary backend first, scripted fallback on any failure, per-round budget, daily autopilot. */
export class BotRunner {
  private primaryCalls = 0;
  private roundSeed: number | null = null;
  autopilotUntil = 0;

  constructor(
    private readonly primary: BotBackend,
    private readonly fallback: BotBackend,
    private readonly opts: RunnerOptions,
  ) {}

  get autopilot(): boolean {
    return this.opts.now() < this.autopilotUntil;
  }

  /** The event to dispatch for this turn, or null when the bot stays silent or nothing valid came back. */
  async turn(state: RoomState, turn: BotTurn): Promise<Event | null> {
    if (!state.round) return null;
    if (state.round.seed !== this.roundSeed) {
      this.roundSeed = state.round.seed;
      this.primaryCalls = 0;
    }
    const inputs = buildInputs(state, turn);
    if (this.primary !== this.fallback && !this.autopilot && this.primaryCalls < this.opts.budgetPerRound) {
      this.primaryCalls++;
      const result = await this.callPrimary(inputs);
      if (result.ok) {
        const v = validateOutput(state, inputs, result.raw, this.opts.now());
        if (v.ok) return v.event;
        this.opts.onFallback?.(inputs.action, v.reason);
      } else {
        this.opts.onFallback?.(inputs.action, result.reason);
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
