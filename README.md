# tokenguardrail

[![npm version](https://img.shields.io/npm/v/tokenguardrail.svg)](https://www.npmjs.com/package/tokenguardrail)
[![license](https://img.shields.io/npm/l/tokenguardrail.svg)](./LICENSE)
[![types](https://img.shields.io/npm/types/tokenguardrail.svg)](https://www.npmjs.com/package/tokenguardrail)

**Know what every LLM call costs — before and after you send it — and cap spend before a call ever fires.**

Wrap your existing OpenAI, Anthropic, Google (Gemini), Mistral, or Groq client and `tokenguardrail`
attaches a pre-call cost estimate and the actual cost from returned token usage (cache-aware). Point
it at a tokenguardrail server with your API key and it also ships every cost event there and enforces
the spend budget you set on the server — all without changing how you call the model.

```ts
import OpenAI from 'openai';
import { tokenguard } from 'tokenguardrail';

const openai = tokenguard(new OpenAI(), {
  onCost: (e) => console.log(e.model, e.estimate?.estimatedCostUsd, '→', e.actual?.actualCostUsd),
});

// use it exactly like the original client — cost is tracked automatically
await openai.chat.completions.create({ model: 'gpt-4o', messages });
```

## Features

- 💰 **Pre-call estimate + actual cost** — cache-aware pricing from returned `usage`, per call.
- 🛡️ **Server-managed budgets** — set a spend cap on your account; the SDK blocks over-budget calls before they fire.
- 🔌 **Drop-in wrapping** — wrap the client once; use it unchanged. Streaming included.
- 🧵 **Sessions** — roll cost up across an agent chain with a per-model breakdown.
- 📤 **Sinks** — fan cost events anywhere; a built-in remote sink ships them to a server.
- 🪶 **Tiny & safe** — no required deps; instrumentation is fail-open and never breaks your call.

## Install

```bash
npm install tokenguardrail
```

Provider clients (`openai`, `@anthropic-ai/sdk`, `@google/genai`, `@mistralai/mistralai`,
`groq-sdk`) are **optional** peer dependencies — install whichever you use. Exact OpenAI token
counting optionally uses `js-tiktoken`; without it, estimates fall back to a heuristic. Requires
Node 18+ (global `fetch`). Ships ESM + CJS with type definitions.

## Wrapping a client

`tokenguard()` detects the provider from the client and intercepts only the cost-bearing method
(`chat.completions.create` / `messages.create`). Every call gets a pre-call estimate and, after the
response, the actual cost — streaming included (from streamed deltas, plus real `usage` when
available; heuristic output is flagged via `actual.approximate`). Instrumentation is
`try/catch`-wrapped, so a throwing tokenizer or `onCost` can never break the underlying call.

**Auto-detected:** OpenAI, Anthropic, Mistral. **Groq** is OpenAI-compatible and can't be told apart
by shape, so pass a hint. **Gemini** uses a different request shape and is supported via the
[standalone API](#standalone-api) rather than the wrapper.

```ts
import Groq from 'groq-sdk';
import { tokenguard } from 'tokenguardrail';

const groq = tokenguard(new Groq(), { provider: 'groq', onCost: (e) => console.log(e.actual?.actualCostUsd) });
await groq.chat.completions.create({ model: 'llama-3.1-8b-instant', messages });
```

## Budgets via the tokenguardrail server

Budgets live on the server, not in code. Set a total spend cap on your account (`PUT /v1/budget`),
then pass your API key — the SDK fetches the cap (plus spend so far) and **enforces it before each
call**: once `spent + this call's estimate` would exceed the cap, the call throws
`BudgetExceededError` and is never sent. The same option ships every cost event to `POST
/v1/ingest`.

```ts
import { tokenguard, BudgetExceededError } from 'tokenguardrail';

const groq = tokenguard(new Groq(), {
  provider: 'groq',
  tokenguardrail: {
    apiKey: process.env.TOKENGUARDRAIL_API_KEY, // tgr_live_...
    baseUrl: 'https://your-tokenguardrail-server', // or http://localhost:3000
  },
});

try {
  await groq.chat.completions.create({ model: 'llama-3.1-8b-instant', messages });
} catch (err) {
  if (err instanceof BudgetExceededError) {
    console.error(`over budget: projected $${err.projectedUsd} > cap $${err.limitUsd}`);
  }
}
```

No budget set ⇒ no restriction. Budget enforcement is fail-open (a budget-service hiccup never
blocks a call); ship cost without enforcing by passing `tokenguardrail: { …, enforceBudget: false }`.

## Sessions

Roll cost up across many calls — e.g. one agent run — with a per-model breakdown and an optional
session-scoped cap.

```ts
import { createSession, tokenguard } from 'tokenguardrail';

const session = createSession({ maxTotalCostUsd: 5 }); // optional cap for this run
const openai = tokenguard(new OpenAI(), { session });

await openai.chat.completions.create({ model: 'gpt-4o', messages: step1 });
await openai.chat.completions.create({ model: 'gpt-4o', messages: step2 });

session.total(); // { calls, estimatedCostUsd, actualCostUsd, byModel: { … } }
```

## Sinks

`onCost` is one listener; `sinks` registers several. Each runs in its own `try/catch`, so a throwing
sink can't break another or your call.

```ts
import { tokenguard, memorySink, consoleSink, createRemoteSink } from 'tokenguardrail';

const store = memorySink();
const openai = tokenguard(new OpenAI(), {
  sinks: [
    consoleSink(),
    store,
    createRemoteSink({ apiKey: process.env.TOKENGUARDRAIL_API_KEY, baseUrl: 'http://localhost:3000' }),
  ],
});

store.total(); // { calls, estimatedCostUsd, actualCostUsd }
```

`createRemoteSink` is the same HTTP sink the `tokenguardrail: { apiKey, baseUrl }` shortcut installs
— use it directly to compose it with others.

## Standalone API

For Gemini, or any time you have the pieces yourself.

```ts
import { estimateCost, costFromUsage, createTokenguard } from 'tokenguardrail';

// Pre-call estimate (async — may lazily load an exact tokenizer):
const est = await estimateCost({ provider: 'openai', model: 'gpt-4o', messages, maxOutputTokens: 500 });
// { model, inputTokens, assumedOutputTokens, estimatedCostUsd, pricingSource, pricingUpdatedAt }

// Actual cost from a response you already have (sync):
const cost = costFromUsage({ provider: 'openai', model: 'gpt-4o', usage: res.usage });
// { model, inputTokens, outputTokens, cachedInputTokens, actualCostUsd, pricingSource }

// A configured instance carrying pricing overrides / defaults / sinks / logger:
const tg = createTokenguard({ pricingOverrides: { 'gpt-4o': { inputPerMTok: 2.5, outputPerMTok: 10 } } });
await tg.estimateCost({ provider: 'openai', model: 'gpt-4o', messages });
```

## Provider support & limitations

| Provider | Wrapper | Local tokenizer (exact estimate) |
| --- | --- | --- |
| OpenAI | ✅ auto | ✅ (via optional `js-tiktoken`) |
| Groq | ✅ (`provider: 'groq'`) | ✅ (OpenAI-compatible) |
| Anthropic | ✅ auto | heuristic |
| Mistral | ✅ auto | heuristic |
| Google / Gemini | ❌ standalone only | heuristic |

- The pre-call **estimate is guidance, not a guarantee** — multimodal content and provider-side
  prompt transforms can shift the count. The actual cost from `usage` is exact.
- The OpenAI Responses API and `beta.*` namespaces aren't wrapped; image/audio content parts aren't
  counted (text only), so vision prompts are under-estimated pre-call.

## License

ISC © Subham Singh
