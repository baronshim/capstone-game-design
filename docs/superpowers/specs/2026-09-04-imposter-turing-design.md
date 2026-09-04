# Imposter Turing: Game Design Spec

Date: 2026-09-04
Status: Draft for review
Course context: See You in the Cosmos adaptation (see `docs/references/`)

## 1. Concept

A chat-based social deduction game for 1 to 6 humans in a 6-seat room. Empty
seats are filled by AI bots that try to pass as human. One seat is the
imposter who does not know the secret word. Every seat is secretly a Knight
(must answer questions truthfully) or a Knave (must answer falsely). Players
give clues, interrogate each other, vote out the imposter, then guess which
seats were bots. The reveal shows who lied, who was forced to lie, and who was
a machine.

**Theme (from the book):** the curated self vs. the actual self. Alex edits
Earth and himself for aliens who can never check. Here, every seat is a
curated performance: the imposter performs knowledge it lacks, knaves perform
honesty they are forbidden, and bots edit themselves to blend in with the
humans in the room. Players choose what to share and how, then find out at
the reveal what was real.

**Target feeling:** betrayal, or the realization you were being lied to.

**One sentence:** My game is about convincing other people, and playing it
should make you feel betrayed.

## 2. Rules

### 2.1 Room and seats

- Exactly 6 seats. Humans join with a room code from a phone or laptop.
- Minimum 1 human to start; up to 6 humans. Remaining seats are bots.
- At round start every seat gets a random alias (color + animal, e.g.
  "Teal Otter"). Seat order is shuffled. Nobody is told how many humans are
  in the room.
- Each human has a `playerId` stored in browser localStorage so a refresh or
  dropped connection rejoins the same seat.

### 2.2 Roles (secret, assigned per round)

- **Imposter:** exactly one seat, human or bot, chosen uniformly. Sees the
  category only. Everyone else sees the word.
- **Knight or Knave:** every seat, imposter included. Split as evenly as
  possible (3/3), with at least one of each. Each player knows only their own
  role. Knights must answer menu questions truthfully; Knaves must answer
  falsely.

### 2.3 Phases

All phases show a visible countdown.

1. **Clues, 2 passes.** In seat order, each player submits one word
   (20s per turn). Forbidden: the secret word itself (case-insensitive,
   plus simple plural/stem match) and any clue already given this round. A
   rejected clue returns an error and the timer continues. Timeout submits
   nothing, shown publicly as "(no clue)".
2. **Interrogation, 90s.** Open free chat. Each player has one **question
   token** per round. Spending it posts a menu question at a target seat:
   - "Are you the imposter?"
   - "Are you a knight?"
   - "Are you a bot?"
   - "Was your clue about the real word?"
   - "Is @X a knight?"
   - "Is @X a bot?"

   The target has 10s to click Yes or No. The server rejects an answer the
   target's role forbids (a Knight cannot lie, a Knave cannot tell the
   truth) with a private message, and the timer continues. Timeout
   auto-answers per role. The question and its answer are posted to chat
   for everyone. Only one question may be pending at a time; others queue.
3. **Vote, 20s.** Every seat votes for one seat (not self). Bots vote too.
   Majority (strictly more than half of votes cast) is ejected. Otherwise,
   including ties, nobody is ejected. Abstentions do not count as votes.
4. **Steal.** If the imposter was ejected, they get one guess at the word
   (15s). Exact match (case-insensitive, trimmed) flips the result to an
   imposter win.
5. **Bot call, 20s.** Each human marks every other seat as Human or Bot.
   Unmarked seats count as no call.
6. **Reveal.** For every seat: alias, human or bot, Knight or Knave,
   imposter or not, and the players behind the aliases (human display
   name). Shows the group result and each human's bot-call score.

### 2.4 Win and scoring

- **Group result.** Crew wins if the imposter is ejected and fails the
  steal. Imposter wins otherwise (not ejected, or ejected and steals).
- **Bot-call score.** One point per correct Human/Bot call. Shown per human
  at the reveal. Scores are per round only; no persistence.

### 2.5 Truth table for menu questions

Ground truth is known to the server for every menu question. The forced
answer is `truth` for a Knight and `not truth` for a Knave.

| Question | Ground truth |
|---|---|
| Are you the imposter? | target.isImposter |
| Are you a knight? | target.role == knight |
| Are you a bot? | target.kind == bot |
| Was your clue about the real word? | target is not the imposter (the imposter never knows the word) |
| Is @X a knight? | X.role == knight |
| Is @X a bot? | X.kind == bot |

