import {
  defineCollection,
  type CollectionDefinition,
  type EntityKey,
  type StoredRecord,
  type StoredValue,
} from '@pegma/storage-core';

/** Public current-stable release facts for one allowlisted repository. */
export interface ComponentRelease {
  readonly repositoryId: string;
  readonly repositoryName: string;
  readonly releaseId: string;
  readonly tagName: string;
  readonly publishedAt: string;
  readonly releaseUrl: string;
  readonly observedAt: string;
}

export interface FollowupReleaseObservation {
  readonly repositoryId: string;
  readonly epoch: number;
  readonly releaseId: string;
  readonly fingerprint: string;
  readonly state: 'active' | 'withdrawn';
}
export type ComponentReleaseState =
  | { readonly kind: 'release'; readonly release: ComponentRelease }
  | {
      readonly kind: 'observation';
      readonly observation: FollowupReleaseObservation;
    };

const RELEASE_PARTITION = 'current';
const EPOCH_FIELD = 'followupReleaseEpoch';

export function supportFollowupReleaseObservationKey(
  repositoryId: string,
): EntityKey {
  return { partition: RELEASE_PARTITION, id: 'followup-epoch:' + repositoryId };
}

function checkedObservation(value: unknown): FollowupReleaseObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Invalid follow-up release observation');
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join(',') !==
      'epoch,fingerprint,releaseId,repositoryId,state' ||
    !Number.isSafeInteger(row.epoch) ||
    Number(row.epoch) < 1 ||
    !['active', 'withdrawn'].includes(String(row.state)) ||
    ['repositoryId', 'releaseId', 'fingerprint'].some(
      (name) =>
        typeof row[name] !== 'string' ||
        !row[name] ||
        String(row[name]).length > 200,
    )
  )
    throw new TypeError('Invalid follow-up release observation');
  return {
    repositoryId: String(row.repositoryId),
    releaseId: String(row.releaseId),
    fingerprint: String(row.fingerprint),
    epoch: Number(row.epoch),
    state: row.state === 'active' ? 'active' : 'withdrawn',
  };
}

function decodeObservation(row: StoredRecord): FollowupReleaseObservation {
  const json = row[EPOCH_FIELD];
  if (
    Object.keys(row).length !== 1 ||
    typeof json !== 'string' ||
    json.length > 2000
  )
    throw new TypeError('Invalid follow-up release observation');
  return checkedObservation(JSON.parse(json));
}

/** Reserved rows share the projection's collection/partition so its epoch CAS
 * can fence every projection write, including an unconditional transaction delete. */
export const supportFollowupReleaseObservations =
  defineCollection<FollowupReleaseObservation>({
    name: 'componentReleases',
    key: (value) => supportFollowupReleaseObservationKey(value.repositoryId),
    codec: {
      encode: (value) => ({
        [EPOCH_FIELD]: JSON.stringify(checkedObservation(value)),
      }),
      decode: decodeObservation,
    },
  });

type EncodedComponentRelease = Record<keyof ComponentRelease, StoredValue>;

function encodeComponentRelease(
  value: ComponentRelease,
): EncodedComponentRelease {
  return {
    repositoryId: value.repositoryId,
    repositoryName: value.repositoryName,
    releaseId: value.releaseId,
    tagName: value.tagName,
    publishedAt: value.publishedAt,
    releaseUrl: value.releaseUrl,
    observedAt: value.observedAt,
  };
}

function decodeComponentRelease(record: StoredRecord): ComponentRelease {
  return {
    repositoryId: String(record['repositoryId'] ?? ''),
    repositoryName: String(record['repositoryName'] ?? ''),
    releaseId: String(record['releaseId'] ?? ''),
    tagName: String(record['tagName'] ?? ''),
    publishedAt: String(record['publishedAt'] ?? ''),
    releaseUrl: String(record['releaseUrl'] ?? ''),
    observedAt: String(record['observedAt'] ?? ''),
  };
}

export function componentReleaseKey(repositoryId: string): EntityKey {
  return { partition: RELEASE_PARTITION, id: repositoryId };
}

export function componentReleaseCollection(): CollectionDefinition<ComponentRelease> {
  return defineCollection({
    name: 'componentReleases',
    key: (value) => componentReleaseKey(value.repositoryId),
    codec: {
      encode: encodeComponentRelease,
      decode: decodeComponentRelease,
    },
  });
}

/** Typed view for atomic writes and enumeration; public reads still use only
 * the allowlisted numeric repository keys and their original release codec. */
export function componentReleaseStateCollection(): CollectionDefinition<ComponentReleaseState> {
  return defineCollection({
    name: 'componentReleases',
    key: (value) =>
      value.kind === 'release'
        ? componentReleaseKey(value.release.repositoryId)
        : supportFollowupReleaseObservationKey(value.observation.repositoryId),
    codec: {
      encode: (value) =>
        value.kind === 'release'
          ? encodeComponentRelease(value.release)
          : supportFollowupReleaseObservations.codec.encode(value.observation),
      decode: (row) =>
        Object.hasOwn(row, EPOCH_FIELD)
          ? { kind: 'observation', observation: decodeObservation(row) }
          : { kind: 'release', release: decodeComponentRelease(row) },
    },
  });
}
