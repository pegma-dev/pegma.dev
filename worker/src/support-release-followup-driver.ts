import { defineCollection, type Store } from '@pegma/storage-core';
import type { Clock } from '@pegma/spine';
import { z } from 'zod';
import type { SupportReleaseFollowupRuntime } from './support-release-followup';

/** Reuses existing cleanup slots every fifteen minutes. Finite per-Work queue
 * continuations remain independent of this idle discovery cadence. */
export function supportReleaseFollowupWakeDue(scheduledTime: number) {
  return (
    Number.isFinite(scheduledTime) &&
    scheduledTime >= 0 &&
    new Date(scheduledTime).getUTCMinutes() % 15 === 0
  );
}

type Runtime = Pick<
  SupportReleaseFollowupRuntime,
  'scanProcessing' | 'process'
> &
  Partial<
    Pick<SupportReleaseFollowupRuntime, 'scanChecks' | 'precomputeChecks'>
  >;
const scalar = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);
const MAX_CONTINUATIONS = 8;
const remainingInvocations = z.number().int().min(0).max(MAX_CONTINUATIONS);
const workTarget = z
  .object({
    ticketId: scalar,
    workId: scalar,
    remainingInvocations: remainingInvocations.optional(),
  })
  .strict();
const checkTarget = z
  .object({
    kind: z.literal('checks'),
    ticketId: scalar,
    workId: scalar,
    operationId: scalar,
    expiresAt: z.string().datetime({ precision: 3 }),
    remainingInvocations: remainingInvocations.optional(),
  })
  .strict();
const target = z.union([workTarget, checkTarget]);
type Target = z.infer<typeof target>;
const targetIdentity = (value: Target) =>
  JSON.stringify([
    'kind' in value ? value.kind : 'work',
    value.ticketId,
    value.workId,
    'operationId' in value ? value.operationId : null,
  ]);
const checkpoint = z
  .object({
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    cursor: z.string().min(1).max(16384).nullable(),
    targets: z.array(target).max(16),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.targets.map(targetIdentity)).size === value.targets.length,
  );
type Checkpoint = z.infer<typeof checkpoint>;
const KEY = Object.freeze({ partition: 'release-followup', id: 'cursor' });
export const supportReleaseFollowupCheckpoints = defineCollection<Checkpoint>({
  name: 'pegma.support-release-followup-driver.v1',
  key: () => KEY,
  codec: {
    encode(value) {
      const payload = JSON.stringify(checkpoint.parse(value));
      if (new TextEncoder().encode(payload).length > 24000)
        throw new TypeError('Follow-up checkpoint exceeded');
      return { format: 1, payload };
    },
    decode(row) {
      if (
        Object.keys(row).sort().join(',') !== 'format,payload' ||
        row.format !== 1 ||
        typeof row.payload !== 'string' ||
        new TextEncoder().encode(row.payload).length > 24000
      )
        throw new TypeError('Invalid follow-up checkpoint');
      return checkpoint.parse(JSON.parse(row.payload));
    },
  },
});
export interface SupportReleaseFollowupDriverOptions {
  readonly store: Store;
  readonly clock: Clock;
  readonly enabled: () => boolean;
  readonly invocationMode?: 'staged';
  readonly runtime: (current: () => boolean) => Runtime | undefined;
}
export type SupportReleaseFollowupDriverResult =
  | {
      readonly outcome: 'disabled' | 'unavailable' | 'contended';
      readonly checkpointSaved: boolean;
    }
  | {
      readonly outcome: 'scanned';
      readonly physicalRows: number;
      readonly selected: boolean;
      readonly checkpointSaved: true;
    }
  | {
      readonly outcome: 'work';
      readonly result: Awaited<ReturnType<Runtime['process']>>;
      readonly remainingTargets: number;
      readonly checkpointSaved: true;
    }
  | {
      readonly outcome: 'settled';
      readonly remainingTargets: number;
      readonly checkpointSaved: true;
    }
  | {
      readonly outcome: 'checks_scanned';
      readonly hints: number;
      readonly selected: boolean;
      readonly checkpointSaved: true;
    }
  | {
      readonly outcome: 'checks';
      readonly result: Awaited<
        ReturnType<NonNullable<Runtime['precomputeChecks']>>
      >;
      readonly remainingTargets: number;
      readonly checkpointSaved: true;
    };

/** One discovery OR one SDK stage per physical invocation. The cursor is an
 * advisory hint; current SDK authority, claims and accounting own all work. */
