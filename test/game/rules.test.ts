import { describe, it, expect } from 'vitest';
import { chooseImposter, DURATIONS, isStealCorrect, POINTS, resolveVote, roundPoints, scoreBotCalls } from '../../src/game/rules';
import { seededRng } from '../../src/game/aliases';

describe('DURATIONS', () => {
  it('matches the spec', () => {
    expect(DURATIONS).toEqual({ deal: 6_000, clueTurn: 30_000, chat: 150_000, vote: 30_000, steal: 20_000, botcall: 30_000 });
  });
});

describe('chooseImposter', () => {
  const seats = [
    { index: 0, kind: 'bot' as const },
    { index: 1, kind: 'human' as const },
    { index: 2, kind: 'bot' as const },
    { index: 3, kind: 'human' as const },
    { index: 4, kind: 'bot' as const },
    { index: 5, kind: 'human' as const },
  ];

  it('picks any of the six seats, bots included, and reaches every seat across seeds', () => {
    const picked = new Set<number>();
    for (let seed = 1; seed <= 60; seed++) picked.add(chooseImposter(seats, seededRng(seed)));
    expect(picked).toEqual(new Set([0, 1, 2, 3, 4, 5]));
  });

  it('is deterministic for a seed', () => {
    expect(chooseImposter(seats, seededRng(9))).toBe(chooseImposter(seats, seededRng(9)));
  });
});

describe('resolveVote', () => {
  it('ejects the seat with strictly more than half of the votes cast', () => {
    expect(resolveVote([1, 1, 2])).toBe(1);
    expect(resolveVote([3, null, null, null, null, null])).toBe(3);
    expect(resolveVote([1, 1, null, null, null, null])).toBe(1);
  });

  it('ejects nobody on a tie, a plurality short of majority, or no votes', () => {
    expect(resolveVote([1, 2, null, null, null, null])).toBeNull();
    expect(resolveVote([1, 1, 2, 2, 3, null])).toBeNull();
    expect(resolveVote([1, 2, 3, 4, null, null])).toBeNull();
    expect(resolveVote([null, null, null, null, null, null])).toBeNull();
    expect(resolveVote([])).toBeNull();
  });

  it('ignores abstentions when counting the majority', () => {
    expect(resolveVote([4, 4, 0, null, null, null])).toBe(4);
  });
});

describe('isStealCorrect', () => {
  it('matches exactly after trimming and lowercasing, nothing looser', () => {
    expect(isStealCorrect('  Pizza ', 'pizza')).toBe(true);
    expect(isStealCorrect('pizzas', 'pizza')).toBe(false);
    expect(isStealCorrect('', 'pizza')).toBe(false);
  });
});

describe('scoreBotCalls', () => {
  const seats = [
    { index: 0, kind: 'human' as const },
    { index: 1, kind: 'bot' as const },
    { index: 2, kind: 'bot' as const },
    { index: 3, kind: 'human' as const },
  ];

  it('scores one point per other seat called correctly and ignores the caller\'s own entry', () => {
    expect(scoreBotCalls(['bot', 'bot', 'bot', 'human'], seats, 0)).toBe(3);
    expect(scoreBotCalls(['human', 'bot', 'human', 'bot'], seats, 0)).toBe(1);
  });

  it('treats null entries and a missing call as zero', () => {
    expect(scoreBotCalls([null, null, null, null], seats, 0)).toBe(0);
    expect(scoreBotCalls(null, seats, 0)).toBe(0);
  });
});

describe('roundPoints', () => {
  const seats = [
    { index: 0, kind: 'human' as const, isImposter: false, vote: 2, botCalls: ['bot', 'bot', 'bot', 'human'] as ('bot' | 'human' | null)[] },
    { index: 1, kind: 'bot' as const, isImposter: false, vote: 0, botCalls: null },
    { index: 2, kind: 'bot' as const, isImposter: true, vote: 0, botCalls: null },
    { index: 3, kind: 'human' as const, isImposter: false, vote: 2, botCalls: null },
  ];

  it('pays crew for voting for the imposter and humans for correct calls', () => {
    const survived = { ejected: null, stealCorrect: false };
    expect(roundPoints(seats[0], seats, survived)).toEqual({ vote: POINTS.vote, imposter: 0, calls: 3, total: POINTS.vote + 3 });
    expect(roundPoints(seats[1], seats, survived)).toEqual({ vote: 0, imposter: 0, calls: 0, total: 0 });
    expect(roundPoints(seats[3], seats, survived)).toEqual({ vote: POINTS.vote, imposter: 0, calls: 0, total: POINTS.vote });
  });

  it('pays the imposter for surviving the vote, less for a steal, and nothing for a failed steal', () => {
    expect(roundPoints(seats[2], seats, { ejected: null, stealCorrect: false }).imposter).toBe(POINTS.survive);
    expect(roundPoints(seats[2], seats, { ejected: 1, stealCorrect: false }).imposter).toBe(POINTS.survive);
    expect(roundPoints(seats[2], seats, { ejected: 2, stealCorrect: true }).imposter).toBe(POINTS.steal);
    expect(roundPoints(seats[2], seats, { ejected: 2, stealCorrect: false }).imposter).toBe(0);
    expect(roundPoints(seats[2], seats, { ejected: 2, stealCorrect: false }).vote).toBe(0);
  });

  it('gives nothing for an abstention or a wrong vote', () => {
    const wrong = { ...seats[3], vote: 1 };
    const none = { ...seats[3], vote: null };
    expect(roundPoints(wrong, seats, { ejected: null, stealCorrect: false }).vote).toBe(0);
    expect(roundPoints(none, seats, { ejected: null, stealCorrect: false }).vote).toBe(0);
  });
});
