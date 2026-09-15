import { describe, it, expect } from 'vitest';
import { chooseImposter, DURATIONS, isStealCorrect, resolveVote, scoreBotCalls } from '../../src/game/rules';
import { seededRng } from '../../src/game/aliases';

describe('DURATIONS', () => {
  it('matches the spec', () => {
    expect(DURATIONS).toEqual({ clueTurn: 20_000, chat: 90_000, vote: 20_000, steal: 15_000, botcall: 20_000 });
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

  it('only ever picks a human seat (M2) and reaches every human across seeds', () => {
    const picked = new Set<number>();
    for (let seed = 1; seed <= 40; seed++) {
      const i = chooseImposter(seats, seededRng(seed));
      expect(seats[i].kind).toBe('human');
      picked.add(i);
    }
    expect(picked).toEqual(new Set([1, 3, 5]));
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
