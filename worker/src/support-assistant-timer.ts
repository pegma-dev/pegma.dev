import type { Logger } from '@pegma/spine';
import type { SupportAnsweringComposition } from './support-assistant-composition';
import type { SupportAssistantRun, SupportAssistantTick } from './support-assistant';

export interface SupportAssistantTimerOptions {
  readonly isEnabled: () => boolean;
  readonly load: (signal: AbortSignal) => Promise<SupportAnsweringComposition | undefined>;
  readonly create: (
    configuration: SupportAnsweringComposition,
  ) => { runTick(run?: SupportAssistantRun): Promise<SupportAssistantTick> } | undefined;
  readonly logger: Logger;
}

/** One invocation owns qualification and one runtime stage under the same deadline. */
export async function runSupportAssistantTimer(
  options: SupportAssistantTimerOptions,
): Promise<SupportAssistantTick> {
  function enabled() {
    try {
      return options.isEnabled() === true;
    } catch {
      return false;
    }
  }
  function log(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown>) {
    try {
      options.logger.log(level, event, fields);
    } catch {
      /* Preserve the worker outcome. */
    }
  }
  if (!enabled()) {
    log('info', 'support.answering.tick', { outcome: 'disabled' });
    return { outcome: 'disabled', checkpointSaved: false };
  }
  const started = performance.now();
  const controller = new AbortController();
  const remaining = () => 25_000 - (performance.now() - started);
  let stage: 'qualification' | 'worker' = 'qualification';
  let rejectDeadline: (error: Error) => void = () => {};
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    controller.abort();
    rejectDeadline(new Error('Answering deadline reached.'));
  }, 25_000);
  function current() {
    return enabled() && !controller.signal.aborted && remaining() > 0;
  }
  async function within<T>(operation: () => Promise<T>): Promise<T> {
    if (!current()) throw new Error('Answering is unavailable.');
    const result = await Promise.race([
      Promise.resolve().then(() => {
        if (!current()) throw new Error('Answering is unavailable.');
        return operation();
      }),
      deadline,
    ]);
    if (!current()) throw new Error('Answering is unavailable.');
    return result;
  }
  try {
    const configuration = await within(() => options.load(controller.signal));
    if (configuration === undefined) throw new Error('Answering qualification unavailable.');
    // Creation stays synchronous after the post-load gate. A late credential
    // response can finish qualification but cannot start a later worker.
    if (!current()) throw new Error('Answering is unavailable.');
    stage = 'worker';
    const runtime = options.create(configuration);
    if (runtime === undefined) throw new Error('Answering worker unavailable.');
    const result = await within(() =>
      runtime.runTick({
        signal: controller.signal,
        budgetMilliseconds: Math.max(1, Math.floor(remaining())),
      }),
    );
    log(result.outcome === 'unavailable' ? 'warn' : 'info', 'support.answering.tick', {
      outcome: result.outcome,
      checkpointSaved: result.checkpointSaved,
    });
    return result;
  } catch {
    log('error', 'support.answering.failed', {
      stage,
      reason: controller.signal.aborted || remaining() <= 0 ? 'deadline' : 'unavailable',
    });
    return { outcome: 'unavailable', checkpointSaved: false };
  } finally {
    clearTimeout(timer);
  }
}
