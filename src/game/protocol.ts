import type { RoundPoints } from './rules';

export type Phase = 'lobby' | 'deal' | 'clue' | 'chat' | 'vote' | 'steal' | 'botcall' | 'reveal';
export type SeatKind = 'human' | 'bot';
/** Who won the round. */
export type Outcome = 'crew' | 'imposter';
/** A human's call on one seat during the bot-call phase; null is no call. */
export type BotCall = SeatKind | null;

export interface ChatLine {
  seat: number;
  text: string;
  at: number;
}

/** What one viewer is allowed to see about a seat. */
export interface SeatView {
  index: number;
  alias: string | null;
  connected: boolean;
  /** Public. One entry per clue pass; '' means the turn passed with no clue. */
  clues: string[];
  /** Public during the vote so the room can see who is still deciding. */
  voted: boolean;
  /** Present in the lobby for everyone, always for your own seat, and for everyone at the reveal. */
  displayName?: string;
  /** Present only for your own seat, and for everyone at the reveal. */
  kind?: SeatKind;
  /** Present only for your own seat, and for everyone at the reveal. */
  isImposter?: boolean;
  /** Present only at the reveal. */
  vote?: number | null;
  /** Present only for your own seat: the calls you locked in this round, or null. */
  botCalls?: BotCall[] | null;
  /** Present only at the reveal: the seat's round points. */
  score?: number;
  /** Present only at the reveal: how the round points break down. */
  points?: RoundPoints;
  /** Running total across rounds in this room; bots start every round at 0. */
  total: number;
}

export interface RoundView {
  category: string;
  /** null for the imposter until the reveal. */
  word: string | null;
  /** Whose turn it is; null outside the clue phase. */
  clueSeat: number | null;
  cluePass: 1 | 2;
  ejected: number | null;
  /** Present only at the reveal. */
  stealGuess: string | null;
  /** Present only at the reveal. */
  result: Outcome | null;
  /** Present only at the reveal: seats sharing the top round score. */
  winners: number[] | null;
}

export interface Snapshot {
  code: string;
  phase: Phase;
  /** Your seat index, or null if you are not seated. */
  you: number | null;
  /** Server clock deadline for the current phase; null when untimed. */
  phaseEndsAt: number | null;
  seats: SeatView[];
  transcript: ChatLine[];
  round: RoundView | null;
  /** True when the daily AI allocation is used up and bots run on the scripted backend. */
  autopilot: boolean;
}

export type ClientMessage =
  | { type: 'join'; playerId: string; displayName: string }
  | { type: 'start' }
  | { type: 'chat'; text: string }
  | { type: 'clue'; word: string }
  | { type: 'vote'; seat: number }
  | { type: 'steal'; word: string }
  | { type: 'botcall'; calls: BotCall[] }
  | { type: 'again' };

export type ServerMessage =
  | { type: 'state'; snapshot: Snapshot }
  | { type: 'error'; code: string; message: string };