Consequences worth surfacing to players in the help text: a Knight can
never hide the imposter; a Knave imposter asked "Are you the imposter?" must
say Yes; a Knave crew member asked the same must also say Yes.

## 3. Architecture

Single TypeScript project deployed as a Cloudflare Worker with one Durable
Object per room. Static frontend served by the same Worker.

```
src/
  worker/
    index.ts      Worker entry: static assets, POST /rooms, GET /rooms/:code (WS upgrade)
    room.ts       Room Durable Object: sockets, alarms, calls the reducer, triggers bots
    bots.ts       Bot scheduling, Anthropic calls, fallbacks, budget guard
    prompts.ts    Prompt builders and output schemas for each bot action
  game/
    state.ts      GameState types and reducer: apply(state, event) -> { state, effects }
    rules.ts      Role assignment, truth table, clue validation, vote resolution, scoring
    redact.ts     Per-viewer snapshot redaction
    words.ts      Categories and word lists
    protocol.ts   Client<->server message types (shared)
  client/
    index.html
    app.ts        WS connection, state store, view switching
    views/        lobby, clue, interrogation, vote, steal, botcall, reveal
test/
  game/           vitest unit tests for src/game
  bots/           prompt builder tests with BOT_MODE=fake
  integration/    full round with fake bots via wrangler test harness
```

**Key boundary.** `src/game` is pure: no I/O, no timers, no network. The
reducer takes a state and an event and returns the new state plus a list of
effects (`broadcast`, `sendTo(seat)`, `setAlarm(at)`, `botTurn(seat, action)`).
The Durable Object executes effects. This keeps rules unit-testable without
Cloudflare and lets bots be tested with a fake API.

**Bots are server-side only.** Bot seats have no socket. The Room DO turns
`botTurn` effects into calls into `bots.ts`, which produces an event that
is fed back into the reducer exactly as a client message would be.

**Deployment.** `wrangler dev` locally (LAN access for the class demo),
`wrangler deploy` to a free `*.workers.dev` URL. `ANTHROPIC_API_KEY` is a
Worker secret. Environment flag `BOT_MODE=fake|live` (default `fake`).

## 4. Protocol and state

### 4.1 Server state (per room)

```
Room  { code, phase, round, seats: Seat[6], transcript: ChatLine[],
        phaseEndsAt, createdAt, lastHumanSeenAt }
Seat  { index, alias, kind: 'human'|'bot', playerId?, displayName?,
        persona?, role: 'knight'|'knave', isImposter, connected,
        clues: string[], questionUsed, vote?, botCalls?: Record<seat, 'human'|'bot'>,
        score }
Round { category, word, currentClueSeat, cluePass: 1|2,
        pendingQuestion?: { asker, target, questionId, refSeat?, endsAt },
        questionQueue: [...], ejected?, stealGuess?, result? }
```

### 4.2 Messages (JSON over WebSocket)

Client to server:
`join {playerId, displayName}`, `start`, `clue {word}`, `chat {text}`,
`ask {target, questionId, refSeat?}`, `answer {yes}`, `vote {seat}`,
`steal {word}`, `botcall {calls}`, `again`.

Server to client:
`state {snapshot}` (redacted for this viewer), `chat {line}`,
`error {code, message}`, `reveal {fullState}`.

### 4.3 Redaction

`redact(state, viewerSeat)` is the only path from room state to a client.
It removes: other seats' roles, imposter flags, kinds, personas, playerIds,
and the word for the imposter. Reveal sends the full state only after the
round has ended. Redaction is unit-tested by asserting a leaked-field
checklist against every phase.

### 4.4 Timers

Each phase sets a DO alarm for `phaseEndsAt`. On alarm the reducer applies
a `timeout` event (skip clue, auto-answer, close votes, close bot calls) and
advances. Bot chat ticks and question-answer deadlines use short alarms.

### 4.5 Failure handling

- Anthropic call fails or exceeds 5s: bot skips that action. For clues the
  bot submits a word from a per-category fallback list.
- Human disconnects mid-round: seat stays, marked disconnected, timeouts
  handle their turns. No bot replacement mid-round.
- No humans connected for 10 minutes: room deletes itself.
- Start with 0 humans: refused.
- Per-room budget of 40 live API calls per round. Over budget, bots go
  silent in chat and use rule-based votes (vote for the seat with the most
  accusations against it, else random non-self).

