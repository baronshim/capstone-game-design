import type { BotCall, Phase, Snapshot } from '../game/protocol';

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

/** Short phase names for the header. */
export const PHASE_LABELS: Record<Phase, string> = {
  lobby: 'lobby',
  clue: 'clues',
  chat: 'chat',
  vote: 'vote',
  steal: 'steal',
  botcall: 'bot call',
  reveal: 'reveal',
};

/** Human/Bot toggles for every other seat. Shows the viewer's unsent `pending` picks until the server echoes locked-in calls. */
export function botcallHtml(snap: Snapshot, pending: BotCall[]): string {
  const me = snap.you;
  if (me === null) return '';
  const locked = snap.seats[me].botCalls ?? null;
  const calls = locked ?? pending;
  const rows = snap.seats
    .filter((s) => s.index !== me)
    .map((s) => {
      const button = (call: 'human' | 'bot', label: string) =>
        `<button data-seat="${s.index}" data-call="${call}" class="${calls[s.index] === call ? 'on' : ''}"${locked ? ' disabled' : ''}>${label}</button>`;
      return `<div class="seat"><span>${esc(nameOf(snap, s.index))}</span><span class="callbtns">${button('human', 'Human')}${button('bot', 'Bot')}</span></div>`;
    })
    .join('');
  const head = locked ? '<p>Calls locked in. Waiting for the others…</p>' : '<p>Who is human and who is a bot? One point per correct call.</p>';
  return head + rows;
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
  const scores = snap.seats
    .filter((s) => s.kind === 'human' && s.score !== null && s.score !== undefined)
    .map((s) => `${esc(s.displayName ?? nameOf(snap, s.index))} ${s.score}/${snap.seats.length - 1}`)
    .join(', ');
  const calls = scores ? `<p>Bot calls: ${scores}</p>` : '';
  return `<h3>${headline}</h3><p>${ejected}${steal} The word was <b>${esc(r.word ?? '')}</b>.</p><table><tr><th>Alias</th><th>Who</th><th></th><th>Voted for</th></tr>${rows}</table>${calls}`;
}

export function logHtml(snap: Snapshot): string {
  return snap.transcript
    .map((l) => `<div class="line"><b>${esc(nameOf(snap, l.seat))}</b>${esc(l.text)}</div>`)
    .join('');
}
