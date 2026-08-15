import { describe, expect, it } from 'vitest';
import { openaiProvider } from '../src/providers/openai.js';
import { anthropicProvider } from '../src/providers/anthropic.js';

describe('openaiProvider.normalizeUsage', () => {
  it('maps a plain (uncached) response', () => {
    // Real shape: https://platform.openai.com/docs/api-reference/chat/object
    const usage = openaiProvider.normalizeUsage({
      prompt_tokens: 120,
      completion_tokens: 45,
      total_tokens: 165,
    });

    expect(usage).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it('treats prompt_tokens as the TOTAL, with cached_tokens as a subset', () => {
    const usage = openaiProvider.normalizeUsage({
      prompt_tokens: 1024,
      completion_tokens: 200,
      prompt_tokens_details: { cached_tokens: 896 },
    });

    expect(usage.inputTokens).toBe(1024); // unchanged — already the total
    expect(usage.cachedInputTokens).toBe(896);
    expect(usage.cacheWriteTokens).toBe(0);
    // Invariant: cached tokens must be a subset of the total.
    expect(usage.cachedInputTokens).toBeLessThanOrEqual(usage.inputTokens);
  });
});

describe('anthropicProvider.normalizeUsage', () => {
  it('maps a plain (uncached) response', () => {
    // Real shape: https://docs.claude.com/en/api/messages
    const usage = anthropicProvider.normalizeUsage({
      input_tokens: 120,
      output_tokens: 45,
    });

    expect(usage).toEqual({
      inputTokens: 120,
      outputTokens: 45,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it('adds cache_read/cache_creation back onto input_tokens (non-overlapping buckets)', () => {
    // Anthropic's input_tokens EXCLUDES cache tokens — this is the exact case that
    // would silently under-count (or go negative) without the §4.1 invariant fix.
    const usage = anthropicProvider.normalizeUsage({
      input_tokens: 50,
      output_tokens: 200,
      cache_read_input_tokens: 900,
      cache_creation_input_tokens: 100,
    });

    // Total input = the billed-full-price remainder (50) + cache read (900) + cache write (100).
    expect(usage.inputTokens).toBe(1050);
    expect(usage.cachedInputTokens).toBe(900);
    expect(usage.cacheWriteTokens).toBe(100);

    // Invariant: cached + cache-write tokens never exceed the total, and the remainder
    // billed at full input price is non-negative.
    const uncached = usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteTokens;
    expect(uncached).toBeGreaterThanOrEqual(0);
    expect(uncached).toBe(50);
  });

  it('handles a cache-write-only response (first call priming the cache)', () => {
    const usage = anthropicProvider.normalizeUsage({
      input_tokens: 10,
      output_tokens: 50,
      cache_creation_input_tokens: 990,
    });

    expect(usage.inputTokens).toBe(1000);
    expect(usage.cachedInputTokens).toBe(0);
    expect(usage.cacheWriteTokens).toBe(990);
  });
});
