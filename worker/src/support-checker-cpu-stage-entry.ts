import { type Clock } from '@pegma/spine';
import {
  runCheckerCpuFixture,
  CHECKER_CPU_QUEUE,
  CheckerCpuFixtureError,
} from './support-checker-cpu-stage';
import {
  CHECKER_CPU_FIXTURE_VERSION,
  CHECKER_CPU_FROZEN,
} from './support-checker-cpu-inputs';

export const CHECKER_CPU_DELIVERIES = Object.freeze([
  Object.freeze({
    body: 'checker-cpu-v1:normal:first-use',
    caseId: 'normal',
    phase: 'first-use',
  }),
  Object.freeze({
    body: 'checker-cpu-v1:normal:warm',
    caseId: 'normal',
    phase: 'warm',
  }),
  Object.freeze({
    body: 'checker-cpu-v1:unsupported:first-use',
    caseId: 'unsupported',
    phase: 'first-use',
  }),
  Object.freeze({
    body: 'checker-cpu-v1:unsupported:warm',
    caseId: 'unsupported',
    phase: 'warm',
  }),
] as const);
export type CheckerCpuObservation = Readonly<Record<string, unknown>>;
interface Options {
  readonly clock?: Clock;
  readonly observe?: (fields: CheckerCpuObservation) => void;
  readonly createIsolateId?: () => string;
}
/** Lifecycle observations only: no cached counts, inputs, results or authority.
 * A newly constructed counter wrapper never establishes a cold tokenizer. */
export function createCheckerCpuStage(options: Options = {}) {
  const seen = new Set<string>();
  const completedFirst = new Set<string>();
  let isolateId: string | undefined;
  let counterEntryRequested = false;
  let counterEntryCounted = false;
  const observe = (fields: CheckerCpuObservation) => {
    try {
      if (options.observe) options.observe(fields);
      else console.info('pegma.synthetic-checker-cpu', fields);
    } catch {
      /* Diagnostics cannot request another delivery. */
    }
  };
  return {
    async queue(batch: MessageBatch<unknown>) {
      if (batch.queue !== CHECKER_CPU_QUEUE || batch.messages.length !== 1) {
        observe({
          fixtureVersion: CHECKER_CPU_FIXTURE_VERSION,
          event: 'refused',
          reason: 'queue-or-batch',
        });
        for (const message of batch.messages) message.ack();
        return;
      }
      const message = batch.messages[0]!;
      const selected = CHECKER_CPU_DELIVERIES.find(
        (item) => item.body === message.body,
      );
      if (!selected || message.attempts !== 1) {
        observe({
          fixtureVersion: CHECKER_CPU_FIXTURE_VERSION,
          event: 'refused',
          reason: 'selector-or-redelivery',
        });
        message.ack();
        return;
      }
      const first = `checker-cpu-v1:${selected.caseId}:first-use`;
      if (
        seen.has(selected.body) ||
        (selected.phase === 'warm' && !completedFirst.has(first))
      ) {
        observe({
          fixtureVersion: CHECKER_CPU_FIXTURE_VERSION,
          event: 'refused',
          reason: 'phase-or-duplicate',
          caseId: selected.caseId,
        });
        message.ack();
        return;
      }
      seen.add(selected.body);
      isolateId ??= options.createIsolateId?.() ?? crypto.randomUUID();
      const sample = {
        fixtureVersion: CHECKER_CPU_FIXTURE_VERSION,
        caseId: selected.caseId,
        requestedPhase: selected.phase,
        isolateId,
        inputSha256: CHECKER_CPU_FROZEN.cases[selected.caseId].inputSha256,
        systemSha256: CHECKER_CPU_FROZEN.systemSha256,
      };
      let counterModuleUse = 'not-requested-in-delivery';
      let counterEntryUse = 'not-counted-in-delivery';
      let counterCalls = 0;
      observe({ ...sample, event: 'start' });
      try {
        const { activity } = await runCheckerCpuFixture(
          selected.caseId,
          options.clock,
          (phase) => {
            if (phase === 'counter-module-request') {
              counterModuleUse = counterEntryRequested
                ? 'previous-request-by-entry'
                : 'first-request-by-entry';
              counterEntryRequested = true;
            } else {
              if (counterCalls === 0) {
                counterEntryUse = counterEntryCounted
                  ? 'previous-count-by-entry'
                  : 'first-count-by-entry';
                counterEntryCounted = true;
              }
              counterCalls++;
            }
          },
        );
        if (selected.phase === 'first-use') completedFirst.add(first);
        observe({
          ...sample,
          event: 'finish',
          outcome: 'fixture-complete',
          counterModuleUse,
          counterEntryUse,
          ...activity,
        });
      } catch (error) {
        // CPU termination may prevent this record too. Retain the platform
        // terminal invocation outcome; never infer completion from a start log.
        observe({
          ...sample,
          event: 'finish',
          outcome: 'held',
          reason:
            error instanceof CheckerCpuFixtureError
              ? error.reason
              : 'sdk-or-runtime',
          counterModuleUse,
          counterEntryUse,
          counterCalls,
        });
      } finally {
        message.ack();
      }
    },
  };
}
export default createCheckerCpuStage() satisfies ExportedHandler;
