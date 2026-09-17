import { describe, it, expect } from 'vitest';
import { apply, createRoom, MAX_CHAT_LENGTH, MAX_TRANSCRIPT, SEAT_COUNT, type BotTurn, type Result, type RoomState } from '../../src/game/state';
import type { Effect, Event } from '../../src/game/state';
import { DURATIONS, POINTS } from '../../src/game/rules';
import { CATEGORIES } from '../../src/game/words';
import type { BotCall } from '../../src/game/protocol';

/** The code of the first error effect, if any; `Effect` is a union with `BotTurn` so `.code` needs narrowing. */
function errorCode(effects: Effect[]): string | undefined {
  return effects.find((e): e is Extract<Effect, { type: 'error' }> => e.type === 'error')?.code;
}

export function roomWith(names: string[]): RoomState {
  let state = createRoom('ABCD', 1000);
  names.forEach((name, i) => {
    state = apply(state, { type: 'join', playerId: `p${i}`, displayName: name, at: 1000 + i }).state;
  });
  return state;
}

export function started(names = ['Ada', 'Bob'], seed = 42): RoomState {
  return apply(roomWith(names), { type: 'start', playerId: 'p0', at: 1000, seed }).state;
}

const NAMES3 = ['Ada', 'Bob', 'Cal'];

/** First seed from 1 whose started room satisfies `pred`, so tests do not depend on how the RNG is consumed. */
export function seedFor(names: string[], pred: (s: RoomState) => boolean): number {
  for (let seed = 1; seed < 1000; seed++) if (pred(started(names, seed))) return seed;
  throw new Error('no seed satisfies the predicate');
}

export const humanImposter = (s: RoomState) => s.seats.find((x) => x.isImposter)!.kind === 'human';
export const botImposter = (s: RoomState) => !humanImposter(s);

/** Passes bot turns with timeouts until a human is on turn or the clue phase ends. */
export function toHumanTurn(state: RoomState, at = 2000): RoomState {
  while (state.phase === 'clue' && state.seats[state.round!.clueSeat!].kind === 'bot') {
    state = apply(state, { type: 'timeout', at }).state;
  }
  return state;
}

/** playerId of the seat whose clue turn it is. */
export function whoseTurn(state: RoomState): string {
  return state.seats[state.round!.clueSeat!].playerId!;
}

/** Times out every clue turn until the chat phase opens. */
export function throughClues(state: RoomState, at = 2000): RoomState {
  while (state.phase === 'clue') state = apply(state, { type: 'timeout', at }).state;
  return state;
}

/** Times out the bot-call phase, and only that, so a decided round reaches the reveal. */
export function toReveal(state: RoomState, at = 9000): RoomState {
  expect(state.phase).toBe('botcall');
  return apply(state, { type: 'timeout', at }).state;
}

describe('createRoom', () => {
  it('starts empty in the lobby with no round', () => {
    expect(createRoom('ABCD', 1000)).toEqual({
      code: 'ABCD', phase: 'lobby', phaseEndsAt: null, seats: [], transcript: [], round: null, createdAt: 1000,
    });
  });
});

describe('join', () => {
  it('seats a new human in the next index', () => {
    const state = roomWith(['Ada', 'Bob']);
    expect(state.seats).toHaveLength(2);
    expect(state.seats[1]).toEqual({
      index: 1, kind: 'human', alias: null, playerId: 'p1', displayName: 'Bob', connected: true,
      isImposter: false, clues: [], vote: null, botCalls: null, score: null, points: null, total: 0,
    });
  });

  it('trims names, caps them at 20 chars, and defaults blank names', () => {
    const state = roomWith(['  ' + 'x'.repeat(30), '   ']);
    expect(state.seats[0].displayName).toBe('x'.repeat(20));
    expect(state.seats[1].displayName).toBe('Player 2');
  });

  it('reconnects an existing playerId instead of adding a seat', () => {
    let state = roomWith(['Ada']);
    state = apply(state, { type: 'disconnect', playerId: 'p0' }).state;
    expect(state.seats[0].connected).toBe(false);
    const result = apply(state, { type: 'join', playerId: 'p0', displayName: 'Ada', at: 2000 });
    expect(result.effects).toEqual([]);
    expect(result.state.seats).toHaveLength(1);
    expect(result.state.seats[0].connected).toBe(true);
  });

  it('rejects a 7th human with room-full', () => {
    const state = roomWith(['a', 'b', 'c', 'd', 'e', 'f']);
    const result = apply(state, { type: 'join', playerId: 'p6', displayName: 'g', at: 0 });
    expect(result.state).toBe(state);
    expect(result.effects).toEqual([{ type: 'error', to: 'p6', code: 'room-full', message: 'This room is full' }]);
  });

  it('rejects a new player after the round started', () => {
    const result = apply(started(['Ada']), { type: 'join', playerId: 'p9', displayName: 'Late', at: 0 });
    expect(errorCode(result.effects)).toBe('room-started');
    expect(result.state.seats.filter((s) => s.kind === 'human')).toHaveLength(1);
  });
});

