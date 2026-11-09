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
  type ScanOptions,
  type Store,
  type StoredRecord,
} from '@pegma/storage-core';
import { describe, expect, it, vi } from 'vitest';
import { createKnowledgeRetrievalMaintenance } from './knowledge-retrieval-maintenance';

const KEY = { partition: 'knowledge', id: 'retrieval' } as const;
const clock = { now: () => '2026-11-08T12:00:00.000Z' };
const actor = resolveAccess(
  { principalId: 'synthetic-kb-fixture-author' },
  {
    version: 'synthetic-kb-fixture-1',
    defaults: Object.values(knowledgePermissions),
  },
);
const checkpoints = defineCollection<StoredRecord>({
  name: 'pegma-dev-maintenance',
  key: (value) => ({
    partition: String(value.partition),
    id: String(value.id),
  }),
  codec: { encode: (value) => value, decode: (value) => value },
});
const checkpoint = (store: Store) => store.collection(checkpoints).get(KEY);

function barrier() {
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}

interface Hooks {
  afterScan?: () => Promise<void>;
  afterCheckpointRead?: () => Promise<void>;
  failScan?: boolean;
  failCheckpoint?: boolean;
  loseProjectionAck?: boolean;
}

/** Only delays/faults a real Store; persistence and SDK processing remain real. */
function observe(backing: Store, hooks: Hooks = {}) {
  const scans: ScanOptions[] = [];
  const calls = { collections: 0, projectionCommits: 0 };
  const store: Store = {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      calls.collections += 1;
      const target = backing.collection(definition);
      return {
        ...target,
        async get(key) {
          const value = await target.get(key);
          if (definition.name === checkpoints.name && key.id === KEY.id)
            await hooks.afterCheckpointRead?.();
          return value;
        },
        async scan(options) {
          if (definition.name !== 'knowledge-base.records.v1')
            return target.scan(options);
          scans.push({ ...options });
          if (hooks.failScan) throw new Error('Synthetic scan failure.');
          const page = await target.scan(options);
          await hooks.afterScan?.();
          return page;
        },
        async update(key, decide, options) {
          if (
            definition.name === checkpoints.name &&
            key.id === KEY.id &&
            hooks.failCheckpoint
          )
            throw new Error('Synthetic checkpoint failure.');
          return target.update(key, decide, options);
        },
        async transact(partition, actions) {
          const result = await target.transact(partition, actions);
          if (definition.name === retrievalRecords.name && result.committed) {
            calls.projectionCommits += 1;
            if (hooks.loseProjectionAck) {
              hooks.loseProjectionAck = false;
              throw new Error('Synthetic lost projection acknowledgement.');
            }
          }
          return result;
        },
      };
    },
  };
  return { store, scans, calls };
}

async function seed(store: Store, count = 3) {
  const app = createKnowledgeBaseApplication({ store, clock });
  for (let index = 0; index < count; index++) {
    const collectionId = `synthetic-guides-${index}`;
    await app.createCollection(actor, {
      commandId: `create-${index}`,
      correlationId: 'test',
      expectedGeneration: 0,
      collectionId,
      name: `Synthetic guides ${index}`,
    });
    const preview = await app.previewCollectionPolicy(actor, {
      collectionId,
      uses: {
        portal: {
          enabled: true,
          audience: {
            kind: 'permission',
            permission: knowledgePermissions.articleRead,
          },
        },
        bot: { enabled: false },
      },
    });
    await app.updateCollectionPolicy(actor, {
      commandId: `enable-${index}`,
      correlationId: 'test',
      expectedGeneration: preview.generation,
      collectionId,
      preview: preview.preview,
    });
  }
  return app;
}

function runner(store: Store, isEnabled = () => true, currentClock = clock) {
  const logger = { log: vi.fn() };
  return {
    logger,
    maintenance: createKnowledgeRetrievalMaintenance({
      store,
      clock: currentClock,
      logger,
      isEnabled,
    }),
  };
}

