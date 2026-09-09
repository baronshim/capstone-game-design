import type { ClientMessage, ServerMessage, Snapshot } from '../game/protocol';

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

function showError(message: string): void {
  $('error').textContent = message;
}

function send(msg: ClientMessage): void {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

function connect(code: string): void {
  roomCode = code.trim().toUpperCase();
  if (roomCode.length !== 4) {
    showError('Room codes are 4 letters');
    return;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${proto}://${location.host}/rooms/${roomCode}/ws`);
  socket.onopen = () => send({ type: 'join', playerId: getPlayerId(), displayName: $<HTMLInputElement>('name').value });
  socket.onmessage = (ev) => handle(JSON.parse(ev.data as string) as ServerMessage);
  socket.onclose = () => {
    // Reconnect only if we were ever in the room (not for room-not-found).
    if (snapshot) setTimeout(() => connect(roomCode), 1000);
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
  snapshot = msg.snapshot;
  showError('');
  history.replaceState(null, '', `?room=${roomCode}`);
  render();
}

function nameOf(seat: number): string {
  const s = snapshot?.seats[seat];
  return s?.alias ?? s?.displayName ?? `Seat ${seat + 1}`;
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

function render(): void {
  if (!snapshot) return;
  const snap = snapshot;
  $('home').hidden = true;
  $('room').hidden = false;
  $('room-code').textContent = snap.code;
  $('phase').textContent = snap.phase;
  $('start').hidden = snap.phase !== 'lobby' || snap.you === null;

  $('seats').innerHTML = snap.seats
    .map((s) => {
      const you = s.index === snap.you ? ' (you)' : '';
      return `<div class="seat ${s.connected ? '' : 'off'}">${esc(nameOf(s.index))}${you}</div>`;
    })
    .join('');

  const log = $('log');
  log.innerHTML = snap.transcript
    .map((l) => `<div class="line"><b>${esc(nameOf(l.seat))}</b>${esc(l.text)}</div>`)
    .join('');
  log.scrollTop = log.scrollHeight;
}

$('create').onclick = async () => {
  const res = await fetch('/rooms', { method: 'POST' });
  const { code } = (await res.json()) as { code: string };
  connect(code);
};

$('join').onclick = () => connect($<HTMLInputElement>('code').value);
$('start').onclick = () => send({ type: 'start' });

$<HTMLFormElement>('composer').onsubmit = (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('text');
  send({ type: 'chat', text: input.value });
  input.value = '';
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
