import type {
  ActualCost,
  CostEstimate,
  CostEvent,
  CostSink,
  EstimateCostInput,
  MessageRole,
  Provider,
  TokenguardConfig,
  TokenguardMessage,
  ToolDefinition,
} from '../types.js';
import { resolveConfig, type ResolvedConfig } from '../config.js';
import { createInstanceFromConfig, type TokenguardInstance } from '../instance.js';
import type { ProviderAdapter } from '../providers/provider.js';
import { heuristicCountTokens } from '../tokens/heuristic.js';
import { emitCostEvent } from '../sinks/sink.js';
import { BudgetExceededError, type BudgetTracker } from '../budget/budget.js';
import type { TokenguardSession } from '../session/session.js';

export interface TokenguardWrapperOptions extends TokenguardConfig {
  onCost?: CostSink;
  /**
   * Override client auto-detection. Required for OpenAI-compatible clients (e.g. Groq) whose shape
   * is indistinguishable from OpenAI's by duck-typing.
   */
  provider?: Provider;
  /** Attribute every wrapped call's cost to this session, in addition to the instance. */
  session?: TokenguardSession;
}

/** Which request path each provider's cost-bearing method lives at. */
const INTERCEPT_PATH: Record<string, string[]> = {
  openai: ['chat', 'completions', 'create'],
  anthropic: ['messages', 'create'],
  groq: ['chat', 'completions', 'create'], // OpenAI-compatible surface
  mistral: ['chat', 'complete'],
};

/** OpenAI-compatible providers share request/response/stream shapes (usage, deltas, stream_options). */
function isOpenAICompatible(providerId: string): boolean {
  return providerId === 'openai' || providerId === 'groq';
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ============================================================================
// Request → EstimateCostInput (provider request shape → our provider-agnostic shape)
// ============================================================================

function toMessageRole(role: unknown): MessageRole {
  const valid: MessageRole[] = ['system', 'user', 'assistant', 'tool'];
  return valid.includes(role as MessageRole) ? (role as MessageRole) : 'user';
}

function extractContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // Only text parts are counted — image/audio blocks are a known undercount (plan §8).
    return content
      .filter((part): part is Record<string, unknown> => typeof part === 'object' && part !== null)
      .map((part) => (typeof part['text'] === 'string' ? (part['text'] as string) : ''))
      .join('\n');
  }
  return '';
}

function extractMessages(raw: unknown): TokenguardMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry): TokenguardMessage => {
    const msg = (entry ?? {}) as Record<string, unknown>;
    return {
      role: toMessageRole(msg['role']),
      content: extractContent(msg['content']),
      name: typeof msg['name'] === 'string' ? (msg['name'] as string) : undefined,
    };
  });
}

function extractTools(raw: unknown): ToolDefinition[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw.map((entry): ToolDefinition => {
    const tool = (entry ?? {}) as Record<string, unknown>;
    const fn = tool['function'] as Record<string, unknown> | undefined; // OpenAI shape
    if (fn) {
      return {
        name: String(fn['name'] ?? ''),
        description: typeof fn['description'] === 'string' ? (fn['description'] as string) : undefined,
        parameters: fn['parameters'],
      };
    }
    return {
      // Anthropic shape: { name, description, input_schema }
      name: String(tool['name'] ?? ''),
      description: typeof tool['description'] === 'string' ? (tool['description'] as string) : undefined,
      parameters: tool['input_schema'],
    };
  });
}

function firstNumber(params: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    if (typeof params[key] === 'number') return params[key] as number;
  }
  return undefined;
}

function toEstimateInput(providerId: string, model: string, params: Record<string, unknown>): EstimateCostInput {
  return {
    provider: providerId,
    model,
    messages: extractMessages(params['messages']),
    system:
      providerId === 'anthropic' && typeof params['system'] === 'string' ? (params['system'] as string) : undefined,
    tools: extractTools(params['tools']),
    // Providers spell the output cap differently: OpenAI `max_tokens`/`max_completion_tokens`,
    // Anthropic `max_tokens`, Mistral `maxTokens`.
    maxOutputTokens: firstNumber(params, ['max_tokens', 'max_completion_tokens', 'maxTokens']),
  };
}

