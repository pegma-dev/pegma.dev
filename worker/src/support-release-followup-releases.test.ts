import {
  createMemoryStore,
  type CollectionDefinition,
  type CollectionStore,
  type Store,
} from '@pegma/storage-core';
import { describe, expect, it } from 'vitest';
import {
  componentReleaseCollection,
  componentReleaseKey,
} from './component-release';
import { handleGitHubReleaseWebhook } from './github-release-webhook';
import { supportFollowupReleaseObservations } from './support-release-followup-releases';
import {
  countCurrentReleases,
  runReleaseReconciliation,
} from './release-reconciliation';
import { buildReleasesResponse } from './releases-api';
import { humanLatch } from './support-human-control-fixtures';

const repositoryId = '1313911960';
const now = '2026-11-13T12:00:00.000Z';
const secret = 'FICTIONAL_RELEASE_TRANSITION_SECRET';
const config = {
  webhookSecret: secret,
  organizationId: '309286193',
  allowedRepositoryIds: new Set([repositoryId]),
};
const logger = { log() {} };

async function fixture() {
  const backing = createMemoryStore();
  const hooks: {
    beforeDelete?: () => Promise<void>;
    afterDelete?: () => Promise<void>;
    refuseTransaction?: () => boolean;
  } = {};
  const store: Store = {
    collection<Value>(
      definition: CollectionDefinition<Value>,
    ): CollectionStore<Value> {
      const actual = backing.collection(definition);
      if (definition.name !== 'componentReleases') return actual;
      return {
        ...actual,
        async deleteIfUnchanged(key, version) {
          await hooks.beforeDelete?.();
          const deleted = await actual.deleteIfUnchanged(key, version);
          if (deleted) await hooks.afterDelete?.();
          return deleted;
        },
        async transact(partition, actions) {
          const deletion = actions.some(
            (action) =>
              action.action === 'delete' && action.key.id === repositoryId,
          );
          if (deletion) await hooks.beforeDelete?.();
          if (hooks.refuseTransaction?.())
            return { committed: false, reason: 'changed' };
          const result = await actual.transact(partition, actions);
          if (deletion && result.committed) await hooks.afterDelete?.();
          return result;
        },
      };
    },
  };
  let delivery = 0;
  async function request(action: 'published' | 'unpublished') {
    const body = JSON.stringify({
      action,
      organization: { id: 309286193 },
      repository: {
        id: Number(repositoryId),
        name: 'webhooks',
        owner: { id: 309286193 },
      },
      release: {
        id: 9001,
        tag_name: 'v0.2.0',
        published_at: now,
        updated_at: new Date(Date.parse(now) + ++delivery).toISOString(),
        draft: false,
        prerelease: false,
      },
    });
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
    );
    return new Request('https://pegma.dev/api/webhooks/github/releases', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'release',
        'X-GitHub-Delivery': crypto.randomUUID(),
        'X-Hub-Signature-256':
          'sha256=' +
          [...signature]
            .map((value) => value.toString(16).padStart(2, '0'))
            .join(''),
      },
      body,
    });
  }
  const journal = store.collection(supportFollowupReleaseObservations);
  const epochKey = supportFollowupReleaseObservations.key({
    repositoryId,
    releaseId: '9001',
    epoch: 1,
    state: 'active',
    fingerprint: 'fixture-key-only',
  });
  const send = (request: Request, tracking = true) =>
    handleGitHubReleaseWebhook({
      request,
      store,
      config,
      logger,
      now,
      followupTracking: () => tracking,
    });
  expect((await send(await request('published'))).status).toBe(204);
  return { store, backing, hooks, request, send, journal, epochKey };
}

