# tokenguardrail — Architecture & Design

> Status: **Stable.** The SDK ships cost estimation, cache-aware actual costing, budget guardrails,
> session aggregation, pluggable sinks, and five providers (OpenAI, Anthropic, Google/Gemini,
> Mistral, Groq). A central ingestion server and dashboard are the only deferred pieces (§9).
>
> This document is the design reference for the SDK. For task-oriented usage, see
> [`../sdk/README.md`](../sdk/README.md).

---

## 1. Context & problem

Teams shipping LLM features can't easily answer **"what is this call going to cost?"** Cost stays
invisible until the provider invoice arrives, and prompt caching / reasoning tokens make the real
number non-obvious even after the fact.

`tokenguardrail` is a **TypeScript/Node SDK** that developers put around their existing LLM clients.
It does three things:

1. **Costs every call** — a *pre-call estimate* (from the input plus an assumed output size) and the
   *actual cost* computed from the token usage the provider returns, **including cached input
   tokens**, which real workloads bill separately.
2. **Guards spend** — an optional pre-call **budget** blocks (or warns on) a call whose estimate
   would exceed a per-call or cumulative limit, *before* the request is sent.
3. **Makes cost observable** — **sessions** roll cost up across an agent chain, and **sinks** fan
   every cost event out to one or more listeners.

### Goals

- Estimate the USD cost of a call *before* sending it.
- Compute the *authoritative* cost from returned usage, cache- and reasoning-token aware.
- Support OpenAI, Anthropic, Google/Gemini, Mistral, and Groq, and make adding a provider a
  **single cohesive change** (one file/seam).
- Be **config-driven**: pricing, defaults, budgets, sinks, and logging are all injectable.
- Be trivial to adopt — standalone functions, plus an optional wrapper that never breaks the call
  (budget enforcement being the one deliberate exception).

### Non-goals (owned by the deferred server, not the SDK — see §9)

- No central ingestion server, storage, or querying/aggregation API.
- No dashboard UI.
- No prompt-content storage.

---

## 2. Repository layout

The SDK is a **self-contained npm package** in `sdk/`. The Express app in `server/` is a **separate
consumer** that installs the package and exercises it end-to-end — it never shares source with the
SDK; it depends on the package the same way any customer would.

```
tokenguardrail/
├── sdk/                          # the npm package — published as `tokenguardrail`
│   ├── src/
│   │   ├── index.ts              # public API surface (re-exports)
│   │   ├── config.ts             # TokenguardConfig resolution + default instance
│   │   ├── instance.ts           # createTokenguard / estimateCost / costFromUsage / createSession
│   │   ├── types.ts              # all public types
│   │   ├── pricing/
│   │   │   ├── registry.ts       # resolution chain (exact → alias → family → unknown)
│   │   │   └── pricing.json      # model → prices (incl. cache rates), versioned
│   │   ├── cost/
│   │   │   └── calculate.ts      # tokens × price → USD (pure, cache-aware)
│   │   ├── providers/
│   │   │   ├── provider.ts       # ProviderAdapter interface (Strategy) + ProviderRegistry
│   │   │   ├── openai.ts         # detect / count / normalize / resolveKey per provider
│   │   │   ├── anthropic.ts
│   │   │   ├── google.ts
│   │   │   ├── mistral.ts
│   │   │   └── groq.ts           # OpenAI-compatible — reuses openai.ts accounting
│   │   ├── tokens/
│   │   │   └── heuristic.ts      # shared fallback counter; js-tiktoken lazy-loaded in openai.ts
│   │   ├── budget/
│   │   │   └── budget.ts         # BudgetConfig, BudgetTracker, BudgetExceededError
│   │   ├── session/
│   │   │   └── session.ts        # TokenguardSession — cross-call aggregation
│   │   ├── sinks/
│   │   │   └── sink.ts           # CostSink fan-out + consoleSink / memorySink
│   │   └── wrapper/
│   │       └── tokenguard.ts     # optional Proxy client wrapper
│   ├── test/
│   ├── tsup.config.ts
│   └── package.json              # ESM+CJS, provider clients are optional peer deps
│
├── server/                       # Express consumer + end-to-end smoke tests
│   ├── app.js
│   ├── server.js
│   └── test/smoke.test.js
│
├── docs/implementation-plan.md   # this document
└── package.json                  # root: workspace orchestration only, no SDK code
```

