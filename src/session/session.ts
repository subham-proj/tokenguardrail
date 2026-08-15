import type {
  ActualCost,
  CostEstimate,
  CostEvent,
  CostFromUsageInput,
  EstimateCostInput,
  ModelTotals,
  SessionTotals,
  BudgetStatus,
} from '../types.js';
import type { TokenguardInstance } from '../instance.js';
import type { BudgetTracker } from '../budget/budget.js';

function genSessionId(): string {
  return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function emptyTotals(): ModelTotals {
  return { calls: 0, estimatedCostUsd: 0, actualCostUsd: 0 };
}

/**
 * Aggregates cost across a chain of calls (e.g. an agent run). Delegates the actual math to a
 * shared TokenguardInstance and just rolls the results up. Feed it either via its own
 * `estimateCost` / `costFromUsage` convenience methods or via `track(event)` from a wrapper's
 * `onCost` (the wrapper attributes automatically when a session is passed).
 *
 * "calls" counts *completed* calls (those with an actual cost); an estimate on its own adds to
 * `estimatedCostUsd` without incrementing `calls`.
 */
export class TokenguardSession {
  readonly id: string;
  /** Present only when the session was created with a budget; exposed for the wrapper to enforce. */
  readonly budgetTracker?: BudgetTracker;

  private readonly totals: SessionTotals = { ...emptyTotals(), byModel: {} };

  constructor(private readonly instance: TokenguardInstance, budgetTracker?: BudgetTracker, id?: string) {
    this.id = id ?? genSessionId();
    this.budgetTracker = budgetTracker;
  }

  async estimateCost(input: EstimateCostInput): Promise<CostEstimate> {
    const estimate = await this.instance.estimateCost(input);
    this.accumulate(estimate.model, { estimatedCostUsd: estimate.estimatedCostUsd });
    return estimate;
  }

  costFromUsage(input: CostFromUsageInput): ActualCost {
    const actual = this.instance.costFromUsage(input);
    this.accumulate(actual.model, { actualCostUsd: actual.actualCostUsd, isCall: true });
    if (this.budgetTracker) this.budgetTracker.record(actual.actualCostUsd);
    return actual;
  }

  /** Fold a full CostEvent (e.g. from a wrapper `onCost`) into the session totals. */
  track(event: CostEvent): void {
    this.accumulate(event.model, {
      estimatedCostUsd: event.estimate?.estimatedCostUsd,
      actualCostUsd: event.actual?.actualCostUsd,
      isCall: !!event.actual,
    });
  }

  /** A stable snapshot of the running totals (safe to keep — it is a deep copy). */
  total(): SessionTotals {
    return {
      calls: this.totals.calls,
      estimatedCostUsd: this.totals.estimatedCostUsd,
      actualCostUsd: this.totals.actualCostUsd,
      byModel: Object.fromEntries(Object.entries(this.totals.byModel).map(([m, t]) => [m, { ...t }])),
    };
  }

  /** Cumulative budget state for the session, if it was created with a budget. */
  budgetStatus(): BudgetStatus | undefined {
    return this.budgetTracker?.status();
  }

  private accumulate(
    model: string,
    delta: { estimatedCostUsd?: number; actualCostUsd?: number; isCall?: boolean }
  ): void {
    const bucket = (this.totals.byModel[model] ??= emptyTotals());
    if (delta.isCall) {
      this.totals.calls += 1;
      bucket.calls += 1;
    }
    if (delta.estimatedCostUsd != null) {
      this.totals.estimatedCostUsd += delta.estimatedCostUsd;
      bucket.estimatedCostUsd += delta.estimatedCostUsd;
    }
    if (delta.actualCostUsd != null) {
      this.totals.actualCostUsd += delta.actualCostUsd;
      bucket.actualCostUsd += delta.actualCostUsd;
    }
  }
}
