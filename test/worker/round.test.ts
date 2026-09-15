import { describe, it, expect } from 'vitest';
import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { connect, createRoom, type Client } from './helpers';
import type { Snapshot } from '../../src/game/protocol';

const NAMES = ['Ada', 'Bob', 'Cal'];
/** Distinct clue words. `clue0`/`clue1` would all normalize to `clue` and be rejected as duplicates. */
const CLUE_WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];

/** Three humans in the clue phase. `seatOf[i]` is the seat index of player i; `byYou(seat)` returns that seat's client. */
async function startedRoom() {
  const code = await createRoom();
  const clients: Client[] = [];
  const snaps: Snapshot[] = [];
  for (let i = 0; i < NAMES.length; i++) {
    const c = await connect(code);
    c.send({ type: 'join', playerId: `p${i}`, displayName: NAMES[i] });
    await c.state((s) => s.you === i);
    clients.push(c);
  }
  clients[0].send({ type: 'start' });
  for (const c of clients) snaps.push(await c.state((s) => s.phase === 'clue'));
  const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
  const fireAlarm = async () => {
    expect(await runDurableObjectAlarm(stub)).toBe(true);
  };
  const byYou = (seat: number) => clients[snaps.findIndex((s) => s.you === seat)];
  const imposterClientIndex = snaps.findIndex((s) => s.seats[s.you!].isImposter);
  return { code, clients, snaps, fireAlarm, byYou, imposterClientIndex };
}

/** Plays every human clue turn with an accepted clue and returns the first chat-phase snapshot seen by client 0. */
async function playClues(room: Awaited<ReturnType<typeof startedRoom>>): Promise<Snapshot> {
  let snap = room.snaps[0];
  let n = 0;
  while (snap.phase === 'clue') {
    const turn = snap.round!.clueSeat!;
    expect(n).toBeLessThan(CLUE_WORDS.length); // a rejected clue would otherwise loop forever
    room.byYou(turn).send({ type: 'clue', word: CLUE_WORDS[n++] });
    snap = await room.clients[0].state((s) => s.phase !== 'clue' || s.round!.clueSeat !== turn);
  }
  expect(n).toBe(6);
  return snap;
}

describe('a round in the Room Durable Object', () => {
  it('starts in the clue phase on a human turn, with exactly one human imposter who cannot see the word', async () => {
    const { snaps, imposterClientIndex } = await startedRoom();
    const first = snaps[0];
    expect(typeof first.phaseEndsAt).toBe('number');
    expect(first.seats[first.round!.clueSeat!].clues).toEqual([]);
    expect(snaps.map((s) => s.you)).toContain(first.round!.clueSeat);
    expect(snaps.filter((s) => s.seats[s.you!].isImposter)).toHaveLength(1);
    expect(snaps[imposterClientIndex].round!.word).toBeNull();
    for (let i = 0; i < snaps.length; i++) {
      if (i === imposterClientIndex) continue;
      expect(typeof snaps[i].round!.word).toBe('string');
      expect(snaps[i].round!.category).toBe(snaps[imposterClientIndex].round!.category);
    }
  });

  it('rejects out-of-turn and two-word clues, accepts a valid one', async () => {
    const room = await startedRoom();
    const turn = room.snaps[0].round!.clueSeat!;
    const other = room.clients.find((c) => c !== room.byYou(turn))!;
    other.send({ type: 'clue', word: 'sneaky' });
    expect(await other.error()).toBe('not-your-turn');
    room.byYou(turn).send({ type: 'clue', word: 'two words' });
    expect(await room.byYou(turn).error()).toBe('clue-one-word');
    room.byYou(turn).send({ type: 'clue', word: 'fine' });
    const next = await room.clients[0].state((s) => s.seats[turn].clues.length === 1);
    expect(next.seats[turn].clues).toEqual(['fine']);
  });

  it('a clue timeout passes the turn as an empty clue', async () => {
    const room = await startedRoom();
    const turn = room.snaps[0].round!.clueSeat!;
    await room.fireAlarm();
    const next = await room.clients[0].state((s) => s.seats[turn].clues.length === 1);
    expect(next.seats[turn].clues).toEqual(['']);
    expect(next.round!.clueSeat).not.toBe(turn);
  });

  it('plays clues, chat, vote, a missed steal, the reveal, and play again', async () => {
    const room = await startedRoom();
    const chat = await playClues(room);
    expect(chat.phase).toBe('chat');
    room.clients[1].send({ type: 'chat', text: 'who said alpha?' });
    await room.clients[0].state((s) => s.transcript.length === 1);

    await room.fireAlarm();
    const voting = await room.clients[0].state((s) => s.phase === 'vote');
    expect(typeof voting.phaseEndsAt).toBe('number');

    const impSeat = room.snaps[room.imposterClientIndex].you!;
    const crew = room.clients.filter((_, i) => i !== room.imposterClientIndex);
    for (const c of crew) c.send({ type: 'vote', seat: impSeat });
    const crewSeat = room.snaps.find((s) => s.you !== impSeat)!.you!;
    room.clients[room.imposterClientIndex].send({ type: 'vote', seat: crewSeat });

    const stealing = await room.clients[room.imposterClientIndex].state((s) => s.phase === 'steal');
    expect(stealing.round!.ejected).toBe(impSeat);
    room.clients[room.imposterClientIndex].send({ type: 'steal', word: 'definitely-wrong' });

    const reveal = await room.clients[0].state((s) => s.phase === 'reveal');
    expect(reveal.round).toMatchObject({ result: 'crew', stealGuess: 'definitely-wrong', ejected: impSeat });
    expect(typeof reveal.round!.word).toBe('string');
    expect(reveal.phaseEndsAt).toBeNull();
    for (const seat of reveal.seats) {
      expect(seat.kind === 'human' || seat.kind === 'bot').toBe(true);
      expect(typeof seat.isImposter).toBe('boolean');
    }
    expect(reveal.seats.filter((s) => s.kind === 'human').map((s) => s.displayName).sort()).toEqual([...NAMES].sort());
    expect(JSON.stringify(reveal)).not.toContain('"playerId"');

    room.clients[2].send({ type: 'again' });
    const lobby = await room.clients[0].state((s) => s.phase === 'lobby');
    expect(lobby.seats).toHaveLength(3);
    expect(lobby.round).toBeNull();
    expect(lobby.seats.map((s) => s.displayName).sort()).toEqual([...NAMES].sort());
  });

  it('a vote timeout with no majority ends the round as an imposter win', async () => {
    const room = await startedRoom();
    await playClues(room);
    await room.fireAlarm();
    await room.clients[0].state((s) => s.phase === 'vote');
    await room.fireAlarm();
    const reveal = await room.clients[0].state((s) => s.phase === 'reveal');
    expect(reveal.round).toMatchObject({ result: 'imposter', ejected: null });
  });

  it('the imposter never receives the word before the reveal', async () => {
    const room = await startedRoom();
    const imp = room.clients[room.imposterClientIndex];
    const word = room.snaps.find((_, i) => i !== room.imposterClientIndex)!.round!.word!;
    await playClues(room);
    await room.fireAlarm();
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
