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
  /**
   * Per-repository generation bumped on every ETag invalidation so recon
   * cannot restore a stale ETag after a concurrent webhook projection.
   */
  readonly repositoryEtagEpochs: Readonly<Record<string, number>>;
}

type EncodedReleaseOpsState = {
  readonly lastSuccessfulWebhookAt: StoredValue;
  readonly lastSuccessfulReconciliationAt: StoredValue;
  readonly repositoryEtagsJson: StoredValue;
  readonly repositoryEtagEpochsJson: StoredValue;
};

function opsKey(): EntityKey {
  return { partition: OPS_PARTITION, id: OPS_ID };
}

function encodeStringMap(map: Readonly<Record<string, string>>): string {
  return JSON.stringify(map);
}

function decodeStringMap(value: StoredValue): Record<string, string> {
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

function encodeEpochMap(map: Readonly<Record<string, number>>): string {
  return JSON.stringify(map);
}

function decodeEpochMap(value: StoredValue): Record<string, number> {
  if (typeof value !== 'string' || value.length === 0 || value.length > 32_768) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const result: Record<string, number> = {};
    for (const [key, entry] of Object.entries(parsed)) {
      if (typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0) {
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
    repositoryEtagsJson: encodeStringMap(value.repositoryEtags),
    repositoryEtagEpochsJson: encodeEpochMap(value.repositoryEtagEpochs),
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
    repositoryEtags: decodeStringMap(record['repositoryEtagsJson'] ?? null),
    repositoryEtagEpochs: decodeEpochMap(
      record['repositoryEtagEpochsJson'] ?? null,
    ),
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
  repositoryEtagEpochs: {},
};

export async function readReleaseOpsState(store: Store): Promise<ReleaseOpsState> {
  const current = await store.collection(releaseOpsCollection()).get(opsKey());
  return current ?? EMPTY;
}

/**
 * Drop the recon ETag for one repository and bump its epoch. Critical for
 * correctness after a webhook changes the local projection.
 */
export async function invalidateReleaseRepositoryEtag(
  store: Store,
  repositoryId: string,
): Promise<void> {
  await store.collection(releaseOpsCollection()).update(opsKey(), (current) => {
    const base = current ?? EMPTY;
    const etags = { ...base.repositoryEtags };
    const epochs = { ...base.repositoryEtagEpochs };
    delete etags[repositoryId];
    epochs[repositoryId] = (epochs[repositoryId] ?? 0) + 1;
    return {
      action: 'write',
      value: {
        ...base,
        repositoryEtags: etags,
        repositoryEtagEpochs: epochs,
      },
    };
  });
}

/** Record last successful webhook time only (health detail). */
export async function markReleaseWebhookSuccess(
  store: Store,
  at: string,
): Promise<void> {
  await store.collection(releaseOpsCollection()).update(opsKey(), (current) => ({
    action: 'write',
    value: {
      ...(current ?? EMPTY),
      lastSuccessfulWebhookAt: at,
    },
  }));
}

/** One repository ETag update conditioned on the epoch observed at fetch time. */
export interface ConditionalEtagUpdate {
  readonly repositoryId: string;
  /** ETag to store, or null to clear. */
  readonly etag: string | null;
  /** Epoch value read when reconciliation began this repository. */
  readonly expectedEpoch: number;
}

/**
 * Merge conditional ETag updates. An update applies only when the live epoch
 * still matches `expectedEpoch`, so a concurrent invalidation wins.
 */
export async function mergeReleaseRepositoryEtagUpdates(
  store: Store,
  updates: readonly ConditionalEtagUpdate[],
  markSuccessAt: string | null,
): Promise<void> {
  await store.collection(releaseOpsCollection()).update(opsKey(), (current) => {
    const base = current ?? EMPTY;
    const etags = { ...base.repositoryEtags };
    const epochs = { ...base.repositoryEtagEpochs };
    for (const update of updates) {
      const liveEpoch = epochs[update.repositoryId] ?? 0;
      if (liveEpoch !== update.expectedEpoch) {
        continue;
      }
      if (update.etag === null) {
        delete etags[update.repositoryId];
      } else {
        etags[update.repositoryId] = update.etag;
      }
    }
    return {
      action: 'write',
      value: {
        ...base,
        repositoryEtags: etags,
        repositoryEtagEpochs: epochs,
        lastSuccessfulReconciliationAt:
          markSuccessAt ?? base.lastSuccessfulReconciliationAt,
      },
    };
  });
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
