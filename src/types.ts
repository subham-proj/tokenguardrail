// ============================================================================
// Provider identity
// ============================================================================

/** A provider id. The open string union lets callers register custom providers. */
export type Provider = 'openai' | 'anthropic' | (string & {});

/**
 * Where a resolved price came from.
 * 'override' means a per-instance `pricingOverrides` entry won (see config.ts).
 */
export type PricingSource = 'exact' | 'family' | 'unknown' | 'override';

// ============================================================================
// Message / tool shapes (provider-agnostic, used for token counting)
// ============================================================================

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface TokenguardMessage {
  role: MessageRole;
  content: string;
  name?: string;
}

export interface ToolDefinition {
  name: string;
  description?: string;
  /** JSON schema for the tool's parameters, if any. */
  parameters?: unknown;
}

/** What a provider needs to count input tokens for one call. */
export interface CountInput {
  model: string;
  messages: TokenguardMessage[];
  system?: string;
  tools?: ToolDefinition[];
}

// ============================================================================
// Usage / pricing (see docs/implementation-plan.md §4.1, §4.3)
// ============================================================================

/**
 * Cross-provider usage shape.
 *
 * INVARIANT: `inputTokens` is the TOTAL input, INCLUDING `cachedInputTokens` and
 * `cacheWriteTokens` as subsets of it. `outputTokens` includes reasoning tokens.
 * Every `normalizeUsage` implementation must uphold this so the cost formula in
 * `cost/calculate.ts` never double-counts or double-subtracts cached tokens.
 */
export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
}

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Discounted rate for cache reads. Falls back to inputPerMTok when absent. */
  cacheReadPerMTok?: number | null;
  /** Surcharge rate for cache writes (Anthropic). Falls back to inputPerMTok when absent. */
  cacheWritePerMTok?: number | null;
  updatedAt: string;
  /** Free-text context (e.g. deprecation notices, caching caveats) surfaced in pricing.json. */
  notes?: string;
}

export interface CostEstimate {
  model: string;
  inputTokens: number;
  assumedOutputTokens: number;
  /** Always an estimate (output length is assumed) — see pricingSource for price confidence. */
  estimatedCostUsd: number;
  pricingSource: PricingSource;
  pricingUpdatedAt: string;
}

export interface ActualCost {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Surfaced so cache savings are visible. */
  cachedInputTokens: number;
  actualCostUsd: number;
  pricingSource: PricingSource;
  /**
   * True when this cost was derived from streamed deltas / a heuristic count rather than
   * a provider-reported `usage` object (see wrapper/tokenguard.ts §6). Absent for non-streamed calls.
   */
  approximate?: boolean;
}

/** Payload passed to onCost / cost sinks — a single structured object per call. */
export interface CostEvent {
  provider: Provider;
  model: string;
  estimate?: CostEstimate;
  actual?: ActualCost;
  /** Set when the call was attributed to a TokenguardSession (see session/session.ts). */
  sessionId?: string;
}

// ============================================================================
// Sinks (multi-listener fan-out — the seam toward the deferred ingestion server, plan §9)
// ============================================================================

/**
 * A destination for CostEvents. `onCost` is one sink; `config.sinks` may register more.
 * Every sink is invoked inside its own try/catch so a throwing sink can never break another
 * sink or the underlying LLM call (see wrapper/tokenguard.ts).
 */
export type CostSink = (event: CostEvent) => void | Promise<void>;

// ============================================================================
// Budgets (pre-call guardrail built on the estimate — plan §9)
// ============================================================================

/** What to do when a call's estimate would exceed a configured budget limit. */
export type BudgetExceededAction = 'throw' | 'warn' | 'silent';

export interface BudgetConfig {
  /** Max estimated cost (USD) allowed for any single call. */
  maxCostPerCallUsd?: number;
  /** Max cumulative *actual* cost (USD) across all calls tracked on this instance/session. */
  maxTotalCostUsd?: number;
  /** Fraction (0–1) of a limit at which a warning fires (e.g. 0.8 = warn at 80%). */
  warnAtFraction?: number;
  /**
   * Action when a limit would be exceeded. Default 'throw'. This is the ONE place the wrapper
   * is allowed to break the call — a guardrail's whole point is to block (see README).
   */
  onExceeded?: BudgetExceededAction;
  /** Invoked when projected spend crosses `warnAtFraction` of a limit (but stays under it). */
  onWarning?: (status: BudgetStatus) => void;
}

