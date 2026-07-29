import type { Store } from '@pegma/storage-core';
import {
  componentReleaseCollection,
  componentReleaseKey,
  type ComponentRelease,
} from './component-release';

const GITHUB_ORG_PREFIX = 'https://github.com/pegma-dev/';
const SAFE_REPO_NAME = /^[A-Za-z0-9_.-]+$/;
const SAFE_TAG_NAME = /^[A-Za-z0-9._+/~^-]+$/;
const DELETE_ATTEMPTS = 3;

/** Fields extracted from an authenticated GitHub release webhook payload. */
export interface ReleaseEventFacts {
  readonly action: string;
  readonly repositoryId: string;
  readonly repositoryName: string;
  readonly releaseId: string;
  readonly tagName: string;
  readonly publishedAt: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
}

export type ReleaseProjectionDecision =
  | { readonly kind: 'ignore' }
  | { readonly kind: 'upsert'; readonly release: ComponentRelease }
  | {
      readonly kind: 'delete';
      readonly repositoryId: string;
      readonly releaseId: string;
    };

function compareReleaseIds(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  if (left.length !== right.length) {
    return left.length < right.length ? -1 : 1;
  }
  return left < right ? -1 : 1;
}

function isNewerOrSameRelease(
  incoming: Pick<ComponentRelease, 'publishedAt' | 'releaseId'>,
  current: Pick<ComponentRelease, 'publishedAt' | 'releaseId'>,
): boolean {
  if (incoming.publishedAt > current.publishedAt) {
    return true;
  }
  if (incoming.publishedAt < current.publishedAt) {
    return false;
  }
  return compareReleaseIds(incoming.releaseId, current.releaseId) >= 0;
}

/** Build a pegma-dev release URL; never trust an arbitrary payload URL. */
export function buildPegmaReleaseUrl(
  repositoryName: string,
  tagName: string,
): string | null {
  if (!SAFE_REPO_NAME.test(repositoryName) || !SAFE_TAG_NAME.test(tagName)) {
    return null;
  }
  return `${GITHUB_ORG_PREFIX}${repositoryName}/releases/tag/${tagName}`;
}

/**
 * Pure decision: whether an authenticated release event should upsert,
 * delete, or ignore the current-release projection.
 */
export function decideReleaseProjection(
  facts: ReleaseEventFacts,
  observedAt: string,
): ReleaseProjectionDecision {
  // `unpublished` converts a release back to draft; check removal actions
  // before the draft/prerelease filter so the current projection can clear.
  if (facts.action === 'unpublished' || facts.action === 'deleted') {
    return {
      kind: 'delete',
      repositoryId: facts.repositoryId,
      releaseId: facts.releaseId,
    };
  }

  if (facts.draft || facts.prerelease) {
    return { kind: 'ignore' };
  }

  if (
    facts.action !== 'published' &&
    facts.action !== 'released' &&
    facts.action !== 'edited'
  ) {
    return { kind: 'ignore' };
  }

  const releaseUrl = buildPegmaReleaseUrl(facts.repositoryName, facts.tagName);
  if (releaseUrl === null) {
    return { kind: 'ignore' };
  }

  return {
    kind: 'upsert',
    release: {
      repositoryId: facts.repositoryId,
      repositoryName: facts.repositoryName,
      releaseId: facts.releaseId,
      tagName: facts.tagName,
      publishedAt: facts.publishedAt,
      releaseUrl,
      observedAt,
    },
  };
}

/** Apply an idempotent projection decision to the release collection. */
export async function applyReleaseProjection(
  store: Store,
  decision: ReleaseProjectionDecision,
): Promise<void> {
  if (decision.kind === 'ignore') {
    return;
  }

  const releases = store.collection(componentReleaseCollection());

  if (decision.kind === 'delete') {
    const key = componentReleaseKey(decision.repositoryId);
    for (let attempt = 0; attempt < DELETE_ATTEMPTS; attempt += 1) {
      const current = await releases.getVersioned(key);
      if (current === null) {
        return;
      }
      if (current.value.releaseId !== decision.releaseId) {
        return;
      }
      if (await releases.deleteIfUnchanged(key, current.version)) {
        return;
      }
    }
    throw new Error('Release projection delete conflicted repeatedly.');
  }

  const incoming = decision.release;
  await releases.update(componentReleaseKey(incoming.repositoryId), (current) => {
    if (current === null) {
      return { action: 'write', value: incoming };
    }
    if (current.releaseId === incoming.releaseId) {
      return { action: 'write', value: incoming };
    }
    if (isNewerOrSameRelease(incoming, current)) {
      return { action: 'write', value: incoming };
    }
    return { action: 'keep' };
  });
}

/**
 * Authoritative write of GitHub's current stable release (reconciliation /
 * backfill). Unlike webhook projection, an older preceding stable release
 * must displace a local current row after a missed delete/unpublish.
 * Returns whether the stored row changed.
 */
export async function applyAuthoritativeCurrentRelease(
  store: Store,
  release: ComponentRelease,
): Promise<'written' | 'unchanged'> {
  const releases = store.collection(componentReleaseCollection());
  let changed: 'written' | 'unchanged' = 'unchanged';
  await releases.update(componentReleaseKey(release.repositoryId), (current) => {
    if (
      current !== null &&
      current.releaseId === release.releaseId &&
      current.tagName === release.tagName &&
      current.publishedAt === release.publishedAt &&
      current.releaseUrl === release.releaseUrl &&
      current.repositoryName === release.repositoryName
    ) {
      return { action: 'keep' };
    }
    changed = 'written';
    return { action: 'write', value: release };
  });
  return changed;
}
