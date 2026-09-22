import { describe, it, expect } from 'vitest';
import { apply, createRoom, type BotTurn, type Event, type RoomState } from '../../src/game/state';
import { CATEGORIES } from '../../src/game/words';
import {
  BotRunner,
  buildInputs,
  canSpeak,
  recheckChat,
  isQuotaError,
  mentionsWord,
  nextUtcMidnight,
  pureAgreement,
  readFrom,
  retryNote,
  validateOutput,
  type BotBackend,
} from '../../src/worker/bots';
import { FALLBACK_CLUES, ruleVote, ScriptedBackend } from '../../src/worker/backends/scripted';
import { FAKE_CLUES, FAKE_LINE, FakeBackend } from '../../src/worker/backends/fake';
import { PERSONAS, styleSheet, type BotInputs } from '../../src/worker/prompts';
import { DURATIONS } from '../../src/game/rules';

/** One human and five bots, started with the first seed whose state satisfies `pred`, past the deal and into the first clue turn. */
function started(pred: (s: RoomState) => boolean = () => true): RoomState {
  for (let seed = 1; seed < 1000; seed++) {
    let s = createRoom('ABCD', 0);
    s = apply(s, { type: 'join', playerId: 'p0', displayName: 'Ada', at: 0 }).state;
    s = apply(s, { type: 'start', playerId: 'p0', at: 1000, seed }).state;
    if (pred(s)) return apply(s, { type: 'timeout', at: 1000 + DURATIONS.deal }).state;
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

const turn = (seat: number, action: BotTurn['action'], move?: BotTurn['move']): BotTurn => ({ type: 'botTurn', seat, action, delayMs: 0, move });

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

  it('passes the turn\'s move and the bot\'s read through, defaulting to react and null', () => {
    const s = inChat();
    const bot = s.seats.find((x) => x.kind === 'bot')!;
    expect(buildInputs(s, turn(bot.index, 'chat'))).toMatchObject({ action: 'chat', move: 'react', read: null });
    const read = { suspect: (bot.index + 1) % 6, reason: 'vague' };
    expect(buildInputs(s, turn(bot.index, 'chat', 'open'), read)).toMatchObject({ move: 'open', read });
    expect(buildInputs(s, turn(bot.index, 'vote'), read)).toMatchObject({ action: 'vote', read });
    expect(buildInputs(s, turn(bot.index, 'vote'), read)).not.toHaveProperty('move');
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
    expect(validateOutput(s, inputs, { say: 'yeah same' }, 9)).toMatchObject({ ok: false, reason: 'say-agree' });
    expect(validateOutput(s, inputs, { say: 'Agreed, fox.' }, 9)).toMatchObject({ ok: false, reason: 'say-agree' });
    expect(validateOutput(s, inputs, { say: 'wait why fruit' }, 9)).toEqual({
      ok: true,
      event: { type: 'botChat', seat: b.index, text: 'wait why fruit', at: 9 },
    });
  });

  it('lets a bot use emoji once a human has, and silences a bot after its seventh line or within 6s of its last', () => {
    let s = inChat();
    const bot = s.seats.find((x) => x.kind === 'bot')!;
    s = apply(s, { type: 'chat', playerId: 'p0', text: 'ok 😀', at: 5 }).state;
    let inputs = buildInputs(s, turn(bot.index, 'chat'));
    expect(validateOutput(s, inputs, { say: 'hm 🤔' }, 9)).toMatchObject({ ok: true });
    for (let i = 0; i < 6; i++) s = apply(s, { type: 'botChat', seat: bot.index, text: `line ${i}`, at: 10_000 * (i + 1) }).state;
    inputs = buildInputs(s, turn(bot.index, 'chat'));
    expect(canSpeak(s, bot.index, 65_999)).toBe(false);
    expect(validateOutput(s, inputs, { say: 'too soon' }, 65_999)).toEqual({ ok: true, event: null });
    expect(canSpeak(s, bot.index, 66_000)).toBe(true);
    expect(validateOutput(s, inputs, { say: 'still fine' }, 66_000)).toMatchObject({ ok: true, event: { text: 'still fine' } });
    s = apply(s, { type: 'botChat', seat: bot.index, text: 'line 6', at: 66_000 }).state;
    inputs = buildInputs(s, turn(bot.index, 'chat'));
    expect(validateOutput(s, inputs, { say: 'one more thing' }, 100_000)).toEqual({ ok: true, event: null });
  });

  it('recheckChat drops a line another seat has since said, or one the bot cannot post anymore', () => {
    let s = inChat();
    const [a, b] = s.seats.filter((x) => x.kind === 'bot');
    const t = turn(b.index, 'chat', 'react');
    expect(recheckChat(s, t, 'fruit does not fit', 9)).toBe(true);
    s = apply(s, { type: 'botChat', seat: a.index, text: 'fruit does not fit at all', at: 6 }).state;
    expect(recheckChat(s, t, 'fruit does not fit', 9)).toBe(false);
    expect(recheckChat(s, t, 'why paws though', 9)).toBe(true);
    s = apply(s, { type: 'botChat', seat: b.index, text: 'ok', at: 7 }).state;
    expect(recheckChat(s, t, 'why paws though', 9)).toBe(false);
    expect(recheckChat(s, t, 'why paws though', 20_000)).toBe(true);
    const voting = apply(s, { type: 'timeout', at: 200_000 }).state;
    expect(voting.phase).toBe('vote');
    expect(recheckChat(voting, t, 'why paws though', 200_001)).toBe(false);
  });

  it('pureAgreement catches lines that only agree and lets lines with a reason through', () => {
    for (const t of ['yeah same', 'agreed', 'true', 'i agree with fox', 'exactly this', 'Yep, fox for sure.']) expect(pureAgreement(t)).toBe(true);
    for (const t of ['yeah but fruit was a weird second clue', 'same read, round gives it away', 'fox why fruit']) expect(pureAgreement(t)).toBe(false);
  });

  it('readFrom takes the suspect and reason from a chat reply, even a silent one, and rejects self or bad seats', () => {
    const s = inChat();
    const bot = s.seats.find((x) => x.kind === 'bot')!;
    const other = s.seats.find((x) => x.index !== bot.index)!;
    const inputs = buildInputs(s, turn(bot.index, 'chat'));
    expect(readFrom(inputs, { say: null, suspect: other.index, reason: '  round is lazy  ' })).toEqual({ suspect: other.index, reason: 'round is lazy' });
    expect(readFrom(inputs, { say: 'hm', suspect: other.index })).toEqual({ suspect: other.index, reason: 'gut feeling' });
    expect(readFrom(inputs, { say: 'hm', suspect: bot.index, reason: 'me' })).toBeNull();
    expect(readFrom(inputs, { say: 'hm', suspect: 9, reason: 'x' })).toBeNull();
    expect(readFrom(inputs, { say: 'hm' })).toBeNull();
    expect(readFrom(buildInputs(s, turn(bot.index, 'vote')), { vote: 1, suspect: other.index })).toBeNull();
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

  it('spends no model call on a chat turn for a bot that cannot post', async () => {
    let s = inChat();
    const bot = s.seats.find((x) => x.kind === 'bot')!;
    s = apply(s, { type: 'botChat', seat: bot.index, text: 'hm', at: 4990 }).state;
    const primary = stub({ say: 'more', suspect: (bot.index + 1) % 6, reason: 'x' });
    expect(await runner(primary, new ScriptedBackend()).turn(s, turn(bot.index, 'chat'))).toBeNull();
    expect(primary.calls).toBe(0);
  });

  it('returns null for a silent chat without falling back, and null when the fallback fails too', async () => {
    const s = inChat();
    const bot = s.seats.find((x) => x.kind === 'bot')!;
    const fallback = stub({ say: 'fallback line' });
    expect(await runner(stub({ say: null }), fallback).turn(s, turn(bot.index, 'chat'))).toBeNull();
    expect(fallback.calls).toBe(0);
    expect(await runner(stub({ clue: 'x'.repeat(30) }), stub({ clue: 'x'.repeat(30) })).turn(clueState, clueTurn)).toBeNull();
  });

  it('remembers each bot\'s read from its chat replies, feeds it to later turns, and forgets it on a new round', async () => {
    const s = inChat();
    const bot = s.seats.find((x) => x.kind === 'bot')!;
    const other = s.seats.find((x) => x.index !== bot.index)!;
    const seen: (BotInputs['read'] | undefined)[] = [];
    const primary: BotBackend = {
      async run(inputs) {
        seen.push(inputs.read);
        if (inputs.action === 'chat') return { say: null, suspect: other.index, reason: 'too neat' };
        return { vote: other.index };
      },
    };
    const r = runner(primary, new ScriptedBackend());
    expect(await r.turn(s, turn(bot.index, 'chat'))).toBeNull();
    expect(r.readOf(bot.index)).toEqual({ suspect: other.index, reason: 'too neat' });
    await r.turn(s, turn(bot.index, 'chat'));
    expect(seen).toEqual([null, { suspect: other.index, reason: 'too neat' }]);
    expect(r.readOf((bot.index + 1) % 6 === other.index ? (bot.index + 2) % 6 : (bot.index + 1) % 6)).toBeNull();
    const next = started((x) => x.round!.seed !== s.round!.seed);
    await r.turn(next, turn(0, 'clue'));
    expect(r.readOf(bot.index)).toBeNull();
  });

  it('keeps the read even when the line itself is rejected', async () => {
    const s = inChat();
    const bot = s.seats.find((x) => x.kind === 'bot')!;
    const other = s.seats.find((x) => x.index !== bot.index)!;
    const r = runner(stub({ say: 'yeah same', suspect: other.index, reason: 'copycat' }), new ScriptedBackend());
    expect(await r.turn(s, turn(bot.index, 'chat'))).toBeNull();
    expect(r.readOf(bot.index)).toEqual({ suspect: other.index, reason: 'copycat' });
  });

  it('retries the primary once with the rejection reason when a chat line fails the style check, then falls back', async () => {
    const seen: BotInputs[] = [];
    const primary: BotBackend = {
      run: async (inputs) => {
        seen.push(inputs);
        return seen.length === 1 ? { say: 'yeah same', suspect: 1, reason: 'x' } : { say: 'fox your second clue was a stretch', suspect: 1, reason: 'x' };
      },
    };
    const fallback = stub({ say: null });
    const s = inChat();
    const bot = s.seats.find((x) => x.kind === 'bot')!;
    const event = await runner(primary, fallback).turn(s, turn(bot.index, 'chat', 'react'));
    expect(event).toMatchObject({ type: 'botChat', text: 'fox your second clue was a stretch' });
    expect(seen).toHaveLength(2);
    expect(seen[1].retry).toMatch(/only agreed/);
    expect(fallback.calls).toBe(0);
  });

  it('gives up after one retry and falls back', async () => {
    const primary = stub({ say: 'yeah same', suspect: 1, reason: 'x' });
    const fallback = stub({ say: null });
    const s = inChat();
    const bot = s.seats.find((x) => x.kind === 'bot')!;
    expect(await runner(primary, fallback).turn(s, turn(bot.index, 'chat'))).toBeNull();
    expect(primary.calls).toBe(2);
    expect(fallback.calls).toBe(1);
  });

  it('retryNote knows the chat rejections and nothing else', () => {
    expect(retryNote('say-agree')).toMatch(/only agreed/);
    expect(retryNote('say-filler')).toMatch(/filler/);
    expect(retryNote('say-duplicate')).toMatch(/already/);
    expect(retryNote('say-leaks-word')).toMatch(/secret word/);
    expect(retryNote('clue-missing')).toBeNull();
    expect(retryNote('bot-timeout')).toBeNull();
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

  it('keeps the last seats.length calls of the budget for non-chat turns', async () => {
    const chatting = inChat();
    const bots = chatting.seats.filter((x) => x.kind === 'bot');
    const other = (bots[0].index + 1) % 6;
    // One reply serves both actions; the runner only reads the field its action validates.
    const primary = stub({ say: 'that second clue was a stretch', vote: other, suspect: other, reason: 'x' });
    const fallback = stub({ say: null, vote: other });
    // Six seats, so chat may spend two of these eight calls and the other six are held back.
    const r = runner(primary, fallback, { budgetPerRound: 8 });
    expect(await r.turn(chatting, turn(bots[0].index, 'chat'))).toMatchObject({ type: 'botChat' });
    expect(await r.turn(chatting, turn(bots[1].index, 'chat'))).toMatchObject({ type: 'botChat' });
    expect(await r.turn(chatting, turn(bots[2].index, 'chat'))).toBeNull();
    expect(primary.calls).toBe(2);
    expect(fallback.calls).toBe(1);

    // Same round, so the count carries over; the vote still reaches the model instead of voting by rule.
    const voting = apply(chatting, { type: 'timeout', at: 200_000 }).state;
    expect(voting.round!.seed).toBe(chatting.round!.seed);
    expect(await r.turn(voting, turn(bots[0].index, 'vote'))).toMatchObject({ type: 'botVote', target: other });
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
