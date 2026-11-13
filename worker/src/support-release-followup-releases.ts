import { defineCollection, type Store } from '@pegma/storage-core';
import type { ComponentRelease } from './component-release';
import {
  componentReleaseCollection,
  componentReleaseKey,
} from './component-release';
import { knowledgeDigest } from './knowledge-evidence';

export interface FollowupReleaseObservation {
  readonly repositoryId: string;
  readonly epoch: number;
  readonly releaseId: string;
  readonly fingerprint: string;
  readonly state: 'active' | 'withdrawn';
}

function checked(value: unknown): FollowupReleaseObservation {
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

export const supportFollowupReleaseObservations =
  defineCollection<FollowupReleaseObservation>({
    name: 'pegma.support-followup-release-observations.v1',
    key: (value) => ({ partition: 'repositories', id: value.repositoryId }),
    codec: {
      encode(value) {
        return { json: JSON.stringify(checked(value)) };
      },
      decode(row) {
        if (
          Object.keys(row).length !== 1 ||
          typeof row.json !== 'string' ||
          row.json.length > 2000
        )
          throw new TypeError('Invalid follow-up release observation');
        return checked(JSON.parse(row.json));
      },
    },
  });

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

/** Called only after an authenticated/authoritative projection, or while a
 * current staff command binds an already trusted stored projection. */
export async function recordSupportFollowupRelease(
  store: Store,
  repositoryId: string,
) {
  const releases = store.collection(componentReleaseCollection());
  const observations = store.collection(supportFollowupReleaseObservations);
  const key = { partition: 'repositories', id: repositoryId };
  for (let attempt = 0; attempt < 3; attempt++) {
    const release = await releases.get(componentReleaseKey(repositoryId));
    const prior = await observations.getVersioned(key);
    if (!release && !prior) return undefined;
    if (prior !== null && prior.value.repositoryId !== repositoryId)
      throw new TypeError('Invalid release observation identity');
    const fingerprint = release
      ? await supportFollowupReleaseFingerprint(release)
      : prior!.value.fingerprint;
    const state = release ? ('active' as const) : ('withdrawn' as const);
    if (prior?.value.state === state && prior.value.fingerprint === fingerprint)
      return prior.value;
    const epoch = (prior?.value.epoch ?? 0) + 1;
    if (!Number.isSafeInteger(epoch))
      throw new TypeError('Release observation exhausted');
    const value: FollowupReleaseObservation = {
      repositoryId,
      epoch,
      state,
      fingerprint,
      releaseId: release?.releaseId ?? prior!.value.releaseId,
    };
    if (
      prior === null
        ? (await observations.insertIfAbsent(value)).inserted
        : await observations.putIfUnchanged(value, prior.version)
    )
      return value;
  }
  throw new TypeError('Release observation changed');
}
