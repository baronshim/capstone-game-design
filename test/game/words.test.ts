import { describe, it, expect } from 'vitest';
import { CATEGORIES, isSecretWord, normalizeWord, pickWord, validateClue } from '../../src/game/words';
import { ALIAS_WORDS, seededRng } from '../../src/game/aliases';

describe('CATEGORIES', () => {
  it('has at least 5 categories of at least 8 single lowercase words with no duplicates', () => {
    expect(CATEGORIES.length).toBeGreaterThanOrEqual(5);
    const all = CATEGORIES.flatMap((c) => c.words);
    expect(new Set(all).size).toBe(all.length);
    for (const c of CATEGORIES) {
      expect(c.words.length).toBeGreaterThanOrEqual(8);
      for (const w of c.words) expect(w).toMatch(/^[a-z]+$/);
    }
  });

  it('never uses a call-sign word as a secret word, so naming a seat cannot leak it', () => {
    for (const c of CATEGORIES) for (const w of c.words) expect(ALIAS_WORDS.has(w)).toBe(false);
  });
});

describe('pickWord', () => {
  it('returns a word from the named category, deterministically per seed', () => {
    const pick = pickWord(seededRng(3));
    const category = CATEGORIES.find((c) => c.name === pick.category)!;
    expect(category.words).toContain(pick.word);
    expect(pickWord(seededRng(3))).toEqual(pick);
    const seen = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((s) => pickWord(seededRng(s)).word));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('normalizeWord', () => {
  it('lowercases, trims, and strips everything but letters', () => {
    expect(normalizeWord('  Pizza! ')).toBe('pizza');
    expect(normalizeWord("Don't")).toBe('dont');
  });
});

describe('isSecretWord', () => {
  it.each([
    ['pizza', 'pizza'],
    ['Pizza', 'pizza'],
    ['pizzas', 'pizza'],
    ['dog', 'dogs'],
    ['boxes', 'box'],
    ['cities', 'city'],
    ['shoes', 'shoe'],
    ['running', 'run'],
    ['jumped', 'jump'],
  ])('%s matches secret %s', (candidate, word) => {
    expect(isSecretWord(candidate, word)).toBe(true);
  });

  it.each([
    ['cat', 'car'],
    ['bust', 'bus'],
    ['pizzeria', 'pizza'],
    ['', 'pizza'],
  ])('%s does not match secret %s', (candidate, word) => {
    expect(isSecretWord(candidate, word)).toBe(false);
  });
});

describe('validateClue', () => {
  it('accepts a single word, trimmed, keeping its casing', () => {
    expect(validateClue('  Cheese ', 'pizza', [])).toEqual({ ok: true, clue: 'Cheese' });
  });

  it('rejects empty, multi-word, and overlong clues', () => {
    expect(validateClue('   ', 'pizza', [])).toMatchObject({ ok: false, code: 'clue-empty' });
    expect(validateClue('two words', 'pizza', [])).toMatchObject({ ok: false, code: 'clue-one-word' });
    expect(validateClue('x'.repeat(21), 'pizza', [])).toMatchObject({ ok: false, code: 'clue-too-long' });
  });

  it('rejects the secret word and its plural or stem', () => {
    expect(validateClue('Pizza', 'pizza', [])).toMatchObject({ ok: false, code: 'clue-is-word' });
    expect(validateClue('pizzas', 'pizza', [])).toMatchObject({ ok: false, code: 'clue-is-word' });
  });

  it('rejects a clue already given this round, case-insensitively', () => {
    expect(validateClue('cheese', 'pizza', ['Cheese', ''])).toMatchObject({ ok: false, code: 'clue-taken' });
    expect(validateClue('crust', 'pizza', ['Cheese', ''])).toEqual({ ok: true, clue: 'crust' });
  });
});
