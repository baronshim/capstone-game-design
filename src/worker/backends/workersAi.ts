import type { BotBackend } from '../bots';
import { type BotInputs, buildMessages, schemaFor } from '../prompts';

/** Verified in the Workers AI catalog on 2026-09-15 (spec 5.6). */
export const DEFAULT_MODEL = '@cf/google/gemma-4-26b-a4b-it';
/** Every reply is a tiny JSON object; 80 tokens is plenty and caps the neuron cost (spec 5.6). */
export const MAX_OUTPUT_TOKENS = 80;

/** The slice of the Workers AI binding this backend uses, typed loosely so a model id from config type-checks. */
export interface AiLike {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

/** One Workers AI call per action with a JSON-schema response format (spec 5.2, 5.6). */
export class WorkersAiBackend implements BotBackend {
  constructor(
    private readonly ai: AiLike,
    private readonly model: string,
  ) {}

  async run(inputs: BotInputs): Promise<unknown> {
    const { system, user } = buildMessages(inputs);
    const res = await this.ai.run(this.model, {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_schema', json_schema: schemaFor(inputs.action) },
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: inputs.action === 'chat' ? 0.8 : 0.3,
    });
    return parseAiResponse(res);
  }
}

/**
 * Workers AI answers either `{ response }` (an object in JSON mode, or a string)
 * or an OpenAI-style `choices` array. Throws on anything that is not JSON so the
 * runner treats it as a failed call.
 */
export function parseAiResponse(res: unknown): unknown {
  if (res === null || typeof res !== 'object') throw new Error('ai-empty');
  const r = res as { response?: unknown; choices?: { message?: { content?: unknown } }[] };
  const body = r.response ?? r.choices?.[0]?.message?.content;
  if (body === undefined || body === null) throw new Error('ai-empty');
  if (typeof body === 'object') return body;
  if (typeof body !== 'string') throw new Error('ai-unexpected');
  const text = body.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(text);
}
