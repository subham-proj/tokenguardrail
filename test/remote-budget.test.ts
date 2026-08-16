import { describe, expect, it, vi } from 'vitest';
import { fetchRemoteBudget } from '../src/budget/remote-budget.js';
import { tokenguard } from '../src/wrapper/tokenguard.js';
import { BudgetExceededError } from '../src/budget/budget.js';

const silentLogger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };

describe('fetchRemoteBudget', () => {
  it('GETs {baseUrl}/v1/budget with a bearer key and returns { budget, spentUsd }', async () => {
    const budget = { maxTotalCostUsd: 5, onExceeded: 'throw' as const };
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ budget, spentUsd: 1.25 }) }));

    const result = await fetchRemoteBudget({ apiKey: 'tgr_live_k', baseUrl: 'http://h:3000/', fetch }, silentLogger);

    expect(result).toEqual({ budget, spentUsd: 1.25 });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('http://h:3000/v1/budget');
    expect(init.method).toBe('GET');
    expect(init.headers.authorization).toBe('Bearer tgr_live_k');
  });

  it('returns { budget: null, spentUsd } when no budget is set', async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ budget: null, spentUsd: 0.4 }) }));
    expect(await fetchRemoteBudget({ apiKey: 'k', baseUrl: 'http://h', fetch }, silentLogger)).toEqual({
      budget: null,
      spentUsd: 0.4,
    });
  });

  it('is fail-open on non-2xx and on network error (returns empty, never throws)', async () => {
    const empty = { budget: null, spentUsd: 0 };
    const err401 = vi.fn(async () => ({ ok: false, status: 401 }));
    expect(await fetchRemoteBudget({ apiKey: 'k', baseUrl: 'http://h', fetch: err401 }, silentLogger)).toEqual(empty);

    const boom = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await fetchRemoteBudget({ apiKey: 'k', baseUrl: 'http://h', fetch: boom }, silentLogger)).toEqual(empty);
  });

  it('returns empty without apiKey/baseUrl', async () => {
    expect(await fetchRemoteBudget({ apiKey: '', baseUrl: 'http://h' }, silentLogger)).toEqual({ budget: null, spentUsd: 0 });
    expect(await fetchRemoteBudget({ apiKey: 'k', baseUrl: '' }, silentLogger)).toEqual({ budget: null, spentUsd: 0 });
  });
});

describe('tokenguard() — enforces a server-fetched cumulative budget before the call', () => {
  // A fake OpenAI/Groq-shaped client whose create() records whether it was actually invoked.
  function fakeClient(calls: { made: boolean }) {
    return {
      chat: {
        completions: {
          create: async () => {
            calls.made = true;
            return { choices: [{ message: { content: 'hi' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
          },
        },
      },
    };
  }

  // Routes GET /v1/budget → the given { budget, spentUsd }; POST /v1/ingest → 201.
  function routingFetch(budget: unknown, spentUsd = 0) {
    return vi.fn(async (url: string, init: { method: string }) => {
      if (init.method === 'GET' && url.endsWith('/v1/budget')) {
        return { ok: true, status: 200, json: async () => ({ budget, spentUsd }) };
      }
      return { ok: true, status: 201, text: async () => '' }; // ingest
    });
  }

  it('blocks (call never made) when the total cap is already exceeded by prior spend', async () => {
    const calls = { made: false };
    // Generous-looking cap, but the account has already spent past it → next call is blocked.
    const fetch = routingFetch({ maxTotalCostUsd: 0.5, onExceeded: 'throw' }, 0.6);
    const client = tokenguard(fakeClient(calls), {
      provider: 'groq',
      logger: silentLogger,
      tokenguardrail: { apiKey: 'tgr_live_k', baseUrl: 'http://h', fetch },
    });

    await expect(
      client.chat.completions.create({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: 'hello there' }] })
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(calls.made).toBe(false); // blocked before the network call
  });

  it('blocks when this call would push the running total over a tiny cap', async () => {
    const calls = { made: false };
    const fetch = routingFetch({ maxTotalCostUsd: 0.0000001, onExceeded: 'throw' }, 0);
    const client = tokenguard(fakeClient(calls), {
      provider: 'groq',
      logger: silentLogger,
      tokenguardrail: { apiKey: 'tgr_live_k', baseUrl: 'http://h', fetch },
    });

    await expect(
      client.chat.completions.create({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: 'hello there' }] })
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(calls.made).toBe(false);
  });

  it('allows the call when total spend stays under the cap', async () => {
    const calls = { made: false };
    const fetch = routingFetch({ maxTotalCostUsd: 100, onExceeded: 'throw' }, 1);
    const client = tokenguard(fakeClient(calls), {
      provider: 'groq',
      logger: silentLogger,
      tokenguardrail: { apiKey: 'tgr_live_k', baseUrl: 'http://h', fetch },
    });

    await client.chat.completions.create({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: 'hi' }] });
    expect(calls.made).toBe(true);
  });

  it('does not fetch or enforce a budget when enforceBudget is false', async () => {
    const calls = { made: false };
    const fetch = routingFetch({ maxTotalCostUsd: 0.0000001, onExceeded: 'throw' }, 1);
    const client = tokenguard(fakeClient(calls), {
      provider: 'groq',
      logger: silentLogger,
      tokenguardrail: { apiKey: 'tgr_live_k', baseUrl: 'http://h', fetch, enforceBudget: false },
    });

    // Even though the server budget is tiny and already exceeded, the call goes through.
    await client.chat.completions.create({ model: 'llama-3.1-8b-instant', messages: [{ role: 'user', content: 'hi' }] });
    expect(calls.made).toBe(true);
    const getBudgetCalls = fetch.mock.calls.filter(([url, init]) => init.method === 'GET' && url.endsWith('/v1/budget'));
    expect(getBudgetCalls).toHaveLength(0);
  });
});
