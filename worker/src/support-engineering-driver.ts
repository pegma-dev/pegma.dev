import { defineCollection, type Store } from '@pegma/storage-core';
import type { Clock } from '@pegma/spine';
import type {
  SupportEngineeringRuntime,
  SupportEngineeringDeferredCheckHint,
  SupportEngineeringPrecomputeResult,
} from './support-engineering';

type Runtime = Pick<
  SupportEngineeringRuntime,
  'scanCandidates' | 'processWork' | 'reconcileSource'
> & {
  readonly precomputeChecks?: (
    hint: SupportEngineeringDeferredCheckHint,
    run?: { readonly signal?: AbortSignal },
  ) => Promise<SupportEngineeringPrecomputeResult>;
};
type Target =
  | {
      readonly kind: 'work';
      readonly ticketId: string;
      readonly sourceGeneration: number;
    }
  | { readonly kind: 'reconciliation'; readonly ticketId: string }
  | SupportEngineeringDeferredCheckHint;
interface Checkpoint {
  readonly generation: number;
  readonly cursor: string | null;
  readonly targets: readonly Target[];
}
export interface SupportEngineeringDriverOptions {
  readonly store: Store;
  readonly clock: Clock;
  readonly isEnabled?: () => boolean;
  /** Bind current() into the real composition's enablement. It grants no authority. */
  readonly runtime?: (current: () => boolean) => Runtime | undefined;
}
export type SupportEngineeringDriverResult =
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
      readonly remainingTargets: number;
      readonly result: Awaited<ReturnType<Runtime['processWork']>>;
      readonly checkpointSaved: true;
    }
  | {
      readonly outcome: 'checks';
      readonly remainingTargets: number;
      readonly result: SupportEngineeringPrecomputeResult;
      readonly checkpointSaved: true;
    }
  | {
      readonly outcome: 'reconciliation';
      readonly remainingTargets: number;
      readonly result: Awaited<ReturnType<Runtime['reconcileSource']>>;
      readonly checkpointSaved: true;
    };

const KEY = Object.freeze({ partition: 'engineering', id: 'cursor' });
const MAX_CURSOR_BYTES = 16_384;
const DISCOVERY_ROWS = 32;
const MAX_RECORD_BYTES = 40_000;
const TICK_MILLISECONDS = 25_000;
const encoder = new TextEncoder();
const workerId = 'pegma.dev-engineering-worker';
const text = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 200 &&
  !/[\u0000-\u001F\u007F]/u.test(value);
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fields(value: Record<string, unknown>, names: readonly string[]) {
  if (
    Object.keys(value).length !== names.length ||
    names.some((name) => !Object.hasOwn(value, name))
  )
    throw new TypeError('Invalid engineering driver checkpoint');
}
function cursor(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' &&
      value.length > 0 &&
      encoder.encode(value).byteLength <= MAX_CURSOR_BYTES &&
      !/[\u0000-\u001F\u007F]/u.test(value))
  );
}
function target(value: unknown): Target {
  if (!object(value) || !text(value.ticketId))
    throw new TypeError('Invalid engineering target hint');
  if (value.kind === 'reconciliation') {
    fields(value, ['kind', 'ticketId']);
    return { kind: 'reconciliation', ticketId: value.ticketId };
  }
  fields(
    value,
    value.kind === 'checks'
      ? ['kind', 'operationId', 'ticketId', 'sourceGeneration', 'expiresAt']
      : ['kind', 'ticketId', 'sourceGeneration'],
  );
  if (
    (value.kind !== 'work' && value.kind !== 'checks') ||
    typeof value.sourceGeneration !== 'number' ||
    !Number.isSafeInteger(value.sourceGeneration) ||
    value.sourceGeneration < 1
  )
    throw new TypeError('Invalid engineering target hint');
  if (value.kind === 'checks') {
    if (
      typeof value.operationId !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(value.operationId) ||
      typeof value.expiresAt !== 'string' ||
      value.expiresAt.length !== 24 ||
      !Number.isFinite(Date.parse(value.expiresAt)) ||
      new Date(value.expiresAt).toISOString() !== value.expiresAt
    )
      throw new TypeError('Invalid deferred engineering check hint');
    return {
      kind: 'checks',
      operationId: value.operationId,
      ticketId: value.ticketId,
      sourceGeneration: value.sourceGeneration,
      expiresAt: value.expiresAt,
    };
  }
  return {
    kind: 'work',
    ticketId: value.ticketId,
    sourceGeneration: value.sourceGeneration,
  };
}
const targetIdentity = (value: Target): string =>
  value.kind === 'checks'
    ? 'checks:' + value.operationId
    : JSON.stringify(value);