An npm workspace (`"workspaces": ["sdk", "server"]`) lets `server/` `import 'tokenguardrail'` from
the local `sdk/` during development without publishing.

---

## 3. How it's used

Full, task-oriented examples live in [`../sdk/README.md`](../sdk/README.md). In brief:

- **`estimateCost(input)`** — async pre-call estimate (may lazily load an exact tokenizer).
- **`costFromUsage(input)`** — sync actual cost from a `usage` object the provider already returned.
- **`createTokenguard(config)`** — a configured, isolated instance; the bare exports are sugar over a
  lazily-created default instance.
- **`tokenguard(client, options)`** — an optional Proxy wrapper that attaches estimate + actual
  automatically, enforces budgets, and emits cost events (including for streaming).
- **`createSession(budget?)` / `tg.session(budget?)`** — aggregate cost across a chain of calls.

---

## 4. Design

The architecture is organized around **one seam per provider** so adding a provider is a single
cohesive change, not edits scattered across `tokens/`, `providers/`, and `pricing/`.

| Component | Responsibility | Pattern |
|---|---|---|
| **Provider** (`providers/*.ts`) | Owns everything provider-specific: detect a client, count input tokens, normalize the usage object, resolve a model → pricing key. | Strategy + Adapter |
| **ProviderRegistry** (`providers/provider.ts`) | Register + look up providers by id. Adding a provider = register one object. | Registry |
| **Pricing registry** (`pricing/`) | Resolve a model to a price via a resolution chain: exact → alias → family → unknown. Bundled versioned JSON, overridable via config. | Registry + chain-of-resolution |
| **Cost calculator** (`cost/`) | `(usage, price) → USD`. Pure, unit-tested, cache-aware. | — |
| **Config** (`config.ts`) | Resolve `TokenguardConfig` in a defined order; hold the default instance and per-instance budget tracker; inject the logger. | Factory + default singleton |
| **Budget** (`budget/`) | Pre-call guardrail state + decision (`BudgetTracker`) and error (`BudgetExceededError`). | — |
| **Session** (`session/`) | Aggregate cost across calls, with an optional session-scoped budget. | — |
| **Sinks** (`sinks/`) | Fan a cost event out to many listeners, each isolated. | Observer |
| **`tokenguard()`** (`wrapper/`) | Optional Proxy: estimate → enforce budget → call → cost from usage → fan out. | Proxy + Observer |

### 4.1 Provider interface & the cross-provider usage invariant (the single seam)

```ts
interface ProviderAdapter {
  id: string;                                           // 'openai' | 'anthropic' | 'google' | …
  detect(client: unknown): boolean;                     // for tokenguard() auto-detection
  countInputTokens(input: CountInput): Promise<number>; // async: exact tokenizer is lazy-loaded (§4.4)
  normalizeUsage(raw: unknown): NormalizedUsage;        // Adapter → common shape (see invariant)
  resolvePricingKey(model: string): string;             // anchored family/alias normalization (§4.3)
}

interface NormalizedUsage {
  inputTokens: number;          // INVARIANT: total input, INCLUDING cached & cache-write
  outputTokens: number;         // INVARIANT: total output, INCLUDING reasoning tokens
  cachedInputTokens: number;    // cache *reads* — a subset of inputTokens
  cacheWriteTokens: number;     // cache *creation* — a subset of inputTokens
}
```

**Cross-provider invariant (must be enforced by every `normalizeUsage`).** Providers report token
usage with *different accounting*, and the §4.3 cost formula only works if we normalize to one
convention: **`inputTokens` is the total input, with `cachedInputTokens` and `cacheWriteTokens` as
subsets of it** (so `inputTokens − cachedInputTokens − cacheWriteTokens` = the tokens billed at full
input price, always ≥ 0). Concretely:

- **OpenAI / Groq** already report this way: `prompt_tokens` is the total and
  `prompt_tokens_details.cached_tokens` is a subset → map directly (`cacheWriteTokens = 0`).