export function createSupportReleaseFollowupDriver(
  options: SupportReleaseFollowupDriverOptions,
) {
  return Object.freeze({
    async runTick(
      run: { readonly signal?: AbortSignal } = {},
    ): Promise<SupportReleaseFollowupDriverResult> {
      const started = performance.now();
      const controller = new AbortController();
      const abort = () => controller.abort();
      run.signal?.addEventListener('abort', abort, { once: true });
      if (run.signal?.aborted) abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let saved = false;
      const current = () => {
        try {
          const now = options.clock.now();
          return (
            options.enabled() === true &&
            !controller.signal.aborted &&
            performance.now() - started < 25000 &&
            Number.isFinite(Date.parse(now)) &&
            new Date(now).toISOString() === now
          );
        } catch {
          return false;
        }
      };
      if (!current()) {
        run.signal?.removeEventListener('abort', abort);
        return { outcome: 'disabled', checkpointSaved: false };
      }
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort();
          reject(new Error('Follow-up tick expired'));
        }, 25000);
      });
      const within = async <Value>(work: () => Promise<Value>) => {
        if (!current()) throw new Error('Follow-up tick unavailable');
        const value = await Promise.race([
          Promise.resolve().then(work),
          deadline,
        ]);
        if (!current()) throw new Error('Follow-up tick unavailable');
        return value;
      };
      try {
        const runtime = options.runtime(current);
        if (!runtime) return { outcome: 'unavailable', checkpointSaved: false };
        const records = options.store.collection(
          supportReleaseFollowupCheckpoints,
        );
        const observed = await within(() => records.getVersioned(KEY));
        const prior = observed?.value ?? {
          generation: 0,
          cursor: null,
          targets: [],
        };
        if (prior.generation === Number.MAX_SAFE_INTEGER)
          return { outcome: 'unavailable', checkpointSaved: false };
        const save = (next: Checkpoint) =>
          observed === null
            ? records.insertIfAbsent(next).then((result) => result.inserted)
            : records.putIfUnchanged(next, observed.version);
        if (prior.targets.length > 0) {
          const selected = prior.targets[0]!;
          const remaining = prior.targets.slice(1);
          if (options.invocationMode === 'staged') {
            const count = selected.remainingInvocations ?? MAX_CONTINUATIONS;
            if (
              count === 0 ||
              ('kind' in selected && !runtime.precomputeChecks)
            ) {
              saved = await within(() =>
                save({
                  generation: prior.generation + 1,
                  cursor: prior.cursor,
                  targets: remaining,
                }),
              );
              return saved
                ? {
                    outcome: 'settled',
                    remainingTargets: remaining.length,
                    checkpointSaved: true,
                  }
                : { outcome: 'contended', checkpointSaved: false };
            }
            const retained = target.parse({
              ...selected,
              remainingInvocations: count - 1,
            });
            const retainedGeneration = prior.generation + 1;
            // Every possible paid phase has a durable body-free continuation
            // first, including when the SDK's planning ACK is lost.
            saved = await within(() =>
              save({
                generation: retainedGeneration,
                cursor: prior.cursor,
                targets: [retained, ...remaining],
              }),
            );
            if (!saved) return { outcome: 'contended', checkpointSaved: false };

            // Use only for an SDK-guaranteed nonprovider result. A concurrent
            // consumer may have advanced the hint while the SDK was awaiting.
            async function rewriteNonpaid(next?: Target) {
              const currentHead = await within(() => records.getVersioned(KEY));
              if (
                !currentHead ||
                currentHead.value.generation !== retainedGeneration ||
                JSON.stringify(currentHead.value.targets[0]) !==
                  JSON.stringify(retained)
              )
                return null;
              const rest = currentHead.value.targets.slice(1);
              const targets =
                next === undefined
                  ? rest
                  : [
                      next,
                      ...rest.filter(
                        (value) =>
                          targetIdentity(value) !== targetIdentity(next),
                      ),
                    ];
              const accepted = await within(() =>
                records.putIfUnchanged(
                  checkpoint.parse({
                    generation: retainedGeneration + 1,
                    cursor: currentHead.value.cursor,
                    targets,
                  }),
                  currentHead.version,
                ),
              );
              return accepted ? targets.length : null;
            }
            if ('kind' in selected) {
              const result =
                Date.parse(selected.expiresAt) <=
                Date.parse(options.clock.now())
                  ? { outcome: 'held' as const }
                  : await within(() =>
                      runtime.precomputeChecks!(
                        selected,
                        controller.signal,
                        current,
                      ),
                    );
              if (result.outcome === 'checked') {
                // checked is a later receipt-only phase. A received verdict is
                // never used as a receipt or as evidence that this phase is free.
                const left = await rewriteNonpaid(
                  workTarget.parse({
                    ticketId: selected.ticketId,
                    workId: selected.workId,
                    remainingInvocations: MAX_CONTINUATIONS,
                  }),
                );
                if (left === null)
                  return { outcome: 'contended', checkpointSaved: true };
                return {
                  outcome: 'checks',
                  result,
                  remainingTargets: left,
                  checkpointSaved: true,
                };
              }
              return {
                outcome: 'checks',
                result,
                remainingTargets: remaining.length + 1,
                checkpointSaved: true,
              };
            }
            const result = await within(() =>
              runtime.process(
                {
                  ticketId: selected.ticketId,
                  workId: selected.workId,
                  workerId: 'pegma.dev-release-followup-worker',
                  leaseMilliseconds: 30000,
                },
                controller.signal,
              ),
            );
            if (result.outcome === 'not_claimed') {
              const left = await rewriteNonpaid();
              if (left === null)
                return { outcome: 'contended', checkpointSaved: true };
              return {
                outcome: 'work',
                result,
                remainingTargets: left,
                checkpointSaved: true,
              };
            }
            if (
              result.outcome === 'pending' &&
              (result.checkpoint === 'checks_planned' ||
                result.checkpoint === 'checks_recorded') &&
              result.checks !== undefined
            ) {
              const left = await rewriteNonpaid(
                checkTarget.parse({
                  kind: 'checks',
                  ticketId: selected.ticketId,
                  workId: selected.workId,
                  operationId: result.checks.operationId,
                  expiresAt: result.checks.expiresAt,
                  remainingInvocations: MAX_CONTINUATIONS,
                }),
              );
              if (left === null)
                return { outcome: 'contended', checkpointSaved: true };
              return {
                outcome: 'work',
                result,
                remainingTargets: left,
                checkpointSaved: true,
              };
            }
            // Paid/unknown outcomes leave the prewritten continuation intact.
            return {
              outcome: 'work',
              result,
              remainingTargets: remaining.length + 1,
              checkpointSaved: true,
            };
          }
          if ('kind' in selected) {
            // A legacy composition cannot execute a deferred check operation.
            saved = await within(() =>
              save({
                generation: prior.generation + 1,
                cursor: prior.cursor,
                targets: remaining,
              }),
            );
            return saved
              ? {
                  outcome: 'settled',
                  remainingTargets: remaining.length,
                  checkpointSaved: true,
                }
              : { outcome: 'contended', checkpointSaved: false };
          }
          saved = await within(() =>
            save({
              generation: prior.generation + 1,
              cursor: prior.cursor,
              targets: remaining,
            }),
          );
          if (!saved) return { outcome: 'contended', checkpointSaved: false };
          // Pop before the stage. No cursor write follows a paid/unknown call;
          // actual pending/candidate SDK state is rediscovered on the next scan.
          const result = await within(() =>
            runtime.process(
              {
                ...selected,
                workerId: 'pegma.dev-release-followup-worker',
                leaseMilliseconds: 30000,
              },
              controller.signal,
            ),
          );
          return {
            outcome: 'work',
            result,
            remainingTargets: remaining.length,
            checkpointSaved: true,
          };
        }
        if (options.invocationMode === 'staged' && runtime.scanChecks) {
          const pending = await within(() =>
            runtime.scanChecks!(controller.signal),
          );
          const targets = [
            ...new Map(
              pending
                .filter(
                  (value) =>
                    value.mode === 'work' &&
                    Date.parse(value.expiresAt) >
                      Date.parse(options.clock.now()),
                )
                .slice(0, 16)
                .map((value) => {
                  const parsed = checkTarget.parse({
                    kind: 'checks',
                    ...value.scope,
                    operationId: value.operationId,
                    expiresAt: value.expiresAt,
                    remainingInvocations: MAX_CONTINUATIONS,
                  });
                  return [targetIdentity(parsed), parsed] as const;
                }),
            ).values(),
          ];
          if (targets.length > 0) {
            saved = await within(() =>
              save(
                checkpoint.parse({
                  generation: prior.generation + 1,
                  cursor: prior.cursor,
                  targets,
                }),
              ),
            );
            return saved
              ? {
                  outcome: 'checks_scanned',
                  hints: targets.length,
                  selected: true,
                  checkpointSaved: true,
                }
              : { outcome: 'contended', checkpointSaved: false };
          }
        }
        const page = await within(() =>
          runtime.scanProcessing({
            limit: 16,
            ...(prior.cursor === null ? {} : { cursor: prior.cursor }),
          }),
        );
        const targets = [
          ...new Map(
            page.candidates.map((value) => [
              JSON.stringify({
                ticketId: value.ticketId,
                workId: value.workId,
              }),
              target.parse({ ticketId: value.ticketId, workId: value.workId }),
            ]),
          ).values(),
        ];
        if (targets.length > 16) throw new TypeError('Follow-up scan exceeded');
        const next = checkpoint.parse({
          generation: prior.generation + 1,
          cursor: page.nextCursor,
          targets,
        });
        saved = await within(() => save(next));
        if (!saved) return { outcome: 'contended', checkpointSaved: false };
        return {
          outcome: 'scanned',
          physicalRows: page.physicalRows,
          selected: targets.length > 0 || page.nextCursor !== null,
          checkpointSaved: true,
        };
      } catch {
        return { outcome: 'unavailable', checkpointSaved: saved };
      } finally {
        clearTimeout(timer);
        abort();
        run.signal?.removeEventListener('abort', abort);
      }
    },
  });
}
