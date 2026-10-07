# Feedback and iteration

Three rounds of feedback shaped the game: playtest #1 (friends, 2026-09-17),
my own play after pass 1 (2026-09-24), and the class game day
(2026-10-02).

## Playtest #1 — 2026-09-17

Feedback, verbatim from my notes:

1. Pacing is too fast
2. Add visual cues (starting, whose turn, transitions, etc) and potentially audio
3. AI sent a message too fast in the open chat
4. AI typed clue too fast
5. AI spoke too little
6. AI stood out too much in terms of "boring" language

**Triage.** Two things to act on, because they were the two things that
broke the theme:

- **Pacing and cues (1, 2).** If players cannot tell what phase they are
  in or whose turn it is, they are not reading each other, and the whole
  game is reading each other. Fix: a 6-second deal phase so you can read
  your card, every phase longer (clue 20 to 30s, chat 90 to 150s, vote
  20 to 30s, steal 15 to 20s, bot call 20 to 30s), a banner on every
  phase change, a progress bar, a your-turn nudge, and synthesized sound
  cues behind a mute toggle.
- **Bot presence (3 to 6).** Bots that answer instantly, say little, and
  write flatly are not curating a self, they are just a tell. Fix: bots
  wait 6 to 16 seconds before a clue and simulate typing at 55 ms per
  character, typing indicators for every seat so the indicator is not
  itself a tell, 5 to 8 chances to speak per bot with a line cap of 7,
  three example lines per persona for voice, a higher temperature, and one
  retry with the rejection reason instead of dropping to silence.

**Revised milestone list.** M4 (Knights and Knaves) was already dropped;
the remaining time became "playtest pass 1" (planned 09-17 as
`plan/plan-playtest-pass-1.md`, merged and deployed 09-22) and a pass 2.

**Visible by playtest #2.** All of the above was live on 09-22. A live
observer run of that build measured the chat at exactly 150 seconds with
31 bot lines across five bots, coherent and naming clues, and bot typing
delays of 0.9 to 4 seconds against the humans' 3.

## My own play after pass 1 — 2026-09-24

- Sounds a little quiet: every cue roughly doubled in volume.
- Bots too formal, and "..." is a tell: every bot line is now lowercased
  and stripped of punctuation server-side, not just asked for in the
  prompt.
- Words too generic (rockets in general): six categories a reader of the
  book would recognise (people in the book, Carl Sagan, the recordings, the
  rocket, where Alex goes, sounds on the record).

## Game day — 2026-10-02

Feedback as received:

1. Add player icons/characters and make names more distinguishable (they all start to blend)
2. Spacing (have to scroll), maybe responsive
3. AI starts sentences with names of players frequently and they only send one chat at a time
4. Players can start the game (not host)
5. Shorten open chat interrogation

**Triage.** The two I would act on first:

- **Names and icons (1).** The vote and the bot call both depend on
  remembering who said what. Colour plus a two-word animal name was not
  enough at a table of six. Plan: a distinct icon per seat shown next to
  every line, every vote button and every reveal row, and shorter, more
  different call signs (no two sharing a colour family or an animal
  starting letter).
- **Chat length (5), with (3).** Pass 1 lengthened the chat from 90 to 150
  seconds because playtest #1 said it was too fast; game day says 150 is
  too long. The right value is in between, about 100 to 120 seconds. At
  the same time, the bot prompt should stop opening lines with a player's
  name (a tell once you notice it) and bots should be allowed a short
  two-line burst, which is how the humans in the room typed.

Also worth doing, smaller: a responsive pass so the clue and vote screens
fit a phone without scrolling (2), and host-only Start (4), which is a
one-line reducer check plus a disabled button.

None of these are in the deployed game; they are the "next two weeks" in
the presentation.
