import type { ModelPrice, PricingSource } from '../types.js';
import type { ProviderAdapter } from '../providers/provider.js';
import pricingJson from './pricing.json' with { type: 'json' };

interface PricingJsonShape {
  version: number;
  models: Record<string, ModelPrice>;
  aliases: Record<string, string>;
}

const data = pricingJson as PricingJsonShape;

/** Conservative fallback for models with no pricing entry at all (flagged pricingSource: 'unknown'). */
const FALLBACK_PRICE: ModelPrice = {
  inputPerMTok: 2.5,
  outputPerMTok: 10,
  cacheReadPerMTok: null,
  cacheWritePerMTok: null,
  updatedAt: 'unknown',
};

export interface PricingRegistryOptions {
  overrides?: Record<string, Partial<ModelPrice>>;
}

export interface PricingResolution {
  price: ModelPrice;
  source: PricingSource;
}

/**
 * Resolves a model to a price via the chain: exact key → aliases → provider
 * `resolvePricingKey()` family match → unknown fallback. Per-instance overrides win over
 * whatever the chain finds and are flagged with pricingSource 'override' so drift stays visible.
 */
export class PricingRegistry {
  private readonly overrides: Record<string, Partial<ModelPrice>>;

  constructor(options: PricingRegistryOptions = {}) {
    this.overrides = options.overrides ?? {};
  }

  resolve(provider: ProviderAdapter, model: string): PricingResolution {
    const exact = data.models[model];
    if (exact) {
      return this.applyOverride(model, exact, 'exact');
    }

    const aliasTarget = data.aliases[model];
    if (aliasTarget) {
      const aliased = data.models[aliasTarget];
      if (aliased) return this.applyOverride(model, aliased, 'exact');
    }

    const familyKey = provider.resolvePricingKey(model);
    if (familyKey !== model) {
      const family = data.models[familyKey] ?? this.resolveAlias(familyKey);
      if (family) return this.applyOverride(model, family, 'family');
    }

    return this.applyOverride(model, FALLBACK_PRICE, 'unknown');
  }

  private resolveAlias(key: string): ModelPrice | undefined {
    const target = data.aliases[key];
    return target ? data.models[target] : undefined;
  }

  private applyOverride(model: string, base: ModelPrice, source: PricingSource): PricingResolution {
    const override = this.overrides[model];
    if (!override) return { price: base, source };
    return { price: { ...base, ...override }, source: 'override' };
  }
}
