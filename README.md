# tokenguardrail

Know the cost of your LLM calls **before** and **after** you send them — and cap spend before a
call ever fires.

`tokenguardrail` is a small TypeScript SDK you put around your existing OpenAI, Anthropic, Google
(Gemini), Mistral, and Groq clients. It tells you the cost of each call (a pre-call estimate and the
actual cost from returned token usage, including cached input tokens), enforces **budget
guardrails**, rolls cost up across an agent chain with **sessions**, and fans cost events out to
pluggable **sinks**.

See [`docs/implementation-plan.md`](docs/implementation-plan.md) for the full design.

## Install

```bash
npm install tokenguardrail
```

The provider clients — `openai`, `@anthropic-ai/sdk`, `@google/genai`, `@mistralai/mistralai`,
`groq-sdk` — are all **optional** peer dependencies; install whichever you use. Exact-mode token
counting optionally uses `js-tiktoken`; without it, estimates fall back to a heuristic counter.

## Usage

### Standalone estimate (no wrapping)

```ts
import { estimateCost } from 'tokenguardrail';

const est = await estimateCost({
  provider: 'openai',
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello!' }],
  maxOutputTokens: 500, // optional; falls back to the configured default
});
// { model, inputTokens, assumedOutputTokens, estimatedCostUsd, pricingSource, pricingUpdatedAt }
```

`estimateCost` is `async`: it may lazily load an exact tokenizer on first use. `costFromUsage`
below stays synchronous — it only reads a `usage` object the provider already returned.

### Actual cost from a response you already have

```ts
import { costFromUsage } from 'tokenguardrail';

const cost = costFromUsage({ provider: 'openai', model: 'gpt-4o', usage: res.usage });
// { model, inputTokens, outputTokens, cachedInputTokens, actualCostUsd, pricingSource }
```

### Configured instance

```ts
import { createTokenguard } from 'tokenguardrail';

const tg = createTokenguard({
  pricingOverrides: { 'gpt-4o': { inputPerMTok: 2.5, outputPerMTok: 10 } },
  defaultMaxOutputTokens: 512,
  logger: myLogger,
});

await tg.estimateCost({ provider: 'openai', model: 'gpt-4o', messages });
```

### Wrapper (attaches both automatically, incl. streaming)

```ts
import OpenAI from 'openai';
import { tokenguard } from 'tokenguardrail';

const openai = tokenguard(new OpenAI(), {
  onCost: (evt) => console.log(evt.estimate?.estimatedCostUsd, evt.actual?.actualCostUsd),
});

const res = await openai.chat.completions.create({ model: 'gpt-4o', messages });
```

`tokenguard()` detects the provider from the client shape and only intercepts
`chat.completions.create` / `messages.create`. Instrumentation is `try/catch`-wrapped so it can
never break the underlying call — a throwing tokenizer or a throwing `onCost` callback still
lets the real response through. Streaming calls get an `actual` cost too, computed from the
streamed deltas (and real provider `usage` when available); when no `usage` arrives, the cost
is heuristic and flagged via `actual.approximate`.

**Auto-wrapped providers:** OpenAI, Anthropic, Mistral. **Groq** is OpenAI-compatible and can't be
told apart from an OpenAI client by shape, so pass an explicit hint:

```ts
import Groq from 'groq-sdk';
import { tokenguard } from 'tokenguardrail';

const groq = tokenguard(new Groq(), { provider: 'groq', onCost: (e) => console.log(e.actual?.actualCostUsd) });
```

**Google/Gemini** uses a different request shape (`contents`, not `messages`), so it is supported via
the standalone `estimateCost` / `costFromUsage` API rather than the wrapper.

## Budgets (pre-call guardrail)

Set a limit and tokenguardrail blocks a call whose **estimate** would exceed it — *before* the
request is sent.

```ts
import { tokenguard, BudgetExceededError } from 'tokenguardrail';

const openai = tokenguard(new OpenAI(), {
  budget: {
    maxCostPerCallUsd: 0.50,   // reject any single call estimated above 50¢
    maxTotalCostUsd: 100,      // reject once cumulative spend would cross $100
    warnAtFraction: 0.8,       // log a warning at 80% of a limit
    onExceeded: 'throw',       // 'throw' (default) | 'warn' | 'silent'
  },
});

try {
  await openai.chat.completions.create({ model: 'gpt-4o', messages });
} catch (err) {
  if (err instanceof BudgetExceededError) {
    console.error(err.reason, err.limitUsd, err.projectedUsd); // 'per-call' | 'cumulative'
  }
}
```

> **Budget errors throw by design.** Everywhere else, tokenguardrail's instrumentation is wrapped in
> `try/catch` so it can *never* break your call. A budget guardrail is the deliberate exception: with
> `onExceeded: 'throw'` (the default) a `BudgetExceededError` propagates to your code and the LLM
> request is **not** made. Use `'warn'` or `'silent'` if you want spend tracking without blocking.
> Cumulative spend is tracked per instance (and per session); read it any time with
> `tg.budgetStatus()`.

## Sessions (aggregate an agent chain)

Roll cost up across many calls — e.g. one agent run — with per-model breakdown.

```ts
import { createSession, tokenguard } from 'tokenguardrail';

const session = createSession({ maxTotalCostUsd: 5 }); // optional session-scoped budget
const openai = tokenguard(new OpenAI(), { session });

await openai.chat.completions.create({ model: 'gpt-4o', messages: step1 });
await openai.chat.completions.create({ model: 'gpt-4o', messages: step2 });

session.total();
// { calls, estimatedCostUsd, actualCostUsd, byModel: { 'gpt-4o': { calls, estimatedCostUsd, actualCostUsd } } }
```

## Sinks (fan cost events out)

`onCost` is one listener; `sinks` lets you register several. Each runs in its own `try/catch`, so a
throwing sink can't break another sink or your call.

```ts
import { tokenguard, memorySink, consoleSink } from 'tokenguardrail';

const store = memorySink();
const openai = tokenguard(new OpenAI(), { sinks: [consoleSink(), store] });
// … after some calls:
store.total(); // { calls, estimatedCostUsd, actualCostUsd }
```

**Known gaps:** the OpenAI Responses API and `beta.*` namespaces aren't wrapped. Image/audio
content parts aren't counted (text parts only), so vision prompts are under-estimated. Gemini is
standalone-only (not wrapped). Anthropic/Mistral/Google have no local tokenizer, so their pre-call
estimates are heuristic.

## Accuracy caveat

The pre-call estimate is guidance, not a guarantee. Exact mode reproduces the OpenAI
per-message/token overhead formula and counts tool/function schemas, but multimodal content and
provider-side prompt transformations can still shift the real count. Anthropic has no public
local tokenizer, so its estimate is always heuristic until the official `count_tokens` endpoint
is wired in as an opt-in exact mode.

## License

ISC
