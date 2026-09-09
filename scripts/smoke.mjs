// End-to-end check against a running `npm run dev`. Node 24 provides fetch and WebSocket.
import assert from 'node:assert/strict';

const BASE = process.env.BASE ?? 'http://localhost:8787';
const WS_BASE = BASE.replace(/^http/, 'ws');

const res = await fetch(`${BASE}/rooms`, { method: 'POST' });
const { code } = await res.json();
assert.match(code, /^[A-Z]{4}$/, 'room code is 4 letters');
console.log('room', code);

function client(name, id = crypto.randomUUID()) {
  const ws = new WebSocket(`${WS_BASE}/rooms/${code}/ws`);
  const inbox = [];
  ws.onmessage = (ev) => inbox.push(JSON.parse(ev.data));
  const open = new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`${name}: socket error`));
    setTimeout(() => reject(new Error(`${name}: timed out opening socket`)), 3000);
  });
  const send = (m) => ws.send(JSON.stringify(m));
  const next = async (pred, ms = 3000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return inbox.splice(i, 1)[0];
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`${name}: timed out waiting for a message`);
  };
  return { ws, id, name, open, send, next };
}

const isState = (m) => m.type === 'state';

const a = client('Ada');
const b = client('Bob');
await Promise.all([a.open, b.open]);

a.send({ type: 'join', playerId: a.id, displayName: 'Ada' });
await a.next((m) => isState(m) && m.snapshot.you === 0);

b.send({ type: 'join', playerId: b.id, displayName: 'Bob' });
await b.next((m) => isState(m) && m.snapshot.you === 1);

a.send({ type: 'chat', text: 'hello from ada' });
const seen = await b.next((m) => isState(m) && m.snapshot.transcript.some((l) => l.text === 'hello from ada'));
assert.equal(seen.snapshot.seats[0].displayName, 'Ada', 'lobby shows display names');
assert.equal(seen.snapshot.seats[0].kind, undefined, 'other seat kind hidden');
assert.equal(seen.snapshot.seats[1].kind, 'human', 'own seat kind visible');

a.send({ type: 'start' });
const started = await b.next((m) => isState(m) && m.snapshot.phase === 'chat');
assert.equal(started.snapshot.seats.length, 6, 'six seats after start');
assert.ok(started.snapshot.seats.every((s) => typeof s.alias === 'string'), 'every seat has an alias');
assert.equal(started.snapshot.transcript.length, 0, 'transcript cleared on start');
const others = started.snapshot.seats.filter((s) => s.index !== started.snapshot.you);
assert.ok(others.every((s) => s.displayName === undefined && s.kind === undefined), 'other seats redacted');
assert.ok(!JSON.stringify(started).includes('"playerId"'), 'playerId never serialized');

// Reconnect: Bob drops and comes back with the same playerId.
b.ws.close();
const dropped = await a.next((m) => isState(m) && m.snapshot.seats.some((s) => !s.connected));
assert.equal(dropped.snapshot.seats.filter((s) => !s.connected).length, 1, 'one seat marked disconnected');

const b2 = client('Bob again', b.id);
await b2.open;
b2.send({ type: 'join', playerId: b.id, displayName: 'Bob' });
const back = await b2.next((m) => isState(m) && m.snapshot.you !== null);
assert.equal(back.snapshot.you, started.snapshot.you, 'reconnected to the same seat');
assert.ok(back.snapshot.seats.every((s) => s.connected), 'all seats connected again');

// Late joiner is refused after start.
const late = client('Late');
await late.open;
late.send({ type: 'join', playerId: late.id, displayName: 'Late' });
const refused = await late.next((m) => m.type === 'error');
assert.equal(refused.code, 'room-started');

// Unknown room gets a readable error. Rotate the real code so we can't collide with it.
const ghostCode = [...code].map((c) => String.fromCharCode(65 + ((c.charCodeAt(0) - 65 + 1) % 26))).join('');
const ghost = new WebSocket(`${WS_BASE}/rooms/${ghostCode}/ws`);
const ghostMsg = await new Promise((resolve, reject) => {
  ghost.onmessage = (ev) => resolve(JSON.parse(ev.data));
  ghost.onerror = () => reject(new Error('ghost socket error'));
  setTimeout(() => reject(new Error('ghost: timed out')), 3000);
});
assert.equal(ghostMsg.code, 'room-not-found');

console.log('SMOKE OK');
process.exit(0);
