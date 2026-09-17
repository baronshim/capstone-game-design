import { describe, it, expect } from 'vitest';
import { apply, createRoom, type BotTurn, type Event, type RoomState } from '../../src/game/state';
import { CATEGORIES } from '../../src/game/words';
import {
  BotRunner,
  buildInputs,
  isQuotaError,
  mentionsWord,
  nextUtcMidnight,
  validateOutput,
  type BotBackend,
} from '../../src/worker/bots';
import { FALLBACK_CLUES, ruleVote, ScriptedBackend } from '../../src/worker/backends/scripted';
import { FAKE_CLUES, FAKE_LINE, FakeBackend } from '../../src/worker/backends/fake';
import { PERSONAS, styleSheet, type BotInputs } from '../../src/worker/prompts';

/** One human and five bots, started with the first seed whose state satisfies `pred`. */
function started(pred: (s: RoomState) => boolean = () => true): RoomState {
  for (let seed = 1; seed < 1000; seed++) {
    let s = createRoom('ABCD', 0);
    s = apply(s, { type: 'join', playerId: 'p0', displayName: 'Ada', at: 0 }).state;
    s = apply(s, { type: 'start', playerId: 'p0', at: 1000, seed }).state;
    if (pred(s)) return s;
  }
  throw new Error('no seed satisfies the predicate');
}

const botFirst = (s: RoomState) => s.seats[0].kind === 'bot';
const crewBotFirst = (s: RoomState) => botFirst(s) && !s.seats[0].isImposter;
const imposterBotFirst = (s: RoomState) => botFirst(s) && s.seats[0].isImposter;

function inChat(pred?: (s: RoomState) => boolean): RoomState {
  let s = started(pred);
  while (s.phase === 'clue') s = apply(s, { type: 'timeout', at: 2000 }).state;
  return s;
}

function inVote(pred?: (s: RoomState) => boolean): RoomState {
  return apply(inChat(pred), { type: 'timeout', at: 3000 }).state;
}

const turn = (seat: number, action: BotTurn['action']): BotTurn => ({ type: 'botTurn', seat, action, delayMs: 0 });

const stub = (reply: unknown | (() => Promise<unknown>)): BotBackend & { calls: number } => {
  const backend = {
    calls: 0,
    async run() {
      backend.calls++;
      return typeof reply === 'function' ? (reply as () => Promise<unknown>)() : reply;
    },
  };
  return backend;
};

const runner = (primary: BotBackend, fallback: BotBackend, over: Partial<ConstructorParameters<typeof BotRunner>[2]> = {}) =>
  new BotRunner(primary, fallback, { budgetPerRound: 40, timeoutMs: 1000, now: () => 5000, ...over });

describe('buildInputs', () => {
  it('gives a crew bot the word and the imposter bot only the category', () => {
    const crew = buildInputs(started(crewBotFirst), turn(0, 'clue'));
    expect(crew).toMatchObject({ action: 'clue', seat: 0, pass: 1, isImposter: false });
    expect(typeof crew.word).toBe('string');
    const imp = buildInputs(started(imposterBotFirst), turn(0, 'clue'));
    expect(imp.word).toBeNull();
    expect(imp.isImposter).toBe(true);
    expect(imp.aliases).toHaveLength(6);
    expect(imp.alias).toBe(imp.aliases[0]);
    expect(PERSONAS).toContain(imp.persona);
  });

  it('builds the style sheet from human lines only', () => {
    let s = inChat();
    const bot = s.seats.find((x) => x.kind === 'bot')!;
    s = apply(s, { type: 'chat', playerId: 'p0', text: 'Hello There.', at: 2500 }).state;
    s = apply(s, { type: 'botChat', seat: bot.index, text: 'beep beep beep', at: 2600 }).state;
    const inputs = buildInputs(s, turn(bot.index, 'chat'));
    expect(inputs.style).toEqual(styleSheet(['Hello There.']));
    expect(inputs.transcript).toHaveLength(2);
    expect(inputs.cluesBySeat.every((c) => c.length === 2)).toBe(true);
  });
});

