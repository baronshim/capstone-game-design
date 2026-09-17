import { describe, it, expect } from 'vitest';
import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { connect, createRoom, type Client } from './helpers';
import type { BotCall, Snapshot } from '../../src/game/protocol';
import { FAKE_CLUES, FAKE_LINE } from '../../src/worker/backends/fake';

const NAMES = ['Ada', 'Bob', 'Cal'];
/** Distinct clue words. `clue0`/`clue1` would all normalize to `clue` and be rejected as duplicates. */
const CLUE_WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];

async function startedRoomOnce(names: string[]) {
  const code = await createRoom();
  const clients: Client[] = [];
  const snaps: Snapshot[] = [];
  for (let i = 0; i < names.length; i++) {
    const c = await connect(code);
    c.send({ type: 'join', playerId: `p${i}`, displayName: names[i] });
    await c.state((s) => s.you === i);
    clients.push(c);
  }
  clients[0].send({ type: 'start' });
  for (const c of clients) snaps.push(await c.state((s) => s.phase === 'clue'));
  const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
  const fireAlarm = async () => {
    expect(await runDurableObjectAlarm(stub)).toBe(true);
  };
  const humanSeats = snaps.map((s) => s.you!);
  const byYou = (seat: number) => clients[snaps.findIndex((s) => s.you === seat)];
  const imposterClientIndex = snaps.findIndex((s) => s.seats[s.you!].isImposter);
  return { code, clients, snaps, fireAlarm, byYou, imposterClientIndex, humanSeats };
}

type Room = Awaited<ReturnType<typeof startedRoomOnce>>;

/** Starts rooms until the imposter's kind matches `imposter` (any kind when omitted). The seed is random, so retry. */
async function startedRoom(opts: { names?: string[]; imposter?: 'human' | 'bot' } = {}): Promise<Room> {
  const names = opts.names ?? NAMES;
  for (let attempt = 0; attempt < 30; attempt++) {
    const room = await startedRoomOnce(names);
    const humanImposter = room.imposterClientIndex >= 0;
    if (!opts.imposter || (opts.imposter === 'human') === humanImposter) return room;
    // A discarded room's sockets would otherwise stay open until afterEach, leaking a pending DO alarm past this test.
    for (const c of room.clients) c.ws.close(1000, 'retry');
  }
  throw new Error(`no room with a ${opts.imposter} imposter in 30 tries`);
}

/** Waits until a human is on turn (fake bots answer within milliseconds) or the clue phase ends. */
async function toHumanTurn(room: Room, snap: Snapshot): Promise<Snapshot> {
  while (snap.phase === 'clue' && !room.humanSeats.includes(snap.round!.clueSeat!)) {
    const turn = snap.round!.clueSeat!;
    snap = await room.clients[0].state((s) => s.phase !== 'clue' || s.round!.clueSeat !== turn);
  }
  return snap;
}

/** Plays every human clue turn with an accepted clue and returns the first chat-phase snapshot seen by client 0. */
async function playClues(room: Room): Promise<Snapshot> {
  let snap = await toHumanTurn(room, room.snaps[0]);
  let n = 0;
  while (snap.phase === 'clue') {
    const turn = snap.round!.clueSeat!;
    expect(n).toBeLessThan(CLUE_WORDS.length); // a rejected clue would otherwise loop forever
    room.byYou(turn).send({ type: 'clue', word: CLUE_WORDS[n++] });
    snap = await room.clients[0].state((s) => s.phase !== 'clue' || s.round!.clueSeat !== turn);
    snap = await toHumanTurn(room, snap);
  }
  expect(n).toBe(room.humanSeats.length * 2);
  return snap;
}

/** Every other seat called correctly, own seat null. */
function perfectCalls(snap: Snapshot, humanSeats: number[]): BotCall[] {
  return snap.seats.map((s) => (s.index === snap.you ? null : humanSeats.includes(s.index) ? 'human' : 'bot'));
}

