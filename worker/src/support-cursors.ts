import {
  defineCollection,
  type Store,
  type StoredValue,
} from '@pegma/storage-core';

/**
 * Host-owned Support Desk maintenance cursors.
 *
 * Independent of Identity mail cursors (`pegma-dev-maintenance`). Never share
 * a cursor across loops or with Identity. Only queue loops persist cursors
 * here; durable rate-limit sweeps are best-effort and do not keep host
 * bookmarks.
 */
export type SupportCursorName =
  'queueRepairCursor' | 'queueInactiveSweepCursor';

interface SupportMaintenanceRecord {
  readonly partition: StoredValue;
  readonly id: StoredValue;
  readonly queueRepairCursor: StoredValue;
  readonly queueInactiveSweepCursor: StoredValue;
}

const KEY = { partition: 'support-desk', id: 'maintenance' } as const;

const maintenance = defineCollection<SupportMaintenanceRecord>({
  name: 'pegma-dev-support-maintenance',
  key: (value) => ({
    partition: String(value.partition),
    id: String(value.id),
  }),
  codec: {
    encode: (value) => ({ ...value }),
    decode: (record) => ({
      partition: record.partition ?? null,
      id: record.id ?? null,
      queueRepairCursor: record.queueRepairCursor ?? null,
      queueInactiveSweepCursor: record.queueInactiveSweepCursor ?? null,
    }),
  },
});

function cursor(value: StoredValue): string | undefined {
  return typeof value === 'string' && value.length <= 8_192 ? value : undefined;
}

function emptyRecord(): SupportMaintenanceRecord {
  return {
    partition: KEY.partition,
    id: KEY.id,
    queueRepairCursor: null,
    queueInactiveSweepCursor: null,
  };
}

export async function readSupportCursor(
  store: Store,
  name: SupportCursorName,
): Promise<string | undefined> {
  const record = await store.collection(maintenance).get(KEY);
  return record === null ? undefined : cursor(record[name]);
}

export async function readSupportCursors(
  store: Store,
): Promise<SupportMaintenanceRecord | null> {
  return store.collection(maintenance).get(KEY);
}

export async function saveSupportCursors(
  store: Store,
  changes: Partial<Record<SupportCursorName, string | null>>,
): Promise<void> {
  if (Object.keys(changes).length === 0) return;
  await store.collection(maintenance).update(KEY, (current) => {
    if (
      Object.entries(changes).every(
        ([name, next]) =>
          (current?.[name as SupportCursorName] ?? null) === next,
      )
    ) {
      return { action: 'keep' };
    }
    return {
      action: 'write',
      value: {
        ...(current ?? emptyRecord()),
        ...changes,
        partition: KEY.partition,
        id: KEY.id,
      },
    };
  });
}

export async function saveSupportCursor(
  store: Store,
  name: SupportCursorName,
  next: string | null,
): Promise<void> {
  await saveSupportCursors(store, { [name]: next });
}
