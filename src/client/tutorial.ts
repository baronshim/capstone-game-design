import type { BotCall, ClientMessage, SeatKind, SeatView, Snapshot } from '../game/protocol';
import { isStealCorrect, roundPoints } from '../game/rules';
import { validateClue } from '../game/words';

/**
 * A guided practice round. The tutorial never opens a socket: it feeds the real
 * renderer a scripted room snapshot, so every control the player learns on is
 * the one they will use in a live game, and it intercepts what the player sends
 * to move the script along.
 */
export interface TutorialHost {
  /** Paints a snapshot through the normal render path. */
  paint(snap: Snapshot): void;
  /** Shows a seat's typing indicator for `ms` milliseconds (0 takes it down). */
  typing(seat: number, ms: number): void;
  /** Shows the red rejection toast, as the room would. */
  error(message: string): void;
  /** The name typed on the home screen. */
  playerName(): string;
  /** Back to the home screen with all room state cleared. */
  reset(): void;
}

const SEEN_KEY = 'tutorialSeen';
const CODE = 'DEMO';
const CATEGORY = 'Sounds on the record';
const WORD = 'whale';
const ME = 0;
const FRIEND = 1;
const IMPOSTER = 3;
const ALIASES = ['Teal Otter', 'Amber Heron', 'Crimson Fox', 'Indigo Lynx', 'Olive Moth', 'Coral Newt'];
const KINDS: SeatKind[] = ['human', 'human', 'bot', 'bot', 'bot', 'bot'];
const NAMES: (string | undefined)[] = [undefined, 'Sam', undefined, undefined, undefined, undefined];
/** Everyone but the player votes out the imposter, so the steal happens whatever the player picks. */
const VOTES: (number | null)[] = [null, IMPOSTER, IMPOSTER, FRIEND, IMPOSTER, IMPOSTER];
const FRIEND_CALLS: BotCall[] = ['human', null, 'bot', 'human', 'bot', 'human'];
/** Candidate clues per seat and pass; the first one the room has not heard yet is used. */
const CLUES: [string[], string[]][] = [
  [[], []],
  [['ocean', 'sea', 'salt'], ['fin', 'swim', 'blowhole']],
  [['song', 'sing', 'hum'], ['splash', 'dive', 'breach']],
  [['loud', 'noise', 'echo'], ['sky', 'wind', 'air']],
  [['blue', 'giant', 'grey'], ['deep', 'water', 'wave']],
  [['huge', 'big', 'vast'], ['tail', 'spout', 'krill']],
];
const REPLIES: { seat: number; text: string }[] = [
  { seat: FRIEND, text: 'Indigo, "sky"? That is not a sound.' },
  { seat: IMPOSTER, text: 'i meant like thunder in the sky idk' },
  { seat: 5, text: 'loud then sky is a stretch' },
];

interface Step {
  title: string;
  text: string;
  /** Id of the element to spotlight. */
  target: string;
  /** What the player must do to move on. Absent for a step that moves on with the Next button. */
  action?: string;
  /** Label of the Next button on a passive step. */
  next?: string;
  enter?: () => void;
}

let host: TutorialHost | null = null;
let snap: Snapshot;
let step = -1;
let timers: number[] = [];
let stealGuess = '';
let target: HTMLElement | null = null;

export function tutorialActive(): boolean {
  return host !== null;
}

export function tutorialSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return true;
  }
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    // storage blocked; the tutorial simply plays again next visit
  }
}

