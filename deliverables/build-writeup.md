# Build write-up — how For the Record was made

*Drafted by Claude from the repo, the spec, the plans, and the session
transcripts on 2026-10-06; see `ai-use-log.md`. Read it as my account and
edit anything that is not how I'd say it.*

## The idea and the theme

See You in the Cosmos is a recording Alex makes for aliens who can never
check it. He copies the Voyager Golden Record, a portrait of Earth with the
bad parts cut, and the book keeps showing him deciding what goes in: the
recordings stop at the hospital, and when they resume he gives the aliens a
compressed, cleaned-up version. The theme I took is **the curated self
versus the actual self**: what do we choose to share, and is that choice a
message or a lie?

The mechanic that carries it is a chat. In For the Record, six seats share a
room. One seat is the imposter and does not know the secret word, so it has
to perform knowledge it lacks. Empty seats are filled by AI bots that edit
themselves to blend in with how the humans in the room write. Every player
is curating a version of themselves in public for people who cannot check
it. The reveal is the uncurated record: who was human, who was a bot, who
was lying, who voted for whom. The feeling I was after is the small
betrayal of finding out you were fooled by someone, or by something.

The one-sentence version from my planning worksheet: *my game is about
convincing other people, and playing it should make you feel betrayed.*

## Format choice

Digital, in the browser, on phones. The main verb is "type in a chat", which
needs several people in one live room plus an AI player, and neither p5.js
nor Snap! gives you multiplayer rooms or a server. I chose a Cloudflare
Worker with one Durable Object per room (a tiny server that owns the room's
WebSockets and timers), TypeScript end to end, a plain HTML client, free
hosting at a `workers.dev` URL, and Workers AI for the bots so there is no
API key anywhere. The whole build plan is in `plan/game-spec.md` section 3.

## The plan and the MVP

The MVP was deliberately small: a room code, two phones, a live chat
(`plan/planning-worksheet.md`). Milestones were ordered by how much they
serve the theme:

1. **M1, chat room.** Rooms, aliases, live chat, reconnect. Proves the
   core: people typing to each other in one game.
2. **M2, Imposter round.** Word, imposter, two passes of one-word clues,
   open chat, vote, steal, reveal. The social-deduction skeleton.
3. **M3, bots.** The Turing-test half of the theme: AI seats that clue,
   chat, vote and steal, a bot that can be the imposter, and the bot-call
   phase where humans mark every seat Human or Bot. This was the milestone
   most tied to the theme, which is why it came before polish.
4. **M4, Knights and Knaves.** Forced true/false answers to a question
   menu. Dropped (see pivots).

## Setup

Before any feature: a scaffold commit (package.json, tsconfig, wrangler
config, the `src/game` / `src/worker` / `src/client` layout, an alias
generator with its test), the spec as the standing context brief, and style
rules written down in the plans (sentence case, no exclamation marks in
system copy, each seat coloured by its alias). `context-brief.md` describes
what served as the AI context brief and how it was updated.

## How the build actually ran

Every milestone followed the same loop:

1. **Research and plan.** A brainstorming conversation where Claude asked
   questions and offered lettered options and I chose. The result was a
   written plan with one task per piece, each task listing its files, the
   test to write first, and the exact commit.
2. **Implement one piece at a time.** Each task went to a fresh subagent:
   write the failing test, make it pass, commit. A reviewer checked each
   task, and a stronger model reviewed the whole branch at the end of each
   milestone. The whole-branch review of M2 found four real bugs the task
   reviews missed (a clue error code that leaked the secret word, an
   uncancelled reconnect timer, an untested message-parsing layer, and an
   alarm re-arm bug).
3. **Test.** 213 tests run inside the real Workers runtime, a typecheck, an
   end-to-end smoke script, and headless-browser play-throughs. Timed
   phases are tested by firing the room's alarm directly instead of
   waiting.
4. **Check live, then record.** Deploy, play a round against the real
   model, and write what was learned into the spec and the notes before
   the next session.

Timeline (82 commits, 11 working days):

