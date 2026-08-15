import { describe, expect, it } from 'vitest';
import { calculateCost } from '../src/cost/calculate.js';
import type { ModelPrice } from '../src/types.js';

const PRICE: ModelPrice = {
  inputPerMTok: 3,
  outputPerMTok: 15,
  cacheReadPerMTok: 0.3,
  cacheWritePerMTok: 3.75,
  updatedAt: '2026-08-03',
};

describe('calculateCost', () => {
  it('charges full input + output price when there is no caching', () => {
    const cost = calculateCost(
      { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 0, cacheWriteTokens: 0 },
      PRICE
    );
    expect(cost).toBeCloseTo(3 + 15, 6);
  });

  it('does not double-charge cached and cache-write tokens (both are subsets of inputTokens)', () => {
    // 1M total input tokens: 400k billed full price, 400k cache reads, 200k cache writes.
    const cost = calculateCost(
      {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cachedInputTokens: 400_000,
        cacheWriteTokens: 200_000,
      },
      PRICE
    );
    // 400k * 3/1e6 + 400k * 0.3/1e6 + 200k * 3.75/1e6
    const expected = 400_000 * (3 / 1e6) + 400_000 * (0.3 / 1e6) + 200_000 * (3.75 / 1e6);
    expect(cost).toBeCloseTo(expected, 9);
  });

  it('falls back to inputPerMTok when cache rates are absent', () => {
    const priceWithoutCacheRates: ModelPrice = {
      inputPerMTok: 2.5,
      outputPerMTok: 10,
      updatedAt: '2026-08-03',
    };
    const cost = calculateCost(
      { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 500_000, cacheWriteTokens: 0 },
      priceWithoutCacheRates
    );
    // Falls back to full inputPerMTok for the whole 1M since no cache rate is configured.
    expect(cost).toBeCloseTo(1_000_000 * (2.5 / 1e6), 9);
  });
});
