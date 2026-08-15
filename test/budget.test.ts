import { describe, expect, it, vi } from 'vitest';
import { BudgetTracker, BudgetExceededError } from '../src/budget/budget.js';

describe('BudgetTracker.check — per-call limit', () => {
  it('allows a call under the per-call limit', () => {
    const tracker = new BudgetTracker({ maxCostPerCallUsd: 1 });
    expect(tracker.check(0.5).action).toBe('allow');
  });

  it('exceeds strictly above the per-call limit (equal is allowed)', () => {
    const tracker = new BudgetTracker({ maxCostPerCallUsd: 1 });
    expect(tracker.check(1).action).toBe('allow'); // exactly at the limit is fine
    const decision = tracker.check(1.0001);
    expect(decision.action).toBe('exceed');
    expect(decision.reason).toBe('per-call');
    expect(decision.limitUsd).toBe(1);
    expect(decision.projectedUsd).toBeCloseTo(1.0001);
  });
});

describe('BudgetTracker.check — cumulative limit', () => {
  it('exceeds when spent + estimate would cross the cumulative cap', () => {
    const tracker = new BudgetTracker({ maxTotalCostUsd: 10 });
    tracker.record(9.5);
    const decision = tracker.check(1);
    expect(decision.action).toBe('exceed');
    expect(decision.reason).toBe('cumulative');
    expect(decision.projectedUsd).toBeCloseTo(10.5);
    expect(decision.status.spentUsd).toBeCloseTo(9.5);
  });

  it('allows while cumulative headroom remains', () => {
    const tracker = new BudgetTracker({ maxTotalCostUsd: 10 });
    tracker.record(5);
    expect(tracker.check(4).action).toBe('allow');
  });
});

describe('BudgetTracker.check — warnings', () => {
  it('warns when projected spend crosses warnAtFraction but stays under the limit', () => {
    const tracker = new BudgetTracker({ maxTotalCostUsd: 10, warnAtFraction: 0.8 });
    tracker.record(7);
    const decision = tracker.check(1); // projected 8 = 80%
    expect(decision.action).toBe('warn');
    expect(decision.reason).toBe('cumulative');
  });

  it('prefers "exceed" over "warn" when both a limit and a threshold are crossed', () => {
    const tracker = new BudgetTracker({ maxCostPerCallUsd: 1, warnAtFraction: 0.8 });
    expect(tracker.check(2).action).toBe('exceed');
  });
});

describe('BudgetTracker.record / status', () => {
  it('accumulates spend and reports fraction + remaining against a cap', () => {
    const tracker = new BudgetTracker({ maxTotalCostUsd: 4 });
    tracker.record(1);
    const status = tracker.record(2);
    expect(status.spentUsd).toBe(3);
    expect(status.calls).toBe(2);
    expect(status.fractionUsed).toBeCloseTo(0.75);
    expect(status.remainingUsd).toBeCloseTo(1);
  });

  it('omits cap-relative fields when no cumulative cap is set', () => {
    const tracker = new BudgetTracker({});
    const status = tracker.record(2);
    expect(status.spentUsd).toBe(2);
    expect(status.maxTotalCostUsd).toBeUndefined();
    expect(status.fractionUsed).toBeUndefined();
  });
});

describe('BudgetExceededError', () => {
  it('carries the machine-readable reason, limit, projected spend, and model', () => {
    const tracker = new BudgetTracker({ maxCostPerCallUsd: 0.5 });
    const decision = tracker.check(2, 'gpt-4o');
    const err = new BudgetExceededError(decision, 'gpt-4o');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('BudgetExceededError');
    expect(err.reason).toBe('per-call');
    expect(err.limitUsd).toBe(0.5);
    expect(err.projectedUsd).toBe(2);
    expect(err.model).toBe('gpt-4o');
  });
});

describe('BudgetConfig.onWarning / onExceeded are policy, not applied by check()', () => {
  it('check() is pure — it never invokes callbacks or mutates state', () => {
    const onWarning = vi.fn();
    const tracker = new BudgetTracker({ maxTotalCostUsd: 10, warnAtFraction: 0.5, onWarning });
    tracker.check(9); // would warn
    tracker.check(9); // would warn again
    expect(onWarning).not.toHaveBeenCalled();
    expect(tracker.status().spentUsd).toBe(0); // check() never records
  });
});
