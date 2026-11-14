import { createMemoryStore, type Store, type CollectionDefinition, type CollectionStore } from '@pegma/storage-core';
import { describe, expect, it, vi } from 'vitest';
import { componentReleaseCollection, componentReleaseKey } from './component-release';
import { readReleaseOpsState } from './release-ops-state';
import { runReleaseReconciliation } from './release-reconciliation';

const ID = '1312512520', ORG = '309286193';
const START = Date.parse('2026-11-14T06:00:00Z');
const latest = { id: 123, tag_name: 'v1.0.0', published_at: '2026-11-01T00:00:00Z', draft: false, prerelease: false };
function latch() {
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { release, ready, async pause() { entered(); await wait; } };
}

async function fixture(status: 200 | 304 | 404) {
  const base = createMemoryStore();
  await base.collection(componentReleaseCollection()).update(componentReleaseKey(ID), () => ({ action: 'write', value: {
    repositoryId: ID, repositoryName: 'spine', releaseId: '99', tagName: 'v0.9.0',
    publishedAt: '2026-10-01T00:00:00Z', observedAt: '2026-11-13T00:00:00Z',
    releaseUrl: 'https://github.com/pegma-dev/spine/releases/tag/v0.9.0',
  } }));
  const state = { now: START, enabled: true, submissions: 0 };
  const hooks: { read?: (key: string) => Promise<void>; acknowledgement?: () => Promise<void>; reject?: boolean } = {};
  const store: Store = {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      const actual = base.collection(definition);
      if (definition.name !== 'componentReleases') return actual;
      return { ...actual,
        async getVersioned(key) { const result = await actual.getVersioned(key); await hooks.read?.(key.id); return result; },
        async transact(partition, actions) {
          state.submissions++;
          const outcome = hooks.reject ? { committed: false as const, reason: 'changed' as const } : await actual.transact(partition, actions);
          await hooks.acknowledgement?.();
          return outcome;
        },
      };
    },
  };
  const log = vi.fn();
  const transport = vi.fn<typeof fetch>(async url => String(url).endsWith('/releases/latest') ?
    (status === 200 ? Response.json(latest) : new Response(null, { status })) :
    Response.json({ id: Number(ID), private: false, visibility: 'public', owner: { id: Number(ORG), type: 'Organization' } }));
  const run = () => runReleaseReconciliation({ store, logger: { log }, config: { allowedRepositoryIds: new Set([ID]) },
    scheduledTime: START, now: new Date(START).toISOString(), clock: { now: () => new Date(state.now).toISOString() }, fetchImpl: transport,
    authentication: { async resolve() { return { repositoryId: ID, organizationId: ORG, token: 'fictional-token',
      expiresAt: START + 10_000, current: () => state.enabled }; } },
  });
  const row = () => base.collection(componentReleaseCollection()).get(componentReleaseKey(ID));
  return { base, state, hooks, log, transport, run, row };
}

describe('catalog authority at actual transaction submission', () => {
  for (const status of [200, 304, 404] as const) {
    for (const read of ['epoch', 'projection'] as const) {
      it.each(['timeout', 'expiry', 'configuration'] as const)(`HTTP ${status} never writes after %s during the ${read} read`, async fault => {
        vi.useFakeTimers();
        try {
          const f = await fixture(status); const before = await f.row(); const paused = latch();
          f.hooks.read = key => (read === 'epoch' ? key.startsWith('followup-epoch:') : key === ID) ? paused.pause() : Promise.resolve();
          const running = f.run(); await paused.ready;
          if (fault === 'timeout') await vi.advanceTimersByTimeAsync(10_000);
          if (fault === 'expiry') f.state.now += 10_001;
          if (fault === 'configuration') f.state.enabled = false;
          paused.release();
          expect((await running).failed).toBe(1);
          await vi.advanceTimersByTimeAsync(0);
          expect(f.state.submissions).toBe(0);
          expect(await f.row()).toEqual(before);
          expect((await readReleaseOpsState(f.base)).lastSuccessfulReconciliationAt).toBeNull();
          expect(f.log).toHaveBeenCalledWith('error', 'release_reconciliation.partial_failure', expect.objectContaining({
            failureDetails: [expect.objectContaining({ phase: 'projection' })],
          }));
        } finally { vi.useRealTimers(); }
      });
    }

    it(`HTTP ${status} awaits a submitted transaction's real late acknowledgement`, async () => {
      vi.useFakeTimers();
      try {
        const f = await fixture(status); const paused = latch(); f.hooks.acknowledgement = paused.pause;
        let settled = false;
        const running = f.run().then(value => { settled = true; return value; });
        await paused.ready; expect(f.state.submissions).toBe(1);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(settled).toBe(false);
        paused.release(); const result = await running;
        expect(result).toEqual({ examined: 1, upserted: status === 200 ? 1 : 0, cleared: status === 404 ? 1 : 0,
          notModified: status === 304 ? 1 : 0, failed: 0 });
        expect((await readReleaseOpsState(f.base)).lastSuccessfulReconciliationAt).toBe(new Date(START).toISOString());
        if (status === 404) expect(await f.row()).toBeNull();
        else expect((await f.row())!.releaseId).toBe(status === 200 ? '123' : '99');
      } finally { vi.useRealTimers(); }
    });
  }

  it('does not retry a rejected transaction when its acknowledgement arrives after expiry', async () => {
    vi.useFakeTimers();
    try {
      const f = await fixture(200), before = await f.row(), paused = latch();
      f.hooks.reject = true; f.hooks.acknowledgement = paused.pause;
      const running = f.run(); await paused.ready; await vi.advanceTimersByTimeAsync(10_000);
      paused.release(); expect((await running).failed).toBe(1);
      expect(f.state.submissions).toBe(1); expect(await f.row()).toEqual(before);
      expect((await readReleaseOpsState(f.base)).lastSuccessfulReconciliationAt).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it.each(['fetch', 'body', 'repository'] as const)('preserves the actual %s phase when the common deadline expires', async phase => {
    vi.useFakeTimers();
    try {
      const f = await fixture(200), paused = latch();
      let body: ReadableStreamDefaultController<Uint8Array> | undefined;
      f.transport.mockImplementation(async url => {
        if ((phase === 'fetch' && String(url).endsWith('/releases/latest')) ||
            (phase === 'repository' && String(url).endsWith('/repositories/' + ID))) {
          await paused.pause();
        }
        if (String(url).endsWith('/releases/latest')) {
          if (phase === 'body') return new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }));
          return Response.json(latest);
        }
        return Response.json({ id: Number(ID), private: false, visibility: 'public', owner: { id: Number(ORG), type: 'Organization' } });
      });
      const running = f.run();
      if (phase !== 'body') await paused.ready;
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await running).failed).toBe(1);
      expect(f.log).toHaveBeenCalledWith('error', 'release_reconciliation.partial_failure', expect.objectContaining({
        failureDetails: [expect.objectContaining({ phase })],
      }));
      paused.release(); body?.close(); await vi.advanceTimersByTimeAsync(0);
      expect(f.state.submissions).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
