export type Rng = () => number;

const COLORS = ['Teal', 'Amber', 'Crimson', 'Indigo', 'Olive', 'Coral', 'Slate', 'Violet', 'Mint', 'Rust'];
const ANIMALS = ['Otter', 'Heron', 'Fox', 'Lynx', 'Moth', 'Newt', 'Raven', 'Yak', 'Ibis', 'Gecko'];

/** Every word a call sign can contain, lowercased. Secret words must stay clear of these, or naming a seat would leak the word. */
export const ALIAS_WORDS: ReadonlySet<string> = new Set([...COLORS, ...ANIMALS].map((w) => w.toLowerCase()));

/** Fisher-Yates shuffle in place; returns the same array for convenience. */
export function shuffle<T>(items: T[], rng: Rng): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

export function makeAliases(count: number, rng: Rng): string[] {
  if (count > 10) throw new RangeError('makeAliases supports at most 10 aliases');
  const colors = shuffle([...COLORS], rng);
  const animals = shuffle([...ANIMALS], rng);
  return colors.slice(0, count).map((color, i) => `${color} ${animals[i]}`);
}

/** mulberry32: small deterministic PRNG for tests and reproducible rounds. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