function checkpoint(value: unknown, format: 1 | 2 = 2): Checkpoint {
  if (!object(value))
    throw new TypeError('Invalid engineering driver checkpoint');
  fields(value, ['generation', 'cursor', format === 1 ? 'target' : 'targets']);
  if (
    typeof value.generation !== 'number' ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !cursor(value.cursor)
  )
    throw new TypeError('Invalid engineering driver checkpoint');
  const references =
    format === 1
      ? value.target === null
        ? []
        : [value.target]
      : value.targets;
  if (!Array.isArray(references) || references.length > DISCOVERY_ROWS)
    throw new TypeError('Invalid engineering target backlog');
  const targets = references.map(target);
  if (format === 1 && targets.some((value) => value.kind === 'checks'))
    throw new TypeError('Invalid legacy engineering target hint');
  if (new Set(targets.map(targetIdentity)).size !== targets.length)
    throw new TypeError('Duplicate engineering target backlog');
  return { generation: value.generation, cursor: value.cursor, targets };
}
const checkpoints = defineCollection<Checkpoint>({
  name: 'pegma.support-engineering-driver.v1',
  key: () => KEY,
  codec: {
    encode(value) {
      const record = {
        ...KEY,
        format: 2,
        payload: JSON.stringify(checkpoint(value)),
      };
      if (encoder.encode(JSON.stringify(record)).byteLength > MAX_RECORD_BYTES)
        throw new TypeError('Engineering checkpoint limit exceeded');
      return record;
    },
    decode(value) {
      fields(value, ['partition', 'id', 'format', 'payload']);
      if (
        value.partition !== KEY.partition ||
        value.id !== KEY.id ||
        (value.format !== 1 && value.format !== 2) ||
        typeof value.payload !== 'string' ||
        encoder.encode(JSON.stringify(value)).byteLength > MAX_RECORD_BYTES
      )
        throw new TypeError('Invalid engineering driver checkpoint');
      return checkpoint(JSON.parse(value.payload), value.format);
    },
  },
});

/** One scan OR one current SDK stage. This head is only a cursor/target hint;
 * SDK Source/Work/claims/receipts and the durable usage ledger remain authority.
 * Work/reconciliation targets are CAS-consumed before the SDK call. Checks are
 * CAS-replaced with a Work resume before precompute, with no post-paid head write.
 * Lost-ACK hints are rediscovered by the wrapping physical scan, never a reason
 * to resubmit a model or create. Unknown dispatches cannot pin other tickets.
 */
