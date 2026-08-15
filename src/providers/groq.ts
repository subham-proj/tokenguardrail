import type { ProviderAdapter } from './provider.js';
import { openaiProvider } from './openai.js';

/**
 * Groq exposes an OpenAI-compatible surface: the same `chat.completions.create` client shape and
 * the same `prompt_tokens` / `completion_tokens` usage accounting. So this adapter reuses OpenAI's
 * token counting and usage normalization wholesale; only the id, the pricing families, and detect
 * differ.
 *
 * NOTE: because the client shape is identical to OpenAI's, `detect()` cannot tell a Groq client
 * apart from an OpenAI one by duck-typing. The standalone API takes `provider` explicitly, so it
 * is unaffected; the tokenguard() wrapper needs an explicit `provider: 'groq'` hint (see
 * wrapper/tokenguard.ts). `detect` therefore returns false to avoid hijacking OpenAI clients.
 */
export const groqProvider: ProviderAdapter = {
  id: 'groq',

  detect() {
    return false; // OpenAI-shaped — disambiguated only via the wrapper `provider` hint.
  },

  countInputTokens(input) {
    return openaiProvider.countInputTokens(input);
  },

  normalizeUsage(raw) {
    return openaiProvider.normalizeUsage(raw);
  },

  resolvePricingKey(model) {
    const m = model.toLowerCase();
    // Anchored, most-specific first (see plan §4.3). Groq hosts open-weight models.
    if (m.startsWith('llama-3.3-70b')) return 'llama-3.3-70b-versatile';
    if (m.startsWith('llama-3.1-8b')) return 'llama-3.1-8b-instant';
    if (m.startsWith('llama-3.1-70b')) return 'llama-3.1-70b-versatile';
    if (m.startsWith('llama3-70b')) return 'llama3-70b-8192';
    if (m.startsWith('llama3-8b')) return 'llama3-8b-8192';
    if (m.startsWith('mixtral-8x7b')) return 'mixtral-8x7b-32768';
    if (m.startsWith('gemma2-9b')) return 'gemma2-9b-it';
    return model;
  },
};
