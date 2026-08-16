import { describe, expect, it, vi } from 'vitest';
import { createRemoteSink } from '../src/sinks/remote.js';
import { resolveConfig } from '../src/config.js';
import type { CostEvent } from '../src/types.js';

function sampleEvent(overrides: Partial<CostEvent> = {}): CostEvent {
  return {
    provider: 'groq',
    model: 'llama-3.1-8b-instant',
    estimate: {
      model: 'llama-3.1-8b-instant',
      inputTokens: 10,
      assumedOutputTokens: 100,
      estimatedCostUsd: 0.001,
      pricingSource: 'exact',
      pricingUpdatedAt: '2026-08-03',
    },
    actual: {
      model: 'llama-3.1-8b-instant',
      inputTokens: 10,
      outputTokens: 20,
      cachedInputTokens: 0,
      actualCostUsd: 0.0002,
      pricingSource: 'exact',
    },
    ...overrides,
  };
}

const silentLogger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };

function okFetch() {
  return vi.fn(async () => ({ ok: true, status: 201 }));
}

describe('createRemoteSink', () => {
  it('POSTs the event to {baseUrl}/v1/ingest with a bearer API key and JSON body', async () => {
    const fetch = okFetch();
    const sink = createRemoteSink({ apiKey: 'tgr_live_abc', baseUrl: 'http://localhost:3000', fetch }, silentLogger);

    const event = sampleEvent();
    await sink(event);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('http://localhost:3000/v1/ingest');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer tgr_live_abc');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual(event);
  });

  it('trims a trailing slash on baseUrl and honours a custom ingestPath', async () => {
    const fetch = okFetch();
    const sink = createRemoteSink(
      { apiKey: 'k', baseUrl: 'http://h:3000/', ingestPath: '/v2/ingest', fetch },
      silentLogger
    );
    await sink(sampleEvent());
    expect(fetch.mock.calls[0][0]).toBe('http://h:3000/v2/ingest');
  });

  it('is fail-open on a network error (never throws)', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    const sink = createRemoteSink({ apiKey: 'k', baseUrl: 'http://h', fetch }, logger);

    await expect(sink(sampleEvent())).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toContain('remote sink failed');
  });

  it('is fail-open on a non-2xx response (warns, does not throw)', async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 401, text: async () => 'Invalid or expired token' }));
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    const sink = createRemoteSink({ apiKey: 'k', baseUrl: 'http://h', fetch }, logger);

    await expect(sink(sampleEvent())).resolves.toBeUndefined();
    expect(String(logger.warn.mock.calls[0][0])).toContain('HTTP 401');
  });

  it('requires apiKey and baseUrl', () => {
    // @ts-expect-error missing apiKey
    expect(() => createRemoteSink({ baseUrl: 'http://h' })).toThrow(/apiKey/);
    // @ts-expect-error missing baseUrl
    expect(() => createRemoteSink({ apiKey: 'k' })).toThrow(/baseUrl/);
  });
});

describe('resolveConfig — tokenguardrail convenience option', () => {
  it('auto-installs a remote sink when tokenguardrail.apiKey is set', async () => {
    const fetch = okFetch();
    const resolved = resolveConfig({
      logger: silentLogger,
      tokenguardrail: { apiKey: 'tgr_live_xyz', baseUrl: 'http://localhost:3000', fetch },
    });

    expect(resolved.sinks).toHaveLength(1);
    await resolved.sinks[0](sampleEvent());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('http://localhost:3000/v1/ingest');
  });

  it('appends the remote sink after any explicit sinks', () => {
    const explicit = vi.fn();
    const resolved = resolveConfig({
      logger: silentLogger,
      sinks: [explicit],
      tokenguardrail: { apiKey: 'k', baseUrl: 'http://h', fetch: okFetch() },
    });
    expect(resolved.sinks).toHaveLength(2);
    expect(resolved.sinks[0]).toBe(explicit);
  });

  it('installs nothing when tokenguardrail is absent', () => {
    expect(resolveConfig({ logger: silentLogger }).sinks).toHaveLength(0);
  });
});