## 5. Bots

### 5.1 Persona

At round start each bot seat gets a persona: typing habits (case,
punctuation, length), mood, a hobby or two for small talk, and a secret
"tell it is hiding". Personas are drawn from a small hand-written pool.

### 5.2 Actions and schemas

Each bot action is a single Anthropic Messages call with structured output.

| Action | Inputs | Output |
|---|---|---|
| Clue | word or category, prior clues, role, persona | `{ clue: string }` |
| Chat line | public transcript, persona, private role info, style sheet | `{ say: string \| null }` |
| Ask question | transcript, suspicions, remaining token | `{ target, questionId, refSeat? } \| null` |
| Vote | transcript, clues | `{ vote: seat }` |
| Steal guess | clues seen | `{ word: string }` |
| Bot call | not needed; bots do not score | none |

Answering a menu question needs no call: the server computes the forced
answer from the role and ground truth.

### 5.3 Mimicry

Before each chat call the server computes a **style sheet** from the human
messages in the transcript: median length, share of lowercase-only lines,
terminal punctuation rate, emoji rate, repeated slang tokens. The prompt
includes it as "the room writes like this; blend in." Bots are also told to
play the game genuinely: give real clues, notice weak clues, accuse, and
defend, because non-engagement is the biggest tell.

### 5.4 Honesty in free chat

Enforcement applies only to menu questions. In free chat a bot is told its
role and asked to stay in character (Knaves bluff, Knights avoid
fabrication). This is soft, as it is for humans.

### 5.5 Pacing

During interrogation each bot gets 2 to 4 chances to speak at jittered
times. Before posting, a chat line is delayed by a typing-time simulation
proportional to its length so replies do not land instantly.

### 5.6 Model settings

Default model `claude-opus-5` with adaptive thinking and `effort: low` for
latency, small `max_tokens`, structured output via `output_config.format`.
Model is configurable by env var. `BOT_MODE=fake` returns canned outputs for
development and tests.

## 6. Client

Plain TypeScript and HTML, mobile-first single column. Views:

- **Lobby:** room code, seat count, connected humans (no bot count), Start.
- **Clue:** word or category card, whose turn, input with validation.
- **Interrogation:** chat log, composer, question button that opens the
  menu, pending-question banner with Yes/No for the target.
- **Vote:** seat list with clue history, vote buttons.
- **Steal:** word guess input (imposter only), waiting screen for others.
- **Bot call:** seat list with Human/Bot toggles.
- **Reveal:** table of seats with true identities and roles, group result,
  bot-call scores, Play Again.

## 7. Testing

- `vitest` on `src/game`: role assignment invariants (one imposter, at
  least one Knight and one Knave), the full truth table for every question
  by role and ground truth, clue validation, vote and tie resolution, steal,
  scoring, redaction leak checklist, timeout transitions.
- Prompt builders with fake bot mode: schemas validate, style sheet math,
  fallbacks on failure and budget.
- Integration: a scripted full round in the Worker test harness with fake
  bots and 1 human, and with 2 humans.

## 8. Milestones

Each milestone ends in a playable build tagged `m1` through `m4`.

1. **Week 1, chat room.** Worker, Durable Object, room codes, join from two
   devices, aliases, live chat, redacted snapshots, reconnect.
2. **Week 2, Imposter round.** Word lists, imposter assignment, clue phase
   with timers, vote, steal, reveal. No bots, no Knight/Knave.
3. **Week 3, bots.** Bot seats fill the room, fake mode then live calls for
   clue, chat, ask, vote, steal. Mimicry style sheet. Bot-call phase and
   scoring. Deploy to `workers.dev`.
4. **Week 4, Knights and Knaves plus polish.** Roles, question menu,
   enforced Yes/No answers, timeout auto-answers, reveal shows roles. Then
   sound cue on questions, reveal animation, mobile layout pass, budget
   guard.

## 9. Out of scope

Accounts or persistent scores, more than one imposter, spectators, custom
word lists, annotated replay reveal, "reverse Turing" points for humans
mistaken for bots, voice, art beyond a clean text UI.

Captured for later: the annotated replay reveal (interrogation log marked
with forced lies and which human each bot was mimicking) is the strongest
theme payoff and is the first stretch feature after m4.

## 10. Success test

A classmate who has never seen the game joins from a phone, plays a full
round, and at the reveal can say which seat fooled them.
