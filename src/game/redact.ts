import type { RoomState } from './state';
import type { SeatView, Snapshot } from './protocol';

/**
 * The only path from room state to a client. Strips everything a viewer
 * must not know about other seats. After start, other seats expose only
 * alias and connection state.
 */
export function redact(state: RoomState, viewerPlayerId: string | null): Snapshot {
  const you = viewerPlayerId === null ? undefined : state.seats.find((s) => s.playerId === viewerPlayerId);
  const seats: SeatView[] = state.seats.map((s) => {
    const mine = you !== undefined && s.index === you.index;
    const view: SeatView = { index: s.index, alias: s.alias, connected: s.connected };
    if (mine || state.phase === 'lobby') view.displayName = s.displayName;
    if (mine) view.kind = s.kind;
    return view;
  });
  return {
    code: state.code,
    phase: state.phase,
    you: you ? you.index : null,
    seats,
    transcript: state.transcript,
  };
}