describe('chat', () => {
  it('appends a trimmed line tagged with the sender seat', () => {
    const state = roomWith(['Ada', 'Bob']);
    const result = apply(state, { type: 'chat', playerId: 'p1', text: '  hi there  ', at: 5 });
    expect(result.state.transcript).toEqual([{ seat: 1, text: 'hi there', at: 5 }]);
  });

  it('ignores blank messages and caps length at 280', () => {
    const state = roomWith(['Ada']);
    expect(apply(state, { type: 'chat', playerId: 'p0', text: '   ', at: 5 }).state.transcript).toEqual([]);
    const long = apply(state, { type: 'chat', playerId: 'p0', text: 'y'.repeat(300), at: 5 });
    expect(long.state.transcript[0].text).toHaveLength(280);
  });

  it('errors for a player who has not joined', () => {
    const result = apply(roomWith(['Ada']), { type: 'chat', playerId: 'ghost', text: 'boo', at: 5 });
    expect(errorCode(result.effects)).toBe('not-seated');
    expect(result.state.transcript).toEqual([]);
  });

  it('caps the transcript at MAX_TRANSCRIPT lines, dropping the oldest', () => {
    let state = roomWith(['Ada']);
    for (let i = 0; i < 201; i++) {
      state = apply(state, { type: 'chat', playerId: 'p0', text: `msg ${i}`, at: i }).state;
    }
    expect(state.transcript).toHaveLength(MAX_TRANSCRIPT);
    expect(state.transcript[0].text).toBe('msg 1');
  });

  it('is closed during the clue phase and open again in the chat phase', () => {
    const inClue = started();
    expect(errorCode(apply(inClue, { type: 'chat', playerId: 'p0', text: 'psst', at: 5 }).effects)).toBe('chat-closed');
    const inChat = throughClues(inClue);
    expect(apply(inChat, { type: 'chat', playerId: 'p0', text: 'psst', at: 5 }).state.transcript).toHaveLength(1);
  });
});

