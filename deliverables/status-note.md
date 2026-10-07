# Status note — For the Record

Kept current through the build in two places: the Status section of the
repo README and Claude's persistent project notes
(`context-brief/memory-project-status.md`, which has the dated history).
This is the final state.

**As of 2026-10-06.** Live at https://imposter-turing.baronshim.workers.dev
(worker version 463b41ac, deployed 2026-10-02). Repo
https://github.com/baronshim/capstone-game-design, branch `main`, 82
commits, tags `m1` `m2` `m3`. 213 tests passing, typecheck clean.

## Declared scope and what shipped

| Milestone | State |
|---|---|
| M1 chat room (MVP) | Done 09-09 |
| M2 Imposter round | Done 09-15 |
| M3 bots on Workers AI, bot imposter, bot call, scoring, deployed | Done 09-15 |
| Playtest pass 1: deal phase, longer phases, cues, sound, typing indicators, bot presence | Done 09-22 |
| Playtest pass 2: louder cues, lowercase bots, book-specific words | Done 09-24 |
| Rename, poster, matching UI | Done 09-28 |
| Tutorial, feedback button | Done 09-30, 10-02 |
| M4 Knights and Knaves | Dropped 09-15, by choice |

MVP plus milestone 2 plus milestone 3 are complete; the rubric's "declared
scope" bar is met.

## Known issues (from game day, 2026-10-02)

See `feedback-triage.md` for the triage. In short: names blur together,
some screens need scrolling, bots open with a player's name too often and
post one line at a time, any player (not just the host) can press Start,
and the 150-second chat feels long.

## What I would do next

Player icons and more distinct names, a responsive pass so nothing
scrolls, a prompt fix for name-leading lines, host-only Start, and a chat
phase around 100 to 120 seconds.
