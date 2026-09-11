import { describe, it, expect } from 'vitest';
import { apply, createRoom, type RoomState } from '../../src/game/state';
import { redact } from '../../src/game/redact';

function lobby(): RoomState {
  let state = createRoom('ABCD', 0);
  state = apply(state, { type: 'join', playerId: 'p0', displayName: 'Ada', at: 0 }).state;
  state = apply(state, { type: 'join', playerId: 'p1', displayName: 'Bob', at: 0 }).state;
  return apply(state, { type: 'chat', playerId: 'p0', text: 'hey', at: 1 }).state;
}

function started(): RoomState {
  return apply(lobby(), { type: 'start', playerId: 'p0', at: 10, seed: 1 }).state;
}

/** Fields that must never reach any client about another seat. */
const FORBIDDEN_KEYS = ['playerId'];

describe('redact', () => {
  it('never serializes playerId for anyone, in any phase', () => {
    for (const state of [lobby(), started()]) {
      for (const viewer of ['p0', 'p1', null]) {
        const json = JSON.stringify(redact(state, viewer));
        for (const key of FORBIDDEN_KEYS) expect(json).not.toContain(`"${key}"`);
      }
    }
  });

  it('in the lobby shows display names to everyone and kind only to yourself', () => {
    const snap = redact(lobby(), 'p1');
    expect(snap.you).toBe(1);
    expect(snap.seats.map((s) => s.displayName)).toEqual(['Ada', 'Bob']);
    expect(snap.seats[0].kind).toBeUndefined();
    expect(snap.seats[1].kind).toBe('human');
  });

  it('after start hides other seats\' display names and kinds but shows aliases', () => {
    const state = started();
    const snap = redact(state, 'p0');
    const me = state.seats.find((s) => s.playerId === 'p0')!;
    expect(snap.you).toBe(me.index);
    for (const seat of snap.seats) {
      expect(seat.alias).toMatch(/\w+ \w+/);
      if (seat.index === me.index) {
        expect(seat.displayName).toBe('Ada');
        expect(seat.kind).toBe('human');
      } else {
        expect(seat.displayName).toBeUndefined();
        expect(seat.kind).toBeUndefined();
      }
    }
  });

  it('copies code, phase, connection flags, and transcript; unknown viewer gets you=null', () => {
    const state = lobby();
    const snap = redact(state, 'nobody');
    expect(snap.you).toBeNull();
    expect(snap.code).toBe('ABCD');
    expect(snap.phase).toBe('lobby');
    expect(snap.transcript).toEqual([{ seat: 0, text: 'hey', at: 1 }]);
    expect(snap.seats.map((s) => s.connected)).toEqual([true, true]);
  });
});
