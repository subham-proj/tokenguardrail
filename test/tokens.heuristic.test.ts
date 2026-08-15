import { describe, expect, it } from 'vitest';
import { heuristicCountTokens } from '../src/tokens/heuristic.js';

describe('heuristicCountTokens', () => {
  it('scales roughly with text length', () => {
    const short = heuristicCountTokens({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const long = heuristicCountTokens({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'hi '.repeat(1000) }],
    });
    expect(long).toBeGreaterThan(short);
  });

  it('adds overhead for system prompt and tool schemas', () => {
    const base = heuristicCountTokens({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'hello' }],
    });
    const withExtras = heuristicCountTokens({
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'hello' }],
      system: 'You are a helpful assistant.',
      tools: [{ name: 'search', description: 'search the web' }],
    });
    expect(withExtras).toBeGreaterThan(base);
  });
});
