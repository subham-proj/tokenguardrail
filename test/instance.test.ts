import { describe, expect, it, vi } from 'vitest';
import { createTokenguard, estimateCost, costFromUsage } from '../src/instance.js';

describe('estimateCost', () => {
  it('is async and returns a real token count using the exact OpenAI tokenizer', async () => {
    const est = await estimateCost({
      provider: 'openai',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello, world!' }],
      maxOutputTokens: 100,
    });

    expect(est.model).toBe('gpt-4o');
    expect(est.inputTokens).toBeGreaterThan(0);
    expect(est.assumedOutputTokens).toBe(100);
    expect(est.estimatedCostUsd).toBeGreaterThan(0);
    expect(est.pricingSource).toBe('exact');
  });

  it('counts tool/function schemas into the OpenAI estimate (not just message text)', async () => {
    const withoutTools = await estimateCost({
      provider: 'openai',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'What is the weather?' }],
    });

    const withTools = await estimateCost({
      provider: 'openai',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'What is the weather?' }],
      tools: [
        {
          name: 'get_weather',
          description: 'Get the current weather for a location',
          parameters: { type: 'object', properties: { location: { type: 'string' } } },
        },
      ],
    });

    expect(withTools.inputTokens).toBeGreaterThan(withoutTools.inputTokens);
  });

  it('falls back to the configured default when maxOutputTokens is omitted', async () => {
    const tg = createTokenguard({ defaultMaxOutputTokens: 42 });
    const est = await tg.estimateCost({
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'Hi' }],
    });
    expect(est.assumedOutputTokens).toBe(42);
  });

  it('applies per-instance pricingOverrides and flags pricingSource "override"', async () => {
    const tg = createTokenguard({ pricingOverrides: { 'gpt-4o': { inputPerMTok: 100 } } });
    const est = await tg.estimateCost({
      provider: 'openai',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 0,
    });
    expect(est.pricingSource).toBe('override');
  });
});

describe('costFromUsage', () => {
  it('is synchronous and computes actual cost from a provider usage object', () => {
    const cost = costFromUsage({
      provider: 'openai',
      model: 'gpt-4o',
      usage: { prompt_tokens: 1000, completion_tokens: 500 },
    });

    expect(cost.inputTokens).toBe(1000);
    expect(cost.outputTokens).toBe(500);
    expect(cost.actualCostUsd).toBeCloseTo(1000 * (2.5 / 1e6) + 500 * (10 / 1e6), 9);
  });

  it('logs a warning exactly once per unknown model (unknownModel: "warn" default)', () => {
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    const tg = createTokenguard({ logger });

    tg.costFromUsage({ provider: 'openai', model: 'no-such-model', usage: { prompt_tokens: 1, completion_tokens: 1 } });
    tg.costFromUsage({ provider: 'openai', model: 'no-such-model', usage: { prompt_tokens: 1, completion_tokens: 1 } });

    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('throws for an unregistered provider id', () => {
    expect(() =>
      costFromUsage({ provider: 'made-up-provider', model: 'x', usage: {} })
    ).toThrow(/unknown provider/i);
  });
});
