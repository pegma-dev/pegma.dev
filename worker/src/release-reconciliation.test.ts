import { createMemoryStore } from '@pegma/storage-core';
import type { Logger } from '@pegma/spine';
import { describe, expect, it, vi } from 'vitest';
import {
  componentReleaseCollection,
  componentReleaseKey,
} from './component-release';
import { readReleaseOpsState } from './release-ops-state';
import {
  backfillReleases,
  githubLatestToFacts,
  runReleaseReconciliation,
} from './release-reconciliation';

const logger: Logger = { log: vi.fn() };
const NOW = '2026-07-28T21:00:00.000Z';
const WEBHOOKS_ID = '1313911960';
const SPINE_ID = '1312512520';

const config = {
  allowedRepositoryIds: new Set([SPINE_ID, WEBHOOKS_ID]),
};

const webhooksLatest = {
  id: 9001,
  tag_name: 'v0.2.0',
  published_at: '2026-07-27T10:00:00.000Z',
  draft: false,
  prerelease: false,
  html_url: 'https://evil.example/ignore',
};

describe('githubLatestToFacts', () => {
  it('maps a stable latest release and ignores payload URLs', () => {
    const facts = githubLatestToFacts(
      { repositoryId: WEBHOOKS_ID, repositoryName: 'webhooks' },
      webhooksLatest,
    );
    expect(facts).toEqual({
      action: 'published',
      repositoryId: WEBHOOKS_ID,
      repositoryName: 'webhooks',
      releaseId: '9001',
      tagName: 'v0.2.0',
      publishedAt: '2026-07-27T10:00:00.000Z',
      draft: false,
      prerelease: false,
    });
  });

  it('rejects drafts and prereleases', () => {
    expect(
      githubLatestToFacts(
        { repositoryId: WEBHOOKS_ID, repositoryName: 'webhooks' },
        { ...webhooksLatest, prerelease: true },
      ),
    ).toBeNull();
  });
});

