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
  deal: 'deal',
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
    return `<span class="pass">${pass}</span>Your turn: type one word that hints at the word`;
  }
  const color = seatColor(snap, snap.round.clueSeat);
  return `${pass} · waiting for <b style="color:${color}">${esc(nameOf(snap, snap.round.clueSeat))}</b>…`;
}

/** Lobby copy that counts the seats, so the host knows how many bots will fill in. */
export function lobbyHint(snap: Snapshot): string {
  const humans = snap.seats.length;
  const bots = 6 - humans;
  const fill = bots === 0 ? 'The room is full.' : `${bots === 1 ? 'The empty seat' : `The ${bots} empty seats`} will be AI players trying to pass as human.`;
  return `${humans} of 6 seats taken. ${fill} Share the code or the link to bring friends in, then start when everyone is here.`;
}

/** Who the vote ejected, shown through the steal and the bot call before the full reveal. */
export function verdictHtml(snap: Snapshot): string {
  const r = snap.round;
  if (!r || (snap.phase !== 'steal' && snap.phase !== 'botcall')) return '';
  if (r.ejected === null) return 'No majority. Nobody was ejected.';
  const color = seatColor(snap, r.ejected);
  const who = `<b style="color:${color}">${esc(nameOf(snap, r.ejected))}</b>`;
  return snap.phase === 'steal' ? `${who} was ejected and is the imposter.` : `${who} was ejected.`;
}

/** One row per other seat; `myVote` is the viewer's current pick, changeable until the phase ends. */
export function voteHtml(snap: Snapshot, myVote: number | null): string {
  const buttons = snap.seats
    .filter((s) => s.index !== snap.you)
    .map((s) => {
      const on = s.index === myVote;
      return `<button class="vote-row${on ? ' on' : ''}" data-seat="${s.index}" style="--seat:${seatColor(snap, s.index)}"><i class="dot"></i><span class="alias">${esc(nameOf(snap, s.index))}</span>${on ? '<span class="picked">your vote</span>' : ''}</button>`;
    })
    .join('');
  const sub = myVote === null ? 'Tap a seat. You can change your mind until the timer ends.' : 'Vote in. Tap another seat to change it.';
  return `<p class="prompt">Who is the imposter?</p><p class="prompt-sub">${sub}</p>${buttons}`;
}

export function revealHtml(snap: Snapshot): string {
  const r = snap.round;
  if (!r) return '';
  const win = r.result === 'crew' ? 'crew' : 'imposter';
  const headline = r.result === 'crew' ? 'Crew wins the round' : 'Imposter wins the round';
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
  return `<div class="reveal-panel">${winnerHtml(snap)}<h3 class="reveal-headline ${win}">${headline}</h3><p class="reveal-sub">${ejected}${steal} The word was <b>${esc(r.word ?? '')}</b>.</p>${scoreboardHtml(snap)}<div class="reveal-list">${rows}</div></div>`;
}

/** The round's winner or winners, by call sign, with the player's name for a human. */
function winnerHtml(snap: Snapshot): string {
  const winners = snap.round?.winners ?? [];
  if (winners.length === 0) return '';
  const top = snap.seats[winners[0]]?.score ?? 0;
  const names = winners
    .map((i) => {
      const s = snap.seats[i];
      const human = s.kind === 'human' && s.displayName ? ` (${esc(s.displayName)})` : s.kind === 'bot' ? ' (bot)' : '';
      return `<b style="color:${seatColor(snap, i)}">${esc(nameOf(snap, i))}</b>${human}`;
    })
    .join(', ');
  const label = winners.length > 1 ? 'Tied for the win' : 'Winner';
  return `<div class="winner"><span class="winner-label">${label}</span><span class="winner-names">${names}</span><span class="winner-pts">${top} pt${top === 1 ? '' : 's'}</span></div>`;
}

/** Every seat's round points, highest first, with how they were earned; running totals once a room has played more than one round. */
function scoreboardHtml(snap: Snapshot): string {
  const seats = snap.seats.filter((s) => s.score !== undefined && s.points !== undefined);
  if (seats.length === 0) return '';
  const showTotals = seats.some((s) => s.total !== s.score);
  const rows = [...seats]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.index - b.index)
    .map((s) => {
      const p = s.points!;
      const parts = [
        p.imposter ? `<span class="pt imp">${p.imposter} ${s.isImposter && snap.round?.ejected !== s.index ? 'survived' : 'stole'}</span>` : '',
        p.vote ? `<span class="pt vote">${p.vote} caught it</span>` : '',
        p.calls ? `<span class="pt calls">${p.calls} bot call${p.calls === 1 ? '' : 's'}</span>` : '',
      ].join('');
      const total = showTotals && s.kind === 'human' ? `<span class="running">total ${s.total}</span>` : '';
      return `<div class="score-row" style="--seat:${seatColor(snap, s.index)}"><i class="dot"></i><span class="alias">${esc(nameOf(snap, s.index))}</span><span class="pts">${parts || '<span class="pt none">0</span>'}</span><b class="score">${s.score}</b>${total}</div>`;
    })
    .join('');
  return `<div class="scoreboard">${rows}</div>`;
}

export function logHtml(snap: Snapshot): string {
  return snap.transcript
    .map(
      (l) =>
        `<div class="line"><span class="who" style="--seat:${seatColor(snap, l.seat)}">${esc(nameOf(snap, l.seat))}</span>${esc(l.text)}</div>`,
    )
    .join('');
}
