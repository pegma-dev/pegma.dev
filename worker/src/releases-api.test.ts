import { createMemoryStore } from '@pegma/storage-core';
import type { Logger } from '@pegma/spine';
import { describe, expect, it, vi } from 'vitest';
import {
  componentReleaseCollection,
  componentReleaseKey,
} from './component-release';
import { RELEASE_CATALOG } from './release-catalog';
import {
  RELEASES_MAX_AGE_SECONDS,
  RELEASES_SCHEMA,
  buildReleasesResponse,
  handleGetReleases,
  toPublicCurrentRelease,
  type ReleasesReadConfig,
} from './releases-api';

const logger: Logger = { log: vi.fn() };
const NOW = '2026-07-28T20:00:00.000Z';
const WEBHOOKS_ID = '1313911960';
const SPINE_ID = '1312512520';

const config: ReleasesReadConfig = {
  allowedRepositoryIds: new Set([SPINE_ID, WEBHOOKS_ID]),
};

async function seedWebhooksRelease(
  store: ReturnType<typeof createMemoryStore>,
): Promise<void> {
  const releases = store.collection(componentReleaseCollection());
  await releases.update(componentReleaseKey(WEBHOOKS_ID), () => ({
    action: 'write',
    value: {
      repositoryId: WEBHOOKS_ID,
      repositoryName: 'webhooks',
      releaseId: '3001',
      tagName: 'v0.0.1',
      publishedAt: '2026-07-20T12:00:00.000Z',
      releaseUrl: 'https://github.com/pegma-dev/webhooks/releases/tag/v0.0.1',
      observedAt: '2026-07-28T18:00:00.000Z',
    },
  }));
}

describe('toPublicCurrentRelease', () => {
  it('accepts only pegma-dev release URLs that match tag and repo', () => {
    expect(
      toPublicCurrentRelease({
        repositoryId: WEBHOOKS_ID,
        repositoryName: 'webhooks',
        releaseId: '1',
        tagName: 'v1.0.0',
        publishedAt: NOW,
        releaseUrl: 'https://github.com/pegma-dev/webhooks/releases/tag/v1.0.0',
        observedAt: NOW,
      }),
    ).toEqual({
      releaseId: '1',
      tagName: 'v1.0.0',
      publishedAt: NOW,
      releaseUrl: 'https://github.com/pegma-dev/webhooks/releases/tag/v1.0.0',
      observedAt: NOW,
    });

    expect(
      toPublicCurrentRelease({
        repositoryId: WEBHOOKS_ID,
        repositoryName: 'webhooks',
        releaseId: '1',
        tagName: 'v1.0.0',
        publishedAt: NOW,
        releaseUrl: 'https://evil.example/payload',
        observedAt: NOW,
      }),
    ).toBeNull();
  });
});

describe('buildReleasesResponse', () => {
  it('returns schema, observation time, catalog order, and empty slots', async () => {
    const store = createMemoryStore();
    await seedWebhooksRelease(store);

    const body = await buildReleasesResponse(store, config, NOW);

    expect(body.schema).toBe(RELEASES_SCHEMA);
    expect(body.observedAt).toBe(NOW);
    expect(body.releases.map((entry) => entry.repositoryName)).toEqual([
      'spine',
      'webhooks',
    ]);
    expect(body.releases[0]).toEqual({
      repositoryId: SPINE_ID,
      repositoryName: 'spine',
      current: null,
    });
    expect(body.releases[1]?.current).toEqual({
      releaseId: '3001',
      tagName: 'v0.0.1',
      publishedAt: '2026-07-20T12:00:00.000Z',
      releaseUrl: 'https://github.com/pegma-dev/webhooks/releases/tag/v0.0.1',
      observedAt: '2026-07-28T18:00:00.000Z',
    });
  });

  it('never includes non-allowlisted catalog repositories', async () => {
    const store = createMemoryStore();
    const releases = store.collection(componentReleaseCollection());
    const outsider = RELEASE_CATALOG.find(
      (entry) => entry.repositoryName === 'identity',
    )!;
    await releases.update(componentReleaseKey(outsider.repositoryId), () => ({
      action: 'write',
      value: {
        repositoryId: outsider.repositoryId,
        repositoryName: outsider.repositoryName,
        releaseId: '9',
        tagName: 'v9.9.9',
        publishedAt: NOW,
        releaseUrl: `https://github.com/pegma-dev/${outsider.repositoryName}/releases/tag/v9.9.9`,
        observedAt: NOW,
      },
    }));

    const body = await buildReleasesResponse(store, config, NOW);
    expect(
      body.releases.some((entry) => entry.repositoryName === 'identity'),
    ).toBe(false);
  });

  it('omits current when stored URL is not a safe pegma-dev link', async () => {
    const store = createMemoryStore();
    const releases = store.collection(componentReleaseCollection());
    await releases.update(componentReleaseKey(WEBHOOKS_ID), () => ({
      action: 'write',
      value: {
        repositoryId: WEBHOOKS_ID,
        repositoryName: 'webhooks',
        releaseId: '1',
        tagName: 'v1.0.0',
        publishedAt: NOW,
        releaseUrl: 'https://github.com/not-pegma/webhooks/releases/tag/v1.0.0',
        observedAt: NOW,
      },
    }));

    const body = await buildReleasesResponse(store, config, NOW);
    const webhooks = body.releases.find(
      (entry) => entry.repositoryId === WEBHOOKS_ID,
    );
    expect(webhooks?.current).toBeNull();
  });
});

