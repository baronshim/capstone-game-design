// End-to-end check against a running `npm run dev` (fake bots), or `npm run dev:live`
// with LIVE=1 (Workers AI bots, slower, must not be canned). Node 22 or newer provides fetch and WebSocket.
import assert from 'node:assert/strict';

const BASE = process.env.BASE ?? 'http://localhost:8787';
const LIVE = process.env.LIVE === '1';
const WS_BASE = BASE.replace(/^http/, 'ws');
/** Fake bots answer within milliseconds; a live bot takes up to 6s of jitter plus the model call. */
const TURN_MS = LIVE ? 20_000 : 3000;

// Mirrors FAKE_CLUES and FALLBACK_CLUES in src/worker/backends; a live round must produce something else.
const CANNED = new Set([
  'apple', 'brick', 'cloud', 'drum', 'ember', 'flute', 'grape', 'hinge', 'ivory', 'jelly', 'kite', 'lemon',
  'fur', 'wild', 'zoo', 'tail', 'paws', 'creature', 'legs', 'nature',
  'tasty', 'dinner', 'snack', 'yummy', 'plate', 'kitchen', 'hungry', 'bite',
  'visit', 'trip', 'crowd', 'building', 'walk', 'ticket', 'map', 'far',
  'handy', 'tool', 'shelf', 'grab', 'useful', 'thing', 'daily', 'hold',
  'work', 'uniform', 'career', 'shift', 'skill', 'training', 'boss', 'salary',
  'team', 'score', 'sweat', 'match', 'fans', 'practice', 'coach', 'win',
]);

const res = await fetch(`${BASE}/rooms`, { method: 'POST' });
assert.equal(res.status, 200, `POST /rooms answered ${res.status}`);
const { code } = await res.json();
assert.match(code, /^[A-Z]{4}$/, 'room code is 4 letters');
console.log('room', code, LIVE ? '(live bots)' : '(fake bots)');

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
  const next = async (pred, ms = TURN_MS) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return inbox.splice(0, i + 1)[i];
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`${name}: timed out waiting for a message; inbox=${JSON.stringify(inbox).slice(0, 2000)}`);
  };
  const state = async (pred = () => true, ms) => (await next((m) => m.type === 'state' && pred(m.snapshot), ms)).snapshot;
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
assert.equal(seen.autopilot, false, 'snapshot carries the autopilot flag');

a.send({ type: 'start' });
let snapA = await a.state((s) => s.phase === 'clue');
const snapB = await b.state((s) => s.phase === 'clue');
assert.equal(snapA.seats.length, 6, 'six seats after start');
assert.ok(snapA.seats.every((s) => typeof s.alias === 'string'), 'every seat has an alias');
assert.ok(snapA.seats.every((s) => s.connected), 'bots count as connected');
assert.equal(snapA.transcript.length, 0, 'transcript cleared on start');
assert.equal(typeof snapA.phaseEndsAt, 'number', 'clue phase is timed');
const others = snapA.seats.filter((s) => s.index !== snapA.you);
assert.ok(others.every((s) => s.displayName === undefined && s.kind === undefined && s.isImposter === undefined), 'other seats redacted');
assert.ok(!JSON.stringify(snapA).includes('"playerId"'), 'playerId never serialized');

// The imposter may be either human or one of the four bots.
const humanSnaps = [snapA, snapB];
const impSnap = humanSnaps.find((s) => s.seats[s.you].isImposter);
const crewSnap = humanSnaps.find((s) => !s.seats[s.you].isImposter);
assert.ok(crewSnap, 'at most one of the two humans is the imposter');
assert.equal(typeof crewSnap.round.word, 'string', 'crew sees the word');
if (impSnap) {
  assert.equal(impSnap.round.word, null, 'imposter does not see the word');
  assert.equal(impSnap.round.category, crewSnap.round.category, 'both see the category');
  assert.ok(!JSON.stringify(impSnap).toLowerCase().includes(crewSnap.round.word), 'word absent from the imposter snapshot');
}
console.log('imposter is', impSnap ? 'human' : 'a bot');

// Clue loop: humans clue on their turns, bots clue by themselves.
const CLUE_WORDS = ['alpha', 'bravo', 'charlie', 'delta'];
let n = 0;
let rejectedOnce = false;
while (snapA.phase === 'clue') {
  const turn = snapA.round.clueSeat;
  const mine = turn === snapA.you ? a : turn === snapB.you ? b : null;
  if (mine) {
    if (!rejectedOnce) {
      mine.send({ type: 'clue', word: 'two words' });
      assert.equal(await mine.error(), 'clue-one-word', 'multi-word clue rejected');
      rejectedOnce = true;
    }
    assert.ok(n < CLUE_WORDS.length, 'a rejected clue would loop forever');
    mine.send({ type: 'clue', word: CLUE_WORDS[n++] });
  }
  snapA = await a.state((s) => s.phase !== 'clue' || s.round.clueSeat !== turn);
}
assert.equal(n, 4, 'two humans, two passes');
assert.equal(snapA.phase, 'chat', 'chat opens after the clues');
assert.equal(snapA.round.clueSeat, null);
assert.ok(snapA.seats.every((s) => s.clues.length === 2), 'every seat has two clue entries');
const botClues = snapA.seats.filter((s) => s.index !== snapA.you && s.index !== snapB.you).flatMap((s) => s.clues);
assert.equal(botClues.length, 8, 'four bots, two clues each');
if (LIVE) {
  assert.ok(botClues.some((c) => c !== '' && !CANNED.has(c.toLowerCase())), `live bots must produce a clue outside the canned lists; got ${botClues.join(', ')}`);
} else {
  assert.ok(botClues.every((c) => CANNED.has(c)), `fake bots clue from FAKE_CLUES; got ${botClues.join(', ')}`);
}
console.log('bot clues:', botClues.join(', '));

// Bots chat: fake bots say "beep" once each right away; live bots say something else within the phase.
if (LIVE) {
  const chatted = await a.state((s) => s.transcript.some((l) => l.seat !== snapA.you && l.seat !== snapB.you && l.text !== 'beep'), 95_000);
  console.log('a bot said:', chatted.transcript.find((l) => l.seat !== snapA.you && l.seat !== snapB.you).text);
} else {
  await a.state((s) => new Set(s.transcript.filter((l) => l.text === 'beep').map((l) => l.seat)).size === 4);
}

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

console.log(`SMOKE OK (${LIVE ? 'live' : 'fake'} bots through the chat phase; vote, steal, bot call, and reveal are covered by test/worker/round.test.ts)`);
process.exit(0);
