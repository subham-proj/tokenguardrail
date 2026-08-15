import { describe, expect, it, vi } from 'vitest';
import { emitCostEvent, memorySink, consoleSink } from '../src/sinks/sink.js';
import type { CostEvent } from '../src/types.js';

function sampleEvent(overrides: Partial<CostEvent> = {}): CostEvent {
  return {
    provider: 'openai',
    model: 'gpt-4o',
    estimate: {
      model: 'gpt-4o',
      inputTokens: 10,
      assumedOutputTokens: 100,
      estimatedCostUsd: 0.001,
      pricingSource: 'exact',
      pricingUpdatedAt: '2026-08-03',
    },
    actual: {
      model: 'gpt-4o',
      inputTokens: 10,
      outputTokens: 20,
      cachedInputTokens: 0,
      actualCostUsd: 0.0002,
      pricingSource: 'exact',
    },
    ...overrides,
  };
}

const silentLogger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };

describe('emitCostEvent — fan-out', () => {
  it('delivers the event to every sink and to onCost', async () => {
    const a = vi.fn();
    const b = vi.fn();
    const onCost = vi.fn();
    const event = sampleEvent();

    await emitCostEvent(event, { sinks: [a, b], onCost, logger: silentLogger });

    expect(a).toHaveBeenCalledWith(event);
    expect(b).toHaveBeenCalledWith(event);
    expect(onCost).toHaveBeenCalledWith(event);
  });

  it('one throwing sink never breaks the other sinks or onCost', async () => {
    const bad = vi.fn(() => {
      throw new Error('sink boom');
    });
    const good = vi.fn();
    const onCost = vi.fn();

    await expect(
      emitCostEvent(sampleEvent(), { sinks: [bad, good], onCost, logger: silentLogger })
    ).resolves.toBeUndefined();

    expect(good).toHaveBeenCalledTimes(1);
    expect(onCost).toHaveBeenCalledTimes(1);
  });

  it('awaits async sinks', async () => {
    const order: string[] = [];
    const slow = vi.fn(async () => {
      await Promise.resolve();
      order.push('slow');
    });
    const onCost = vi.fn(() => {
      order.push('onCost');
    });

    await emitCostEvent(sampleEvent(), { sinks: [slow], onCost, logger: silentLogger });
    expect(order).toEqual(['slow', 'onCost']);
  });
});

describe('memorySink', () => {
  it('collects events and totals actual/estimated cost', async () => {
    const sink = memorySink();
    await emitCostEvent(sampleEvent(), { sinks: [sink], logger: silentLogger });
    await emitCostEvent(sampleEvent({ estimate: undefined }), { sinks: [sink], logger: silentLogger });

    expect(sink.events).toHaveLength(2);
    const total = sink.total();
    expect(total.calls).toBe(2); // both have an actual
    expect(total.estimatedCostUsd).toBeCloseTo(0.001); // only the first had an estimate
    expect(total.actualCostUsd).toBeCloseTo(0.0004);

    sink.clear();
    expect(sink.events).toHaveLength(0);
  });
});

describe('consoleSink', () => {
  it('logs a one-line summary via the provided logger', () => {
    const info = vi.fn();
    consoleSink({ info })(sampleEvent());
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toContain('openai/gpt-4o');
  });
});