describe('validateOutput', () => {
  it('accepts a valid clue and rejects the secret word, two words, or a missing field', () => {
    const s = started(crewBotFirst);
    const inputs = buildInputs(s, turn(0, 'clue'));
    expect(validateOutput(s, inputs, { clue: 'Brick' }, 1500)).toEqual({
      ok: true,
      event: { type: 'botClue', seat: 0, pass: 1, word: 'Brick', at: 1500 },
    });
    expect(validateOutput(s, inputs, { clue: s.round!.word }, 1500)).toMatchObject({ ok: false, reason: 'clue-is-word' });
    expect(validateOutput(s, inputs, { clue: 'two words' }, 1500)).toMatchObject({ ok: false, reason: 'clue-one-word' });
    expect(validateOutput(s, inputs, {}, 1500)).toMatchObject({ ok: false });
    expect(validateOutput(s, inputs, null, 1500)).toMatchObject({ ok: false });
    expect(validateOutput(s, inputs, 'Brick', 1500)).toMatchObject({ ok: false });
  });

  it('treats a null or blank chat reply as silence, caps length, and drops lines that mention the word', () => {
    const s = inChat();
    const bot = s.seats.find((x) => x.kind === 'bot')!;
    const inputs = buildInputs(s, turn(bot.index, 'chat'));
    expect(validateOutput(s, inputs, { say: null }, 9)).toEqual({ ok: true, event: null });
    expect(validateOutput(s, inputs, { say: '   ' }, 9)).toEqual({ ok: true, event: null });
    expect(validateOutput(s, inputs, { say: 'x'.repeat(141) }, 9)).toMatchObject({ ok: false, reason: 'say-too-long' });
    expect(validateOutput(s, inputs, { say: `is it ${s.round!.word}s?` }, 9)).toMatchObject({ ok: false, reason: 'say-leaks-word' });
    expect(validateOutput(s, inputs, { say: ' hello ' }, 9)).toEqual({
      ok: true,
      event: { type: 'botChat', seat: bot.index, text: 'hello', at: 9 },
    });
    expect(validateOutput(s, inputs, { say: 5 }, 9)).toMatchObject({ ok: false });
  });

  it('drops chat lines that copy an earlier line, lean on filler, or use emoji when the humans do not', () => {
    let s = inChat();
    const bots = s.seats.filter((x) => x.kind === 'bot');
    const [a, b] = bots;
    s = apply(s, { type: 'chat', playerId: 'p0', text: 'fox is kinda sus with fruit', at: 5 }).state;
    s = apply(s, { type: 'botChat', seat: a.index, text: 'fruit does not fit at all', at: 6 }).state;
    const inputs = buildInputs(s, turn(b.index, 'chat'));
    expect(validateOutput(s, inputs, { say: 'fruit does not fit at all.' }, 9)).toMatchObject({ ok: false, reason: 'say-duplicate' });
    expect(validateOutput(s, inputs, { say: 'yeah fruit doesnt fit at all' }, 9)).toMatchObject({ ok: false, reason: 'say-duplicate' });
    expect(validateOutput(s, inputs, { say: 'fox is definitely the imposter' }, 9)).toMatchObject({ ok: false, reason: 'say-filler' });
    expect(validateOutput(s, inputs, { say: "Let's gooo!" }, 9)).toMatchObject({ ok: false, reason: 'say-filler' });
    expect(validateOutput(s, inputs, { say: 'hmm fox? 🤔' }, 9)).toMatchObject({ ok: false, reason: 'say-emoji' });
    expect(validateOutput(s, inputs, { say: 'wait why fruit' }, 9)).toEqual({
      ok: true,
      event: { type: 'botChat', seat: b.index, text: 'wait why fruit', at: 9 },
    });
  });

  it('lets a bot use emoji once a human has, and silences a bot after its third line', () => {
    let s = inChat();
    const bot = s.seats.find((x) => x.kind === 'bot')!;
    s = apply(s, { type: 'chat', playerId: 'p0', text: 'ok 😀', at: 5 }).state;
    let inputs = buildInputs(s, turn(bot.index, 'chat'));
    expect(validateOutput(s, inputs, { say: 'hm 🤔' }, 9)).toMatchObject({ ok: true });
    for (let i = 0; i < 3; i++) s = apply(s, { type: 'botChat', seat: bot.index, text: `line ${i}`, at: 6 + i }).state;
    inputs = buildInputs(s, turn(bot.index, 'chat'));
    expect(validateOutput(s, inputs, { say: 'one more thing' }, 9)).toEqual({ ok: true, event: null });
  });

  it('accepts a vote for another live seat only', () => {
    const s = inVote();
    const bot = s.seats.find((x) => x.kind === 'bot')!;
    const inputs = buildInputs(s, turn(bot.index, 'vote'));
    const other = (bot.index + 1) % 6;
    expect(validateOutput(s, inputs, { vote: other }, 9)).toEqual({
      ok: true,
      event: { type: 'botVote', seat: bot.index, target: other, at: 9 },
    });
    for (const bad of [bot.index, 6, -1, 1.5, '1', undefined]) {
      expect(validateOutput(s, inputs, { vote: bad }, 9)).toMatchObject({ ok: false, reason: 'bad-vote' });
    }
  });

  it('accepts a trimmed steal guess capped at 40 characters and rejects an empty one', () => {
    const s = started(imposterBotFirst);
    const inputs = buildInputs(s, turn(0, 'steal'));
    expect(validateOutput(s, inputs, { word: '  guess ' }, 9)).toEqual({
      ok: true,
      event: { type: 'botSteal', seat: 0, word: 'guess', at: 9 },
    });
    const long = validateOutput(s, inputs, { word: 'g'.repeat(50) }, 9);
    expect(long.ok && (long.event as Extract<Event, { type: 'botSteal' }>).word.length).toBe(40);
    expect(validateOutput(s, inputs, { word: '' }, 9)).toMatchObject({ ok: false });
  });

  it('mentionsWord matches the word and its stems as whole tokens', () => {
    expect(mentionsWord('the pizzas were great', 'pizza')).toBe(true);
    expect(mentionsWord('PIZZA?', 'pizza')).toBe(true);
    expect(mentionsWord('a pizzeria', 'pizza')).toBe(false);
    expect(mentionsWord('nothing here', '')).toBe(false);
  });
});

