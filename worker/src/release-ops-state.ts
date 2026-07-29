import {
  defineCollection,
  type EntityKey,
  type Store,
  type StoredRecord,
  type StoredValue,
} from '@pegma/storage-core';

const OPS_PARTITION = 'ops';
const OPS_ID = 'github-releases';

/** Durable operator markers for release webhook + reconciliation. */
export interface ReleaseOpsState {
  readonly lastSuccessfulWebhookAt: string | null;
  readonly lastSuccessfulReconciliationAt: string | null;
  /** Per-repository ETag for GitHub conditional requests (repoId → etag). */
  readonly repositoryEtags: Readonly<Record<string, string>>;
}

type EncodedReleaseOpsState = {
  readonly lastSuccessfulWebhookAt: StoredValue;
  readonly lastSuccessfulReconciliationAt: StoredValue;
  readonly repositoryEtagsJson: StoredValue;
};

function opsKey(): EntityKey {
  return { partition: OPS_PARTITION, id: OPS_ID };
}

function encodeEtags(etags: Readonly<Record<string, string>>): string {
  return JSON.stringify(etags);
}

function decodeEtags(value: StoredValue): Record<string, string> {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32_768) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const result: Record<string, string> = {};
    for (const [key, entry] of Object.entries(parsed)) {
      if (typeof entry === 'string' && entry.length > 0 && entry.length <= 512) {
        result[key] = entry;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function encode(value: ReleaseOpsState): EncodedReleaseOpsState {
  return {
    lastSuccessfulWebhookAt: value.lastSuccessfulWebhookAt,
    lastSuccessfulReconciliationAt: value.lastSuccessfulReconciliationAt,
    repositoryEtagsJson: encodeEtags(value.repositoryEtags),
  };
}

function decode(record: StoredRecord): ReleaseOpsState {
  return {
    lastSuccessfulWebhookAt:
      typeof record['lastSuccessfulWebhookAt'] === 'string'
        ? record['lastSuccessfulWebhookAt']
        : null,
    lastSuccessfulReconciliationAt:
      typeof record['lastSuccessfulReconciliationAt'] === 'string'
        ? record['lastSuccessfulReconciliationAt']
        : null,
    repositoryEtags: decodeEtags(record['repositoryEtagsJson'] ?? null),
  };
}

export function releaseOpsCollection() {
  return defineCollection({
    name: 'releaseOps',
    key: () => opsKey(),
    codec: { encode, decode },
  });
}

const EMPTY: ReleaseOpsState = {
  lastSuccessfulWebhookAt: null,
  lastSuccessfulReconciliationAt: null,
  repositoryEtags: {},
};

export async function readReleaseOpsState(store: Store): Promise<ReleaseOpsState> {
  const current = await store.collection(releaseOpsCollection()).get(opsKey());
  return current ?? EMPTY;
}

/**
 * Record a successful webhook observation and drop the recon ETag for the
 * touched repository so a later 304 cannot mask a missed delete/unpublish
 * that returned GitHub to a previously cached representation.
 */
export async function markReleaseWebhookSuccess(
  store: Store,
  at: string,
  repositoryId?: string,
): Promise<void> {
  await store.collection(releaseOpsCollection()).update(opsKey(), (current) => {
    const base = current ?? EMPTY;
    const etags = { ...base.repositoryEtags };
    if (typeof repositoryId === 'string' && repositoryId.length > 0) {
      delete etags[repositoryId];
    }
    return {
      action: 'write',
      value: {
        ...base,
        lastSuccessfulWebhookAt: at,
        repositoryEtags: etags,
      },
    };
  });
}

export async function markReleaseReconciliationSuccess(
  store: Store,
  at: string,
  repositoryEtags: Readonly<Record<string, string>>,
): Promise<void> {
  await store.collection(releaseOpsCollection()).update(opsKey(), (current) => ({
    action: 'write',
    value: {
      ...(current ?? EMPTY),
      lastSuccessfulReconciliationAt: at,
      repositoryEtags: { ...repositoryEtags },
    },
  }));
}

/**
 * Persist advanced per-repo ETags after a partial run without claiming a
 * successful reconciliation completion.
 */
export async function saveReleaseRepositoryEtags(
  store: Store,
  repositoryEtags: Readonly<Record<string, string>>,
): Promise<void> {
  await store.collection(releaseOpsCollection()).update(opsKey(), (current) => ({
    action: 'write',
    value: {
      ...(current ?? EMPTY),
      repositoryEtags: { ...repositoryEtags },
    },
  }));
}

/** Reconciliation is stale when last success is older than this. */
export const RECONCILIATION_STALE_AFTER_MS = 7 * 60 * 60 * 1000;

export function isReconciliationStale(
  lastSuccessfulReconciliationAt: string | null,
  nowMs: number,
): boolean {
  if (lastSuccessfulReconciliationAt === null) {
    return true;
  }
  const at = Date.parse(lastSuccessfulReconciliationAt);
  if (!Number.isFinite(at)) {
    return true;
  }
  return nowMs - at > RECONCILIATION_STALE_AFTER_MS;
}
