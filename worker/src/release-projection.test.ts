import { createMemoryStore } from '@pegma/storage-core';
import { describe, expect, it } from 'vitest';
import {
  componentReleaseCollection,
  componentReleaseKey,
} from './component-release';
import {
  applyReleaseProjection,
  buildPegmaReleaseUrl,
  decideReleaseProjection,
  type ReleaseEventFacts,
} from './release-projection';

const NOW = '2026-07-28T18:00:00.000Z';

function facts(
  overrides: Partial<ReleaseEventFacts> = {},
): ReleaseEventFacts {
  return {
    action: 'published',
    repositoryId: '1313911960',
    repositoryName: 'webhooks',
    releaseId: '100',
    tagName: 'v0.1.0',
    publishedAt: '2026-07-28T12:00:00.000Z',
    draft: false,
    prerelease: false,
    ...overrides,
  };
}

describe('decideReleaseProjection', () => {
  it('ignores drafts and prereleases', () => {
    expect(
      decideReleaseProjection(facts({ draft: true }), NOW),
    ).toEqual({ kind: 'ignore' });
    expect(
      decideReleaseProjection(facts({ prerelease: true }), NOW),
    ).toEqual({ kind: 'ignore' });
  });

  it('builds pegma-dev release URLs and rejects unsafe names', () => {
    expect(buildPegmaReleaseUrl('webhooks', 'v0.1.0')).toBe(
      'https://github.com/pegma-dev/webhooks/releases/tag/v0.1.0',
    );
    expect(buildPegmaReleaseUrl('../evil', 'v1')).toBeNull();
  });

  it('upserts published/released/edited and deletes matching ids', () => {
    expect(decideReleaseProjection(facts(), NOW).kind).toBe('upsert');
    expect(
      decideReleaseProjection(facts({ action: 'released' }), NOW).kind,
    ).toBe('upsert');
    expect(
      decideReleaseProjection(facts({ action: 'edited' }), NOW).kind,
    ).toBe('upsert');
    expect(
      decideReleaseProjection(facts({ action: 'deleted' }), NOW),
    ).toEqual({
      kind: 'delete',
      repositoryId: '1313911960',
      releaseId: '100',
    });
  });
});

describe('applyReleaseProjection', () => {
  it('upserts once and ignores older edited releases', async () => {
    const store = createMemoryStore();
    const releases = store.collection(componentReleaseCollection());

    await applyReleaseProjection(
      store,
      decideReleaseProjection(
        facts({
          releaseId: '200',
          tagName: 'v0.2.0',
          publishedAt: '2026-07-28T14:00:00.000Z',
        }),
        NOW,
      ),
    );
    await applyReleaseProjection(
      store,
      decideReleaseProjection(
        facts({
          action: 'edited',
          releaseId: '100',
          tagName: 'v0.1.0',
          publishedAt: '2026-07-28T12:00:00.000Z',
        }),
        NOW,
      ),
    );

    const current = await releases.get(componentReleaseKey('1313911960'));
    expect(current?.tagName).toBe('v0.2.0');
    expect(current?.releaseId).toBe('200');
  });

  it('updates in place when the same releaseId is edited', async () => {
    const store = createMemoryStore();
    const releases = store.collection(componentReleaseCollection());

    await applyReleaseProjection(
      store,
      decideReleaseProjection(facts({ tagName: 'v0.1.0' }), NOW),
    );
    await applyReleaseProjection(
      store,
      decideReleaseProjection(
        facts({ action: 'edited', tagName: 'v0.1.0-fixed' }),
        '2026-07-28T19:00:00.000Z',
      ),
    );

    const current = await releases.get(componentReleaseKey('1313911960'));
    expect(current?.tagName).toBe('v0.1.0-fixed');
    expect(current?.releaseId).toBe('100');
  });

  it('deletes unpublished drafts that were previously current', async () => {
    const store = createMemoryStore();
    const releases = store.collection(componentReleaseCollection());

    await applyReleaseProjection(
      store,
      decideReleaseProjection(facts({ releaseId: '100' }), NOW),
    );
    await applyReleaseProjection(
      store,
      decideReleaseProjection(
        facts({
          action: 'unpublished',
          releaseId: '100',
          draft: true,
        }),
        NOW,
      ),
    );
    expect(await releases.get(componentReleaseKey('1313911960'))).toBeNull();
  });

  it('orders same-timestamp releases by numeric release id', async () => {
    const store = createMemoryStore();
    const releases = store.collection(componentReleaseCollection());
    const publishedAt = '2026-07-28T12:00:00.000Z';

    await applyReleaseProjection(
      store,
      decideReleaseProjection(
        facts({
          releaseId: '100',
          tagName: 'v0.1.0',
          publishedAt,
        }),
        NOW,
      ),
    );
    await applyReleaseProjection(
      store,
      decideReleaseProjection(
        facts({
          releaseId: '99',
          tagName: 'v0.0.9',
          publishedAt,
        }),
        NOW,
      ),
    );

    expect(await releases.get(componentReleaseKey('1313911960'))).toMatchObject({
      releaseId: '100',
      tagName: 'v0.1.0',
    });
  });

  it('deletes only when releaseId matches the stored current release', async () => {
    const store = createMemoryStore();
    const releases = store.collection(componentReleaseCollection());

    await applyReleaseProjection(
      store,
      decideReleaseProjection(
        facts({
          releaseId: '200',
          tagName: 'v0.2.0',
          publishedAt: '2026-07-28T14:00:00.000Z',
        }),
        NOW,
      ),
    );
    await applyReleaseProjection(
      store,
      decideReleaseProjection(
        facts({ action: 'deleted', releaseId: '100' }),
        NOW,
      ),
    );
    expect(
      await releases.get(componentReleaseKey('1313911960')),
    ).not.toBeNull();

    await applyReleaseProjection(
      store,
      decideReleaseProjection(
        facts({ action: 'deleted', releaseId: '200' }),
        NOW,
      ),
    );
    expect(await releases.get(componentReleaseKey('1313911960'))).toBeNull();
  });

  it('does not persist surplus provider fields through the codec', async () => {
    const store = createMemoryStore();
    const releases = store.collection(componentReleaseCollection());
    await applyReleaseProjection(
      store,
      decideReleaseProjection(facts(), NOW),
    );
    const current = await releases.get(componentReleaseKey('1313911960'));
    expect(current).toEqual({
      repositoryId: '1313911960',
      repositoryName: 'webhooks',
      releaseId: '100',
      tagName: 'v0.1.0',
      publishedAt: '2026-07-28T12:00:00.000Z',
      releaseUrl: 'https://github.com/pegma-dev/webhooks/releases/tag/v0.1.0',
      observedAt: NOW,
    });
  });
});
