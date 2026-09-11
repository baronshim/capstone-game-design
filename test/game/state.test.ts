import { describe, it, expect } from 'vitest';
import { apply, createRoom, MAX_TRANSCRIPT, SEAT_COUNT, type RoomState } from '../../src/game/state';
import { DURATIONS } from '../../src/game/rules';
import { CATEGORIES } from '../../src/game/words';

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
      isImposter: false, clues: [], vote: null,
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
    const s0 = started();
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
