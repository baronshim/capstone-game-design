import type { BotBackend } from '../bots';
import type { BotInputs } from '../prompts';
import { CATEGORIES, validateClue } from '../../game/words';

/** Generic clues per category for when no model is available (spec 4.5). None of these is a secret word. */
export const FALLBACK_CLUES: Record<string, string[]> = {
  Space: ['sky', 'dark', 'float', 'vast', 'science', 'beyond', 'gravity', 'distant'],
  'Golden record': ['sound', 'earth', 'noise', 'loud', 'nature', 'human', 'echo', 'alive'],
  'Rocket launch': ['blast', 'smoke', 'thrust', 'soar', 'build', 'festival', 'glue', 'hobby'],
  'Road trip': ['travel', 'miles', 'road', 'wheels', 'rest', 'journey', 'stop', 'pack'],
  'Places in the book': ['city', 'state', 'far', 'warm', 'crowd', 'visit', 'west', 'home'],
  'Recording kit': ['audio', 'voice', 'press', 'listen', 'gadget', 'pocket', 'tech', 'button'],
  Family: ['together', 'related', 'love', 'older', 'younger', 'house', 'name', 'blood'],
};

/**
 * The vote every backend falls back to (spec 4.5): the seat other players
 * mention most in chat, ties to the lowest seat, else the next seat along.
 * The bot's own lines and mentions of itself do not count.
 */
export function ruleVote(inputs: BotInputs): number {
  const n = inputs.aliases.length;
  const counts = new Array<number>(n).fill(0);
  for (const line of inputs.transcript) {
    if (line.seat === inputs.seat) continue;
    const text = line.text.toLowerCase();
    inputs.aliases.forEach((alias, i) => {
      if (i !== inputs.seat && text.includes(alias.toLowerCase())) counts[i]++;
    });
  }
  let best = -1;
  let bestCount = 0;
  for (let i = 0; i < n; i++) {
    if (counts[i] > bestCount) {
      best = i;
      bestCount = counts[i];
    }
  }
  return best >= 0 ? best : (inputs.seat + 1) % n;
}

/** No model: fallback-list clues, silence in chat, the rule vote, and a category word for the steal (spec 5.6). */
export class ScriptedBackend implements BotBackend {
  async run(inputs: BotInputs): Promise<unknown> {
    switch (inputs.action) {
      case 'clue': {
        const prior = inputs.cluesBySeat.flat();
        const candidates = FALLBACK_CLUES[inputs.category] ?? [];
        const clue = candidates.find((w) => validateClue(w, inputs.word ?? '', prior, inputs.word !== null).ok) ?? '';
        return { clue };
      }
      case 'chat':
        return { say: null };
      case 'vote':
        return { vote: ruleVote(inputs) };
      case 'steal': {
        const clues = new Set(inputs.cluesBySeat.flat().map((c) => c.toLowerCase()));
        const words = CATEGORIES.find((c) => c.name === inputs.category)?.words ?? ['unknown'];
        return { word: words.find((w) => !clues.has(w)) ?? words[0] };
      }
    }
  }
}
