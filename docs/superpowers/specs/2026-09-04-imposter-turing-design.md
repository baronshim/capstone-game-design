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
   nothing, shown publicly as "(no clue)". The imposter's clue skips the
   secret-word check (decided 2026-09-15): the imposter cannot knowingly say
   the word, and rejecting it would turn the error code into a word oracle.
   An imposter who happens to say the word has simply outed themselves.
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
   The question menu ships in milestone 4; until then interrogation is open
   chat only and bots do not ask.
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
    bots.ts       Bot scheduling, BotBackend dispatch, output validation, budget guard
    backends/     BotBackend implementations: fake, workersAi, scripted
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
effects. As built in m2 and m3 the effects are `error {to, code, message}`
and `botTurn {seat, action, delayMs}`; snapshots are broadcast after every
event rather than requested by an effect, and the phase deadline lives on
the state as `phaseEndsAt`, which the Durable Object mirrors into its single
alarm. The Durable Object executes effects. This keeps rules unit-testable without
Cloudflare and lets bots be tested with a fake API.

**Bots are server-side only.** Bot seats have no socket. The Room DO turns
`botTurn` effects into calls into `bots.ts`, which produces a bot event
(`botClue`, `botChat`, `botVote`, `botSteal`, keyed by seat) that is fed back
into the reducer through the same inner functions as the human events. Bot
delays (typing time, jittered chat ticks, vote delays) are `setTimeout`
calls inside the Durable Object, all shorter than the phase they belong to;
the single alarm is reserved for phase deadlines. If the object is evicted
mid-phase the pending bot timers are lost and those bots stay silent for the
rest of that phase; the phase alarm still advances the round.

**Deployment.** `wrangler dev` locally (LAN access for the class demo),
`wrangler deploy` to a free `*.workers.dev` URL. Bots run on Cloudflare
Workers AI through the `env.AI` binding declared in `wrangler.jsonc`, so
the deployment holds no API key or secret of any kind. Environment flags:
`BOT_MODE=fake|scripted|live` (default `fake`) and `BOT_MODEL` (default
`@cf/google/gemma-4-26b-a4b-it`, verified in the Workers AI catalog on
2026-09-15). The AI binding is remote-only: `wrangler dev` needs a one-time
`wrangler login`, and the vitest pool cannot start with the binding present,
so `wrangler.jsonc` defines a `test` environment without it and
`vitest.config.ts` selects that environment (verified 2026-09-15).

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
`ask {target, questionId, refSeat?}` (m4), `answer {yes}` (m4),
`vote {seat}`, `steal {word}`, `botcall {calls}`, `again`.

Server to client:
`state {snapshot}` (redacted for this viewer, sent to every seated socket
after every event, including timeouts and bot actions) and
`error {code, message}`. The snapshot carries the transcript, so there is
no separate `chat` message, and the reveal is the same snapshot with every
field exposed, so there is no separate `reveal` message (as built in m2).

### 4.3 Redaction

`redact(state, viewerSeat)` is the only path from room state to a client.
It removes: other seats' roles, imposter flags, kinds, personas, playerIds,
and the word for the imposter. At the reveal the same snapshot exposes
everything. Redaction is unit-tested by asserting a leaked-field
checklist against every phase.

### 4.4 Timers

Each phase sets a DO alarm for `phaseEndsAt`. On alarm the reducer applies
a `timeout` event (skip clue, auto-answer, close votes, close bot calls) and
advances. Bot chat ticks and vote delays are short `setTimeout`s inside the
Durable Object (see section 3); question-answer deadlines (m4) use the alarm.

### 4.5 Failure handling

- Model call fails, exceeds 5s, or returns output that fails validation:
  the scripted backend handles that action. For clues it submits a word
  from a per-category fallback list; for chat it stays silent; for votes
  it uses the rule-based vote below.
- Daily Workers AI allocation exhausted (calls start failing with a quota
  error): the room stores an autopilot flag until midnight UTC, uses the
  scripted backend until then, and the lobby shows "bots are on autopilot
  today".
- Human disconnects mid-round: seat stays, marked disconnected, timeouts
  handle their turns. No bot replacement mid-round. The vote closes as soon
  as every connected human has voted. Seats still disconnected when Play
  Again is pressed are dropped so they cannot fill the room.
- No humans connected for 10 minutes: room deletes itself.
- Start with 0 humans: refused.
- Room creation is limited to 5 rooms per minute per client IP, counted in
  Worker memory (best effort, resets when the isolate restarts).
- Per-room budget of 40 live API calls per round. Over budget, bots go
  silent in chat and use rule-based votes (vote for the seat with the most
  accusations against it, else random non-self).

## 5. Bots

