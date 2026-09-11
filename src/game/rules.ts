import type { Rng } from './aliases';
import type { SeatKind } from './protocol';

/** Phase lengths in milliseconds (spec 2.3). */
export const DURATIONS = {
  clueTurn: 20_000,
  chat: 90_000,
  vote: 20_000,
  steal: 15_000,
} as const;

/**
 * Picks the imposter uniformly among human seats. M2 only: bots cannot act yet,
 * so a bot imposter would make the round unwinnable. M3 widens this to all seats.
 */
export function chooseImposter(seats: { index: number; kind: SeatKind }[], rng: Rng): number {
  const humans = seats.filter((s) => s.kind === 'human');
  if (humans.length === 0) throw new RangeError('chooseImposter needs at least one human seat');
  return humans[Math.floor(rng() * humans.length)].index;
}

/** Majority of votes cast (strictly more than half) ejects; ties and abstentions eject nobody. */
export function resolveVote(votes: (number | null)[]): number | null {
  const cast = votes.filter((v): v is number => v !== null);
  if (cast.length === 0) return null;
  const tally = new Map<number, number>();
  for (const v of cast) tally.set(v, (tally.get(v) ?? 0) + 1);
  for (const [seat, count] of tally) if (count * 2 > cast.length) return seat;
  return null;
}

export function isStealCorrect(guess: string, word: string): boolean {
  const g = guess.trim().toLowerCase();
  return g.length > 0 && g === word.trim().toLowerCase();
}
