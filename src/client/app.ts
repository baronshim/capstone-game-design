import type { BotCall, ClientMessage, Phase, ServerMessage, Snapshot } from '../game/protocol';
import { DURATIONS } from '../game/rules';
import { chime, ding, isMuted, setMuted, tap, tickSound, unlock } from './sound';
import { BANNERS, botcallHtml, cardHtml, dealHtml, lobbyHint, logHtml, PHASE_LABELS, revealHtml, seatsHtml, turnHtml, typingHtml, verdictHtml, voteHtml } from './views';

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function getPlayerId(): string {
  let id = localStorage.getItem('playerId');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('playerId', id);
  }
  return id;
}

let socket: WebSocket | null = null;
let snapshot: Snapshot | null = null;
let roomCode = '';
let retries = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
/** The viewer's own clue count as of the last render, to detect a new turn reusing the same box. */
let lastClueCount = 0;
/** The viewer's unsent Human/Bot picks during the bot call, reset whenever the phase changes. */
let pendingCalls: BotCall[] = [];
/** The seat the viewer last voted for this phase, so the pick stays highlighted. */
let myVote: number | null = null;
let lastPhase: Phase | null = null;
/** Seats seen typing, each mapped to the time its indicator should come down. */
const typing = new Map<number, number>();
/** Transcript lines per seat as of the last snapshot: a seat that just posted is no longer typing. */
const lastLineBySeat = new Map<number, number>();
/** The last typing ping this client sent, so it pings no faster than the room relays. */
let lastPing = 0;
const TYPING_PING_MS = 1500;
/** Whether the clue turn was the viewer's at the last render, so the nudge fires once per turn. */
let lastTurnMine = false;
/** Transcript length at the last render, to sound a tap only on lines that are new. */
let lastLineCount = 0;
/** The last whole second a tick sounded, so each of the final five seconds ticks once. */
let lastTickSecond = -1;
/** Timer that takes the transition banner back down. */
let bannerTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Shows the transition banner for a couple of seconds. `mine` paints it as the viewer's own cue;
 * `belowCard` drops it under the word card, for the deal, whose whole point is reading that card.
 */
