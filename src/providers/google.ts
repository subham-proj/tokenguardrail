import type { NormalizedUsage } from '../types.js';
import { heuristicCountTokens } from '../tokens/heuristic.js';
import type { ProviderAdapter } from './provider.js';

interface GeminiUsageShape {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}

/**
 * Google Gemini (the `@google/genai` SDK: `client.models.generateContent`). Usage is reported as
 * `usageMetadata`, where `promptTokenCount` is the TOTAL prompt (cache-inclusive) and
 * `cachedContentTokenCount` is a subset of it — which already matches our cross-provider invariant
 * (types.ts), so no add-back is needed (unlike Anthropic). Reasoning ("thoughts") tokens are billed
 * as output, so they are folded into `outputTokens`.
 *
 * No public local tokenizer, so the estimate uses the shared heuristic counter.
 *
 * NOTE: Gemini's request shape (`contents`, not `messages`) differs from the OpenAI/Anthropic shape
 * the tokenguard() wrapper parses, so Gemini is supported via the standalone API (estimateCost /
 * costFromUsage) but is not auto-wrapped in v1 (documented gap).
 */
export const googleProvider: ProviderAdapter = {
  id: 'google',

  detect(client) {
    if (!client || typeof client !== 'object') return false;
    const models = (client as Record<string, unknown>)['models'];
    if (!models || typeof models !== 'object') return false;
    return typeof (models as Record<string, unknown>)['generateContent'] === 'function';
  },

  async countInputTokens(input) {
    return heuristicCountTokens(input, 3);
  },

  normalizeUsage(raw): NormalizedUsage {
    const usage = (raw ?? {}) as GeminiUsageShape;
    const cachedInputTokens = usage.cachedContentTokenCount ?? 0;
    return {
      inputTokens: usage.promptTokenCount ?? 0, // already total & cache-inclusive — no add-back
      outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
      cachedInputTokens,
      cacheWriteTokens: 0, // Gemini implicit caching has no separate write charge in this schema
    };
  },

  resolvePricingKey(model) {
    const m = model.toLowerCase();
    // Anchored, most-specific first (see plan §4.3): "-lite" before the bare "-flash", etc.
    if (m.startsWith('gemini-2.5-flash-lite')) return 'gemini-2.5-flash-lite';
    if (m.startsWith('gemini-2.5-flash')) return 'gemini-2.5-flash';
    if (m.startsWith('gemini-2.5-pro')) return 'gemini-2.5-pro';
    if (m.startsWith('gemini-2.0-flash-lite')) return 'gemini-2.0-flash-lite';
    if (m.startsWith('gemini-2.0-flash')) return 'gemini-2.0-flash';
    if (m.startsWith('gemini-1.5-flash-8b')) return 'gemini-1.5-flash-8b';
    if (m.startsWith('gemini-1.5-flash')) return 'gemini-1.5-flash';
    if (m.startsWith('gemini-1.5-pro')) return 'gemini-1.5-pro';
    return model;
  },
};
