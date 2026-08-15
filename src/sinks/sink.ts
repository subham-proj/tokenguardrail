import type { CostEvent, CostSink, Logger, ModelTotals } from '../types.js';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface EmitOptions {
  /** Extra sinks registered via config. */
  sinks?: CostSink[];
  /** The wrapper's `onCost` callback — treated as one more sink. */
  onCost?: CostSink;
  logger: Logger;
}

/**
 * Fan a CostEvent out to every sink plus `onCost`. Each target runs in its own try/catch so a
 * throwing sink can never break another sink or the underlying LLM call. Awaits async sinks in
 * sequence (order = config.sinks first, then onCost) so callers see a stable ordering.
 */
export async function emitCostEvent(event: CostEvent, options: EmitOptions): Promise<void> {
  const targets: CostSink[] = [...(options.sinks ?? [])];
  if (options.onCost) targets.push(options.onCost);

  for (const sink of targets) {
    try {
      await sink(event);
    } catch (err) {
      options.logger.warn(`tokenguardrail: a cost sink threw (continuing): ${errMessage(err)}`);
    }
  }
}

/** Built-in sink: log a one-line cost summary per event. */
export function consoleSink(logger: Pick<Console, 'info'> = console): CostSink {
  return (event: CostEvent) => {
    const est = event.estimate ? `est $${event.estimate.estimatedCostUsd.toFixed(6)}` : 'est —';
    const act = event.actual ? `actual $${event.actual.actualCostUsd.toFixed(6)}` : 'actual —';
    logger.info(`tokenguardrail [${event.provider}/${event.model}] ${est} | ${act}`);
  };
}

/** A sink that collects events in memory and can total them — handy for tests and aggregation. */
export interface MemorySink extends CostSink {
  readonly events: CostEvent[];
  total(): ModelTotals;
  clear(): void;
}

export function memorySink(): MemorySink {
  const events: CostEvent[] = [];

  const sink = ((event: CostEvent) => {
    events.push(event);
  }) as MemorySink;

  Object.defineProperty(sink, 'events', { get: () => events });

  sink.total = () =>
    events.reduce<ModelTotals>(
      (acc, e) => {
        if (e.actual) acc.calls += 1;
        acc.estimatedCostUsd += e.estimate?.estimatedCostUsd ?? 0;
        acc.actualCostUsd += e.actual?.actualCostUsd ?? 0;
        return acc;
      },
      { calls: 0, estimatedCostUsd: 0, actualCostUsd: 0 }
    );

  sink.clear = () => {
    events.length = 0;
  };

  return sink;
}
