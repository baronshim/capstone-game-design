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

/** Round points (spec 2.4): a crew vote for the imposter, the imposter surviving the vote or stealing, and each correct bot call. */
export const POINTS = { vote: 2, survive: 3, steal: 2, call: 1 } as const;

export interface RoundPoints {
  vote: number;
  imposter: number;
  calls: number;
  total: number;
}

interface ScoredSeat {
  index: number;
  kind: SeatKind;
  isImposter: boolean;
  vote: number | null;
  botCalls: BotCall[] | null;
}

/** A seat's points for the round once the vote and any steal have resolved. */
export function roundPoints(seat: ScoredSeat, seats: ScoredSeat[], outcome: { ejected: number | null; stealCorrect: boolean }): RoundPoints {
  const imposter = seats.find((s) => s.isImposter);
  let vote = 0;
  let imp = 0;
  if (seat.isImposter) {
    if (outcome.ejected !== seat.index) imp = POINTS.survive;
    else if (outcome.stealCorrect) imp = POINTS.steal;
  } else if (imposter && seat.vote === imposter.index) {
    vote = POINTS.vote;
  }
  const calls = seat.kind === 'human' ? scoreBotCalls(seat.botCalls, seats, seat.index) * POINTS.call : 0;
  return { vote, imposter: imp, calls, total: vote + imp + calls };
}

/** One point per other seat called correctly (spec 2.4); a null entry or a missing call scores nothing. */
export function scoreBotCalls(calls: BotCall[] | null, seats: { index: number; kind: SeatKind }[], self: number): number {
  if (!calls) return 0;
  let score = 0;
  for (const s of seats) if (s.index !== self && calls[s.index] === s.kind) score++;
  return score;
}