describe('atomic authenticated release projection epochs', () => {
  it('bounds competing epoch CAS attempts without partially deleting a projection', async () => {
    const f = await fixture();
    const before = await f.journal.get(f.epochKey);
    let attempts = 0;
    f.hooks.refuseTransaction = () => { attempts += 1; return true; };
    expect((await f.send(await f.request('unpublished'))).status).toBe(500);
    expect(attempts).toBe(3);
    expect(await f.journal.get(f.epochKey)).toEqual(before);
    expect((await f.store.collection(componentReleaseCollection()).get(componentReleaseKey(repositoryId)))?.releaseId).toBe('9001');
  });

  it('retains withdrawal and republication while the withdrawal is held after its projection commit', async () => {
    const f = await fixture();
    const initial = await f.journal.get(f.epochKey);
    const reached = humanLatch(),
      resume = humanLatch();
    f.hooks.afterDelete = async () => {
      reached.release();
      await resume.ready;
    };
    const withdrawal = f.send(await f.request('unpublished'));
    await reached.ready;
    try {
      expect((await f.send(await f.request('published'))).status).toBe(204);
      expect(
        (
          await f.store
            .collection(componentReleaseCollection())
            .get(componentReleaseKey(repositoryId))
        )?.releaseId,
      ).toBe('9001');
      expect((await f.journal.get(f.epochKey))?.epoch).toBeGreaterThan(
        initial!.epoch,
      );
    } finally {
      resume.release();
    }
    expect((await withdrawal).status).toBe(204);
    expect(await f.journal.get(f.epochKey)).toMatchObject({
      epoch: initial!.epoch + 2,
      state: 'active',
    });
  });

  it.each(['before', 'after'] as const)(
    'recovers an identical signed delivery after failure %s the atomic withdrawal commit',
    async (phase) => {
      const f = await fixture();
      const initial = await f.journal.get(f.epochKey);
      let fail = true;
      const fault = async () => {
        if (fail) {
          fail = false;
          throw new Error('Fictional process failure');
        }
      };
      if (phase === 'before') f.hooks.beforeDelete = fault;
      else f.hooks.afterDelete = fault;
      const request = await f.request('unpublished');
      const body = await request.text();
      const replay = () =>
        new Request(request.url, {
          method: 'POST',
          headers: request.headers,
          body,
        });
      expect((await f.send(replay())).status).toBe(500);
      expect((await f.journal.get(f.epochKey))?.epoch).toBe(
        initial!.epoch + (phase === 'after' ? 1 : 0),
      );
      const projection = await f.store
        .collection(componentReleaseCollection())
        .get(componentReleaseKey(repositoryId));
      if (phase === 'after') expect(projection).toBeNull();
      else expect(projection?.releaseId).toBe('9001');
      expect((await f.send(replay())).status).toBe(204);
      expect(
        await f.store
          .collection(componentReleaseCollection())
          .get(componentReleaseKey(repositoryId)),
      ).toBeNull();
      expect(await f.journal.get(f.epochKey)).toMatchObject({
        epoch: initial!.epoch + 1,
        state: 'withdrawn',
      });
      expect((await f.send(replay())).status).toBe(204);
      expect((await f.journal.get(f.epochKey))?.epoch).toBe(initial!.epoch + 1);
    },
  );

  it('CAS-fences a delayed withdrawal against a concurrent same-fact refresh without inventing a delete version', async () => {
    const f = await fixture();
    const initial = await f.journal.getVersioned(f.epochKey);
    const reached = humanLatch(),
      resume = humanLatch();
    let attempts = 0;
    f.hooks.beforeDelete = async () => {
      if (++attempts === 1) {
        reached.release();
        await resume.ready;
      }
    };
    const withdrawal = f.send(await f.request('unpublished'));
    await reached.ready;
    try {
      expect((await f.send(await f.request('published'))).status).toBe(204);
      const refreshed = await f.journal.getVersioned(f.epochKey);
      expect(refreshed?.value.epoch).toBe(initial!.value.epoch);
      expect(refreshed?.version).not.toBe(initial!.version);
    } finally {
      resume.release();
    }
    expect((await withdrawal).status).toBe(204);
    expect(attempts).toBe(2);
    expect(await f.journal.get(f.epochKey)).toMatchObject({
      epoch: initial!.value.epoch + 1,
      state: 'withdrawn',
    });
  });

  it('tracks OFF/ON transitions and reconciliation clears while keeping epoch rows out of public DTOs and health counts', async () => {
    const f = await fixture();
    const initial = await f.journal.get(f.epochKey);
    expect((await f.send(await f.request('unpublished'), false)).status).toBe(
      204,
    );
    expect((await f.send(await f.request('published'), false)).status).toBe(
      204,
    );
    expect((await f.journal.get(f.epochKey))?.epoch).toBe(initial!.epoch + 2);
    expect(await countCurrentReleases(f.store)).toBe(1);
    const dto = await buildReleasesResponse(
      f.store,
      { allowedRepositoryIds: config.allowedRepositoryIds },
      now,
    );
    expect(JSON.stringify(dto)).not.toContain('followup-epoch');
    expect(JSON.stringify(dto)).not.toContain('fingerprint');
    const beforeRefresh = await f.journal.get(f.epochKey);
    await runReleaseReconciliation({
      store: f.store,
      logger,
      config: { allowedRepositoryIds: config.allowedRepositoryIds },
      now,
      fetchImpl: async () => new Response(null, { status: 304 }),
    });
    expect((await f.journal.get(f.epochKey))?.epoch).toBe(beforeRefresh!.epoch);
    await runReleaseReconciliation({
      store: f.store,
      logger,
      config: { allowedRepositoryIds: config.allowedRepositoryIds },
      now,
      fetchImpl: async () => new Response(null, { status: 404 }),
    });
    expect((await f.journal.get(f.epochKey))?.state).toBe('withdrawn');
    expect(await countCurrentReleases(f.store)).toBe(0);
    expect(
      JSON.stringify(
        await buildReleasesResponse(
          f.store,
          { allowedRepositoryIds: config.allowedRepositoryIds },
          now,
        ),
      ),
    ).not.toContain('followup-epoch');
  });
});
