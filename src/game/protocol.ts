export type Phase = 'lobby' | 'chat';
export type SeatKind = 'human' | 'bot';

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
  /** Present in the lobby for everyone, and always for your own seat. */
  displayName?: string;
  /** Present only for your own seat. */
  kind?: SeatKind;
}

export interface Snapshot {
  code: string;
  phase: Phase;
  /** Your seat index, or null if you are not seated. */
  you: number | null;
  seats: SeatView[];
  transcript: ChatLine[];
}

export type ClientMessage =
  | { type: 'join'; playerId: string; displayName: string }
  | { type: 'start' }
  | { type: 'chat'; text: string };

export type ServerMessage =
  | { type: 'state'; snapshot: Snapshot }
  | { type: 'error'; code: string; message: string };
