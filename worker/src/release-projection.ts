import type { Store } from '@pegma/storage-core';
import type { ComponentRelease } from './component-release';
import { updateSupportFollowupRelease, type ReleaseProjectionFence } from './support-release-followup-releases';

const GITHUB_ORG_PREFIX = 'https://github.com/pegma-dev/';
const SAFE_REPO_NAME = /^[A-Za-z0-9_.-]+$/;
const SAFE_TAG_NAME = /^[A-Za-z0-9._+/~^-]+$/;

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

  const repositoryId =
    decision.kind === 'delete'
      ? decision.repositoryId
      : decision.release.repositoryId;
  await updateSupportFollowupRelease(store, repositoryId, (current) => {
    if (decision.kind === 'delete')
      return current?.releaseId === decision.releaseId ? null : undefined;
    const incoming = decision.release;
    return current === null ||
      current.releaseId === incoming.releaseId ||
      isNewerOrSameRelease(incoming, current)
      ? incoming
      : undefined;
  });
}

/**
 * Authoritative write of GitHub's current stable release (reconciliation /
 * backfill). Unlike webhook projection, an older preceding stable release
 * must displace a local current row after a missed delete/unpublish.
 *
 * Always writes (including a fresh `observedAt`) so UI staleness tracks
 * successful recon. A rare concurrent webhook publish during the GitHub GET
 * can lose a race; the webhook or the next recon restores truth within the
 * six-hour cadence — delete convergence requires force-write here.
 */
export async function applyAuthoritativeCurrentRelease(
  store: Store,
  release: ComponentRelease,
  fence?: ReleaseProjectionFence,
): Promise<'written' | 'unchanged'> {
  const result = await updateSupportFollowupRelease(
    store,
    release.repositoryId,
    (current) =>
      current !== null &&
      Object.keys(release).every(
        (name) =>
          current[name as keyof ComponentRelease] ===
          release[name as keyof ComponentRelease],
      )
        ? undefined
        : release,
    fence,
  );
  return result.changed ? 'written' : 'unchanged';
}

/** Touch observedAt on an existing current row (successful 304 revalidation). */
export async function touchCurrentReleaseObservedAt(
  store: Store,
  repositoryId: string,
  observedAt: string,
  fence?: ReleaseProjectionFence,
): Promise<boolean> {
  return (
    await updateSupportFollowupRelease(store, repositoryId, (current) =>
      current === null || current.observedAt === observedAt
        ? undefined
        : { ...current, observedAt }, fence,
    )
  ).changed;
}

/** Authoritative absence retains the durable epoch while atomically deleting
 * only the projection fenced by that same epoch row. */
export async function clearCurrentRelease(
  store: Store,
  repositoryId: string,
  fence?: ReleaseProjectionFence,
): Promise<boolean> {
  return (
    await updateSupportFollowupRelease(store, repositoryId, (current) =>
      current === null ? undefined : null, fence,
    )
  ).changed;
}
