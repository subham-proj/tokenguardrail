import type { NormalizedUsage } from '../types.js';
import { heuristicCountTokens } from '../tokens/heuristic.js';
import type { ProviderAdapter } from './provider.js';

interface MistralUsageShape {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/**
 * Mistral has its own SDK: `client.chat.complete({ model, messages })`, with usage reported as
 * `promptTokens` / `completionTokens` (camelCase) and no prompt-cache accounting. No public local
 * tokenizer, so the estimate uses the shared heuristic counter.
 */
export const mistralProvider: ProviderAdapter = {
  id: 'mistral',

  detect(client) {
    if (!client || typeof client !== 'object') return false;
    const chat = (client as Record<string, unknown>)['chat'];
    if (!chat || typeof chat !== 'object') return false;
    // `chat.complete` (not `.completions.create`) is what distinguishes Mistral from OpenAI.
    return typeof (chat as Record<string, unknown>)['complete'] === 'function';
  },

  async countInputTokens(input) {
    return heuristicCountTokens(input, 3);
  },

  normalizeUsage(raw): NormalizedUsage {
    const usage = (raw ?? {}) as MistralUsageShape;
    return {
      inputTokens: usage.promptTokens ?? 0,
      outputTokens: usage.completionTokens ?? 0,
      cachedInputTokens: 0, // Mistral does not report prompt-cache tokens.
      cacheWriteTokens: 0,
    };
  },

  resolvePricingKey(model) {
    const m = model.toLowerCase();
    // Anchored, most-specific first (see plan §4.3).
    if (m.startsWith('mistral-large')) return 'mistral-large-latest';
    if (m.startsWith('mistral-small')) return 'mistral-small-latest';
    if (m.startsWith('mistral-medium')) return 'mistral-medium-latest';
    if (m.startsWith('ministral-8b')) return 'ministral-8b-latest';
    if (m.startsWith('ministral-3b')) return 'ministral-3b-latest';
    if (m.startsWith('codestral')) return 'codestral-latest';
    if (m.startsWith('pixtral-large')) return 'pixtral-large-latest';
    if (m.startsWith('open-mistral-nemo')) return 'open-mistral-nemo';
    return model;
  },
};
