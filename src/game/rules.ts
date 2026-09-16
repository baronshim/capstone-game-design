import type { Rng } from './aliases';
import type { BotCall, SeatKind } from './protocol';

/** Phase lengths in milliseconds (spec 2.3). */
export const DURATIONS = {
  clueTurn: 20_000,
  chat: 90_000,
  vote: 20_000,
  steal: 15_000,
  botcall: 20_000,
} as const;

/** Picks the imposter uniformly among all seats, bots included (spec 2.2). */
export function chooseImposter(seats: { index: number }[], rng: Rng): number {
  if (seats.length === 0) throw new RangeError('chooseImposter needs at least one seat');
  return seats[Math.floor(rng() * seats.length)].index;
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

/** One point per other seat called correctly (spec 2.4); a null entry or a missing call scores nothing. */
export function scoreBotCalls(calls: BotCall[] | null, seats: { index: number; kind: SeatKind }[], self: number): number {
  if (!calls) return 0;
  let score = 0;
  for (const s of seats) if (s.index !== self && calls[s.index] === s.kind) score++;
  return score;
}