describe('ScriptedBackend', () => {
  const scripted = new ScriptedBackend();

  it('clues from the category fallback list, skipping clues already given', async () => {
    const s = started(crewBotFirst);
    const inputs = buildInputs(s, turn(0, 'clue'));
    const list = FALLBACK_CLUES[inputs.category];
    expect(list.length).toBeGreaterThanOrEqual(8);
    expect(await scripted.run(inputs)).toEqual({ clue: list[0] });
    const used: BotInputs = { ...inputs, cluesBySeat: [[list[0]], [list[1]], [], [], [], []] };
    expect(await scripted.run(used)).toEqual({ clue: list[2] });
  });

  it('never clues a secret word', () => {
    const secrets = new Set(CATEGORIES.flatMap((c) => c.words));
    for (const words of Object.values(FALLBACK_CLUES)) for (const w of words) expect(secrets.has(w)).toBe(false);
    for (const c of CATEGORIES) expect(FALLBACK_CLUES[c.name]).toBeDefined();
  });

  it('stays silent in chat', async () => {
    const s = inChat();
    const bot = s.seats.find((x) => x.kind === 'bot')!;
    expect(await scripted.run(buildInputs(s, turn(bot.index, 'chat')))).toEqual({ say: null });
  });

  it('votes for the seat others mention most, ignoring its own lines and mentions of itself, else the next seat', () => {
    const base = buildInputs(inVote(), turn(2, 'vote'));
    const a = base.aliases;
    const mentions = (lines: { seat: number; text: string }[]) => ruleVote({ ...base, transcript: lines.map((l) => ({ ...l, at: 1 })) });
    expect(mentions([])).toBe(3);
    expect(mentions([{ seat: 0, text: `it is ${a[4]}` }, { seat: 1, text: `${a[4].toLowerCase()} for sure` }, { seat: 0, text: a[5] }])).toBe(4);
    expect(mentions([{ seat: 2, text: `${a[5]} ${a[5]}` }, { seat: 0, text: a[1] }])).toBe(1);
    expect(mentions([{ seat: 0, text: a[2] }])).toBe(3);
    expect(mentions([{ seat: 0, text: a[4] }, { seat: 1, text: a[1] }])).toBe(1);
  });

  it('steals with a category word that is not among the clues', async () => {
    const s = started(imposterBotFirst);
    const inputs = buildInputs(s, turn(0, 'steal'));
    const words = CATEGORIES.find((c) => c.name === inputs.category)!.words;
    expect(await scripted.run({ ...inputs, cluesBySeat: [[words[0]], [words[1]], [], [], [], []] })).toEqual({ word: words[2] });
  });
});

