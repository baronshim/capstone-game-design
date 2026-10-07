# AI context brief, project skeleton, and style decisions

The rubric asks for an AI context brief that was actually used and updated
at least once, a project skeleton, and style decisions ready before
building. Here is what played each role.

## The brief

There is no single file called "context brief". Three things did that job,
and all three were updated repeatedly:

1. **The Game Spec Doc** (`plan/game-spec.md`). Every plan begins with
   "Spec: ... Read the spec before starting a task", and every subagent
   was pointed at it. It was amended nine times as the build taught us
   things:

   | Date | Change |
   |---|---|
   | 09-04 | Written |
   | 09-09 | Bots run on Workers AI, no API key |
   | 09-15 | Amended for M2 as built; M3 decisions |
   | 09-15 | Live URL; the Gemma thinking-mode finding |
   | 09-16 | Scoring with a winner |
   | 09-16 | Bots think for themselves |
   | 09-16 | Bot chat cooldown and cap |
   | 09-22 | Playtest pass 1 (deal phase, longer phases, bot timing, typing indicators, retry) |
   | 09-22 | Bot call budget with a reserve for the vote |

2. **The plans' "Global Constraints" sections.** Each plan opens with the
   invariants a subagent must not break (six seats, redaction is the only
   path to a client, pure game logic with no I/O, phase durations, copy
   rules). Those were the per-milestone brief.

3. **Claude Code's persistent memory** (copies in `context-brief/`). Claude
   keeps notes between sessions: project status with a dated history,
   stack decisions, lessons from M2 and M3, and how I like to work. These
   were read at the start of every session ("where did we leave off"
   worked because of them) and rewritten at the end of most. The account
   id has been removed from the copy.

Also used: `docs/references/` (the assignment, the theme write-up, my
planning worksheet), which Claude read in the first design session.

## The skeleton

Commit 63b169a (2026-09-09), before any feature: `package.json`,
`tsconfig.json` and a client tsconfig, `wrangler.jsonc`, `.gitignore`, the
`src/game` / `src/worker` / `src/client` split, a placeholder worker, and
the alias generator with its test. The layout never changed after that.

## Style decisions

Set before the UI work and kept through it: sentence case everywhere, no
exclamation marks in system copy, every seat coloured by the first word of
its call sign, a single dark palette. After the poster (09-28) the palette
became the poster's: near-black blue background, warm gold accents, a
teal highlight, Chakra Petch for display text and IBM Plex Sans and Mono
for body and data. The poster source (`docs/poster/poster.html`) is the
record of those values.
