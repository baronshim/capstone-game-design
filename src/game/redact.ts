import type { RoomState } from './state';
import type { RoundView, SeatView, Snapshot } from './protocol';

/**
 * The only path from room state to a client. Strips everything a viewer
 * must not know about other seats.
 *
 * Task 6 implements the real round rules. Until then `word` and `stealGuess`
 * are withheld from every viewer: a stub must never leak more than the
 * finished rule would.
 */
export function redact(state: RoomState, viewerPlayerId: string | null): Snapshot {
  const you = viewerPlayerId === null ? undefined : state.seats.find((s) => s.playerId === viewerPlayerId);
  const seats: SeatView[] = state.seats.map((s) => {
    const mine = you !== undefined && s.index === you.index;
    const view: SeatView = {
      index: s.index,
      alias: s.alias,
      connected: s.connected,
      clues: s.clues,
      voted: s.vote !== null,
    };
    if (mine || state.phase === 'lobby') view.displayName = s.displayName;
    if (mine) view.kind = s.kind;
    return view;
  });
  const r = state.round;
  const round: RoundView | null =
    r === null
      ? null
      : {
          category: r.category,
          word: null,
          clueSeat: state.phase === 'clue' ? r.clueSeat : null,
          cluePass: r.cluePass,
          ejected: r.ejected,
          stealGuess: null,
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
