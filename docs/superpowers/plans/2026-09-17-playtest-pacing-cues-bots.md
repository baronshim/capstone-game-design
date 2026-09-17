# Playtest Pass 1: Pacing, Cues, Bot Presence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Act on the first playtest's feedback: slow the round down, add visual and audio cues for phase changes and turns, make bots wait longer before clueing and chatting, make them talk more, and make their language less flat.

**Architecture:** The reducer in `src/game/state.ts` stays the single source of truth for phases and bot timing (seeded jitter, pure functions). A new `deal` phase opens each round. Typing indicators are a new ephemeral message pair in `src/game/protocol.ts` relayed by the Durable Object in `src/worker/room.ts`, never stored in state. Bot voice lives in `src/worker/prompts.ts`; the runner in `src/worker/bots.ts` gains a single retry-with-feedback before falling back. All visual cues and audio are client-only in `src/client/` and `public/index.html`.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects, vitest with `@cloudflare/vitest-pool-workers`, esbuild client bundle, Workers AI Gemma 4 (live only). Web Audio API for sound.

**Spec:** `docs/superpowers/specs/2026-09-04-imposter-turing-design.md` sections 2.3 (phases), 5.1 (personas), 5.5 (pacing), 5.6 (model), 5.7 (validation). The brainstormed design for this pass is summarised in the Global Constraints below; the spec gets amended in Task 6.

## Global Constraints

- Phase durations after this pass: deal 6s, clue turn 30s, chat 150s, vote 30s, steal 20s, bot call 30s. Exact values in `DURATIONS` in `src/game/rules.ts`.
- Bot timing after this pass: clue delay 6 to 16s; chat 5 to 8 ticks per bot; two openers 8 to 18s after the chat opens; remaining ticks 15 to 140s; reply ticks 4 to 12s; reply chance 80% after a human line, 30% after a bot line; per-bot line cap 7; per-bot cooldown 6s; typing simulation 55ms per character capped at 6s.
- Typing indicator: client message `{ type: 'typing' }`; server message `{ type: 'typing'; seat: number; ms: number }`. Never stored in `RoomState`, never in a `Snapshot`. Humans and bots both produce it, so it is not a bot tell.
- Bot chat validation keeps every existing rejection (filler, emoji, near-duplicate, pure agreement, word leak, length); a rejected line gets ONE retry on the primary with the reason, then the scripted fallback.
- No new dependencies. No audio asset files; every sound is synthesized with `AudioContext`.
- Every commit runs `npm test` and `npm run typecheck` green first.
- Run tests with no `wrangler dev` process running (it produces flaky failures).
- Copy rules from the existing UI: sentence case, no exclamation marks in system copy, call signs coloured by their first word.

---

### Task 1: Longer phases and a `deal` phase

**Files:**
- Modify: `src/game/rules.ts:4-11` (DURATIONS)
- Modify: `src/game/protocol.ts:3` (Phase)
- Modify: `src/game/state.ts` (`start`, `timeout`, new `enterClue`)
- Modify: `src/client/views.ts:36-44` (PHASE_LABELS)
- Modify: `test/game/rules.test.ts:5-8`
- Modify: `test/game/state.test.ts` (helper `started`, every test that expects `start` to land in `clue`)
- Modify: `test/worker/round.test.ts:22` (`startedRoomOnce`), `test/worker/room.test.ts:39` and `:53`
- Modify: `scripts/smoke.mjs:32-33`

**Interfaces:**
- Produces: `Phase` includes `'deal'`. `DURATIONS = { deal: 6_000, clueTurn: 30_000, chat: 150_000, vote: 30_000, steal: 20_000, botcall: 30_000 }`. `start` lands in `deal` with `phaseEndsAt = at + DURATIONS.deal` and `round.clueSeat = 0`; a `timeout` in `deal` moves to `clue` with `phaseEndsAt = at + DURATIONS.clueTurn` and emits the first bot clue turn if seat 0 is a bot. `redact` already exposes `clueSeat` only in `clue`, so the deal snapshot shows `clueSeat: null`.
- Test helper produced for later tasks: `dealt(names?, seed?)` in `test/game/state.test.ts` returning the state after `start` and one `timeout` (i.e. in `clue`). Later tasks use `dealt` wherever `started` was used to reach the clue phase.

- [ ] **Step 1: Update the rules test**

In `test/game/rules.test.ts` change the `DURATIONS` expectation to:

```ts
expect(DURATIONS).toEqual({ deal: 6_000, clueTurn: 30_000, chat: 150_000, vote: 30_000, steal: 20_000, botcall: 30_000 });
```

- [ ] **Step 2: Write the failing state tests**

In `test/game/state.test.ts`, add next to `started`:

```ts
/** After the deal timeout: the first clue turn is open. */
export function dealt(names = ['Ada', 'Bob'], seed = 42): RoomState {
  return apply(started(names, seed), { type: 'timeout', at: 1000 + DURATIONS.deal }).state;
}
```

Add a `describe('deal phase')` block:

```ts
describe('deal phase', () => {
  it('start lands in deal for 6s with the card dealt, no clue turn open, and no bot effects', () => {
    const r = apply(roomWith(['Ada']), { type: 'start', playerId: 'p0', at: 1000, seed: 42 });
    expect(r.state.phase).toBe('deal');
    expect(r.state.phaseEndsAt).toBe(1000 + DURATIONS.deal);
    expect(r.state.round!.clueSeat).toBe(0);
    expect(r.state.round!.cluePass).toBe(1);
    expect(r.effects).toEqual([]);
  });

  it('a deal timeout opens the first clue turn and emits its bot turn when seat 0 is a bot', () => {
    const seed = seedFor(['Ada'], (s) => s.seats[0].kind === 'bot');
    const r = apply(started(['Ada'], seed), { type: 'timeout', at: 7000 });
    expect(r.state.phase).toBe('clue');
    expect(r.state.phaseEndsAt).toBe(7000 + DURATIONS.clueTurn);
    expect(r.state.round!.clueSeat).toBe(0);
    expect(r.effects).toMatchObject([{ type: 'botTurn', seat: 0, action: 'clue' }]);
  });

  it('a clue sent during the deal is refused as wrong-phase and a botClue during the deal is ignored', () => {
    const s = started(['Ada']);
    const r = apply(s, { type: 'clue', playerId: 'p0', word: 'early', at: 1500 });
    expect(r.state).toBe(s);
    expect(r.effects).toMatchObject([{ type: 'error', to: 'p0', code: 'wrong-phase' }]);
    expect(apply(s, { type: 'botClue', seat: 0, pass: 1, word: 'early', at: 1500 }).state).toBe(s);
  });
});
```