function banner(title: string, sub: string, mine = false, belowCard = false): void {
  const el = $('banner');
  $('banner-title').textContent = title;
  $('banner-sub').textContent = sub;
  el.classList.toggle('mine', mine);
  el.classList.toggle('below', belowCard);
  el.classList.add('show');
  if (bannerTimer !== null) clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function showError(message: string): void {
  $('error').textContent = message;
}

function sendRaw(msg: ClientMessage): void {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

function send(msg: ClientMessage): void {
  // Clear any previous error/notice on the next user action, so a rejection
  // (e.g. "one word only") stays visible until then instead of being wiped
  // by the state snapshot that follows it.
  showError('');
  sendRaw(msg);
}

/** Tells the room this seat is writing, no more often than the room would relay it. */
function pingTyping(value: string): void {
  const now = Date.now();
  if (value.trim() === '' || now - lastPing < TYPING_PING_MS) return;
  lastPing = now;
  sendRaw({ type: 'typing' });
}

/** Drops typing indicators whose window has passed. Returns true when one came down. */
function pruneTyping(): boolean {
  const now = Date.now();
  let changed = false;
  for (const [seat, until] of typing) {
    if (until <= now) {
      typing.delete(seat);
      changed = true;
    }
  }
  return changed;
}

function connect(code: string): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  roomCode = code.trim().toUpperCase();
  if (roomCode.length !== 4) {
    showError('Room codes are 4 letters');
    return;
  }
  if (socket) {
    socket.onclose = null;
    socket.close();
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/rooms/${roomCode}/ws`);
  socket.onopen = () => send({ type: 'join', playerId: getPlayerId(), displayName: $<HTMLInputElement>('name').value });
  socket.onmessage = (ev) => handle(JSON.parse(ev.data as string) as ServerMessage);
  socket.onclose = () => {
    // Reconnect only if we were ever in the room (not for room-not-found), backing off up to 10s.
    if (!snapshot) return;
    const delay = Math.min(10_000, 1000 * 2 ** retries);
    retries++;
    showError(`Connection lost. Reconnecting in ${Math.round(delay / 1000)}s…`);
    reconnectTimer = setTimeout(() => connect(roomCode), delay);
  };
}

/** Back to the home screen: drop the socket, forget the room, and clear the room from the URL. */
function leave(): void {
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }
  snapshot = null;
  lastPhase = null;
  lastTurnMine = false;
  lastLineCount = 0;
  if (bannerTimer !== null) {
    clearTimeout(bannerTimer);
    bannerTimer = null;
  }
  $('banner').classList.remove('show');
  typing.clear();
  lastLineBySeat.clear();
  roomCode = '';
  showError('');
  history.replaceState(null, '', location.pathname);
  $('room').hidden = true;
  $('home').hidden = false;
}

function handle(msg: ServerMessage): void {
  if (msg.type === 'error') {
    showError(msg.message);
    if (msg.code === 'room-not-found') {
      snapshot = null;
      socket?.close();
    }
    return;
  }
  if (msg.type === 'typing') {
    typing.set(msg.seat, Date.now() + msg.ms);
    render();
    return;
  }
  retries = 0;
  snapshot = msg.snapshot;
  // A seat that just posted has stopped typing, whatever its window said.
  for (const seat of msg.snapshot.seats) {
    const lines = msg.snapshot.transcript.filter((l) => l.seat === seat.index).length;
    if (lines > (lastLineBySeat.get(seat.index) ?? 0)) typing.delete(seat.index);
    lastLineBySeat.set(seat.index, lines);
  }
  history.replaceState(null, '', `?room=${roomCode}`);
  render();
}

function show(id: string, on: boolean): void {
  $(id).hidden = !on;
}

function render(): void {
  if (!snapshot) return;
  const snap = snapshot;
  const ph = snap.phase;
  const seated = snap.you !== null;
  const myTurn = ph === 'clue' && snap.round?.clueSeat === snap.you;
  const imposter = seated && snap.seats[snap.you as number].isImposter === true;
  const chatOpen = ph === 'lobby' || ph === 'chat' || ph === 'reveal';

  if (ph !== lastPhase) {
    pendingCalls = snap.seats.map(() => null);
    myVote = null;
    typing.clear();
    // Not on the first snapshot after joining: that one is the room as found, not a transition.
    if (lastPhase !== null) {
      banner(BANNERS[ph].title, BANNERS[ph].sub, false, ph === 'deal');
      chime();
    }
    lastTurnMine = false;
    lastLineCount = 0;
    lastPhase = ph;
  }
  if (myTurn && !lastTurnMine) {
    banner('Your turn', `Round ${snap.round!.cluePass} of 2 · one word`, true);
    ding();
  }
  lastTurnMine = myTurn;
  // A tap for lines somebody else just posted, never for the transcript as first loaded.
  const lines = snap.transcript.length;
  if (lines > lastLineCount && lastLineCount > 0 && ph === 'chat') {
    const last = snap.transcript[lines - 1];
    if (last.seat !== snap.you) tap();
  }
  lastLineCount = lines;
  const typingNow = new Set([...typing].filter(([, until]) => until > Date.now()).map(([seat]) => seat));

  $('home').hidden = true;
  $('room').hidden = false;
  $('room-code').textContent = snap.code;
  $('phase').textContent = PHASE_LABELS[ph];
  show('notice', snap.autopilot);

  show('card', snap.round !== null && ph !== 'lobby');
  $('card').innerHTML = cardHtml(snap);
  show('deal', ph === 'deal');
  $('deal').innerHTML = dealHtml(snap);
  $('seats').innerHTML = seatsHtml(snap, typingNow);
  $('seats').classList.toggle('compact', ph === 'chat');
  show('start', ph === 'lobby' && seated);
  show('lobby-hint', ph === 'lobby' && seated);
  show('lobby-tools', ph === 'lobby' && seated);
  $('lobby-hint').textContent = lobbyHint(snap);
  show('turn', ph === 'clue');
  $('turn').innerHTML = turnHtml(snap);
  $('turn').classList.toggle('mine', myTurn);
  show('verdict', ph === 'steal' || ph === 'botcall');
  $('verdict').innerHTML = verdictHtml(snap);
  show('clue-form', myTurn);
  // Clear the box on a fresh turn: either it left this seat, or it came back to
  // this seat with a new clue recorded since the last render (one human with
  // five bots wraps pass 1 straight back to the same human).
  const myClueCount = seated ? snap.seats[snap.you as number].clues.length : 0;
  if (!myTurn || myClueCount > lastClueCount) $<HTMLInputElement>('clue').value = '';
  lastClueCount = myClueCount;
  show('vote', ph === 'vote');
  $('vote').innerHTML = voteHtml(snap, myVote);
  show('steal-form', ph === 'steal' && imposter);
  show('steal-wait', ph === 'steal' && !imposter);
  show('botcall', ph === 'botcall' && seated);
  $('botcall').innerHTML = ph === 'botcall' ? botcallHtml(snap, pendingCalls) : '';
  show('lock-calls', ph === 'botcall' && seated && snap.seats[snap.you as number].botCalls === null);
  show('reveal', ph === 'reveal');
  $('reveal').innerHTML = revealHtml(snap);
  show('again', ph === 'reveal' && seated);
  // The transcript stays readable while deciding: the vote, the steal, and the bot call all turn on what was said.
  const logVisible = chatOpen || ph === 'vote' || ph === 'steal' || ph === 'botcall';
  show('log', logVisible);
  show('log-label', logVisible && !chatOpen);
  show('composer', chatOpen);
  const log = $('log');
  log.classList.toggle('readonly', !chatOpen);
  log.innerHTML = logHtml(snap);
  log.scrollTop = log.scrollHeight;
  $('typing').innerHTML = typingHtml(snap, typingNow);
  show('typing', logVisible);

  if (myTurn) $('clue').focus();
  if (ph === 'steal' && imposter) $('steal').focus();
  tick();
}

function tick(): void {
  // render() calls tick() again, but the expired entries are gone by then, so this settles after one pass.
  if (pruneTyping()) render();
  const end = snapshot?.phaseEndsAt ?? null;
  const timer = $('timer');
  const bar = $('progress');
  if (end === null) {
    timer.textContent = '';
    timer.className = 'timer';
    bar.style.width = '0';
    bar.className = '';
    return;
  }
  const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
  timer.textContent = `${left}s`;
  timer.className = `timer${left === 0 ? ' out' : left <= 5 ? ' low' : ''}`;
  // The bar drains over the phase's full length; `clue` is timed per turn.
  const key = snapshot!.phase === 'clue' ? 'clueTurn' : snapshot!.phase;
  const total = (DURATIONS as Record<string, number>)[key] ?? 0;
  const remaining = Math.max(0, end - Date.now());
  bar.style.width = total ? `${(100 * remaining) / total}%` : '0';
  bar.className = left === 0 ? 'out' : left <= 5 ? 'low' : '';
  if (left <= 5 && left > 0 && left !== lastTickSecond) tickSound();
  lastTickSecond = left;
}
setInterval(tick, 250);

$('create').onclick = async () => {
  unlock();
  const res = await fetch('/rooms', { method: 'POST' });
  const { code } = (await res.json()) as { code: string };
  connect(code);
};

$('join').onclick = () => {
  unlock();
  connect($<HTMLInputElement>('code').value);
};
// A player who rejoined from a shared link never clicked Create or Join, so this is their first gesture.
$('start').onclick = () => {
  unlock();
  send({ type: 'start' });
};
$('again').onclick = () => {
  unlock();
  send({ type: 'again' });
};
$('leave').onclick = leave;

const help = $<HTMLDialogElement>('help');
for (const id of ['help-home', 'help-room', 'help-lobby']) {
  $(id).onclick = () => {
    help.showModal();
    // showModal focuses the first control, which is the close button at the bottom; start at the top instead.
    help.scrollTop = 0;
  };
}

$('copy-link').onclick = async () => {
  const url = `${location.origin}${location.pathname}?room=${roomCode}`;
  const button = $('copy-link');
  try {
    await navigator.clipboard.writeText(url);
    button.textContent = 'Link copied';
  } catch {
    button.textContent = url;
  }
  setTimeout(() => (button.textContent = 'Copy invite link'), 2500);
};

for (const id of ['text', 'clue']) {
  $<HTMLInputElement>(id).addEventListener('input', (e) => pingTyping((e.target as HTMLInputElement).value));
}

$<HTMLFormElement>('composer').onsubmit = (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('text');
  send({ type: 'chat', text: input.value });
  input.value = '';
};

$<HTMLFormElement>('clue-form').onsubmit = (e) => {
  e.preventDefault();
  // Keep the text so a rejected clue can be edited; render() clears it when the turn passes.
  send({ type: 'clue', word: $<HTMLInputElement>('clue').value });
};

$<HTMLFormElement>('steal-form').onsubmit = (e) => {
  e.preventDefault();
  send({ type: 'steal', word: $<HTMLInputElement>('steal').value });
};

$('vote').onclick = (e) => {
  const button = (e.target as HTMLElement).closest('button');
  if (button?.dataset.seat === undefined) return;
  myVote = Number(button.dataset.seat);
  send({ type: 'vote', seat: myVote });
  render();
};

$('botcall').onclick = (e) => {
  const button = (e.target as HTMLElement).closest('button');
  if (!button || button.disabled || button.dataset.seat === undefined) return;
  pendingCalls[Number(button.dataset.seat)] = button.dataset.call === 'human' ? 'human' : 'bot';
  render();
};

$('lock-calls').onclick = () => send({ type: 'botcall', calls: pendingCalls });

const mute = $('mute');
function paintMute(): void {
  mute.classList.toggle('off', isMuted());
  mute.title = isMuted() ? 'Sound off' : 'Sound on';
}
mute.onclick = () => {
  setMuted(!isMuted());
  unlock();
  paintMute();
};
paintMute();

const nameInput = $<HTMLInputElement>('name');
const savedName = localStorage.getItem('name');
if (savedName) nameInput.value = savedName;
nameInput.addEventListener('change', () => localStorage.setItem('name', nameInput.value));

$<HTMLInputElement>('code').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  unlock();
  connect($<HTMLInputElement>('code').value);
});

const roomParam = new URLSearchParams(location.search).get('room');
if (roomParam) {
  $<HTMLInputElement>('code').value = roomParam;
  // Refresh or shared link with a saved name: rejoin the same seat automatically.
  if (savedName) connect(roomParam);
}
