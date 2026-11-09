import { resolveAccess } from '@pegma/authorization-core';
import {
  createKnowledgeBaseApplication,
  retrievalRecords,
} from '@pegma/knowledge-base-application';
import {
  articleKinds,
  knowledgePermissions,
} from '@pegma/knowledge-base-contracts';
import {
  createMemoryStore,
  defineCollection,
  type CollectionDefinition,
  type CollectionStore,
  type Store,
  type StoredRecord,
} from '@pegma/storage-core';
import { describe, expect, it, vi } from 'vitest';
import { createKnowledgeRetrievalReady } from './knowledge-retrieval-ready';

const clock = { now: () => '2026-11-08T12:00:00.000Z' };
const actor = resolveAccess(
  { principalId: 'synthetic-ready-author' },
  { version: 'test', defaults: Object.values(knowledgePermissions) },
);
const raw = defineCollection<StoredRecord>({
  name: 'pegma-dev.knowledge-retrieval-ready.v1',
  key: (value) => ({ partition: 'knowledge', id: String(value.id) }),
  codec: { encode: (value) => value, decode: (value) => value },
});
const bookmarks = defineCollection<StoredRecord>({
  name: 'pegma-dev-maintenance',
  key: (value) => ({
    partition: String(value.partition),
    id: String(value.id),
  }),
  codec: { encode: (value) => value, decode: (value) => value },
});
const key = { partition: 'knowledge', id: 'retrieval-ready' };
function barrier() {
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}
interface Hooks {
  failPut?: boolean;
  failRepair?: boolean;
  failCheckpoint?: boolean;
  afterScan?: () => Promise<void>;
  beforeDelete?: () => Promise<void>;
}
function observe(backing: Store, hooks: Hooks = {}) {
  const calls = { collections: 0, scans: 0, puts: 0, deletes: 0, attempts: 0 };
  const store: Store = {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      calls.collections += 1;
      const target = backing.collection(definition);
      return {
        ...target,
        async put(value) {
          if (definition.name === raw.name) {
            calls.puts += 1;
            if (hooks.failPut) throw new Error('Synthetic lost enqueue.');
          }
          return target.put(value);
        },
        async scan(options) {
          if (definition.name !== raw.name) return target.scan(options);
          calls.scans += 1;
          expect(options.limit).toBe(1);
          const page = await target.scan(options);
          await hooks.afterScan?.();
          return page;
        },
        async deleteIfUnchanged(key, version) {
          if (definition.name === raw.name) {
            calls.deletes += 1;
            await hooks.beforeDelete?.();
          }
          return target.deleteIfUnchanged(key, version);
        },
        async update(key, decide, options) {
          if (definition.name === bookmarks.name && hooks.failCheckpoint)
            throw new Error('Synthetic checkpoint failure.');
          return target.update(key, decide, options);
        },
        async transact(partition, actions) {
          if (definition.name === retrievalRecords.name) {
            calls.attempts += 1;
            if (hooks.failRepair)
              throw new Error('Synthetic projection outage.');
          }
          return target.transact(partition, actions);
        },
      };
    },
  };
  return { store, calls };
}
function runner(store: Store, isEnabled = () => true) {
  const logger = { log: vi.fn() };
  return {
    logger,
    ready: createKnowledgeRetrievalReady({ store, clock, logger, isEnabled }),
  };
}
async function seed(store: Store, articleIds: readonly string[]) {
  const app = createKnowledgeBaseApplication({ store, clock });
  const collection = await app.createCollection(actor, {
    commandId: 'collection',
    correlationId: 'test',
    expectedGeneration: 0,
    collectionId: 'guides',
    name: 'Synthetic guides',
  });
  await app.putValidationPolicy(actor, {
    commandId: 'policy',
    correlationId: 'test',
    expectedGeneration: 0,
    policy: {
      id: 'policy',
      version: 1,
      requirements: [
        ...articleKinds.map((kind) => ({
          id: kind + '-content',
          kind,
          testKind: 'content',
          maxAgeMilliseconds: 3_600_000,
          trustedRunnerIds: ['runner'],
        })),
        {
          id: 'walkthrough-workflow',
          kind: 'walkthrough',
          testKind: 'workflow',
          maxAgeMilliseconds: 3_600_000,
          trustedRunnerIds: ['runner'],
        },
      ],
    },
  });
  await app.putGovernanceConfiguration(actor, {
    commandId: 'governance',
    correlationId: 'test',
    expectedGeneration: collection.value.generation,
    collectionId: 'guides',
    configuration: {
      validationPolicy: { id: 'policy', version: 1 },
      expectedStagingBuildId: 'build',
      trustedAttesterIds: ['staff'],
    },
  });
  for (const articleId of articleIds)
    await app.createDraft(actor, {
      commandId: 'create-' + articleId,
      correlationId: 'test',
      expectedGeneration: 0,
      articleId,
      collectionId: 'guides',
      draft: {
        kind: 'explanation',
        title: 'Synthetic guide',
        summary: 'Synthetic summary',
        content: { format: 'plain_text', text: 'Synthetic instructions.' },
        tags: [],
        applicability: {
          productId: 'test',
          productVersion: '1',
          buildId: 'build',
        },
      },
    });
  return app;
}
async function rows(store: Store) {
  return (await store.collection(raw).scan({ limit: 100 })).records;
}