export function createSupportEngineeringDriver(
  options: SupportEngineeringDriverOptions,
) {
  return Object.freeze({
    async runTick(
      run: { readonly signal?: AbortSignal } = {},
    ): Promise<SupportEngineeringDriverResult> {
      function enabled() {
        try {
          return options.isEnabled?.() === true;
        } catch {
          return false;
        }
      }
      if (!enabled()) return { outcome: 'disabled', checkpointSaved: false };
      if (!options.runtime || run.signal?.aborted)
        return { outcome: 'unavailable', checkpointSaved: false };
      const controller = new AbortController();
      const started = performance.now();
      let rejectDeadline: (error: Error) => void = () => {};
      const deadline = new Promise<never>((_, reject) => {
        rejectDeadline = reject;
      });
      void deadline.catch(() => {});
      const stop = () => {
        controller.abort();
        rejectDeadline(new Error('Engineering tick stopped'));
      };
      run.signal?.addEventListener('abort', stop, { once: true });
      const timer = setTimeout(stop, TICK_MILLISECONDS);
      let saved = false;
      function current(): boolean {
        if (
          !enabled() ||
          controller.signal.aborted ||
          performance.now() - started >= TICK_MILLISECONDS
        )
          return false;
        const now = options.clock.now();
        return (
          typeof now === 'string' &&
          Number.isFinite(Date.parse(now)) &&
          new Date(now).toISOString() === now
        );
      }
      async function within<Value>(
        operation: () => Promise<Value>,
      ): Promise<Value> {
        const value = await Promise.race([
          Promise.resolve().then(() => {
            if (!current()) throw new Error('Engineering tick is unavailable');
            return operation();
          }),
          deadline,
        ]);
        if (!current()) throw new Error('Engineering tick is unavailable');
        return value;
      }
      try {
        if (!current()) throw new Error('Engineering tick is unavailable');
        const runtime = options.runtime(current);
        if (!runtime) return { outcome: 'unavailable', checkpointSaved: false };
        const collection = options.store.collection(checkpoints);
        const observed = await within(() => collection.getVersioned(KEY));
        const prior =
          observed === null
            ? { generation: 0, cursor: null, targets: [] }
            : checkpoint(observed.value);
        if (prior.generation === Number.MAX_SAFE_INTEGER)
          return { outcome: 'unavailable', checkpointSaved: false };
        async function save(next: Checkpoint): Promise<boolean> {
          if (observed === null)
            return (await collection.insertIfAbsent(next)).inserted;
          return collection.putIfUnchanged(next, observed.version);
        }
        if (prior.targets.length > 0) {
          const hint = prior.targets[0]!;
          const remaining = prior.targets.slice(1);
          const nextTargets =
            hint.kind === 'checks'
              ? [
                  {
                    kind: 'work' as const,
                    ticketId: hint.ticketId,
                    sourceGeneration: hint.sourceGeneration,
                  },
                  ...remaining,
                ]
              : remaining;
          saved = await within(() =>
            save({
              generation: prior.generation + 1,
              cursor: prior.cursor,
              targets: nextTargets,
            }),
          );
          if (!saved) return { outcome: 'contended', checkpointSaved: false };
          if (hint.kind === 'checks') {
            // Resume is durable BEFORE the possibly paid call. Unknown/lost
            // ACKs never cause a post-paid head write or assert completion.
            const result =
              Date.parse(hint.expiresAt) <= Date.parse(options.clock.now()) ||
              runtime.precomputeChecks === undefined
                ? { outcome: 'held' as const }
                : await within(() =>
                    runtime.precomputeChecks!(hint, {
                      signal: controller.signal,
                    }),
                  );
            return {
              outcome: 'checks',
              result,
              remainingTargets: nextTargets.length,
              checkpointSaved: true,
            };
          }
          if (hint.kind === 'reconciliation') {
            const result = await within(() =>
              runtime.reconcileSource(hint.ticketId, {
                signal: controller.signal,
              }),
            );
            return {
              outcome: 'reconciliation',
              result,
              remainingTargets: remaining.length,
              checkpointSaved: true,
            };
          }
          const result = await within(() =>
            runtime.processWork(
              {
                ticketId: hint.ticketId,
                sourceGeneration: hint.sourceGeneration,
                workerId,
                leaseMilliseconds: 30_000,
              },
              { signal: controller.signal },
            ),
          );
          let remainingTargets = remaining.length;
          if (result.outcome === 'checks_pending') {
            const deferred = target(result.hint);
            if (
              deferred.kind !== 'checks' ||
              deferred.ticketId !== hint.ticketId ||
              deferred.sourceGeneration !== hint.sourceGeneration
            )
              throw new TypeError('Mismatched deferred engineering check hint');
            // Only the nonpaid proposal path emits this outcome. Merge against
            // the CURRENT head so a concurrent pop/scan is never overwritten.
            // If full/contended, its durable queued input re-emits on discovery.
            for (let attempt = 0; attempt < 2; attempt++) {
              const head = await within(() => collection.getVersioned(KEY));
              if (head === null) break;
              const value = checkpoint(head.value);
              remainingTargets = value.targets.length;
              const same = value.targets.find(
                (entry) => targetIdentity(entry) === targetIdentity(deferred),
              );
              if (same !== undefined) {
                if (JSON.stringify(same) !== JSON.stringify(deferred))
                  throw new TypeError(
                    'Conflicting deferred engineering check hint',
                  );
                break;
              }
              // A concurrently rediscovered same Work will recapture its own
              // durable operation. Avoid a duplicate resume beside that ref.
              if (
                value.targets.some(
                  (entry) =>
                    entry.kind !== 'reconciliation' &&
                    entry.ticketId === deferred.ticketId &&
                    entry.sourceGeneration === deferred.sourceGeneration,
                )
              )
                break;
              if (
                value.targets.length === DISCOVERY_ROWS ||
                value.generation === Number.MAX_SAFE_INTEGER ||
                Date.parse(deferred.expiresAt) <=
                  Date.parse(options.clock.now())
              )
                break;
              const targets = [...value.targets, deferred];
              if (
                await within(() =>
                  collection.putIfUnchanged(
                    {
                      generation: value.generation + 1,
                      cursor: value.cursor,
                      targets,
                    },
                    head.version,
                  ),
                )
              ) {
                remainingTargets = targets.length;
                break;
              }
            }
          }
          return {
            outcome: 'work',
            result,
            remainingTargets,
            checkpointSaved: true,
          };
        }
        const page = await within(() =>
          runtime.scanCandidates({
            limit: DISCOVERY_ROWS,
            ...(prior.cursor === null ? {} : { cursor: prior.cursor }),
          }),
        );
        if (
          !('candidates' in page) ||
          page.pages !== 1 ||
          !Number.isSafeInteger(page.physicalRows) ||
          page.physicalRows < 0 ||
          page.physicalRows > DISCOVERY_ROWS ||
          !cursor(page.nextCursor) ||
          (page.nextCursor !== null && page.nextCursor === prior.cursor) ||
          !Array.isArray(page.candidates) ||
          page.candidates.length > page.physicalRows ||
          !Array.isArray(page.reconciliationSources) ||
          page.reconciliationSources.length + page.candidates.length >
            page.physicalRows ||
          encoder.encode(JSON.stringify(page)).byteLength > MAX_RECORD_BYTES
        )
          return { outcome: 'unavailable', checkpointSaved: false };
        const targets = [
          ...page.reconciliationSources.map((ticketId) =>
            target({ kind: 'reconciliation', ticketId }),
          ),
          ...page.candidates.map((work) => {
            if (!object(work))
              throw new TypeError('Invalid engineering candidate hint');
            fields(work, ['ticketId', 'sourceGeneration']);
            return target({
              kind: 'work',
              ticketId: work.ticketId,
              sourceGeneration: work.sourceGeneration,
            });
          }),
        ];
        if (
          new Set(targets.map((value) => JSON.stringify(value))).size !==
          targets.length
        )
          throw new TypeError('Duplicate engineering scan target');
        saved = await within(() =>
          save({
            generation: prior.generation + 1,
            cursor: page.nextCursor,
            targets,
          }),
        );
        return saved
          ? {
              outcome: 'scanned',
              physicalRows: page.physicalRows,
              selected: targets.length > 0,
              checkpointSaved: true,
            }
          : { outcome: 'contended', checkpointSaved: false };
      } catch {
        return { outcome: 'unavailable', checkpointSaved: saved };
      } finally {
        clearTimeout(timer);
        run.signal?.removeEventListener('abort', stop);
        controller.abort();
      }
    },
  });
}
