import { createMemoryStore } from '@pegma/storage-core';
import { describe, expect, it } from 'vitest';
import {
  invalidateReleaseRepositoryEtag,
  isReconciliationStale,
  markReleaseWebhookSuccess,
  mergeReleaseRepositoryEtagUpdates,
  readReleaseOpsState,
  RECONCILIATION_STALE_AFTER_MS,
} from './release-ops-state';

describe('release ops state', () => {
  it('records webhook and reconciliation markers independently', async () => {
    const store = createMemoryStore();
    await markReleaseWebhookSuccess(store, '2026-07-28T10:00:00.000Z');
    await mergeReleaseRepositoryEtagUpdates(
      store,
      [
        {
          repositoryId: '1313911960',
          etag: '"etag"',
          expectedEpoch: 0,
        },
      ],
      '2026-07-28T12:00:00.000Z',
    );

    const ops = await readReleaseOpsState(store);
    expect(ops.lastSuccessfulWebhookAt).toBe('2026-07-28T10:00:00.000Z');
    expect(ops.lastSuccessfulReconciliationAt).toBe(
      '2026-07-28T12:00:00.000Z',
    );
    expect(ops.repositoryEtags).toEqual({ '1313911960': '"etag"' });
  });

  it('invalidates a repository ETag and bumps its epoch', async () => {
    const store = createMemoryStore();
    await mergeReleaseRepositoryEtagUpdates(
      store,
      [
        {
          repositoryId: '1313911960',
          etag: '"etag-a"',
          expectedEpoch: 0,
        },
        {
          repositoryId: '1312512520',
          etag: '"keep"',
          expectedEpoch: 0,
        },
      ],
      '2026-07-28T12:00:00.000Z',
    );
    await invalidateReleaseRepositoryEtag(store, '1313911960');
    const ops = await readReleaseOpsState(store);
    expect(ops.repositoryEtags).toEqual({ '1312512520': '"keep"' });
    expect(ops.repositoryEtagEpochs['1313911960']).toBe(1);
    expect(ops.lastSuccessfulReconciliationAt).toBe(
      '2026-07-28T12:00:00.000Z',
    );
  });

  it('does not restore ETags after concurrent invalidation', async () => {
    const store = createMemoryStore();
    await mergeReleaseRepositoryEtagUpdates(
      store,
      [{ repositoryId: 'a', etag: '1', expectedEpoch: 0 }],
      null,
    );
    // Recon observed epoch 0 for a, then webhook invalidates.
    await invalidateReleaseRepositoryEtag(store, 'a');
    await mergeReleaseRepositoryEtagUpdates(
      store,
      [{ repositoryId: 'a', etag: 'stale', expectedEpoch: 0 }],
      null,
    );
    const ops = await readReleaseOpsState(store);
    expect(ops.repositoryEtags).toEqual({});
    expect(ops.repositoryEtagEpochs['a']).toBe(1);
  });

  it('classifies reconciliation staleness', () => {
    const now = Date.parse('2026-07-28T20:00:00.000Z');
    expect(isReconciliationStale(null, now)).toBe(true);
    expect(
      isReconciliationStale(
        new Date(now - RECONCILIATION_STALE_AFTER_MS - 1).toISOString(),
        now,
      ),
    ).toBe(true);
    expect(
      isReconciliationStale(
        new Date(now - RECONCILIATION_STALE_AFTER_MS + 60_000).toISOString(),
        now,
      ),
    ).toBe(false);
  });
});
