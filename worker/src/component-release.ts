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

const RELEASE_PARTITION = 'current';

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
