# Imposter Turing

A chat-based social deduction game where humans and AI bots share a 6-seat
room. One seat is the imposter who does not know the word; every seat is
secretly a Knight (must tell the truth) or a Knave (must lie); empty seats
are bots trying to pass as human. Built for the See You in the Cosmos
adaptation assignment (theme: the curated self vs. the actual self).

Design spec: `docs/superpowers/specs/2026-09-04-imposter-turing-design.md`
Plans: `docs/superpowers/plans/`

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
npm test           # unit tests for src/game
npm run typecheck  # worker + client
npm run smoke      # end-to-end against a running `npm run dev`
```

The smoke script needs Node 22 or newer (global WebSocket).

## Deploy

```sh
npx wrangler login
npm run deploy
```

## Layout

- `src/game/` pure game logic (reducer, redaction, aliases, protocol types)
- `src/worker/` Cloudflare Worker entry and Room Durable Object
- `src/client/` browser app, bundled to `public/app.js`
- `test/` vitest unit tests
- `scripts/smoke.mjs` end-to-end smoke test

## Status

- [x] M1 chat room: rooms, aliases, live chat, reconnect
- [ ] M2 Imposter round
- [ ] M3 bots
- [ ] M4 Knights and Knaves
