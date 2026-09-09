import { describe, it, expect } from 'vitest';
import { apply, createRoom, SEAT_COUNT, type RoomState } from '../../src/game/state';
import { seededRng } from '../../src/game/aliases';

const rng = () => seededRng(42);

function roomWith(names: string[]): RoomState {
  let state = createRoom('ABCD', 1000);
  names.forEach((name, i) => {
    state = apply(state, { type: 'join', playerId: `p${i}`, displayName: name, at: 1000 + i }).state;
  });
  return state;
}

describe('createRoom', () => {
  it('starts empty in the lobby', () => {
    const state = createRoom('ABCD', 1000);
    expect(state).toEqual({ code: 'ABCD', phase: 'lobby', seats: [], transcript: [], createdAt: 1000 });
  });
});

describe('join', () => {
  it('seats a new human in the next index', () => {
    const state = roomWith(['Ada', 'Bob']);
    expect(state.seats).toHaveLength(2);
    expect(state.seats[1]).toEqual({
      index: 1, kind: 'human', alias: null, playerId: 'p1', displayName: 'Bob', connected: true,
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
    let state = roomWith(['Ada']);
    state = apply(state, { type: 'start', playerId: 'p0' }, rng()).state;
    const result = apply(state, { type: 'join', playerId: 'p9', displayName: 'Late', at: 0 });
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
    const state = roomWith(['Ada']);
    const result = apply(state, { type: 'chat', playerId: 'ghost', text: 'boo', at: 5 });
    expect(result.effects[0].code).toBe('not-seated');
    expect(result.state.transcript).toEqual([]);
  });
});

describe('start', () => {
  it('fills to 6 seats with bots, shuffles, assigns unique aliases, clears lobby chat', () => {
    let state = roomWith(['Ada', 'Bob']);
    state = apply(state, { type: 'chat', playerId: 'p0', text: 'lobby talk', at: 5 }).state;
    const result = apply(state, { type: 'start', playerId: 'p0' }, rng());
    const s = result.state;
    expect(result.effects).toEqual([]);
    expect(s.phase).toBe('chat');
    expect(s.transcript).toEqual([]);
    expect(s.seats).toHaveLength(SEAT_COUNT);
    expect(s.seats.map((seat) => seat.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(new Set(s.seats.map((seat) => seat.alias)).size).toBe(SEAT_COUNT);
    expect(s.seats.filter((seat) => seat.kind === 'human').map((seat) => seat.playerId).sort()).toEqual(['p0', 'p1']);
    expect(s.seats.filter((seat) => seat.kind === 'bot')).toHaveLength(4);
    expect(s.seats.every((seat) => seat.connected)).toBe(true);
  });

  it('actually shuffles seat order for some seed', () => {
    const state = roomWith(['a', 'b', 'c', 'd', 'e', 'f']);
    const orders = [1, 2, 3, 4, 5].map((seed) =>
      apply(state, { type: 'start', playerId: 'p0' }, seededRng(seed)).state.seats.map((s) => s.playerId).join(),
    );
    expect(new Set(orders).size).toBeGreaterThan(1);
  });

  it('errors if already started or from a non-member', () => {
    let state = roomWith(['Ada']);
    expect(apply(state, { type: 'start', playerId: 'ghost' }, rng()).effects[0].code).toBe('not-seated');
    state = apply(state, { type: 'start', playerId: 'p0' }, rng()).state;
    expect(apply(state, { type: 'start', playerId: 'p0' }, rng()).effects[0].code).toBe('already-started');
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
