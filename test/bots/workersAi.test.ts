import { describe, it, expect } from 'vitest';
import { apply, createRoom, type RoomState } from '../../src/game/state';
import type { Env } from '../../src/worker/env';
import { makeRunner } from '../../src/worker/bots';
import { DEFAULT_MODEL, MAX_OUTPUT_TOKENS, parseAiResponse, WorkersAiBackend, type AiLike } from '../../src/worker/backends/workersAi';
import { PERSONAS, schemaFor, styleSheet, type BotInputs } from '../../src/worker/prompts';

function inputs(action: BotInputs['action']): BotInputs {
  const ctx = {
    seat: 1,
    alias: 'Coral Newt',
    aliases: ['Amber Fox', 'Coral Newt', 'Teal Otter', 'Slate Yak', 'Mint Ibis', 'Rust Gecko'],
    category: 'Food',
    word: 'pizza',
    isImposter: false,
    cluesBySeat: [['cheese'], [], [], [], [], []],
    transcript: [],
    style: styleSheet([]),
    persona: PERSONAS[1],
  };
  return action === 'clue' ? { action, pass: 1, ...ctx } : { action, ...ctx };
}

function stubAi(reply: unknown): AiLike & { calls: { model: string; inputs: Record<string, unknown> }[] } {
  const ai = {
    calls: [] as { model: string; inputs: Record<string, unknown> }[],
    async run(model: string, req: Record<string, unknown>) {
      ai.calls.push({ model, inputs: req });
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return ai;
}

describe('parseAiResponse', () => {
  it('returns an object response as is, parses a JSON string, strips code fences, and reads OpenAI-style choices', () => {
    expect(parseAiResponse({ response: { clue: 'brick' } })).toEqual({ clue: 'brick' });
    expect(parseAiResponse({ response: '{"clue":"brick"}' })).toEqual({ clue: 'brick' });
    expect(parseAiResponse({ response: '```json\n{"say": null}\n```' })).toEqual({ say: null });
    expect(parseAiResponse({ choices: [{ message: { content: '{"vote": 3}' } }] })).toEqual({ vote: 3 });
  });

  it('throws on empty or non-JSON replies so the runner falls back', () => {
    expect(() => parseAiResponse(null)).toThrow();
    expect(() => parseAiResponse({})).toThrow();
    expect(() => parseAiResponse({ response: 'not json' })).toThrow();
    expect(() => parseAiResponse({ response: 7 })).toThrow();
  });
});

describe('WorkersAiBackend', () => {
  it('sends the model id, system and user messages, the action schema, the token cap, and the action temperature', async () => {
    const ai = stubAi({ response: { clue: 'brick' } });
    const backend = new WorkersAiBackend(ai, DEFAULT_MODEL);
    expect(await backend.run(inputs('clue'))).toEqual({ clue: 'brick' });
    expect(ai.calls[0].model).toBe('@cf/google/gemma-4-26b-a4b-it');
    const req = ai.calls[0].inputs;
    expect(req.response_format).toEqual({ type: 'json_schema', json_schema: schemaFor('clue') });
    expect(req.max_tokens).toBe(MAX_OUTPUT_TOKENS);
    expect(MAX_OUTPUT_TOKENS).toBe(80);
    expect(req.temperature).toBe(0.3);
    expect(req.chat_template_kwargs).toEqual({ enable_thinking: false });
    const messages = req.messages as { role: string; content: string }[];
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(messages[0].content).toContain('Imposter Turing');
    expect(messages[1].content).toContain('cheese');
    await backend.run(inputs('chat'));
    expect(ai.calls[1].inputs.temperature).toBe(0.8);
    expect(ai.calls[1].inputs.response_format).toEqual({ type: 'json_schema', json_schema: schemaFor('chat') });
  });

  it('lets a binding error propagate so the runner can fall back', async () => {
    const backend = new WorkersAiBackend(stubAi(new Error('3040: Daily quota exceeded')), DEFAULT_MODEL);
    await expect(backend.run(inputs('vote'))).rejects.toThrow(/quota/);
  });
});

describe('makeRunner', () => {
  function started(): RoomState {
    for (let seed = 1; seed < 1000; seed++) {
      let s = createRoom('ABCD', 0);
      s = apply(s, { type: 'join', playerId: 'p0', displayName: 'Ada', at: 0 }).state;
      s = apply(s, { type: 'start', playerId: 'p0', at: 1000, seed }).state;
      if (s.seats[0].kind === 'bot' && !s.seats[0].isImposter) return s;
    }
    throw new Error('no seed');
  }
  const env = (over: Partial<Env>): Env => ({ ROOMS: {} as Env['ROOMS'], ASSETS: {} as Env['ASSETS'], BOT_MODE: 'live', ...over });
  const turn = { type: 'botTurn' as const, seat: 0, action: 'clue' as const, delayMs: 0 };

  it('uses the AI binding and BOT_MODEL in live mode', async () => {
    const ai = stubAi({ response: { clue: 'brick' } });
    const runner = makeRunner(env({ AI: ai, BOT_MODEL: '@cf/test/model' }));
    expect(await runner.turn(started(), turn)).toMatchObject({ type: 'botClue', word: 'brick' });
    expect(ai.calls[0].model).toBe('@cf/test/model');
  });

  it('falls back to scripted clues when the binding fails, and runs scripted when live mode has no binding', async () => {
    const ai = stubAi(new Error('boom'));
    const runner = makeRunner(env({ AI: ai }));
    const event = await runner.turn(started(), turn);
    expect(event).toMatchObject({ type: 'botClue' });
    expect((event as { word: string }).word).not.toBe('brick');
    const noBinding = makeRunner(env({}));
    expect(await noBinding.turn(started(), turn)).toMatchObject({ type: 'botClue' });
  });
});