- **Anthropic** reports **non-overlapping buckets**: `usage.input_tokens` *excludes* cached and
  cache-creation tokens, so `normalizeUsage` **adds them back**:
  `inputTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`,
  `cachedInputTokens = cache_read_input_tokens`, `cacheWriteTokens = cache_creation_input_tokens`.
- **Google/Gemini** reports `promptTokenCount` as the total (cache-inclusive) with
  `cachedContentTokenCount` a subset → map directly, and folds `thoughtsTokenCount` (reasoning) into
  `outputTokens`.
- **Mistral** reports `promptTokens` / `completionTokens` and no cache tokens.
- **`outputTokens`** already includes reasoning tokens for every provider — never add a separate
  reasoning count on top (it would double-count).

Every provider ships a `normalizeUsage` **fixture test** (one response with cache tokens, one
without) asserting the invariant holds — the cheapest guard against silent mis-billing that would
otherwise only surface on an invoice.

Providers register into the `ProviderRegistry`; `tokens/heuristic.ts` is a shared helper a provider
*pulls in*. There is no parallel provider `switch` to keep in sync.

### 4.2 Config-driven, instance-based API

A `TokenguardConfig` is resolved in a **defined order** (last wins): bundled defaults → instance
overrides passed to `createTokenguard(config)` → per-call overrides (e.g. inline `maxOutputTokens`).

```ts
interface TokenguardConfig {
  pricingOverrides?: Record<string, Partial<ModelPrice>>;  // merged onto bundled pricing
  defaultMaxOutputTokens?: number;                          // used when maxOutputTokens omitted
  unknownModel?: 'warn' | 'throw' | 'silent';               // default 'warn' (log-once)
  logger?: Logger;                                          // injectable — no hardcoded console
  budget?: BudgetConfig;                                    // pre-call guardrail (§6)
  sinks?: CostSink[];                                       // extra event listeners (§7)
}
```

Module-level exports back a lazily-created default instance, so the simple case stays one import
while tests and multi-tenant callers get isolated instances (no hidden global mutable state). The
cumulative-spend `BudgetTracker` lives on the resolved instance for the same reason.

### 4.3 Pricing schema & resolution (cache-aware)

```jsonc
{
  "version": 2,
  "models": {
    "gpt-4o": {
      "inputPerMTok": 2.5,
      "outputPerMTok": 10,
      "cacheReadPerMTok": 1.25,     // cached input billed at a discount
      "cacheWritePerMTok": null,    // OpenAI: n/a; Anthropic: cache-creation surcharge
      "updatedAt": "2026-08-03"
    }
  },
  "aliases": { "gpt-4o-2024-08-06": "gpt-4o" }   // family resolution for dated snapshots
}
```

**Resolution chain:** exact key → `aliases` lookup → provider `resolvePricingKey()` prefix/family
match → unknown (fallback per `unknownModel`, result flagged `pricingSource: 'unknown'`). This keeps
the JSON from rotting every time a provider ships a dated snapshot. A per-instance `pricingOverride`
wins over whatever the chain finds and is flagged `pricingSource: 'override'` so drift stays visible.

> **Anchored matching only.** `resolvePricingKey()` resolves families with **anchored** rules
> (longest-prefix / explicit family list): the most-specific variant is tried first, e.g.
> `gpt-4o-mini-*` before `gpt-4o-*`, `gemini-2.5-flash-lite-*` before `gemini-2.5-flash-*`, and a
> bare `o1` never matches `o1-preview`. Bidirectional substring matching
> (`model.includes(key) || key.includes(model)`) mis-resolves models and is explicitly avoided —
> order-sensitive prefix rules + a fixed family table are the safe form.

**Cost model.** The pre-call number is an *estimate* (output length is unknown, so
`assumedOutputTokens` = `maxOutputTokens` or the configured default). The post-call number is
*authoritative*:

```
uncachedInput = inputTokens - cachedInputTokens - cacheWriteTokens   // ≥ 0 by the §4.1 invariant

cost = uncachedInput      × inputPerMTok
     + cachedInputTokens  × (cacheReadPerMTok  ?? inputPerMTok)
     + cacheWriteTokens   × (cacheWritePerMTok ?? inputPerMTok)
     + outputTokens       × outputPerMTok      // all ÷ 1e6
```

Because §4.1 makes cached and cache-write tokens **subsets** of `inputTokens`, both are subtracted
out of the full-price term (subtracting only `cachedInputTokens` would double-charge cache writes).

