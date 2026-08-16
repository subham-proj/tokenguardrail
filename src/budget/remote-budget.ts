import type { BudgetConfig, Logger, RemoteSinkConfig } from '../types.js';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Minimal fetch surface (mirrors sinks/remote.ts) so tests can inject a fake. */
type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string> }
) => Promise<{ ok: boolean; status: number; json?: () => Promise<unknown> }>;

const DEFAULT_BUDGET_PATH = '/v1/budget';

/** The account's server-side budget plus the spend already recorded for it. */
export interface RemoteBudget {
  /** The configured cap, or null when none is set. */
  budget: BudgetConfig | null;
  /** Actual cost accumulated so far (USD) — seeds the cumulative tracker. */
  spentUsd: number;
}

/** Trim a trailing slash so `baseUrl + path` never doubles up. */
function joinUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, '') + path;
}

/**
 * Fetch the account's cumulative spend budget (and spend-so-far) from a tokenguardrail server so
 * the wrapper can enforce it before each call — the server-configured counterpart to a
 * locally-passed `budget`.
 *
 * `GET {baseUrl}{budgetPath}` with `Authorization: Bearer {apiKey}`; reads the `{ budget, spentUsd }`
 * envelope. **Fail-open**: any missing config, network error, non-2xx, or unparseable body yields
 * `{ budget: null, spentUsd: 0 }` — a budget-service hiccup must never break a call (nor silently
 * block it).
 */
export async function fetchRemoteBudget(
  config: RemoteSinkConfig,
  logger: Logger = console
): Promise<RemoteBudget> {
  const empty: RemoteBudget = { budget: null, spentUsd: 0 };
  if (!config?.apiKey || !config?.baseUrl) return empty;

  const url = joinUrl(config.baseUrl, config.budgetPath ?? DEFAULT_BUDGET_PATH);
  const doFetch = (config.fetch as FetchLike | undefined) ?? (globalThis.fetch as FetchLike | undefined);
  if (!doFetch) return empty;

  try {
    const res = await doFetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${config.apiKey}` },
    });
    if (!res.ok) {
      logger.warn(`tokenguardrail: budget fetch got HTTP ${res.status} from ${url} (continuing without a remote budget)`);
      return empty;
    }
    const body = (res.json ? await res.json() : null) as { budget?: BudgetConfig | null; spentUsd?: number } | null;
    return { budget: body?.budget ?? null, spentUsd: Number(body?.spentUsd) || 0 };
  } catch (err) {
    logger.warn(`tokenguardrail: budget fetch failed for ${url} (continuing without a remote budget): ${errMessage(err)}`);
    return empty;
  }
}