/** Synthesizes a raw usage object shaped like the provider's response, so it can flow
 *  through the same normalizeUsage()/costFromUsage() path as a real response. */
function syntheticUsage(providerId: string, inputTokens: number, outputTokens: number): unknown {
  if (isOpenAICompatible(providerId)) {
    return { prompt_tokens: inputTokens, completion_tokens: outputTokens };
  }
  if (providerId === 'mistral') {
    return { promptTokens: inputTokens, completionTokens: outputTokens };
  }
  return { input_tokens: inputTokens, output_tokens: outputTokens };
}

// ============================================================================
// Streaming delta extraction
// ============================================================================

function extractOpenAIDeltaText(chunk: Record<string, unknown>): string {
  const choices = chunk['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const delta = (choices[0] as Record<string, unknown> | undefined)?.['delta'] as
    | Record<string, unknown>
    | undefined;
  const content = delta?.['content'];
  return typeof content === 'string' ? content : '';
}

function extractAnthropicDeltaText(chunk: Record<string, unknown>): string {
  if (chunk['type'] !== 'content_block_delta') return '';
  const delta = chunk['delta'] as Record<string, unknown> | undefined;
  const text = delta?.['text'];
  return typeof text === 'string' ? text : '';
}

// ============================================================================
// Budget enforcement + cost emission
// ============================================================================

/**
 * The ONE place the wrapper is allowed to break the call. Checks the instance budget (and the
 * session budget, if any) against the pre-call estimate. On 'exceed' with onExceeded:'throw'
 * (the default) a BudgetExceededError propagates to the caller *before* the real API call — that
 * is the guardrail's entire purpose. 'warn'/'silent' let the call proceed. Warning callbacks are
 * try/catch'd (a bad callback must not break the call); the deliberate throw is not.
 */
function enforceBudget(
  estimate: CostEstimate,
  model: string,
  resolved: ResolvedConfig,
  session: TokenguardSession | undefined
): void {
  const trackers: BudgetTracker[] = [resolved.budgetTracker];
  if (session?.budgetTracker) trackers.push(session.budgetTracker);

  for (const tracker of trackers) {
    const decision = tracker.check(estimate.estimatedCostUsd, model);
    if (decision.action === 'allow') continue;

    if (decision.action === 'warn') {
      try {
        tracker.config.onWarning?.(decision.status);
      } catch (err) {
        resolved.logger.warn(`tokenguardrail: budget onWarning callback threw (continuing): ${errMessage(err)}`);
      }
      resolved.logger.warn(
        `tokenguardrail: approaching ${decision.reason} budget for "${model}" — ` +
          `projected $${decision.projectedUsd?.toFixed(6)} of $${decision.limitUsd?.toFixed(6)}.`
      );
      continue;
    }

    // action === 'exceed'
    const onExceeded = tracker.config.onExceeded ?? 'throw';
    if (onExceeded === 'throw') throw new BudgetExceededError(decision, model);
    if (onExceeded === 'warn') {
      resolved.logger.warn(
        `tokenguardrail: ${decision.reason} budget exceeded for "${model}" ` +
          `(projected $${decision.projectedUsd?.toFixed(6)} > $${decision.limitUsd?.toFixed(6)}); ` +
          `allowing per onExceeded:'warn'.`
      );
    }
    // 'silent' → proceed with no output
  }
}

/** Record spend into the trackers, attribute to the session, then fan out to sinks + onCost. */
async function recordAndEmit(
  event: CostEvent,
  resolved: ResolvedConfig,
  options: TokenguardWrapperOptions
): Promise<void> {
  if (event.actual) {
    resolved.budgetTracker.record(event.actual.actualCostUsd);
    options.session?.budgetTracker?.record(event.actual.actualCostUsd);
  }
  if (options.session) {
    try {
      options.session.track(event);
    } catch (err) {
      resolved.logger.warn(`tokenguardrail: session tracking threw (continuing): ${errMessage(err)}`);
    }
  }
  await emitCostEvent(event, { sinks: resolved.sinks, onCost: options.onCost, logger: resolved.logger });
}

// ============================================================================
// Wrapper factory
// ============================================================================

function createWrappedMethod(
  originalCreate: (...args: unknown[]) => unknown,
  provider: ProviderAdapter,
  instance: TokenguardInstance,
  resolved: ResolvedConfig,
  options: TokenguardWrapperOptions
): (...args: unknown[]) => Promise<unknown> {
  return async function wrapped(...args: unknown[]): Promise<unknown> {
    const params = (args[0] ?? {}) as Record<string, unknown>;
    const model = String(params['model'] ?? 'unknown');
    const isStreaming = params['stream'] === true;

    // Pre-call estimate — try/catch-wrapped so a tokenizer failure never blocks the call.
    let estimate: CostEstimate | undefined;
    try {
      estimate = await instance.estimateCost(toEstimateInput(provider.id, model, params));
    } catch (err) {
      resolved.logger.warn(`tokenguardrail: pre-call estimate failed (continuing): ${errMessage(err)}`);
    }

    // Budget guardrail — the deliberate throwing path (see enforceBudget). Skipped, fail-open, if
    // the estimate itself failed above. NOT wrapped in try/catch: a BudgetExceededError must
    // propagate to the caller before the real call is made.
    if (estimate) {
      enforceBudget(estimate, model, resolved, options.session);
    }

    // Ask OpenAI-compatible providers for real usage on the final stream chunk, unless the caller
    // already decided.
    let callArgs = args;
    if (isStreaming && isOpenAICompatible(provider.id) && !('stream_options' in params)) {
      try {
        callArgs = [{ ...params, stream_options: { include_usage: true } }, ...args.slice(1)];
      } catch (err) {
        resolved.logger.warn(`tokenguardrail: failed to request stream usage (continuing): ${errMessage(err)}`);
      }
    }

    // The real call — never caught here. A thrown error must propagate untouched.
    const response = await originalCreate(...callArgs);

    if (isStreaming) {
      return wrapStream(response as AsyncIterable<unknown>, provider, model, instance, estimate, resolved, options);
    }

    try {
      const usage = (response as Record<string, unknown> | null)?.['usage'];
      const actual = usage ? instance.costFromUsage({ provider: provider.id, model, usage }) : undefined;
      // Emit whenever there's anything to report (estimate or actual) so sinks/session/budget see it.
      if (estimate || actual) {
        await recordAndEmit(
          { provider: provider.id, model, estimate, actual, sessionId: options.session?.id },
          resolved,
          options
        );
      }
    } catch (err) {
      resolved.logger.warn(`tokenguardrail: post-call cost accounting failed (continuing): ${errMessage(err)}`);
    }

    return response;
  };
}

function wrapStream(
  stream: AsyncIterable<unknown>,
  provider: ProviderAdapter,
  model: string,
  instance: TokenguardInstance,
  estimate: CostEstimate | undefined,
  resolved: ResolvedConfig,
  options: TokenguardWrapperOptions
): AsyncIterable<unknown> {
  async function* accounted(): AsyncGenerator<unknown> {
    let outputTokens = 0;
    let finalUsage: unknown = null;

    try {
      for await (const chunk of stream) {
        try {
          const c = (chunk ?? {}) as Record<string, unknown>;
          if (isOpenAICompatible(provider.id)) {
            if (c['usage']) finalUsage = c['usage'];
            const delta = extractOpenAIDeltaText(c);
            if (delta) outputTokens += heuristicCountTokens({ model, messages: [{ role: 'assistant', content: delta }] });
          } else if (provider.id === 'anthropic') {
            if (c['type'] === 'message_start') {
              const startUsage = (c['message'] as Record<string, unknown> | undefined)?.['usage'];
              if (startUsage) finalUsage = { ...(finalUsage as object | null), ...(startUsage as object) };
            }
            if (c['type'] === 'message_delta' && c['usage']) {
              finalUsage = { ...(finalUsage as object | null), ...(c['usage'] as object) };
            }
            const delta = extractAnthropicDeltaText(c);
            if (delta) outputTokens += heuristicCountTokens({ model, messages: [{ role: 'assistant', content: delta }] });
          }
        } catch (err) {
          resolved.logger.warn(`tokenguardrail: failed to account a stream chunk (continuing): ${errMessage(err)}`);
        }

        yield chunk; // never buffer/delay a chunk on the way to the caller
      }
    } finally {
      try {
        const usage = finalUsage ?? syntheticUsage(provider.id, estimate?.inputTokens ?? 0, outputTokens);
        const actual: ActualCost = instance.costFromUsage({ provider: provider.id, model, usage });
        if (!finalUsage) actual.approximate = true; // no provider usage arrived — heuristic-derived
        await recordAndEmit(
          { provider: provider.id, model, estimate, actual, sessionId: options.session?.id },
          resolved,
          options
        );
      } catch (err) {
        resolved.logger.warn(`tokenguardrail: stream cost accounting failed: ${errMessage(err)}`);
      }
    }
  }

  // Proxy so every property of the original stream object (e.g. `.controller`) still works;
  // only Symbol.asyncIterator is intercepted to route iteration through cost accounting.
  return new Proxy(stream as object, {
    get(target, prop, receiver) {
      if (prop === Symbol.asyncIterator) {
        return () => accounted();
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as AsyncIterable<unknown>;
}

function proxyAtPath(
  target: object,
  path: string[],
  provider: ProviderAdapter,
  instance: TokenguardInstance,
  resolved: ResolvedConfig,
  options: TokenguardWrapperOptions
): object {
  const [head, ...rest] = path;

  return new Proxy(target, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver);
      if (prop !== head) return value;

      if (rest.length === 0) {
        return typeof value === 'function'
          ? createWrappedMethod((value as (...a: unknown[]) => unknown).bind(t), provider, instance, resolved, options)
          : value;
      }

      return value && typeof value === 'object' ? proxyAtPath(value, rest, provider, instance, resolved, options) : value;
    },
  });
}

/**
 * Wraps an LLM client with automatic cost tracking. Detects the provider by duck-typing the
 * client (or uses the explicit `options.provider` hint), intercepts only the provider's
 * cost-bearing method, enforces any configured budget before the call, and fans the resulting
 * CostEvent out to `onCost` + configured sinks (+ a session, if given) — including for streaming
 * calls (see docs/implementation-plan.md §6).
 *
 * Auto-wrapped providers: OpenAI, Anthropic, Mistral. Groq is OpenAI-compatible and cannot be
 * told apart from OpenAI by shape, so it requires `options.provider: 'groq'`. Google/Gemini uses a
 * different request shape and is supported via the standalone API, not the wrapper.
 *
 * Known-uncovered surfaces: the OpenAI Responses API and `beta.*` namespaces pass through
 * untouched (no cost event).
 */
export function tokenguard<T extends object>(client: T, options: TokenguardWrapperOptions = {}): T {
  const resolved = resolveConfig(options);
  const provider = options.provider ? resolved.providers.require(options.provider) : resolved.providers.detect(client);

  if (!provider) {
    throw new Error(
      `tokenguardrail: tokenguard() could not detect a supported client. Pass an explicit ` +
        `{ provider } for OpenAI-compatible clients (e.g. Groq). Supported providers: ${resolved.providers
          .list()
          .map((p) => p.id)
          .join(', ')}.`
    );
  }

  const path = INTERCEPT_PATH[provider.id];
  if (!path) {
    throw new Error(`tokenguardrail: no wrapper support configured for provider "${provider.id}".`);
  }

  const instance = createInstanceFromConfig(resolved);
  return proxyAtPath(client, path, provider, instance, resolved, options) as T;
}