Then update the existing tests that assume `start` lands in `clue`. Rule: wherever a test builds a room with `started(...)` and then acts in the clue phase, or loops `while (phase === 'clue') timeout`, switch it to `dealt(...)`. `seedFor` keeps using `started` (seat layout is fixed at start, so the predicate result is the same). In the `bots` describe block, `startOne` becomes:

```ts
function startOne(seed: number) {
  const s = apply(roomWith(['Ada']), { type: 'start', playerId: 'p0', at: 1000, seed }).state;
  return apply(s, { type: 'timeout', at: 1000 + DURATIONS.deal });
}
```

and the first test in that block expects `phaseEndsAt` to be `1000 + DURATIONS.deal + DURATIONS.clueTurn`. Read every failing test's intent before editing it; do not delete assertions.

- [ ] **Step 3: Run the tests to see them fail**

Run: `npx vitest run test/game`
Expected: the new deal tests fail (`phase` is `'clue'`), and the DURATIONS test fails.

- [ ] **Step 4: Implement**

`src/game/protocol.ts`:

```ts
export type Phase = 'lobby' | 'deal' | 'clue' | 'chat' | 'vote' | 'steal' | 'botcall' | 'reveal';
```

`src/game/rules.ts`:

```ts
/** Phase lengths in milliseconds (spec 2.3). The deal is a shared beat to read the card before the first clue turn. */
export const DURATIONS = {
  deal: 6_000,
  clueTurn: 30_000,
  chat: 150_000,
  vote: 30_000,
  steal: 20_000,
  botcall: 30_000,
} as const;
```

`src/game/state.ts`, in `start`, change the final return to:

```ts
  // The deal: everyone reads their card for a few seconds before the first clue turn opens.
  return ok({ ...state, phase: 'deal', phaseEndsAt: event.at + DURATIONS.deal, seats, transcript: [], round });
```

Add before `recordClue`:

```ts
/** Opens the first clue turn once the deal has been read. */
function enterClue(state: RoomState, at: number): RoomState {
  return { ...state, phase: 'clue', phaseEndsAt: at + DURATIONS.clueTurn };
}
```

In `timeout`, add a case before `'clue'`:

```ts
    case 'deal':
      return ok(enterClue(state, event.at));
```

Check `botEffects`: its clue branch already fires on `prev.phase !== 'clue'`, so the deal-to-clue transition emits the first bot clue turn with no change. Confirm `clue()` and `botClue()` already reject or ignore outside `'clue'` (they do: `state.phase !== 'clue'`).

`src/client/views.ts` `PHASE_LABELS`: add `deal: 'deal'` between `lobby` and `clue`.

- [ ] **Step 5: Update the Durable Object tests and the smoke script**

`test/worker/round.test.ts` `startedRoomOnce`: after `clients[0].send({ type: 'start' })`, wait for the deal, fire the alarm, then wait for the clue phase:

```ts
  clients[0].send({ type: 'start' });
  for (const c of clients) await c.state((s) => s.phase === 'deal');
  const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  for (const c of clients) snaps.push(await c.state((s) => s.phase === 'clue'));
```

(Move the `stub` line up; `fireAlarm` keeps using it.) Add one DO test to `round.test.ts`:

```ts
  it('start opens a timed deal with no clue turn, and the deal alarm opens the first clue turn', async () => {
    const code = await createRoom();
    const a = await connect(code);
    a.send({ type: 'join', playerId: 'p0', displayName: 'Ada' });
    await a.state((s) => s.you === 0);
    a.send({ type: 'start' });
    const deal = await a.state((s) => s.phase === 'deal');
    expect(typeof deal.phaseEndsAt).toBe('number');
    expect(deal.round!.clueSeat).toBeNull();
    const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const clue = await a.state((s) => s.phase === 'clue');
    expect(clue.round!.clueSeat).toBe(0);
  });
```

`test/worker/room.test.ts`: the test at line 34 waits for `s.phase === 'clue'`; change to `s.phase === 'deal'`. The test at line 51 already waits for `!== 'lobby'`.

`scripts/smoke.mjs` lines 32-33: wait for `'deal'` first, then for `'clue'` with an 8s budget (the deal runs 6s of real time even with fake bots):

```js
await a.state((s) => s.phase === 'deal');
let snapA = await a.state((s) => s.phase === 'clue', 8000);
const snapB = await b.state((s) => s.phase === 'clue', 8000);
```

- [ ] **Step 6: Run everything**

Run: `npm test && npm run typecheck`
Expected: all green. If a state test still expects the old clue-turn `phaseEndsAt` arithmetic, fix the arithmetic to include the deal, do not weaken the assertion.

- [ ] **Step 7: Commit**

```bash
git add src/game/rules.ts src/game/protocol.ts src/game/state.ts src/client/views.ts test scripts/smoke.mjs
git commit -m "Slow the round down: 6s deal phase, longer clue, chat, vote, steal, and bot-call phases"
```

---

### Task 2: Bots take longer and speak more often

**Files:**
- Modify: `src/game/state.ts:146-167` (clue and vote delays), `:220-244` (`chatTicks`), `:261-277` (`replyTicks`)
- Modify: `src/worker/bots.ts:52-55` (line cap, cooldown)
- Modify: `src/worker/room.ts:9-11` (typing constants)
- Modify: `test/game/state.test.ts` (delay range assertions), `test/bots/bots.test.ts:147-163` (cap and cooldown test)