describe('runReleaseReconciliation', () => {
  it('backfills stable releases and records success markers', async () => {
    const store = createMemoryStore();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`/repositories/${WEBHOOKS_ID}/releases/latest`)) {
        return new Response(JSON.stringify(webhooksLatest), {
          status: 200,
          headers: {
            ETag: '"webhooks-etag"',
            'Content-Type': 'application/json',
          },
        });
      }
      if (url.includes(`/repositories/${SPINE_ID}/releases/latest`)) {
        return new Response('Not Found', { status: 404 });
      }
      return new Response('unexpected', { status: 500 });
    });

    const summary = await backfillReleases({
      store,
      logger,
      config,
      now: NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(summary).toEqual({
      examined: 2,
      upserted: 1,
      cleared: 0,
      notModified: 0,
      failed: 0,
    });

    const releases = store.collection(componentReleaseCollection());
    expect(await releases.get(componentReleaseKey(WEBHOOKS_ID))).toEqual({
      repositoryId: WEBHOOKS_ID,
      repositoryName: 'webhooks',
      releaseId: '9001',
      tagName: 'v0.2.0',
      publishedAt: '2026-07-27T10:00:00.000Z',
      releaseUrl: 'https://github.com/pegma-dev/webhooks/releases/tag/v0.2.0',
      observedAt: NOW,
    });
    expect(await releases.get(componentReleaseKey(SPINE_ID))).toBeNull();

    const ops = await readReleaseOpsState(store);
    expect(ops.lastSuccessfulReconciliationAt).toBe(NOW);
    expect(ops.repositoryEtags[WEBHOOKS_ID]).toBe('"webhooks-etag"');
  });

  it('honors If-None-Match and clears when GitHub has no stable release', async () => {
    const store = createMemoryStore();
    const releases = store.collection(componentReleaseCollection());
    await releases.update(componentReleaseKey(WEBHOOKS_ID), () => ({
      action: 'write',
      value: {
        repositoryId: WEBHOOKS_ID,
        repositoryName: 'webhooks',
        releaseId: '1',
        tagName: 'v0.1.0',
        publishedAt: '2026-07-01T00:00:00.000Z',
        releaseUrl: 'https://github.com/pegma-dev/webhooks/releases/tag/v0.1.0',
        observedAt: '2026-07-01T00:00:00.000Z',
      },
    }));

    // Seed etag via a successful run first.
    await runReleaseReconciliation({
      store,
      logger,
      config: { allowedRepositoryIds: new Set([WEBHOOKS_ID]) },
      now: '2026-07-28T12:00:00.000Z',
      fetchImpl: (async () =>
        new Response(JSON.stringify(webhooksLatest), {
          status: 200,
          headers: { ETag: '"etag-1"' },
        })) as unknown as typeof fetch,
    });

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('If-None-Match')).toBe('"etag-1"');
      // Simulate unpublish of the only stable release.
      return new Response('Not Found', { status: 404 });
    });

    const summary = await runReleaseReconciliation({
      store,
      logger,
      config: { allowedRepositoryIds: new Set([WEBHOOKS_ID]) },
      now: NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(summary.cleared).toBe(1);
    expect(await releases.get(componentReleaseKey(WEBHOOKS_ID))).toBeNull();
  });

  it('does not mark global success when a repository fails', async () => {
    const store = createMemoryStore();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`/repositories/${WEBHOOKS_ID}/`)) {
        return new Response(JSON.stringify(webhooksLatest), {
          status: 200,
          headers: { ETag: '"ok"' },
        });
      }
      return new Response('rate limited', { status: 403 });
    });

    const summary = await runReleaseReconciliation({
      store,
      logger,
      config,
      now: NOW,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(summary.failed).toBe(1);
    expect(summary.upserted).toBe(1);
    const ops = await readReleaseOpsState(store);
    expect(ops.lastSuccessfulReconciliationAt).toBeNull();
    expect(ops.repositoryEtags[WEBHOOKS_ID]).toBe('"ok"');
  });

  it('returns not_modified without rewriting projection on 304', async () => {
    const store = createMemoryStore();
    await runReleaseReconciliation({
      store,
      logger,
      config: { allowedRepositoryIds: new Set([WEBHOOKS_ID]) },
      now: '2026-07-28T12:00:00.000Z',
      fetchImpl: (async () =>
        new Response(JSON.stringify(webhooksLatest), {
          status: 200,
          headers: { ETag: '"etag-1"' },
        })) as unknown as typeof fetch,
    });

    const summary = await runReleaseReconciliation({
      store,
      logger,
      config: { allowedRepositoryIds: new Set([WEBHOOKS_ID]) },
      now: NOW,
      fetchImpl: (async () =>
        new Response(null, { status: 304, headers: { ETag: '"etag-1"' } })) as unknown as typeof fetch,
    });

    expect(summary.notModified).toBe(1);
    const release = await store
      .collection(componentReleaseCollection())
      .get(componentReleaseKey(WEBHOOKS_ID));
    // 304 still refreshes observedAt so UI staleness tracks successful recon.
    expect(release?.observedAt).toBe(NOW);
    expect(release?.tagName).toBe('v0.2.0');
  });

  it('fails closed on 2xx bodies that are not a usable stable release', async () => {
    const store = createMemoryStore();
    const releases = store.collection(componentReleaseCollection());
    await releases.update(componentReleaseKey(WEBHOOKS_ID), () => ({
      action: 'write',
      value: {
        repositoryId: WEBHOOKS_ID,
        repositoryName: 'webhooks',
        releaseId: '1',
        tagName: 'v0.1.0',
        publishedAt: '2026-07-01T00:00:00.000Z',
        releaseUrl: 'https://github.com/pegma-dev/webhooks/releases/tag/v0.1.0',
        observedAt: '2026-07-01T00:00:00.000Z',
      },
    }));

    const summary = await runReleaseReconciliation({
      store,
      logger,
      config: { allowedRepositoryIds: new Set([WEBHOOKS_ID]) },
      now: NOW,
      fetchImpl: (async () =>
        new Response(JSON.stringify({ id: 'not-a-number' }), {
          status: 200,
          headers: { ETag: '"bad"' },
        })) as unknown as typeof fetch,
    });

    expect(summary.failed).toBe(1);
    expect(await releases.get(componentReleaseKey(WEBHOOKS_ID))).not.toBeNull();
  });

  it('does not 304-mask a missed delete after a later webhook projection', async () => {
    const store = createMemoryStore();
    // Recon caches etag for A.
    await runReleaseReconciliation({
      store,
      logger,
      config: { allowedRepositoryIds: new Set([WEBHOOKS_ID]) },
      now: '2026-07-28T10:00:00.000Z',
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            id: 100,
            tag_name: 'v0.1.0',
            published_at: '2026-06-01T00:00:00.000Z',
            draft: false,
            prerelease: false,
          }),
          { status: 200, headers: { ETag: '"etag-a"' } },
        )) as unknown as typeof fetch,
    });

    // Webhook later projects B and must drop etag-a.
    const releases = store.collection(componentReleaseCollection());
    await releases.update(componentReleaseKey(WEBHOOKS_ID), () => ({
      action: 'write',
      value: {
        repositoryId: WEBHOOKS_ID,
        repositoryName: 'webhooks',
        releaseId: '200',
        tagName: 'v0.2.0',
        publishedAt: '2026-07-20T00:00:00.000Z',
        releaseUrl: 'https://github.com/pegma-dev/webhooks/releases/tag/v0.2.0',
        observedAt: '2026-07-28T11:00:00.000Z',
      },
    }));
    const { invalidateReleaseRepositoryEtag } = await import(
      './release-ops-state'
    );
    await invalidateReleaseRepositoryEtag(store, WEBHOOKS_ID);

    // Missed delete of B: GitHub is A again. Without ETag invalidation this
    // would 304 and leave B; with invalidation we re-fetch A.
    let sawIfNoneMatch = false;
    const summary = await runReleaseReconciliation({
      store,
      logger,
      config: { allowedRepositoryIds: new Set([WEBHOOKS_ID]) },
      now: NOW,
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        if (headers.get('If-None-Match')) {
          sawIfNoneMatch = true;
        }
        return new Response(
          JSON.stringify({
            id: 100,
            tag_name: 'v0.1.0',
            published_at: '2026-06-01T00:00:00.000Z',
            draft: false,
            prerelease: false,
          }),
          { status: 200, headers: { ETag: '"etag-a"' } },
        );
      }) as unknown as typeof fetch,
    });

    expect(sawIfNoneMatch).toBe(false);
    expect(summary.upserted).toBe(1);
    expect(await releases.get(componentReleaseKey(WEBHOOKS_ID))).toMatchObject({
      releaseId: '100',
      tagName: 'v0.1.0',
    });
  });

  it('replaces a local newer release with GitHub preceding stable after delete', async () => {
    const store = createMemoryStore();
    const releases = store.collection(componentReleaseCollection());
    // Local still shows a release that was deleted on GitHub (missed webhook).
    await releases.update(componentReleaseKey(WEBHOOKS_ID), () => ({
      action: 'write',
      value: {
        repositoryId: WEBHOOKS_ID,
        repositoryName: 'webhooks',
        releaseId: '9999',
        tagName: 'v9.9.9',
        publishedAt: '2026-07-28T00:00:00.000Z',
        releaseUrl: 'https://github.com/pegma-dev/webhooks/releases/tag/v9.9.9',
        observedAt: '2026-07-28T00:00:00.000Z',
      },
    }));

    const preceding = {
      id: 100,
      tag_name: 'v0.1.0',
      published_at: '2026-06-01T00:00:00.000Z',
      draft: false,
      prerelease: false,
    };

    const summary = await runReleaseReconciliation({
      store,
      logger,
      config: { allowedRepositoryIds: new Set([WEBHOOKS_ID]) },
      now: NOW,
      fetchImpl: (async () =>
        new Response(JSON.stringify(preceding), {
          status: 200,
          headers: { ETag: '"preceding"' },
        })) as unknown as typeof fetch,
    });

    expect(summary.upserted).toBe(1);
    expect(await releases.get(componentReleaseKey(WEBHOOKS_ID))).toEqual({
      repositoryId: WEBHOOKS_ID,
      repositoryName: 'webhooks',
      releaseId: '100',
      tagName: 'v0.1.0',
      publishedAt: '2026-06-01T00:00:00.000Z',
      releaseUrl: 'https://github.com/pegma-dev/webhooks/releases/tag/v0.1.0',
      observedAt: NOW,
    });
  });
});
