import type { CountInput, NormalizedUsage } from '../types.js';
import { heuristicCountTokens } from '../tokens/heuristic.js';
import type { ProviderAdapter } from './provider.js';

interface OpenAIUsageShape {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

type TiktokenEncoding = 'o200k_base' | 'cl100k_base';
type TiktokenEncoder = { encode(text: string): number[] };
type TiktokenModule = { getEncoding(encoding: TiktokenEncoding): TiktokenEncoder };

// Lazy-loaded so the (large) BPE ranks land in the bundle only for callers who use exact
// estimate mode; costFromUsage-only consumers never pay for it (see plan §4.4).
let tiktokenModulePromise: Promise<TiktokenModule | null> | null = null;

async function loadTiktoken(): Promise<TiktokenModule | null> {
  if (!tiktokenModulePromise) {
    tiktokenModulePromise = import('js-tiktoken').then(
      (mod) => mod as unknown as TiktokenModule,
      () => null // optional dependency not installed — fall back to the heuristic
    );
  }
  return tiktokenModulePromise;
}

// Encoders are cached module-wide; js-tiktoken is pure JS, so no free()/cleanup is needed.
const encoderCache = new Map<TiktokenEncoding, TiktokenEncoder>();

function encodingForModel(model: string): TiktokenEncoding {
  const m = model.toLowerCase();
  if (
    m.startsWith('gpt-4o') ||
    m.startsWith('gpt-4.1') ||
    m.startsWith('gpt-5') ||
    m.startsWith('o1') ||
    m.startsWith('o3') ||
    m.startsWith('o4')
  ) {
    return 'o200k_base';
  }
  return 'cl100k_base';
}

async function getEncoder(model: string): Promise<TiktokenEncoder | null> {
  const tiktoken = await loadTiktoken();
  if (!tiktoken) return null;

  const encoding = encodingForModel(model);
  const cached = encoderCache.get(encoding);
  if (cached) return cached;

  const encoder = tiktoken.getEncoding(encoding);
  encoderCache.set(encoding, encoder);
  return encoder;
}

/**
 * Exact token count following the OpenAI cookbook formula: per-message overhead, per-name
 * overhead, tool/function-schema counting, and reply priming.
 * https://github.com/openai/openai-cookbook/blob/main/examples/How_to_count_tokens_with_tiktoken.ipynb
 */
function countExact(encoder: TiktokenEncoder, input: CountInput): number {
  const TOKENS_PER_MESSAGE = 3;
  const TOKENS_PER_NAME = 1;
  let tokens = 0;

  if (input.system) {
    tokens += TOKENS_PER_MESSAGE + encoder.encode(input.system).length;
  }

  for (const message of input.messages) {
    tokens += TOKENS_PER_MESSAGE;
    tokens += encoder.encode(message.role).length;
    tokens += encoder.encode(message.content).length;
    if (message.name) {
      tokens += encoder.encode(message.name).length + TOKENS_PER_NAME;
    }
  }

  if (input.tools && input.tools.length > 0) {
    tokens += 9; // base overhead for a tools array
    for (const tool of input.tools) {
      tokens += encoder.encode(tool.name).length;
      if (tool.description) tokens += encoder.encode(tool.description).length;
      if (tool.parameters) tokens += encoder.encode(JSON.stringify(tool.parameters)).length;
      tokens += 7; // per-tool overhead
    }
  }

  tokens += 3; // every reply is primed with <|start|>assistant<|message|>
  return tokens;
}

export const openaiProvider: ProviderAdapter = {
  id: 'openai',

  detect(client) {
    if (!client || typeof client !== 'object') return false;
    const chat = (client as Record<string, unknown>)['chat'];
    if (!chat || typeof chat !== 'object') return false;
    const completions = (chat as Record<string, unknown>)['completions'];
    return !!completions && typeof (completions as Record<string, unknown>)['create'] === 'function';
  },

  async countInputTokens(input) {
    const encoder = await getEncoder(input.model);
    if (!encoder) return heuristicCountTokens(input);
    return countExact(encoder, input);
  },

  normalizeUsage(raw): NormalizedUsage {
    const usage = (raw ?? {}) as OpenAIUsageShape;
    return {
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
      cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
      cacheWriteTokens: 0, // OpenAI's automatic caching has no explicit write charge
    };
  },

  resolvePricingKey(model) {
    const m = model.toLowerCase();
    // Most-specific first: every "-mini"/"-nano"/"-pro"/dotted-minor variant must be
    // checked before its bare family prefix, or the bare check would swallow it
    // (e.g. "gpt-5.6-sol".startsWith("gpt-5") is true, so bare "gpt-5" must be last).
    if (m.startsWith('gpt-4o-mini')) return 'gpt-4o-mini';
    if (m.startsWith('gpt-4o')) return 'gpt-4o';
    if (m.startsWith('gpt-4.1-mini')) return 'gpt-4.1-mini';
    if (m.startsWith('gpt-4.1-nano')) return 'gpt-4.1-nano';
    if (m.startsWith('gpt-4.1')) return 'gpt-4.1';
    if (m.startsWith('gpt-5.6-sol')) return 'gpt-5.6-sol';
    if (m.startsWith('gpt-5.6-terra')) return 'gpt-5.6-terra';
    if (m.startsWith('gpt-5.6-luna')) return 'gpt-5.6-luna';
    if (m.startsWith('gpt-5.5-pro')) return 'gpt-5.5-pro';
    if (m.startsWith('gpt-5.5')) return 'gpt-5.5';
    if (m.startsWith('gpt-5.4-mini')) return 'gpt-5.4-mini';
    if (m.startsWith('gpt-5.4-nano')) return 'gpt-5.4-nano';
    if (m.startsWith('gpt-5.4-pro')) return 'gpt-5.4-pro';
    if (m.startsWith('gpt-5.4')) return 'gpt-5.4';
    if (m.startsWith('gpt-5.2-pro')) return 'gpt-5.2-pro';
    if (m.startsWith('gpt-5.2')) return 'gpt-5.2';
    if (m.startsWith('gpt-5.1')) return 'gpt-5.1';
    if (m.startsWith('gpt-5-mini')) return 'gpt-5-mini';
    if (m.startsWith('gpt-5-nano')) return 'gpt-5-nano';
    if (m.startsWith('gpt-5-pro')) return 'gpt-5-pro';
    if (m.startsWith('gpt-5')) return 'gpt-5';
    if (m.startsWith('o1-mini')) return 'o1-mini';
    if (m.startsWith('o1-pro')) return 'o1-pro';
    if (m.startsWith('o1')) return 'o1';
    if (m.startsWith('o3-mini')) return 'o3-mini';
    if (m.startsWith('o3-pro')) return 'o3-pro';
    if (m.startsWith('o3')) return 'o3';
    if (m.startsWith('o4-mini')) return 'o4-mini';
    if (m.startsWith('gpt-4-turbo')) return 'gpt-4-turbo';
    if (m.startsWith('gpt-4')) return 'gpt-4';
    if (m.startsWith('gpt-3.5-turbo')) return 'gpt-3.5-turbo';
    return model;
  },
};