> **Cache-rate fallbacks are asymmetric on purpose.** When a rate is missing,
> `cacheReadPerMTok ?? inputPerMTok` *over*charges reads (real reads are cheaper) while
> `cacheWritePerMTok ?? inputPerMTok` *under*charges writes (writes are often 1.25–2× input). Known
> models set both, so this only bites unknown models; the conservative-ish direction is intentional.

### 4.4 Token counting — heuristic default, lazy exact (`countInputTokens` is async)

Input-token counting for the *estimate* has two tiers behind one provider method:

- **Default = heuristic (zero extra deps).** A shared char-ratio counter in `tokens/heuristic.ts`.
  Cheap, always available, "guidance not guarantee" accuracy.
- **Exact mode = lazily-imported tokenizer.** `openai.ts` does `await import('js-tiktoken')` on first
  use, so the (large) BPE ranks land in the bundle **only** for callers who opt into exact estimates;
  `costFromUsage`-only consumers stay light. Because the import is dynamic, **`countInputTokens` and
  therefore `estimateCost` are `async`** — chosen over eagerly bundling the tokenizer to keep the
  bundle small without giving up accuracy for callers who want it.

Exact mode reproduces the real request shape, not a bare `text.length`:

- **Per-model encoder selection:** `o200k_base` for `gpt-4o`/GPT-5/o-series, `cl100k_base` for
  gpt-4/3.5.
- **Message overhead:** `+3` tokens/message, `+1` for `name`, `+3` reply priming.
- **Tool/function schemas:** count name + description + `JSON.stringify(parameters)` + per-tool
  overhead — these materially change the count and are easy to forget.
- **Encoder caching:** encoder instances are memoized at module scope (`js-tiktoken` is pure-JS and
  needs no manual free).

`CountInput` therefore carries `messages`, `system?`, and `tools?`. Anthropic, Google, and Mistral
have no local tokenizer, so their estimates use the heuristic counter (Anthropic's official
`count_tokens` endpoint remains a possible later opt-in exact mode at the cost of a network
round-trip).

---

## 5. Public types

```ts
type Provider = 'openai' | 'anthropic' | 'google' | 'mistral' | 'groq' | (string & {});
type PricingSource = 'exact' | 'family' | 'unknown' | 'override';

interface CostEstimate {
  model: string;
  inputTokens: number;
  assumedOutputTokens: number;
  estimatedCostUsd: number;      // always an estimate (output assumed) — see pricingSource for price confidence
  pricingSource: PricingSource;
  pricingUpdatedAt: string;
}

interface ActualCost {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;     // surfaced so cache savings are visible
  actualCostUsd: number;
  pricingSource: PricingSource;
  approximate?: boolean;         // true when derived from streamed deltas without provider usage
}

interface CostEvent {            // payload passed to sinks / onCost
  provider: Provider;
  model: string;
  estimate?: CostEstimate;
  actual?: ActualCost;
  sessionId?: string;            // set when attributed to a session
}
```

> **Money type:** USD is a `number` (display/aggregation at SDK scale). A future ingestion server
> that sums across millions of calls will likely want integer micro-USD or a decimal type to avoid
> summation drift — a conscious choice noted so the field type isn't an accidental commitment.

---

## 6. The optional wrapper — detection, streaming & budget enforcement

`tokenguard(client, opts)` is the riskiest surface, so its hard realities are specified explicitly:

