import {
  createMemoryStore,
  type CollectionDefinition,
  type CollectionStore,
  type Store,
} from '@pegma/storage-core';
import type { Logger } from '@pegma/spine';
import { describe, expect, it, vi } from 'vitest';
import { componentReleaseCollection, componentReleaseKey } from './component-release';
import { RELEASE_CATALOG } from './release-catalog';
import { readReleaseOpsState } from './release-ops-state';
import { runReleaseReconciliation } from './release-reconciliation';
import { createAppLogger } from './logger';

const ID = '1312512520';
const START = Date.parse('2026-11-14T00:00:00Z');
const AT = '2026-11-14T00:00:01.000Z';
const LIMIT = 256 * 1024;
const CANARY = 'FICTIONAL_DIAGNOSTIC_DO_NOT_LOG';
const latest = { id: 123, tag_name: 'v1.0.0', published_at: '2026-11-01T00:00:00Z', draft: false, prerelease: false };
const validBody = JSON.stringify(latest);
type Fault = 'ops_read' | 'ops_merge' | 'epoch_read' | 'projection_read' | 'transaction';

function fixture(fault?: Fault) {
  const base = createMemoryStore();
  const log = vi.fn<Logger['log']>();
  const activity = { reads: 0, versionedReads: 0, transactions: 0, updates: 0 };
  const store: Store = {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      const records = base.collection(definition);
      return {
        ...records,
        async get(key) {
          activity.reads++;
          if (fault === 'ops_read' && definition.name === 'releaseOps') throw new Error(CANARY);
          return records.get(key);
        },
        async getVersioned(key) {
          activity.versionedReads++;
          if (definition.name === 'componentReleases' &&
            ((fault === 'epoch_read' && key.id.startsWith('followup-epoch:')) ||
             (fault === 'projection_read' && key.id === ID))) throw new Error(CANARY);
          return records.getVersioned(key);
        },
        async transact(partition, actions) {
          activity.transactions++;
          if (fault === 'transaction' && definition.name === 'componentReleases') throw new Error(CANARY);
          return records.transact(partition, actions);
        },
        async update(key, decide, options) {
          activity.updates++;
          if (fault === 'ops_merge' && definition.name === 'releaseOps') throw new Error(CANARY);
          return records.update(key, decide, options);
        },
      };
    },
  };
  const run = (fetchImpl: typeof fetch, now = AT) => runReleaseReconciliation({
    store, logger: { log }, config: { allowedRepositoryIds: new Set([ID]) },
    scheduledTime: START, now, fetchImpl,
  });
  return { base, store, log, activity, run };
}

function bodyMustNotBeRead(status: 304 | 404) {
  const response = new Response(null, { status });
  const read = vi.fn(() => { throw new Error(CANARY); });
  Object.defineProperty(response, 'body', { get: read });
  return { response, read };
}

async function seed(f: ReturnType<typeof fixture>) {
  await f.base.collection(componentReleaseCollection()).update(componentReleaseKey(ID), () => ({
    action: 'write', value: { repositoryId: ID, repositoryName: 'spine', releaseId: '123', tagName: 'v1.0.0',
      publishedAt: latest.published_at, releaseUrl: 'https://github.com/pegma-dev/spine/releases/tag/v1.0.0', observedAt: '2026-11-13T18:00:00Z' },
  }));
}