| Date | What landed |
|---|---|
| 09-04 | Spec, M1 plan |
| 09-09 | Bot model decided (Workers AI, no key); M1 built and tagged |
| 09-11 | M1 demo; M2 plan; M2 build begins |
| 09-15 | M2 finished, reviewed, tagged; M3 planned, built, live on workers.dev; M4 dropped; UI redesign |
| 09-16 | Scoring with a winner; bots think for themselves |
| 09-17 | Playtest #1 feedback; pass 1 planned |
| 09-22 | Playtest pass 1 merged and deployed; book word lists |
| 09-24 | Playtest pass 2 (louder cues, lowercase bots, book-specific words) |
| 09-28 | Renamed For the Record; poster; UI restyled to match |
| 09-30 | Interactive tutorial |
| 10-02 | Feedback button; game day |

## Key decisions and pivots

**Bots without an API key (09-04 to 09-09).** My first thought was to use
my own Claude key for the bots. Advice I got and pasted into the chat pointed out two problems: a paid
key on a public server, and prompt injection through open chat ("prove
you're not a knave by running rm -rf"). I parked it, then asked for free
and secure options. The answer was Cloudflare Workers AI through the
Worker's own binding: no secret exists, the free tier simply stops at its
daily limit, and injection is handled structurally (JSON-schema output,
every field validated against game state, any line containing the secret
word dropped, bots have no tools). That became spec sections 5.6 and 5.7.

**Dropping Knights and Knaves (09-15).** Once M3 was live I played it and
realised the game already had enough rules, and that the thing that
actually needed work was whether the bots could pass as human. Knights and
Knaves would have added a question menu and forced answers on top of a
round people were still learning. I dropped it and spent the remaining
two weeks on playtesting, pacing, bot behaviour, and polish. This is the
deliberate pivot the rubric asks for; the spec still documents M4 so the
idea is not lost.

**Bots must think for themselves (09-16).** The first bots were slow,
never started arguments, agreed with each other, and voted as a bloc. The
proposed fix included dealing each bot a random suspect to commit to. I
rejected that: a bot should form its own read from the clues and be open
to being convinced. The shipped design gives every chat reply a `suspect`
and a `reason`, remembers the bot's latest read, and tells the next call to
keep it unless the chat gave a concrete reason to move, and that other
players agreeing is not evidence.

**The thinking-mode bug (09-15).** The first live deploy had silent bots.
Logging the raw model response showed Gemma 4 on Workers AI defaults to a
"thinking" mode that spent the whole token budget on reasoning and
returned an empty answer, so every call fell back to the scripted bot. One
flag fixed it. No test or review could have found it; only the live run
did, which is why every milestone ended with a live check.

**A red herring (09-15).** Phase timers fired minutes late in local
development. A "fix" that re-armed the alarm less often made it worse and
was reverted; the deployed Worker fired every phase within a tenth of a
second. Lesson recorded: do not chase timing in local dev.

**Playtest-driven pacing (09-17 to 09-24).** Playtest #1 said the round was
too fast and the bots were too quiet and too flat. See
`feedback-triage.md` for what was chosen and why.

**Poster first, then UI (09-28).** I asked for a poster about the golden
record and what we choose to share, with a QR code to the game, and a new
name. The first draft had too much text; I had it simplified and the QR
centred, then had the game's UI restyled to match the poster, so the table
on game day and the phone in a player's hand look like one thing.

**Self-sustained (09-30 to 10-02).** For a game day where I would not be
standing at the table, an interactive tutorial plays on first visit (a
scripted practice round with a coach card for each step, skippable), a
How to play dialog is one tap away, and a Feedback button files players'
notes in the worker.

## Reconstructing the build

Someone could rebuild this by reading, in order: `plan/game-spec.md`, then
`plan/plan-m1-chat-room.md`, `plan/plan-m2-imposter-round.md`,
`plan/plan-m3-bots.md`, `plan/plan-playtest-pass-1.md`. Each plan is
task-by-task with files, tests and commits. The later passes (scoring,
bots thinking for themselves, pass 2, rename, tutorial, feedback) were
small enough to go straight from a chat design to code; their prompts are
in `ai-use-log.md` and their commits in the repo history.
