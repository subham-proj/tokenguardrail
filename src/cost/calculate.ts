import type { ModelPrice, NormalizedUsage } from '../types.js';

/**
 * (tokens, price) → USD. Pure, cache-aware.
 *
 * Relies on the NormalizedUsage invariant (types.ts): `cachedInputTokens` and
 * `cacheWriteTokens` are subsets of `inputTokens`, so both must be subtracted out of the
 * full-price term — subtracting only `cachedInputTokens` would double-charge cache writes.
 */
export function calculateCost(usage: NormalizedUsage, price: ModelPrice): number {
  const uncachedInputTokens = usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteTokens;
  const cacheReadRate = price.cacheReadPerMTok ?? price.inputPerMTok;
  const cacheWriteRate = price.cacheWritePerMTok ?? price.inputPerMTok;

  const cost =
    uncachedInputTokens * price.inputPerMTok +
    usage.cachedInputTokens * cacheReadRate +
    usage.cacheWriteTokens * cacheWriteRate +
    usage.outputTokens * price.outputPerMTok;

  return cost / 1_000_000;
}