describe('bounded release reconciliation diagnostics', () => {
  it('keeps 200/304/404 summaries, projection changes and one log/fetch per invocation', async () => {
    const f = fixture();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(validBody, { headers: { ETag: 'fixture-etag' } }));
    expect(await f.run(fetchImpl)).toEqual({ examined: 1, upserted: 1, cleared: 0, notModified: 0, failed: 0 });
    expect(f.activity).toEqual({ reads: 1, versionedReads: 2, transactions: 1, updates: 1 });
    expect((await readReleaseOpsState(f.base)).lastSuccessfulReconciliationAt).toBe(new Date(START).toISOString());

    const notModified = bodyMustNotBeRead(304);
    fetchImpl.mockResolvedValueOnce(notModified.response);
    expect(await f.run(fetchImpl, '2026-11-14T00:00:02.000Z')).toEqual({ examined: 1, upserted: 0, cleared: 0, notModified: 1, failed: 0 });
    expect(notModified.read).not.toHaveBeenCalled();
    expect((await f.base.collection(componentReleaseCollection()).get(componentReleaseKey(ID)))?.observedAt).toBe('2026-11-14T00:00:02.000Z');
    expect(f.activity).toEqual({ reads: 2, versionedReads: 4, transactions: 2, updates: 2 });

    const absent = bodyMustNotBeRead(404);
    fetchImpl.mockResolvedValueOnce(absent.response);
    expect(await f.run(fetchImpl)).toEqual({ examined: 1, upserted: 0, cleared: 1, notModified: 0, failed: 0 });
    expect(absent.read).not.toHaveBeenCalled();
    expect(await f.base.collection(componentReleaseCollection()).get(componentReleaseKey(ID))).toBeNull();
    expect(f.activity).toEqual({ reads: 3, versionedReads: 6, transactions: 3, updates: 3 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(f.log).toHaveBeenCalledTimes(3);
    for (const [level, event, fields] of f.log.mock.calls) {
      expect(level).toBe('info'); expect(event).toBe('release_reconciliation.completed');
      expect(Object.keys(fields ?? {}).sort()).toEqual(['cleared', 'examined', 'notModified', 'upserted']);
    }
  });

  it('treats empty 404 as a successful observation without a projection transaction', async () => {
    const f = fixture(); const body = bodyMustNotBeRead(404);
    const fetchImpl = vi.fn<typeof fetch>(async () => body.response);
    expect(await f.run(fetchImpl)).toEqual({ examined: 1, upserted: 0, cleared: 0, notModified: 0, failed: 0 });
    expect(f.activity).toEqual({ reads: 1, versionedReads: 2, transactions: 0, updates: 1 });
    expect(body.read).not.toHaveBeenCalled();
    expect((await readReleaseOpsState(f.base)).lastSuccessfulReconciliationAt).toBe(new Date(START).toISOString());
    expect(f.log).toHaveBeenCalledTimes(1);
  });

  it('preserves nested failure details through the production tee and Cloudflare logger adapters', async () => {
    const sink = vi.spyOn(console, 'error').mockImplementation(() => {});
    const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
    try {
      await runReleaseReconciliation({
        store: createMemoryStore(), logger: createAppLogger({}, waitUntil),
        config: { allowedRepositoryIds: new Set([ID]) }, scheduledTime: START, now: AT,
        fetchImpl: async () => new Response(CANARY, { status: 403 }),
      });
      expect(sink).toHaveBeenCalledTimes(1);
      const expected = {
        level: 'error', message: 'release_reconciliation.partial_failure', fields: {
          examined: 1, upserted: 0, cleared: 0, notModified: 0, failed: 1,
          failureDetails: [{ repositoryId: ID, phase: 'status', failureClass: 'http_status', httpStatus: 403 }],
          failureDetailsOmitted: 0,
        },
      };
      expect(sink).toHaveBeenCalledWith(expected);
      expect(JSON.parse(JSON.stringify(sink.mock.calls[0]![0]))).toEqual(expected);
      expect(JSON.stringify(sink.mock.calls)).not.toContain(CANARY);
      expect(waitUntil).not.toHaveBeenCalled();
    } finally {
      sink.mockRestore();
    }
  });

  it('does not claim that a null 2xx body was streamed', async () => {
    const f = fixture();
    expect((await f.run(async () => new Response(null))).failed).toBe(1);
    expect(f.log).toHaveBeenCalledWith('error', 'release_reconciliation.partial_failure', expect.objectContaining({
      failureDetails: [{ repositoryId: ID, phase: 'facts', failureClass: 'invalid_release', httpStatus: 200 }],
    }));
    expect((await readReleaseOpsState(f.base)).lastSuccessfulReconciliationAt).toBeNull();
  });

  it.each([
    ['fetch rejection', () => Promise.reject(new Error(CANARY)), { phase: 'fetch', failureClass: 'fetch_rejected' }],
    ['HTTP refusal', async () => new Response(CANARY, { status: 403, headers: { 'X-Fixture': CANARY } }), { phase: 'status', failureClass: 'http_status', httpStatus: 403 }],
    ['bad JSON', async () => new Response(CANARY), { phase: 'body', failureClass: 'invalid_json', httpStatus: 200, bodyBytes: CANARY.length, bodyBytesSource: 'streamed' }],
    ['invalid facts', async () => Response.json({ id: CANARY }), { phase: 'facts', failureClass: 'invalid_release', httpStatus: 200 }],
    ['unsafe tag', async () => Response.json({ ...latest, tag_name: CANARY + ' forbidden' }), { phase: 'url', failureClass: 'unsafe_release_url', httpStatus: 200 }],
  ] as const)('reports only finite details for %s and preserves the old projection', async (_name, response, detail) => {
    const f = fixture(); await seed(f);
    const before = await f.base.collection(componentReleaseCollection()).get(componentReleaseKey(ID));
    const fetchImpl = vi.fn<typeof fetch>(response);
    expect(await f.run(fetchImpl)).toEqual({ examined: 1, upserted: 0, cleared: 0, notModified: 0, failed: 1 });
    expect(await f.base.collection(componentReleaseCollection()).get(componentReleaseKey(ID))).toEqual(before);
    expect((await readReleaseOpsState(f.base)).lastSuccessfulReconciliationAt).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(f.log).toHaveBeenCalledTimes(1);
    expect(f.log).toHaveBeenCalledWith('error', 'release_reconciliation.partial_failure', expect.objectContaining({
      examined: 1, failed: 1, failureDetails: [expect.objectContaining({ repositoryId: ID, ...detail })], failureDetailsOmitted: 0,
    }));
    expect(JSON.stringify(f.log.mock.calls)).not.toContain(CANARY);
  });

  it.each(['epoch_read', 'projection_read', 'transaction'] as const)('labels %s rejection as projection phase without recording the error', async (fault) => {
    const f = fixture(fault); await seed(f);
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(validBody));
    expect((await f.run(fetchImpl)).failed).toBe(1);
    expect(f.log).toHaveBeenCalledWith('error', 'release_reconciliation.partial_failure', expect.objectContaining({
      failureDetails: [expect.objectContaining({ repositoryId: ID, phase: 'projection', failureClass: 'operation_rejected', httpStatus: 200, bodyBytes: validBody.length })],
    }));
    expect(f.log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.log.mock.calls)).not.toContain(CANARY);
    expect((await readReleaseOpsState(f.base)).lastSuccessfulReconciliationAt).toBeNull();
  });

  it.each([304, 404] as const)('preserves projection-read failure on HTTP %i without reading its body', async (status) => {
    const f = fixture('projection_read'); const body = bodyMustNotBeRead(status);
    expect((await f.run(async () => body.response)).failed).toBe(1);
    expect(body.read).not.toHaveBeenCalled();
    expect(f.log).toHaveBeenCalledWith('error', 'release_reconciliation.partial_failure', expect.objectContaining({
      failureDetails: [{ repositoryId: ID, phase: 'projection', failureClass: 'operation_rejected', httpStatus: status }],
    }));
    expect((await readReleaseOpsState(f.base)).lastSuccessfulReconciliationAt).toBeNull();
  });

  it.each(['ops_read', 'ops_merge'] as const)('still propagates %s failure before a misleading summary can be logged', async (fault) => {
    const f = fixture(fault);
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(CANARY, { status: 503 }));
    await expect(f.run(fetchImpl)).rejects.toThrow(CANARY);
    expect(f.log).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(fault === 'ops_read' ? 0 : 1);
    expect((await readReleaseOpsState(f.base)).lastSuccessfulReconciliationAt).toBeNull();
  });

  it('retains bounded consumed-byte metadata for a failed body reader without error text', async () => {
    const f = fixture(); let pulls = 0;
    const response = new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (pulls++ === 0) controller.enqueue(new TextEncoder().encode('123'));
      else controller.error(new Error(CANARY));
    } }));
    expect((await f.run(async () => response)).failed).toBe(1);
    expect(f.log).toHaveBeenCalledWith('error', 'release_reconciliation.partial_failure', expect.objectContaining({
      failureDetails: [{ repositoryId: ID, phase: 'body', failureClass: 'operation_rejected', httpStatus: 200, bodyBytes: 3, bodyBytesSource: 'streamed' }],
    }));
    expect(JSON.stringify(f.log.mock.calls)).not.toContain(CANARY);
  });

  it.each([1, 999])('accepts the existing body cap and rejects %i bytes over with saturated diagnostics', async (extraBytes) => {
    const f = fixture(); const body = validBody + ' '.repeat(LIMIT - validBody.length);
    expect((await f.run(async () => new Response(body))).failed).toBe(0);
    f.log.mockClear();
    const next = await f.run(async () => new Response(body + ' '.repeat(extraBytes)));
    expect(next.failed).toBe(1);
    expect(f.log).toHaveBeenCalledWith('error', 'release_reconciliation.partial_failure', expect.objectContaining({
      failureDetails: [{ repositoryId: ID, phase: 'body', failureClass: 'too_large', httpStatus: 200, bodyBytes: LIMIT + 1, bodyBytesSource: 'streamed' }],
    }));
  });

  it('does not consume a declared oversized body and does not log the header', async () => {
    const f = fixture(); const response = new Response(CANARY, { headers: { 'Content-Length': '9'.repeat(50) } });
    const read = vi.fn(() => { throw new Error(CANARY); });
    Object.defineProperty(response, 'body', { get: read });
    expect((await f.run(async () => response)).failed).toBe(1);
    expect(read).not.toHaveBeenCalled();
    expect(f.log).toHaveBeenCalledWith('error', 'release_reconciliation.partial_failure', expect.objectContaining({
      failureDetails: [{ repositoryId: ID, phase: 'body', failureClass: 'too_large', httpStatus: 200, bodyBytes: LIMIT + 1, bodyBytesSource: 'declared' }],
    }));
    expect(JSON.stringify(f.log.mock.calls)).not.toContain(CANARY);
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('9'.repeat(50));
  });

  it('bounds full-backfill details while keeping its counters and one summary log', async () => {
    const f = fixture(); const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 503 }));
    const summary = await runReleaseReconciliation({ store: f.store, logger: { log: f.log },
      config: { allowedRepositoryIds: new Set(RELEASE_CATALOG.map(entry => entry.repositoryId)) }, fetchImpl, now: AT });
    expect(summary).toEqual({ examined: 13, upserted: 0, cleared: 0, notModified: 0, failed: 13 });
    expect(fetchImpl).toHaveBeenCalledTimes(13);
    expect(f.log).toHaveBeenCalledTimes(1);
    expect(f.log).toHaveBeenCalledWith('error', 'release_reconciliation.partial_failure', expect.objectContaining({
      failureDetails: RELEASE_CATALOG.slice(0, 4).map(entry => ({ repositoryId: entry.repositoryId, phase: 'status', failureClass: 'http_status', httpStatus: 503 })), failureDetailsOmitted: 9,
    }));
    expect((await readReleaseOpsState(f.base)).lastSuccessfulReconciliationAt).toBeNull();
  });

  it('includes the final catalog repository when its normal scheduled slot fails', async () => {
    const f = fixture(); const tail = RELEASE_CATALOG.at(-1)!;
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 503 }));
    const summary = await runReleaseReconciliation({
      store: f.store, logger: { log: f.log },
      config: { allowedRepositoryIds: new Set(RELEASE_CATALOG.map(entry => entry.repositoryId)) },
      scheduledTime: START + (RELEASE_CATALOG.length - 1) * 60_000, fetchImpl, now: AT,
    });
    expect(summary).toEqual({ examined: 1, upserted: 0, cleared: 0, notModified: 0, failed: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('/repositories/' + tail.repositoryId + '/releases/latest');
    expect(f.log).toHaveBeenCalledTimes(1);
    expect(f.log).toHaveBeenCalledWith('error', 'release_reconciliation.partial_failure', expect.objectContaining({
      failureDetails: [{ repositoryId: tail.repositoryId, phase: 'status', failureClass: 'http_status', httpStatus: 503 }],
      failureDetailsOmitted: 0,
    }));
  });
});
