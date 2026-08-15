import type { CountInput, NormalizedUsage } from '../types.js';

/**
 * The single seam per provider (Strategy + Adapter). Owns everything provider-specific:
 * client detection, input token counting, usage normalization, and pricing-key resolution.
 */
export interface ProviderAdapter {
  id: string;

  /** Duck-types the client's shape for tokenguard() auto-detection. No `instanceof` on optional peer deps. */
  detect(client: unknown): boolean;

  /** Async: exact mode may lazily import a tokenizer (see providers/openai.ts). */
  countInputTokens(input: CountInput): Promise<number>;

  /** Adapter: raw provider `usage` → the cross-provider NormalizedUsage shape (see types.ts invariant). */
  normalizeUsage(raw: unknown): NormalizedUsage;

  /**
   * Resolve a model id to a pricing-family key. Must use anchored prefix/family rules, never
   * two-way substring `includes()` (that mis-resolves models, e.g. a bare `o1` matching `o1-preview`).
   * Returns `model` unchanged as the sentinel for "no family match found."
   */
  resolvePricingKey(model: string): string;
}

/** Register + look up providers by id. Adding a provider = register one object. */
export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderAdapter>();

  register(provider: ProviderAdapter): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): ProviderAdapter | undefined {
    return this.providers.get(id);
  }

  require(id: string): ProviderAdapter {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new Error(
        `tokenguardrail: unknown provider "${id}". Registered providers: ${[...this.providers.keys()].join(', ')}`
      );
    }
    return provider;
  }

  detect(client: unknown): ProviderAdapter | undefined {
    for (const provider of this.providers.values()) {
      if (provider.detect(client)) return provider;
    }
    return undefined;
  }

  list(): ProviderAdapter[] {
    return [...this.providers.values()];
  }
}