### 5.1 Persona

At round start each bot seat gets a persona: typing habits (case,
punctuation, length), mood, a hobby or two for small talk, and a secret
"tell it is hiding". Personas are drawn from a small hand-written pool using the round seed, so
a round is reproducible from its seed.

### 5.2 Actions and schemas

Each bot action is a single call through the `BotBackend` interface
(`run(action, inputs) -> output | null`). The live backend makes one
Workers AI call with a JSON schema response format. Every output is
validated server-side before it becomes an event (see 5.7); anything that
fails validation is treated as a failed call.

| Action | Inputs | Output |
|---|---|---|
| Clue | word or category, prior clues, role, persona | `{ clue: string }` |
| Chat line | public transcript, persona, private role info, style sheet | `{ say: string \| null }` |
| Ask question (m4) | transcript, suspicions, remaining token | `{ target, questionId, refSeat? } \| null` |
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

Bots use Cloudflare Workers AI via the `env.AI` binding. Chosen 2026-09-09
over an Anthropic key because it is free (10,000 neurons per day on the
Workers Free plan), needs no secret on the public Worker, and cannot run up
a bill: past the daily allocation calls fail and the scripted backend takes
over.

Default model is Gemma 4 26B (`@cf/google/gemma-4-26b-a4b-it`), about 15
neurons per bot call at roughly 1,500 input and 40 output tokens, so around
650 calls or 20 to 30 full rounds per day. `BOT_MODEL` overrides it. Each
call uses the JSON schema `response_format`, `max_completion_tokens` of 80,
and a temperature around 0.8 for chat and 0.3 for votes and clues. Gemma 4's
thinking mode is sent OFF explicitly via `chat_template_kwargs: { enable_thinking: false }`. Verified live 2026-09-16: this Workers AI Gemma 4 build defaults thinking ON, and without the flag it spends the whole 80-token budget on `reasoning_content` and returns empty `content`, so every bot call would fall back to scripted.
A call that has not returned after 5 seconds is abandoned (the promise is
raced against a timer; the binding has no cancel) and counts as failed.

Three `BotBackend` implementations, selected by `BOT_MODE`:

- `fake`: canned outputs for development and tests (default).
- `live`: Workers AI, falling back to `scripted` per action on failure.
- `scripted`: no model. Clue from the fallback list, silence in chat, no
  questions, rule-based vote (4.5), steal guess from clues by category.

The backend interface is the only place a model is named, so swapping in a
hosted API later (for example Claude with a Worker secret) is a one-file
change and a new `BOT_MODE` value.

### 5.7 Output validation and injection guard

Prompt injection through free chat is treated as a given, not something
the prompt prevents. Bots have no tools and hold only two secrets, their
role and the word, so the guard is structural:

- Every model output is parsed against the action's JSON schema and each
  field is checked against game state: a clue is a single word not equal
  to the secret word; a vote or question target is a live non-self seat;
  a question id is on the menu; a chat line is at most 140 characters.
- Any chat line or clue containing the secret word (case-insensitive,
  including the plural and obvious spelling variants) is dropped and the
  bot stays silent for that turn.
- Transcript text is passed to the model inside a clearly delimited data
  block with the instruction that it is player chat, not instructions.
- The per-round call budget (4.5) caps how much a room can spend of the
  daily allocation no matter what players type.

A failed check counts as a failed call and routes to the scripted backend.

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
- Output validation (5.7): secret-word leak filter, invalid seats and
  question ids rejected, oversize chat lines rejected, each failure routes
  to the scripted backend.
- Integration: a scripted full round in the Worker test harness with fake
  bots and 1 human, and with 2 humans.

## 8. Milestones

Each milestone ends in a playable build tagged `m1` through `m4`.

1. **Week 1, chat room.** Worker, Durable Object, room codes, join from two
   devices, aliases, live chat, redacted snapshots, reconnect.
2. **Week 2, Imposter round.** Word lists, imposter assignment, clue phase
   with timers, vote, steal, reveal. No bots, no Knight/Knave.
3. **Week 3, bots.** Bot seats fill the room, fake mode then Workers AI
   calls for clue, chat, vote, steal, with the scripted backend as
   fallback (asking questions waits for the menu in week 4). Output
   validation. Mimicry style sheet. The imposter can be a bot. Bot-call
   phase and scoring. Rate-limited room creation. Deploy to `workers.dev`.
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
theme payoff and is the first stretch feature after m4. Second stretch:
a LoRA adapter on the Workers AI model, fine-tuned on human chat lines
collected from playtests, to improve mimicry beyond the style sheet.

## 10. Success test

A classmate who has never seen the game joins from a phone, plays a full
round, and at the reveal can say which seat fooled them.
