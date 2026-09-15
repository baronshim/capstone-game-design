import { describe, it, expect } from 'vitest';
import { apply, createRoom, type RoomState } from '../../src/game/state';
import { redact } from '../../src/game/redact';

function lobby(): RoomState {
  let state = createRoom('ABCD', 0);
  state = apply(state, { type: 'join', playerId: 'p0', displayName: 'Ada', at: 0 }).state;
  state = apply(state, { type: 'join', playerId: 'p1', displayName: 'Bob', at: 0 }).state;
  state = apply(state, { type: 'join', playerId: 'p2', displayName: 'Cal', at: 0 }).state;
  return apply(state, { type: 'chat', playerId: 'p0', text: 'hey', at: 1 }).state;
}

function startWith(seed: number): RoomState {
  return apply(lobby(), { type: 'start', playerId: 'p0', at: 10, seed }).state;
}

/** First seed whose imposter is human, so the imposter's view can be redacted by playerId. */
const SEED = (() => {
  for (let seed = 1; seed < 1000; seed++) {
    if (startWith(seed).seats.find((s) => s.isImposter)!.kind === 'human') return seed;
  }
  throw new Error('no seed with a human imposter');
})();

function inClue(): RoomState {
  return startWith(SEED);
}

function inChat(): RoomState {
  let s = inClue();
  while (s.phase === 'clue') s = apply(s, { type: 'timeout', at: 20 }).state;
  return apply(s, { type: 'chat', playerId: 'p1', text: 'sus', at: 21 }).state;
}

function inVote(): RoomState {
  return apply(inChat(), { type: 'timeout', at: 30 }).state;
}

function imposterOf(state: RoomState) {
  return state.seats.find((s) => s.isImposter)!;
}

function inSteal(): RoomState {
  let s = inVote();
  const imp = imposterOf(s);
  for (const seat of s.seats) {
    if (seat.kind !== 'human' || seat.isImposter) continue;
    s = apply(s, { type: 'vote', playerId: seat.playerId!, seat: imp.index, at: 40 }).state;
  }
  const crew = s.seats.find((seat) => seat.kind === 'human' && !seat.isImposter)!;
  s = apply(s, { type: 'vote', playerId: imp.playerId!, seat: crew.index, at: 41 }).state;
  s = apply(s, { type: 'timeout', at: 42 }).state;
  expect(s.phase).toBe('steal');
  return s;
}

function inBotcall(): RoomState {
  const s = inSteal();
  return apply(s, { type: 'steal', playerId: imposterOf(s).playerId!, word: 'nope', at: 50 }).state;
}

function inReveal(): RoomState {
  return apply(inBotcall(), { type: 'timeout', at: 60 }).state;
}

const HUMANS = ['p0', 'p1', 'p2'];
/** Fields that must never reach a viewer about another seat before the reveal. */
const OTHER_SEAT_SECRETS = ['playerId', 'kind', 'isImposter', 'displayName', 'vote', 'botCalls', 'score'];

