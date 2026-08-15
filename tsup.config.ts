import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  // Peer + optional deps must stay external, not inlined: js-tiktoken is dynamically
  // imported so its BPE ranks only load for callers who use exact estimate mode (§4.4) —
  // inlining it here would bundle it into every consumer's build regardless of use.
  external: ['js-tiktoken', 'openai', '@anthropic-ai/sdk'],
});