describe('FakeBackend', () => {
  const fake = new FakeBackend();

  it('clues a fixed word per seat and pass, none of them a secret word', async () => {
    const s = started(crewBotFirst);
    expect(await fake.run(buildInputs(s, turn(0, 'clue')))).toEqual({ clue: FAKE_CLUES[0] });
    expect(await fake.run({ ...buildInputs(s, turn(0, 'clue')), pass: 2 } as BotInputs)).toEqual({ clue: FAKE_CLUES[1] });
    const secrets = new Set(CATEGORIES.flatMap((c) => c.words));
    expect(FAKE_CLUES).toHaveLength(12);
    for (const w of FAKE_CLUES) expect(secrets.has(w)).toBe(false);
  });

  it('says one line per round and then stays quiet; votes and steals like the scripted backend', async () => {
    let s = inChat();
    const bot = s.seats.find((x) => x.kind === 'bot')!;
    expect(await fake.run(buildInputs(s, turn(bot.index, 'chat')))).toEqual({ say: FAKE_LINE });
    s = apply(s, { type: 'botChat', seat: bot.index, text: FAKE_LINE, at: 2500 }).state;
    expect(await fake.run(buildInputs(s, turn(bot.index, 'chat')))).toEqual({ say: null });
    const v = inVote();
    const voter = v.seats.find((x) => x.kind === 'bot')!;
    const inputs = buildInputs(v, turn(voter.index, 'vote'));
    expect(await fake.run(inputs)).toEqual({ vote: ruleVote(inputs) });
  });
});

