import type { BotCall, ClientMessage, Phase, ServerMessage, Snapshot } from '../game/protocol';
import { botcallHtml, cardHtml, lobbyHint, logHtml, PHASE_LABELS, revealHtml, seatsHtml, turnHtml, verdictHtml, voteHtml } from './views';

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

function showError(message: string): void {
  $('error').textContent = message;
}

function send(msg: ClientMessage): void {
  // Clear any previous error/notice on the next user action, so a rejection
  // (e.g. "one word only") stays visible until then instead of being wiped
  // by the state snapshot that follows it.
  showError('');
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
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
  retries = 0;
  snapshot = msg.snapshot;
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
    lastPhase = ph;
  }

  $('home').hidden = true;
  $('room').hidden = false;
  $('room-code').textContent = snap.code;
  $('phase').textContent = PHASE_LABELS[ph];
  show('notice', snap.autopilot);

  show('card', snap.round !== null && ph !== 'lobby');
  $('card').innerHTML = cardHtml(snap);
  $('seats').innerHTML = seatsHtml(snap);
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

  if (myTurn) $('clue').focus();
  if (ph === 'steal' && imposter) $('steal').focus();
  tick();
}

function tick(): void {
  const end = snapshot?.phaseEndsAt ?? null;
  const timer = $('timer');
  if (end === null) {
    timer.textContent = '';
    timer.className = 'timer';
    return;
  }
  const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
  timer.textContent = `${left}s`;
  timer.className = `timer${left === 0 ? ' out' : left <= 5 ? ' low' : ''}`;
}
setInterval(tick, 250);

$('create').onclick = async () => {
  const res = await fetch('/rooms', { method: 'POST' });
  const { code } = (await res.json()) as { code: string };
  connect(code);
};

$('join').onclick = () => connect($<HTMLInputElement>('code').value);
$('start').onclick = () => send({ type: 'start' });
$('again').onclick = () => send({ type: 'again' });
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

const nameInput = $<HTMLInputElement>('name');
const savedName = localStorage.getItem('name');
if (savedName) nameInput.value = savedName;
nameInput.addEventListener('change', () => localStorage.setItem('name', nameInput.value));

$<HTMLInputElement>('code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') connect($<HTMLInputElement>('code').value);
});

const roomParam = new URLSearchParams(location.search).get('room');
if (roomParam) {
  $<HTMLInputElement>('code').value = roomParam;
  // Refresh or shared link with a saved name: rejoin the same seat automatically.
  if (savedName) connect(roomParam);
}
