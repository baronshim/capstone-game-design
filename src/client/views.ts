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

/** The alias colour word maps to a real, screen-legible hue so each call sign wears its own colour. */
const ALIAS_COLORS: Record<string, string> = {
  Teal: '#2dd4bf',
  Amber: '#f5b642',
  Crimson: '#f0546a',
  Indigo: '#8b8bf0',
  Olive: '#b7c26a',
  Coral: '#ff8a6b',
  Slate: '#9fb0d4',
  Violet: '#bd8cf0',
  Mint: '#6fe0b0',
  Rust: '#e08a5c',
};

/** The colour for a seat, read from the first word of its alias ("Teal Otter" -> teal). */
function seatColor(snap: Snapshot, seat: number): string {
  const alias = snap.seats[seat]?.alias ?? '';
  return ALIAS_COLORS[alias.split(' ')[0]] ?? 'var(--accent)';
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
      return `<div class="call-row" style="--seat:${seatColor(snap, s.index)}"><i class="dot"></i><span class="alias">${esc(nameOf(snap, s.index))}</span><span class="callbtns">${button('human', 'Human')}${button('bot', 'Bot')}</span></div>`;
    })
    .join('');
  const head = locked
    ? '<p class="prompt">Calls locked in.</p><p style="color:var(--muted);font-size:14px;margin:-6px 0 10px">Waiting for the others…</p>'
    : '<p class="prompt">Who is human, who is a bot?</p><p style="color:var(--muted);font-size:14px;margin:-6px 0 10px">One point for every correct call.</p>';
  return head + rows;
}

export function cardHtml(snap: Snapshot): string {
  const r = snap.round;
  if (!r) return '';
  if (r.word === null) {
    return `<div class="card-inner imposter"><span class="card-badge">You are the imposter</span><div class="card-eyebrow">Category</div><div class="card-word">${esc(r.category)}</div><div class="card-note">You don't know the word. Give clues that fit and blend in.</div></div>`;
  }
  return `<div class="card-inner crew"><div class="card-eyebrow">${esc(r.category)}</div><div class="card-word">${esc(r.word)}</div></div>`;
}

export function seatsHtml(snap: Snapshot): string {
  return snap.seats
    .map((s) => {
      const color = seatColor(snap, s.index);
      const mine = s.index === snap.you;
      const turn = snap.phase === 'clue' && snap.round?.clueSeat === s.index;
      const voted = snap.phase === 'vote' && s.voted;
      const cls = ['seat', s.connected ? '' : 'off', turn ? 'turn' : ''].filter(Boolean).join(' ');
      const you = mine ? '<span class="badge-you">you</span>' : '';
      const check = voted ? '<span class="check">✓</span>' : '';
      const chips = s.clues.length
        ? `<span class="clues">${s.clues
            .map((c) => (c ? `<span class="clue-chip">${esc(c)}</span>` : '<span class="clue-chip empty">no clue</span>'))
            .join('')}</span>`
        : '';
      return `<div class="${cls}" style="--seat:${color}"><span class="sig"><i class="dot"></i><span class="alias">${esc(nameOf(snap, s.index))}</span>${you}${check}</span>${chips}</div>`;
    })
    .join('');
}

export function turnHtml(snap: Snapshot): string {
  if (snap.phase !== 'clue' || !snap.round || snap.round.clueSeat === null) return '';
  const pass = `Round ${snap.round.cluePass} of 2`;
  if (snap.round.clueSeat === snap.you) {
    return `${pass} · <span class="turn-you">your turn — one word</span>`;
  }
  const color = seatColor(snap, snap.round.clueSeat);
  return `${pass} · waiting for <b style="color:${color}">${esc(nameOf(snap, snap.round.clueSeat))}</b>…`;
}

export function voteHtml(snap: Snapshot): string {
  const buttons = snap.seats
    .filter((s) => s.index !== snap.you)
    .map(
      (s) =>
        `<button class="vote-row" data-seat="${s.index}" style="--seat:${seatColor(snap, s.index)}"><i class="dot"></i><span class="alias">${esc(nameOf(snap, s.index))}</span></button>`,
    )
    .join('');
  return `<p class="prompt">Who is the imposter?</p>${buttons}`;
}

export function revealHtml(snap: Snapshot): string {
  const r = snap.round;
  if (!r) return '';
  const win = r.result === 'crew' ? 'crew' : 'imposter';
  const headline = r.result === 'crew' ? 'Crew wins' : 'Imposter wins';
  const ejected = r.ejected === null ? 'Nobody was ejected.' : `${esc(nameOf(snap, r.ejected))} was ejected.`;
  const steal = r.stealGuess !== null ? ` Steal guess: “${esc(r.stealGuess)}”.` : '';
  const rows = snap.seats
    .map((s) => {
      const color = seatColor(snap, s.index);
      const who = s.kind === 'bot' ? '<span class="who bot">bot</span>' : `<span class="who">${esc(s.displayName ?? '')}</span>`;
      const imp = s.isImposter ? '<span class="tag-imp">imposter</span>' : '';
      const votedFor = s.vote === null || s.vote === undefined ? '' : `<span class="reveal-votes">voted ${esc(nameOf(snap, s.vote))}</span>`;
      return `<div class="reveal-seat" style="--seat:${color}"><span class="alias">${esc(s.alias ?? '')}</span><span style="display:flex;gap:8px;align-items:center;justify-content:flex-end">${imp}${who}</span>${votedFor}</div>`;
    })
    .join('');
  const scores = snap.seats
    .filter((s) => s.kind === 'human' && s.score !== null && s.score !== undefined)
    .map((s) => `${esc(s.displayName ?? nameOf(snap, s.index))} <b>${s.score}/${snap.seats.length - 1}</b>`)
    .join(' · ');
  const scoreLine = scores ? `<div class="scores">Bot calls — ${scores}</div>` : '';
  return `<div class="reveal-panel"><h3 class="reveal-headline ${win}">${headline}</h3><p class="reveal-sub">${ejected}${steal} The word was <b>${esc(r.word ?? '')}</b>.</p><div class="reveal-list">${rows}</div>${scoreLine}</div>`;
}

export function logHtml(snap: Snapshot): string {
  return snap.transcript
    .map(
      (l) =>
        `<div class="line"><span class="who" style="--seat:${seatColor(snap, l.seat)}">${esc(nameOf(snap, l.seat))}</span>${esc(l.text)}</div>`,
    )
    .join('');
}
