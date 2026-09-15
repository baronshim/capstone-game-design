import type { Rng } from './aliases';

export interface Category {
  name: string;
  words: string[];
}

export const CATEGORIES: Category[] = [
  { name: 'Animals', words: ['elephant', 'penguin', 'dolphin', 'giraffe', 'octopus', 'kangaroo', 'tiger', 'parrot', 'camel', 'spider'] },
  { name: 'Food', words: ['pizza', 'sushi', 'pancake', 'burrito', 'chocolate', 'noodles', 'cheese', 'mango', 'popcorn', 'soup'] },
  { name: 'Places', words: ['beach', 'library', 'airport', 'hospital', 'castle', 'desert', 'stadium', 'jungle', 'museum', 'farm'] },
  { name: 'Objects', words: ['umbrella', 'guitar', 'telescope', 'backpack', 'candle', 'mirror', 'ladder', 'pillow', 'compass', 'kettle'] },
  { name: 'Jobs', words: ['pilot', 'chef', 'dentist', 'firefighter', 'astronaut', 'farmer', 'detective', 'teacher', 'plumber', 'magician'] },
  { name: 'Sports', words: ['soccer', 'tennis', 'boxing', 'surfing', 'chess', 'bowling', 'hockey', 'archery', 'skiing', 'golf'] },
];

export const MAX_CLUE_LENGTH = 20;

export function pickWord(rng: Rng): { category: string; word: string } {
  const category = CATEGORIES[Math.floor(rng() * CATEGORIES.length)];
  const word = category.words[Math.floor(rng() * category.words.length)];
  return { category: category.name, word };
}

export function normalizeWord(s: string): string {
  return s.toLowerCase().replace(/[^a-z]/g, '');
}

/** Candidate stems for a normalized word: itself plus simple plural and verb-ending strips. */
function stems(w: string): Set<string> {
  const out = new Set([w]);
  const strip = (suffix: string, replacement = '') => {
    if (!w.endsWith(suffix) || w.length - suffix.length < 2) return;
    const base = w.slice(0, -suffix.length) + replacement;
    out.add(base);
    // Consonant doubling before -ing/-ed: running -> runn -> run, stopped -> stopp -> stop.
    if ((suffix === 'ing' || suffix === 'ed') && base.length >= 3 && base[base.length - 1] === base[base.length - 2]) {
      out.add(base.slice(0, -1));
    }
  };
  strip('ies', 'y');
  strip('es');
  strip('s');
  strip('ing');
  strip('ed');
  return out;
}

/** True when `candidate` is the secret word or a plural or simple stem variant of it. */
export function isSecretWord(candidate: string, word: string): boolean {
  const c = normalizeWord(candidate);
  if (!c) return false;
  const a = stems(c);
  for (const s of stems(normalizeWord(word))) if (a.has(s)) return true;
  return false;
}

export type ClueCheck =
  | { ok: true; clue: string }
  | { ok: false; code: 'clue-empty' | 'clue-one-word' | 'clue-too-long' | 'clue-is-word' | 'clue-taken'; message: string };

export function validateClue(raw: string, word: string, priorClues: string[], checkSecret = true): ClueCheck {
  const clue = raw.trim();
  if (!clue) return { ok: false, code: 'clue-empty', message: 'Type a clue' };
  if (/\s/.test(clue)) return { ok: false, code: 'clue-one-word', message: 'One word only' };
  if (clue.length > MAX_CLUE_LENGTH) return { ok: false, code: 'clue-too-long', message: `Clues are at most ${MAX_CLUE_LENGTH} letters` };
  if (checkSecret && isSecretWord(clue, word)) return { ok: false, code: 'clue-is-word', message: 'That is the word itself' };
  const norm = normalizeWord(clue);
  if (priorClues.some((p) => p !== '' && normalizeWord(p) === norm)) {
    return { ok: false, code: 'clue-taken', message: 'That clue was already given' };
  }
  return { ok: true, clue };
}