describe('redact before the reveal', () => {
  const phases = { clue: inClue, chat: inChat, vote: inVote, steal: inSteal, botcall: inBotcall };

  it.each(Object.entries(phases))('in the %s phase never exposes identity fields of other seats', (_name, make) => {
    const state = make();
    for (const viewer of [...HUMANS, null]) {
      const snap = redact(state, viewer);
      for (const seat of snap.seats) {
        if (seat.index === snap.you) continue;
        for (const key of OTHER_SEAT_SECRETS) expect(seat).not.toHaveProperty(key);
      }
      expect(JSON.stringify(snap)).not.toContain('"playerId"');
      expect(snap.round!.stealGuess).toBeNull();
      expect(snap.round!.result).toBeNull();
      expect(snap.autopilot).toBe(false);
    }
  });

  it.each(Object.entries(phases))('in the %s phase hides the word from the imposter and from non-viewers, shows it to crew', (_name, make) => {
    const state = make();
    const imp = imposterOf(state);
    const impSnap = redact(state, imp.playerId!);
    expect(impSnap.round!.word).toBeNull();
    expect(impSnap.round!.category).toBe(state.round!.category);
    expect(JSON.stringify(impSnap).toLowerCase()).not.toContain(state.round!.word);
    expect(redact(state, null).round!.word).toBeNull();
    for (const id of HUMANS) {
      if (id === imp.playerId) continue;
      expect(redact(state, id).round!.word).toBe(state.round!.word);
    }
  });

  it('shows your own kind and imposter flag, and public clues for everyone', () => {
    const state = inChat();
    const imp = imposterOf(state);
    const snap = redact(state, imp.playerId!);
    expect(snap.seats[snap.you!]).toMatchObject({ kind: 'human', isImposter: true, displayName: imp.displayName });
    for (const seat of snap.seats) expect(seat.clues).toEqual(state.seats[seat.index].clues);
  });

  it('exposes clueSeat only during the clue phase and voted flags during the vote', () => {
    expect(redact(inClue(), 'p0').round!.clueSeat).toBe(inClue().round!.clueSeat);
    expect(redact(inChat(), 'p0').round!.clueSeat).toBeNull();
    let s = inVote();
    const imp = imposterOf(s);
    const voter = s.seats.find((seat) => seat.kind === 'human' && !seat.isImposter)!;
    s = apply(s, { type: 'vote', playerId: voter.playerId!, seat: imp.index, at: 1 }).state;
    const snap = redact(s, imp.playerId!);
    expect(snap.seats[voter.index].voted).toBe(true);
    expect(snap.seats[voter.index]).not.toHaveProperty('vote');
    expect(snap.seats.filter((seat) => seat.voted)).toHaveLength(1);
  });

  it('copies code, phase, phaseEndsAt, connection flags, and transcript', () => {
    const state = inChat();
    const snap = redact(state, 'p0');
    expect(snap.code).toBe('ABCD');
    expect(snap.phase).toBe('chat');
    expect(snap.phaseEndsAt).toBe(state.phaseEndsAt);
    expect(snap.transcript).toEqual(state.transcript);
    expect(snap.seats.map((s) => s.connected)).toEqual(state.seats.map((s) => s.connected));
  });
});

describe('redact in the lobby', () => {
  it('shows display names to everyone, kind and imposter flag only to yourself, no round', () => {
    const snap = redact(lobby(), 'p1');
    expect(snap.you).toBe(1);
    expect(snap.round).toBeNull();
    expect(snap.phaseEndsAt).toBeNull();
    expect(snap.seats.map((s) => s.displayName)).toEqual(['Ada', 'Bob', 'Cal']);
    expect(snap.seats[0].kind).toBeUndefined();
    expect(snap.seats[1]).toMatchObject({ kind: 'human', isImposter: false });
  });

  it('gives an unknown viewer you=null', () => {
    expect(redact(lobby(), 'nobody').you).toBeNull();
  });
});

describe('redact at the reveal', () => {
  it('exposes names, kinds, imposter flags, votes, the word, and the steal guess to everyone, never playerId', () => {
    const state = inReveal();
    for (const viewer of HUMANS) {
      const snap = redact(state, viewer);
      expect(snap.phase).toBe('reveal');
      expect(snap.round).toMatchObject({ word: state.round!.word, stealGuess: 'nope', result: 'crew', ejected: imposterOf(state).index });
      for (const seat of snap.seats) {
        const real = state.seats[seat.index];
        expect(seat).toMatchObject({ kind: real.kind, isImposter: real.isImposter, vote: real.vote });
        if (real.kind === 'human') expect(seat.displayName).toBe(real.displayName);
      }
      expect(JSON.stringify(snap)).not.toContain('"playerId"');
    }
  });
});

describe('redact during the bot call and at the reveal', () => {
  it('echoes your own locked calls back to you and to nobody else, with the result still hidden', () => {
    let s = inBotcall();
    const caller = s.seats.find((seat) => seat.kind === 'human')!;
    const calls = s.seats.map((seat) => (seat.index === caller.index ? null : 'bot' as const));
    s = apply(s, { type: 'botcall', playerId: caller.playerId!, calls, at: 55 }).state;
    expect(s.phase).toBe('botcall');
    const own = redact(s, caller.playerId!);
    expect(own.seats[caller.index].botCalls).toEqual(calls);
    expect(own.round!.result).toBeNull();
    for (const id of HUMANS) {
      if (id === caller.playerId) continue;
      const snap = redact(s, id);
      expect(snap.seats[caller.index]).not.toHaveProperty('botCalls');
      expect(snap.seats[snap.you!].botCalls).toBeNull();
    }
  });

  it('exposes the result and every seat\'s score at the reveal', () => {
    const s = inReveal();
    const snap = redact(s, 'p0');
    expect(snap.round!.result).toBe('crew');
    for (const seat of snap.seats) {
      expect(seat.score).toBe(seat.kind === 'human' ? 0 : null);
    }
  });
});
