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
      { '1313911960': '"etag"' },
      '2026-07-28T12:00:00.000Z',
    );

    const ops = await readReleaseOpsState(store);
    expect(ops.lastSuccessfulWebhookAt).toBe('2026-07-28T10:00:00.000Z');
    expect(ops.lastSuccessfulReconciliationAt).toBe(
      '2026-07-28T12:00:00.000Z',
    );
    expect(ops.repositoryEtags).toEqual({ '1313911960': '"etag"' });
  });

  it('invalidates a repository ETag without clobbering siblings', async () => {
    const store = createMemoryStore();
    await mergeReleaseRepositoryEtagUpdates(
      store,
      { '1313911960': '"etag-a"', '1312512520': '"keep"' },
      '2026-07-28T12:00:00.000Z',
    );
    await invalidateReleaseRepositoryEtag(store, '1313911960');
    const ops = await readReleaseOpsState(store);
    expect(ops.repositoryEtags).toEqual({ '1312512520': '"keep"' });
    expect(ops.lastSuccessfulReconciliationAt).toBe(
      '2026-07-28T12:00:00.000Z',
    );
  });

  it('merges etag updates without restoring concurrent invalidations', async () => {
    const store = createMemoryStore();
    await mergeReleaseRepositoryEtagUpdates(
      store,
      { a: '1', b: '2' },
      null,
    );
    await invalidateReleaseRepositoryEtag(store, 'a');
    // Partial recon only updates b — must not restore a.
    await mergeReleaseRepositoryEtagUpdates(store, { b: '2b' }, null);
    const ops = await readReleaseOpsState(store);
    expect(ops.repositoryEtags).toEqual({ b: '2b' });
    expect(ops.lastSuccessfulReconciliationAt).toBeNull();
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