function $(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

function later(ms: number, fn: () => void): void {
  timers.push(window.setTimeout(fn, ms));
}

function clearTimers(): void {
  for (const t of timers) clearTimeout(t);
  timers = [];
}

function seat(index: number, name?: string): SeatView {
  const mine = index === ME;
  const s: SeatView = { index, alias: null, connected: true, clues: [], voted: false, total: 0 };
  if (name !== undefined) s.displayName = name;
  if (mine) {
    s.kind = 'human';
    s.isImposter = false;
    s.botCalls = null;
  }
  return s;
}

function freshSnapshot(name: string): Snapshot {
  return { code: CODE, phase: 'lobby', you: ME, phaseEndsAt: null, seats: [seat(ME, name)], transcript: [], round: null, autopilot: false };
}

function paint(): void {
  host?.paint(snap);
}

/** Deals the round: six seats with call signs, and the player as crew. */
function deal(): void {
  snap.seats = ALIASES.map((alias, i) => ({ ...seat(i, NAMES[i]), alias }));
  snap.seats[ME].displayName = host?.playerName() || 'You';
  snap.phase = 'deal';
  snap.round = { category: CATEGORY, word: WORD, clueSeat: null, cluePass: 1, ejected: null, stealGuess: null, result: null, winners: null };
}

const STEPS: Step[] = [
  {
    title: 'Welcome to For the Record',
    text: 'Six seats share a chat room. One seat never learned the secret word, and some seats are machines pretending to be people. This practice round walks you through every step. First, type your name.',
    target: 'name',
    next: 'Next',
  },
  {
    title: 'Open a room',
    text: 'Press Create a room to open a fresh room. If a friend already has one, type their 4-letter code and press Join instead. Either way, try it now.',
    target: 'create',
    action: 'Press Create a room, or Join',
  },
  {
    title: 'The lobby',
    text: 'The room code at the top is what friends type to join; Copy invite link puts a link on your clipboard. Any seat nobody takes is filled by an AI player. When everyone is in, press Start the round.',
    target: 'start',
    action: 'Press Start the round',
    enter: () => {
      snap = freshSnapshot(host?.playerName() || 'You');
      paint();
      later(1400, () => {
        snap.seats.push(seat(FRIEND, 'Sam'));
        paint();
      });
    },
  },
  {
    title: 'Your card',
    text: 'This is the secret word and its category. In a real round you get six seconds to memorise it. One seat, the imposter, sees only the category and has to bluff.',
    target: 'card',
    next: 'Next',
    enter: () => {
      deal();
      paint();
    },
  },
  {
    title: 'Give a clue',
    text: 'It is your turn. Type one word that hints at the word without being the word, then press Send. Everyone hears it, the imposter included, so do not make it too obvious. You have 30 seconds per turn.',
    target: 'clue-form',
    action: 'Type one word and press Send',
    enter: () => {
      snap.phase = 'clue';
      snap.round!.clueSeat = ME;
      snap.round!.cluePass = 1;
      paint();
    },
  },
  {
    title: 'Second clue',
    text: 'Round two of clues. One more word, different from every clue so far: repeats are rejected. Look at the chips beside each seat. Whose clue did not fit?',
    target: 'clue-form',
    action: 'Type one word and press Send',
    enter: () => {
      snap.round!.clueSeat = ME;
      snap.round!.cluePass = 2;
      paint();
    },
  },
  {
    title: 'Chat',
    text: 'Chat is open for 150 seconds. Argue it out: whose clues were vague? Who types like a machine? Say something and press Send.',
    target: 'composer',
    action: 'Say something and press Send',
    enter: () => {
      snap.phase = 'chat';
      snap.round!.clueSeat = null;
      paint();
    },
  },
  {
    title: 'Reading the room',
    text: 'The others answer, and bots chip in too, mimicking how the humans in the room write. When the timer runs out, the vote begins.',
    target: 'log',
    next: 'On to the vote',
  },
  {
    title: 'Vote',
    text: 'Tap the seat you think is the imposter. You can change your pick until the 30 seconds run out. A majority of votes ejects one seat.',
    target: 'vote',
    action: 'Tap a seat',
    enter: () => {
      snap.phase = 'vote';
      paint();
    },
  },
  {
    title: 'The steal',
    text: 'The room ejected Indigo Lynx, and it was the imposter. An ejected imposter gets 20 seconds to guess the word and win anyway. You would normally wait here, but try the box the imposter sees: type a guess and press Steal.',
    target: 'steal-form',
    action: 'Type a guess and press Steal',
    enter: () => {
      snap.phase = 'steal';
      snap.round!.ejected = IMPOSTER;
      // Borrow the imposter's view so the steal box appears for the player to try.
      snap.seats[ME].isImposter = true;
      paint();
    },
  },
  {
    title: 'Bot call',
    text: 'Mark every other seat Human or Bot, one point for each correct call, then press Lock in calls. You have 30 seconds.',
    target: 'botcall',
    action: 'Mark each seat, then press Lock in calls',
    enter: () => {
      snap.phase = 'botcall';
      snap.seats[ME].isImposter = false;
      snap.seats[ME].botCalls = null;
      paint();
    },
  },
  {
    title: 'The reveal',
    text: 'Names, who was a bot, the imposter, who voted for whom, the word, and the scores. The highest round total wins. Play again takes everyone back to the lobby, and your total carries over. That is the whole game.',
    target: 'reveal',
    next: 'Finish and play for real',
    enter: () => {
      reveal();
      paint();
    },
  },
];

const WELCOME = 0;
const CREATE = 1;
const LOBBY = 2;
const DEAL = 3;
const CLUE_1 = 4;
const CLUE_2 = 5;
const CHAT = 6;
const CHAT_DONE = 7;
const VOTE = 8;
const STEAL = 9;
const BOTCALL = 10;
const REVEAL = 11;

function spotlight(id: string): void {
  target?.classList.remove('tut-target');
  target = $(id);
  target.classList.add('tut-target');
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function go(i: number): void {
  clearTimers();
  step = i;
  const s = STEPS[i];
  s.enter?.();
  $('tut-step').textContent = `${i + 1} of ${STEPS.length}`;
  $('tut-title').textContent = s.title;
  $('tut-text').textContent = s.text;
  const next = $('tut-next');
  const doIt = $('tut-do');
  next.hidden = s.action !== undefined;
  next.textContent = s.next ?? 'Next';
  doIt.hidden = s.action === undefined;
  doIt.textContent = s.action ?? '';
  spotlight(s.target);
}

function onNext(): void {
  if (step === WELCOME) {
    if (host?.playerName().trim() === '') {
      host.error('Type your name first');
      $('name').focus();
      return;
    }
    go(CREATE);
  } else if (step === DEAL) go(CLUE_1);
  else if (step === CHAT_DONE) go(VOTE);
  else if (step === REVEAL) finish();
}

export function startTutorial(h: TutorialHost): void {
  host = h;
  stealGuess = '';
  snap = freshSnapshot('');
  document.body.classList.add('tut-on');
  $('tut').hidden = false;
  $('tut-next').onclick = onNext;
  $('tut-skip').onclick = endTutorial;
  go(WELCOME);
}

/** Leaves the tutorial, whether skipped or finished, and returns to the home screen. */
export function endTutorial(): void {
  if (!host) return;
  markSeen();
  clearTimers();
  const h = host;
  host = null;
  step = -1;
  target?.classList.remove('tut-target');
  target = null;
  $('tut').hidden = true;
  document.body.classList.remove('tut-on');
  h.reset();
}

function finish(): void {
  endTutorial();
}

/** Create or Join on the home screen: both open the practice lobby. */
export function tutorialOpenRoom(): void {
  if (step === CREATE) go(LOBBY);
}

/** What the player sends instead of the room receiving it. */
export function tutorialSend(msg: ClientMessage): void {
  switch (msg.type) {
    case 'start':
      if (step === LOBBY) go(DEAL);
      break;
    case 'clue':
      if (step === CLUE_1 || step === CLUE_2) clue(msg.word);
      break;
    case 'chat':
      chat(msg.text);
      break;
    case 'vote':
      // The pick can change until the phase ends; the first one starts the room voting.
      snap.seats[ME].vote = msg.seat;
      if (step === VOTE) vote();
      break;
    case 'steal':
      if (step === STEAL) steal(msg.word);
      break;
    case 'botcall':
      if (step === BOTCALL) botcall(msg.calls);
      break;
    case 'again':
      if (step === REVEAL) finish();
      break;
    default:
      break;
  }
}

function heard(): string[] {
  return snap.seats.flatMap((s) => s.clues);
}

function clue(word: string): void {
  const check = validateClue(word, WORD, heard());
  if (!check.ok) {
    host?.error(check.message);
    return;
  }
  const pass = snap.round!.cluePass;
  snap.seats[ME].clues.push(check.clue);
  botClue(FRIEND, pass);
}

/** One seat's clue turn after the player's, then the next seat, until the pass is over. */
function botClue(index: number, pass: 1 | 2): void {
  if (index >= snap.seats.length) {
    later(700, () => go(pass === 1 ? CLUE_2 : CHAT));
    return;
  }
  snap.round!.clueSeat = index;
  paint();
  later(1100, () => {
    const taken = new Set(heard().map((c) => c.toLowerCase()));
    const word = CLUES[index][pass - 1].find((c) => !taken.has(c)) ?? '';
    snap.seats[index].clues.push(word);
    botClue(index + 1, pass);
  });
}

function chat(text: string): void {
  const line = text.trim();
  if (!line) return;
  snap.transcript.push({ seat: ME, text: line, at: Date.now() });
  paint();
  if (step !== CHAT) return;
  // Freeze the script's step so a second line from the player does not queue a second set of replies.
  step = -1;
  REPLIES.forEach((r, i) => {
    const at = 900 + i * 2600;
    later(at, () => host?.typing(r.seat, 2000));
    later(at + 1900, () => {
      host?.typing(r.seat, 0);
      snap.transcript.push({ seat: r.seat, text: r.text, at: Date.now() });
      paint();
    });
  });
  later(900 + REPLIES.length * 2600, () => go(CHAT_DONE));
}

function vote(): void {
  // Frozen so a changed pick does not queue a second countdown.
  step = -1;
  snap.seats[ME].voted = true;
  paint();
  snap.seats.forEach((s, i) => {
    if (i === ME) return;
    later(400 * i, () => {
      s.voted = true;
      paint();
    });
  });
  later(400 * snap.seats.length + 900, () => go(STEAL));
}

function steal(word: string): void {
  if (!word.trim()) {
    host?.error('Type a guess');
    return;
  }
  stealGuess = word.trim();
  go(BOTCALL);
}

function botcall(calls: BotCall[]): void {
  snap.seats[ME].botCalls = calls;
  paint();
  later(1000, () => go(REVEAL));
}

/** Fills in everything the reveal shows: kinds, votes, the steal, and every seat's points. */
function reveal(): void {
  const r = snap.round!;
  const stealCorrect = isStealCorrect(stealGuess, WORD);
  r.stealGuess = stealGuess;
  r.result = stealCorrect ? 'imposter' : 'crew';
  snap.phase = 'reveal';
  const myVote = snap.seats[ME].vote ?? null;
  const scored = snap.seats.map((s, i) => ({
    index: i,
    kind: KINDS[i],
    isImposter: i === IMPOSTER,
    vote: i === ME ? myVote : VOTES[i],
    botCalls: i === ME ? (s.botCalls ?? null) : i === FRIEND ? FRIEND_CALLS : null,
  }));
  for (const s of scored) {
    const points = roundPoints(s, scored, { ejected: IMPOSTER, stealCorrect });
    const view = snap.seats[s.index];
    view.kind = s.kind;
    view.isImposter = s.isImposter;
    view.vote = s.vote;
    view.displayName = s.kind === 'human' ? (view.displayName ?? NAMES[s.index]) : undefined;
    view.points = points;
    view.score = points.total;
    view.total = points.total;
  }
  const top = Math.max(...scored.map((s) => snap.seats[s.index].score ?? 0));
  r.winners = scored.filter((s) => snap.seats[s.index].score === top).map((s) => s.index);
}