describe('bounded Knowledge retrieval maintenance', () => {
  it('preserves committed checkpoints and best-effort completion when an injected Logger throws', async () => {
    const backing = createMemoryStore();
    const hooks: Hooks = {};
    const seen = observe(backing, hooks);
    const logger = {
      log: vi.fn(() => {
        throw new Error('Synthetic injected logger failure.');
      }),
    };
    const maintenance = createKnowledgeRetrievalMaintenance({
      store: seen.store,
      clock,
      logger,
      isEnabled: () => true,
    });
    await expect(maintenance.runPage()).resolves.toBeUndefined();
    const committed = await checkpoint(backing);
    expect(committed).toMatchObject({ generation: 1, cursor: null });
    hooks.failScan = true;
    await expect(maintenance.runPage()).resolves.toBeUndefined();
    expect(await checkpoint(backing)).toEqual(committed);
  });

  it('does no Store work when disabled, or when the clock is invalid', async () => {
    for (const mode of ['disabled', 'clock'] as const) {
      const backing = createMemoryStore();
      const seen = observe(backing);
      const { maintenance, logger } = runner(
        seen.store,
        () => mode !== 'disabled',
        {
          now: () => (mode === 'clock' ? 'not-a-time' : clock.now()),
        },
      );
      await maintenance.runPage();
      expect(seen.calls.collections).toBe(0);
      expect(await checkpoint(backing)).toBeNull();
      if (mode === 'disabled') expect(logger.log).not.toHaveBeenCalled();
      else
        expect(JSON.stringify(logger.log.mock.calls)).not.toContain(
          'not-a-time',
        );
    }
  });

  it('scans one physical row per call and resumes across reconstructed workers', async () => {
    const backing = createMemoryStore();
    const app = await seed(backing);
    expect((await app.listPortalCollections(actor, {})).collections).toEqual(
      [],
    );
    const seen = observe(backing);
    let complete = false;
    for (let tick = 0; tick < 256; tick++) {
      const before = seen.scans.length;
      await runner(seen.store).maintenance.runPage();
      expect(seen.scans.length - before).toBe(1);
      expect(seen.scans.at(-1)?.limit).toBe(1);
      const saved = await checkpoint(backing);
      expect(saved?.generation).toBe(tick + 1);
      if (
        saved?.cursor === null &&
        (await app.listPortalCollections(actor, {})).collections.length === 3
      ) {
        complete = true;
        break;
      }
    }
    expect(complete).toBe(true);
    expect(
      (await app.listPortalCollections(actor, {})).collections.map(
        (value) => value.collectionId,
      ),
    ).toEqual([
      'synthetic-guides-0',
      'synthetic-guides-1',
      'synthetic-guides-2',
    ]);
  });

  it('retains the prior cursor after a page failure and resumes from that exact cursor', async () => {
    const backing = createMemoryStore();
    await seed(backing);
    const hooks: Hooks = {};
    const seen = observe(backing, hooks);
    await runner(seen.store).maintenance.runPage();
    const prior = await checkpoint(backing);
    expect(typeof prior?.cursor).toBe('string');
    hooks.failScan = true;
    await runner(seen.store).maintenance.runPage();
    expect(await checkpoint(backing)).toEqual(prior);
    expect(seen.scans.at(-1)?.cursor).toBe(prior?.cursor);
    hooks.failScan = false;
    await runner(seen.store).maintenance.runPage();
    expect(seen.scans.at(-1)?.cursor).toBe(prior?.cursor);
    expect((await checkpoint(backing))?.generation).toBe(2);
  });

  it('advances opaque continuation through a physical page containing no repair candidates', async () => {
    const backing = createMemoryStore();
    const app = createKnowledgeBaseApplication({ store: backing, clock });
    for (let index = 0; index < 3; index++) {
      await app.putValidationPolicy(actor, {
        commandId: `validation-${index}`,
        correlationId: 'test',
        expectedGeneration: 0,
        policy: {
          id: `synthetic-validation-${index}`,
          version: 1,
          requirements: [
            ...articleKinds.map((kind) => ({
              id: `${kind}-content`,
              kind,
              testKind: 'content',
              maxAgeMilliseconds: 3_600_000,
              trustedRunnerIds: ['synthetic-runner'],
            })),
            {
              id: 'walkthrough-workflow',
              kind: 'walkthrough',
              testKind: 'workflow',
              maxAgeMilliseconds: 3_600_000,
              trustedRunnerIds: ['synthetic-runner'],
            },
          ],
        },
      });
    }
    const seen = observe(backing);
    const first = runner(seen.store);
    await first.maintenance.runPage();
    const saved = await checkpoint(backing);
    expect(typeof saved?.cursor).toBe('string');
    expect(first.logger.log).toHaveBeenCalledWith(
      'info',
      'knowledge.retrieval_maintenance.page',
      expect.objectContaining({
        physicalRows: 1,
        candidates: 0,
        cursorSaved: true,
      }),
    );
    await runner(seen.store).maintenance.runPage();
    expect(seen.scans).toHaveLength(2);
    expect(seen.scans[1]?.cursor).toBe(saved?.cursor);
    expect(seen.calls.projectionCommits).toBe(0);
    expect((await checkpoint(backing))?.generation).toBe(2);
  });

  it.each(['projection_ack', 'checkpoint'] as const)(
    'recovers partial committed work after %s failure without advancing the cursor',
    async (failure) => {
      const backing = createMemoryStore();
      const app = await seed(backing, 1);
      const hooks: Hooks = {
        loseProjectionAck: failure === 'projection_ack',
        failCheckpoint: failure === 'checkpoint',
      };
      const seen = observe(backing, hooks);
      // A checkpoint outage retries the same physical candidate. A lost SDK
      // ACK can occur later in the cycle, after earlier noncandidate pages.
      if (failure === 'checkpoint')
        await runner(seen.store).maintenance.runPage();
      else {
        for (
          let tick = 0;
          tick < 64 && seen.calls.projectionCommits === 0;
          tick++
        )
          await runner(seen.store).maintenance.runPage();
        expect(seen.calls.projectionCommits).toBeGreaterThan(0);
      }
      const retry = await checkpoint(backing);
      if (failure === 'checkpoint') expect(retry).toBeNull();
      hooks.failCheckpoint = false;
      for (let tick = 0; tick < 128; tick++) {
        await runner(seen.store).maintenance.runPage();
        if (
          (await app.listPortalCollections(actor, {})).collections.length === 1
        )
          break;
      }
      expect((await app.listPortalCollections(actor, {})).collections).toEqual([
        { collectionId: 'synthetic-guides-0', label: 'Synthetic guides 0' },
      ]);
      expect(await checkpoint(backing)).not.toBeNull();
    },
  );

  it('does not overwrite a newer cursor after a delayed overlapping page', async () => {
    const backing = createMemoryStore();
    await seed(backing);
    const entered = barrier();
    const resume = barrier();
    const seen = observe(backing, {
      afterScan: async () => {
        entered.release();
        await resume.ready;
      },
    });
    const delayed = runner(seen.store).maintenance.runPage();
    await entered.ready;
    await runner(backing).maintenance.runPage();
    const winner = await checkpoint(backing);
    expect(winner?.generation).toBe(1);
    resume.release();
    await delayed;
    expect(await checkpoint(backing)).toEqual(winner);
    expect(seen.scans).toHaveLength(1);
  });

  it('fences null-cycle ABA even when no physical candidate exists', async () => {
    const backing = createMemoryStore();
    const entered = barrier();
    const resume = barrier();
    const seen = observe(backing, {
      afterScan: async () => {
        entered.release();
        await resume.ready;
      },
    });
    const delayed = runner(seen.store).maintenance.runPage();
    await entered.ready;
    await runner(backing).maintenance.runPage();
    await runner(backing).maintenance.runPage();
    const winner = await checkpoint(backing);
    expect(winner).toMatchObject({ generation: 2, cursor: null });
    resume.release();
    await delayed;
    expect(await checkpoint(backing)).toEqual(winner);
  });

  it('rechecks activation after the checkpoint read and after the awaited page', async () => {
    for (const boundary of ['read', 'page'] as const) {
      const backing = createMemoryStore();
      const entered = barrier();
      const resume = barrier();
      let enabled = true;
      const pause = async () => {
        entered.release();
        await resume.ready;
      };
      const seen = observe(
        backing,
        boundary === 'read'
          ? { afterCheckpointRead: pause }
          : { afterScan: pause },
      );
      const pending = runner(seen.store, () => enabled).maintenance.runPage();
      await entered.ready;
      enabled = false;
      resume.release();
      await pending;
      expect(await checkpoint(backing)).toBeNull();
      expect(seen.calls.projectionCommits).toBe(0);
      expect(seen.scans).toHaveLength(boundary === 'read' ? 0 : 1);
    }
  });

  it('refuses corrupt or exhausted checkpoints before scanning and preserves the limiter bookmark', async () => {
    const invalid: readonly StoredRecord[] = [
      ...[0, -1, Number.MAX_SAFE_INTEGER].map((generation) => ({
        ...KEY,
        cursor: null,
        generation,
      })),
      { ...KEY, generation: 1 },
      { ...KEY, cursor: '', generation: 1 },
      { ...KEY, cursor: null, generation: 1, unexpected: true },
    ];
    for (const corrupt of invalid) {
      const backing = createMemoryStore();
      const raw = backing.collection(checkpoints);
      const limiter = {
        partition: 'knowledge',
        id: 'rate-limits',
        cursor: 'synthetic-limiter-cursor',
        generation: 7,
      };
      await raw.put(corrupt);
      await raw.put(limiter);
      const seen = observe(backing);
      await runner(seen.store).maintenance.runPage();
      expect(seen.scans).toEqual([]);
      expect(await raw.get(KEY)).toEqual(corrupt);
      expect(
        await raw.get({ partition: 'knowledge', id: 'rate-limits' }),
      ).toEqual(limiter);
    }
  });
});