**Interfaces:**
- Consumes: `dealt()` from Task 1.
- Produces: constants other tasks reference: `MAX_BOT_LINES_PER_ROUND = 7`, `MIN_BOT_GAP_MS = 6000`, `TYPING_MS_PER_CHAR = 55`, `MAX_TYPING_MS = 6000`.

- [ ] **Step 1: Update the failing tests first**

`test/game/state.test.ts`:
- Bot clue turn test: rename to "...with a 6 to 16s delay"; expect `delay >= 6000` and `< 16_000`.
- Chat ticks test: rename to "entering the chat emits 5 to 8 chat ticks per bot with moves, two openers within 18s, none past 140s, and the first an open". Per bot: `mine.length >= 5` and `<= 8`; each `delayMs >= 8000` and `< 140_000`. Early openers: `ticks.filter((t) => t.delayMs < 18_000)` from exactly 2 seats, and no tick under 8000ms at all.
- Reply tick test: "4 to 12s later"; `delayMs >= 4000` and `< 12_000`.
- Vote delay test (around line 763) stays 3 to 12s; leave it.
- Find the reply-probability test if one exists (search `0.6` or `human than to` in the test file); update the expected rate if it asserts one.

`test/bots/bots.test.ts` line 147 test: rename to "silences a bot after its seventh line or within 6s of its last"; build seven lines instead of four, and check the cooldown boundary at 6000ms (a line at `last + 5999` is silenced, `last + 6000` is allowed).

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/game/state.test.ts test/bots/bots.test.ts`
Expected: the renamed tests fail on the ranges.

- [ ] **Step 3: Implement**

`src/game/state.ts`:

```ts
// clue turn (line ~151): people take a while to think of a word
out.push({ type: 'botTurn', seat: seat.index, action: 'clue', delayMs: 6000 + Math.floor(rng() * 10_000) });
```

`chatTicks` docstring and body:

```ts
/** Chat ticks for the phase (spec 5.5): 5 to 8 per bot, two bots open 8 to 18s in (people reread the clues first), the rest spread from 15s to 140s. */
function chatTicks(next: RoomState): BotTurn[] {
  ...
  bots.forEach((seat, order) => {
    const ticks = 5 + Math.floor(rng() * 4);
    const delays: number[] = [];
    if (order < 2) delays.push(8000 + Math.floor(rng() * 10_000));
    while (delays.length < ticks) delays.push(15_000 + Math.floor(rng() * 125_000));
    ...
```

`replyTicks`: both delays become `4000 + Math.floor(rng() * 8000)`; the react chance becomes `speaker.kind === 'human' ? 0.8 : 0.3`; update its docstring ("more often to a human (80%) than to another bot (30%)").

`src/worker/bots.ts`:

```ts
/** Chat lines a bot may post per round; a talkative human manages about this many in 150 seconds. */
export const MAX_BOT_LINES_PER_ROUND = 7;
/** A bot never posts two lines closer together than this; people do not double-post seconds apart. */
export const MIN_BOT_GAP_MS = 6000;
```

`src/worker/room.ts`:

```ts
/** Typing-time simulation for bot chat (spec 5.5): 55ms per character, at most 6s, so a line lands when a person could have typed it. */
export const TYPING_MS_PER_CHAR = 55;
export const MAX_TYPING_MS = 6000;
```

- [ ] **Step 4: Run everything**

Run: `npm test && npm run typecheck`
Expected: green. The fake-bot DO tests run in `instant` mode and do not wait out delays.

- [ ] **Step 5: Commit**

```bash
git add src/game/state.ts src/worker/bots.ts src/worker/room.ts test
git commit -m "Bots wait longer to clue and open the chat, then talk more: 5-8 ticks, cap 7, 6s cooldown, slower typing"
```

---

### Task 3: Typing indicators for humans and bots

**Files:**
- Modify: `src/game/protocol.ts:72-85` (messages)
- Modify: `src/worker/room.ts` (relay human typing; emit bot typing before the simulated typing sleep and before a bot clue)
- Modify: `src/client/app.ts` (send typing from the chat and clue inputs; keep a seat-to-expiry map; render)
- Modify: `src/client/views.ts` (`seatsHtml` and a new `typingHtml`)
- Modify: `public/index.html` (a `#typing` line under the log; a `.typing` tag style on seats)
- Test: `test/worker/room.test.ts`, `test/worker/round.test.ts`

**Interfaces:**
- Produces: `ClientMessage` gains `{ type: 'typing' }`. `ServerMessage` gains `{ type: 'typing'; seat: number; ms: number }`. `seatsHtml(snap, typing: Set<number>)` and `typingHtml(snap, typing: Set<number>): string`.
- Room DO rule: a human typing ping is relayed to every OTHER seated socket with `ms: 3000`, at most once per 1500ms per seat, only in phases where that seat could be writing (`lobby`, `chat`, `reveal`, or `clue` when it is that seat's turn). Bots emit `ms` equal to their typing sleep for chat, and `ms: 2500` followed by a 2500ms sleep before a clue is dispatched (skipped in `instant` mode, but the message is still sent so tests can see it).

- [ ] **Step 1: Write the failing DO tests**

`test/worker/room.test.ts`, inside the describe:

```ts
  it('relays a typing ping to the other seats only, and throttles repeats', async () => {
    const { a, b } = await lobbyWithTwo();
    a.send({ type: 'typing' });
    const seen = await b.next((m) => m.type === 'typing');
    expect(seen).toEqual({ type: 'typing', seat: 0, ms: 3000 });
    a.send({ type: 'typing' });
    a.send({ type: 'chat', text: 'done typing' });
    await b.state((s) => s.transcript.some((l) => l.text === 'done typing'));
    // The second ping came within 1.5s of the first, so nothing else arrived before the chat line.
    await expect(b.next((m) => m.type === 'typing')).rejects.toThrow(/timed out/);
  }, 8000);
```

`test/worker/round.test.ts`, inside the describe (fake bots):

```ts
  it('a bot announces typing before its clue and before its chat line', async () => {
    const room = await startedRoom();
    const botSeat = room.snaps[0].seats.find((s) => !room.humanSeats.includes(s.index))!.index;
    const typed = await room.clients[0].next((m) => m.type === 'typing' && m.seat === botSeat);
    expect(typed).toMatchObject({ type: 'typing', seat: botSeat });
    expect((typed as { ms: number }).ms).toBeGreaterThan(0);
  });
```

(The `next` helper drops earlier messages; with fake bots the first bot clue turn produces a typing message within milliseconds. If seat 0 is human the first bot to clue is still a bot seat, so the predicate matches any bot seat: change `botSeat` to a set of bot seats and test membership.)

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/worker`
Expected: `unknown-type` error for the ping; no typing message from bots.

- [ ] **Step 3: Implement the protocol and the DO**

`src/game/protocol.ts`:

```ts
export type ClientMessage =
  | ...existing...
  | { type: 'again' }
  /** The sender is writing; ephemeral, rate-limited by the room, never stored. */
  | { type: 'typing' };

export type ServerMessage =
  | { type: 'state'; snapshot: Snapshot }
  | { type: 'error'; code: string; message: string }
  /** A seat is writing; show an indicator for `ms` milliseconds or until that seat posts. Sent for humans and bots alike so it is not a tell. */
  | { type: 'typing'; seat: number; ms: number };
```

`src/worker/room.ts`:

```ts
/** A human typing ping shows for this long on the other screens, and repeats from one seat are dropped inside the throttle window. */
export const HUMAN_TYPING_MS = 3000;
const TYPING_THROTTLE_MS = 1500;
/** A bot "types" its clue for this long after the model answers, so the chip does not appear the instant the model returns. */
export const CLUE_TYPING_MS = 2500;
```

In the class: `private lastTyping = new Map<number, number>();`

In `webSocketMessage`, before the `else` that returns `unknown-type`:

```ts
    } else if (msg.type === 'typing') {
      this.relayTyping(att.playerId, at);
      return;
```

Add methods:

```ts
  /** Relays a seated human's typing ping to the other seated sockets, throttled per seat and only when that seat could be writing. */
  private relayTyping(playerId: string, at: number): void {
    if (!this.state) return;
    const seat = this.state.seats.find((s) => s.playerId === playerId);
    if (!seat) return;
    const ph = this.state.phase;
    const writing = ph === 'lobby' || ph === 'chat' || ph === 'reveal' || (ph === 'clue' && this.state.round?.clueSeat === seat.index);
    if (!writing) return;
    const last = this.lastTyping.get(seat.index) ?? 0;
    if (at - last < TYPING_THROTTLE_MS) return;
    this.lastTyping.set(seat.index, at);
    this.broadcastTyping(seat.index, HUMAN_TYPING_MS, playerId);
  }

  /** Sends a typing message to every seated socket except the one belonging to `except`. */
  private broadcastTyping(seat: number, ms: number, except: string | null = null): void {
    if (!this.state) return;
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment;
      if (att.playerId === null || att.playerId === except) continue;
      if (!this.state.seats.some((s) => s.playerId === att.playerId)) continue;
      this.send(ws, { type: 'typing', seat, ms });
    }
  }
```

In `runBot`, replace the block after `if (!event) return;`:

```ts
      if (event.type === 'botClue') {
        this.broadcastTyping(turn.seat, CLUE_TYPING_MS);
        if (!this.instant) await new Promise((r) => setTimeout(r, CLUE_TYPING_MS));
        if (!this.state?.round || this.state.round.seed !== seed) return;
        await this.dispatch({ ...event, at: Date.now() });
        return;
      }
      if (event.type !== 'botChat') {
        await this.dispatch(event);
        return;
      }
      const typingMs = Math.min(MAX_TYPING_MS, TYPING_MS_PER_CHAR * event.text.length);
      this.broadcastTyping(turn.seat, typingMs);
      if (!this.instant) await new Promise((r) => setTimeout(r, typingMs));
```

Note the clue path re-checks the round seed after sleeping: a clue from a round that ended during the sleep is dropped. The reducer's `botClue` also guards pass and turn, so a late clue after the turn timed out is ignored there.

- [ ] **Step 4: Run the DO tests**

Run: `npx vitest run test/worker`
Expected: green.

- [ ] **Step 5: Client**

`src/client/views.ts`:
- `seatsHtml(snap: Snapshot, typing: Set<number> = new Set())`: when `typing.has(s.index)` append `<span class="typing-tag">typing…</span>` inside the `.sig` span after the badges.
- New:

```ts
/** "Coral Fox is typing…" for seats writing right now, for the line under the transcript. */
export function typingHtml(snap: Snapshot, typing: Set<number>): string {
  const names = [...typing].filter((i) => i !== snap.you).map((i) => `<b style="color:${seatColor(snap, i)}">${esc(nameOf(snap, i))}</b>`);
  if (names.length === 0) return '';
  const verb = names.length === 1 ? 'is' : 'are';
  return `${names.join(', ')} ${verb} typing…`;
}
```

`src/client/app.ts`:
- State: `const typing = new Map<number, number>();` (seat to expiry).
- `handle()`: add a branch before `retries = 0`:

```ts
  if (msg.type === 'typing') {
    typing.set(msg.seat, Date.now() + msg.ms);
    render();
    return;
  }
```

- In `render()`: before drawing, prune expired entries and any seat whose last transcript line is newer than when it started typing. Simplest correct rule: on every `state` message, delete `typing` entries for seats whose transcript line count grew (track `lastLineBySeat: Map<number, number>` counting lines per seat in the snapshot). Then compute `const typingNow = new Set([...typing].filter(([, until]) => until > Date.now()).map(([seat]) => seat));` and pass it to `seatsHtml(snap, typingNow)`. Set `$('typing').innerHTML = typingHtml(snap, typingNow)` and `show('typing', logVisible)`.
- In `tick()`: if any `typing` entry has expired since the last tick, delete it and call `render()` (guard so this does not loop: delete first, then render once).
- Send pings: on `input` events of `#text` and `#clue`, if the value is non-empty and at least 1500ms passed since the last ping, `send({ type: 'typing' })`. Do NOT route this through the existing `send()` wrapper if it clears the error text; add a `sendRaw` that skips `showError('')`, or make `send` take a `{ keepError }` flag. Keep `send` semantics for everything else unchanged.
- Reset `typing.clear()` in `leave()` and when the phase changes.

`public/index.html`: add `<p id="typing" class="typing-line" hidden></p>` right after `<div id="log" hidden></div>`. CSS:

```css
    .typing-line { min-height: 18px; margin: -6px 2px 8px; font-size: 13px; color: var(--faint); font-family: var(--mono); }
    .typing-line:empty { display: none; }
    .typing-tag { font-family: var(--mono); font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--faint); flex: none; animation: pulse 1.2s ease-in-out infinite; }
```

- [ ] **Step 6: Typecheck, build, and test**

Run: `npm run typecheck && npm run build:client && npm test`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add src/game/protocol.ts src/worker/room.ts src/client public/index.html public/app.js test
git commit -m "Typing indicators for every seat: humans ping, bots announce their typing window"
```

---

### Task 4: Bots retry a rejected line once, and sound less flat

**Files:**
- Modify: `src/worker/prompts.ts` (Persona `examples`, `BotContext.retry`, HUMAN_STYLE, MOVES, `buildMessages`)
- Modify: `src/worker/bots.ts` (export `FILLER`; retry in `BotRunner.turn`; `retryNote`)
- Modify: `src/worker/backends/workersAi.ts:11-20` (chat temperature 1.0)
- Test: `test/bots/prompts.test.ts`, `test/bots/bots.test.ts`, `test/bots/workersAi.test.ts`

**Interfaces:**
- Produces: `Persona.examples: string[]` (exactly 3 per persona). `BotContext.retry?: string`. `export function retryNote(reason: string): string | null` in `bots.ts` returning a sentence for a chat rejection reason (`say-filler`, `say-emoji`, `say-duplicate`, `say-agree`, `say-leaks-word`, `say-too-long`) and `null` for anything else. `BotRunner` retries the primary once with `retry` set when the first reply validated with a reason `retryNote` knows; the retry counts against the round budget.

- [ ] **Step 1: Write the failing prompt tests**

In `test/bots/prompts.test.ts`:

```ts
  it('gives every persona three example lines in its voice, none of them filler or emoji', () => {
    for (const p of PERSONAS) {
      expect(p.examples).toHaveLength(3);
      for (const line of p.examples) {
        expect(line.length).toBeLessThanOrEqual(MAX_BOT_LINE);
        expect(FILLER.test(line)).toBe(false);
        expect(/\p{Extended_Pictographic}/u.test(line)).toBe(false);
      }
    }
  });

  it('shows the persona\'s example lines in the system prompt and pushes for opinions, not silence', () => {
    const m = buildMessages(chatInputs());
    for (const line of chatInputs().persona.examples) expect(m.system).toContain(line);
    expect(m.system).toContain('quiet players look like bots');
    expect(m.system).not.toContain('It is normal to say nothing');
  });

  it('appends the retry note to the chat prompt when a line was rejected', () => {
    const m = buildMessages({ ...chatInputs(), retry: 'Your last line was rejected because it only agreed with someone.' });
    expect(m.user).toContain('rejected because it only agreed');
    expect(buildMessages(chatInputs()).user).not.toContain('rejected');
  });
```

(`chatInputs()` is whatever the file already uses to build chat inputs; reuse it. Import `FILLER` from `../../src/worker/bots`.)

In `test/bots/bots.test.ts`, in the runner block:

```ts
  it('retries the primary once with the rejection reason when a chat line fails the style check, then falls back', async () => {
    const seen: BotInputs[] = [];
    const primary: BotBackend = {
      run: async (inputs) => {
        seen.push(inputs);
        return seen.length === 1 ? { say: 'yeah same', suspect: 1, reason: 'x' } : { say: 'fox your second clue was a stretch', suspect: 1, reason: 'x' };
      },
    };
    const fallback = stub({ say: null });
    const s = chatState(); // whatever helper the file uses for a chat-phase state with a bot seat
    const bot = s.seats.find((x) => x.kind === 'bot')!;
    const event = await runner(primary, fallback).turn(s, turn(bot.index, 'chat', 'react'));
    expect(event).toMatchObject({ type: 'botChat', text: 'fox your second clue was a stretch' });
    expect(seen).toHaveLength(2);
    expect(seen[1].retry).toMatch(/only agreed/);
    expect(fallback.calls).toBe(0);
  });

  it('gives up after one retry and falls back', async () => {
    const primary = stub({ say: 'yeah same', suspect: 1, reason: 'x' });
    const fallback = stub({ say: null });
    const s = chatState();
    const bot = s.seats.find((x) => x.kind === 'bot')!;
    expect(await runner(primary, fallback).turn(s, turn(bot.index, 'chat'))).toBeNull();
    expect(primary.calls).toBe(2);
    expect(fallback.calls).toBe(1);
  });

  it('retryNote knows the chat rejections and nothing else', () => {
    expect(retryNote('say-agree')).toMatch(/only agreed/);
    expect(retryNote('say-filler')).toMatch(/filler/);
    expect(retryNote('say-duplicate')).toMatch(/already/);
    expect(retryNote('say-leaks-word')).toMatch(/secret word/);
    expect(retryNote('clue-missing')).toBeNull();
    expect(retryNote('bot-timeout')).toBeNull();
  });
```

Adapt names (`stub`, `chatState`, `turn`, `runner`) to the helpers that already exist in the file; read the file first. The existing "falls back when the primary ... fails validation" test uses a clue turn, so it is unaffected (clues do not retry).

In `test/bots/workersAi.test.ts`, if `temperatureFor('chat')` is asserted, update it to `1.0`.

- [ ] **Step 2: Run to see them fail**

Run: `npx vitest run test/bots`
Expected: failures on `examples`, `retry`, `retryNote`, and the prompt strings.

- [ ] **Step 3: Implement the prompts**

`src/worker/prompts.ts`:

Add to `Persona`:

```ts
  /** Three lines this player might type, for the voice only; the model must not reuse their content. */
  examples: string[];
```

Add examples to each persona (keep everything else). None may contain the words the `FILLER` regex bans (`definitely`, `sus`, `vibes`, `for real`, `honestly`, `tbh`, `lol`, `haha`, `let's go`, `hype`, `ready to ...`), emoji, or a real category word:

```ts
  // lowercase
  examples: ['ok that second one was a reach', 'otter why would you pick that', 'nah i still think its fox'],
  // tidy
  examples: ['Newt, your first clue fits three other things in the category.', 'I would look at Yak before anyone else.', 'That is not a reason, that is a hunch.'],
  // quick
  examples: ['wait what was that clue about', 'Ibis that one! that was so vague', 'ok nope not buying it'],
  // dry
  examples: ['bold clue for someone who knows the word', 'so we are all just ignoring fox then?', 'sure. and I am the queen'],
  // rambler
  examples: ['I keep coming back to the second round, Otter went really safe there, which is exactly what I would do if I was guessing...', 'not saying it is Yak, but the timing was odd', 'the first clues were fine, it was the second pass that got weird'],
  // texter
  examples: ['idk newt ur 2nd clue was kinda nothing', 'fox is way too quiet rn', 'ok but who actually knows the word here'],
```

Add to `BotContext`:

```ts
  /** Set on a retry: why the previous line was rejected, so the model writes something else. */
  retry?: string;
```

Replace `HUMAN_STYLE` with:

```ts
/** How people in a chat actually write, as a contrast to model-speak. */
const HUMAN_STYLE = [
  'Write like a person in a group chat, not a narrator: be a bit lazy, leave things implied, have an opinion.',
  'Be specific. Name the clue you mean ("that second clue", "the one about legs") and say what is wrong with it.',
  'Tease people. A dig, a dry joke, or a half-serious accusation is more human than a careful summary.',
  'Refer to other players by one word of their call sign (say "fox", not "coral fox"), and do not open every line with a name.',
  'No greetings, no hype, no pep talk, no "let\'s go", no announcing what you are about to do.',
  'Avoid filler people notice: "definitely", "sus", "vibes", "for real", "honestly", "tbh", "lol", "haha".',
  'Never bring up your hobby or your life unprompted; this is a game chat about clues.',
  'Never just agree. "yeah same" adds nothing; if you agree, add a reason nobody has given, or say nothing.',
  'Say nothing (null) only when someone already made your exact point. Do not go quiet to be safe: quiet players look like bots.',
].join(' ');
```

In `buildMessages`, after the persona line in `system`, add:

```ts
    `Lines you might type, for the voice only, never the content: ${inputs.persona.examples.map((l) => `"${l}"`).join(' ')}`,
```

`MOVES.react` becomes: `'React to the latest line: agree with a twist, poke a hole in it, or ask a follow-up. Stay quiet only if you truly have nothing.'`

In the chat `user` message, before the final "Say one short thing" line, add `...(inputs.retry ? [inputs.retry] : []),`.

- [ ] **Step 4: Implement the retry in the runner**

`src/worker/bots.ts`: change `const FILLER` to `export const FILLER`. Add:

```ts
/** What to tell the model when its chat line was rejected, or null when the failure is not one a rewrite would fix. */
export function retryNote(reason: string): string | null {
  const why: Record<string, string> = {
    'say-filler': 'it leaned on filler words',
    'say-emoji': 'it used an emoji and nobody here does',
    'say-duplicate': 'it made a point someone already made',
    'say-agree': 'it only agreed with someone',
    'say-leaks-word': 'it contained the secret word',
    'say-too-long': 'it was too long',
  };
  const w = why[reason];
  return w ? `Your last line was rejected because ${w}. Write a different line, or reply null.` : null;
}
```

In `BotRunner.turn`, restructure the primary branch so a chat rejection with a known note tries once more:

```ts
    if (this.primary !== this.fallback && !this.autopilot && this.primaryCalls < this.opts.budgetPerRound) {
      let attempt = inputs;
      for (let tries = 0; tries < 2 && this.primaryCalls < this.opts.budgetPerRound; tries++) {
        this.primaryCalls++;
        const result = await this.callPrimary(attempt);
        if (!result.ok) {
          this.opts.onFallback?.(inputs.action, result.reason);
          break;
        }
        const read = readFrom(attempt, result.raw);
        if (read) this.reads.set(turn.seat, read);
        const v = validateOutput(state, attempt, result.raw, this.opts.now());
        if (v.ok) return v.event;
        const note = attempt.action === 'chat' && tries === 0 ? retryNote(v.reason) : null;
        if (!note) {
          this.opts.onFallback?.(inputs.action, v.reason);
          break;
        }
        attempt = { ...attempt, retry: note };
      }
    }
```

`src/worker/backends/workersAi.ts`: chat temperature `1.0`; update the docstring ("Chat runs hot so lines vary and personas show").

- [ ] **Step 5: Run everything**

Run: `npm test && npm run typecheck`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add src/worker test
git commit -m "Bots: persona example lines, push for opinions over silence, one retry with the rejection reason, hotter chat"
```

---

### Task 5: Visual cues and audio on the client

**Files:**
- Create: `src/client/sound.ts`
- Modify: `src/client/app.ts`, `src/client/views.ts`, `public/index.html`

**Interfaces:**
- Consumes: `Phase` with `'deal'` (Task 1), `DURATIONS` from `src/game/rules.ts` (importable by the client bundle; it is pure), typing set from Task 3.
- Produces: `sound.ts` exports `unlock(): void` (creates or resumes the `AudioContext`; call from a user gesture), `setMuted(m: boolean)`, `isMuted(): boolean`, `chime()` (phase change, two rising notes), `ding()` (your turn, one bright note), `tickSound()` (last-five-seconds tick), `tap()` (new message, short soft tap). Every player is a no-op when muted or when no context exists.

- [ ] **Step 1: Sound module**

`src/client/sound.ts`:

```ts
/** Synthesized cues through Web Audio; no asset files. Muted state persists per browser. */
let ctx: AudioContext | null = null;
let muted = false;
try {
  muted = localStorage.getItem('muted') === '1';
} catch {
  // storage blocked; stay unmuted
}

/** Create or resume the context. Browsers only allow this from a user gesture. */
export function unlock(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    ctx = null;
  }
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(m: boolean): void {
  muted = m;
  try {
    localStorage.setItem('muted', m ? '1' : '0');
  } catch {
    // ignore
  }
}

/** One sine note: `freq` Hz for `ms`, with a soft attack and release. */
function note(freq: number, ms: number, startIn = 0, gain = 0.08): void {
  if (muted || !ctx || ctx.state !== 'running') return;
  const t0 = ctx.currentTime + startIn / 1000;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0005, t0 + ms / 1000);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + ms / 1000 + 0.02);
}

/** Phase change: two rising notes. */
export function chime(): void {
  note(523, 140);
  note(784, 220, 120);
}

/** Your turn: one bright note. */
export function ding(): void {
  note(988, 260, 0, 0.1);
}

/** Last seconds: a dry tick. */
export function tickSound(): void {
  note(1320, 45, 0, 0.05);
}

/** New line in the chat: a soft tap. */
export function tap(): void {
  note(440, 60, 0, 0.04);
}
```

- [ ] **Step 2: Markup and CSS in `public/index.html`**

In the statusbar, after `#timer` and before `#help-room`, add:

```html
        <button id="mute" class="icon-btn" title="Sound" aria-label="Toggle sound">♪</button>
```

Right after the `.statusbar` div (still inside `#room`), add the progress bar:

```html
      <div class="progress" aria-hidden="true"><i id="progress"></i></div>
```

Right after `<div id="card" class="card" hidden></div>`, add:

```html
      <p id="deal" class="deal" hidden></p>
```

At the end of `<main>` (after the footer, inside main), add the transition banner:

```html
  <div id="banner" class="banner" aria-live="polite"><b id="banner-title"></b><span id="banner-sub"></span></div>
```

CSS to add (near the statusbar styles):

```css
    .progress { height: 3px; margin: -10px 4px 14px; background: var(--line-soft); border-radius: 2px; overflow: hidden; }
    .progress i { display: block; height: 100%; width: 0; background: var(--accent); transition: width .25s linear; }
    .progress i.low { background: var(--warn); }
    .progress i.out { background: var(--bad); }
    #mute.off { color: var(--faint); text-decoration: line-through; }
    .deal {
      text-align: center; color: var(--muted); font-size: 15px; margin: -4px 0 14px;
    }
    .banner {
      position: fixed; left: 50%; top: 18%; transform: translate(-50%, -12px);
      display: flex; flex-direction: column; align-items: center; gap: 2px;
      padding: 14px 22px; border-radius: var(--radius);
      background: var(--panel-2); border: 1px solid var(--line); box-shadow: 0 18px 40px -16px rgba(0,0,0,.9);
      opacity: 0; pointer-events: none; z-index: 20; transition: opacity .25s ease, transform .25s ease;
      max-width: calc(100% - 32px);
    }
    .banner.show { opacity: 1; transform: translate(-50%, 0); }
    .banner b { font-family: var(--display); font-size: 22px; letter-spacing: .02em; color: var(--ink); }
    .banner span { font-family: var(--mono); font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: var(--accent); }
    .banner.mine { background: var(--accent); border-color: transparent; }
    .banner.mine b { color: var(--accent-ink); }
    .banner.mine span { color: var(--accent-ink); opacity: .8; }
    #turn.mine { animation: nudge .6s ease-out 1; }
    @keyframes nudge { 0% { transform: scale(.97); } 60% { transform: scale(1.02); } 100% { transform: scale(1); } }
    .seat.turn .alias::after { content: " · on turn"; font-family: var(--mono); font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--faint); }
```

Update the help dialog copy: clues "30 seconds each", chat "150 seconds", vote "30 seconds", steal "20 seconds", bot call "30 seconds". Insert a step between Lobby and Clues: `<li><b>Deal.</b> Six seconds to read your card before the first clue turn.</li>`.

- [ ] **Step 3: Views**

`src/client/views.ts`:

```ts
/** What the transition banner says as each phase opens. */
export const BANNERS: Record<Phase, { title: string; sub: string }> = {
  lobby: { title: 'Back in the lobby', sub: 'Play again when ready' },
  deal: { title: 'Round starting', sub: 'Read your card' },
  clue: { title: 'Clues', sub: 'One word each, two rounds' },
  chat: { title: 'Chat is open', sub: 'Who never learned the word?' },
  vote: { title: 'Vote', sub: 'A majority ejects one seat' },
  steal: { title: 'Steal', sub: 'The imposter gets one guess' },
  botcall: { title: 'Bot call', sub: 'Human or machine?' },
  reveal: { title: 'Reveal', sub: 'Names, bots, the word' },
};

/** Copy under the card during the deal. */
export function dealHtml(snap: Snapshot): string {
  if (snap.phase !== 'deal' || !snap.round) return '';
  return snap.round.word === null ? 'Memorise the category. Clues start when the timer runs out.' : 'Memorise the word. Clues start when the timer runs out.';
}
```

`PHASE_LABELS.deal` is `'deal'` (from Task 1).

- [ ] **Step 4: App wiring in `src/client/app.ts`**

Imports: `BANNERS, dealHtml` from views; `DURATIONS` from `../game/rules`; `chime, ding, isMuted, setMuted, tap, tickSound, unlock` from `./sound`.

State: `let lastTurnMine = false; let lastLineCount = 0; let lastTickSecond = -1; let bannerTimer: ReturnType<typeof setTimeout> | null = null;`

Banner helper:

```ts
function banner(title: string, sub: string, mine = false): void {
  const el = $('banner');
  $('banner-title').textContent = title;
  $('banner-sub').textContent = sub;
  el.classList.toggle('mine', mine);
  el.classList.add('show');
  if (bannerTimer !== null) clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => el.classList.remove('show'), 2600);
}
```

In `render()`, inside the existing `if (ph !== lastPhase)` block, when `lastPhase !== null` (not the first snapshot after joining): `banner(BANNERS[ph].title, BANNERS[ph].sub); chime();`. Reset `lastTurnMine = false` there too.

After computing `myTurn`: if `myTurn && !lastTurnMine` then `banner('Your turn', `Round ${snap.round!.cluePass} of 2 · one word`, true); ding();`. Set `lastTurnMine = myTurn`.

New line sound: `const lines = snap.transcript.length; if (lines > lastLineCount && lastLineCount > 0 && ph === 'chat') { const last = snap.transcript[lines - 1]; if (last.seat !== snap.you) tap(); } lastLineCount = lines;` Reset `lastLineCount = 0` when the phase changes (the transcript is cleared at start).

Deal copy: `show('deal', ph === 'deal'); $('deal').innerHTML = dealHtml(snap);`. Also `show('turn', ph === 'clue')` stays as is.

Progress bar and ticks in `tick()`:

```ts
  const bar = $('progress');
  if (end === null) { bar.style.width = '0'; bar.className = ''; return; }
  const key = snapshot!.phase === 'clue' ? 'clueTurn' : snapshot!.phase;
  const total = (DURATIONS as Record<string, number>)[key] ?? 0;
  const remaining = Math.max(0, end - Date.now());
  bar.style.width = total ? `${(100 * remaining) / total}%` : '0';
  bar.className = left === 0 ? 'out' : left <= 5 ? 'low' : '';
  if (left <= 5 && left > 0 && left !== lastTickSecond) tickSound();
  lastTickSecond = left;
```

Place it after `left` is computed; keep the existing timer text logic. Note `DURATIONS` has no `lobby` or `reveal` key, and those phases are untimed anyway.

Mute button:

```ts
const mute = $('mute');
function paintMute(): void {
  mute.classList.toggle('off', isMuted());
  mute.title = isMuted() ? 'Sound off' : 'Sound on';
}
mute.onclick = () => { setMuted(!isMuted()); unlock(); paintMute(); };
paintMute();
```

Unlock audio on the gestures that lead into a room: add `unlock();` at the top of the `#create` and `#join` click handlers and in the `#code` Enter handler. `leave()` should clear the banner timer and remove `show`.

- [ ] **Step 5: Typecheck and build**

Run: `npm run typecheck && npm run build:client && npm test`
Expected: green (no unit tests cover the DOM; the DO tests must still pass).

- [ ] **Step 6: Browser check with fake bots**

Start the dev server in the background: `npm run dev` (Bash `run_in_background`), poll `curl -s localhost:8787/ | head -c 200` until it answers. Use the headless-Chrome CDP pattern:

```
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --headless=new --remote-debugging-port=9222 --user-data-dir=<scratchpad>/chrome
```

Then a Node script in the scratchpad that connects to `/json/version`'s `webSocketDebuggerUrl`, `Target.createBrowserContext`, `Target.createTarget {url: 'http://localhost:8787/'}`, `Target.attachToTarget {flatten: true}`, and `Runtime.evaluate` with `returnByValue`. Script the flow: set `#name`, click `#create`, wait for `#phase` text `lobby`, click `#start`, then assert in order:
1. `#phase` becomes `deal`, `#deal` is visible and non-empty, `#banner.show` is present with title `Round starting`, `#progress` has a non-zero width.
2. After about 6.5s `#phase` is `clues` and `#banner-title` read `Clues` at some point (poll every 100ms and record titles seen).
3. When it is the human's turn, `#banner.mine` appears with `Your turn` and `#turn.mine` is visible.
4. Submit clues with `form.requestSubmit()` through both passes; reach `chat`; confirm the banner title `Chat is open`; type into `#text` and confirm the DO relayed nothing back to self (no `#typing` text on the sender's own page), then open a second browser context as a second player earlier in the flow if you want to see the "is typing…" line on the other screen (optional, the DO test already covers relay).
5. Clicking `#mute` toggles the `off` class and persists across a reload of the page.
Capture a screenshot (`Page.captureScreenshot`) of the deal and of a banner into the scratchpad. Stop Chrome and `pkill -f "wrangler dev"` when done. Do not run vitest while the dev server is up.

- [ ] **Step 7: Commit**

```bash
git add src/client public/index.html public/app.js
git commit -m "Client: phase banners, deal countdown, progress bar, your-turn nudge, synthesized sound cues with a mute toggle"
```

---

### Task 6: Spec amendments, live check, deploy, push

**Files:**
- Modify: `docs/superpowers/specs/2026-09-04-imposter-turing-design.md` sections 2.3, 5.1, 5.5, 5.6, 5.7
- Modify: `README.md` if it lists phase lengths
- Modify: `scripts/smoke.mjs` (print every chat line at the end so a live run can be eyeballed)

- [ ] **Step 1: Spec**

Section 2.3: add the deal phase and the new durations. Section 5.1: personas carry three example lines. Section 5.5: new tick counts and delays, cap 7, cooldown 6s, typing 55ms/6s, typing indicators (humans ping, bots announce; ephemeral; not stored). Section 5.6: chat temperature 1.0. Section 5.7: one retry with the rejection reason before the scripted fallback. Keep the amendments short and dated "2026-09-17 playtest pass".

- [ ] **Step 2: Smoke prints the transcript**

In `scripts/smoke.mjs`, before the final `SMOKE OK` line, print every transcript line from the last snapshot seen as `alias: text`, and every bot clue, so a live run shows the bot voice.

- [ ] **Step 3: Full verification, then deploy**

```bash
npm test && npm run typecheck
git status   # clean apart from the spec, README, smoke changes
git add docs README.md scripts/smoke.mjs
git commit -m "Spec: playtest pass 1 (deal phase, longer phases, bot timing, typing indicators, retry)"
npm run deploy
```

Then a live check against https://imposter-turing.baronshim.workers.dev with `BASE=https://imposter-turing.baronshim.workers.dev LIVE=1 npm run smoke` (the deploy uses the real model; the smoke's `TURN_MS` of 20s covers a 16s clue delay plus the model call). Read the printed bot lines and judge: are there at least 8 bot lines over the chat, do they name clues, do they vary in voice? Report the lines verbatim to the controller. If a live round produces fewer than 5 bot lines, check `wrangler tail` for `fell back to scripted` reasons before concluding.

- [ ] **Step 4: Push**

```bash
git push origin main
```
