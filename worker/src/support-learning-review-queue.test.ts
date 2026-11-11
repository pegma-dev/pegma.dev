import { createMemoryStore, type Store } from '@pegma/storage-core';
import { describe, expect, it, vi } from 'vitest';
import { createSupportLearningReviewQueue, type SupportLearningReviewQueueMessage } from './support-learning-review-queue';
import { createStagedReviewFixture } from './support-learning-staged-review-fixture';

// These isolate transport/cursor mechanics with actual public Store persistence.
// Real SDK review/authority and Native binding budgets are tested separately.
function fixture() {
  const backing = createMemoryStore();
  const state = { enabled: true, process: 'pending' as 'pending' | 'settled',
    physicalRows: 1, cursor: 'page-two' as string | null, held: false,
    scanFailure: false, sendFailure: false, processFailure: false,
    afterProcess: undefined as (() => Promise<void>) | undefined,
    afterScan: undefined as (() => Promise<void>) | undefined,
    storeGets: 0 };
  const key = { ticketId: 'fictional-ticket', commandId: 'EXACT-UPPERCASE-command' };
  const scans: ({ limit: 1; cursor?: string })[] = [];
  const deliveries: SupportLearningReviewQueueMessage[] = [];
  const process = vi.fn(async () => {
    if (state.processFailure) throw new Error('Synthetic private dependency failure');
    await state.afterProcess?.();
    return state.process;
  });
  const scanPending = vi.fn(async (bounds: { limit: 1; cursor?: string }) => {
    scans.push(bounds);
    if (state.scanFailure) throw new Error('Synthetic scan failure');
    await state.afterScan?.();
    return { candidates: state.physicalRows === 0 ? [] : [{ ...key, held: state.held }],
      physicalRows: state.physicalRows, pages: 1 as const, nextCursor: state.cursor };
  });
  const send = vi.fn(async (message: SupportLearningReviewQueueMessage) => {
    if (state.sendFailure) throw new Error('Synthetic send failure');
    deliveries.push(message);
  });
  const create = (store: Store = backing) => createSupportLearningReviewQueue({
    enabled: () => state.enabled,
    store: () => { state.storeGets += 1; return store; },
    clock: { now: () => '2026-11-11T12:00:00.000Z' },
    logger: { log() { throw new Error('Synthetic logger failure'); } },
    runtime: () => ({ scanPending, process }), sender: { send }, newId: () => 'fictional-worker',
  });
  const queue = create();
  return { backing, state, key, scans, deliveries, process, scanPending, send, queue, create };
}

function delivery(body: unknown) {
  const ack = vi.fn(); const retry = vi.fn();
  const message = { id: 'synthetic-delivery', timestamp: new Date('2026-11-11T12:00:00.000Z'),
    body, attempts: 1, ack, retry };
  const batch: MessageBatch<unknown> = { queue: 'pegma-dev-support-learning-reviews',
    messages: [message], metadata: { metrics: { backlogCount: 1, backlogBytes: 0 } }, ackAll: vi.fn(), retryAll: vi.fn() };
  return { batch, ack, retry };
}