describe('start', () => {
  it('fills to 6 seats with bots, shuffles, assigns unique aliases, clears lobby chat, opens the clue phase', () => {
    let state = roomWith(['Ada', 'Bob']);
    state = apply(state, { type: 'chat', playerId: 'p0', text: 'lobby talk', at: 5 }).state;
    const seed = seedFor(['Ada', 'Bob'], (s) => s.seats[s.round!.clueSeat!].kind === 'human');
    const result = apply(state, { type: 'start', playerId: 'p0', at: 1000, seed });
    const s = result.state;
    expect(result.effects).toEqual([]);
    expect(s.phase).toBe('clue');
    expect(s.phaseEndsAt).toBe(1000 + DURATIONS.clueTurn);
    expect(s.transcript).toEqual([]);
    expect(s.seats).toHaveLength(SEAT_COUNT);
    expect(s.seats.map((seat) => seat.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(new Set(s.seats.map((seat) => seat.alias)).size).toBe(SEAT_COUNT);
    expect(s.seats.filter((seat) => seat.kind === 'human').map((seat) => seat.playerId).sort()).toEqual(['p0', 'p1']);
    expect(s.seats.filter((seat) => seat.kind === 'bot')).toHaveLength(4);
    expect(s.seats.every((seat) => seat.connected)).toBe(true);
  });

  it('picks a word from a category and exactly one imposter, human or bot', () => {
    const s = started();
    const category = CATEGORIES.find((c) => c.name === s.round!.category)!;
    expect(category.words).toContain(s.round!.word);
    expect(s.round).toMatchObject({ seed: 42, cluePass: 1, ejected: null, stealGuess: null, result: null });
    const imposters = s.seats.filter((seat) => seat.isImposter);
    expect(imposters).toHaveLength(1);

    const kinds = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) kinds.add(started(['Ada', 'Bob'], seed).seats.find((seat) => seat.isImposter)!.kind);
    expect(kinds).toEqual(new Set(['human', 'bot']));
  });

  it('is deterministic for a seed and varies across seeds', () => {
    expect(started(['Ada', 'Bob'], 7)).toEqual(started(['Ada', 'Bob'], 7));
    const words = new Set([1, 2, 3, 4, 5, 6].map((seed) => started(['Ada', 'Bob'], seed).round!.word));
    expect(words.size).toBeGreaterThan(1);
    const orders = new Set([1, 2, 3, 4, 5].map((seed) => started(['a', 'b', 'c', 'd', 'e', 'f'], seed).seats.map((s) => s.playerId).join()));
    expect(orders.size).toBeGreaterThan(1);
  });

  it('errors if already started or from a non-member', () => {
    const state = roomWith(['Ada']);
    expect(errorCode(apply(state, { type: 'start', playerId: 'ghost', at: 0, seed: 1 }).effects)).toBe('not-seated');
    expect(errorCode(apply(started(['Ada']), { type: 'start', playerId: 'p0', at: 0, seed: 1 }).effects)).toBe('already-started');
  });
});

describe('clue', () => {
  it('records a valid clue for the seat whose turn it is and resets the turn timer', () => {
    const s0 = started();
    const me = whoseTurn(s0);
    const result = apply(s0, { type: 'clue', playerId: me, word: ' Crust ', at: 5000 });
    expect(result.effects).toEqual([]);
    const s1 = result.state;
    const mine = s1.seats.find((seat) => seat.playerId === me)!;
    expect(mine.clues).toEqual(['Crust']);
    expect(s1.phaseEndsAt).toBe(5000 + DURATIONS.clueTurn);
    expect(whoseTurn(s1) !== me || s1.round!.cluePass === 2).toBe(true);
  });

  it('rejects out-of-turn, multi-word, secret-word, and repeated clues without advancing', () => {
    // The first turn holder is a crew human, so the secret-word check below
    // exercises the crew path (see the imposter carve-out tests further down).
    const s0 = started(['Ada', 'Bob'], seedFor(['Ada', 'Bob'], (s) => {
      const t = s.seats[s.round!.clueSeat!];
      return t.kind === 'human' && !t.isImposter;
    }));
    const me = whoseTurn(s0);
    const other = me === 'p0' ? 'p1' : 'p0';
    expect(errorCode(apply(s0, { type: 'clue', playerId: other, word: 'x', at: 1 }).effects)).toBe('not-your-turn');
    expect(errorCode(apply(s0, { type: 'clue', playerId: me, word: 'two words', at: 1 }).effects)).toBe('clue-one-word');
    expect(errorCode(apply(s0, { type: 'clue', playerId: me, word: s0.round!.word, at: 1 }).effects)).toBe('clue-is-word');
    const s1 = apply(s0, { type: 'clue', playerId: me, word: 'first', at: 1 }).state;
    const next = whoseTurn(s1);
    const dup = apply(s1, { type: 'clue', playerId: next, word: 'FIRST', at: 2 });
    expect(errorCode(dup.effects)).toBe('clue-taken');
    expect(dup.state).toBe(s1);
    expect(errorCode(apply(s0, { type: 'clue', playerId: 'ghost', word: 'x', at: 1 }).effects)).toBe('not-seated');
  });

  it('is rejected outside the clue phase', () => {
    const inChat = throughClues(started());
    expect(errorCode(apply(inChat, { type: 'clue', playerId: 'p0', word: 'late', at: 1 }).effects)).toBe('wrong-phase');
  });

  it('opens the chat phase for 90s after two passes, with clueSeat null and two entries per seat', () => {
    // Distinct words: `c0`/`c1` all normalize to `c` and would be rejected as duplicates.
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
    let s = started();
    let n = 0;
    while (true) {
      s = toHumanTurn(s, 3000);
      if (s.phase !== 'clue') break;
      expect(n).toBeLessThan(words.length); // a rejected clue would otherwise loop forever
      s = apply(s, { type: 'clue', playerId: whoseTurn(s), word: words[n++], at: 3000 }).state;
    }
    expect(n).toBe(4);
    expect(s.phase).toBe('chat');
    expect(s.phaseEndsAt).toBe(3000 + DURATIONS.chat);
    expect(s.round!.clueSeat).toBeNull();
    expect(s.round!.cluePass).toBe(2);
    for (const seat of s.seats) expect(seat.clues).toHaveLength(2);
    expect(s.seats.filter((seat) => seat.kind === 'bot').every((seat) => seat.clues.every((c) => c === ''))).toBe(true);
  });

  it('rejects a crew clue that matches the secret word, leaving the state unchanged', () => {
    let s = started(['Ada', 'Bob', 'Cal'], 42);
    while (s.phase === 'clue' && s.seats[s.round!.clueSeat!].isImposter) {
      s = apply(s, { type: 'timeout', at: 1 }).state;
    }
    expect(s.phase).toBe('clue'); // sanity: a crew turn was found before the round moved on
    const me = whoseTurn(s);
    const result = apply(s, { type: 'clue', playerId: me, word: s.round!.word, at: 2 });
    expect(errorCode(result.effects)).toBe('clue-is-word');
    expect(result.state).toBe(s);
  });

  it('accepts the imposter clueing the secret word, recording it and advancing the turn', () => {
    let s = started(['Ada', 'Bob'], seedFor(['Ada', 'Bob'], humanImposter));
    while (s.phase === 'clue' && !s.seats[s.round!.clueSeat!].isImposter) {
      s = apply(s, { type: 'timeout', at: 1 }).state;
    }
    expect(s.phase).toBe('clue'); // sanity: the imposter's turn was found before the round moved on
    const imp = s.seats[s.round!.clueSeat!];
    const result = apply(s, { type: 'clue', playerId: imp.playerId!, word: s.round!.word, at: 2 });
    // The next turn may fall to a bot, which legitimately emits a botTurn effect; only errors matter here.
    expect(result.effects.some((e) => e.type === 'error')).toBe(false);
    expect(result.state.seats.find((seat) => seat.playerId === imp.playerId)!.clues).toEqual([s.round!.word]);
    expect(result.state.phase !== 'clue' || result.state.round!.clueSeat !== imp.index).toBe(true);
  });
});

describe('timeout in the clue phase', () => {
  it('records "" for the current seat and advances to the next human turn', () => {
    const s0 = started();
    const me = whoseTurn(s0);
    const s1 = apply(s0, { type: 'timeout', at: 4000 }).state;
    expect(s1.seats.find((seat) => seat.playerId === me)!.clues).toEqual(['']);
  });

  it('is a no-op in the lobby', () => {
    const state = roomWith(['Ada']);
    expect(apply(state, { type: 'timeout', at: 1 }).state).toBe(state);
  });
});

describe('disconnect', () => {
  it('marks only that seat disconnected and is a no-op for unknown ids', () => {
    const state = roomWith(['Ada', 'Bob']);
    const result = apply(state, { type: 'disconnect', playerId: 'p1' });
    expect(result.state.seats.map((s) => s.connected)).toEqual([true, false]);
    expect(apply(state, { type: 'disconnect', playerId: 'nobody' }).state).toEqual(state);
  });
});

/** Three humans so a 2-vote majority can eject. Returns the state at the start of the vote phase. */
function inVote(seed = seedFor(NAMES3, humanImposter)): RoomState {
  const inChat = throughClues(started(NAMES3, seed));
  return apply(inChat, { type: 'timeout', at: 10_000 }).state;
}

function imposterOf(state: RoomState) {
  return state.seats.find((s) => s.isImposter)!;
}

function crewOf(state: RoomState) {
  return state.seats.filter((s) => s.kind === 'human' && !s.isImposter);
}

describe('chat phase timeout', () => {
  it('opens a 20s vote with every vote cleared', () => {
    const s = inVote();
    expect(s.phase).toBe('vote');
    expect(s.phaseEndsAt).toBe(10_000 + DURATIONS.vote);
    expect(s.seats.every((seat) => seat.vote === null)).toBe(true);
  });
});

describe('vote', () => {
  it('records a vote for another seat and allows changing it until the phase closes', () => {
    const s0 = inVote();
    const [c1, c2] = crewOf(s0);
    const s1 = apply(s0, { type: 'vote', playerId: c1.playerId!, seat: c2.index, at: 1 }).state;
    expect(s1.seats[c1.index].vote).toBe(c2.index);
    expect(s1.phase).toBe('vote');
    const target = imposterOf(s0).index;
    const s2 = apply(s1, { type: 'vote', playerId: c1.playerId!, seat: target, at: 2 }).state;
    expect(s2.seats[c1.index].vote).toBe(target);
  });

  it('rejects self-votes, out-of-range seats, non-integers, and votes outside the vote phase', () => {
    const s0 = inVote();
    const [c1] = crewOf(s0);
    expect(errorCode(apply(s0, { type: 'vote', playerId: c1.playerId!, seat: c1.index, at: 1 }).effects)).toBe('bad-vote');
    expect(errorCode(apply(s0, { type: 'vote', playerId: c1.playerId!, seat: 6, at: 1 }).effects)).toBe('bad-vote');
    expect(errorCode(apply(s0, { type: 'vote', playerId: c1.playerId!, seat: 1.5, at: 1 }).effects)).toBe('bad-vote');
    expect(errorCode(apply(started(), { type: 'vote', playerId: 'p0', seat: 1, at: 1 }).effects)).toBe('wrong-phase');
    expect(errorCode(apply(s0, { type: 'vote', playerId: 'ghost', seat: 1, at: 1 }).effects)).toBe('not-seated');
  });

  it('closes once every bot and connected human has voted; a majority on the imposter opens a 15s steal', () => {
    let s = inVote();
    const imp = imposterOf(s);
    const [c1, c2] = crewOf(s);
    s = apply(s, { type: 'vote', playerId: c1.playerId!, seat: imp.index, at: 1 }).state;
    s = apply(s, { type: 'vote', playerId: c2.playerId!, seat: imp.index, at: 2 }).state;
    expect(s.phase).toBe('vote');
    for (const b of s.seats.filter((x) => x.kind === 'bot')) {
      s = apply(s, { type: 'botVote', seat: b.index, target: imp.index, at: 1 }).state;
    }
    expect(s.phase).toBe('vote');
    s = apply(s, { type: 'vote', playerId: imp.playerId!, seat: c1.index, at: 3000 }).state;
    expect(s.phase).toBe('steal');
    expect(s.phaseEndsAt).toBe(3000 + DURATIONS.steal);
    expect(s.round!.ejected).toBe(imp.index);
    expect(s.round!.result).toBeNull();
  });

  it('a majority on a crew member ends the round as an imposter win', () => {
    let s = inVote();
    const imp = imposterOf(s);
    const [c1, c2] = crewOf(s);
    s = apply(s, { type: 'vote', playerId: c1.playerId!, seat: c2.index, at: 1 }).state;
    s = apply(s, { type: 'vote', playerId: imp.playerId!, seat: c2.index, at: 2 }).state;
    s = apply(s, { type: 'vote', playerId: c2.playerId!, seat: c1.index, at: 3 }).state;
    s = apply(s, { type: 'timeout', at: 3 }).state;
    expect(s.phase).toBe('botcall');
    expect(s.round!.ejected).toBe(c2.index);
    expect(s.round!.result).toBe('imposter');
  });

  it('timeout with a split vote ejects nobody and the imposter wins', () => {
    let t = inVote();
    const imp = imposterOf(t);
    const [d1, d2] = crewOf(t);
    t = apply(t, { type: 'vote', playerId: d1.playerId!, seat: imp.index, at: 1 }).state;
    t = apply(t, { type: 'vote', playerId: d2.playerId!, seat: d1.index, at: 2 }).state;
    t = apply(t, { type: 'timeout', at: 5 }).state;
    expect(t.phase).toBe('botcall');
    expect(t.round!.ejected).toBeNull();
    expect(t.round!.result).toBe('imposter');
  });

  it('timeout with a single vote cast treats it as a majority of one', () => {
    let s = inVote();
    const [c1] = crewOf(s);
    s = apply(s, { type: 'vote', playerId: c1.playerId!, seat: imposterOf(s).index, at: 1 }).state;
    s = apply(s, { type: 'timeout', at: 5 }).state;
    expect(s.phase).toBe('steal');
    expect(s.round!.ejected).toBe(imposterOf(s).index);
  });
});

/** State in the steal phase with the imposter ejected. */
function inSteal(seed = seedFor(NAMES3, humanImposter)): RoomState {
  let s = inVote(seed);
  const imp = imposterOf(s);
  for (const c of crewOf(s)) s = apply(s, { type: 'vote', playerId: c.playerId!, seat: imp.index, at: 1 }).state;
  s = apply(s, { type: 'vote', playerId: imp.playerId!, seat: crewOf(s)[0].index, at: 2 }).state;
  s = apply(s, { type: 'timeout', at: 2 }).state;
  expect(s.phase).toBe('steal');
  return s;
}

describe('steal', () => {
  it('an exact guess flips the round to an imposter win', () => {
    const s0 = inSteal();
    const guess = ` ${s0.round!.word.toUpperCase()} `;
    const s1 = apply(s0, { type: 'steal', playerId: imposterOf(s0).playerId!, word: guess, at: 9 }).state;
    expect(s1.phase).toBe('botcall');
    expect(s1.round!.result).toBe('imposter');
    expect(s1.round!.stealGuess).toBe(guess.trim());
  });

  it('a wrong guess or a timeout is a crew win', () => {
    const s0 = inSteal();
    const wrong = apply(s0, { type: 'steal', playerId: imposterOf(s0).playerId!, word: 'nope', at: 9 }).state;
    expect(wrong.phase).toBe('botcall');
    expect(wrong.round!.result).toBe('crew');
    expect(wrong.round!.stealGuess).toBe('nope');
    const late = apply(s0, { type: 'timeout', at: 9 }).state;
    expect(late.phase).toBe('botcall');
    expect(late.round!.result).toBe('crew');
    expect(late.round!.stealGuess).toBeNull();
  });

  it('only the imposter may steal, and only during the steal phase', () => {
    const s0 = inSteal();
    const crew = crewOf(s0)[0];
    expect(errorCode(apply(s0, { type: 'steal', playerId: crew.playerId!, word: 'x', at: 1 }).effects)).toBe('not-imposter');
    expect(errorCode(apply(inVote(), { type: 'steal', playerId: 'p0', word: 'x', at: 1 }).effects)).toBe('wrong-phase');
  });
});

describe('again', () => {
  it('returns humans to a fresh lobby, dropping bots, aliases, clues, votes, and the round', () => {
    const s0 = inSteal();
    const done = toReveal(apply(s0, { type: 'timeout', at: 1 }).state);
    const s1 = apply(done, { type: 'again', playerId: 'p1', at: 2 }).state;
    expect(s1.phase).toBe('lobby');
    expect(s1.phaseEndsAt).toBeNull();
    expect(s1.round).toBeNull();
    expect(s1.transcript).toEqual([]);
    expect(s1.seats.map((s) => s.playerId).sort()).toEqual(['p0', 'p1', 'p2']);
    expect(s1.seats.map((s) => s.index)).toEqual([0, 1, 2]);
    for (const seat of s1.seats) {
      expect(seat).toMatchObject({ kind: 'human', alias: null, isImposter: false, clues: [], vote: null });
    }
    expect(apply(s1, { type: 'start', playerId: 'p0', at: 3, seed: 5 }).state.phase).toBe('clue');
  });

  it('is rejected before the reveal', () => {
    expect(errorCode(apply(inVote(), { type: 'again', playerId: 'p0', at: 1 }).effects)).toBe('wrong-phase');
  });
});

/** A round decided by a majority on a crew member: goes straight to the bot-call phase, no steal. */
function decided(): RoomState {
  let s = inVote();
  const imp = imposterOf(s);
  const [c1, c2] = crewOf(s);
  s = apply(s, { type: 'vote', playerId: c1.playerId!, seat: c2.index, at: 100 }).state;
  s = apply(s, { type: 'vote', playerId: c2.playerId!, seat: c1.index, at: 100 }).state;
  s = apply(s, { type: 'vote', playerId: imp.playerId!, seat: c1.index, at: 100 }).state;
  s = apply(s, { type: 'timeout', at: 100 }).state;
  return s;
}

describe('bot-call phase', () => {
  it('a decided round opens a 20s bot-call phase before the reveal and keeps the result on the round', () => {
    const s = decided();
    expect(s.phase).toBe('botcall');
    expect(s.phaseEndsAt).toBe(100 + DURATIONS.botcall);
    expect(s.round!.ejected).toBe(crewOf(inVote())[0].index);
    expect(s.round!.result).toBe('imposter');
    expect(s.seats.every((seat) => seat.botCalls === null && seat.score === null && seat.points === null)).toBe(true);
    expect(s.round!.winners).toBeNull();
  });

  it('records a human\'s calls, forces the entry for their own seat to null, and rejects malformed calls', () => {
    const s0 = decided();
    const [c1] = crewOf(s0);
    const calls: BotCall[] = s0.seats.map((seat) => seat.kind);
    const r = apply(s0, { type: 'botcall', playerId: c1.playerId!, calls, at: 200 });
    expect(r.effects).toEqual([]);
    expect(r.state.phase).toBe('botcall');
    const mine = r.state.seats[c1.index].botCalls!;
    expect(mine[c1.index]).toBeNull();
    expect(mine.filter((c) => c !== null)).toHaveLength(SEAT_COUNT - 1);
    expect(errorCode(apply(s0, { type: 'botcall', playerId: c1.playerId!, calls: ['bot'], at: 200 }).effects)).toBe('bad-botcall');
    const junk = calls.map(() => 'maybe') as unknown as BotCall[];
    expect(errorCode(apply(s0, { type: 'botcall', playerId: c1.playerId!, calls: junk, at: 200 }).effects)).toBe('bad-botcall');
    expect(errorCode(apply(inVote(), { type: 'botcall', playerId: c1.playerId!, calls, at: 200 }).effects)).toBe('wrong-phase');
    expect(errorCode(apply(s0, { type: 'botcall', playerId: 'ghost', calls, at: 200 }).effects)).toBe('not-seated');
  });

  it('reveals once every connected human has called, scoring calls, votes, and the imposter, and naming the winners', () => {
    let s = decided();
    const humans = s.seats.filter((seat) => seat.kind === 'human');
    const imp = humans.find((seat) => seat.isImposter)!;
    const perfect: BotCall[] = s.seats.map((seat) => seat.kind);
    const allBots: BotCall[] = s.seats.map(() => 'bot');
    s = apply(s, { type: 'botcall', playerId: humans[0].playerId!, calls: perfect, at: 200 }).state;
    s = apply(s, { type: 'botcall', playerId: humans[1].playerId!, calls: allBots, at: 201 }).state;
    expect(s.phase).toBe('botcall');
    s = apply(s, { type: 'botcall', playerId: humans[2].playerId!, calls: s.seats.map(() => null), at: 202 }).state;
    expect(s.phase).toBe('reveal');
    expect(s.phaseEndsAt).toBeNull();
    // In decided() nobody voted for the imposter and the imposter survived, so the imposter earns the survival points.
    expect(s.seats[humans[0].index].points).toMatchObject({ calls: 5, vote: 0 });
    expect(s.seats[humans[1].index].points).toMatchObject({ calls: 3, vote: 0 });
    expect(s.seats[humans[2].index].points).toMatchObject({ calls: 0, vote: 0 });
    expect(s.seats[imp.index].points!.imposter).toBe(POINTS.survive);
    for (const seat of s.seats) {
      expect(seat.points).not.toBeNull();
      expect(seat.score).toBe(seat.points!.total);
      expect(seat.total).toBe(seat.score);
    }
    const best = Math.max(...s.seats.map((seat) => seat.score!));
    expect(s.round!.winners).toEqual(s.seats.filter((seat) => seat.score === best).map((seat) => seat.index));
    expect(s.round!.winners!.length).toBeGreaterThan(0);
  });

  it('crew who voted for the imposter score the vote points and an ejected imposter who steals scores the steal points', () => {
    let s = inVote();
    const imp = imposterOf(s);
    const [c1, c2] = crewOf(s);
    s = apply(s, { type: 'vote', playerId: c1.playerId!, seat: imp.index, at: 100 }).state;
    s = apply(s, { type: 'vote', playerId: c2.playerId!, seat: imp.index, at: 100 }).state;
    s = apply(s, { type: 'vote', playerId: imp.playerId!, seat: c1.index, at: 100 }).state;
    s = apply(s, { type: 'timeout', at: 100 }).state;
    expect(s.phase).toBe('steal');
    s = apply(s, { type: 'steal', playerId: imp.playerId!, word: s.round!.word, at: 110 }).state;
    s = apply(s, { type: 'timeout', at: 300 }).state;
    expect(s.phase).toBe('reveal');
    expect(s.seats[c1.index].points).toMatchObject({ vote: POINTS.vote, imposter: 0 });
    expect(s.seats[imp.index].points).toMatchObject({ vote: 0, imposter: POINTS.steal });
    const bots = s.seats.filter((seat) => seat.kind === 'bot');
    expect(bots.every((seat) => seat.points!.calls === 0)).toBe(true);
  });

  it('a disconnected human does not hold the phase open, and a timeout reveals with 0 for humans who never called', () => {
    let s = decided();
    const humans = s.seats.filter((seat) => seat.kind === 'human');
    s = apply(s, { type: 'disconnect', playerId: humans[2].playerId! }).state;
    s = apply(s, { type: 'botcall', playerId: humans[0].playerId!, calls: s.seats.map(() => 'bot'), at: 200 }).state;
    expect(s.phase).toBe('botcall');
    s = apply(s, { type: 'botcall', playerId: humans[1].playerId!, calls: s.seats.map(() => 'bot'), at: 201 }).state;
    expect(s.phase).toBe('reveal');
    expect(s.seats[humans[2].index].score).toBe(0);

    const t = apply(decided(), { type: 'timeout', at: 300 }).state;
    expect(t.phase).toBe('reveal');
    expect(t.seats.filter((seat) => seat.kind === 'human').every((seat) => seat.points!.calls === 0)).toBe(true);
  });

  it('play again drops humans still disconnected, resets round scores, and keeps each human\'s running total', () => {
    let s = apply(decided(), { type: 'timeout', at: 300 }).state;
    const humans = s.seats.filter((seat) => seat.kind === 'human');
    const imp = humans.find((seat) => seat.isImposter)!;
    expect(s.seats[imp.index].total).toBe(POINTS.survive);
    s = apply(s, { type: 'disconnect', playerId: humans[1].playerId! }).state;
    s = apply(s, { type: 'again', playerId: humans[0].playerId!, at: 400 }).state;
    expect(s.phase).toBe('lobby');
    expect(s.seats.map((seat) => seat.playerId).sort()).toEqual([humans[0].playerId, humans[2].playerId].sort());
    expect(s.seats.map((seat) => seat.index)).toEqual([0, 1]);
    expect(s.seats.every((seat) => seat.botCalls === null && seat.score === null && seat.points === null)).toBe(true);
    const kept = s.seats.find((seat) => seat.playerId === imp.playerId);
    if (kept) expect(kept.total).toBe(POINTS.survive);
    expect(s.seats.reduce((sum, seat) => sum + seat.total, 0)).toBe(
      [humans[0], humans[2]].reduce((sum, seat) => sum + seat.total, 0),
    );
  });
});

describe('timeout in untimed phases', () => {
  it('is a no-op at the reveal', () => {
    const done = toReveal(apply(inSteal(), { type: 'timeout', at: 1 }).state);
    expect(apply(done, { type: 'timeout', at: 2 }).state).toBe(done);
  });
});

describe('bots in the reducer', () => {
  function startOne(seed: number): Result {
    return apply(roomWith(['Ada']), { type: 'start', playerId: 'p0', at: 1000, seed });
  }
  const botFirst = (s: RoomState) => s.seats[0].kind === 'bot';
  const botFirstTwo = (s: RoomState) => s.seats[0].kind === 'bot' && s.seats[1].kind === 'bot';

  it('a bot clue turn stays open and emits one botTurn clue effect with a 1.5 to 6s delay', () => {
    const r = startOne(seedFor(['Ada'], botFirst));
    expect(r.state.phase).toBe('clue');
    expect(r.state.round!.clueSeat).toBe(0);
    expect(r.state.phaseEndsAt).toBe(1000 + DURATIONS.clueTurn);
    expect(r.effects).toHaveLength(1);
    expect(r.effects[0]).toMatchObject({ type: 'botTurn', seat: 0, action: 'clue' });
    const delay = (r.effects[0] as BotTurn).delayMs;
    expect(delay).toBeGreaterThanOrEqual(1500);
    expect(delay).toBeLessThan(6000);
  });

  it('a human turn emits no bot effect', () => {
    expect(startOne(seedFor(['Ada'], (s) => s.seats[0].kind === 'human')).effects).toEqual([]);
  });

  it('botClue records the word for the bot on turn and emits the next bot turn', () => {
    const s0 = startOne(seedFor(['Ada'], botFirstTwo)).state;
    const r1 = apply(s0, { type: 'botClue', seat: 0, pass: 1, word: 'Brick', at: 1500 });
    expect(r1.state.seats[0].clues).toEqual(['Brick']);
    expect(r1.state.round!.clueSeat).toBe(1);
    expect(r1.state.phaseEndsAt).toBe(1500 + DURATIONS.clueTurn);
    expect(r1.effects).toMatchObject([{ type: 'botTurn', seat: 1, action: 'clue' }]);
  });

  it('ignores a botClue that is stale, for the wrong pass, not on turn, or for a human seat', () => {
    const s0 = startOne(seedFor(['Ada'], botFirstTwo)).state;
    const s1 = apply(s0, { type: 'botClue', seat: 0, pass: 1, word: 'Brick', at: 1500 }).state;
    const stale: Event[] = [
      { type: 'botClue', seat: 0, pass: 1, word: 'late', at: 1600 },
      { type: 'botClue', seat: 1, pass: 2, word: 'early', at: 1600 },
      { type: 'botClue', seat: 3, pass: 1, word: 'wrong', at: 1600 },
    ];
    for (const ev of stale) {
      const r = apply(s1, ev);
      expect(r.state).toBe(s1);
      expect(r.effects).toEqual([]);
    }
    const humanFirst = startOne(seedFor(['Ada'], (s) => s.seats[0].kind === 'human')).state;
    expect(apply(humanFirst, { type: 'botClue', seat: 0, pass: 1, word: 'nope', at: 1500 }).state).toBe(humanFirst);
  });

  it('a bot clue that is the secret word, a repeat, or empty is recorded as a passed turn', () => {
    const s0 = startOne(seedFor(['Ada'], (s) => botFirstTwo(s) && !s.seats[0].isImposter && !s.seats[1].isImposter)).state;
    const word = s0.round!.word;
    expect(apply(s0, { type: 'botClue', seat: 0, pass: 1, word, at: 1500 }).state.seats[0].clues).toEqual(['']);
    expect(apply(s0, { type: 'botClue', seat: 0, pass: 1, word: '', at: 1500 }).state.seats[0].clues).toEqual(['']);
    const s1 = apply(s0, { type: 'botClue', seat: 0, pass: 1, word: 'brick', at: 1500 }).state;
    expect(apply(s1, { type: 'botClue', seat: 1, pass: 1, word: 'BRICK', at: 1600 }).state.seats[1].clues).toEqual(['']);
  });

  it('a clue timeout on a bot turn passes it and emits the next bot turn', () => {
    const s0 = startOne(seedFor(['Ada'], botFirstTwo)).state;
    const r = apply(s0, { type: 'timeout', at: 21_000 });
    expect(r.state.seats[0].clues).toEqual(['']);
    expect(r.effects).toMatchObject([{ type: 'botTurn', seat: 1, action: 'clue' }]);
  });

  it('entering the chat emits 1 to 3 chat ticks per bot, each 6 to 80s in, and nothing for humans', () => {
    let r: Result = { state: started(['Ada', 'Bob']), effects: [] };
    while (r.state.phase === 'clue') r = apply(r.state, { type: 'timeout', at: 2000 });
    expect(r.state.phase).toBe('chat');
    const ticks = r.effects.filter((e): e is BotTurn => e.type === 'botTurn');
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.every((t) => t.action === 'chat')).toBe(true);
    for (const seat of r.state.seats) {
      const mine = ticks.filter((t) => t.seat === seat.index);
      if (seat.kind === 'human') {
        expect(mine).toHaveLength(0);
      } else {
        expect(mine.length).toBeGreaterThanOrEqual(1);
        expect(mine.length).toBeLessThanOrEqual(3);
        for (const t of mine) {
          expect(t.delayMs).toBeGreaterThanOrEqual(6000);
          expect(t.delayMs).toBeLessThan(80_000);
        }
      }
    }
    expect(apply(r.state, { type: 'chat', playerId: 'p0', text: 'hi', at: 2001 }).effects).toEqual([]);
  });

  it('botChat appends a trimmed, capped line during the chat only, and never for a human seat', () => {
    const chat = throughClues(started(['Ada', 'Bob']));
    const bot = chat.seats.find((s) => s.kind === 'bot')!;
    const human = chat.seats.find((s) => s.kind === 'human')!;
    const s1 = apply(chat, { type: 'botChat', seat: bot.index, text: '  hmm ' + 'x'.repeat(300), at: 3000 }).state;
    expect(s1.transcript).toHaveLength(1);
    expect(s1.transcript[0]).toMatchObject({ seat: bot.index, at: 3000 });
    expect(s1.transcript[0].text).toHaveLength(MAX_CHAT_LENGTH);
    expect(apply(chat, { type: 'botChat', seat: bot.index, text: '   ', at: 3000 }).state).toBe(chat);
    expect(apply(chat, { type: 'botChat', seat: human.index, text: 'nope', at: 3000 }).state).toBe(chat);
    const clue = started(['Ada', 'Bob']);
    expect(apply(clue, { type: 'botChat', seat: bot.index, text: 'early', at: 3000 }).state).toBe(clue);
  });

  it('entering the vote emits one botTurn vote per bot, 3 to 12s in', () => {
    const chat = throughClues(started(['Ada', 'Bob']));
    const r = apply(chat, { type: 'timeout', at: 10_000 });
    expect(r.state.phase).toBe('vote');
    const votes = r.effects.filter((e): e is BotTurn => e.type === 'botTurn');
    expect(votes.map((v) => v.seat).sort()).toEqual(r.state.seats.filter((s) => s.kind === 'bot').map((s) => s.index).sort());
    for (const v of votes) {
      expect(v.action).toBe('vote');
      expect(v.delayMs).toBeGreaterThanOrEqual(3000);
      expect(v.delayMs).toBeLessThan(12_000);
    }
  });

  it('bot votes count, the vote waits for bots and connected humans, and a disconnected human does not hold it open', () => {
    let s = inVote();
    const bots = s.seats.filter((seat) => seat.kind === 'bot');
    const [c1, c2] = crewOf(s);
    const imp = imposterOf(s);
    for (const b of bots) s = apply(s, { type: 'botVote', seat: b.index, target: imp.index, at: 1 }).state;
    expect(s.phase).toBe('vote');
    expect(bots.every((b) => s.seats[b.index].vote === imp.index)).toBe(true);
    s = apply(s, { type: 'vote', playerId: c1.playerId!, seat: imp.index, at: 2 }).state;
    s = apply(s, { type: 'disconnect', playerId: c2.playerId! }).state;
    expect(s.phase).toBe('vote');
    s = apply(s, { type: 'vote', playerId: imp.playerId!, seat: c1.index, at: 3 }).state;
    expect(s.phase).toBe('steal');
    expect(s.round!.ejected).toBe(imp.index);
  });

  it('ignores a bot vote for itself, out of range, from a human seat, outside the vote, or a second vote', () => {
    const s = inVote();
    const bot = s.seats.find((seat) => seat.kind === 'bot')!;
    const human = crewOf(s)[0];
    expect(apply(s, { type: 'botVote', seat: bot.index, target: bot.index, at: 1 }).state).toBe(s);
    expect(apply(s, { type: 'botVote', seat: bot.index, target: 9, at: 1 }).state).toBe(s);
    expect(apply(s, { type: 'botVote', seat: human.index, target: bot.index, at: 1 }).state).toBe(s);
    const chat = throughClues(started(NAMES3, seedFor(NAMES3, humanImposter)));
    const chatBot = chat.seats.find((x) => x.kind === 'bot')!;
    expect(apply(chat, { type: 'botVote', seat: chatBot.index, target: (chatBot.index + 1) % SEAT_COUNT, at: 1 }).state).toBe(chat);
    const voted = apply(s, { type: 'botVote', seat: bot.index, target: human.index, at: 1 }).state;
    expect(voted.seats[bot.index].vote).toBe(human.index);
    expect(apply(voted, { type: 'botVote', seat: bot.index, target: imposterOf(s).index, at: 2 }).state).toBe(voted);
  });

  it('an ejected bot imposter opens the steal with a botTurn steal, and botSteal decides the round', () => {
    const seed = seedFor(NAMES3, botImposter);
    let s = apply(throughClues(started(NAMES3, seed)), { type: 'timeout', at: 10_000 }).state;
    const imp = imposterOf(s);
    expect(imp.kind).toBe('bot');
    for (const h of s.seats.filter((x) => x.kind === 'human')) {
      s = apply(s, { type: 'vote', playerId: h.playerId!, seat: imp.index, at: 11 }).state;
    }
    expect(s.phase).toBe('vote');
    const r = apply(s, { type: 'timeout', at: 12_000 });
    expect(r.state.phase).toBe('steal');
    expect(r.state.phaseEndsAt).toBe(12_000 + DURATIONS.steal);
    expect(r.effects).toMatchObject([{ type: 'botTurn', seat: imp.index, action: 'steal' }]);
    const delay = (r.effects[0] as BotTurn).delayMs;
    expect(delay).toBeGreaterThanOrEqual(2000);
    expect(delay).toBeLessThan(8000);

    const wrong = apply(r.state, { type: 'botSteal', seat: imp.index, word: 'nope', at: 13_000 }).state;
    expect(wrong.phase).toBe('botcall');
    expect(wrong.round).toMatchObject({ result: 'crew', stealGuess: 'nope' });
    const right = apply(r.state, { type: 'botSteal', seat: imp.index, word: ` ${r.state.round!.word.toUpperCase()} `, at: 13_000 }).state;
    expect(right.round!.result).toBe('imposter');
    const crewBot = r.state.seats.find((x) => x.kind === 'bot' && !x.isImposter)!;
    expect(apply(r.state, { type: 'botSteal', seat: crewBot.index, word: 'x', at: 1 }).state).toBe(r.state);
  });

  it('an ejected human imposter emits no bot effect', () => {
    let s = inVote();
    const imp = imposterOf(s);
    for (const c of crewOf(s)) s = apply(s, { type: 'vote', playerId: c.playerId!, seat: imp.index, at: 1 }).state;
    const r = apply(s, { type: 'timeout', at: 12_000 });
    expect(r.state.phase).toBe('steal');
    expect(r.effects).toEqual([]);
  });
});