/** A snapshot of cumulative budget state for an instance or session. */
export interface BudgetStatus {
  /** Cumulative actual USD recorded from completed calls. */
  spentUsd: number;
  /** Number of completed calls folded into `spentUsd`. */
  calls: number;
  /** Configured cumulative cap, if any. */
  maxTotalCostUsd?: number;
  /** `spentUsd / maxTotalCostUsd`, if a cumulative cap is set. */
  fractionUsed?: number;
  /** `maxTotalCostUsd − spentUsd`, if a cumulative cap is set. */
  remainingUsd?: number;
}

/** The outcome of a pre-call budget check (pure — see budget/budget.ts). */
export interface BudgetDecision {
  action: 'allow' | 'warn' | 'exceed';
  /** Which limit drove a 'warn'/'exceed' outcome. */
  reason?: 'per-call' | 'cumulative';
  /** The limit (USD) that was compared against. */
  limitUsd?: number;
  /** The value that breached/approached the limit (call estimate, or spent + estimate). */
  projectedUsd?: number;
  status: BudgetStatus;
}

// ============================================================================
// Session aggregation (roll cost up across an agent chain — plan §9)
// ============================================================================

export interface ModelTotals {
  calls: number;
  estimatedCostUsd: number;
  actualCostUsd: number;
}

export interface SessionTotals extends ModelTotals {
  /** Per-model breakdown, keyed by model id. */
  byModel: Record<string, ModelTotals>;
}

// ============================================================================
// Config
// ============================================================================

export type Logger = Pick<Console, 'warn' | 'error' | 'info'>;

export type UnknownModelBehavior = 'warn' | 'throw' | 'silent';

/**
 * Configures the built-in remote sink (sinks/remote.ts) that ships CostEvents to a tokenguardrail
 * server. Setting it via `TokenguardConfig.tokenguardrail` auto-installs the sink — the API key
 * you get after signing up goes straight "into the wrapper" and events flow to the server.
 */
export interface RemoteSinkConfig {
  /** Account API key (e.g. `tgr_live_...`). Sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string;
  /** Server origin, e.g. `https://api.tokenguardrail.com` or `http://localhost:3000`. */
  baseUrl: string;
  /** Ingest path appended to `baseUrl`. Default `/v1/ingest`. */
  ingestPath?: string;
  /**
   * Fetch the account's server-configured budget and enforce it before each call — the wrapper
   * blocks a call once projected cumulative spend would exceed the cap. Default `true`; set
   * `false` to send cost events without enforcing a budget.
   */
  enforceBudget?: boolean;
  /** Budget path appended to `baseUrl`. Default `/v1/budget`. */
  budgetPath?: string;
  /** Extra headers merged onto the request. */
  headers?: Record<string, string>;
  /** Injectable fetch implementation (defaults to global `fetch`). Mainly for tests. */
  fetch?: unknown;
}

export interface TokenguardConfig {
  /** Merged onto the bundled pricing.json, keyed by exact model id. */
  pricingOverrides?: Record<string, Partial<ModelPrice>>;
  /** Used for the pre-call estimate when maxOutputTokens is omitted. */
  defaultMaxOutputTokens?: number;
  /** Behavior when a model has no pricing entry at all. Default 'warn' (log-once). */
  unknownModel?: UnknownModelBehavior;
  logger?: Logger;
  /** Extra CostEvent sinks, fanned out alongside a wrapper's `onCost` (see sinks/sink.ts). */
  sinks?: CostSink[];
  /**
   * Connect to a tokenguardrail server. When `apiKey` is set, the wrapper (a) auto-installs a
   * remote sink that ships every cost event to `POST {baseUrl}/v1/ingest`, and (b) fetches your
   * account's spend budget and enforces it before each call (see config.ts / sinks/remote.ts /
   * budget/remote-budget.ts). This is the only way to configure a budget — budgets live on the
   * server, not in code.
   */
  tokenguardrail?: RemoteSinkConfig;
}

// ============================================================================
// Public function inputs
// ============================================================================

export interface EstimateCostInput {
  provider: Provider;
  model: string;
  messages: TokenguardMessage[];
  system?: string;
  tools?: ToolDefinition[];
  /** Overrides defaultMaxOutputTokens for this one call. */
  maxOutputTokens?: number;
}

export interface CostFromUsageInput {
  provider: Provider;
  model: string;
  /** The raw `usage` object returned by the provider; normalized internally. */
  usage: unknown;
}
