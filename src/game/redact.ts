import type { RoomState } from './state';
import type { RoundView, SeatView, Snapshot } from './protocol';

/**
 * The only path from room state to a client. Before the reveal, other seats
 * expose only alias, connection state, public clues, and whether they have
 * voted; the imposter never receives the word. At the reveal everything but
 * playerId is public.
 */
export function redact(state: RoomState, viewerPlayerId: string | null): Snapshot {
  const you = viewerPlayerId === null ? undefined : state.seats.find((s) => s.playerId === viewerPlayerId);
  const lobby = state.phase === 'lobby';
  const reveal = state.phase === 'reveal';

  const seats: SeatView[] = state.seats.map((s) => {
    const mine = you !== undefined && s.index === you.index;
    const view: SeatView = { index: s.index, alias: s.alias, connected: s.connected, clues: s.clues, voted: s.vote !== null };
    if (mine || lobby || reveal) view.displayName = s.displayName;
    if (mine || reveal) {
      view.kind = s.kind;
      view.isImposter = s.isImposter;
    }
    if (reveal) view.vote = s.vote;
    return view;
  });

  const r = state.round;
  const round: RoundView | null =
    r === null
      ? null
      : {
          category: r.category,
          word: (reveal || (you !== undefined && !you.isImposter)) ? r.word : null,
          clueSeat: state.phase === 'clue' ? r.clueSeat : null,
          cluePass: r.cluePass,
          ejected: r.ejected,
          stealGuess: reveal ? r.stealGuess : null,
          result: r.result,
        };

  return {
    code: state.code,
    phase: state.phase,
    you: you ? you.index : null,
    phaseEndsAt: state.phaseEndsAt,
    seats,
    transcript: state.transcript,
    round,
  };
}
