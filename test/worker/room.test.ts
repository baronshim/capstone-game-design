import { describe, it, expect } from 'vitest';
import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { connect, createRoom } from './helpers';

async function lobbyWithTwo() {
  const code = await createRoom();
  const a = await connect(code);
  const b = await connect(code);
  a.send({ type: 'join', playerId: 'pa', displayName: 'Ada' });
  await a.state((s) => s.you === 0);
  b.send({ type: 'join', playerId: 'pb', displayName: 'Bob' });
  await b.state((s) => s.you === 1);
  return { code, a, b };
}

describe('Room Durable Object', () => {
  it('allocates a 4-letter code and refuses unknown rooms with a readable error', async () => {
    const code = await createRoom();
    expect(code).toMatch(/^[A-Z]{4}$/);
    const ghost = await connect(code === 'ZZZZ' ? 'YYYY' : 'ZZZZ');
    expect(await ghost.error()).toBe('room-not-found');
  });

  it('seats players, shows names in the lobby, hides other kinds, and relays chat', async () => {
    const { a, b } = await lobbyWithTwo();
    a.send({ type: 'chat', text: 'hello from ada' });
    const seen = await b.state((s) => s.transcript.some((l) => l.text === 'hello from ada'));
    expect(seen.seats[0].displayName).toBe('Ada');
    expect(seen.seats[0].kind).toBeUndefined();
    expect(seen.seats[1].kind).toBe('human');
    expect(JSON.stringify(seen)).not.toContain('"playerId"');
  });

  it('relays a typing ping to the other seats only, and throttles repeats', async () => {
    const { a, b } = await lobbyWithTwo();
    a.send({ type: 'typing' });
    const seen = await b.next((m) => m.type === 'typing');
    expect(seen).toEqual({ type: 'typing', seat: 0, ms: 3000 });
    a.send({ type: 'typing' });
    a.send({ type: 'chat', text: 'done typing' });
    await b.state((s) => s.transcript.some((l) => l.text === 'done typing'));
    // The second ping came within 1.5s of the first, so nothing else arrived before the chat line.
    await expect(b.next((m) => m.type === 'typing')).rejects.toThrow(/timed out/);
  }, 8000);

  it('start fills six aliased seats, clears the transcript, and redacts other seats', async () => {
    const { a, b } = await lobbyWithTwo();
    a.send({ type: 'chat', text: 'lobby talk' });
    await b.state((s) => s.transcript.length === 1);
    a.send({ type: 'start' });
    const started = await b.state((s) => s.phase === 'deal');
    expect(started.seats).toHaveLength(6);
    expect(started.seats.every((s) => typeof s.alias === 'string')).toBe(true);
    expect(started.transcript).toEqual([]);
    for (const seat of started.seats) {
      if (seat.index === started.you) continue;
      expect(seat.displayName).toBeUndefined();
      expect(seat.kind).toBeUndefined();
    }
    expect(JSON.stringify(started)).not.toContain('"playerId"');
  });

  it('marks a dropped player and reconnects the same playerId to the same seat', async () => {
    const { code, a, b } = await lobbyWithTwo();
    a.send({ type: 'start' });
    const started = await b.state((s) => s.phase !== 'lobby');
    b.ws.close(1000, 'dropped');
    const dropped = await a.state((s) => s.seats.some((seat) => !seat.connected));
    expect(dropped.seats.filter((seat) => !seat.connected)).toHaveLength(1);

    const b2 = await connect(code);
    b2.send({ type: 'join', playerId: 'pb', displayName: 'Bob' });
    const back = await b2.state((s) => s.you !== null);
    expect(back.you).toBe(started.you);
    expect(back.seats.every((seat) => seat.connected)).toBe(true);
  });

  it('refuses a late joiner after start', async () => {
    const { code, a } = await lobbyWithTwo();
    a.send({ type: 'start' });
    await a.state((s) => s.phase !== 'lobby');
    const late = await connect(code);
    late.send({ type: 'join', playerId: 'late', displayName: 'Late' });
    expect(await late.error()).toBe('room-started');
  });

  it('rejects hostile frames without crashing', async () => {
    const code = await createRoom();

    // A fresh socket that has never joined: the JSON/shape guards run before the
    // join check, so both malformed frames still come back as bad-json.
    const fresh = await connect(code);
    fresh.ws.send('not json');
    expect(await fresh.error()).toBe('bad-json');
    fresh.ws.send('[]');
    expect(await fresh.error()).toBe('bad-json');
    fresh.ws.send(JSON.stringify({ type: 'chat', text: 'x' }));
    expect(await fresh.error()).toBe('not-joined');

    const { a } = await lobbyWithTwo();
    a.send({ type: 'nope' });
    expect(await a.error()).toBe('unknown-type');
    a.send({ type: 'vote', seat: 99 });
    expect(await a.error()).toBe('wrong-phase');

    // The room and this socket are still alive after all of the above.
    a.send({ type: 'chat', text: 'still here' });
    const seen = await a.state((s) => s.transcript.some((l) => l.text === 'still here'));
    expect(seen.transcript.some((l) => l.text === 'still here')).toBe(true);
  });

  it('deletes an empty room when its alarm fires', async () => {
    const code = await createRoom();
    const a = await connect(code);
    a.send({ type: 'join', playerId: 'pa', displayName: 'Ada' });
    await a.state();
    a.ws.close(1000, 'bye');
    await new Promise((r) => setTimeout(r, 50));
    const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const back = await connect(code);
    expect(await back.error()).toBe('room-not-found');
  });
});
