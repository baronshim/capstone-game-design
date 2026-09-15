# Milestone 2: Imposter Round Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A playable round on top of the M1 chat room: a secret word and category, one imposter who only sees the category, two timed passes of one-word clues, a timed open-chat phase, a majority vote, a steal guess for an ejected imposter, and a reveal that names everyone, followed by Play Again.

**Architecture:** All rules live in the pure reducer in `src/game` (`apply(state, event) -> { state, effects }`). Randomness enters as a `seed` on the `start` event (the Room DO generates it), so `apply` no longer takes an `rng` argument. Timed phases store `phaseEndsAt` on the state; after every event the Room Durable Object syncs its single alarm to that deadline (or to the empty-room TTL when the room is idle) and the alarm handler feeds a `timeout` event back into the reducer. `redact` grows to hide the word from the imposter and every identity field from other seats until the reveal, when the same snapshot exposes everything (no separate `reveal` message). The client stays one page whose sections show or hide per phase, with a countdown driven by `phaseEndsAt`.

**Tech Stack:** TypeScript 5, Cloudflare Workers + Durable Objects (SQLite-backed), wrangler 4, esbuild, **vitest 4.1 with `@cloudflare/vitest-pool-workers` 0.22** (all tests run inside workerd, including the Durable Object), Node 24 for the smoke script.

**Spec:** `docs/superpowers/specs/2026-09-04-imposter-turing-design.md` (sections 2.1 to 2.4, 3, 4, 6, 7, 8 milestone 2). Read the spec before starting a task.

## Global Constraints

- Exactly 6 seats (`SEAT_COUNT = 6`); minimum 1 human to start; bots fill empty seats.
- Phase durations from spec 2.3: clue turn 20s, interrogation chat 90s, vote 20s, steal 15s. Reveal and lobby are untimed. Every timed phase has a visible countdown on the client.
- Clue rules from spec 2.3: one word per turn, two passes in seat order, forbidden: the secret word (case-insensitive, plural and simple stem match) and any clue already given this round. A rejected clue returns an error and the timer continues. A timeout records `''`, displayed as "(no clue)".
- Vote rules from spec 2.3 and 2.4: every seat votes for one other seat; strictly more than half of the votes cast ejects; ties and abstentions eject nobody. Crew wins only if the imposter is ejected and fails the steal. Steal succeeds on exact match, case-insensitive, trimmed.
- `redact` is the only path from room state to a client. Before the reveal it never emits another seat's `playerId`, `kind`, `isImposter`, `displayName`, or `vote`, and never emits the word to the imposter.
- `src/game` has no I/O, timers, or network. All randomness comes from `seededRng(event.seed)`.
- Room deletes itself after 10 minutes with no connected sockets and no timed phase running.
- **M2 simplifications, agreed 2026-09-11 (revisit in M3):** the imposter is chosen among *human* seats only (a bot imposter cannot be caught while bots are inert); bot seats pass their clue turn instantly with `''`, never vote, and never steal; the interrogation phase is open chat only (menu questions are M4).
- Every commit message ends with these two lines:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01MrLZUUQrsJ4cV7L4ApiNU9
  ```
- Commit subjects are plain imperative sentences without a `feat:` prefix, matching M1 history.

## File Structure

| File | Responsibility |
|---|---|
| `.npmrc` (new) | `legacy-peer-deps=true`. npm 11's resolver crashes on the pool's peer set without it (verified 2026-09-11). |
| `vitest.config.ts` (new) | Registers the Workers pool plugin so every test runs in workerd against `wrangler.jsonc`. |
| `test/env.d.ts` (new) | Types `env` from `cloudflare:test` as our `Env`. |
| `test/worker/helpers.ts` (new) | `createRoom()`, `connect(code)` returning a client with `send`, `state(pred)`, `error()`; closes sockets after each test. |
| `test/worker/room.test.ts` (new) | The M1 smoke assertions as Durable Object tests, plus the empty-room alarm. |
| `test/worker/round.test.ts` (new) | Full-round Durable Object tests driven by `runDurableObjectAlarm`. |
| `src/game/words.ts` (new) | Categories and words, `pickWord`, `isSecretWord`, `validateClue`. |
| `src/game/rules.ts` (new) | `DURATIONS`, `chooseImposter`, `resolveVote`, `isStealCorrect`. |
| `src/game/protocol.ts` | Phases, `SeatView`, `RoundView`, `Snapshot`, client and server messages. |
| `src/game/state.ts` | `Seat`, `Round`, `RoomState`, `Event`, and the reducer for every phase. |
| `src/game/redact.ts` | Per-viewer snapshot, including round data and the reveal. |
| `src/worker/room.ts` | Parses the new messages, generates the round seed, syncs the alarm to `phaseEndsAt`, turns the alarm into `timeout`. |
| `src/client/views.ts` (new) | Pure HTML-string builders for the card, seats, vote buttons, and reveal table. |
| `src/client/app.ts`, `public/index.html` | Phase-driven sections, countdown, reconnect backoff. |
| `scripts/smoke.mjs` | Extended to play the clue phase against a running dev server. |
| `README.md` | Round flow, testing notes, status. |

---

### Task 1: Durable Object test harness (M1 carry-over)

Moves the suite into the Workers runtime so the Room Durable Object is tested automatically, and ports every assertion from `scripts/smoke.mjs` into it. The smoke script stays as the manual end-to-end check.

**Files:**
- Create: `.npmrc`, `vitest.config.ts`, `test/env.d.ts`, `test/worker/helpers.ts`, `test/worker/room.test.ts`
- Modify: `package.json` (devDependencies), `tsconfig.json` (`types`)

**Interfaces:**
- Produces: `createRoom(): Promise<string>`, `connect(code: string): Promise<Client>` where `Client = { ws: WebSocket; send(msg: unknown): void; next(pred): Promise<ServerMessage>; state(pred?): Promise<Snapshot>; error(): Promise<string> }`. `state(pred)` returns the first snapshot matching `pred` and discards every message received before it.

- [ ] **Step 1: Pin vitest 4 and add the pool**

`@cloudflare/vitest-pool-workers` peer-depends on `vitest ^4.1.0`, so the project moves from vitest 5 to 4.1. Edit `package.json` devDependencies to:

```json
"devDependencies": {
  "@cloudflare/vitest-pool-workers": "^0.22.0",
  "@cloudflare/workers-types": "^5.20260904.1",
  "esbuild": "^0.28.2",
  "typescript": "^5.9.0",
  "vitest": "^4.1.11",
  "wrangler": "^4.129.0"
}
```

Create `.npmrc`:

```
legacy-peer-deps=true
```

Run: `npm install`
Expected: succeeds. (Without `.npmrc`, npm 11.4 fails with `Cannot read properties of null (reading 'edgesOut')`.)

- [ ] **Step 2: Vitest config, types, and env augmentation**

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.jsonc' } })],
});
```

In `tsconfig.json` change the `types` line to:

```json
"types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers/types"],
```

Create `test/env.d.ts`:

```ts
import type { Env as AppEnv } from '../src/worker/env';

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {}
  }
}
```

Run: `npm test`
Expected: the 22 existing tests pass, now under `RUN v4.1.x` and inside workerd.

- [ ] **Step 3: Write the socket helpers**

Create `test/worker/helpers.ts`:

