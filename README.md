# Imposter Turing

A chat-based social deduction game where humans and AI bots share a 6-seat
room. One seat is the imposter who does not know the word; every seat is
secretly a Knight (must tell the truth) or a Knave (must lie) (m4); empty
seats are bots trying to pass as human. Built for the See You in the Cosmos
adaptation assignment (theme: the curated self vs. the actual self).

Design spec: `docs/superpowers/specs/2026-09-04-imposter-turing-design.md`
Plans: `docs/superpowers/plans/`

## A round (as of m2)

1. **Lobby.** Create a room, share the 4-letter code, press Start with 1 to 6
   humans. Empty seats become bots (inert until m3). In m2 the sole human is
   always the imposter and bots never vote, so use two or more humans for a
   real round.
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
