import type { BudgetConfig, BudgetDecision, BudgetStatus } from '../types.js';

/**
 * Error thrown when a call's estimate would exceed a budget limit and `onExceeded: 'throw'`
 * (the default). This is intentional: unlike the wrapper's try/catch'd instrumentation, a
 * budget guardrail is *meant* to break the call — that is its entire purpose (see README).
 */
export class BudgetExceededError extends Error {
  readonly reason: 'per-call' | 'cumulative';
  readonly limitUsd: number;
  readonly projectedUsd: number;
  readonly model: string;

  constructor(decision: BudgetDecision, model: string) {
    const limit = decision.limitUsd ?? 0;
    const projected = decision.projectedUsd ?? 0;
    super(
      `tokenguardrail: ${decision.reason} budget exceeded for "${model}" — ` +
        `projected $${projected.toFixed(6)} > limit $${limit.toFixed(6)}.`
    );
    this.name = 'BudgetExceededError';
    this.reason = decision.reason ?? 'per-call';
    this.limitUsd = limit;
    this.projectedUsd = projected;
    this.model = model;
  }
}

/**
 * Error thrown when the account's budget cannot be verified (network error, non-2xx, unparseable
 * body) and `onUnavailable: 'block'` (the default). Distinct from BudgetExceededError: the call is
 * blocked not because a known cap was hit, but because the guardrail couldn't read the cap at all —
 * failing closed. Set `onUnavailable: 'allow'` to proceed instead.
 */
export class BudgetUnavailableError extends Error {
  readonly model: string;

  constructor(model: string) {
    super(
      `tokenguardrail: could not verify the account budget for "${model}"; blocking the call ` +
        `(onUnavailable:'block'). Set onUnavailable:'allow' to proceed when the budget is unreachable.`
    );
    this.name = 'BudgetUnavailableError';
    this.model = model;
  }
}

/**
 * Holds cumulative spend for one instance or session and answers pre-call budget questions.
 * Lives on the resolved instance (not a module global) so instances stay isolated.
 *
 * `check()` is pure (no state change, no callbacks) so the caller decides how to act on an
 * 'exceed' — this keeps the "budget may throw" decision explicit in the wrapper. `record()`
 * is the only mutator; it folds a completed call's actual cost into cumulative spend.
 */
export class BudgetTracker {
  private spentUsd: number;
  private callCount = 0;

  /**
   * @param config      Enforcement policy (public so the wrapper can read onExceeded / onWarning).
   * @param initialSpentUsd Spend already accumulated elsewhere (e.g. fetched from the server) so a
   *   cumulative cap is enforced against real total spend, not just this process. Does not count as
   *   a completed call.
   */
  constructor(readonly config: BudgetConfig = {}, initialSpentUsd = 0) {
    this.spentUsd = initialSpentUsd > 0 ? initialSpentUsd : 0;
  }

  /** Pre-call decision from an estimate. Does not mutate state. */
  check(estimatedCostUsd: number, _model?: string): BudgetDecision {
    const status = this.status();
    const { maxCostPerCallUsd, maxTotalCostUsd, warnAtFraction } = this.config;

    if (maxCostPerCallUsd != null && estimatedCostUsd > maxCostPerCallUsd) {
      return { action: 'exceed', reason: 'per-call', limitUsd: maxCostPerCallUsd, projectedUsd: estimatedCostUsd, status };
    }

    const projectedTotal = this.spentUsd + estimatedCostUsd;
    if (maxTotalCostUsd != null && projectedTotal > maxTotalCostUsd) {
      return { action: 'exceed', reason: 'cumulative', limitUsd: maxTotalCostUsd, projectedUsd: projectedTotal, status };
    }

    if (warnAtFraction != null) {
      if (maxCostPerCallUsd != null && estimatedCostUsd >= warnAtFraction * maxCostPerCallUsd) {
        return { action: 'warn', reason: 'per-call', limitUsd: maxCostPerCallUsd, projectedUsd: estimatedCostUsd, status };
      }
      if (maxTotalCostUsd != null && projectedTotal >= warnAtFraction * maxTotalCostUsd) {
        return { action: 'warn', reason: 'cumulative', limitUsd: maxTotalCostUsd, projectedUsd: projectedTotal, status };
      }
    }

    return { action: 'allow', status };
  }

  /** Fold a completed call's actual cost into cumulative spend. Returns the new status. */
  record(actualCostUsd: number): BudgetStatus {
    this.spentUsd += actualCostUsd;
    this.callCount += 1;
    return this.status();
  }

  status(): BudgetStatus {
    const { maxTotalCostUsd } = this.config;
    const base: BudgetStatus = { spentUsd: this.spentUsd, calls: this.callCount };
    if (maxTotalCostUsd != null) {
      base.maxTotalCostUsd = maxTotalCostUsd;
      base.fractionUsed = maxTotalCostUsd > 0 ? this.spentUsd / maxTotalCostUsd : 0;
      base.remainingUsd = maxTotalCostUsd - this.spentUsd;
    }
    return base;
  }
}
