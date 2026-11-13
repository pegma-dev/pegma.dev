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
>;
const scalar = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);
const target = z.object({ ticketId: scalar, workId: scalar }).strict();
const checkpoint = z
  .object({
    generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    cursor: z.string().min(1).max(16384).nullable(),
    targets: z.array(target).max(16),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.targets.map((key) => JSON.stringify(key))).size ===
      value.targets.length,
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
