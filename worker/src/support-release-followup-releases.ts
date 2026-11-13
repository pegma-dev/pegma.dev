import type { Store, TransactionAction } from '@pegma/storage-core';
import type { ComponentRelease } from './component-release';
import {
  componentReleaseStateCollection,
  componentReleaseKey,
  supportFollowupReleaseObservationKey,
  type ComponentReleaseState,
  type FollowupReleaseObservation,
} from './component-release';
import { knowledgeDigest } from './knowledge-evidence';
export {
  supportFollowupReleaseObservations,
  supportFollowupReleaseObservationKey,
  type FollowupReleaseObservation,
} from './component-release';

/** Refresh timestamps are not release changes. Deletion/republication advances
 * the durable epoch even if the release later has identical display facts. */
export function supportFollowupReleaseFingerprint(value: ComponentRelease) {
  return knowledgeDigest({
    repositoryId: value.repositoryId,
    repositoryName: value.repositoryName,
    releaseId: value.releaseId,
    tagName: value.tagName,
    publishedAt: value.publishedAt,
    releaseUrl: value.releaseUrl,
  });
}

/** Every projection writer participates, even while follow-up is OFF. Read the
 * shared epoch FIRST: its opaque version fences the subsequently read projection.
 * No conditional delete or cross-collection transaction is assumed. */
export async function updateSupportFollowupRelease(
  store: Store,
  repositoryId: string,
  decide: (
    current: ComponentRelease | null,
  ) => ComponentRelease | null | undefined,
): Promise<{
  release: ComponentRelease | null;
  changed: boolean;
  observation: FollowupReleaseObservation | undefined;
}> {
  const records = store.collection(componentReleaseStateCollection());
  const key = componentReleaseKey(repositoryId);
  const epochKey = supportFollowupReleaseObservationKey(repositoryId);
  for (let attempt = 0; attempt < 3; attempt++) {
    const prior = await records.getVersioned(epochKey);
    if (
      prior !== null &&
      (prior.value.kind !== 'observation' ||
        prior.value.observation.repositoryId !== repositoryId)
    )
      throw new TypeError('Invalid release observation identity');
    const stored = await records.getVersioned(key);
    if (
      stored !== null &&
      (stored.value.kind !== 'release' ||
        stored.value.release.repositoryId !== repositoryId)
    )
      throw new TypeError('Invalid release projection identity');
    const current =
      stored?.value.kind === 'release' ? stored.value.release : null;
    const previous =
      prior?.value.kind === 'observation' ? prior.value.observation : undefined;
    const decision = decide(current);
    const release = decision === undefined ? current : decision;
    const changed = decision !== undefined;
    if (release === null && previous === undefined && current === null)
      return { release, changed: false, observation: undefined };
    const basis = release ?? current;
    const fingerprint = basis
      ? await supportFollowupReleaseFingerprint(basis)
      : previous!.fingerprint;
    const state = release ? ('active' as const) : ('withdrawn' as const);
    const same =
      previous?.state === state && previous.fingerprint === fingerprint;
    if (!changed && same) return { release, changed, observation: previous };
    const epoch = (previous?.epoch ?? 0) + (same ? 0 : 1);
    if (!Number.isSafeInteger(epoch))
      throw new TypeError('Release observation exhausted');
    const observation: FollowupReleaseObservation = {
      repositoryId,
      epoch,
      state,
      fingerprint,
      releaseId: basis?.releaseId ?? previous!.releaseId,
    };
    const epochValue: ComponentReleaseState = {
      kind: 'observation',
      observation,
    };
    const actions: TransactionAction<ComponentReleaseState>[] = [
      prior === null
        ? { action: 'insert', value: epochValue }
        : {
            action: 'putIfUnchanged',
            value: epochValue,
            version: prior.version,
          },
    ];
    if (changed) {
      if (release !== null)
        actions.push({ action: 'put', value: { kind: 'release', release } });
      else if (stored !== null) actions.push({ action: 'delete', key });
    }
    if ((await records.transact(key.partition, actions)).committed)
      return { release, changed, observation };
  }
  throw new TypeError('Release observation changed');
}

/** Synchronize only an already trusted stored projection for a staff command.
 * All normal projection changes commit their observation in the same transaction. */
export async function recordSupportFollowupRelease(
  store: Store,
  repositoryId: string,
) {
  return (
    await updateSupportFollowupRelease(store, repositoryId, () => undefined)
  ).observation;
}
