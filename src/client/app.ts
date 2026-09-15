import type { ClientMessage, ServerMessage, Snapshot } from '../game/protocol';
import { cardHtml, logHtml, revealHtml, seatsHtml, turnHtml, voteHtml } from './views';

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
    setTimeout(() => connect(roomCode), delay);
  };
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

  $('home').hidden = true;
  $('room').hidden = false;
  $('room-code').textContent = snap.code;
  $('phase').textContent = ph;

  show('card', snap.round !== null && ph !== 'lobby');
  $('card').innerHTML = cardHtml(snap);
  $('seats').innerHTML = seatsHtml(snap);
  show('start', ph === 'lobby' && seated);
  show('turn', ph === 'clue');
  $('turn').innerHTML = turnHtml(snap);
  show('clue-form', myTurn);
  if (!myTurn) $<HTMLInputElement>('clue').value = '';
  show('vote', ph === 'vote');
  $('vote').innerHTML = voteHtml(snap);
  show('steal-form', ph === 'steal' && imposter);
  show('steal-wait', ph === 'steal' && !imposter);
  show('reveal', ph === 'reveal');
  $('reveal').innerHTML = revealHtml(snap);
  show('again', ph === 'reveal' && seated);
  show('log', chatOpen);
  show('composer', chatOpen);
  const log = $('log');
  log.innerHTML = logHtml(snap);
  log.scrollTop = log.scrollHeight;

  if (myTurn) $('clue').focus();
  if (ph === 'steal' && imposter) $('steal').focus();
  tick();
}

function tick(): void {
  const end = snapshot?.phaseEndsAt ?? null;
  $('timer').textContent = end === null ? '' : `${Math.max(0, Math.ceil((end - Date.now()) / 1000))}s`;
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
  if (button?.dataset.seat !== undefined) send({ type: 'vote', seat: Number(button.dataset.seat) });
};

const nameInput = $<HTMLInputElement>('name');
const savedName = localStorage.getItem('name');
if (savedName) nameInput.value = savedName;
nameInput.addEventListener('change', () => localStorage.setItem('name', nameInput.value));

const roomParam = new URLSearchParams(location.search).get('room');
if (roomParam) {
  $<HTMLInputElement>('code').value = roomParam;
  // Refresh or shared link with a saved name: rejoin the same seat automatically.
  if (savedName) connect(roomParam);
}
