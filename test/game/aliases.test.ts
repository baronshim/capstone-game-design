import { describe, it, expect } from 'vitest';
import { makeAliases, seededRng, shuffle } from '../../src/game/aliases';

describe('makeAliases', () => {
  it('returns the requested number of unique "Color Animal" aliases', () => {
    const aliases = makeAliases(6, seededRng(1));
    expect(aliases).toHaveLength(6);
    expect(new Set(aliases).size).toBe(6);
    for (const a of aliases) expect(a).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  });

  it('is deterministic for the same seed and differs across seeds', () => {
    expect(makeAliases(6, seededRng(7))).toEqual(makeAliases(6, seededRng(7)));
    expect(makeAliases(6, seededRng(7))).not.toEqual(makeAliases(6, seededRng(8)));
  });

  it('gives every alias in a round a distinct color and a distinct animal', () => {
    const aliases = makeAliases(6, seededRng(5));
    const colors = new Set(aliases.map((a) => a.split(' ')[0]));
    const animals = new Set(aliases.map((a) => a.split(' ')[1]));
    expect(colors.size).toBe(6);
    expect(animals.size).toBe(6);
  });
});

describe('shuffle', () => {
  it('keeps the same elements and shuffles in place', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const result = shuffle(items, seededRng(3));
    expect(result).toBe(items);
    expect([...result].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(result).not.toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
