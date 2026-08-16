import type { BudgetConfig, CostSink, Logger, TokenguardConfig, UnknownModelBehavior } from './types.js';
import { createRemoteSink } from './sinks/remote.js';
import { PricingRegistry } from './pricing/registry.js';
import { ProviderRegistry } from './providers/provider.js';
import { openaiProvider } from './providers/openai.js';
import { anthropicProvider } from './providers/anthropic.js';
import { googleProvider } from './providers/google.js';
import { mistralProvider } from './providers/mistral.js';
import { groqProvider } from './providers/groq.js';
import { BudgetTracker } from './budget/budget.js';

const DEFAULT_MAX_OUTPUT_TOKENS = 512;

export interface ResolvedConfig {
  pricing: PricingRegistry;
  providers: ProviderRegistry;
  defaultMaxOutputTokens: number;
  unknownModel: UnknownModelBehavior;
  logger: Logger;
  /** Guardrail config (undefined = no limits) and its per-instance cumulative-spend tracker. */
  budget: BudgetConfig | undefined;
  budgetTracker: BudgetTracker;
  /** Extra CostEvent sinks, fanned out by the wrapper alongside `onCost`. */
  sinks: CostSink[];
  /** Logs (or throws, per unknownModel) the first time a given model has no pricing entry. */
  warnUnknownModel(model: string): void;
}

/**
 * Resolves a TokenguardConfig in the defined order (last wins): bundled defaults →
 * instance overrides passed here. Per-call overrides are applied by the caller (instance.ts).
 */
export function resolveConfig(config: TokenguardConfig = {}): ResolvedConfig {
  const providers = new ProviderRegistry();
  providers.register(openaiProvider);
  providers.register(anthropicProvider);
  providers.register(googleProvider);
  providers.register(mistralProvider);
  providers.register(groqProvider);

  const pricing = new PricingRegistry({ overrides: config.pricingOverrides });
  const logger = config.logger ?? console;
  const unknownModel = config.unknownModel ?? 'warn';
  const warned = new Set<string>();

  // A `tokenguardrail: { apiKey, baseUrl }` config auto-installs the remote sink alongside any
  // explicit sinks, so the platform integration is one option rather than a hand-written onCost.
  const sinks: CostSink[] = [...(config.sinks ?? [])];
  if (config.tokenguardrail?.apiKey) {
    sinks.push(createRemoteSink(config.tokenguardrail, logger));
  }

  return {
    pricing,
    providers,
    defaultMaxOutputTokens: config.defaultMaxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    unknownModel,
    logger,
    budget: config.budget,
    budgetTracker: new BudgetTracker(config.budget),
    sinks,
    warnUnknownModel(model: string) {
      if (unknownModel === 'silent') return;
      if (unknownModel === 'throw') {
        throw new Error(`tokenguardrail: no pricing found for model "${model}".`);
      }
      if (warned.has(model)) return;
      warned.add(model);
      logger.warn(`tokenguardrail: no pricing found for model "${model}"; cost is a rough fallback estimate.`);
    },
  };
}

let defaultInstance: ResolvedConfig | undefined;

/** Backs the module-level `estimateCost`/`costFromUsage` sugar exports (instance.ts). */
export function getDefaultConfig(): ResolvedConfig {
  if (!defaultInstance) {
    defaultInstance = resolveConfig();
  }
  return defaultInstance;
}
