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
  ws.onmessage = (ev) => {
    inbox.push(JSON.parse(ev.data));
  };
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
      if (i >= 0) return inbox.splice(0, i + 1)[i];
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`${name}: timed out waiting for a message; inbox=${JSON.stringify(inbox)}`);
  };
  const state = async (pred = () => true) => (await next((m) => m.type === 'state' && pred(m.snapshot))).snapshot;
  const error = async () => (await next((m) => m.type === 'error')).code;
  return { ws, id, name, open, send, next, state, error };
}

const a = client('Ada');
const b = client('Bob');
await Promise.all([a.open, b.open]);

a.send({ type: 'join', playerId: a.id, displayName: 'Ada' });
await a.state((s) => s.you === 0);
b.send({ type: 'join', playerId: b.id, displayName: 'Bob' });
await b.state((s) => s.you === 1);

a.send({ type: 'chat', text: 'hello from ada' });
const seen = await b.state((s) => s.transcript.some((l) => l.text === 'hello from ada'));
assert.equal(seen.seats[0].displayName, 'Ada', 'lobby shows display names');
assert.equal(seen.seats[0].kind, undefined, 'other seat kind hidden');
assert.equal(seen.seats[1].kind, 'human', 'own seat kind visible');

a.send({ type: 'start' });
let snapA = await a.state((s) => s.phase === 'clue');
const snapB = await b.state((s) => s.phase === 'clue');
assert.equal(snapA.seats.length, 6, 'six seats after start');
assert.ok(snapA.seats.every((s) => typeof s.alias === 'string'), 'every seat has an alias');
assert.equal(snapA.transcript.length, 0, 'transcript cleared on start');
assert.equal(typeof snapA.phaseEndsAt, 'number', 'clue phase is timed');
const others = snapA.seats.filter((s) => s.index !== snapA.you);
assert.ok(others.every((s) => s.displayName === undefined && s.kind === undefined && s.isImposter === undefined), 'other seats redacted');
assert.ok(!JSON.stringify(snapA).includes('"playerId"'), 'playerId never serialized');

const aIsImposter = snapA.seats[snapA.you].isImposter;
const bIsImposter = snapB.seats[snapB.you].isImposter;
assert.ok(aIsImposter !== bIsImposter, 'exactly one of the two humans is the imposter');
const imposter = aIsImposter ? snapA : snapB;
const crew = aIsImposter ? snapB : snapA;
assert.equal(imposter.round.word, null, 'imposter does not see the word');
assert.equal(typeof crew.round.word, 'string', 'crew sees the word');
assert.equal(imposter.round.category, crew.round.category, 'both see the category');
assert.ok(!JSON.stringify(imposter).toLowerCase().includes(crew.round.word), 'word absent from the imposter snapshot');

// Bots pass instantly, so the first turn is a human's.
assert.ok([snapA.you, snapB.you].includes(snapA.round.clueSeat), 'first clue turn belongs to a human');
const whose = () => (snapA.round.clueSeat === snapA.you ? a : b);
whose().send({ type: 'clue', word: 'two words' });
assert.equal(await whose().error(), 'clue-one-word', 'multi-word clue rejected');

// Distinct words: `clue0`/`clue1` would all normalize to `clue` and be rejected as duplicates.
const CLUE_WORDS = ['alpha', 'bravo', 'charlie', 'delta'];
let n = 0;
while (snapA.phase === 'clue') {
  const turn = snapA.round.clueSeat;
  assert.ok(n < CLUE_WORDS.length, 'a rejected clue would loop forever');
  whose().send({ type: 'clue', word: CLUE_WORDS[n++] });
  snapA = await a.state((s) => s.phase !== 'clue' || s.round.clueSeat !== turn);
}
assert.equal(n, 4, 'two humans, two passes');
assert.equal(snapA.phase, 'chat', 'chat opens after the clues');
assert.equal(snapA.round.clueSeat, null);
assert.equal(snapA.seats.flatMap((s) => s.clues).filter(Boolean).length, 4, 'four real clues recorded');
assert.ok(snapA.seats.every((s) => s.clues.length === 2), 'every seat has two clue entries');

// Reconnect: Bob drops and comes back with the same playerId.
b.ws.close();
const dropped = await a.state((s) => s.seats.some((s2) => !s2.connected));
assert.equal(dropped.seats.filter((s) => !s.connected).length, 1, 'one seat marked disconnected');

const b2 = client('Bob again', b.id);
await b2.open;
b2.send({ type: 'join', playerId: b.id, displayName: 'Bob' });
const back = await b2.state((s) => s.you !== null);
assert.equal(back.you, snapB.you, 'reconnected to the same seat');
assert.equal(back.phase, 'chat', 'reconnect lands in the current phase');
assert.ok(back.seats.every((s) => s.connected), 'all seats connected again');

// Late joiner is refused after start.
const late = client('Late');
await late.open;
late.send({ type: 'join', playerId: late.id, displayName: 'Late' });
assert.equal(await late.error(), 'room-started');

// Unknown room gets a readable error. Rotate the real code so we can't collide with it.
const ghostCode = [...code].map((c) => String.fromCharCode(65 + ((c.charCodeAt(0) - 65 + 1) % 26))).join('');
const ghost = new WebSocket(`${WS_BASE}/rooms/${ghostCode}/ws`);
const ghostMsg = await new Promise((resolve, reject) => {
  ghost.onmessage = (ev) => resolve(JSON.parse(ev.data));
  ghost.onerror = () => reject(new Error('ghost socket error'));
  setTimeout(() => reject(new Error('ghost: timed out')), 3000);
});
assert.equal(ghostMsg.code, 'room-not-found');

console.log('SMOKE OK (through the clue phase; vote, steal, and reveal are covered by test/worker/round.test.ts)');
process.exit(0);
