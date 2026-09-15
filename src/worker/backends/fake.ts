import type { BotInputs } from '../prompts';
import { ScriptedBackend } from './scripted';

/** Twelve distinct alphabetic words, one per (seat, pass), none a secret word or a stem of one. */
export const FAKE_CLUES = ['apple', 'brick', 'cloud', 'drum', 'ember', 'flute', 'grape', 'hinge', 'ivory', 'jelly', 'kite', 'lemon'];
export const FAKE_LINE = 'beep';

/** Canned, deterministic outputs for tests and local development: a fixed clue per turn, one chat line per round, scripted votes and steals. */
export class FakeBackend extends ScriptedBackend {
  override async run(inputs: BotInputs): Promise<unknown> {
    if (inputs.action === 'clue') return { clue: FAKE_CLUES[inputs.seat * 2 + (inputs.pass - 1)] };
    if (inputs.action === 'chat') {
      const spoken = inputs.transcript.some((l) => l.seat === inputs.seat);
      return { say: spoken ? null : FAKE_LINE };
    }
    return super.run(inputs);
  }
}