```ts
import { afterEach, expect } from 'vitest';
import { SELF } from 'cloudflare:test';
import type { ServerMessage, Snapshot } from '../../src/game/protocol';

const openSockets: WebSocket[] = [];

afterEach(() => {
  for (const ws of openSockets.splice(0)) {
    try {
      ws.close(1000, 'test done');
    } catch {
      // already closed
    }
  }
});

export async function createRoom(): Promise<string> {
  const res = await SELF.fetch('http://room.test/rooms', { method: 'POST' });
  expect(res.status).toBe(200);
  const { code } = (await res.json()) as { code: string };
  return code;
}

export interface Client {
  ws: WebSocket;
  send(msg: unknown): void;
  /** Resolves with the first message matching `pred`, discarding everything received before it. */
  next(pred: (m: ServerMessage) => boolean): Promise<ServerMessage>;
  /** Resolves with the first state snapshot matching `pred`. */
  state(pred?: (snap: Snapshot) => boolean): Promise<Snapshot>;
  /** Resolves with the code of the next error message. */
  error(): Promise<string>;
}

export async function connect(code: string): Promise<Client> {
  const res = await SELF.fetch(`http://room.test/rooms/${code}/ws`, { headers: { Upgrade: 'websocket' } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const inbox: ServerMessage[] = [];
  ws.addEventListener('message', (ev: MessageEvent) => {
    inbox.push(JSON.parse(ev.data as string) as ServerMessage);
  });
  ws.accept();
  openSockets.push(ws);

  const next = async (pred: (m: ServerMessage) => boolean): Promise<ServerMessage> => {
    for (let i = 0; i < 300; i++) {
      const idx = inbox.findIndex(pred);
      if (idx >= 0) return inbox.splice(0, idx + 1)[idx];
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out after 3s; inbox=${JSON.stringify(inbox)}`);
  };

  return {
    ws,
    send: (msg) => ws.send(JSON.stringify(msg)),
    next,
    state: async (pred = () => true) => {
      const m = await next((x) => x.type === 'state' && pred(x.snapshot));
      return (m as Extract<ServerMessage, { type: 'state' }>).snapshot;
    },
    error: async () => {
      const m = await next((x) => x.type === 'error');
      return (m as Extract<ServerMessage, { type: 'error' }>).code;
    },
  };
}
```

- [ ] **Step 4: Port the smoke assertions to Durable Object tests**

Create `test/worker/room.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { connect, createRoom } from './helpers';

async function lobbyWithTwo() {
  const code = await createRoom();
  const a = await connect(code);
  const b = await connect(code);
  a.send({ type: 'join', playerId: 'pa', displayName: 'Ada' });
  await a.state((s) => s.you === 0);
  b.send({ type: 'join', playerId: 'pb', displayName: 'Bob' });
  await b.state((s) => s.you === 1);
  return { code, a, b };
}

describe('Room Durable Object', () => {
  it('allocates a 4-letter code and refuses unknown rooms with a readable error', async () => {
    const code = await createRoom();
    expect(code).toMatch(/^[A-Z]{4}$/);
    const ghost = await connect(code === 'ZZZZ' ? 'YYYY' : 'ZZZZ');
    expect(await ghost.error()).toBe('room-not-found');
  });

  it('seats players, shows names in the lobby, hides other kinds, and relays chat', async () => {
    const { a, b } = await lobbyWithTwo();
    a.send({ type: 'chat', text: 'hello from ada' });
    const seen = await b.state((s) => s.transcript.some((l) => l.text === 'hello from ada'));
    expect(seen.seats[0].displayName).toBe('Ada');
    expect(seen.seats[0].kind).toBeUndefined();
    expect(seen.seats[1].kind).toBe('human');
    expect(JSON.stringify(seen)).not.toContain('"playerId"');
  });

  it('start fills six aliased seats, clears the transcript, and redacts other seats', async () => {
    const { a, b } = await lobbyWithTwo();
    a.send({ type: 'chat', text: 'lobby talk' });
    await b.state((s) => s.transcript.length === 1);
    a.send({ type: 'start' });
    const started = await b.state((s) => s.phase !== 'lobby');
    expect(started.seats).toHaveLength(6);
    expect(started.seats.every((s) => typeof s.alias === 'string')).toBe(true);
    expect(started.transcript).toEqual([]);
    for (const seat of started.seats) {
      if (seat.index === started.you) continue;
      expect(seat.displayName).toBeUndefined();
      expect(seat.kind).toBeUndefined();
    }
    expect(JSON.stringify(started)).not.toContain('"playerId"');
  });

  it('marks a dropped player and reconnects the same playerId to the same seat', async () => {
    const { code, a, b } = await lobbyWithTwo();
    a.send({ type: 'start' });
    const started = await b.state((s) => s.phase !== 'lobby');
    b.ws.close(1000, 'dropped');
    const dropped = await a.state((s) => s.seats.some((seat) => !seat.connected));
    expect(dropped.seats.filter((seat) => !seat.connected)).toHaveLength(1);

    const b2 = await connect(code);
    b2.send({ type: 'join', playerId: 'pb', displayName: 'Bob' });
    const back = await b2.state((s) => s.you !== null);
    expect(back.you).toBe(started.you);
    expect(back.seats.every((seat) => seat.connected)).toBe(true);
  });

  it('refuses a late joiner after start', async () => {
    const { code, a } = await lobbyWithTwo();
    a.send({ type: 'start' });
    await a.state((s) => s.phase !== 'lobby');
    const late = await connect(code);
    late.send({ type: 'join', playerId: 'late', displayName: 'Late' });
    expect(await late.error()).toBe('room-started');
  });

  it('deletes an empty room when its alarm fires', async () => {
    const code = await createRoom();
    const a = await connect(code);
    a.send({ type: 'join', playerId: 'pa', displayName: 'Ada' });
    await a.state();
    a.ws.close(1000, 'bye');
    await new Promise((r) => setTimeout(r, 50));
    const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const back = await connect(code);
    expect(await back.error()).toBe('room-not-found');
  });
});
```

- [ ] **Step 5: Run the suite and typecheck**

Run: `npm test && npm run typecheck`
Expected: 28 tests pass (22 game + 6 worker); typecheck clean. If the alarm test fails because the room still exists, raise the 50ms wait to 200ms: the close handler runs asynchronously after the client closes.

- [ ] **Step 6: Commit**

```bash
git add .npmrc package.json package-lock.json vitest.config.ts tsconfig.json test/env.d.ts test/worker
git commit -m "Run tests in the Workers runtime and cover the Room DO

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MrLZUUQrsJ4cV7L4ApiNU9"
```

---

### Task 2: Word lists and clue validation

**Files:**
- Create: `src/game/words.ts`
- Test: `test/game/words.test.ts`

**Interfaces:**
- Consumes: `Rng` from `src/game/aliases.ts`.
- Produces: `CATEGORIES: Category[]` with `Category = { name: string; words: string[] }`; `pickWord(rng: Rng): { category: string; word: string }`; `normalizeWord(s: string): string`; `isSecretWord(candidate: string, word: string): boolean`; `validateClue(raw: string, word: string, priorClues: string[]): ClueCheck` with `ClueCheck = { ok: true; clue: string } | { ok: false; code: 'clue-empty' | 'clue-one-word' | 'clue-too-long' | 'clue-is-word' | 'clue-taken'; message: string }`.

- [ ] **Step 1: Write the failing tests**

Create `test/game/words.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { CATEGORIES, isSecretWord, normalizeWord, pickWord, validateClue } from '../../src/game/words';
import { seededRng } from '../../src/game/aliases';

describe('CATEGORIES', () => {
  it('has at least 5 categories of at least 8 single lowercase words with no duplicates', () => {
    expect(CATEGORIES.length).toBeGreaterThanOrEqual(5);
    const all = CATEGORIES.flatMap((c) => c.words);
    expect(new Set(all).size).toBe(all.length);
    for (const c of CATEGORIES) {
      expect(c.words.length).toBeGreaterThanOrEqual(8);
      for (const w of c.words) expect(w).toMatch(/^[a-z]+$/);
    }
  });
});

describe('pickWord', () => {
  it('returns a word from the named category, deterministically per seed', () => {
    const pick = pickWord(seededRng(3));
    const category = CATEGORIES.find((c) => c.name === pick.category)!;
    expect(category.words).toContain(pick.word);
    expect(pickWord(seededRng(3))).toEqual(pick);
    const seen = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((s) => pickWord(seededRng(s)).word));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('normalizeWord', () => {
  it('lowercases, trims, and strips everything but letters', () => {
    expect(normalizeWord('  Pizza! ')).toBe('pizza');
    expect(normalizeWord("Don't")).toBe('dont');
  });
});

describe('isSecretWord', () => {
  it.each([
    ['pizza', 'pizza'],
    ['Pizza', 'pizza'],
    ['pizzas', 'pizza'],
    ['dog', 'dogs'],
    ['boxes', 'box'],
    ['cities', 'city'],
    ['shoes', 'shoe'],
    ['running', 'run'],
    ['jumped', 'jump'],
  ])('%s matches secret %s', (candidate, word) => {
    expect(isSecretWord(candidate, word)).toBe(true);
  });

  it.each([
    ['cat', 'car'],
    ['bust', 'bus'],
    ['pizzeria', 'pizza'],
    ['', 'pizza'],
  ])('%s does not match secret %s', (candidate, word) => {
    expect(isSecretWord(candidate, word)).toBe(false);
  });
});

describe('validateClue', () => {
  it('accepts a single word, trimmed, keeping its casing', () => {
    expect(validateClue('  Cheese ', 'pizza', [])).toEqual({ ok: true, clue: 'Cheese' });
  });

  it('rejects empty, multi-word, and overlong clues', () => {
    expect(validateClue('   ', 'pizza', [])).toMatchObject({ ok: false, code: 'clue-empty' });
    expect(validateClue('two words', 'pizza', [])).toMatchObject({ ok: false, code: 'clue-one-word' });
    expect(validateClue('x'.repeat(21), 'pizza', [])).toMatchObject({ ok: false, code: 'clue-too-long' });
  });

  it('rejects the secret word and its plural or stem', () => {
    expect(validateClue('Pizza', 'pizza', [])).toMatchObject({ ok: false, code: 'clue-is-word' });
    expect(validateClue('pizzas', 'pizza', [])).toMatchObject({ ok: false, code: 'clue-is-word' });
  });

  it('rejects a clue already given this round, case-insensitively', () => {
    expect(validateClue('cheese', 'pizza', ['Cheese', ''])).toMatchObject({ ok: false, code: 'clue-taken' });
    expect(validateClue('crust', 'pizza', ['Cheese', ''])).toEqual({ ok: true, clue: 'crust' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/game/words.test.ts`
Expected: FAIL, cannot resolve `../../src/game/words`.

- [ ] **Step 3: Implement `words.ts`**

Create `src/game/words.ts`:

```ts
import type { Rng } from './aliases';

export interface Category {
  name: string;
  words: string[];
}

export const CATEGORIES: Category[] = [
  { name: 'Animals', words: ['elephant', 'penguin', 'dolphin', 'giraffe', 'octopus', 'kangaroo', 'tiger', 'parrot', 'camel', 'spider'] },
  { name: 'Food', words: ['pizza', 'sushi', 'pancake', 'burrito', 'chocolate', 'noodles', 'cheese', 'mango', 'popcorn', 'soup'] },
  { name: 'Places', words: ['beach', 'library', 'airport', 'hospital', 'castle', 'desert', 'stadium', 'jungle', 'museum', 'farm'] },
  { name: 'Objects', words: ['umbrella', 'guitar', 'telescope', 'backpack', 'candle', 'mirror', 'ladder', 'pillow', 'compass', 'kettle'] },
  { name: 'Jobs', words: ['pilot', 'chef', 'dentist', 'firefighter', 'astronaut', 'farmer', 'detective', 'teacher', 'plumber', 'magician'] },
  { name: 'Sports', words: ['soccer', 'tennis', 'boxing', 'surfing', 'chess', 'bowling', 'hockey', 'archery', 'skiing', 'golf'] },
];

export const MAX_CLUE_LENGTH = 20;

export function pickWord(rng: Rng): { category: string; word: string } {
  const category = CATEGORIES[Math.floor(rng() * CATEGORIES.length)];
  const word = category.words[Math.floor(rng() * category.words.length)];
  return { category: category.name, word };
}

export function normalizeWord(s: string): string {
  return s.toLowerCase().replace(/[^a-z]/g, '');
}

/** Candidate stems for a normalized word: itself plus simple plural and verb-ending strips. */
function stems(w: string): Set<string> {
  const out = new Set([w]);
  const strip = (suffix: string, replacement = '') => {
    if (w.endsWith(suffix) && w.length - suffix.length >= 2) out.add(w.slice(0, -suffix.length) + replacement);
  };
  strip('ies', 'y');
  strip('es');
  strip('s');
  strip('ing');
  strip('ed');
  return out;
}

/** True when `candidate` is the secret word or a plural or simple stem variant of it. */
export function isSecretWord(candidate: string, word: string): boolean {
  const c = normalizeWord(candidate);
  if (!c) return false;
  const a = stems(c);
  for (const s of stems(normalizeWord(word))) if (a.has(s)) return true;
  return false;
}

export type ClueCheck =
  | { ok: true; clue: string }
  | { ok: false; code: 'clue-empty' | 'clue-one-word' | 'clue-too-long' | 'clue-is-word' | 'clue-taken'; message: string };

export function validateClue(raw: string, word: string, priorClues: string[]): ClueCheck {
  const clue = raw.trim();
  if (!clue) return { ok: false, code: 'clue-empty', message: 'Type a clue' };
  if (/\s/.test(clue)) return { ok: false, code: 'clue-one-word', message: 'One word only' };
  if (clue.length > MAX_CLUE_LENGTH) return { ok: false, code: 'clue-too-long', message: `Clues are at most ${MAX_CLUE_LENGTH} letters` };
  if (isSecretWord(clue, word)) return { ok: false, code: 'clue-is-word', message: 'That is the word itself' };
  const norm = normalizeWord(clue);
  if (priorClues.some((p) => p !== '' && normalizeWord(p) === norm)) {
    return { ok: false, code: 'clue-taken', message: 'That clue was already given' };
  }
  return { ok: true, clue };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/game/words.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/game/words.ts test/game/words.test.ts
git commit -m "Add word lists and clue validation

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MrLZUUQrsJ4cV7L4ApiNU9"
```

---

### Task 3: Round rules: durations, imposter choice, vote resolution, steal

**Files:**
- Create: `src/game/rules.ts`
- Test: `test/game/rules.test.ts`

**Interfaces:**
- Consumes: `Rng` from `aliases.ts`, `SeatKind` from `protocol.ts`.
- Produces: `DURATIONS = { clueTurn: 20_000, chat: 90_000, vote: 20_000, steal: 15_000 }`; `chooseImposter(seats: { index: number; kind: SeatKind }[], rng: Rng): number` (index of a human seat); `resolveVote(votes: (number | null)[]): number | null`; `isStealCorrect(guess: string, word: string): boolean`.

- [ ] **Step 1: Write the failing tests**

Create `test/game/rules.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { chooseImposter, DURATIONS, isStealCorrect, resolveVote } from '../../src/game/rules';
import { seededRng } from '../../src/game/aliases';

describe('DURATIONS', () => {
  it('matches the spec', () => {
    expect(DURATIONS).toEqual({ clueTurn: 20_000, chat: 90_000, vote: 20_000, steal: 15_000 });
  });
});

describe('chooseImposter', () => {
  const seats = [
    { index: 0, kind: 'bot' as const },
    { index: 1, kind: 'human' as const },
    { index: 2, kind: 'bot' as const },
    { index: 3, kind: 'human' as const },
    { index: 4, kind: 'bot' as const },
    { index: 5, kind: 'human' as const },
  ];

  it('only ever picks a human seat (M2) and reaches every human across seeds', () => {
    const picked = new Set<number>();
    for (let seed = 1; seed <= 40; seed++) {
      const i = chooseImposter(seats, seededRng(seed));
      expect(seats[i].kind).toBe('human');
      picked.add(i);
    }
    expect(picked).toEqual(new Set([1, 3, 5]));
  });

  it('is deterministic for a seed', () => {
    expect(chooseImposter(seats, seededRng(9))).toBe(chooseImposter(seats, seededRng(9)));
  });
});

describe('resolveVote', () => {
  it('ejects the seat with strictly more than half of the votes cast', () => {
    expect(resolveVote([1, 1, 2])).toBe(1);
    expect(resolveVote([3, null, null, null, null, null])).toBe(3);
    expect(resolveVote([1, 1, null, null, null, null])).toBe(1);
  });

  it('ejects nobody on a tie, a plurality short of majority, or no votes', () => {
    expect(resolveVote([1, 2, null, null, null, null])).toBeNull();
    expect(resolveVote([1, 1, 2, 2, 3, null])).toBeNull();
    expect(resolveVote([1, 2, 3, 4, null, null])).toBeNull();
    expect(resolveVote([null, null, null, null, null, null])).toBeNull();
    expect(resolveVote([])).toBeNull();
  });

  it('ignores abstentions when counting the majority', () => {
    expect(resolveVote([4, 4, 0, null, null, null])).toBe(4);
  });
});

describe('isStealCorrect', () => {
  it('matches exactly after trimming and lowercasing, nothing looser', () => {
    expect(isStealCorrect('  Pizza ', 'pizza')).toBe(true);
    expect(isStealCorrect('pizzas', 'pizza')).toBe(false);
    expect(isStealCorrect('', 'pizza')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/game/rules.test.ts`
Expected: FAIL, cannot resolve `../../src/game/rules`.

- [ ] **Step 3: Implement `rules.ts`**

Create `src/game/rules.ts`:

```ts
import type { Rng } from './aliases';
import type { SeatKind } from './protocol';

/** Phase lengths in milliseconds (spec 2.3). */
export const DURATIONS = {
  clueTurn: 20_000,
  chat: 90_000,
  vote: 20_000,
  steal: 15_000,
} as const;

/**
 * Picks the imposter uniformly among human seats. M2 only: bots cannot act yet,
 * so a bot imposter would make the round unwinnable. M3 widens this to all seats.
 */
export function chooseImposter(seats: { index: number; kind: SeatKind }[], rng: Rng): number {
  const humans = seats.filter((s) => s.kind === 'human');
  if (humans.length === 0) throw new RangeError('chooseImposter needs at least one human seat');
  return humans[Math.floor(rng() * humans.length)].index;
}

/** Majority of votes cast (strictly more than half) ejects; ties and abstentions eject nobody. */
export function resolveVote(votes: (number | null)[]): number | null {
  const cast = votes.filter((v): v is number => v !== null);
  if (cast.length === 0) return null;
  const tally = new Map<number, number>();
  for (const v of cast) tally.set(v, (tally.get(v) ?? 0) + 1);
  for (const [seat, count] of tally) if (count * 2 > cast.length) return seat;
  return null;
}

export function isStealCorrect(guess: string, word: string): boolean {
  const g = guess.trim().toLowerCase();
  return g.length > 0 && g === word.trim().toLowerCase();
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/game/rules.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/game/rules.ts test/game/rules.test.ts
git commit -m "Add round rules: durations, imposter choice, vote and steal resolution

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MrLZUUQrsJ4cV7L4ApiNU9"
```

---

### Task 4: Protocol types and the reducer through the clue phase

The `start` event now carries `at` and `seed`; `apply` loses its `rng` parameter. Start picks the word and imposter, enters the clue phase, and passes bot turns instantly. The `clue` event and clue-phase `timeout` advance turns; after pass 2 the chat phase opens.

**Files:**
- Modify: `src/game/protocol.ts` (replace whole file)
- Modify: `src/game/state.ts` (replace whole file)
- Modify: `test/game/state.test.ts` (replace whole file), `test/game/redact.test.ts` (one helper)

**Interfaces:**
- Consumes: `makeAliases`, `shuffle`, `seededRng` (aliases.ts); `pickWord`, `validateClue` (words.ts); `chooseImposter`, `DURATIONS` (rules.ts).
- Produces (used by Tasks 5 to 9): the types below, `apply(state: RoomState, event: Event): Result`, `createRoom(code, at)`. Error codes: `not-seated`, `room-started`, `room-full`, `already-started`, `chat-closed`, `wrong-phase`, `not-your-turn`, plus the `clue-*` codes from `validateClue`.

- [ ] **Step 1: Replace `src/game/protocol.ts`**

```ts
export type Phase = 'lobby' | 'clue' | 'chat' | 'vote' | 'steal' | 'reveal';
export type SeatKind = 'human' | 'bot';
/** Who won the round. */
export type Outcome = 'crew' | 'imposter';

export interface ChatLine {
  seat: number;
  text: string;
  at: number;
}

/** What one viewer is allowed to see about a seat. */
export interface SeatView {
  index: number;
  alias: string | null;
  connected: boolean;
  /** Public. One entry per clue pass; '' means the turn passed with no clue. */
  clues: string[];
  /** Public during the vote so the room can see who is still deciding. */
  voted: boolean;
  /** Present in the lobby for everyone, always for your own seat, and for everyone at the reveal. */
  displayName?: string;
  /** Present only for your own seat, and for everyone at the reveal. */
  kind?: SeatKind;
  /** Present only for your own seat, and for everyone at the reveal. */
  isImposter?: boolean;
  /** Present only at the reveal. */
  vote?: number | null;
}

export interface RoundView {
  category: string;
  /** null for the imposter until the reveal. */
  word: string | null;
  /** Whose turn it is; null outside the clue phase. */
  clueSeat: number | null;
  cluePass: 1 | 2;
  ejected: number | null;
  /** Present only at the reveal. */
  stealGuess: string | null;
  result: Outcome | null;
}

export interface Snapshot {
  code: string;
  phase: Phase;
  /** Your seat index, or null if you are not seated. */
  you: number | null;
  /** Server clock deadline for the current phase; null when untimed. */
  phaseEndsAt: number | null;
  seats: SeatView[];
  transcript: ChatLine[];
  round: RoundView | null;
}

export type ClientMessage =
  | { type: 'join'; playerId: string; displayName: string }
  | { type: 'start' }
  | { type: 'chat'; text: string }
  | { type: 'clue'; word: string }
  | { type: 'vote'; seat: number }
  | { type: 'steal'; word: string }
  | { type: 'again' };

export type ServerMessage =
  | { type: 'state'; snapshot: Snapshot }
  | { type: 'error'; code: string; message: string };
```

- [ ] **Step 2: Write the failing tests (replace `test/game/state.test.ts`)**

```ts
import { describe, it, expect } from 'vitest';
import { apply, createRoom, MAX_TRANSCRIPT, SEAT_COUNT, type RoomState } from '../../src/game/state';
import { DURATIONS } from '../../src/game/rules';
import { CATEGORIES } from '../../src/game/words';

export function roomWith(names: string[]): RoomState {
  let state = createRoom('ABCD', 1000);
  names.forEach((name, i) => {
    state = apply(state, { type: 'join', playerId: `p${i}`, displayName: name, at: 1000 + i }).state;
  });
  return state;
}

export function started(names = ['Ada', 'Bob'], seed = 42): RoomState {
  return apply(roomWith(names), { type: 'start', playerId: 'p0', at: 1000, seed }).state;
}

/** playerId of the seat whose clue turn it is. */
export function whoseTurn(state: RoomState): string {
  return state.seats[state.round!.clueSeat!].playerId!;
}

/** Times out every clue turn until the chat phase opens. */
export function throughClues(state: RoomState, at = 2000): RoomState {
  while (state.phase === 'clue') state = apply(state, { type: 'timeout', at }).state;
  return state;
}

describe('createRoom', () => {
  it('starts empty in the lobby with no round', () => {
    expect(createRoom('ABCD', 1000)).toEqual({
      code: 'ABCD', phase: 'lobby', phaseEndsAt: null, seats: [], transcript: [], round: null, createdAt: 1000,
    });
  });
});

describe('join', () => {
  it('seats a new human in the next index', () => {
    const state = roomWith(['Ada', 'Bob']);
    expect(state.seats).toHaveLength(2);
    expect(state.seats[1]).toEqual({
      index: 1, kind: 'human', alias: null, playerId: 'p1', displayName: 'Bob', connected: true,
      isImposter: false, clues: [], vote: null,
    });
  });

  it('trims names, caps them at 20 chars, and defaults blank names', () => {
    const state = roomWith(['  ' + 'x'.repeat(30), '   ']);
    expect(state.seats[0].displayName).toBe('x'.repeat(20));
    expect(state.seats[1].displayName).toBe('Player 2');
  });

  it('reconnects an existing playerId instead of adding a seat', () => {
    let state = roomWith(['Ada']);
    state = apply(state, { type: 'disconnect', playerId: 'p0' }).state;
    expect(state.seats[0].connected).toBe(false);
    const result = apply(state, { type: 'join', playerId: 'p0', displayName: 'Ada', at: 2000 });
    expect(result.effects).toEqual([]);
    expect(result.state.seats).toHaveLength(1);
    expect(result.state.seats[0].connected).toBe(true);
  });

  it('rejects a 7th human with room-full', () => {
    const state = roomWith(['a', 'b', 'c', 'd', 'e', 'f']);
    const result = apply(state, { type: 'join', playerId: 'p6', displayName: 'g', at: 0 });
    expect(result.state).toBe(state);
    expect(result.effects).toEqual([{ type: 'error', to: 'p6', code: 'room-full', message: 'This room is full' }]);
  });

  it('rejects a new player after the round started', () => {
    const result = apply(started(['Ada']), { type: 'join', playerId: 'p9', displayName: 'Late', at: 0 });
    expect(result.effects[0].code).toBe('room-started');
    expect(result.state.seats.filter((s) => s.kind === 'human')).toHaveLength(1);
  });
});

describe('chat', () => {
  it('appends a trimmed line tagged with the sender seat', () => {
    const state = roomWith(['Ada', 'Bob']);
    const result = apply(state, { type: 'chat', playerId: 'p1', text: '  hi there  ', at: 5 });
    expect(result.state.transcript).toEqual([{ seat: 1, text: 'hi there', at: 5 }]);
  });

  it('ignores blank messages and caps length at 280', () => {
    const state = roomWith(['Ada']);
    expect(apply(state, { type: 'chat', playerId: 'p0', text: '   ', at: 5 }).state.transcript).toEqual([]);
    const long = apply(state, { type: 'chat', playerId: 'p0', text: 'y'.repeat(300), at: 5 });
    expect(long.state.transcript[0].text).toHaveLength(280);
  });

  it('errors for a player who has not joined', () => {
    const result = apply(roomWith(['Ada']), { type: 'chat', playerId: 'ghost', text: 'boo', at: 5 });
    expect(result.effects[0].code).toBe('not-seated');
    expect(result.state.transcript).toEqual([]);
  });

  it('caps the transcript at MAX_TRANSCRIPT lines, dropping the oldest', () => {
    let state = roomWith(['Ada']);
    for (let i = 0; i < 201; i++) {
      state = apply(state, { type: 'chat', playerId: 'p0', text: `msg ${i}`, at: i }).state;
    }
    expect(state.transcript).toHaveLength(MAX_TRANSCRIPT);
    expect(state.transcript[0].text).toBe('msg 1');
  });

  it('is closed during the clue phase and open again in the chat phase', () => {
    const inClue = started();
    expect(apply(inClue, { type: 'chat', playerId: 'p0', text: 'psst', at: 5 }).effects[0].code).toBe('chat-closed');
    const inChat = throughClues(inClue);
    expect(apply(inChat, { type: 'chat', playerId: 'p0', text: 'psst', at: 5 }).state.transcript).toHaveLength(1);
  });
});

describe('start', () => {
  it('fills to 6 seats with bots, shuffles, assigns unique aliases, clears lobby chat, opens the clue phase', () => {
    let state = roomWith(['Ada', 'Bob']);
    state = apply(state, { type: 'chat', playerId: 'p0', text: 'lobby talk', at: 5 }).state;
    const result = apply(state, { type: 'start', playerId: 'p0', at: 1000, seed: 42 });
    const s = result.state;
    expect(result.effects).toEqual([]);
    expect(s.phase).toBe('clue');
    expect(s.phaseEndsAt).toBe(1000 + DURATIONS.clueTurn);
    expect(s.transcript).toEqual([]);
    expect(s.seats).toHaveLength(SEAT_COUNT);
    expect(s.seats.map((seat) => seat.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(new Set(s.seats.map((seat) => seat.alias)).size).toBe(SEAT_COUNT);
    expect(s.seats.filter((seat) => seat.kind === 'human').map((seat) => seat.playerId).sort()).toEqual(['p0', 'p1']);
    expect(s.seats.filter((seat) => seat.kind === 'bot')).toHaveLength(4);
    expect(s.seats.every((seat) => seat.connected)).toBe(true);
  });

  it('picks a word from a category and exactly one imposter, who is human', () => {
    const s = started();
    const category = CATEGORIES.find((c) => c.name === s.round!.category)!;
    expect(category.words).toContain(s.round!.word);
    expect(s.round).toMatchObject({ seed: 42, cluePass: 1, ejected: null, stealGuess: null, result: null });
    const imposters = s.seats.filter((seat) => seat.isImposter);
    expect(imposters).toHaveLength(1);
    expect(imposters[0].kind).toBe('human');
  });

  it('is deterministic for a seed and varies across seeds', () => {
    expect(started(['Ada', 'Bob'], 7)).toEqual(started(['Ada', 'Bob'], 7));
    const words = new Set([1, 2, 3, 4, 5, 6].map((seed) => started(['Ada', 'Bob'], seed).round!.word));
    expect(words.size).toBeGreaterThan(1);
    const orders = new Set([1, 2, 3, 4, 5].map((seed) => started(['a', 'b', 'c', 'd', 'e', 'f'], seed).seats.map((s) => s.playerId).join()));
    expect(orders.size).toBeGreaterThan(1);
  });

  it('passes bot turns instantly so the first turn is a human, recording "" for each skipped bot', () => {
    const s = started();
    const turn = s.seats[s.round!.clueSeat!];
    expect(turn.kind).toBe('human');
    for (const seat of s.seats) {
      if (seat.index < turn.index) expect(seat.clues).toEqual(['']);
      else expect(seat.clues).toEqual([]);
    }
  });

  it('errors if already started or from a non-member', () => {
    const state = roomWith(['Ada']);
    expect(apply(state, { type: 'start', playerId: 'ghost', at: 0, seed: 1 }).effects[0].code).toBe('not-seated');
    expect(apply(started(['Ada']), { type: 'start', playerId: 'p0', at: 0, seed: 1 }).effects[0].code).toBe('already-started');
  });
});

describe('clue', () => {
  it('records a valid clue for the seat whose turn it is and resets the turn timer', () => {
    const s0 = started();
    const me = whoseTurn(s0);
    const result = apply(s0, { type: 'clue', playerId: me, word: ' Crust ', at: 5000 });
    expect(result.effects).toEqual([]);
    const s1 = result.state;
    const mine = s1.seats.find((seat) => seat.playerId === me)!;
    expect(mine.clues).toEqual(['Crust']);
    expect(s1.phaseEndsAt).toBe(5000 + DURATIONS.clueTurn);
    expect(s1.phase === 'chat' || s1.seats[s1.round!.clueSeat!].kind === 'human').toBe(true);
    expect(whoseTurn(s1) !== me || s1.round!.cluePass === 2).toBe(true);
  });

  it('rejects out-of-turn, multi-word, secret-word, and repeated clues without advancing', () => {
    const s0 = started();
    const me = whoseTurn(s0);
    const other = me === 'p0' ? 'p1' : 'p0';
    expect(apply(s0, { type: 'clue', playerId: other, word: 'x', at: 1 }).effects[0].code).toBe('not-your-turn');
    expect(apply(s0, { type: 'clue', playerId: me, word: 'two words', at: 1 }).effects[0].code).toBe('clue-one-word');
    expect(apply(s0, { type: 'clue', playerId: me, word: s0.round!.word, at: 1 }).effects[0].code).toBe('clue-is-word');
    const s1 = apply(s0, { type: 'clue', playerId: me, word: 'first', at: 1 }).state;
    const next = whoseTurn(s1);
    const dup = apply(s1, { type: 'clue', playerId: next, word: 'FIRST', at: 2 });
    expect(dup.effects[0].code).toBe('clue-taken');
    expect(dup.state).toBe(s1);
    expect(apply(s0, { type: 'clue', playerId: 'ghost', word: 'x', at: 1 }).effects[0].code).toBe('not-seated');
  });

  it('is rejected outside the clue phase', () => {
    const inChat = throughClues(started());
    expect(apply(inChat, { type: 'clue', playerId: 'p0', word: 'late', at: 1 }).effects[0].code).toBe('wrong-phase');
  });

  it('opens the chat phase for 90s after two passes, with clueSeat null and two entries per seat', () => {
    // Distinct words: `c0`/`c1` all normalize to `c` and would be rejected as duplicates.
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
    let s = started();
    let n = 0;
    while (s.phase === 'clue') {
      expect(n).toBeLessThan(words.length); // a rejected clue would otherwise loop forever
      s = apply(s, { type: 'clue', playerId: whoseTurn(s), word: words[n++], at: 3000 }).state;
    }
    expect(n).toBe(4);
    expect(s.phase).toBe('chat');
    expect(s.phaseEndsAt).toBe(3000 + DURATIONS.chat);
    expect(s.round!.clueSeat).toBeNull();
    expect(s.round!.cluePass).toBe(2);
    for (const seat of s.seats) expect(seat.clues).toHaveLength(2);
    expect(s.seats.filter((seat) => seat.kind === 'bot').every((seat) => seat.clues.every((c) => c === ''))).toBe(true);
  });
});

describe('timeout in the clue phase', () => {
  it('records "" for the current seat and advances to the next human turn', () => {
    const s0 = started();
    const me = whoseTurn(s0);
    const s1 = apply(s0, { type: 'timeout', at: 4000 }).state;
    expect(s1.seats.find((seat) => seat.playerId === me)!.clues).toEqual(['']);
    expect(s1.phase === 'chat' || s1.seats[s1.round!.clueSeat!].kind === 'human').toBe(true);
  });

  it('is a no-op in the lobby', () => {
    const state = roomWith(['Ada']);
    expect(apply(state, { type: 'timeout', at: 1 }).state).toBe(state);
  });
});

describe('disconnect', () => {
  it('marks only that seat disconnected and is a no-op for unknown ids', () => {
    const state = roomWith(['Ada', 'Bob']);
    const result = apply(state, { type: 'disconnect', playerId: 'p1' });
    expect(result.state.seats.map((s) => s.connected)).toEqual([true, false]);
    expect(apply(state, { type: 'disconnect', playerId: 'nobody' }).state).toEqual(state);
  });
});
```

Also patch `test/game/redact.test.ts` so it compiles against the new `start` signature. Replace its `started()` helper with:

```ts
function started(): RoomState {
  return apply(lobby(), { type: 'start', playerId: 'p0', at: 10, seed: 1 }).state;
}
```

and delete the now-unused `import { seededRng } from '../../src/game/aliases';` line. Task 6 rewrites this file completely.

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/game`
Expected: FAIL. `state.test.ts` fails to compile against the old `Event` type (`seed` is not accepted) and, at runtime, on the missing `phaseEndsAt`, `round`, `isImposter`, `clues`, and `vote` fields.

- [ ] **Step 4: Replace `src/game/state.ts`**

```ts
import type { ChatLine, Outcome, Phase, SeatKind } from './protocol';
import { makeAliases, seededRng, shuffle } from './aliases';
import { pickWord, validateClue } from './words';
import { chooseImposter, DURATIONS } from './rules';

export const SEAT_COUNT = 6;
export const MAX_CHAT_LENGTH = 280;
export const MAX_TRANSCRIPT = 200;
const MAX_NAME_LENGTH = 20;

export interface Seat {
  index: number;
  kind: SeatKind;
  alias: string | null;
  playerId?: string;
  displayName?: string;
  connected: boolean;
  isImposter: boolean;
  /** One entry per clue pass; '' means the turn passed with no clue. */
  clues: string[];
  vote: number | null;
}

export interface Round {
  seed: number;
  category: string;
  word: string;
  /** Whose turn it is during the clue phase; null in every other phase. */
  clueSeat: number | null;
  cluePass: 1 | 2;
  ejected: number | null;
  stealGuess: string | null;
  result: Outcome | null;
}

export interface RoomState {
  code: string;
  phase: Phase;
  /** Deadline of the current phase on the server clock; null when untimed. The DO mirrors it into its alarm. */
  phaseEndsAt: number | null;
  seats: Seat[];
  transcript: ChatLine[];
  round: Round | null;
  createdAt: number;
}

export type Event =
  | { type: 'join'; playerId: string; displayName: string; at: number }
  | { type: 'disconnect'; playerId: string }
  | { type: 'chat'; playerId: string; text: string; at: number }
  | { type: 'start'; playerId: string; at: number; seed: number }
  | { type: 'clue'; playerId: string; word: string; at: number }
  | { type: 'vote'; playerId: string; seat: number; at: number }
  | { type: 'steal'; playerId: string; word: string; at: number }
  | { type: 'again'; playerId: string; at: number }
  | { type: 'timeout'; at: number };

export type Effect = { type: 'error'; to: string; code: string; message: string };

export interface Result {
  state: RoomState;
  effects: Effect[];
}

const CHAT_PHASES: readonly Phase[] = ['lobby', 'chat', 'reveal'];

export function createRoom(code: string, at: number): RoomState {
  return { code, phase: 'lobby', phaseEndsAt: null, seats: [], transcript: [], round: null, createdAt: at };
}

export function apply(state: RoomState, event: Event): Result {
  switch (event.type) {
    case 'join':
      return join(state, event);
    case 'disconnect':
      return disconnect(state, event);
    case 'chat':
      return chat(state, event);
    case 'start':
      return start(state, event);
    case 'clue':
      return clue(state, event);
    case 'vote':
      return vote(state, event);
    case 'steal':
      return steal(state, event);
    case 'again':
      return again(state, event);
    case 'timeout':
      return timeout(state, event);
  }
}

function ok(state: RoomState): Result {
  return { state, effects: [] };
}

function fail(state: RoomState, to: string, code: string, message: string): Result {
  return { state, effects: [{ type: 'error', to, code, message }] };
}

function seatOf(state: RoomState, playerId: string): Seat | undefined {
  return state.seats.find((s) => s.playerId === playerId);
}

function join(state: RoomState, event: Extract<Event, { type: 'join' }>): Result {
  const existing = seatOf(state, event.playerId);
  if (existing) {
    const seats = state.seats.map((s) => (s === existing ? { ...s, connected: true } : s));
    return ok({ ...state, seats });
  }
  if (state.phase !== 'lobby') return fail(state, event.playerId, 'room-started', 'This round already started');
  if (state.seats.length >= SEAT_COUNT) return fail(state, event.playerId, 'room-full', 'This room is full');
  const displayName = event.displayName.trim().slice(0, MAX_NAME_LENGTH) || `Player ${state.seats.length + 1}`;
  const seat: Seat = {
    index: state.seats.length,
    kind: 'human',
    alias: null,
    playerId: event.playerId,
    displayName,
    connected: true,
    isImposter: false,
    clues: [],
    vote: null,
  };
  return ok({ ...state, seats: [...state.seats, seat] });
}

function disconnect(state: RoomState, event: Extract<Event, { type: 'disconnect' }>): Result {
  const seats = state.seats.map((s) => (s.playerId === event.playerId ? { ...s, connected: false } : s));
  return ok({ ...state, seats });
}

function chat(state: RoomState, event: Extract<Event, { type: 'chat' }>): Result {
  const seat = seatOf(state, event.playerId);
  if (!seat) return fail(state, event.playerId, 'not-seated', 'Join the room first');
  if (!CHAT_PHASES.includes(state.phase)) return fail(state, event.playerId, 'chat-closed', 'Chat opens after the clues');
  const text = event.text.trim().slice(0, MAX_CHAT_LENGTH);
  if (!text) return ok(state);
  const line: ChatLine = { seat: seat.index, text, at: event.at };
  return ok({ ...state, transcript: [...state.transcript, line].slice(-MAX_TRANSCRIPT) });
}

function start(state: RoomState, event: Extract<Event, { type: 'start' }>): Result {
  const seat = seatOf(state, event.playerId);
  if (!seat) return fail(state, event.playerId, 'not-seated', 'Join the room first');
  if (state.phase !== 'lobby') return fail(state, event.playerId, 'already-started', 'The round already started');

  const rng = seededRng(event.seed);
  const filled: Seat[] = [...state.seats];
  while (filled.length < SEAT_COUNT) {
    filled.push({ index: filled.length, kind: 'bot', alias: null, connected: true, isImposter: false, clues: [], vote: null });
  }
  const aliases = makeAliases(SEAT_COUNT, rng);
  const order = shuffle(filled.map((_, i) => i), rng);
  const seats: Seat[] = order.map((from, index) => ({
    ...filled[from],
    index,
    alias: aliases[index],
    isImposter: false,
    clues: [],
    vote: null,
  }));
  const { category, word } = pickWord(rng);
  const imposter = chooseImposter(seats, rng);
  seats[imposter] = { ...seats[imposter], isImposter: true };

  const round: Round = { seed: event.seed, category, word, clueSeat: 0, cluePass: 1, ejected: null, stealGuess: null, result: null };
  // Lobby chat referenced old seat indices, and the round is a fresh transcript anyway.
  const next: RoomState = { ...state, phase: 'clue', phaseEndsAt: event.at + DURATIONS.clueTurn, seats, transcript: [], round };
  return ok(skipBotClues(next, event.at));
}

/** Records a clue ('' for a passed turn) for the seat whose turn it is, then moves to the next turn or opens the chat. */
function recordClue(state: RoomState, clueText: string, at: number): RoomState {
  const round = state.round!;
  const current = round.clueSeat!;
  const seats = state.seats.map((s) => (s.index === current ? { ...s, clues: [...s.clues, clueText] } : s));
  if (current < SEAT_COUNT - 1) {
    return { ...state, seats, phaseEndsAt: at + DURATIONS.clueTurn, round: { ...round, clueSeat: current + 1 } };
  }
  if (round.cluePass === 1) {
    return { ...state, seats, phaseEndsAt: at + DURATIONS.clueTurn, round: { ...round, clueSeat: 0, cluePass: 2 } };
  }
  return { ...state, seats, phase: 'chat', phaseEndsAt: at + DURATIONS.chat, round: { ...round, clueSeat: null } };
}

/** M2 has no bot brains: a bot's clue turn passes immediately. M3 replaces this with a botTurn effect. */
function skipBotClues(state: RoomState, at: number): RoomState {
  while (state.phase === 'clue' && state.seats[state.round!.clueSeat!].kind === 'bot') {
    state = recordClue(state, '', at);
  }
  return state;
}

function clue(state: RoomState, event: Extract<Event, { type: 'clue' }>): Result {
  const seat = seatOf(state, event.playerId);
  if (!seat) return fail(state, event.playerId, 'not-seated', 'Join the room first');
  if (state.phase !== 'clue' || !state.round) return fail(state, event.playerId, 'wrong-phase', 'Clues are closed');
  if (state.round.clueSeat !== seat.index) return fail(state, event.playerId, 'not-your-turn', 'Wait for your turn');
  const prior = state.seats.flatMap((s) => s.clues);
  const check = validateClue(event.word, state.round.word, prior);
  if (!check.ok) return fail(state, event.playerId, check.code, check.message);
  return ok(skipBotClues(recordClue(state, check.clue, event.at), event.at));
}

function vote(state: RoomState, event: Extract<Event, { type: 'vote' }>): Result {
  const seat = seatOf(state, event.playerId);
  if (!seat) return fail(state, event.playerId, 'not-seated', 'Join the room first');
  return fail(state, event.playerId, 'wrong-phase', 'Voting is closed');
}

function steal(state: RoomState, event: Extract<Event, { type: 'steal' }>): Result {
  const seat = seatOf(state, event.playerId);
  if (!seat) return fail(state, event.playerId, 'not-seated', 'Join the room first');
  return fail(state, event.playerId, 'wrong-phase', 'No steal in progress');
}

function again(state: RoomState, event: Extract<Event, { type: 'again' }>): Result {
  const seat = seatOf(state, event.playerId);
  if (!seat) return fail(state, event.playerId, 'not-seated', 'Join the room first');
  return fail(state, event.playerId, 'wrong-phase', 'The round is still going');
}

function timeout(state: RoomState, event: Extract<Event, { type: 'timeout' }>): Result {
  switch (state.phase) {
    case 'clue':
      return ok(skipBotClues(recordClue(state, '', event.at), event.at));
    default:
      return ok(state);
  }
}
```

`vote`, `steal`, and `again` are deliberately phase-rejecting stubs here; Task 5 fills them in and extends `timeout`.

- [ ] **Step 5: Run to verify pass**

Run: `npm test && npm run typecheck`
Expected: all game tests pass; `test/worker/room.test.ts` still passes (it only asserts `phase !== 'lobby'`).

Typecheck will report two errors in `src/game/redact.ts`: the widened `SeatView` and `Snapshot` now require fields it does not build. Task 6 rewrites that file properly; for now replace it with exactly this, which adds only the fields the types demand and withholds the word from everyone so no half-finished rule can leak it:

```ts
import type { RoomState } from './state';
import type { RoundView, SeatView, Snapshot } from './protocol';

/**
 * The only path from room state to a client. Strips everything a viewer
 * must not know about other seats.
 *
 * Task 6 implements the real round rules. Until then `word` and `stealGuess`
 * are withheld from every viewer: a stub must never leak more than the
 * finished rule would.
 */
export function redact(state: RoomState, viewerPlayerId: string | null): Snapshot {
  const you = viewerPlayerId === null ? undefined : state.seats.find((s) => s.playerId === viewerPlayerId);
  const seats: SeatView[] = state.seats.map((s) => {
    const mine = you !== undefined && s.index === you.index;
    const view: SeatView = {
      index: s.index,
      alias: s.alias,
      connected: s.connected,
      clues: s.clues,
      voted: s.vote !== null,
    };
    if (mine || state.phase === 'lobby') view.displayName = s.displayName;
    if (mine) view.kind = s.kind;
    return view;
  });
  const r = state.round;
  const round: RoundView | null =
    r === null
      ? null
      : {
          category: r.category,
          word: null,
          clueSeat: state.phase === 'clue' ? r.clueSeat : null,
          cluePass: r.cluePass,
          ejected: r.ejected,
          stealGuess: null,
          result: r.result,
        };
  return {
    code: state.code,
    phase: state.phase,
    you: you ? you.index : null,
    phaseEndsAt: state.phaseEndsAt,
    seats,
    transcript: state.transcript,
    round,
  };
}
```

Also confirm the worker still compiles: `src/worker/room.ts` builds the `start` event without `at`/`seed`, which now fails typecheck. Patch that one line in `src/worker/room.ts` now so the tree stays green:

```ts
    } else if (msg.type === 'start') {
      event = { type: 'start', playerId: att.playerId, at: Date.now(), seed: crypto.getRandomValues(new Uint32Array(1))[0] };
```

And in `dispatch`, drop the `rng` argument: `const result = apply(this.state, event);` (it already reads that way). Run `npm run typecheck` again: clean.

- [ ] **Step 6: Commit**

```bash
git add src/game/protocol.ts src/game/state.ts src/game/redact.ts src/worker/room.ts test/game/state.test.ts test/game/redact.test.ts
git commit -m "Seeded start, word and imposter assignment, clue phase with turn timer

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MrLZUUQrsJ4cV7L4ApiNU9"
```

---

### Task 5: Chat timeout, vote, steal, reveal, play again

**Files:**
- Modify: `src/game/state.ts` (replace `vote`, `steal`, `again`, `timeout`; add `enterVote`, `closeVote`, `finish`)
- Test: `test/game/state.test.ts` (append)

**Interfaces:**
- Consumes: `resolveVote`, `isStealCorrect`, `DURATIONS` from `rules.ts`; `Outcome` from `protocol.ts`.
- Produces: error codes `bad-vote`, `not-imposter`, `wrong-phase`. Phase order `chat -> vote -> (steal) -> reveal -> lobby`.

- [ ] **Step 1: Append the failing tests to `test/game/state.test.ts`**

```ts
/** Three humans so a 2-vote majority can eject. Returns the state at the start of the vote phase. */
function inVote(seed = 42): RoomState {
  const inChat = throughClues(started(['Ada', 'Bob', 'Cal'], seed));
  return apply(inChat, { type: 'timeout', at: 10_000 }).state;
}

function imposterOf(state: RoomState) {
  return state.seats.find((s) => s.isImposter)!;
}

function crewOf(state: RoomState) {
  return state.seats.filter((s) => s.kind === 'human' && !s.isImposter);
}

describe('chat phase timeout', () => {
  it('opens a 20s vote with every vote cleared', () => {
    const s = inVote();
    expect(s.phase).toBe('vote');
    expect(s.phaseEndsAt).toBe(10_000 + DURATIONS.vote);
    expect(s.seats.every((seat) => seat.vote === null)).toBe(true);
  });
});

describe('vote', () => {
  it('records a vote for another seat and allows changing it until the phase closes', () => {
    const s0 = inVote();
    const [c1, c2] = crewOf(s0);
    const s1 = apply(s0, { type: 'vote', playerId: c1.playerId!, seat: c2.index, at: 1 }).state;
    expect(s1.seats[c1.index].vote).toBe(c2.index);
    expect(s1.phase).toBe('vote');
    const target = imposterOf(s0).index;
    const s2 = apply(s1, { type: 'vote', playerId: c1.playerId!, seat: target, at: 2 }).state;
    expect(s2.seats[c1.index].vote).toBe(target);
  });

  it('rejects self-votes, out-of-range seats, non-integers, and votes outside the vote phase', () => {
    const s0 = inVote();
    const [c1] = crewOf(s0);
    expect(apply(s0, { type: 'vote', playerId: c1.playerId!, seat: c1.index, at: 1 }).effects[0].code).toBe('bad-vote');
    expect(apply(s0, { type: 'vote', playerId: c1.playerId!, seat: 6, at: 1 }).effects[0].code).toBe('bad-vote');
    expect(apply(s0, { type: 'vote', playerId: c1.playerId!, seat: 1.5, at: 1 }).effects[0].code).toBe('bad-vote');
    expect(apply(started(), { type: 'vote', playerId: 'p0', seat: 1, at: 1 }).effects[0].code).toBe('wrong-phase');
    expect(apply(s0, { type: 'vote', playerId: 'ghost', seat: 1, at: 1 }).effects[0].code).toBe('not-seated');
  });

  it('closes as soon as every human has voted; a majority on the imposter opens a 15s steal', () => {
    let s = inVote();
    const imp = imposterOf(s);
    const [c1, c2] = crewOf(s);
    s = apply(s, { type: 'vote', playerId: c1.playerId!, seat: imp.index, at: 1 }).state;
    s = apply(s, { type: 'vote', playerId: c2.playerId!, seat: imp.index, at: 2 }).state;
    expect(s.phase).toBe('vote');
    s = apply(s, { type: 'vote', playerId: imp.playerId!, seat: c1.index, at: 3000 }).state;
    expect(s.phase).toBe('steal');
    expect(s.phaseEndsAt).toBe(3000 + DURATIONS.steal);
    expect(s.round!.ejected).toBe(imp.index);
    expect(s.round!.result).toBeNull();
  });

  it('a majority on a crew member ends the round as an imposter win', () => {
    let s = inVote();
    const imp = imposterOf(s);
    const [c1, c2] = crewOf(s);
    s = apply(s, { type: 'vote', playerId: c1.playerId!, seat: c2.index, at: 1 }).state;
    s = apply(s, { type: 'vote', playerId: imp.playerId!, seat: c2.index, at: 2 }).state;
    s = apply(s, { type: 'vote', playerId: c2.playerId!, seat: c1.index, at: 3 }).state;
    expect(s.phase).toBe('reveal');
    expect(s.phaseEndsAt).toBeNull();
    expect(s.round!.ejected).toBe(c2.index);
    expect(s.round!.result).toBe('imposter');
  });

  it('timeout with a split vote ejects nobody and the imposter wins', () => {
    let t = inVote();
    const imp = imposterOf(t);
    const [d1, d2] = crewOf(t);
    t = apply(t, { type: 'vote', playerId: d1.playerId!, seat: imp.index, at: 1 }).state;
    t = apply(t, { type: 'vote', playerId: d2.playerId!, seat: d1.index, at: 2 }).state;
    t = apply(t, { type: 'timeout', at: 5 }).state;
    expect(t.phase).toBe('reveal');
    expect(t.round!.ejected).toBeNull();
    expect(t.round!.result).toBe('imposter');
  });

  it('timeout with a single vote cast treats it as a majority of one', () => {
    let s = inVote();
    const [c1] = crewOf(s);
    s = apply(s, { type: 'vote', playerId: c1.playerId!, seat: imposterOf(s).index, at: 1 }).state;
    s = apply(s, { type: 'timeout', at: 5 }).state;
    expect(s.phase).toBe('steal');
    expect(s.round!.ejected).toBe(imposterOf(s).index);
  });
});

/** State in the steal phase with the imposter ejected. */
function inSteal(seed = 42): RoomState {
  let s = inVote(seed);
  const imp = imposterOf(s);
  for (const c of crewOf(s)) s = apply(s, { type: 'vote', playerId: c.playerId!, seat: imp.index, at: 1 }).state;
  s = apply(s, { type: 'vote', playerId: imp.playerId!, seat: crewOf(s)[0].index, at: 2 }).state;
  expect(s.phase).toBe('steal');
  return s;
}

describe('steal', () => {
  it('an exact guess flips the round to an imposter win', () => {
    const s0 = inSteal();
    const guess = ` ${s0.round!.word.toUpperCase()} `;
    const s1 = apply(s0, { type: 'steal', playerId: imposterOf(s0).playerId!, word: guess, at: 9 }).state;
    expect(s1.phase).toBe('reveal');
    expect(s1.round!.result).toBe('imposter');
    expect(s1.round!.stealGuess).toBe(guess.trim());
  });

  it('a wrong guess or a timeout is a crew win', () => {
    const s0 = inSteal();
    const wrong = apply(s0, { type: 'steal', playerId: imposterOf(s0).playerId!, word: 'nope', at: 9 }).state;
    expect(wrong.phase).toBe('reveal');
    expect(wrong.round!.result).toBe('crew');
    expect(wrong.round!.stealGuess).toBe('nope');
    const late = apply(s0, { type: 'timeout', at: 9 }).state;
    expect(late.phase).toBe('reveal');
    expect(late.round!.result).toBe('crew');
    expect(late.round!.stealGuess).toBeNull();
  });

  it('only the imposter may steal, and only during the steal phase', () => {
    const s0 = inSteal();
    const crew = crewOf(s0)[0];
    expect(apply(s0, { type: 'steal', playerId: crew.playerId!, word: 'x', at: 1 }).effects[0].code).toBe('not-imposter');
    expect(apply(inVote(), { type: 'steal', playerId: 'p0', word: 'x', at: 1 }).effects[0].code).toBe('wrong-phase');
  });
});

describe('again', () => {
  it('returns humans to a fresh lobby, dropping bots, aliases, clues, votes, and the round', () => {
    const s0 = inSteal();
    const done = apply(s0, { type: 'timeout', at: 1 }).state;
    const s1 = apply(done, { type: 'again', playerId: 'p1', at: 2 }).state;
    expect(s1.phase).toBe('lobby');
    expect(s1.phaseEndsAt).toBeNull();
    expect(s1.round).toBeNull();
    expect(s1.transcript).toEqual([]);
    expect(s1.seats.map((s) => s.playerId).sort()).toEqual(['p0', 'p1', 'p2']);
    expect(s1.seats.map((s) => s.index)).toEqual([0, 1, 2]);
    for (const seat of s1.seats) {
      expect(seat).toMatchObject({ kind: 'human', alias: null, isImposter: false, clues: [], vote: null });
    }
    expect(apply(s1, { type: 'start', playerId: 'p0', at: 3, seed: 5 }).state.phase).toBe('clue');
  });

  it('is rejected before the reveal', () => {
    expect(apply(inVote(), { type: 'again', playerId: 'p0', at: 1 }).effects[0].code).toBe('wrong-phase');
  });
});

describe('timeout in untimed phases', () => {
  it('is a no-op at the reveal', () => {
    const done = apply(inSteal(), { type: 'timeout', at: 1 }).state;
    expect(apply(done, { type: 'timeout', at: 2 }).state).toBe(done);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/game/state.test.ts`
Expected: FAIL on `vote` (wrong-phase), `steal`, `again`, and the chat timeout test.

- [ ] **Step 3: Replace the four stubs in `src/game/state.ts`**

Replace the `vote`, `steal`, `again`, and `timeout` functions with:

```ts
function enterVote(state: RoomState, at: number): RoomState {
  return { ...state, phase: 'vote', phaseEndsAt: at + DURATIONS.vote, seats: state.seats.map((s) => ({ ...s, vote: null })) };
}

function finish(state: RoomState, result: Outcome): RoomState {
  return { ...state, phase: 'reveal', phaseEndsAt: null, round: { ...state.round!, result } };
}

function closeVote(state: RoomState, at: number): RoomState {
  const ejected = resolveVote(state.seats.map((s) => s.vote));
  const withEjected: RoomState = { ...state, round: { ...state.round!, ejected } };
  if (ejected === null || !state.seats[ejected].isImposter) return finish(withEjected, 'imposter');
  // A bot imposter has nobody to make the steal guess (M3 gives bots one).
  if (state.seats[ejected].kind === 'bot') return finish(withEjected, 'crew');
  return { ...withEjected, phase: 'steal', phaseEndsAt: at + DURATIONS.steal };
}

function vote(state: RoomState, event: Extract<Event, { type: 'vote' }>): Result {
  const seat = seatOf(state, event.playerId);
  if (!seat) return fail(state, event.playerId, 'not-seated', 'Join the room first');
  if (state.phase !== 'vote') return fail(state, event.playerId, 'wrong-phase', 'Voting is closed');
  if (!Number.isInteger(event.seat) || event.seat < 0 || event.seat >= state.seats.length || event.seat === seat.index) {
    return fail(state, event.playerId, 'bad-vote', 'Vote for another seat');
  }
  const seats = state.seats.map((s) => (s.index === seat.index ? { ...s, vote: event.seat } : s));
  const next = { ...state, seats };
  const allIn = seats.every((s) => s.kind !== 'human' || s.vote !== null);
  return ok(allIn ? closeVote(next, event.at) : next);
}

function steal(state: RoomState, event: Extract<Event, { type: 'steal' }>): Result {
  const seat = seatOf(state, event.playerId);
  if (!seat) return fail(state, event.playerId, 'not-seated', 'Join the room first');
  if (state.phase !== 'steal') return fail(state, event.playerId, 'wrong-phase', 'No steal in progress');
  if (!seat.isImposter) return fail(state, event.playerId, 'not-imposter', 'Only the imposter can steal');
  const guess = event.word.trim().slice(0, 40);
  const result: Outcome = isStealCorrect(guess, state.round!.word) ? 'imposter' : 'crew';
  return ok(finish({ ...state, round: { ...state.round!, stealGuess: guess } }, result));
}

function again(state: RoomState, event: Extract<Event, { type: 'again' }>): Result {
  const seat = seatOf(state, event.playerId);
  if (!seat) return fail(state, event.playerId, 'not-seated', 'Join the room first');
  if (state.phase !== 'reveal') return fail(state, event.playerId, 'wrong-phase', 'The round is still going');
  const seats = state.seats
    .filter((s) => s.kind === 'human')
    .map((s, index) => ({ ...s, index, alias: null, isImposter: false, clues: [], vote: null }));
  return ok({ ...state, phase: 'lobby', phaseEndsAt: null, seats, transcript: [], round: null });
}

function timeout(state: RoomState, event: Extract<Event, { type: 'timeout' }>): Result {
  switch (state.phase) {
    case 'clue':
      return ok(skipBotClues(recordClue(state, '', event.at), event.at));
    case 'chat':
      return ok(enterVote(state, event.at));
    case 'vote':
      return ok(closeVote(state, event.at));
    case 'steal':
      return ok(finish(state, 'crew'));
    default:
      return ok(state);
  }
}
```

Update the rules import at the top of the file to:

```ts
import { chooseImposter, DURATIONS, isStealCorrect, resolveVote } from './rules';
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/game/state.ts test/game/state.test.ts
git commit -m "Vote, steal, reveal, and play again in the reducer

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MrLZUUQrsJ4cV7L4ApiNU9"
```

---

### Task 6: Redaction of round data and the reveal

**Files:**
- Modify: `src/game/redact.ts` (replace whole file)
- Test: `test/game/redact.test.ts` (replace whole file)

**Interfaces:**
- Consumes: `RoomState`, `Round`, `Seat` (state.ts); `Snapshot`, `SeatView`, `RoundView` (protocol.ts).
- Produces: `redact(state: RoomState, viewerPlayerId: string | null): Snapshot` (signature unchanged).

- [ ] **Step 1: Write the failing tests (replace `test/game/redact.test.ts`)**

```ts
import { describe, it, expect } from 'vitest';
import { apply, createRoom, type RoomState } from '../../src/game/state';
import { redact } from '../../src/game/redact';

function lobby(): RoomState {
  let state = createRoom('ABCD', 0);
  state = apply(state, { type: 'join', playerId: 'p0', displayName: 'Ada', at: 0 }).state;
  state = apply(state, { type: 'join', playerId: 'p1', displayName: 'Bob', at: 0 }).state;
  state = apply(state, { type: 'join', playerId: 'p2', displayName: 'Cal', at: 0 }).state;
  return apply(state, { type: 'chat', playerId: 'p0', text: 'hey', at: 1 }).state;
}

function inClue(): RoomState {
  return apply(lobby(), { type: 'start', playerId: 'p0', at: 10, seed: 1 }).state;
}

function inChat(): RoomState {
  let s = inClue();
  while (s.phase === 'clue') s = apply(s, { type: 'timeout', at: 20 }).state;
  return apply(s, { type: 'chat', playerId: 'p1', text: 'sus', at: 21 }).state;
}

function inVote(): RoomState {
  return apply(inChat(), { type: 'timeout', at: 30 }).state;
}

function imposterOf(state: RoomState) {
  return state.seats.find((s) => s.isImposter)!;
}

function inSteal(): RoomState {
  let s = inVote();
  const imp = imposterOf(s);
  for (const seat of s.seats) {
    if (seat.kind !== 'human' || seat.isImposter) continue;
    s = apply(s, { type: 'vote', playerId: seat.playerId!, seat: imp.index, at: 40 }).state;
  }
  const crew = s.seats.find((seat) => seat.kind === 'human' && !seat.isImposter)!;
  s = apply(s, { type: 'vote', playerId: imp.playerId!, seat: crew.index, at: 41 }).state;
  expect(s.phase).toBe('steal');
  return s;
}

function inReveal(): RoomState {
  const s = inSteal();
  return apply(s, { type: 'steal', playerId: imposterOf(s).playerId!, word: 'nope', at: 50 }).state;
}

const HUMANS = ['p0', 'p1', 'p2'];
/** Fields that must never reach a viewer about another seat before the reveal. */
const OTHER_SEAT_SECRETS = ['playerId', 'kind', 'isImposter', 'displayName', 'vote'];

describe('redact before the reveal', () => {
  const phases = { clue: inClue, chat: inChat, vote: inVote, steal: inSteal };

  it.each(Object.entries(phases))('in the %s phase never exposes identity fields of other seats', (_name, make) => {
    const state = make();
    for (const viewer of [...HUMANS, null]) {
      const snap = redact(state, viewer);
      for (const seat of snap.seats) {
        if (seat.index === snap.you) continue;
        for (const key of OTHER_SEAT_SECRETS) expect(seat).not.toHaveProperty(key);
      }
      expect(JSON.stringify(snap)).not.toContain('"playerId"');
      expect(snap.round!.stealGuess).toBeNull();
    }
  });

  it.each(Object.entries(phases))('in the %s phase hides the word from the imposter and from non-viewers, shows it to crew', (_name, make) => {
    const state = make();
    const imp = imposterOf(state);
    const impSnap = redact(state, imp.playerId!);
    expect(impSnap.round!.word).toBeNull();
    expect(impSnap.round!.category).toBe(state.round!.category);
    expect(JSON.stringify(impSnap).toLowerCase()).not.toContain(state.round!.word);
    expect(redact(state, null).round!.word).toBeNull();
    for (const id of HUMANS) {
      if (id === imp.playerId) continue;
      expect(redact(state, id).round!.word).toBe(state.round!.word);
    }
  });

  it('shows your own kind and imposter flag, and public clues for everyone', () => {
    const state = inChat();
    const imp = imposterOf(state);
    const snap = redact(state, imp.playerId!);
    expect(snap.seats[snap.you!]).toMatchObject({ kind: 'human', isImposter: true, displayName: imp.displayName });
    for (const seat of snap.seats) expect(seat.clues).toEqual(state.seats[seat.index].clues);
  });

  it('exposes clueSeat only during the clue phase and voted flags during the vote', () => {
    expect(redact(inClue(), 'p0').round!.clueSeat).toBe(inClue().round!.clueSeat);
    expect(redact(inChat(), 'p0').round!.clueSeat).toBeNull();
    let s = inVote();
    const imp = imposterOf(s);
    const voter = s.seats.find((seat) => seat.kind === 'human' && !seat.isImposter)!;
    s = apply(s, { type: 'vote', playerId: voter.playerId!, seat: imp.index, at: 1 }).state;
    const snap = redact(s, imp.playerId!);
    expect(snap.seats[voter.index].voted).toBe(true);
    expect(snap.seats[voter.index]).not.toHaveProperty('vote');
    expect(snap.seats.filter((seat) => seat.voted)).toHaveLength(1);
  });

  it('copies code, phase, phaseEndsAt, connection flags, and transcript', () => {
    const state = inChat();
    const snap = redact(state, 'p0');
    expect(snap.code).toBe('ABCD');
    expect(snap.phase).toBe('chat');
    expect(snap.phaseEndsAt).toBe(state.phaseEndsAt);
    expect(snap.transcript).toEqual(state.transcript);
    expect(snap.seats.map((s) => s.connected)).toEqual(state.seats.map((s) => s.connected));
  });
});

describe('redact in the lobby', () => {
  it('shows display names to everyone, kind and imposter flag only to yourself, no round', () => {
    const snap = redact(lobby(), 'p1');
    expect(snap.you).toBe(1);
    expect(snap.round).toBeNull();
    expect(snap.phaseEndsAt).toBeNull();
    expect(snap.seats.map((s) => s.displayName)).toEqual(['Ada', 'Bob', 'Cal']);
    expect(snap.seats[0].kind).toBeUndefined();
    expect(snap.seats[1]).toMatchObject({ kind: 'human', isImposter: false });
  });

  it('gives an unknown viewer you=null', () => {
    expect(redact(lobby(), 'nobody').you).toBeNull();
  });
});

describe('redact at the reveal', () => {
  it('exposes names, kinds, imposter flags, votes, the word, and the steal guess to everyone, never playerId', () => {
    const state = inReveal();
    for (const viewer of HUMANS) {
      const snap = redact(state, viewer);
      expect(snap.phase).toBe('reveal');
      expect(snap.round).toMatchObject({ word: state.round!.word, stealGuess: 'nope', result: 'crew', ejected: imposterOf(state).index });
      for (const seat of snap.seats) {
        const real = state.seats[seat.index];
        expect(seat).toMatchObject({ kind: real.kind, isImposter: real.isImposter, vote: real.vote });
        if (real.kind === 'human') expect(seat.displayName).toBe(real.displayName);
      }
      expect(JSON.stringify(snap)).not.toContain('"playerId"');
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/game/redact.test.ts`
Expected: FAIL: `snap.round` is undefined, `clues` missing, and so on.

- [ ] **Step 3: Replace `src/game/redact.ts`**

```ts
import type { RoomState } from './state';
import type { RoundView, SeatView, Snapshot } from './protocol';

/**
 * The only path from room state to a client. Before the reveal, other seats
 * expose only alias, connection state, public clues, and whether they have
 * voted; the imposter never receives the word. At the reveal everything but
 * playerId is public.
 */
export function redact(state: RoomState, viewerPlayerId: string | null): Snapshot {
  const you = viewerPlayerId === null ? undefined : state.seats.find((s) => s.playerId === viewerPlayerId);
  const lobby = state.phase === 'lobby';
  const reveal = state.phase === 'reveal';

  const seats: SeatView[] = state.seats.map((s) => {
    const mine = you !== undefined && s.index === you.index;
    const view: SeatView = { index: s.index, alias: s.alias, connected: s.connected, clues: s.clues, voted: s.vote !== null };
    if (mine || lobby || reveal) view.displayName = s.displayName;
    if (mine || reveal) {
      view.kind = s.kind;
      view.isImposter = s.isImposter;
    }
    if (reveal) view.vote = s.vote;
    return view;
  });

  const r = state.round;
  const round: RoundView | null =
    r === null
      ? null
      : {
          category: r.category,
          word: reveal || (you !== undefined && !you.isImposter) ? r.word : null,
          clueSeat: state.phase === 'clue' ? r.clueSeat : null,
          cluePass: r.cluePass,
          ejected: r.ejected,
          stealGuess: reveal ? r.stealGuess : null,
          result: r.result,
        };

  return {
    code: state.code,
    phase: state.phase,
    you: you ? you.index : null,
    phaseEndsAt: state.phaseEndsAt,
    seats,
    transcript: state.transcript,
    round,
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/game/redact.ts test/game/redact.test.ts
git commit -m "Redact round data: hide the word from the imposter, expose everything at the reveal

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MrLZUUQrsJ4cV7L4ApiNU9"
```

---

### Task 7: Room Durable Object: new messages, alarm sync, timeouts

The DO has one alarm slot. After every event it mirrors `state.phaseEndsAt` into that alarm; when the room is untimed and empty it uses the alarm as the 10-minute deletion TTL; otherwise it clears it. When the alarm fires during a timed phase it dispatches `timeout`. Alarms are trusted: the DO does not compare `Date.now()` to the deadline, which is what lets tests fire phases early with `runDurableObjectAlarm`.

**Files:**
- Modify: `src/worker/room.ts` (replace whole file)
- Test: `test/worker/round.test.ts` (new), `test/worker/room.test.ts` (tighten one assertion)

**Interfaces:**
- Consumes: `apply`, `Event`, `RoomState`, `createRoom` (state.ts); `redact`; `ClientMessage`, `ServerMessage`.
- Produces: wire behaviour for `clue`, `vote`, `steal`, `again`; `state` broadcasts after every event including timeouts.

- [ ] **Step 1: Write the failing round tests**

Create `test/worker/round.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { connect, createRoom, type Client } from './helpers';
import type { Snapshot } from '../../src/game/protocol';

const NAMES = ['Ada', 'Bob', 'Cal'];
/** Distinct clue words. `clue0`/`clue1` would all normalize to `clue` and be rejected as duplicates. */
const CLUE_WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];

/** Three humans in the clue phase. `seatOf[i]` is the seat index of player i; `byYou(seat)` returns that seat's client. */
async function startedRoom() {
  const code = await createRoom();
  const clients: Client[] = [];
  const snaps: Snapshot[] = [];
  for (let i = 0; i < NAMES.length; i++) {
    const c = await connect(code);
    c.send({ type: 'join', playerId: `p${i}`, displayName: NAMES[i] });
    await c.state((s) => s.you === i);
    clients.push(c);
  }
  clients[0].send({ type: 'start' });
  for (const c of clients) snaps.push(await c.state((s) => s.phase === 'clue'));
  const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
  const fireAlarm = async () => {
    expect(await runDurableObjectAlarm(stub)).toBe(true);
  };
  const byYou = (seat: number) => clients[snaps.findIndex((s) => s.you === seat)];
  const imposterClientIndex = snaps.findIndex((s) => s.seats[s.you!].isImposter);
  return { code, clients, snaps, fireAlarm, byYou, imposterClientIndex };
}

/** Plays every human clue turn with an accepted clue and returns the first chat-phase snapshot seen by client 0. */
async function playClues(room: Awaited<ReturnType<typeof startedRoom>>): Promise<Snapshot> {
  let snap = room.snaps[0];
  let n = 0;
  while (snap.phase === 'clue') {
    const turn = snap.round!.clueSeat!;
    expect(n).toBeLessThan(CLUE_WORDS.length); // a rejected clue would otherwise loop forever
    room.byYou(turn).send({ type: 'clue', word: CLUE_WORDS[n++] });
    snap = await room.clients[0].state((s) => s.phase !== 'clue' || s.round!.clueSeat !== turn);
  }
  expect(n).toBe(6);
  return snap;
}

describe('a round in the Room Durable Object', () => {
  it('starts in the clue phase on a human turn, with exactly one human imposter who cannot see the word', async () => {
    const { snaps, imposterClientIndex } = await startedRoom();
    const first = snaps[0];
    expect(typeof first.phaseEndsAt).toBe('number');
    expect(first.seats[first.round!.clueSeat!].clues).toEqual([]);
    expect(snaps.map((s) => s.you)).toContain(first.round!.clueSeat);
    expect(snaps.filter((s) => s.seats[s.you!].isImposter)).toHaveLength(1);
    expect(snaps[imposterClientIndex].round!.word).toBeNull();
    for (let i = 0; i < snaps.length; i++) {
      if (i === imposterClientIndex) continue;
      expect(typeof snaps[i].round!.word).toBe('string');
      expect(snaps[i].round!.category).toBe(snaps[imposterClientIndex].round!.category);
    }
  });

  it('rejects out-of-turn and two-word clues, accepts a valid one', async () => {
    const room = await startedRoom();
    const turn = room.snaps[0].round!.clueSeat!;
    const other = room.clients.find((c) => c !== room.byYou(turn))!;
    other.send({ type: 'clue', word: 'sneaky' });
    expect(await other.error()).toBe('not-your-turn');
    room.byYou(turn).send({ type: 'clue', word: 'two words' });
    expect(await room.byYou(turn).error()).toBe('clue-one-word');
    room.byYou(turn).send({ type: 'clue', word: 'fine' });
    const next = await room.clients[0].state((s) => s.seats[turn].clues.length === 1);
    expect(next.seats[turn].clues).toEqual(['fine']);
  });

  it('a clue timeout passes the turn as an empty clue', async () => {
    const room = await startedRoom();
    const turn = room.snaps[0].round!.clueSeat!;
    await room.fireAlarm();
    const next = await room.clients[0].state((s) => s.seats[turn].clues.length === 1);
    expect(next.seats[turn].clues).toEqual(['']);
    expect(next.round!.clueSeat).not.toBe(turn);
  });

  it('plays clues, chat, vote, a missed steal, the reveal, and play again', async () => {
    const room = await startedRoom();
    const chat = await playClues(room);
    expect(chat.phase).toBe('chat');
    room.clients[1].send({ type: 'chat', text: 'who said alpha?' });
    await room.clients[0].state((s) => s.transcript.length === 1);

    await room.fireAlarm();
    const voting = await room.clients[0].state((s) => s.phase === 'vote');
    expect(typeof voting.phaseEndsAt).toBe('number');

    const impSeat = room.snaps[room.imposterClientIndex].you!;
    const crew = room.clients.filter((_, i) => i !== room.imposterClientIndex);
    for (const c of crew) c.send({ type: 'vote', seat: impSeat });
    const crewSeat = room.snaps.find((s) => s.you !== impSeat)!.you!;
    room.clients[room.imposterClientIndex].send({ type: 'vote', seat: crewSeat });

    const stealing = await room.clients[room.imposterClientIndex].state((s) => s.phase === 'steal');
    expect(stealing.round!.ejected).toBe(impSeat);
    room.clients[room.imposterClientIndex].send({ type: 'steal', word: 'definitely-wrong' });

    const reveal = await room.clients[0].state((s) => s.phase === 'reveal');
    expect(reveal.round).toMatchObject({ result: 'crew', stealGuess: 'definitely-wrong', ejected: impSeat });
    expect(typeof reveal.round!.word).toBe('string');
    expect(reveal.phaseEndsAt).toBeNull();
    for (const seat of reveal.seats) {
      expect(seat.kind === 'human' || seat.kind === 'bot').toBe(true);
      expect(typeof seat.isImposter).toBe('boolean');
    }
    expect(reveal.seats.filter((s) => s.kind === 'human').map((s) => s.displayName).sort()).toEqual([...NAMES].sort());
    expect(JSON.stringify(reveal)).not.toContain('"playerId"');

    room.clients[2].send({ type: 'again' });
    const lobby = await room.clients[0].state((s) => s.phase === 'lobby');
    expect(lobby.seats).toHaveLength(3);
    expect(lobby.round).toBeNull();
    expect(lobby.seats.map((s) => s.displayName).sort()).toEqual([...NAMES].sort());
  });

  it('a vote timeout with no majority ends the round as an imposter win', async () => {
    const room = await startedRoom();
    await playClues(room);
    await room.fireAlarm();
    await room.clients[0].state((s) => s.phase === 'vote');
    await room.fireAlarm();
    const reveal = await room.clients[0].state((s) => s.phase === 'reveal');
    expect(reveal.round).toMatchObject({ result: 'imposter', ejected: null });
  });

  it('the imposter never receives the word before the reveal', async () => {
    const room = await startedRoom();
    const imp = room.clients[room.imposterClientIndex];
    const word = room.snaps.find((_, i) => i !== room.imposterClientIndex)!.round!.word!;
    await playClues(room);
    await room.fireAlarm();
    await room.fireAlarm();
    let leaked = false;
    let snap: Snapshot;
    do {
      snap = await imp.state();
      if (snap.phase !== 'reveal' && JSON.stringify(snap).toLowerCase().includes(word)) leaked = true;
    } while (snap.phase !== 'reveal');
    expect(leaked).toBe(false);
    expect(snap.round!.word).toBe(word);
  });
});
```

In `test/worker/room.test.ts`, tighten the start test: change `await b.state((s) => s.phase !== 'lobby')` in the test named `start fills six aliased seats...` to `await b.state((s) => s.phase === 'clue')`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/worker`
Expected: FAIL: `clue` is answered with `unknown-type`, no phase advances.

- [ ] **Step 3: Replace `src/worker/room.ts`**

```ts
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import { apply, createRoom, type Event, type RoomState } from '../game/state';
import { redact } from '../game/redact';
import type { ClientMessage, ServerMessage } from '../game/protocol';

const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;

interface Attachment {
  playerId: string | null;
}

export class RoomObject extends DurableObject<Env> {
  private state: RoomState | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get<RoomState>('state')) ?? null;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/create' && request.method === 'POST') {
      const created = !this.state;
      if (!this.state) {
        this.state = createRoom(url.searchParams.get('code') ?? '????', Date.now());
        await this.save();
      }
      await this.syncAlarm();
      return Response.json({ created });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.serializeAttachment({ playerId: null } satisfies Attachment);
    this.ctx.acceptWebSocket(server);

    if (!this.state) {
      // Accept so the browser gets a readable error instead of a bare connection failure.
      this.send(server, { type: 'error', code: 'room-not-found', message: 'No room with that code' });
      server.close(4004, 'room-not-found');
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string' || !this.state) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.send(ws, { type: 'error', code: 'bad-json', message: 'Malformed message' });
      return;
    }
    if (parsed === null || typeof parsed !== 'object') {
      this.send(ws, { type: 'error', code: 'bad-json', message: 'Malformed message' });
      return;
    }
    const msg = parsed as ClientMessage;
    const att = ws.deserializeAttachment() as Attachment;
    const at = Date.now();
    let event: Event;

    if (msg.type === 'join') {
      if (typeof msg.playerId !== 'string' || msg.playerId.length === 0 || msg.playerId.length > 64) {
        this.send(ws, { type: 'error', code: 'bad-join', message: 'Missing playerId' });
        return;
      }
      ws.serializeAttachment({ playerId: msg.playerId } satisfies Attachment);
      event = { type: 'join', playerId: msg.playerId, displayName: String(msg.displayName ?? ''), at };
    } else if (!att.playerId) {
      this.send(ws, { type: 'error', code: 'not-joined', message: 'Send join first' });
      return;
    } else if (msg.type === 'chat') {
      event = { type: 'chat', playerId: att.playerId, text: String(msg.text ?? ''), at };
    } else if (msg.type === 'start') {
      event = { type: 'start', playerId: att.playerId, at, seed: crypto.getRandomValues(new Uint32Array(1))[0] };
    } else if (msg.type === 'clue') {
      event = { type: 'clue', playerId: att.playerId, word: String(msg.word ?? ''), at };
    } else if (msg.type === 'vote') {
      event = { type: 'vote', playerId: att.playerId, seat: Number(msg.seat), at };
    } else if (msg.type === 'steal') {
      event = { type: 'steal', playerId: att.playerId, word: String(msg.word ?? ''), at };
    } else if (msg.type === 'again') {
      event = { type: 'again', playerId: att.playerId, at };
    } else {
      this.send(ws, { type: 'error', code: 'unknown-type', message: 'Unknown message type' });
      return;
    }

    await this.dispatch(event);
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
    const att = ws.deserializeAttachment() as Attachment;
    const others = this.ctx.getWebSockets().filter((o) => o !== ws);
    if (att.playerId && this.state) {
      const stillOpen = others.some((o) => (o.deserializeAttachment() as Attachment).playerId === att.playerId);
      if (!stillOpen) await this.dispatch({ type: 'disconnect', playerId: att.playerId });
    }
    await this.syncAlarm();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, 'error');
  }

  /**
   * One alarm slot, two jobs. During a timed phase the alarm is the phase
   * deadline and fires a `timeout` event. Otherwise it is the empty-room TTL:
   * with nobody connected the room deletes itself.
   */
  async alarm(): Promise<void> {
    if (this.state && this.state.phaseEndsAt !== null) {
      await this.dispatch({ type: 'timeout', at: Date.now() });
      return;
    }
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.deleteAll();
      this.state = null;
    }
  }

  private async dispatch(event: Event): Promise<void> {
    if (!this.state) return;
    const result = apply(this.state, event);
    this.state = result.state;
    await this.save();
    await this.syncAlarm();

    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment;
      for (const effect of result.effects) {
        if (effect.to === att.playerId) {
          this.send(ws, { type: 'error', code: effect.code, message: effect.message });
        }
      }
      const seated = att.playerId !== null && this.state.seats.some((s) => s.playerId === att.playerId);
      if (!seated) continue;
      this.send(ws, { type: 'state', snapshot: redact(this.state, att.playerId) });
    }
  }

  /** Mirrors the reducer's deadline into the DO alarm, or arms the deletion TTL when idle and empty. */
  private async syncAlarm(): Promise<void> {
    if (!this.state) return;
    if (this.state.phaseEndsAt !== null) {
      await this.ctx.storage.setAlarm(this.state.phaseEndsAt);
    } else if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.setAlarm(Date.now() + EMPTY_ROOM_TTL_MS);
    } else {
      await this.ctx.storage.deleteAlarm();
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // socket already gone; close handler will clean up
    }
  }

  private async save(): Promise<void> {
    if (this.state) await this.ctx.storage.put('state', this.state);
  }
}
```

Note the `'deletes an empty room when its alarm fires'` test from Task 1 still holds: a lobby has `phaseEndsAt === null`, so the alarm set by `syncAlarm` after the last close is the TTL, and firing it with no sockets deletes the room.

- [ ] **Step 4: Run to verify pass**

Run: `npm test && npm run typecheck`
Expected: PASS: 6 room tests, 6 round tests, all game tests. If `playClues` times out, check that `skipBotClues` ran on the server (bots should already have `['']` for seats before the first human).

- [ ] **Step 5: Commit**

```bash
git add src/worker/room.ts test/worker/room.test.ts test/worker/round.test.ts
git commit -m "Room DO drives the round: clue, vote, steal, again, and phase alarms

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MrLZUUQrsJ4cV7L4ApiNU9"
```

---

### Task 8: Client: phase views, countdown, reconnect backoff

One page, one `render()` that shows the sections for the current phase. Pure HTML builders live in `views.ts` so they stay readable. The countdown reads `phaseEndsAt` against the browser clock every 250ms. Reconnect uses exponential backoff (1s, 2s, 4s, 8s, then 10s) instead of a fixed 1s retry (M1 carry-over).

**Files:**
- Modify: `public/index.html` (replace whole file), `src/client/app.ts` (replace whole file)
- Create: `src/client/views.ts`

**Interfaces:**
- Consumes: `Snapshot`, `ClientMessage`, `ServerMessage` from `src/game/protocol.ts`.
- Produces: `esc`, `nameOf(snap, seat)`, `cardHtml(snap)`, `seatsHtml(snap)`, `turnHtml(snap)`, `voteHtml(snap)`, `revealHtml(snap)`, `logHtml(snap)`.

- [ ] **Step 1: Replace `public/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Imposter Turing</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; display: flex; justify-content: center; }
    main { width: 100%; max-width: 480px; padding: 16px; box-sizing: border-box; }
    [hidden] { display: none !important; }
    input, button { font: inherit; padding: 8px 12px; }
    label { display: block; margin-bottom: 12px; }
    .row { display: flex; gap: 8px; margin-bottom: 8px; }
    .row input { flex: 1; min-width: 0; }
    h2 { display: flex; align-items: baseline; gap: 8px; }
    h2 small { font-weight: normal; opacity: 0.7; }
    .timer { margin-left: auto; font-variant-numeric: tabular-nums; font-size: 1.2em; }
    .card { border: 1px solid #8884; border-radius: 8px; padding: 12px; margin: 8px 0; }
    .card b { font-size: 1.3em; }
    #seats { margin: 8px 0; }
    .seat { padding: 4px 0; display: flex; gap: 8px; align-items: baseline; }
    .seat.off { opacity: 0.5; }
    .seat.turn { font-weight: bold; }
    .seat .clues { opacity: 0.7; font-size: 0.9em; }
    #vote button { display: block; width: 100%; margin: 6px 0; text-align: left; }
    #log { height: 40vh; overflow-y: auto; border: 1px solid #8884; padding: 8px; margin: 8px 0; }
    .line { margin: 4px 0; overflow-wrap: anywhere; }
    .line b { margin-right: 6px; }
    table { width: 100%; border-collapse: collapse; margin: 8px 0; }
    td, th { text-align: left; padding: 4px; border-bottom: 1px solid #8884; }
    .error { color: #c33; min-height: 1.2em; }
  </style>
</head>
<body>
  <main>
    <section id="home">
      <h1>Imposter Turing</h1>
      <label>Your name <input id="name" maxlength="20" autocomplete="nickname"></label>
      <div class="row"><button id="create">Create room</button></div>
      <div class="row">
        <input id="code" placeholder="Room code" maxlength="4" autocapitalize="characters">
        <button id="join">Join</button>
      </div>
    </section>

    <section id="room" hidden>
      <h2>Room <span id="room-code"></span> <small id="phase"></small> <span id="timer" class="timer"></span></h2>
      <div id="card" class="card" hidden></div>
      <div id="seats"></div>
      <button id="start" hidden>Start</button>
      <p id="turn" hidden></p>
      <form id="clue-form" class="row" hidden>
        <input id="clue" maxlength="20" autocomplete="off" placeholder="One-word clue">
        <button>Give clue</button>
      </form>
      <div id="vote" hidden></div>
      <form id="steal-form" class="row" hidden>
        <input id="steal" maxlength="40" autocomplete="off" placeholder="Guess the word">
        <button>Steal</button>
      </form>
      <p id="steal-wait" hidden>The imposter was caught and is guessing the word…</p>
      <div id="reveal" hidden></div>
      <button id="again" hidden>Play again</button>
      <div id="log" hidden></div>
      <form id="composer" class="row" hidden>
        <input id="text" maxlength="280" autocomplete="off" placeholder="Say something">
        <button>Send</button>
      </form>
    </section>

    <p id="error" class="error"></p>
  </main>
  <script type="module" src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `src/client/views.ts`**

```ts
import type { Snapshot } from '../game/protocol';

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
  return `<h3>${headline}</h3><p>${ejected}${steal} The word was <b>${esc(r.word ?? '')}</b>.</p><table><tr><th>Alias</th><th>Who</th><th></th><th>Voted for</th></tr>${rows}</table>`;
}

export function logHtml(snap: Snapshot): string {
  return snap.transcript
    .map((l) => `<div class="line"><b>${esc(nameOf(snap, l.seat))}</b>${esc(l.text)}</div>`)
    .join('');
}
```

- [ ] **Step 3: Replace `src/client/app.ts`**

```ts
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
  showError('');
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
```

- [ ] **Step 4: Typecheck and build**

Run: `npm run typecheck && npm run build:client`
Expected: clean; `public/app.js` rebuilt (it is gitignored).

- [ ] **Step 5: Play a round by hand**

Run `npm run dev`. Open http://localhost:8787 in one normal window and two private windows (each private window gets its own playerId). Create a room, join with the other two, press Start, and check:

- Bots' seats already show "(no clue)" and the first turn is a human, with a 20s countdown.
- The imposter's card shows only the category; the other two see the word.
- Submitting the secret word from a crew window shows "That is the word itself" and the timer keeps running.
- After six clues the chat opens for 90s. The vote page lists five buttons. Two votes on the imposter close the vote early and the imposter sees the steal form while others see the waiting line.
- The reveal names everyone, shows the word, the steal guess, and "Crew wins" or "Imposter wins". Play again returns all three to the lobby.
- Reload a window mid-round: it rejoins the same seat.

The Chrome extension was not connected on 2026-09-11. If it is still not connected, the headless Chrome DevTools driver used for the M1 demo is a good way to screenshot this; it is not required for the commit.

- [ ] **Step 6: Commit**

```bash
git add public/index.html src/client/app.ts src/client/views.ts
git commit -m "Client: clue, vote, steal, and reveal views with countdown and reconnect backoff

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MrLZUUQrsJ4cV7L4ApiNU9"
```

---

### Task 9: Smoke script, README, tag m2

The smoke script plays the clue phase against a real `wrangler dev` (bots are skipped, so with two humans it takes four clues) and stops at the chat phase, because waiting 90 seconds is not a smoke test; the alarm-driven Durable Object tests cover the rest.

**Files:**
- Modify: `scripts/smoke.mjs` (replace whole file), `README.md`

- [ ] **Step 1: Replace `scripts/smoke.mjs`**

```js
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
```

- [ ] **Step 2: Run it**

With `npm run dev` running in another terminal: `npm run smoke`
Expected: `SMOKE OK ...`.

- [ ] **Step 3: Update `README.md`**

Replace the intro paragraph's second sentence onward and the Check and Status sections so the file reads:

```markdown
# Imposter Turing

A chat-based social deduction game where humans and AI bots share a 6-seat
room. One seat is the imposter who does not know the word; every seat is
secretly a Knight (must tell the truth) or a Knave (must lie); empty seats
are bots trying to pass as human. Built for the See You in the Cosmos
adaptation assignment (theme: the curated self vs. the actual self).

Design spec: `docs/superpowers/specs/2026-09-04-imposter-turing-design.md`
Plans: `docs/superpowers/plans/`

## A round (as of m2)

1. **Lobby.** Create a room, share the 4-letter code, press Start with 1 to 6
   humans. Empty seats become bots (inert until m3).
2. **Clues.** Everyone gets an alias. One human is the imposter and sees only
   the category; everyone else sees the word. Two passes of one-word clues,
   20s per turn. The word itself and repeated clues are rejected.
3. **Chat.** 90s of open discussion.
4. **Vote.** 20s. A majority of votes cast ejects a seat.
5. **Steal.** An ejected imposter gets 15s to guess the word.
6. **Reveal.** Everyone's name, who was the imposter, who voted for whom,
   the word, and the result. Play again returns to the lobby.

## Run locally

```sh
npm install
npm run dev        # builds the client, serves on http://localhost:8787 (LAN: --ip 0.0.0.0 is on)
```

Open the URL on two devices, create a room on one, join with the code on
the other. The room URL includes `?room=CODE` and can be shared or reloaded
to rejoin the same seat. A room with nobody connected for 10 minutes deletes
itself.

## Check

```sh
npm test           # vitest inside the Workers runtime: src/game units + Room DO round tests
npm run typecheck  # worker + client
npm run smoke      # end-to-end through the clue phase against a running `npm run dev`
```

Tests run in workerd via `@cloudflare/vitest-pool-workers` (vitest 4). Phase
timeouts are tested by firing the Durable Object alarm directly. The smoke
script needs Node 22 or newer (global WebSocket).

## Deploy

```sh
npx wrangler login
npm run deploy
```

## Layout

- `src/game/` pure game logic (reducer, rules, words, redaction, aliases, protocol types)
- `src/worker/` Cloudflare Worker entry and Room Durable Object
- `src/client/` browser app, bundled to `public/app.js`
- `test/game/` vitest unit tests, `test/worker/` Durable Object tests
- `scripts/smoke.mjs` end-to-end smoke test

## Status

- [x] M1 chat room: rooms, aliases, live chat, reconnect
- [x] M2 Imposter round: word, imposter, clues, chat, vote, steal, reveal
- [ ] M3 bots
- [ ] M4 Knights and Knaves
```

- [ ] **Step 4: Final verification, commit, tag, push**

Run: `npm test && npm run typecheck && npm run smoke` (dev server running).
Expected: all green.

```bash
git add scripts/smoke.mjs README.md
git commit -m "Smoke plays the clue phase; README describes the m2 round

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MrLZUUQrsJ4cV7L4ApiNU9"
git tag m2
git push && git push --tags
```

---

## Carry-overs for the M3 plan

Recorded here so they are not lost; none of them block m2.

- **Imposter pool.** `chooseImposter` in `src/game/rules.ts` picks among humans only. M3 widens it to all seats once bots can clue, vote, and steal.
- **Bot turns.** `skipBotClues` in `src/game/state.ts` passes bot clue turns instantly and bots never vote or steal. M3 replaces it with `botTurn` effects handled by `src/worker/bots.ts`, and `closeVote`'s "bot imposter cannot steal" branch goes away.
- **Bot tells.** `connected: false` (only humans disconnect) and `voted: false` during the vote (bots never vote in M2) both identify bots. Both must be closed before bot-call scoring ships.
- **Rate-limit `POST /rooms`** before the public deploy.
- **Leak checklist.** `OTHER_SEAT_SECRETS` in `test/game/redact.test.ts` gains `role` in M4; the reveal test gains Knight/Knave columns.
- **Digits-only clues.** `normalizeWord` strips non-letters, so a clue of only
  digits or punctuation normalizes to the empty string, and the second such clue
  in a round is rejected as a duplicate. Harmless in play; tighten if it surfaces.
- **Clock skew.** The countdown compares the server's `phaseEndsAt` to the browser clock. If phones show timers that are off by seconds, add a `now` field to the snapshot and compute an offset on the client.
- **Transcript deltas.** Every event re-broadcasts the whole transcript (200 lines × 280 chars × 6 sockets). Switch to a `chat` delta message before bot chatter multiplies traffic.
- **Vote closes early.** `allIn` in `state.ts` counts disconnected humans, so a dropped player forces the full 20 s vote. Treat disconnected humans as done.
- **Ghost seats on `again`.** Disconnected humans keep their seats across Play Again and can fill the room. Drop seats disconnected at `again` time or add a kick.
- **Duplicate error effects.** A player with two tabs open receives each rejection once per socket. Harmless; dedupe if it shows.
- **`webSocketClose` vs `syncAlarm` socket counting.** The close handler filters the closing socket; `syncAlarm` counts the raw list. Verified equivalent by the TTL test; unify or comment.
- **Stemmer comment.** `words.ts` says "consonant doubling" but strips any doubled trailing letter (`agreeing` → `agre`). Harmless for the shipped lists.
- **Spec amendments.** Spec 4.2/4.3 still describe separate `chat {line}` and `reveal {fullState}` messages; M2 ships a single redacted `state` snapshot for both. Spec 2.3.1 ("a rejected clue returns an error") now has an imposter carve-out: the imposter's clue skips the secret-word check so the error code cannot be used as a word oracle. Update the spec text.
- **Alarm trust.** `alarm()` deliberately trusts delivery (no `Date.now()` guard) so tests can fire phases early. If a late alarm ever steals a turn in production, add the guard and advance the test clock instead.
