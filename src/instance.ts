import type {
  ActualCost,
  BudgetConfig,
  BudgetStatus,
  CostEstimate,
  CostFromUsageInput,
  EstimateCostInput,
  TokenguardConfig,
} from './types.js';
import { resolveConfig, getDefaultConfig, type ResolvedConfig } from './config.js';
import { calculateCost } from './cost/calculate.js';
import { BudgetTracker } from './budget/budget.js';
import { TokenguardSession } from './session/session.js';

export interface TokenguardInstance {
  estimateCost(input: EstimateCostInput): Promise<CostEstimate>;
  costFromUsage(input: CostFromUsageInput): ActualCost;
  /** Cumulative budget state (spend recorded by the wrapper / sessions on this instance). */
  budgetStatus(): BudgetStatus;
  /** Start a session that rolls cost up across a chain of calls. Optionally scoped to its own budget. */
  session(budget?: BudgetConfig): TokenguardSession;
}

/** Exposed so wrapper/tokenguard.ts can share one ResolvedConfig (pricing, logger, providers). */
export function createInstanceFromConfig(resolved: ResolvedConfig): TokenguardInstance {
  const instance: TokenguardInstance = {
    async estimateCost(input) {
      const provider = resolved.providers.require(input.provider);
      const assumedOutputTokens = input.maxOutputTokens ?? resolved.defaultMaxOutputTokens;

      const inputTokens = await provider.countInputTokens({
        model: input.model,
        messages: input.messages,
        system: input.system,
        tools: input.tools,
      });

      const { price, source } = resolved.pricing.resolve(provider, input.model);
      if (source === 'unknown') resolved.warnUnknownModel(input.model);

      const estimatedCostUsd = calculateCost(
        { inputTokens, outputTokens: assumedOutputTokens, cachedInputTokens: 0, cacheWriteTokens: 0 },
        price
      );

      return {
        model: input.model,
        inputTokens,
        assumedOutputTokens,
        estimatedCostUsd,
        pricingSource: source,
        pricingUpdatedAt: price.updatedAt,
      };
    },

    costFromUsage(input) {
      const provider = resolved.providers.require(input.provider);
      const usage = provider.normalizeUsage(input.usage);
      const { price, source } = resolved.pricing.resolve(provider, input.model);
      if (source === 'unknown') resolved.warnUnknownModel(input.model);

      return {
        model: input.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        actualCostUsd: calculateCost(usage, price),
        pricingSource: source,
      };
    },

    budgetStatus() {
      return resolved.budgetTracker.status();
    },

    session(budget) {
      // A session-scoped budget gets its own tracker; without one it shares nothing and just aggregates.
      const tracker = budget ? new BudgetTracker(budget) : undefined;
      return new TokenguardSession(instance, tracker);
    },
  };

  return instance;
}

export function createTokenguard(config: TokenguardConfig = {}): TokenguardInstance {
  return createInstanceFromConfig(resolveConfig(config));
}

let defaultTokenguard: TokenguardInstance | undefined;

function getDefaultInstance(): TokenguardInstance {
  if (!defaultTokenguard) {
    defaultTokenguard = createInstanceFromConfig(getDefaultConfig());
  }
  return defaultTokenguard;
}

/** Sugar over a lazily-created default instance — the simple case stays one import. */
export function estimateCost(input: EstimateCostInput): Promise<CostEstimate> {
  return getDefaultInstance().estimateCost(input);
}

/** Sync — reads an already-returned `usage`, no tokenizer involved. */
export function costFromUsage(input: CostFromUsageInput): ActualCost {
  return getDefaultInstance().costFromUsage(input);
}

/** Start a session off the default instance, optionally scoped to its own budget. */
export function createSession(budget?: BudgetConfig): TokenguardSession {
  return getDefaultInstance().session(budget);
}
