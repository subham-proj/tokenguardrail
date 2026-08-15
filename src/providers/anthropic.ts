import type { NormalizedUsage } from '../types.js';
import { heuristicCountTokens } from '../tokens/heuristic.js';
import type { ProviderAdapter } from './provider.js';

interface AnthropicUsageShape {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export const anthropicProvider: ProviderAdapter = {
  id: 'anthropic',

  detect(client) {
    if (!client || typeof client !== 'object') return false;
    const messages = (client as Record<string, unknown>)['messages'];
    if (!messages || typeof messages !== 'object') return false;
    return typeof (messages as Record<string, unknown>)['create'] === 'function';
  },

  async countInputTokens(input) {
    // No public local tokenizer for Anthropic; the official `count_tokens` endpoint is a
    // later opt-in exact mode (network round-trip) — see plan §8. Heuristic is the estimate.
    return heuristicCountTokens(input, 3);
  },

  normalizeUsage(raw): NormalizedUsage {
    const usage = (raw ?? {}) as AnthropicUsageShape;
    const cachedInputTokens = usage.cache_read_input_tokens ?? 0;
    const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;

    // Anthropic's `input_tokens` EXCLUDES cache read/write tokens (non-overlapping buckets),
    // unlike OpenAI. Add them back so `inputTokens` is the TOTAL, matching the cross-provider
    // invariant in types.ts — otherwise cost/calculate.ts would double-subtract them.
    return {
      inputTokens: (usage.input_tokens ?? 0) + cachedInputTokens + cacheWriteTokens,
      outputTokens: usage.output_tokens ?? 0,
      cachedInputTokens,
      cacheWriteTokens,
    };
  },

  resolvePricingKey(model) {
    const m = model.toLowerCase();
    // Most-specific first: every "4-N" minor version must be checked before a same-major
    // bare fallback, or the bare check would swallow it (see plan §4.3 on anchored ordering).
    // Anthropic's real IDs always carry a minor version (opus-4-1 … opus-4-8, sonnet-4-5,
    // sonnet-4-6) — there is no bare "opus-4"/"sonnet-4" family, so no such fallback exists.
    if (m.includes('opus-4-8') || m.includes('opus-4.8')) return 'claude-opus-4-8';
    if (m.includes('opus-4-7') || m.includes('opus-4.7')) return 'claude-opus-4-7';
    if (m.includes('opus-4-6') || m.includes('opus-4.6')) return 'claude-opus-4-6';
    if (m.includes('opus-4-5') || m.includes('opus-4.5')) return 'claude-opus-4-5';
    if (m.includes('opus-4-1') || m.includes('opus-4.1')) return 'claude-opus-4-1';
    if (m.includes('opus-5')) return 'claude-opus-5';
    if (m.includes('sonnet-4-6') || m.includes('sonnet-4.6')) return 'claude-sonnet-4-6';
    if (m.includes('sonnet-4-5') || m.includes('sonnet-4.5')) return 'claude-sonnet-4-5';
    if (m.includes('sonnet-5')) return 'claude-sonnet-5';
    if (m.includes('haiku-4-5') || m.includes('haiku-4.5')) return 'claude-haiku-4-5';
    if (m.includes('mythos')) return 'claude-fable-5';
    if (m.includes('fable')) return 'claude-fable-5';
    if (m.startsWith('claude-3-7-sonnet') || m.startsWith('claude-3.7-sonnet')) return 'claude-3-7-sonnet-20250219';
    if (m.startsWith('claude-3-5-sonnet') || m.startsWith('claude-3.5-sonnet')) return 'claude-3-5-sonnet-20241022';
    if (m.startsWith('claude-3-5-haiku') || m.startsWith('claude-3.5-haiku')) return 'claude-3-5-haiku-20241022';
    if (m.startsWith('claude-3-opus')) return 'claude-3-opus-20240229';
    if (m.startsWith('claude-3-sonnet')) return 'claude-3-sonnet-20240229';
    if (m.startsWith('claude-3-haiku')) return 'claude-3-haiku-20240307';
    return model;
  },
};
