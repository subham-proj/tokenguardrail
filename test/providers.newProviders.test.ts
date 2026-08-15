import { describe, expect, it } from 'vitest';
import { googleProvider } from '../src/providers/google.js';
import { mistralProvider } from '../src/providers/mistral.js';
import { groqProvider } from '../src/providers/groq.js';
import { openaiProvider } from '../src/providers/openai.js';
import { PricingRegistry } from '../src/pricing/registry.js';

describe('googleProvider.normalizeUsage', () => {
  it('maps a plain Gemini usageMetadata response', () => {
    const usage = googleProvider.normalizeUsage({ promptTokenCount: 120, candidatesTokenCount: 45, totalTokenCount: 165 });
    expect(usage).toEqual({ inputTokens: 120, outputTokens: 45, cachedInputTokens: 0, cacheWriteTokens: 0 });
  });

  it('treats promptTokenCount as the total (cache-inclusive) — no add-back, unlike Anthropic', () => {
    const usage = googleProvider.normalizeUsage({
      promptTokenCount: 1000,
      candidatesTokenCount: 200,
      cachedContentTokenCount: 800,
    });
    expect(usage.inputTokens).toBe(1000);
    expect(usage.cachedInputTokens).toBe(800);
    expect(usage.cachedInputTokens).toBeLessThanOrEqual(usage.inputTokens); // §4.1 invariant
  });

  it('folds reasoning ("thoughts") tokens into outputTokens', () => {
    const usage = googleProvider.normalizeUsage({
      promptTokenCount: 100,
      candidatesTokenCount: 50,
      thoughtsTokenCount: 30,
    });
    expect(usage.outputTokens).toBe(80);
  });

  it('detects a @google/genai client and not an OpenAI one', () => {
    expect(googleProvider.detect({ models: { generateContent: () => {} } })).toBe(true);
    expect(googleProvider.detect({ chat: { completions: { create: () => {} } } })).toBe(false);
  });
});

describe('mistralProvider.normalizeUsage / detect', () => {
  it('maps camelCase promptTokens/completionTokens, no cache', () => {
    const usage = mistralProvider.normalizeUsage({ promptTokens: 300, completionTokens: 120, totalTokens: 420 });
    expect(usage).toEqual({ inputTokens: 300, outputTokens: 120, cachedInputTokens: 0, cacheWriteTokens: 0 });
  });

  it('detects a Mistral client (chat.complete) and not an OpenAI one (chat.completions.create)', () => {
    expect(mistralProvider.detect({ chat: { complete: () => {} } })).toBe(true);
    expect(mistralProvider.detect({ chat: { completions: { create: () => {} } } })).toBe(false);
  });
});

describe('groqProvider — reuses OpenAI accounting, distinct pricing', () => {
  it('normalizes usage identically to OpenAI', () => {
    const raw = { prompt_tokens: 50, completion_tokens: 25, prompt_tokens_details: { cached_tokens: 10 } };
    expect(groqProvider.normalizeUsage(raw)).toEqual(openaiProvider.normalizeUsage(raw));
  });

  it('does NOT auto-detect (OpenAI-shaped) — must be selected by explicit provider hint', () => {
    expect(groqProvider.detect({ chat: { completions: { create: () => {} } } })).toBe(false);
  });
});

describe('PricingRegistry — new providers resolve with anchored family matching', () => {
  const registry = new PricingRegistry();

  it.each([
    [googleProvider, 'gemini-2.5-pro', 1.25, 10],
    [googleProvider, 'gemini-2.5-flash', 0.3, 2.5],
    [googleProvider, 'gemini-2.5-flash-lite', 0.1, 0.4],
    [mistralProvider, 'mistral-large-latest', 2, 6],
    [mistralProvider, 'mistral-small-latest', 0.2, 0.6],
    [groqProvider, 'llama-3.3-70b-versatile', 0.59, 0.79],
    [groqProvider, 'llama-3.1-8b-instant', 0.05, 0.08],
  ])('%s / %s resolves exactly', (provider, model, input, output) => {
    const { price, source } = registry.resolve(provider as never, model as string);
    expect(source).toBe('exact');
    expect(price.inputPerMTok).toBe(input);
    expect(price.outputPerMTok).toBe(output);
  });

  it('resolves an undated Gemini "-lite" before the bare "-flash" family (anchored order)', () => {
    // gemini-2.5-flash-lite-preview must NOT collapse to gemini-2.5-flash.
    const { price, source } = registry.resolve(googleProvider, 'gemini-2.5-flash-lite-preview-09-2026');
    expect(source).toBe('family');
    expect(price.inputPerMTok).toBe(0.1); // lite rate, not flash's 0.3
  });

  it('resolves a dated Mistral snapshot via alias', () => {
    const { price, source } = registry.resolve(mistralProvider, 'mistral-large-2411');
    expect(source).toBe('exact');
    expect(price.inputPerMTok).toBe(2);
  });
});