describe('durable learning review queue transport', () => {
  it('defaults off before persistence, runtime construction or send', async () => {
    const store = vi.fn(() => { throw new Error('Unexpected Store'); });
    const runtime = vi.fn(() => { throw new Error('Unexpected runtime'); });
    const send = vi.fn();
    const queue = createSupportLearningReviewQueue({ store, runtime, sender: { send },
      clock: { now: () => { throw new Error('Unexpected clock'); } }, logger: { log() {} } });
    const item = delivery({ version: 1, key: 'a'.repeat(64) });
    await queue.enqueue({ ticketId: 'fictional', commandId: 'same' }); await queue.runPage(); await queue.consume(item.batch);
    expect(store).not.toHaveBeenCalled(); expect(runtime).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    expect(item.ack).not.toHaveBeenCalled(); expect(item.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
  });

  it('uses opaque messages, one phase per delivery, and the same key through P1/P2', async () => {
    const f = fixture(); await f.queue.enqueue(f.key);
    const body = f.deliveries[0]!;
    expect(body).toEqual({ version: 1, key: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(JSON.stringify(body)).not.toContain(f.key.ticketId);
    const proof = delivery(body); await f.queue.consume(proof.batch);
    expect(f.process).toHaveBeenCalledTimes(1); expect(proof.ack).not.toHaveBeenCalled();
    expect(proof.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    f.state.process = 'settled';
    const commit = delivery(body); await f.create().consume(commit.batch);
    expect(f.process).toHaveBeenCalledTimes(2); expect(commit.ack).toHaveBeenCalledOnce();
    const duplicate = delivery(body); await f.create().consume(duplicate.batch);
    expect(duplicate.ack).toHaveBeenCalledOnce(); expect(f.process).toHaveBeenCalledTimes(2);
  });

  it('does not change durable acknowledgement when send and logger both throw; scan repairs the lost send', async () => {
    const f = fixture(); f.state.sendFailure = true;
    await expect(f.queue.enqueue(f.key)).resolves.toBeUndefined();
    f.state.sendFailure = false; await f.create().runPage();
    expect(f.deliveries).toHaveLength(1);
    await f.queue.consume(delivery(f.deliveries[0]).batch);
    expect(f.process).toHaveBeenCalledOnce();
  });

  it('retries a failed phase without losing the pointer or launching another phase', async () => {
    const f = fixture(); await f.queue.enqueue(f.key); f.state.processFailure = true;
    const failed = delivery(f.deliveries[0]); await f.queue.consume(failed.batch);
    expect(failed.retry).toHaveBeenCalledOnce(); expect(failed.ack).not.toHaveBeenCalled();
    f.state.processFailure = false; await f.create().consume(delivery(f.deliveries[0]).batch);
    expect(f.process).toHaveBeenCalledTimes(2);
  });

  it('keeps a newer hint when an older worker finishes', async () => {
    const f = fixture(); await f.queue.enqueue(f.key); f.state.process = 'settled';
    f.state.afterProcess = async () => { f.state.afterProcess = undefined; await f.queue.enqueue(f.key); };
    await f.queue.consume(delivery(f.deliveries[0]).batch);
    await f.queue.consume(delivery(f.deliveries[0]).batch);
    expect(f.process).toHaveBeenCalledTimes(2);
  });

  it('recovers a newer terminal hint whose send and old delivery retry were both lost', async () => {
    const f = fixture(); await f.queue.enqueue(f.key); f.state.process = 'settled';
    f.state.afterProcess = async () => {
      f.state.afterProcess = undefined; f.state.sendFailure = true;
      await f.queue.enqueue(f.key);
    };
    const old = delivery(f.deliveries[0]); await f.queue.consume(old.batch);
    expect(old.ack).not.toHaveBeenCalled(); expect(old.retry).toHaveBeenCalledOnce();
    // The SDK no longer enumerates a terminal command. Only the independent
    // host-hint cycle can rediscover this orphaned acceleration row.
    f.deliveries.length = 0; f.state.physicalRows = 0; f.state.sendFailure = false;
    await f.create().runPage(); expect(f.deliveries).toHaveLength(0);
    await f.create().runPage(); expect(f.deliveries).toHaveLength(1);
    const recovered = delivery(f.deliveries[0]); await f.create().consume(recovered.batch);
    expect(recovered.ack).toHaveBeenCalledOnce();
  });

  it('does not checkpoint a failed scan/send and resumes its exact cursor after reconstruction', async () => {
    const f = fixture(); await f.queue.runPage();
    await f.create().runPage(); // the independent hint lane
    f.state.sendFailure = true; await f.create().runPage();
    f.state.sendFailure = false; await f.create().runPage();
    expect(f.scans).toEqual([{ limit: 1 }, { limit: 1, cursor: 'page-two' }, { limit: 1, cursor: 'page-two' }]);
    expect(f.process).not.toHaveBeenCalled();
  });

  it('completes full cursor cycles and rotates past held work without pretending it settled', async () => {
    const f = fixture(); f.state.held = true; f.state.cursor = null;
    for (let index = 0; index < 4; index++) await f.create().runPage();
    expect(f.scans).toEqual([{ limit: 1 }, { limit: 1 }]);
    expect(f.send).not.toHaveBeenCalled(); expect(f.process).not.toHaveBeenCalled();
  });

  it('fences a stale null→cursor→null checkpoint worker with monotone generation', async () => {
    const f = fixture(); let release = () => {}; let entered = () => {};
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    f.state.afterScan = async () => { f.state.afterScan = undefined; entered(); await paused; };
    const old = f.queue.runPage(); await ready;
    f.state.cursor = 'peer'; await f.create().runPage();
    await f.create().runPage(); // hint cursor moves independently
    f.state.cursor = null; await f.create().runPage();
    await f.create().runPage();
    f.state.cursor = 'stale';
    release(); await old;
    f.state.cursor = null;
    await f.create().runPage();
    expect(f.scans.at(-1)).toEqual({ limit: 1 });
  });

  it('rejects oversized pages and malformed messages before processing', async () => {
    const f = fixture(); f.state.physicalRows = 2;
    await f.queue.runPage(); expect(f.send).not.toHaveBeenCalled();
    for (const body of [null, { version: 1, key: 'bad' }, { version: 1, key: 'a'.repeat(64), actor: 'untrusted' }]) {
      const item = delivery(body); await f.queue.consume(item.batch); expect(item.ack).toHaveBeenCalledOnce();
    }
    expect(f.process).not.toHaveBeenCalled();
  });

  it('refuses batch amplification before persistence or runtime work', async () => {
    const f = fixture(); const one = delivery({ version: 1, key: 'a'.repeat(64) });
    await f.queue.consume({ ...one.batch, messages: [...one.batch.messages, ...one.batch.messages] });
    expect(one.retry).toHaveBeenCalledTimes(2); expect(f.state.storeGets).toBe(0); expect(f.process).not.toHaveBeenCalled();
  });

  it('observes the live switch again after a phase and preserves uncertain work', async () => {
    const f = fixture(); await f.queue.enqueue(f.key); f.state.process = 'settled';
    f.state.afterProcess = async () => { f.state.enabled = false; };
    const item = delivery(f.deliveries[0]); await f.queue.consume(item.batch);
    expect(item.ack).not.toHaveBeenCalled(); expect(item.retry).toHaveBeenCalledOnce();
    f.state.enabled = true; f.state.afterProcess = undefined;
    await f.create().consume(delivery(f.deliveries[0]).batch); expect(f.process).toHaveBeenCalledTimes(2);
  });
});


describe('staged review authentication calendar', () => {
  it('anchors actual clocked Identity/Sessions to the current epoch while preserving learning elapsed time', async () => {
    const startedAt = Date.now();
    const f = await createStagedReviewFixture(createMemoryStore(), undefined, { clockedAuthentication: true });
    expect(Date.parse(f.authenticationClockStartedAt)).toBeGreaterThanOrEqual(startedAt);
    expect(Date.parse(f.authenticationClockStartedAt)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(f.identityCreatedAt)).toBeGreaterThan(Date.parse(f.authenticationClockStartedAt));
    const logicalStartedAt = Date.parse(f.learning.clock.now());
    const delivered = await f.checked();
    const packet = await f.prepare(delivered.source.sourceGeneration);
    const first = f.sessionObservations.at(-1);
    if (first === undefined) throw new Error('Expected real browser session fences.');
    f.learning.advance(2_000);
    expect((await f.invoke('/review-queue', packet.body)).status).toBe(202);
    const last = f.sessionObservations.at(-1);
    if (last === undefined) throw new Error('Expected the real closing session fence.');
    expect(Date.parse(last.at) - Date.parse(first.at)).toBeGreaterThanOrEqual(2_000);
    expect(Date.parse(f.learning.clock.now()) - logicalStartedAt).toBeGreaterThanOrEqual(2_000);
    const session = await f.readSessionAt(last.at);
    expect(session?.lastSeenAt).toBe(last.at);
    if (session === null) throw new Error('Expected the actual live session.');
    expect(Date.parse(session.expiresAt)).toBeGreaterThan(Date.now());
  });
});
