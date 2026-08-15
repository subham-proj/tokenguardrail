import { describe, expect, it } from 'vitest';
import { createTokenguard, createSession } from '../src/instance.js';
import type { CostEvent } from '../src/types.js';

describe('TokenguardSession — aggregation', () => {
  it('rolls estimate + actual up across calls, counting one call per actual', async () => {
    const tg = createTokenguard();
    const session = tg.session();

    await session.estimateCost({ provider: 'openai', model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
    session.costFromUsage({ provider: 'openai', model: 'gpt-4o', usage: { prompt_tokens: 100, completion_tokens: 50 } });
    session.costFromUsage({
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      usage: { input_tokens: 200, output_tokens: 80 },
    });

    const total = session.total();
    expect(total.calls).toBe(2); // two actuals; the estimate alone does not count as a call
    expect(total.actualCostUsd).toBeGreaterThan(0);
    expect(total.estimatedCostUsd).toBeGreaterThan(0);
    expect(Object.keys(total.byModel).sort()).toEqual(['claude-3-5-sonnet-20241022', 'gpt-4o']);
    expect(total.byModel['gpt-4o'].calls).toBe(1);
    expect(total.byModel['claude-3-5-sonnet-20241022'].calls).toBe(1);
  });

  it('folds a full CostEvent via track()', () => {
    const session = createSession();
    const event: CostEvent = {
      provider: 'openai',
      model: 'gpt-4o',
      estimate: {
        model: 'gpt-4o',
        inputTokens: 10,
        assumedOutputTokens: 50,
        estimatedCostUsd: 0.01,
        pricingSource: 'exact',
        pricingUpdatedAt: '2026-08-03',
      },
      actual: {
        model: 'gpt-4o',
        inputTokens: 10,
        outputTokens: 20,
        cachedInputTokens: 0,
        actualCostUsd: 0.005,
        pricingSource: 'exact',
      },
    };
    session.track(event);

    const total = session.total();
    expect(total.calls).toBe(1);
    expect(total.estimatedCostUsd).toBeCloseTo(0.01);
    expect(total.actualCostUsd).toBeCloseTo(0.005);
  });

  it('total() returns a snapshot that does not mutate as the session continues', () => {
    const session = createSession();
    session.costFromUsage({ provider: 'openai', model: 'gpt-4o', usage: { prompt_tokens: 10, completion_tokens: 5 } });
    const snap = session.total();
    session.costFromUsage({ provider: 'openai', model: 'gpt-4o', usage: { prompt_tokens: 10, completion_tokens: 5 } });
    expect(snap.calls).toBe(1); // the earlier snapshot is frozen at the time it was taken
    expect(session.total().calls).toBe(2);
  });
});

describe('TokenguardSession — session-scoped budget', () => {
  it('tracks its own cumulative spend when created with a budget', () => {
    const session = createSession({ maxTotalCostUsd: 1 });
    session.costFromUsage({
      provider: 'openai',
      model: 'gpt-4o',
      usage: { prompt_tokens: 1_000_000, completion_tokens: 0 }, // 1M input @ $2.50/M = $2.50
    });
    const status = session.budgetStatus();
    expect(status?.spentUsd).toBeCloseTo(2.5);
    expect(status?.remainingUsd).toBeCloseTo(-1.5);
  });

  it('has no budgetStatus without a session budget', () => {
    expect(createSession().budgetStatus()).toBeUndefined();
  });
});