- **Provider detection.** The wrapper calls `Provider.detect(client)` across the registry
  (duck-typing the client's shape — no `instanceof` on optional peer deps). OpenAI-compatible clients
  such as **Groq** are indistinguishable from OpenAI by shape, so they require an explicit
  `options.provider` hint. **Google/Gemini** uses a different request shape and is served by the
  standalone API rather than the wrapper.
- **Budget enforcement — the one place the wrapper may break the call.** After the estimate and
  *before* the real request, the wrapper checks the instance budget (and the session budget, if any).
  On exceed with `onExceeded: 'throw'` (the default) a `BudgetExceededError` propagates to the caller
  and the request is **not** made — that is the guardrail's entire purpose. `'warn'`/`'silent'` let
  the call proceed. This runs on an explicit path *outside* the try/catch that wraps all other
  instrumentation; a throwing `onWarning` callback is still caught so it can't break the call.
- **Streaming (cost from deltas).** Streaming is detected from the **request**
  (`params.stream === true`), never from the return value. Then:
  - **OpenAI-compatible:** inject `stream_options: { include_usage: true }` (only if the caller didn't
    set it) so the final chunk carries real `usage`; wrap the returned async iterator and read that
    `usage` on completion. If the caller opted out, fall back to summing output deltas via the
    heuristic counter (input stays the pre-call estimate).
  - **Anthropic:** read `message_start.message.usage` (input, incl. cache tokens) and the final
    `message_delta.usage.output_tokens`.
  - When the count is heuristic (no provider usage), the emitted `actual` is flagged `approximate`.
  - **Passthrough:** the wrapper **tees** the stream without buffering or delaying chunks, and the
    whole delta-accounting path stays inside `try/catch` so a parse error can never break the stream.
- **Cost emission.** Post-call, the wrapper records actual spend into the budget tracker(s),
  attributes it to a session if provided, then fans the `CostEvent` out to all configured sinks +
  `onCost` (§7). Every listener is isolated in its own try/catch.
- **Known-uncovered surfaces.** Only `chat.completions.create` / `chat.complete` / `messages.create`
  are intercepted. The OpenAI Responses API and `beta.*` namespaces pass through untouched (no cost
  event).

---

## 7. Budgets, sessions, and sinks

**Budgets (`budget/budget.ts`).** `BudgetConfig` supports `maxCostPerCallUsd`, `maxTotalCostUsd`,
`warnAtFraction`, `onExceeded` (`'throw' | 'warn' | 'silent'`), and `onWarning`. `BudgetTracker`
splits **decision** from **state**: `check(estimate)` is pure (no mutation, no callbacks) and returns
an `allow | warn | exceed` `BudgetDecision`; `record(actual)` is the only mutator. This keeps the
"budget may throw" decision explicit in the wrapper and makes the tracker trivially testable.
Cumulative state is per-instance and per-session (never a module global); read it with
`tg.budgetStatus()` / `session.budgetStatus()`.

**Sessions (`session/session.ts`).** `TokenguardSession` aggregates cost across a chain of calls:
`total()` returns `{ calls, estimatedCostUsd, actualCostUsd, byModel }`, where `calls` counts
*completed* calls (those with an actual). A session may carry its own budget. Feed it via its own
`estimateCost` / `costFromUsage` methods, via `track(event)`, or automatically by passing it to the
wrapper (which also stamps `CostEvent.sessionId`).

**Sinks (`sinks/sink.ts`).** `CostSink = (event: CostEvent) => void | Promise<void>`. `emitCostEvent`
fans an event out to every configured sink plus `onCost`, each isolated in its own try/catch so one
throwing sink can't break another sink or the call. Built-ins: `consoleSink()` (one-line summary) and
`memorySink()` (collects events + totals — handy for tests and ad-hoc aggregation). `onCost` is just
one sink; `sinks` is the forward-compatible seam toward the ingestion server (§9).

---

## 8. Accuracy caveats

The pre-call **estimate** is guidance, not a guarantee:

- Even exact mode relies on the per-message overhead formula; **tool/function schemas** and
  **vision/image inputs** shift real counts. Images are counted only for their text parts today, so
  vision prompts are **under-estimated** (fast-follow: image-block token estimation).
- Anthropic, Google, and Mistral estimates are heuristic (no local tokenizer), so expect wider error
  bands than for OpenAI exact mode.
- The **actual** cost from returned usage is authoritative; both numbers are exposed so drift is
  visible.

---

## 9. Deferred — the ingestion server & dashboard

The SDK's `CostEvent` + sink fan-out is the seam toward a future observability stack, not yet built:

- **Metrics logging** (latency, status) alongside cost.
- A central **ingestion API** (what `server/` grows into) that consumes `CostEvent`s through a sink,
  persists them (e.g. SQLite), and exposes query/aggregation endpoints plus `X-Tokenguard-*` cost
  response headers.
- A **dashboard** for visualization (cost over time, per-model breakdown, budget status).

Nothing about the current SDK API blocks these; they layer on top of the existing sink seam.
