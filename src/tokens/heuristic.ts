import type { CountInput } from '../types.js';

const CHARS_PER_TOKEN = 4;
const TOOL_OVERHEAD_TOKENS = 10;

function approximateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Zero-dependency char-ratio token counter. Shared fallback used as the default estimate
 * mode for every provider, and as OpenAI's fallback when the exact tokenizer isn't available.
 * Approximate by design — "guidance, not a guarantee" (see docs/implementation-plan.md §8).
 */
export function heuristicCountTokens(input: CountInput, overheadPerMessage = 4): number {
  let tokens = 0;

  if (input.system) {
    tokens += approximateTokens(input.system) + overheadPerMessage;
  }

  for (const message of input.messages) {
    tokens += approximateTokens(message.content) + overheadPerMessage;
    if (message.name) {
      tokens += approximateTokens(message.name) + 1;
    }
  }

  if (input.tools) {
    for (const tool of input.tools) {
      tokens += approximateTokens(tool.name);
      if (tool.description) tokens += approximateTokens(tool.description);
      if (tool.parameters) tokens += approximateTokens(JSON.stringify(tool.parameters));
      tokens += TOOL_OVERHEAD_TOKENS;
    }
  }

  return tokens;
}