describe('a round in the Room Durable Object with fake bots', () => {
  it('starts in the clue phase with six connected seats and exactly one imposter who cannot see the word', async () => {
    const room = await startedRoom({ imposter: 'human' });
    const first = room.snaps[0];
    expect(typeof first.phaseEndsAt).toBe('number');
    expect(first.seats).toHaveLength(6);
    expect(first.seats.every((s) => s.connected)).toBe(true);
    expect(room.snaps.filter((s) => s.seats[s.you!].isImposter)).toHaveLength(1);
    const impSnap = room.snaps[room.imposterClientIndex];
    expect(impSnap.round!.word).toBeNull();
    for (let i = 0; i < room.snaps.length; i++) {
      if (i === room.imposterClientIndex) continue;
      expect(typeof room.snaps[i].round!.word).toBe('string');
      expect(room.snaps[i].round!.category).toBe(impSnap.round!.category);
    }
  });

  it('bots take their clue turns by themselves with canned words', async () => {
    const room = await startedRoom();
    const chat = await playClues(room);
    expect(chat.phase).toBe('chat');
    for (const seat of chat.seats) {
      expect(seat.clues).toHaveLength(2);
      if (!room.humanSeats.includes(seat.index)) {
        expect(seat.clues).toEqual([FAKE_CLUES[seat.index * 2], FAKE_CLUES[seat.index * 2 + 1]]);
      }
    }
    expect(chat.seats.flatMap((s) => s.clues).filter((c) => CLUE_WORDS.includes(c))).toHaveLength(6);
  });

  it('rejects out-of-turn and two-word clues, accepts a valid one', async () => {
    const room = await startedRoom();
    const snap = await toHumanTurn(room, room.snaps[0]);
    const turn = snap.round!.clueSeat!;
    const other = room.clients.find((c) => c !== room.byYou(turn))!;
    other.send({ type: 'clue', word: 'sneaky' });
    expect(await other.error()).toBe('not-your-turn');
    room.byYou(turn).send({ type: 'clue', word: 'two words' });
    expect(await room.byYou(turn).error()).toBe('clue-one-word');
    room.byYou(turn).send({ type: 'clue', word: 'fine' });
    const next = await room.clients[0].state((s) => s.seats[turn].clues.length === 1);
    expect(next.seats[turn].clues).toEqual(['fine']);
  });

  it('a clue timeout on a human turn passes it as an empty clue', async () => {
    const room = await startedRoom();
    const snap = await toHumanTurn(room, room.snaps[0]);
    const turn = snap.round!.clueSeat!;
    await room.fireAlarm();
    const next = await room.clients[0].state((s) => s.seats[turn].clues.length === 1);
    expect(next.seats[turn].clues).toEqual(['']);
    expect(next.round!.clueSeat).not.toBe(turn);
  });

  it('bots chat once each, vote for the accused seat, the human imposter steals, humans call, and the reveal scores', async () => {
    const room = await startedRoom({ imposter: 'human' });
    await playClues(room);
    // Chat ticks fire together in fake mode, so a bot may say its line twice; count speaking seats, not lines.
    const spoke = (s: Snapshot) => new Set(s.transcript.filter((l) => l.text === FAKE_LINE).map((l) => l.seat));
    const chatted = await room.clients[0].state((s) => spoke(s).size === 3);
    expect([...spoke(chatted)].every((seat) => !room.humanSeats.includes(seat))).toBe(true);

    const impSeat = room.humanSeats[room.imposterClientIndex];
    const impAlias = room.snaps[0].seats[impSeat].alias!;
    room.clients[1].send({ type: 'chat', text: `pretty sure it is ${impAlias}` });
    await room.clients[0].state((s) => s.transcript.some((l) => l.text.includes(impAlias)));

    await room.fireAlarm();
    const voting = await room.clients[0].state((s) => s.phase === 'vote' && s.seats.filter((x) => x.voted).length === 3);
    expect(typeof voting.phaseEndsAt).toBe('number');
    for (const seat of voting.seats) expect(seat.voted).toBe(!room.humanSeats.includes(seat.index));

    const crew = room.clients.filter((_, i) => i !== room.imposterClientIndex);
    for (const c of crew) c.send({ type: 'vote', seat: impSeat });
    const crewSeat = room.humanSeats.find((s) => s !== impSeat)!;
    room.clients[room.imposterClientIndex].send({ type: 'vote', seat: crewSeat });

    const stealing = await room.clients[room.imposterClientIndex].state((s) => s.phase === 'steal');
    expect(stealing.round!.ejected).toBe(impSeat);
    room.clients[room.imposterClientIndex].send({ type: 'steal', word: 'definitely-wrong' });

    const calling = await room.clients[0].state((s) => s.phase === 'botcall');
    expect(typeof calling.phaseEndsAt).toBe('number');
    expect(calling.round!.result).toBeNull();
    for (let i = 0; i < room.clients.length; i++) {
      room.clients[i].send({ type: 'botcall', calls: perfectCalls(room.snaps[i], room.humanSeats) });
    }

    const reveal = await room.clients[0].state((s) => s.phase === 'reveal');
    expect(reveal.round).toMatchObject({ result: 'crew', stealGuess: 'definitely-wrong', ejected: impSeat });
    expect(reveal.phaseEndsAt).toBeNull();
    for (const seat of reveal.seats) {
      expect(seat.kind === 'human' || seat.kind === 'bot').toBe(true);
      expect(typeof seat.isImposter).toBe('boolean');
      expect(typeof seat.score).toBe('number');
      if (seat.kind === 'bot') {
        expect(seat.vote).toBe(impSeat);
        expect(seat.points).toMatchObject({ vote: 2, calls: 0 });
      } else {
        expect(seat.points!.calls).toBe(5);
      }
    }
    // Every crew seat voted for the imposter and the imposter missed the steal: the humans with perfect calls win.
    const crewHumans = reveal.seats.filter((s) => s.kind === 'human' && !s.isImposter).map((s) => s.index);
    expect(reveal.round!.winners).toEqual(crewHumans);
    {
    }
    expect(reveal.seats.filter((s) => s.kind === 'human').map((s) => s.displayName).sort()).toEqual([...NAMES].sort());
    expect(JSON.stringify(reveal)).not.toContain('"playerId"');

    room.clients[2].send({ type: 'again' });
    const lobby = await room.clients[0].state((s) => s.phase === 'lobby');
    expect(lobby.seats).toHaveLength(3);
    expect(lobby.round).toBeNull();
    expect(lobby.seats.map((s) => s.displayName).sort()).toEqual([...NAMES].sort());
  });

  it('a vote timeout with no majority ends the round as an imposter win after the bot call', async () => {
    const room = await startedRoom();
    await playClues(room);
    await room.fireAlarm();
    await room.clients[0].state((s) => s.phase === 'vote' && s.seats.filter((x) => x.voted).length === 3);
    await room.fireAlarm();
    const calling = await room.clients[0].state((s) => s.phase === 'botcall');
    expect(calling.round!.ejected).toBeNull();
    await room.fireAlarm();
    const reveal = await room.clients[0].state((s) => s.phase === 'reveal');
    expect(reveal.round).toMatchObject({ result: 'imposter', ejected: null });
    expect(reveal.seats.filter((s) => s.kind === 'human').every((s) => s.points!.calls === 0)).toBe(true);
    expect(reveal.round!.winners!.length).toBeGreaterThan(0);
  });

  it('one human with a bot imposter: bots clue, chat, and vote, an ejected bot imposter steals, the human scores', async () => {
    const room = await startedRoom({ names: ['Ada'], imposter: 'bot' });
    const me = room.clients[0];
    const chat = await playClues(room);
    expect(chat.phase).toBe('chat');
    await me.state((s) => new Set(s.transcript.filter((l) => l.text === FAKE_LINE).map((l) => l.seat)).size === 5);
    const target = chat.seats.find((s) => s.index !== chat.you)!;
    me.send({ type: 'chat', text: `I vote ${target.alias}` });
    await me.state((s) => s.transcript.some((l) => l.text.includes(target.alias!)));

    await room.fireAlarm();
    await me.state((s) => s.phase === 'vote' && s.seats.filter((x) => x.voted).length === 5);
    me.send({ type: 'vote', seat: target.index });
    const closed = await me.state((s) => s.phase !== 'vote');
    if (closed.phase === 'steal') {
      // The accused bot was the imposter: it guesses by itself and the round moves on.
      const decided = await me.state((s) => s.phase === 'botcall');
      expect(decided.round!.ejected).toBe(target.index);
    } else {
      expect(closed.phase).toBe('botcall');
    }
    me.send({ type: 'botcall', calls: chat.seats.map((s) => (s.index === chat.you ? null : 'bot')) });
    const reveal = await me.state((s) => s.phase === 'reveal');
    expect(reveal.round!.ejected).toBe(target.index);
    const imposters = reveal.seats.filter((s) => s.isImposter);
    expect(imposters).toHaveLength(1);
    expect(imposters[0].kind).toBe('bot');
    expect(reveal.seats[chat.you!].points!.calls).toBe(5);
    expect(reveal.seats.filter((s) => s.kind === 'bot').every((s) => s.vote !== null)).toBe(true);
    if (reveal.seats[target.index].isImposter) expect(typeof reveal.round!.stealGuess).toBe('string');
    else expect(reveal.round!.result).toBe('imposter');
  });

  it('the imposter never receives the word before the reveal', async () => {
    const room = await startedRoom({ imposter: 'human' });
    const imp = room.clients[room.imposterClientIndex];
    const word = room.snaps.find((_, i) => i !== room.imposterClientIndex)!.round!.word!;
    await playClues(room);
    await room.fireAlarm();
    await room.clients[0].state((s) => s.phase === 'vote');
    await room.fireAlarm();
    await room.clients[0].state((s) => s.phase === 'botcall');
    await room.fireAlarm();
    let leaked = false;
    let snap: Snapshot;
    do {
      snap = await imp.state();
      if (snap.phase !== 'reveal' && JSON.stringify(snap).toLowerCase().includes(word)) leaked = true;
    } while (snap.phase !== 'reveal');
    expect(leaked).toBe(false);
    expect(snap.round!.word).toBe(word);
  });
});
