import type { CostEvent, CostSink, Logger, RemoteSinkConfig } from '../types.js';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Minimal fetch surface we depend on — lets tests inject a fake without pulling DOM types. */
type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ ok: boolean; status: number; text?: () => Promise<string> }>;

const DEFAULT_INGEST_PATH = '/v1/ingest';

/** Trim a trailing slash so `baseUrl + path` never doubles up (`http://h//v1/ingest`). */
function joinUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, '') + path;
}

/**
 * Built-in sink that ships each CostEvent to a tokenguardrail server's ingestion endpoint,
 * authenticated with the account's API key. This is the batteries-included counterpart to the
 * hand-written `onCost` seam: the consumer passes only `{ apiKey, baseUrl }` and events flow to
 * `POST {baseUrl}/v1/ingest`.
 *
 * Fail-open by design (like every sink): a network error or non-2xx response is logged and
 * swallowed so it can never break the underlying LLM call. Delivery is per-event (the server's
 * ingest endpoint accepts a single CostEvent); batching can be layered on later.
 *
 * Wired automatically when a config carries `tokenguardrail: { apiKey, baseUrl }` (see config.ts),
 * so both `createTokenguard(...)` and `tokenguard(client, ...)` pick it up. Can also be used
 * directly via `sinks: [createRemoteSink(...)]` / `onCost`.
 */
export function createRemoteSink(config: RemoteSinkConfig, logger: Logger = console): CostSink {
  const { apiKey, baseUrl } = config;
  if (!apiKey) throw new Error('createRemoteSink: `apiKey` is required.');
  if (!baseUrl) throw new Error('createRemoteSink: `baseUrl` is required.');

  const url = joinUrl(baseUrl, config.ingestPath ?? DEFAULT_INGEST_PATH);
  const doFetch = (config.fetch as FetchLike | undefined) ?? (globalThis.fetch as FetchLike | undefined);

  if (!doFetch) {
    throw new Error(
      'createRemoteSink: no global fetch available. Use Node >= 18 or pass a `fetch` implementation.'
    );
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
    ...config.headers,
  };

  return async function remoteSink(event: CostEvent): Promise<void> {
    try {
      const res = await doFetch(url, { method: 'POST', headers, body: JSON.stringify(event) });
      if (!res.ok) {
        const detail = res.text ? `: ${(await res.text().catch(() => '')).slice(0, 200)}` : '';
        logger.warn(`tokenguardrail: remote sink got HTTP ${res.status} from ${url} (continuing)${detail}`);
      }
    } catch (err) {
      logger.warn(`tokenguardrail: remote sink failed to POST to ${url} (continuing): ${errMessage(err)}`);
    }
  };
}
