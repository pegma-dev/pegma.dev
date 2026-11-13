import {
  createMemoryStore,
  defineCollection,
  type Store,
} from '@pegma/storage-core';
import { describe, expect, it, vi } from 'vitest';
import { cleanupSupportLearningTestReceipts } from './support-learning-test-receipts';
import { runSupportMaintenance } from './support-maintenance';
import { readSupportCursor, saveSupportCursor } from './support-cursors';

const NOW = Date.parse('2026-11-12T00:00:00.000Z');
const clock = { now: () => new Date(NOW).toISOString() };
const logger = { log: vi.fn() };
const COLLECTION = 'pegma.support-learning-test-bindings.v1';
interface RawRow {
  readonly partition: string;
  readonly id: string;
  readonly payload: string;
}
const rawRows = defineCollection<RawRow>({
  name: COLLECTION,
  key: (value) => ({ partition: value.partition, id: value.id }),
  codec: {
    encode: (value) => ({ ...value }),
    decode: (value) => ({
      partition: String(value.partition),
      id: String(value.id),
      payload: String(value.payload),
    }),
  },
});

// Cleanup-only legacy row fixtures. These are never submitted, verified or used
// as passing test evidence. They contain only the existing body-free DTO fields.
function reference(index: number, retainUntil: number) {
  const stamp = new Date(NOW - 60_000).toISOString();
  return {
    id: `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
    commandHash: index.toString(16).padStart(64, '0'),
    inputHash: '1'.repeat(64),
    actorId: 'cleanup-only-actor',
    prepared: {
      ticketId: 'cleanup-only-ticket',
      expectedRevision: 1,
      resolutionCycle: 1,
      solutionMessageId: 'cleanup-only-solution',
      clientCommandId: `cleanup-only-command-${index}`,
      report: {
        articleId: 'cleanup-only-article',
        ledgerEpoch: 1,
        reportId: 'cleanup-only-report',
        expectedReportGeneration: 1,
        reviewBindingHash: '2'.repeat(64),
        receipt: 'cleanup-only-legacy-coordinate',
      },
    },
    resolvedAt: stamp,
    sourceFingerprint: '3'.repeat(64),
    product: {
      productId: 'cleanup-only',
      version: 'legacy',
      buildId: 'legacy',
      binding: 'legacy',
      contextVersion: 'legacy',
    },
    reportFingerprint: '4'.repeat(64),
    reportSubmitterId: 'cleanup-only-submitter',
    reportReviewerId: 'cleanup-only-reviewer',
    reportConfirmedAt: stamp,
    executionId: 'cleanup-only-execution',
    runnerId: 'cleanup-only-runner',
    testId: 'cleanup-only-test',
    executedAt: stamp,
    verifiedAt: stamp,
    validUntil: stamp,
    retainUntil: new Date(retainUntil).toISOString(),
  };
}
function row(
  index: number,
  references: ReturnType<typeof reference>[],
): RawRow {
  const partition = index.toString(16).padStart(64, '0');
  return {
    partition,
    id: 'bindings',
    payload: JSON.stringify({
      partition,
      id: 'bindings',
      ticketId: 'cleanup-only-ticket',
      references,
    }),
  };
}
const key = (value: RawRow) => ({ partition: value.partition, id: value.id });
async function seed(store: Store, value: RawRow) {
  await store.collection(rawRows).put(value);
}

describe('nonpaid Support test-receipt retention', () => {
  it('uses Store/Clock alone, removes elapsed retention and preserves valid references even after verification expiry', async () => {
    const store = createMemoryStore();
    const rows = store.collection(rawRows);
    const mixed = row(1, [reference(1, NOW), reference(2, NOW + 60_000)]);
    const expired = row(2, [reference(3, NOW - 1)]);
    const valid = row(3, [reference(4, NOW + 60_000)]);
    await seed(store, mixed);
    await seed(store, expired);
    await seed(store, valid);
    expect(
      await cleanupSupportLearningTestReceipts({ store, clock }, { limit: 8 }),
    ).toMatchObject({ scanned: 3, changed: 2 });
    expect(await rows.get(key(expired))).toBeNull();
    expect(
      JSON.parse((await rows.get(key(mixed)))!.payload).references,
    ).toEqual([reference(2, NOW + 60_000)]);
    expect(await rows.get(key(valid))).toEqual(valid);
  });

  it.each([0, 33, 1.5, Number.NaN])(
    'refuses unbounded cleanup limit %s before accessing Store',
    async (limit) => {
      const store = createMemoryStore();
      const collection = vi.spyOn(store, 'collection');
      await expect(
        cleanupSupportLearningTestReceipts({ store, clock }, { limit }),
      ).rejects.toMatchObject({ code: 'invalid' });
      expect(collection).not.toHaveBeenCalled();
    },
  );

  it('advances a durable bounded page through live rows to later expired rows and wraps fairly', async () => {
    const store = createMemoryStore();
    for (let i = 1; i <= 25; i++)
      await seed(
        store,
        row(i, [reference(i, i <= 17 ? NOW + 60_000 : NOW - 1)]),
      );
    const scans: number[] = [];
    const measured = new Proxy(store, {
      get(target, property, receiver) {
        if (property !== 'collection')
          return Reflect.get(target, property, receiver);
        return (definition: Parameters<Store['collection']>[0]) => {
          const collection = target.collection(definition);
          if (definition.name !== COLLECTION) return collection;
          return new Proxy(collection, {
            get(records, method, value) {
              if (method !== 'scan') return Reflect.get(records, method, value);
              return async (input: { limit: number; cursor?: string }) => {
                scans.push(input.limit);
                return records.scan(input);
              };
            },
          });
        };
      },
    });
    for (let tick = 0; tick < 4; tick++) {
      await runSupportMaintenance(
        { store: measured, clock, limiters: [] },
        logger,
        { tasks: ['test_receipts'] },
      );
      if (tick < 3)
        expect(await readSupportCursor(store, 'testReceiptCursor')).toEqual(
          expect.any(String),
        );
    }
    expect(scans).toEqual([8, 8, 8, 8]);
    expect(await readSupportCursor(store, 'testReceiptCursor')).toBeUndefined();
    const remaining = await store.collection(rawRows).scan({ limit: 32 });
    expect(remaining.records).toHaveLength(17);
    await runSupportMaintenance({ store, clock, limiters: [] }, logger, {
      tasks: ['test_receipts'],
    });
    expect(await readSupportCursor(store, 'testReceiptCursor')).toEqual(
      expect.any(String),
    );
  });

  it.each(['deleteIfUnchanged', 'putIfUnchanged'])(
    'preserves a concurrent association when %s loses its scanned version',
    async (method) => {
      const store = createMemoryStore();
      const original = row(1, [
        reference(1, NOW - 1),
        ...(method === 'putIfUnchanged' ? [reference(2, NOW + 60_000)] : []),
      ]);
      await seed(store, original);
      const fresh = row(1, [
        ...JSON.parse(original.payload).references,
        reference(3, NOW + 60_000),
      ]);
      let raced = false;
      const racing = new Proxy(store, {
        get(target, property, receiver) {
          if (property !== 'collection')
            return Reflect.get(target, property, receiver);
          return (definition: Parameters<Store['collection']>[0]) => {
            const collection = target.collection(definition);
            if (definition.name !== COLLECTION) return collection;
            return new Proxy(collection, {
              get(records, name, receiver) {
                const operation = Reflect.get(records, name, receiver);
                if (name !== method) return operation;
                return async (...args: unknown[]) => {
                  if (!raced) {
                    raced = true;
                    await seed(store, fresh);
                  }
                  return Reflect.apply(operation, records, args);
                };
              },
            });
          };
        },
      });
      expect(
        await cleanupSupportLearningTestReceipts(
          { store: racing, clock },
          { limit: 1 },
        ),
      ).toMatchObject({ scanned: 1, changed: 0 });
      expect(raced).toBe(true);
      expect(await store.collection(rawRows).get(key(original))).toEqual(fresh);
      expect(
        await cleanupSupportLearningTestReceipts(
          { store, clock },
          { limit: 1 },
        ),
      ).toMatchObject({ changed: 1 });
      expect(
        JSON.parse(
          (await store.collection(rawRows).get(key(original)))!.payload,
        ).references,
      ).toContainEqual(reference(3, NOW + 60_000));
    },
  );

  it('reads old cursor rows without the new field and preserves independent queue bookmarks', async () => {
    const store = createMemoryStore();
    const old = defineCollection<{
      partition: string;
      id: string;
      queueRepairCursor: string;
      queueInactiveSweepCursor: string;
    }>({
      name: 'pegma-dev-support-maintenance',
      key: (value) => ({ partition: value.partition, id: value.id }),
      codec: {
        encode: (value) => ({ ...value }),
        decode: (value) => ({
          partition: String(value.partition),
          id: String(value.id),
          queueRepairCursor: String(value.queueRepairCursor),
          queueInactiveSweepCursor: String(value.queueInactiveSweepCursor),
        }),
      },
    });
    await store.collection(old).put({
      partition: 'support-desk',
      id: 'maintenance',
      queueRepairCursor: 'old-repair',
      queueInactiveSweepCursor: 'old-inactive',
    });
    expect(await readSupportCursor(store, 'testReceiptCursor')).toBeUndefined();
    await saveSupportCursor(store, 'testReceiptCursor', 'retention-next');
    expect(await readSupportCursor(store, 'queueRepairCursor')).toBe(
      'old-repair',
    );
    expect(await readSupportCursor(store, 'queueInactiveSweepCursor')).toBe(
      'old-inactive',
    );
    await saveSupportCursor(store, 'queueRepairCursor', 'new-repair');
    expect(await readSupportCursor(store, 'testReceiptCursor')).toBe(
      'retention-next',
    );
  });

  it('leaves its cursor unchanged after a failed retention scan and logs only an error name', async () => {
    const store = createMemoryStore();
    const log = { log: vi.fn() };
    await saveSupportCursor(
      store,
      'testReceiptCursor',
      'original-retention-position',
    );
    const original = store.collection.bind(store);
    vi.spyOn(store, 'collection').mockImplementation((definition) => {
      const collection = original(definition);
      return definition.name === COLLECTION
        ? {
            ...collection,
            scan: async () => {
              throw new Error('PRIVATE_FAILURE_BODY');
            },
          }
        : collection;
    });
    await runSupportMaintenance({ store, clock, limiters: [] }, log, {
      tasks: ['test_receipts'],
    });
    expect(await readSupportCursor(store, 'testReceiptCursor')).toBe(
      'original-retention-position',
    );
    expect(log.log).toHaveBeenCalledExactlyOnceWith(
      'error',
      'support.maintenance_failed',
      { task: 'test_receipts', error: 'Error' },
    );
  });
});
