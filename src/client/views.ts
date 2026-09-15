import type { Snapshot } from '../game/protocol';

export function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

export function nameOf(snap: Snapshot, seat: number): string {
  const s = snap.seats[seat];
  return s?.alias ?? s?.displayName ?? `Seat ${seat + 1}`;
}

export function cardHtml(snap: Snapshot): string {
  const r = snap.round;
  if (!r) return '';
  if (r.word === null) {
    return `<div>Category: <b>${esc(r.category)}</b></div><div>You are the <b>imposter</b>. You do not know the word. Blend in.</div>`;
  }
  return `<div>Category: ${esc(r.category)}</div><div>The word is <b>${esc(r.word)}</b></div>`;
}

export function seatsHtml(snap: Snapshot): string {
  return snap.seats
    .map((s) => {
      const you = s.index === snap.you ? ' (you)' : '';
      const turn = snap.phase === 'clue' && snap.round?.clueSeat === s.index ? ' turn' : '';
      const voted = snap.phase === 'vote' && s.voted ? ' ✓' : '';
      const clues = s.clues.map((c) => esc(c || '(no clue)')).join(', ');
      return `<div class="seat${s.connected ? '' : ' off'}${turn}"><span>${esc(nameOf(snap, s.index))}${you}${voted}</span><span class="clues">${clues}</span></div>`;
    })
    .join('');
}

export function turnHtml(snap: Snapshot): string {
  if (snap.phase !== 'clue' || !snap.round || snap.round.clueSeat === null) return '';
  const pass = `Clue round ${snap.round.cluePass} of 2.`;
  if (snap.round.clueSeat === snap.you) return `${pass} <b>Your turn:</b> give a one-word clue.`;
  return `${pass} Waiting for ${esc(nameOf(snap, snap.round.clueSeat))}…`;
}

export function voteHtml(snap: Snapshot): string {
  const buttons = snap.seats
    .filter((s) => s.index !== snap.you)
    .map((s) => `<button data-seat="${s.index}">${esc(nameOf(snap, s.index))}</button>`)
    .join('');
  return `<p>Who is the imposter?</p>${buttons}`;
}

export function revealHtml(snap: Snapshot): string {
  const r = snap.round;
  if (!r) return '';
  const headline = r.result === 'crew' ? 'Crew wins' : 'Imposter wins';
  const ejected = r.ejected === null ? 'Nobody was ejected.' : `${esc(nameOf(snap, r.ejected))} was ejected.`;
  const steal = r.stealGuess !== null ? ` Steal guess: “${esc(r.stealGuess)}”.` : '';
  const rows = snap.seats
    .map((s) => {
      const who = s.kind === 'bot' ? '<i>bot</i>' : esc(s.displayName ?? '');
      const voted = s.vote === null || s.vote === undefined ? '' : esc(nameOf(snap, s.vote));
      return `<tr><td>${esc(s.alias ?? '')}</td><td>${who}</td><td>${s.isImposter ? 'Imposter' : ''}</td><td>${voted}</td></tr>`;
    })
    .join('');
  return `<h3>${headline}</h3><p>${ejected}${steal} The word was <b>${esc(r.word ?? '')}</b>.</p><table><tr><th>Alias</th><th>Who</th><th></th><th>Voted for</th></tr>${rows}</table>`;
}

export function logHtml(snap: Snapshot): string {
  return snap.transcript
    .map((l) => `<div class="line"><b>${esc(nameOf(snap, l.seat))}</b>${esc(l.text)}</div>`)
    .join('');
}
