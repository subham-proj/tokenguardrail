import { describe, expect, it } from 'vitest';
import { PricingRegistry } from '../src/pricing/registry.js';
import { openaiProvider } from '../src/providers/openai.js';
import { anthropicProvider } from '../src/providers/anthropic.js';

describe('PricingRegistry.resolve', () => {
  it('resolves an exact model key', () => {
    const registry = new PricingRegistry();
    const { price, source } = registry.resolve(openaiProvider, 'gpt-4o');
    expect(source).toBe('exact');
    expect(price.inputPerMTok).toBe(2.5);
  });

  it('resolves a dated snapshot via aliases', () => {
    const registry = new PricingRegistry();
    const { price, source } = registry.resolve(openaiProvider, 'gpt-4o-2024-08-06');
    expect(source).toBe('exact');
    expect(price.inputPerMTok).toBe(2.5);
  });

  it('resolves an unlisted dated snapshot via the provider family match', () => {
    const registry = new PricingRegistry();
    // Not in pricing.json or aliases — must fall through to resolvePricingKey().
    const { price, source } = registry.resolve(openaiProvider, 'gpt-4o-2025-03-01');
    expect(source).toBe('family');
    expect(price.inputPerMTok).toBe(2.5);
  });

  it('never mis-resolves a short model id to a longer unrelated one (anchored, not substring)', () => {
    const registry = new PricingRegistry();
    // A bare "o1" must resolve to the o1 family, not accidentally match "o1-mini" or vice versa.
    const mini = registry.resolve(openaiProvider, 'o1-mini-2024-09-12');
    expect(mini.price.inputPerMTok).toBe(3); // o1-mini rate, not o1's 15

    const full = registry.resolve(openaiProvider, 'o1-2099-01-01');
    expect(full.price.inputPerMTok).toBe(15); // o1 rate
  });

  it('falls back to unknown pricing for a wholly unrecognized model', () => {
    const registry = new PricingRegistry();
    const { source } = registry.resolve(openaiProvider, 'totally-made-up-model');
    expect(source).toBe('unknown');
  });

  it('resolves Anthropic cache-aware pricing for a known model', () => {
    const registry = new PricingRegistry();
    const { price, source } = registry.resolve(anthropicProvider, 'claude-3-5-sonnet-20241022');
    expect(source).toBe('exact');
    expect(price.cacheReadPerMTok).toBe(0.3);
    expect(price.cacheWritePerMTok).toBe(3.75);
  });

  it('flags an instance override with pricingSource "override"', () => {
    const registry = new PricingRegistry({
      overrides: { 'gpt-4o': { inputPerMTok: 999 } },
    });
    const { price, source } = registry.resolve(openaiProvider, 'gpt-4o');
    expect(source).toBe('override');
    expect(price.inputPerMTok).toBe(999);
    expect(price.outputPerMTok).toBe(10); // untouched fields still merged in from the base price
  });

  describe('newly added OpenAI models', () => {
    it.each([
      ['gpt-4.1', 2, 8],
      ['gpt-4-turbo', 10, 30],
      ['gpt-4', 30, 60],
      ['gpt-3.5-turbo', 0.5, 1.5],
      ['o3', 2, 8],
      ['o3-mini', 1.1, 4.4],
      ['o4-mini', 1.1, 4.4],
    ])('%s resolves exactly with the documented rates', (model, input, output) => {
      const registry = new PricingRegistry();
      const { price, source } = registry.resolve(openaiProvider, model);
      expect(source).toBe('exact');
      expect(price.inputPerMTok).toBe(input);
      expect(price.outputPerMTok).toBe(output);
    });

    it('models predating automatic prompt caching have no cache-read rate', () => {
      const registry = new PricingRegistry();
      const { price } = registry.resolve(openaiProvider, 'gpt-4-turbo');
      expect(price.cacheReadPerMTok).toBeNull();
    });

    it('a dated gpt-4.1 snapshot resolves via the family match, not gpt-4 or gpt-4-turbo', () => {
      const registry = new PricingRegistry();
      const { price, source } = registry.resolve(openaiProvider, 'gpt-4.1-2025-09-01');
      expect(source).toBe('family');
      expect(price.inputPerMTok).toBe(2);
    });
  });

  describe('newly added Anthropic models', () => {
    it.each([
      ['claude-opus-4-1', 15, 75],
      ['claude-3-7-sonnet-20250219', 3, 15],
      ['claude-3-sonnet-20240229', 3, 15],
      ['claude-3-haiku-20240307', 0.25, 1.25],
    ])('%s resolves exactly with the documented rates', (model, input, output) => {
      const registry = new PricingRegistry();
      const { price, source } = registry.resolve(anthropicProvider, model);
      expect(source).toBe('exact');
      expect(price.inputPerMTok).toBe(input);
      expect(price.outputPerMTok).toBe(output);
    });

    it('distinguishes Opus 4.1 from Opus 4.5/4.6/4.7/4.8 via the confirmed dated snapshot', () => {
      const registry = new PricingRegistry();
      expect(registry.resolve(anthropicProvider, 'claude-opus-4-1-20250805').price.inputPerMTok).toBe(15);
      expect(registry.resolve(anthropicProvider, 'claude-opus-4-5-20251101').price.inputPerMTok).toBe(5);
    });

    it('resolves an unlisted dated Sonnet 4.6 snapshot via the family match', () => {
      const registry = new PricingRegistry();
      const { price, source } = registry.resolve(anthropicProvider, 'claude-sonnet-4-6-2099-01-01');
      expect(source).toBe('family');
      expect(price.inputPerMTok).toBe(3);
    });
  });

  describe('latest-generation models (GPT-5 family, Claude Opus 5 / Sonnet 5 / Fable 5)', () => {
    it.each([
      ['gpt-5', 1.25, 10],
      ['gpt-5-mini', 0.25, 2],
      ['gpt-5-nano', 0.05, 0.4],
      ['gpt-5-pro', 15, 120],
      ['gpt-5.1', 1.25, 10],
      ['gpt-5.2', 1.75, 14],
      ['gpt-5.2-pro', 21, 168],
      ['gpt-5.4', 2.5, 15],
      ['gpt-5.4-mini', 0.75, 4.5],
      ['gpt-5.4-nano', 0.2, 1.25],
      ['gpt-5.4-pro', 30, 180],
      ['gpt-5.5', 5, 30],
      ['gpt-5.5-pro', 30, 180],
      ['gpt-5.6-sol', 5, 30],
      ['gpt-5.6-terra', 2, 12],
      ['gpt-5.6-luna', 0.2, 1.2],
      ['gpt-4.1-mini', 0.4, 1.6],
      ['gpt-4.1-nano', 0.1, 0.4],
      ['o1-pro', 150, 600],
      ['o3-pro', 20, 80],
    ])('%s resolves exactly with the documented rates', (model, input, output) => {
      const registry = new PricingRegistry();
      const { price, source } = registry.resolve(openaiProvider, model);
      expect(source).toBe('exact');
      expect(price.inputPerMTok).toBe(input);
      expect(price.outputPerMTok).toBe(output);
    });

    it('a bare "gpt-5" family match never swallows the more specific 5.x/mini/nano/pro variants', () => {
      const registry = new PricingRegistry();
      // Every one of these contains "gpt-5" as a prefix; the more specific exact key must win.
      expect(registry.resolve(openaiProvider, 'gpt-5.6-sol').price.outputPerMTok).toBe(30);
      expect(registry.resolve(openaiProvider, 'gpt-5.4-mini').price.outputPerMTok).toBe(4.5);
      expect(registry.resolve(openaiProvider, 'gpt-5-pro').price.outputPerMTok).toBe(120);
    });

    it('resolves an unlisted dated gpt-5.6-sol snapshot via family match, not bare gpt-5', () => {
      const registry = new PricingRegistry();
      const { price, source } = registry.resolve(openaiProvider, 'gpt-5.6-sol-2026-09-01');
      expect(source).toBe('family');
      expect(price.outputPerMTok).toBe(30); // gpt-5.6-sol's rate, not bare gpt-5's 10
    });

    it.each([
      ['claude-opus-5', 5, 25],
      ['claude-sonnet-5', 3, 15],
      ['claude-fable-5', 10, 50],
      ['claude-opus-4-8', 5, 25],
      ['claude-opus-4-7', 5, 25],
      ['claude-opus-4-6', 5, 25],
      ['claude-sonnet-4-6', 3, 15],
    ])('%s resolves exactly with the documented rates', (model, input, output) => {
      const registry = new PricingRegistry();
      const { price, source } = registry.resolve(anthropicProvider, model);
      expect(source).toBe('exact');
      expect(price.inputPerMTok).toBe(input);
      expect(price.outputPerMTok).toBe(output);
    });

    it('resolves the confirmed dated Haiku 4.5 snapshot via alias', () => {
      const registry = new PricingRegistry();
      const { price, source } = registry.resolve(anthropicProvider, 'claude-haiku-4-5-20251001');
      expect(source).toBe('exact');
      expect(price.inputPerMTok).toBe(1);
    });

    it('resolves claude-mythos-5 as an alias sharing Fable 5 pricing', () => {
      const registry = new PricingRegistry();
      const { price, source } = registry.resolve(anthropicProvider, 'claude-mythos-5');
      expect(source).toBe('exact');
      expect(price.inputPerMTok).toBe(10);
      expect(price.outputPerMTok).toBe(50);
    });

    it('an unlisted dated mythos snapshot resolves via the family match to Fable 5 pricing', () => {
      const registry = new PricingRegistry();
      const { price, source } = registry.resolve(anthropicProvider, 'claude-mythos-preview-2099-01-01');
      expect(source).toBe('family');
      expect(price.inputPerMTok).toBe(10);
    });

    it('Opus 4.8/4.7/4.6 never fall through to Opus 4.5 or 4.1', () => {
      const registry = new PricingRegistry();
      expect(registry.resolve(anthropicProvider, 'claude-opus-4-8-20260101').price.inputPerMTok).toBe(5);
      expect(registry.resolve(anthropicProvider, 'claude-opus-4-7-20260101').price.inputPerMTok).toBe(5);
      expect(registry.resolve(anthropicProvider, 'claude-opus-4-6-20260101').price.inputPerMTok).toBe(5);
      // Sanity: the older 4.5 / 4.1 rates are untouched by adding 4.6/4.7/4.8.
      expect(registry.resolve(anthropicProvider, 'claude-opus-4-5-20251101').price.inputPerMTok).toBe(5);
      expect(registry.resolve(anthropicProvider, 'claude-opus-4-1-20250805').price.inputPerMTok).toBe(15);
    });

    it('resolves the real dated Sonnet 4.5 and Opus 4.5/4.1 snapshot aliases', () => {
      const registry = new PricingRegistry();
      expect(registry.resolve(anthropicProvider, 'claude-sonnet-4-5-20250929').source).toBe('exact');
      expect(registry.resolve(anthropicProvider, 'claude-opus-4-5-20251101').source).toBe('exact');
      expect(registry.resolve(anthropicProvider, 'claude-opus-4-1-20250805').source).toBe('exact');
    });
  });
});
