import { createMemoryStore } from '@pegma/storage-core';
import { describe, expect, it } from 'vitest';
import {
  isReconciliationStale,
  markReleaseReconciliationSuccess,
  markReleaseWebhookSuccess,
  readReleaseOpsState,
  RECONCILIATION_STALE_AFTER_MS,
  saveReleaseRepositoryEtags,
} from './release-ops-state';

describe('release ops state', () => {
  it('records webhook and reconciliation markers independently', async () => {
    const store = createMemoryStore();
    await markReleaseWebhookSuccess(store, '2026-07-28T10:00:00.000Z');
    await markReleaseReconciliationSuccess(
      store,
      '2026-07-28T12:00:00.000Z',
      { '1313911960': '"etag"' },
    );

    const ops = await readReleaseOpsState(store);
    expect(ops.lastSuccessfulWebhookAt).toBe('2026-07-28T10:00:00.000Z');
    expect(ops.lastSuccessfulReconciliationAt).toBe(
      '2026-07-28T12:00:00.000Z',
    );
    expect(ops.repositoryEtags).toEqual({ '1313911960': '"etag"' });
  });

  it('saves etags without claiming reconciliation success', async () => {
    const store = createMemoryStore();
    await saveReleaseRepositoryEtags(store, { a: '1' });
    const ops = await readReleaseOpsState(store);
    expect(ops.lastSuccessfulReconciliationAt).toBeNull();
    expect(ops.repositoryEtags).toEqual({ a: '1' });
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
