import { describe, it, expect } from 'vitest';
import { apply, createRoom, MAX_TRANSCRIPT, SEAT_COUNT, type RoomState } from '../../src/game/state';
import { DURATIONS } from '../../src/game/rules';
import { CATEGORIES } from '../../src/game/words';
import type { BotCall } from '../../src/game/protocol';

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
      isImposter: false, clues: [], vote: null, botCalls: null, score: null,
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
    expect(result.effects[0].code).toBe('room-started');
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
    expect(result.effects[0].code).toBe('not-seated');
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
    expect(apply(inClue, { type: 'chat', playerId: 'p0', text: 'psst', at: 5 }).effects[0].code).toBe('chat-closed');
    const inChat = throughClues(inClue);
    expect(apply(inChat, { type: 'chat', playerId: 'p0', text: 'psst', at: 5 }).state.transcript).toHaveLength(1);
  });
});

describe('start', () => {
  it('fills to 6 seats with bots, shuffles, assigns unique aliases, clears lobby chat, opens the clue phase', () => {
    let state = roomWith(['Ada', 'Bob']);
    state = apply(state, { type: 'chat', playerId: 'p0', text: 'lobby talk', at: 5 }).state;
    const result = apply(state, { type: 'start', playerId: 'p0', at: 1000, seed: 42 });
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

  it('picks a word from a category and exactly one imposter, who is human', () => {
    const s = started();
    const category = CATEGORIES.find((c) => c.name === s.round!.category)!;
    expect(category.words).toContain(s.round!.word);
    expect(s.round).toMatchObject({ seed: 42, cluePass: 1, ejected: null, stealGuess: null, result: null });
    const imposters = s.seats.filter((seat) => seat.isImposter);
    expect(imposters).toHaveLength(1);
    expect(imposters[0].kind).toBe('human');
  });

  it('is deterministic for a seed and varies across seeds', () => {
    expect(started(['Ada', 'Bob'], 7)).toEqual(started(['Ada', 'Bob'], 7));
    const words = new Set([1, 2, 3, 4, 5, 6].map((seed) => started(['Ada', 'Bob'], seed).round!.word));
    expect(words.size).toBeGreaterThan(1);
    const orders = new Set([1, 2, 3, 4, 5].map((seed) => started(['a', 'b', 'c', 'd', 'e', 'f'], seed).seats.map((s) => s.playerId).join()));
    expect(orders.size).toBeGreaterThan(1);
  });

  it('passes bot turns instantly so the first turn is a human, recording "" for each skipped bot', () => {
    const s = started();
    const turn = s.seats[s.round!.clueSeat!];
    expect(turn.kind).toBe('human');
    for (const seat of s.seats) {
      if (seat.index < turn.index) expect(seat.clues).toEqual(['']);
      else expect(seat.clues).toEqual([]);
    }
  });

  it('errors if already started or from a non-member', () => {
    const state = roomWith(['Ada']);
    expect(apply(state, { type: 'start', playerId: 'ghost', at: 0, seed: 1 }).effects[0].code).toBe('not-seated');
    expect(apply(started(['Ada']), { type: 'start', playerId: 'p0', at: 0, seed: 1 }).effects[0].code).toBe('already-started');
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
    expect(s1.phase === 'chat' || s1.seats[s1.round!.clueSeat!].kind === 'human').toBe(true);
    expect(whoseTurn(s1) !== me || s1.round!.cluePass === 2).toBe(true);
  });

  it('rejects out-of-turn, multi-word, secret-word, and repeated clues without advancing', () => {
    // Seed 1: the first turn holder is crew, so the secret-word check below
    // exercises the crew path (see the imposter carve-out tests further down).
    const s0 = started(['Ada', 'Bob'], 1);
    const me = whoseTurn(s0);
    const other = me === 'p0' ? 'p1' : 'p0';
    expect(apply(s0, { type: 'clue', playerId: other, word: 'x', at: 1 }).effects[0].code).toBe('not-your-turn');
    expect(apply(s0, { type: 'clue', playerId: me, word: 'two words', at: 1 }).effects[0].code).toBe('clue-one-word');
    expect(apply(s0, { type: 'clue', playerId: me, word: s0.round!.word, at: 1 }).effects[0].code).toBe('clue-is-word');
    const s1 = apply(s0, { type: 'clue', playerId: me, word: 'first', at: 1 }).state;
    const next = whoseTurn(s1);
    const dup = apply(s1, { type: 'clue', playerId: next, word: 'FIRST', at: 2 });
    expect(dup.effects[0].code).toBe('clue-taken');
    expect(dup.state).toBe(s1);
    expect(apply(s0, { type: 'clue', playerId: 'ghost', word: 'x', at: 1 }).effects[0].code).toBe('not-seated');
  });

  it('is rejected outside the clue phase', () => {
    const inChat = throughClues(started());
    expect(apply(inChat, { type: 'clue', playerId: 'p0', word: 'late', at: 1 }).effects[0].code).toBe('wrong-phase');
  });

  it('opens the chat phase for 90s after two passes, with clueSeat null and two entries per seat', () => {
    // Distinct words: `c0`/`c1` all normalize to `c` and would be rejected as duplicates.
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
    let s = started();
    let n = 0;
    while (s.phase === 'clue') {
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
    expect(result.effects[0].code).toBe('clue-is-word');
    expect(result.state).toBe(s);
  });

  it('accepts the imposter clueing the secret word, recording it and advancing the turn', () => {
    let s = started(['Ada', 'Bob', 'Cal'], 42);
    while (s.phase === 'clue' && !s.seats[s.round!.clueSeat!].isImposter) {
      s = apply(s, { type: 'timeout', at: 1 }).state;
    }
    expect(s.phase).toBe('clue'); // sanity: the imposter's turn was found before the round moved on
    const imp = s.seats[s.round!.clueSeat!];
    const result = apply(s, { type: 'clue', playerId: imp.playerId!, word: s.round!.word, at: 2 });
    expect(result.effects).toEqual([]);
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
    expect(s1.phase === 'chat' || s1.seats[s1.round!.clueSeat!].kind === 'human').toBe(true);
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
function inVote(seed = 42): RoomState {
  const inChat = throughClues(started(['Ada', 'Bob', 'Cal'], seed));
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
    expect(apply(s0, { type: 'vote', playerId: c1.playerId!, seat: c1.index, at: 1 }).effects[0].code).toBe('bad-vote');
    expect(apply(s0, { type: 'vote', playerId: c1.playerId!, seat: 6, at: 1 }).effects[0].code).toBe('bad-vote');
    expect(apply(s0, { type: 'vote', playerId: c1.playerId!, seat: 1.5, at: 1 }).effects[0].code).toBe('bad-vote');
    expect(apply(started(), { type: 'vote', playerId: 'p0', seat: 1, at: 1 }).effects[0].code).toBe('wrong-phase');
    expect(apply(s0, { type: 'vote', playerId: 'ghost', seat: 1, at: 1 }).effects[0].code).toBe('not-seated');
  });

  it('closes as soon as every human has voted; a majority on the imposter opens a 15s steal', () => {
    let s = inVote();
    const imp = imposterOf(s);
    const [c1, c2] = crewOf(s);
    s = apply(s, { type: 'vote', playerId: c1.playerId!, seat: imp.index, at: 1 }).state;
    s = apply(s, { type: 'vote', playerId: c2.playerId!, seat: imp.index, at: 2 }).state;
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
function inSteal(seed = 42): RoomState {
  let s = inVote(seed);
  const imp = imposterOf(s);
  for (const c of crewOf(s)) s = apply(s, { type: 'vote', playerId: c.playerId!, seat: imp.index, at: 1 }).state;
  s = apply(s, { type: 'vote', playerId: imp.playerId!, seat: crewOf(s)[0].index, at: 2 }).state;
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
    expect(apply(s0, { type: 'steal', playerId: crew.playerId!, word: 'x', at: 1 }).effects[0].code).toBe('not-imposter');
    expect(apply(inVote(), { type: 'steal', playerId: 'p0', word: 'x', at: 1 }).effects[0].code).toBe('wrong-phase');
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
    expect(apply(inVote(), { type: 'again', playerId: 'p0', at: 1 }).effects[0].code).toBe('wrong-phase');
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
  return s;
}

describe('bot-call phase', () => {
  it('a decided round opens a 20s bot-call phase before the reveal and keeps the result on the round', () => {
    const s = decided();
    expect(s.phase).toBe('botcall');
    expect(s.phaseEndsAt).toBe(100 + DURATIONS.botcall);
    expect(s.round!.ejected).toBe(crewOf(inVote())[0].index);
    expect(s.round!.result).toBe('imposter');
    expect(s.seats.every((seat) => seat.botCalls === null && seat.score === null)).toBe(true);
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
    expect(apply(s0, { type: 'botcall', playerId: c1.playerId!, calls: ['bot'], at: 200 }).effects[0].code).toBe('bad-botcall');
    const junk = calls.map(() => 'maybe') as unknown as BotCall[];
    expect(apply(s0, { type: 'botcall', playerId: c1.playerId!, calls: junk, at: 200 }).effects[0].code).toBe('bad-botcall');
    expect(apply(inVote(), { type: 'botcall', playerId: c1.playerId!, calls, at: 200 }).effects[0].code).toBe('wrong-phase');
    expect(apply(s0, { type: 'botcall', playerId: 'ghost', calls, at: 200 }).effects[0].code).toBe('not-seated');
  });

  it('reveals once every connected human has called, scoring one point per correct call on another seat', () => {
    let s = decided();
    const humans = s.seats.filter((seat) => seat.kind === 'human');
    const perfect: BotCall[] = s.seats.map((seat) => seat.kind);
    const allBots: BotCall[] = s.seats.map(() => 'bot');
    s = apply(s, { type: 'botcall', playerId: humans[0].playerId!, calls: perfect, at: 200 }).state;
    s = apply(s, { type: 'botcall', playerId: humans[1].playerId!, calls: allBots, at: 201 }).state;
    expect(s.phase).toBe('botcall');
    s = apply(s, { type: 'botcall', playerId: humans[2].playerId!, calls: s.seats.map(() => null), at: 202 }).state;
    expect(s.phase).toBe('reveal');
    expect(s.phaseEndsAt).toBeNull();
    expect(s.seats[humans[0].index].score).toBe(5);
    expect(s.seats[humans[1].index].score).toBe(3);
    expect(s.seats[humans[2].index].score).toBe(0);
    expect(s.seats.filter((seat) => seat.kind === 'bot').every((seat) => seat.score === null)).toBe(true);
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
    expect(t.seats.filter((seat) => seat.kind === 'human').every((seat) => seat.score === 0)).toBe(true);
  });

  it('play again drops humans still disconnected and resets calls and scores', () => {
    let s = apply(decided(), { type: 'timeout', at: 300 }).state;
    const humans = s.seats.filter((seat) => seat.kind === 'human');
    s = apply(s, { type: 'disconnect', playerId: humans[1].playerId! }).state;
    s = apply(s, { type: 'again', playerId: humans[0].playerId!, at: 400 }).state;
    expect(s.phase).toBe('lobby');
    expect(s.seats.map((seat) => seat.playerId).sort()).toEqual([humans[0].playerId, humans[2].playerId].sort());
    expect(s.seats.map((seat) => seat.index)).toEqual([0, 1]);
    expect(s.seats.every((seat) => seat.botCalls === null && seat.score === null)).toBe(true);
  });
});

describe('timeout in untimed phases', () => {
  it('is a no-op at the reveal', () => {
    const done = toReveal(apply(inSteal(), { type: 'timeout', at: 1 }).state);
    expect(apply(done, { type: 'timeout', at: 2 }).state).toBe(done);
  });
});
