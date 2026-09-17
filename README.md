# Imposter Turing

A chat-based social deduction game where humans and AI bots share a 6-seat
room. One seat is the imposter who does not know the word; every seat is
secretly a Knight (must tell the truth) or a Knave (must lie) (m4); empty
seats are bots trying to pass as human. Built for the See You in the Cosmos
adaptation assignment (theme: the curated self vs. the actual self).

Play it: https://imposter-turing.baronshim.workers.dev

Design spec: `docs/superpowers/specs/2026-09-04-imposter-turing-design.md`
Plans: `docs/superpowers/plans/`

## A round (as of m3)

1. **Lobby.** Create a room, share the 4-letter code, press Start with 1 to 6
   humans. Empty seats become bots with their own personas.
2. **Clues.** Everyone gets an alias. One seat, human or bot, is the imposter
   and sees only the category; everyone else sees the word. Two passes of
   one-word clues, 20s per turn. The word itself and repeated clues are
   rejected. Bots take their turns by themselves.
3. **Chat.** 90s of open discussion. Bots chip in one to three times each,
   mimicking how the humans in the room write. The transcript stays on screen,
   read-only, through the vote, the steal, and the bot call.
4. **Vote.** 20s. Bots vote too. A majority of votes cast ejects a seat.
5. **Steal.** An ejected imposter, human or bot, gets 15s to guess the word.
6. **Bot call.** 20s. Every human marks every other seat Human or Bot.
7. **Reveal.** Everyone's name, who was human and who was a bot, who was the
   imposter, who voted for whom, the word, the result, and each human's
   bot-call score. Play again returns to the lobby.

## Bots

Bots run on Cloudflare Workers AI (`@cf/google/gemma-4-26b-a4b-it`) through
the Worker's `AI` binding; there is no API key anywhere. The `AI` binding
lives only in the `production` environment of `wrangler.jsonc` — local dev
and the tests never declare it. Every reply is requested as JSON and
validated server-side before it becomes a game event: one-word clues that
are not the secret word, chat lines under 140 characters that never contain
the word, votes for a real seat. Chat lines are also dropped when they read
as a bot: filler such as "definitely", "sus", or "lol", emoji when no human
has used one, or the same point an earlier line already made; each bot says
at most three lines a round. Each bot seat is dealt a distinct persona from a
pool of six (typing habits, mood, a hobby it must not bring up). Anything
invalid, slow (over 5s), or over the budget of 40 calls per round falls back
to a scripted bot: generic clues, silence in chat, a rule-based vote. If the free daily allocation runs
out, rooms show "bots are on autopilot today" and play by script until
midnight UTC.

`BOT_MODE` selects the backend: `live` (production), `fake` (canned, instant;
used by `npm run dev` and the tests), `scripted` (no model at all).

## Run locally

```sh
npm install
npm run dev        # fake bots, no login needed; serves on http://localhost:8787 (LAN: --ip 0.0.0.0 is on)
npm run dev:live   # real Workers AI bots (the production environment); needs a one-time `npx wrangler login`
```

Open the URL on two devices, create a room on one, join with the code on
the other. The room URL includes `?room=CODE` and can be shared (the lobby
has a copy-link button) or reloaded to rejoin the same seat; the arrow in the
room header leaves the room, and the question mark opens the rules. A room with nobody connected for 10 minutes deletes
itself. Room creation is limited to 5 per minute per address.

## Check

```sh
npm test           # vitest inside the Workers runtime: game units, bot units, Room DO rounds with fake bots
npm run typecheck  # worker + client
npm run smoke      # end-to-end through the chat phase against a running `npm run dev`
LIVE=1 npm run smoke   # same against `npm run dev:live`; checks the model, not the canned lists, produced the clues
```

Tests run in workerd via `@cloudflare/vitest-pool-workers` (vitest 4) under
the wrangler `test` environment, which has no AI binding, so they never call
the network. Phase timeouts are tested by firing the Durable Object alarm
directly. The smoke script needs Node 22 or newer (global WebSocket).

## Deploy

```sh
npx wrangler login
npm run deploy
```

## Layout

- `src/game/` pure game logic (reducer, rules, words, redaction, aliases, protocol types)
- `src/worker/` Cloudflare Worker entry, Room Durable Object, bot runner (`bots.ts`), prompts, backends
- `src/client/` browser app, bundled to `public/app.js`
- `test/game/` game units, `test/bots/` bot units, `test/worker/` Durable Object tests
- `scripts/smoke.mjs` end-to-end smoke test

## Status

- [x] M1 chat room: rooms, aliases, live chat, reconnect
- [x] M2 Imposter round: word, imposter, clues, chat, vote, steal, reveal
- [x] M3 bots: Workers AI bots with scripted fallback, bot imposter, bot call and scoring, deployed to workers.dev
- [ ] M4 Knights and Knaves
