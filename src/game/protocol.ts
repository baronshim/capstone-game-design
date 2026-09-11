export type Phase = 'lobby' | 'clue' | 'chat' | 'vote' | 'steal' | 'reveal';
export type SeatKind = 'human' | 'bot';
/** Who won the round. */
export type Outcome = 'crew' | 'imposter';

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
  result: Outcome | null;
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
}

export type ClientMessage =
  | { type: 'join'; playerId: string; displayName: string }
  | { type: 'start' }
  | { type: 'chat'; text: string }
  | { type: 'clue'; word: string }
  | { type: 'vote'; seat: number }
  | { type: 'steal'; word: string }
  | { type: 'again' };

export type ServerMessage =
  | { type: 'state'; snapshot: Snapshot }
  | { type: 'error'; code: string; message: string };
