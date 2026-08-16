import { describe, expect, it, vi } from 'vitest';
import { tokenguard } from '../src/wrapper/tokenguard.js';
import { createTokenguard } from '../src/instance.js';
import { BudgetExceededError } from '../src/budget/budget.js';

function mockOpenAIClient(createImpl: (...args: unknown[]) => unknown) {
  return {
    chat: {
      completions: {
        create: createImpl,
      },
    },
  };
}

function mockAnthropicClient(createImpl: (...args: unknown[]) => unknown) {
  return {
    messages: {
      create: createImpl,
    },
  };
}

async function* toAsyncIterable<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

describe('tokenguard() — detection', () => {
  it('wraps a duck-typed OpenAI client', async () => {
    const client = mockOpenAIClient(async () => ({ usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    const wrapped = tokenguard(client);
    const res = await wrapped.chat.completions.create({ model: 'gpt-4o', messages: [] });
    expect(res).toEqual({ usage: { prompt_tokens: 10, completion_tokens: 5 } });
  });

  it('wraps a duck-typed Anthropic client', async () => {
    const client = mockAnthropicClient(async () => ({ usage: { input_tokens: 10, output_tokens: 5 } }));
    const wrapped = tokenguard(client);
    const res = await wrapped.messages.create({ model: 'claude-3-5-sonnet-20241022', max_tokens: 100, messages: [] });
    expect(res).toEqual({ usage: { input_tokens: 10, output_tokens: 5 } });
  });

  it('throws at setup time for an unrecognized client', () => {
    expect(() => tokenguard({ somethingElse: true })).toThrow(/could not detect/i);
  });
});

describe('tokenguard() — non-streaming cost tracking', () => {
  it('emits estimate + actual via onCost without altering the response', async () => {
    const onCost = vi.fn();
    const client = mockOpenAIClient(async () => ({
      choices: [{ message: { content: 'hi' } }],
      usage: { prompt_tokens: 12, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 4 } },
    }));
    const wrapped = tokenguard(client, { onCost });

    const res = await wrapped.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Hello!' }],
    });

    expect(res.choices[0].message.content).toBe('hi');
    expect(onCost).toHaveBeenCalledTimes(1);
    const event = onCost.mock.calls[0][0];
    expect(event.provider).toBe('openai');
    expect(event.estimate).toBeDefined();
    expect(event.actual).toMatchObject({ inputTokens: 12, outputTokens: 8, cachedInputTokens: 4 });
  });

  it('never breaks the underlying call when onCost throws', async () => {
    const onCost = vi.fn().mockRejectedValue(new Error('boom'));
    const client = mockOpenAIClient(async () => ({ usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const wrapped = tokenguard(client, { onCost, logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } });

    await expect(
      wrapped.chat.completions.create({ model: 'gpt-4o', messages: [] })
    ).resolves.toEqual({ usage: { prompt_tokens: 1, completion_tokens: 1 } });
  });

  it('propagates a real API error untouched (instrumentation never swallows it)', async () => {
    const client = mockOpenAIClient(async () => {
      throw new Error('upstream 500');
    });
    const wrapped = tokenguard(client, { onCost: vi.fn() });

    await expect(
      wrapped.chat.completions.create({ model: 'gpt-4o', messages: [] })
    ).rejects.toThrow('upstream 500');
  });
});

describe('tokenguard() — streaming cost tracking', () => {
  it('injects stream_options.include_usage for OpenAI and uses the real final usage', async () => {
    const onCost = vi.fn();
    const received: unknown[] = [];
    const client = mockOpenAIClient((params: unknown) => {
      received.push(params);
      return toAsyncIterable([
        { choices: [{ delta: { content: 'Hel' } }] },
        { choices: [{ delta: { content: 'lo' } }] },
        { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
      ]);
    });
    const wrapped = tokenguard(client, { onCost });

    const stream = await wrapped.chat.completions.create({
      model: 'gpt-4o',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });

    const chunks: unknown[] = [];
    for await (const chunk of stream as AsyncIterable<unknown>) chunks.push(chunk);

    expect(chunks).toHaveLength(3); // every chunk passed through untouched
    expect((received[0] as Record<string, unknown>)['stream_options']).toEqual({ include_usage: true });
    expect(onCost).toHaveBeenCalledTimes(1);
    const event = onCost.mock.calls[0][0];
    expect(event.actual).toMatchObject({ inputTokens: 10, outputTokens: 2 });
    expect(event.actual.approximate).toBeUndefined();
  });

  it('does not override an explicit stream_options the caller already set', async () => {
    const received: unknown[] = [];
    const client = mockOpenAIClient((params: unknown) => {
      received.push(params);
      return toAsyncIterable([{ choices: [{ delta: {} }] }]);
    });
    const wrapped = tokenguard(client, { onCost: vi.fn() });

    const stream = await wrapped.chat.completions.create({
      model: 'gpt-4o',
      stream: true,
      stream_options: { include_usage: false },
      messages: [],
    });
    for await (const _ of stream as AsyncIterable<unknown>) {
      // drain
    }

    expect((received[0] as Record<string, unknown>)['stream_options']).toEqual({ include_usage: false });
  });

  it('falls back to a heuristic output count and flags approximate when no usage arrives', async () => {
    const onCost = vi.fn();
    const client = mockOpenAIClient(() =>
      toAsyncIterable([
        { choices: [{ delta: { content: 'Hello there, how are you?' } }] },
        { choices: [{ delta: {} }] }, // no usage on this chunk — caller opted out
      ])
    );
    const wrapped = tokenguard(client, { onCost });

    const stream = await wrapped.chat.completions.create({
      model: 'gpt-4o',
      stream: true,
      stream_options: { include_usage: false },
      messages: [{ role: 'user', content: 'hi' }],
    });
    for await (const _ of stream as AsyncIterable<unknown>) {
      // drain
    }

    expect(onCost).toHaveBeenCalledTimes(1);
    const event = onCost.mock.calls[0][0];
    expect(event.actual.approximate).toBe(true);
    expect(event.actual.outputTokens).toBeGreaterThan(0);
  });

  it('accounts an Anthropic stream via message_start/message_delta usage', async () => {
    const onCost = vi.fn();
    const client = mockAnthropicClient(() =>
      toAsyncIterable([
        { type: 'message_start', message: { usage: { input_tokens: 20, cache_read_input_tokens: 5 } } },
        { type: 'content_block_delta', delta: { text: 'Hi' } },
        { type: 'message_delta', usage: { output_tokens: 7 } },
      ])
    );
    const wrapped = tokenguard(client, { onCost });

    const stream = await wrapped.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 100,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    for await (const _ of stream as AsyncIterable<unknown>) {
      // drain
    }

    expect(onCost).toHaveBeenCalledTimes(1);
    const event = onCost.mock.calls[0][0];
    // input_tokens(20) + cache_read(5) = 25 total, per the §4.1 invariant.
    expect(event.actual).toMatchObject({ inputTokens: 25, outputTokens: 7, cachedInputTokens: 5 });
  });

  it('never buffers/delays chunks even while accounting fails on a malformed one', async () => {
    const onCost = vi.fn();
    const client = mockOpenAIClient(() =>
      toAsyncIterable([
        { choices: [{ delta: { content: 'ok' } }] },
        null, // malformed chunk — accounting must not throw or drop it
        { choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ])
    );
    const wrapped = tokenguard(client, { onCost, logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } });

    const stream = await wrapped.chat.completions.create({ model: 'gpt-4o', stream: true, messages: [] });
    const chunks: unknown[] = [];
    for await (const chunk of stream as AsyncIterable<unknown>) chunks.push(chunk);

    expect(chunks).toEqual([{ choices: [{ delta: { content: 'ok' } }] }, null, { choices: [{ delta: {} }], usage: { prompt_tokens: 1, completion_tokens: 1 } }]);
    expect(onCost).toHaveBeenCalledTimes(1);
  });
});

describe('tokenguard() — provider hint (Groq / OpenAI-compatible)', () => {
  it('attributes cost to Groq when { provider: "groq" } is passed to an OpenAI-shaped client', async () => {
    const onCost = vi.fn();
    const client = mockOpenAIClient(async () => ({ usage: { prompt_tokens: 100, completion_tokens: 50 } }));
    const wrapped = tokenguard(client, { provider: 'groq', onCost });

    await wrapped.chat.completions.create({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'hi' }] });

    expect(onCost).toHaveBeenCalledTimes(1);
    const event = onCost.mock.calls[0][0];
    expect(event.provider).toBe('groq');
    expect(event.actual.pricingSource).toBe('exact'); // resolved against Groq pricing, not a fallback
  });

  it('defaults an OpenAI-shaped client to OpenAI without a hint', async () => {
    const onCost = vi.fn();
    const client = mockOpenAIClient(async () => ({ usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const wrapped = tokenguard(client, { onCost });
    await wrapped.chat.completions.create({ model: 'gpt-4o', messages: [] });
    expect(onCost.mock.calls[0][0].provider).toBe('openai');
  });
});

describe('tokenguard() — session attribution', () => {
  it('folds each wrapped call into the session and stamps sessionId on the event', async () => {
    const onCost = vi.fn();
    const tg = createTokenguard();
    const session = tg.session();
    const client = mockOpenAIClient(async () => ({ usage: { prompt_tokens: 100, completion_tokens: 50 } }));
    const wrapped = tokenguard(client, { session, onCost });

    await wrapped.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
    await wrapped.chat.completions.create({ model: 'gpt-4o', messages: [{ role: 'user', content: 'again' }] });

    const total = session.total();
    expect(total.calls).toBe(2);
    expect(total.actualCostUsd).toBeGreaterThan(0);
    expect(onCost.mock.calls[0][0].sessionId).toBe(session.id);
  });

  it('blocks via a session-scoped budget once the session cap is projected to be exceeded', async () => {
    // Keep estimate and actual aligned (~$2.00/call) so the cumulative math is deterministic:
    // 200k output tokens @ $10/M = $2.00, and max_tokens=200k makes the pre-call estimate match.
    const create = vi.fn(async () => ({ usage: { prompt_tokens: 0, completion_tokens: 200_000 } }));
    const tg = createTokenguard();
    const session = tg.session({ maxTotalCostUsd: 3 });
    const wrapped = tokenguard(mockOpenAIClient(create), { session });
    const params = { model: 'gpt-4o', max_tokens: 200_000, messages: [] };

    await wrapped.chat.completions.create(params); // estimate $2 < $3 → allowed; records ~$2 actual
    await expect(wrapped.chat.completions.create(params)).rejects.toBeInstanceOf(BudgetExceededError); // 2 + 2 > 3
    expect(create).toHaveBeenCalledTimes(1); // second call blocked before firing
  });
});