describe('BotRunner', () => {
  const clueState = started(crewBotFirst);
  const clueTurn = turn(0, 'clue');

  it('returns the primary backend\'s event when it validates', async () => {
    const primary = stub({ clue: 'brick' });
    const fallback = stub({ clue: 'fall' });
    expect(await runner(primary, fallback).turn(clueState, clueTurn)).toEqual({ type: 'botClue', seat: 0, pass: 1, word: 'brick', at: 5000 });
    expect(fallback.calls).toBe(0);
  });

  it('falls back when the primary throws, returns null, or fails validation', async () => {
    const fallback = stub({ clue: 'fall' });
    const reasons: string[] = [];
    const opts = { onFallback: (_a: string, r: string) => reasons.push(r) };
    for (const primary of [stub(() => Promise.reject(new Error('boom'))), stub(null), stub({ clue: 'two words' })]) {
      expect(await runner(primary, fallback, opts).turn(clueState, clueTurn)).toMatchObject({ type: 'botClue', word: 'fall' });
    }
    expect(fallback.calls).toBe(3);
    expect(reasons).toEqual(['boom', 'empty', 'clue-one-word']);
  });

  it('abandons a primary call after the timeout', async () => {
    const primary = stub(() => new Promise(() => undefined));
    const fallback = stub({ clue: 'fall' });
    const r = runner(primary, fallback, { timeoutMs: 20 });
    expect(await r.turn(clueState, clueTurn)).toMatchObject({ word: 'fall' });
  });

  it('returns null for a silent chat without falling back, and null when the fallback fails too', async () => {
    const s = inChat();
    const bot = s.seats.find((x) => x.kind === 'bot')!;
    const fallback = stub({ say: 'fallback line' });
    expect(await runner(stub({ say: null }), fallback).turn(s, turn(bot.index, 'chat'))).toBeNull();
    expect(fallback.calls).toBe(0);
    expect(await runner(stub({ clue: 'x'.repeat(30) }), stub({ clue: 'x'.repeat(30) })).turn(clueState, clueTurn)).toBeNull();
  });

  it('stops calling the primary after the per-round budget and resets on a new round', async () => {
    const primary = stub({ clue: 'brick' });
    const fallback = stub({ clue: 'fall' });
    const r = runner(primary, fallback, { budgetPerRound: 2 });
    await r.turn(clueState, clueTurn);
    await r.turn(clueState, clueTurn);
    expect(await r.turn(clueState, clueTurn)).toMatchObject({ word: 'fall' });
    expect(primary.calls).toBe(2);
    const nextRound = started((s) => crewBotFirst(s) && s.round!.seed !== clueState.round!.seed);
    expect(await r.turn(nextRound, clueTurn)).toMatchObject({ word: 'brick' });
    expect(primary.calls).toBe(3);
  });

  it('switches to autopilot until the next UTC midnight on a quota error', async () => {
    const now = Date.UTC(2026, 8, 15, 13, 0, 0);
    const primary = stub(() => Promise.reject(new Error('3040: Daily quota exceeded (neurons)')));
    const fallback = stub({ clue: 'fall' });
    let notified = 0;
    const r = runner(primary, fallback, { now: () => now, onAutopilot: (until) => (notified = until) });
    expect(r.autopilot).toBe(false);
    expect(await r.turn(clueState, clueTurn)).toMatchObject({ word: 'fall' });
    expect(r.autopilot).toBe(true);
    expect(r.autopilotUntil).toBe(Date.UTC(2026, 8, 16));
    expect(notified).toBe(r.autopilotUntil);
    await r.turn(clueState, clueTurn);
    expect(primary.calls).toBe(1);
  });

  it('never calls the primary when the turn has no round', async () => {
    const primary = stub({ clue: 'brick' });
    const lobby = apply(createRoom('ABCD', 0), { type: 'join', playerId: 'p0', displayName: 'Ada', at: 0 }).state;
    expect(await runner(primary, stub({ clue: 'fall' })).turn(lobby, clueTurn)).toBeNull();
    expect(primary.calls).toBe(0);
  });

  it('nextUtcMidnight and isQuotaError', () => {
    expect(nextUtcMidnight(Date.UTC(2026, 8, 15, 23, 59, 59))).toBe(Date.UTC(2026, 8, 16));
    expect(nextUtcMidnight(Date.UTC(2026, 8, 16, 0, 0, 0))).toBe(Date.UTC(2026, 8, 17));
    expect(isQuotaError(new Error('Daily quota exceeded'))).toBe(true);
    expect(isQuotaError(new Error('429 Too Many Requests'))).toBe(true);
    expect(isQuotaError(new Error('model not found'))).toBe(false);
    expect(isQuotaError('neurons limit exceeded')).toBe(true);
  });
});