describe('handleGetReleases', () => {
  it('returns JSON with cache headers, etag, and nosniff', async () => {
    const store = createMemoryStore();
    await seedWebhooksRelease(store);

    const response = await handleGetReleases({
      request: new Request('https://pegma.dev/api/releases', { method: 'GET' }),
      store,
      logger,
      config,
      now: NOW,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe(
      'application/json; charset=utf-8',
    );
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Cache-Control')).toBe(
      `public, max-age=${RELEASES_MAX_AGE_SECONDS}`,
    );
    expect(response.headers.get('ETag')).toMatch(/^W\/"[0-9a-f]{32}"$/);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();

    const body = (await response.json()) as {
      schema: string;
      releases: unknown[];
    };
    expect(body.schema).toBe(RELEASES_SCHEMA);
    expect(body.releases).toHaveLength(2);
  });

  it('returns 304 when If-None-Match matches', async () => {
    const store = createMemoryStore();
    await seedWebhooksRelease(store);

    const first = await handleGetReleases({
      request: new Request('https://pegma.dev/api/releases', { method: 'GET' }),
      store,
      logger,
      config,
      now: NOW,
    });
    const etag = first.headers.get('ETag');
    expect(etag).toBeTruthy();

    const second = await handleGetReleases({
      request: new Request('https://pegma.dev/api/releases', {
        method: 'GET',
        headers: { 'If-None-Match': etag! },
      }),
      store,
      logger,
      config,
      now: NOW,
    });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
  });

  it('returns 304 when If-None-Match is *', async () => {
    const store = createMemoryStore();
    await seedWebhooksRelease(store);

    const response = await handleGetReleases({
      request: new Request('https://pegma.dev/api/releases', {
        method: 'GET',
        headers: { 'If-None-Match': '*' },
      }),
      store,
      logger,
      config,
      now: NOW,
    });
    expect(response.status).toBe(304);
  });

  it('validates public URL against the catalog display name', async () => {
    const store = createMemoryStore();
    const releases = store.collection(componentReleaseCollection());
    await releases.update(componentReleaseKey(WEBHOOKS_ID), () => ({
      action: 'write',
      value: {
        repositoryId: WEBHOOKS_ID,
        repositoryName: 'renamed-webhooks',
        releaseId: '3001',
        tagName: 'v0.0.1',
        publishedAt: '2026-07-20T12:00:00.000Z',
        releaseUrl:
          'https://github.com/pegma-dev/webhooks/releases/tag/v0.0.1',
        observedAt: '2026-07-28T18:00:00.000Z',
      },
    }));

    const body = await buildReleasesResponse(store, config, NOW);
    const webhooks = body.releases.find(
      (entry) => entry.repositoryId === WEBHOOKS_ID,
    );
    expect(webhooks?.repositoryName).toBe('webhooks');
    expect(webhooks?.current?.releaseUrl).toBe(
      'https://github.com/pegma-dev/webhooks/releases/tag/v0.0.1',
    );
  });

  it('rejects non-GET methods without reading storage side effects', async () => {
    const store = createMemoryStore();
    const response = await handleGetReleases({
      request: new Request('https://pegma.dev/api/releases', { method: 'POST' }),
      store,
      logger,
      config,
      now: NOW,
    });
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET, HEAD');
  });

  it('never serializes receipt or delivery internals', async () => {
    const store = createMemoryStore();
    await seedWebhooksRelease(store);
    const response = await handleGetReleases({
      request: new Request('https://pegma.dev/api/releases', { method: 'GET' }),
      store,
      logger,
      config,
      now: NOW,
    });
    const text = await response.text();
    expect(text).not.toMatch(/delivery|quarantine|receipt|webhookSecret|payload/i);
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'observedAt',
      'releases',
      'schema',
    ]);
  });
});