describe('one-step knowledge ready hints', () => {
  it('coalesces one body-free overwrite per article and deletes only a converged authoritative result', async () => {
    const backing = createMemoryStore();
    const app = await seed(backing, ['article/export']);
    const seen = observe(backing);
    await runner(seen.store).ready.enqueue('article/export');
    await runner(seen.store).ready.enqueue('article/export');
    expect(seen.calls.puts).toBe(2);
    const queued = await rows(backing);
    expect(queued).toHaveLength(1);
    expect(Object.keys(queued[0]!.value).sort()).toEqual([
      'articleId',
      'format',
      'id',
      'requestedAt',
    ]);
    expect(queued[0]!.key.id).toMatch(/^[a-f0-9]{64}$/);
    for (let tick = 0; tick < 16 && (await rows(backing)).length; tick++) {
      const before = { ...seen.calls };
      await runner(seen.store).ready.runPage();
      expect(seen.calls.scans - before.scans).toBe(1);
      expect(seen.calls.attempts - before.attempts).toBeLessThanOrEqual(1);
    }
    expect(await rows(backing)).toEqual([]);
    expect(
      await app.getArticleIndexStatus(actor, { articleId: 'article/export' }),
    ).toMatchObject({ status: 'ready', indexed: false });
  });

  it('keeps failed work, rotates to another hint, and recovers across reconstructed workers', async () => {
    const backing = createMemoryStore();
    await seed(backing, ['first', 'second']);
    const hooks: Hooks = { failRepair: true };
    const seen = observe(backing, hooks);
    for (const id of ['first', 'second'])
      await runner(seen.store).ready.enqueue(id);
    await runner(seen.store).ready.runPage();
    expect(await rows(backing)).toHaveLength(2);
    const saved = await backing.collection(bookmarks).get(key);
    expect(typeof saved?.cursor).toBe('string');
    hooks.failRepair = false;
    for (let tick = 0; tick < 32 && (await rows(backing)).length; tick++)
      await runner(seen.store).ready.runPage();
    expect(await rows(backing)).toEqual([]);
  });

  it('preserves a newer enqueue while an old worker awaits conditional deletion', async () => {
    const backing = createMemoryStore();
    await seed(backing, ['article']);
    await runner(backing).ready.enqueue('article');
    const entered = barrier();
    const resume = barrier();
    const seen = observe(backing, {
      beforeDelete: async () => {
        entered.release();
        await resume.ready;
      },
    });
    let complete = false;
    const process = (async () => {
      for (let tick = 0; tick < 16 && !complete; tick++)
        await runner(seen.store).ready.runPage();
    })();
    await entered.ready;
    complete = true;
    const prior = (await rows(backing))[0];
    await runner(backing).ready.enqueue('article');
    const newer = (await rows(backing))[0];
    expect(newer?.version).not.toBe(prior?.version);
    resume.release();
    await process;
    expect(await rows(backing)).toEqual([newer]);
    await runner(backing).ready.runPage();
    if ((await rows(backing)).length) await runner(backing).ready.runPage();
    expect(await rows(backing)).toEqual([]);
  });

  it('fences stale null-cycle checkpoint completion and retains the prior cursor on checkpoint failure', async () => {
    const backing = createMemoryStore();
    const entered = barrier();
    const resume = barrier();
    const seen = observe(backing, {
      afterScan: async () => {
        entered.release();
        await resume.ready;
      },
    });
    const delayed = runner(seen.store).ready.runPage();
    await entered.ready;
    await runner(backing).ready.runPage();
    await runner(backing).ready.runPage();
    const winner = await backing.collection(bookmarks).get(key);
    expect(winner).toMatchObject({ generation: 2, cursor: null });
    resume.release();
    await delayed;
    expect(await backing.collection(bookmarks).get(key)).toEqual(winner);
    await runner(
      observe(backing, { failCheckpoint: true }).store,
    ).ready.runPage();
    expect(await backing.collection(bookmarks).get(key)).toEqual(winner);
  });

  it('does no disabled work and contains enqueue and diagnostic failures', async () => {
    const backing = createMemoryStore();
    const seen = observe(backing);
    const disabled = runner(seen.store, () => false).ready;
    await disabled.enqueue('article');
    await disabled.runPage();
    expect(seen.calls.collections).toBe(0);
    const failure = observe(backing, { failPut: true });
    const ready = createKnowledgeRetrievalReady({
      store: failure.store,
      clock,
      isEnabled: () => true,
      logger: {
        log() {
          throw new Error('Synthetic logger outage.');
        },
      },
    });
    await expect(ready.enqueue('article')).resolves.toBeUndefined();
    expect(await rows(backing)).toEqual([]);
  });
});
