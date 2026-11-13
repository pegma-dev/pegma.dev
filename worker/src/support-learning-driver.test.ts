import {
  createMemoryStore,
  defineCollection,
  type StoredRecord,
  type Store,
} from '@pegma/storage-core';
import { describe, expect, it, vi } from 'vitest';
import {
  createSupportLearningDriver,
  type SupportLearningDriverRuntime,
  type SupportLearningDeferredCheckHint,
} from './support-learning-driver';
import {
  createLearningDriverFixture,
  learningDriverHintRows,
  learningDriverHintKey,
} from './support-learning-driver-fixtures';
import { learningCanary } from './support-learning-fixtures';

const fixture = (deferredChecks = false, modelAttempts?: 1 | 2) =>
  createLearningDriverFixture(createMemoryStore(), {
    deferredChecks,
    ...(modelAttempts === undefined ? {} : { modelAttempts }),
  });

/** Confirmed NON-LLM checkpoint port contract plus real Memory CAS only.
 * These tests do not emulate a staged SDK, domain proof or Native capacity. */
describe('confirmed delivery checkpoint advisory resume protocol', () => {
  const work = { kind: 'work', ticketId: 'work', sourceGeneration: 1 };
  it.each(['prepared', 'acknowledged'] as const)(
    'queues the exact Work after a confirmed %s checkpoint while preserving FIFO',
    async (checkpoint) => {
      const t = referenceProtocol();
      const other = { kind: 'reconciliation', ticketId: 'other' };
      await t.write([work, other]);
      vi.mocked(t.runtime.processWork).mockResolvedValueOnce({
        outcome: 'pending',
        stage: 'delivery',
        checkpoint,
      });
      expect(await t.tick()).toMatchObject({
        outcome: 'work',
        result: { outcome: 'pending', stage: 'delivery', checkpoint },
        remainingTargets: 2,
      });
      expect(await t.read()).toEqual({
        generation: 3,
        cursor: 'learning-cursor',
        targets: [other, work],
      });
      expect(t.runtime.scanCandidates).not.toHaveBeenCalled();
    },
  );
  it('leaves unknown legacy pending delivery without a post-SDK checkpoint write', async () => {
    const t = referenceProtocol();
    await t.write([work]);
    let atCall: unknown;
    vi.mocked(t.runtime.processWork).mockImplementation(async () => {
      atCall = await t.read();
      return { outcome: 'pending', stage: 'delivery' };
    });
    expect(await t.tick()).toMatchObject({
      outcome: 'work',
      result: { outcome: 'pending', stage: 'delivery' },
      remainingTargets: 0,
    });
    expect(atCall).toEqual({
      generation: 2,
      cursor: 'learning-cursor',
      targets: [],
    });
    expect(await t.read()).toEqual(atCall);
  });
  it('preserves an acknowledged domain checkpoint if the later advisory read fails', async () => {
    const t = referenceProtocol();
    await t.write([work]);
    let reads = 0;
    vi.mocked(t.runtime.processWork).mockResolvedValueOnce({
      outcome: 'pending',
      stage: 'delivery',
      checkpoint: 'acknowledged',
    });
    const store: Store = {
      collection(definition) {
        const actual = t.store.collection(definition);
        return definition.name !== learningDriverHintRows.name
          ? actual
          : {
              ...actual,
              async getVersioned(key) {
                if (++reads === 2)
                  throw new Error(
                    'Fictional post-checkpoint advisory read failure',
                  );
                return actual.getVersioned(key);
              },
            };
      },
    };
    expect(
      await createSupportLearningDriver({
        store,
        clock: { now: () => '2026-11-10T12:00:00.000Z' },
        isEnabled: () => true,
        runtime: () => t.runtime,
      }).runTick(),
    ).toMatchObject({
      outcome: 'work',
      result: { checkpoint: 'acknowledged' },
      remainingTargets: 0,
      checkpointSaved: true,
    });
    expect((await t.read()).targets).toEqual([]);
    expect(t.runtime.processWork).toHaveBeenCalledOnce();
  });
  it('retains a genuinely committed resume whose advisory CAS acknowledgement is lost', async () => {
    const t = referenceProtocol();
    await t.write([work]);
    let writes = 0;
    vi.mocked(t.runtime.processWork).mockResolvedValueOnce({
      outcome: 'pending',
      stage: 'delivery',
      checkpoint: 'prepared',
    });
    const store: Store = {
      collection(definition) {
        const actual = t.store.collection(definition);
        return definition.name !== learningDriverHintRows.name
          ? actual
          : {
              ...actual,
              async putIfUnchanged(value, version) {
                const accepted = await actual.putIfUnchanged(value, version);
                if (++writes === 2 && accepted)
                  throw new Error('Lost genuine advisory ACK');
                return accepted;
              },
            };
      },
    };
    expect(
      await createSupportLearningDriver({
        store,
        clock: { now: () => '2026-11-10T12:00:00.000Z' },
        isEnabled: () => true,
        runtime: () => t.runtime,
      }).runTick(),
    ).toMatchObject({
      outcome: 'work',
      result: { checkpoint: 'prepared' },
      checkpointSaved: true,
    });
    expect(await t.read()).toEqual({
      generation: 3,
      cursor: 'learning-cursor',
      targets: [work],
    });
    expect(t.runtime.processWork).toHaveBeenCalledOnce();
  });
  it('merges a resume into the current cursor without restoring a concurrently consumed reference', async () => {
    const t = referenceProtocol();
    await t.write([work, { kind: 'reconciliation', ticketId: 'consumed' }]);
    vi.mocked(t.runtime.processWork).mockImplementation(async () => {
      await t.store.collection(learningDriverHintRows).put({
        ...learningDriverHintKey,
        format: 1,
        payload: JSON.stringify({
          generation: 3,
          cursor: 'concurrent-cursor',
          targets: [],
        }),
      });
      return { outcome: 'pending', stage: 'delivery', checkpoint: 'prepared' };
    });
    expect(await t.tick()).toMatchObject({
      outcome: 'work',
      remainingTargets: 1,
    });
    expect(await t.read()).toEqual({
      generation: 4,
      cursor: 'concurrent-cursor',
      targets: [work],
    });
  });
  it('keeps a concurrent full32-reference backlog intact without changing accepted delivery progress', async () => {
    const t = referenceProtocol();
    await t.write([work]);
    const full = Array.from({ length: 32 }, (_, n) => ({
      kind: 'reconciliation',
      ticketId: 'other-' + n,
    }));
    vi.mocked(t.runtime.processWork).mockImplementation(async () => {
      await t.write(full, 4);
      return {
        outcome: 'pending',
        stage: 'delivery',
        checkpoint: 'acknowledged',
      };
    });
    expect(await t.tick()).toMatchObject({
      outcome: 'work',
      result: { checkpoint: 'acknowledged' },
      remainingTargets: 32,
    });
    expect(await t.read()).toEqual({
      generation: 4,
      cursor: 'learning-cursor',
      targets: full,
    });
  });
});

describe('automatic learning over real Source, Work, KB and usage', () => {
  it('discovers existing verified-evidence Work, runs one model stage, then a separate private draft stage', async () => {
    const t = await fixture();
    expect(await t.work()).toMatchObject({ status: 'pending', stage: 'model' });
    const before = (await t.work()).deadline;
    await t.until((result) => result.outcome === 'scanned' && result.selected);
    expect(t.f.state.modelCalls).toBe(0);
    const writes = t.faults.hintWrites;
    expect(await t.tick()).toMatchObject({
      outcome: 'work',
      result: { outcome: 'candidate' },
    });
    expect(t.faults.hintWrites).toBe(writes + 1);
    expect(t.f.state.modelCalls).toBe(1);
    expect(t.faults.createCalls).toBe(0);
    expect(await t.usage()).toMatchObject({
      spentMicros: '10',
      reservations: [{ state: 'known' }],
    });
    expect(await t.phase()).toMatchObject({
      outcome: 'work',
      result: { outcome: 'delivered' },
    });
    const work = await t.work();
    expect(work.deadline).toBe(before);
    expect(work.target).toBeDefined();
    expect(t.f.state.modelCalls).toBe(1);
    expect(t.faults.createCalls).toBe(1);
    if (!work.target) throw new Error('Actual KB target required');
    expect(
      (
        await t.f.knowledge.getDraft(t.f.actors.staff, {
          articleId: work.target.articleId,
        })
      ).state,
    ).toBe('draft');
    await expect(
      t.f.knowledge.getPublishedArticle(t.f.actors.customer, {
        articleId: work.target.articleId,
      }),
    ).rejects.toThrow();
    expect(JSON.stringify(t.f.state.modelInputs)).not.toContain(learningCanary);
    expect(String((await t.hint())?.payload)).not.toContain(learningCanary);
  });
  it('recovers an accepted discovery-head ACK loss without making a second model opportunity', async () => {
    const t = await fixture();
    t.faults.loseHintAck = true;
    expect(await t.tick()).toEqual({
      outcome: 'unavailable',
      checkpointSaved: false,
    });
    expect(await t.hint()).not.toBeNull();
    expect(t.f.state.modelCalls).toBe(0);
    expect(await t.phase()).toMatchObject({ result: { outcome: 'candidate' } });
    expect(await t.phase()).toMatchObject({ result: { outcome: 'delivered' } });
    expect(t.f.state.modelCalls).toBe(1);
  });
  it('does not call the SDK after the target-consumption CAS acknowledgement is lost', async () => {
    const t = await fixture();
    await t.until((result) => result.outcome === 'scanned' && result.selected);
    t.faults.loseHintAck = true;
    expect((await t.tick()).outcome).toBe('unavailable');
    expect(t.f.state.modelCalls).toBe(0);
    expect(await t.phase()).toMatchObject({ result: { outcome: 'candidate' } });
    expect(t.f.state.modelCalls).toBe(1);
  });
  it('recovers an actual model completion receipt after its transaction ACK is lost', async () => {
    const t = await fixture();
    t.faults.loseCandidateAck = true;
    expect(await t.phase()).toMatchObject({ result: { outcome: 'candidate' } });
    expect(await t.phase()).toMatchObject({ result: { outcome: 'delivered' } });
    expect(t.f.state.modelCalls).toBe(1);
    expect(await t.usage()).toMatchObject({ spentMicros: '10' });
  });
  it('holds genuinely unknown model usage and does not issue another paid call on cold rediscovery', async () => {
    const t = await fixture(false, 1);
    t.f.state.beforeModelReturn = async () => {
      throw new Error('Fictional paid model ACK loss');
    };
    await t.phase();
    expect(t.f.state.modelCalls).toBe(1);
    expect(await t.usage()).toMatchObject({
      spentMicros: '0',
      reservations: [{ state: 'unknown' }],
    });
    t.f.advance(31_000);
    await t.phase();
    await t.phase();
    expect(t.f.state.modelCalls).toBe(1);
    expect((await t.work()).candidate).toBeUndefined();
    expect(t.faults.createCalls).toBe(0);
  });
  it('honors an explicit two-attempt generation policy and retains both unknown liabilities', async () => {
    const t = await fixture(false, 2);
    t.f.state.beforeModelReturn = async () => {
      throw new Error('Fictional paid model ACK loss');
    };
    await t.phase();
    t.f.advance(31_000);
    await t.phase();
    await t.phase();
    expect(t.f.state.modelCalls).toBe(2);
    expect(await t.usage()).toMatchObject({
      spentMicros: '0',
      reservations: [{ state: 'unknown' }, { state: 'unknown' }],
    });
    expect((await t.work()).candidate).toBeUndefined();
    expect(t.faults.createCalls).toBe(0);
  });
  it('recovers a committed KB draft after unknown delivery ACKs using its exact durable request', async () => {
    const t = await fixture();
    await t.phase();
    t.faults.loseDeliveryAcks = 2;
    expect(await t.phase()).toMatchObject({
      result: { outcome: 'pending', stage: 'delivery' },
    });
    const pending = await t.work();
    expect(pending.exactRequest).toBeDefined();
    const articleId = pending.exactRequest?.articleId;
    if (!articleId) throw new Error('Actual exact request required');
    expect(
      await t.f.knowledge.getDraft(t.f.actors.staff, { articleId }),
    ).toBeDefined();
    t.f.advance(31_000);
    expect(await t.phase()).toMatchObject({ result: { outcome: 'delivered' } });
    expect((await t.work()).target?.articleId).toBe(articleId);
    expect(t.f.state.modelCalls).toBe(1);
    expect(await t.usage()).toMatchObject({ spentMicros: '10' });
  });
  it('keeps source retirement discovery active when generation is OFF', async () => {
    const t = await fixture();
    await t.phase();
    await t.phase();
    const articleId = (await t.work()).target?.articleId;
    if (!articleId) throw new Error('Actual delivered target required');
    await t.f.review(articleId);
    await t.f.evidenceAndPublish(articleId);
    t.f.state.enabled = false;
    await t.f.runtime.withdraw(t.f.actors.staff, {
      ticketId: t.key.ticketId,
      clientCommandId: 'driver-privacy-withdrawal',
      reason: 'privacy_withdrawal',
    });
    expect(
      await t.until((result) => result.outcome === 'reconciliation'),
    ).toMatchObject({
      outcome: 'reconciliation',
      result: { outcome: 'reconciled', processedDestinations: 1 },
    });
    expect(
      (await t.f.knowledge.getDraft(t.f.actors.staff, { articleId })).state,
    ).toBe('retired');
    expect(t.f.state.modelCalls).toBe(1);
  });
  it('reconciles a reopened published source without granting publication or new model authority', async () => {
    const t = await fixture();
    await t.phase();
    await t.phase();
    const articleId = (await t.work()).target?.articleId;
    if (!articleId) throw new Error('Actual delivered target required');
    await t.f.review(articleId);
    await t.f.evidenceAndPublish(articleId);
    await t.f.application.reopenTicket(t.f.actors.staff, {
      ...t.f.command('driver-reopen'),
      ticketId: t.key.ticketId,
    });
    t.f.state.enabled = false;
    expect(
      await t.until((result) => result.outcome === 'reconciliation'),
    ).toMatchObject({ result: { outcome: 'reconciled' } });
    expect(
      (await t.f.knowledge.getDraft(t.f.actors.staff, { articleId })).state,
    ).toBe('retired');
    expect(t.f.state.modelCalls).toBe(1);
  });
  it('uses current real processing-role assignments after discovery', async () => {
    const t = await fixture();
    await t.until((result) => result.outcome === 'scanned' && result.selected);
    await t.revokeProcessing();
    await t.tick();
    expect(t.f.state.modelCalls).toBe(0);
    expect(await t.usage()).toBeNull();
  });
  it('admits only one cold owner through the actual reference CAS', async () => {
    const t = await fixture();
    await t.until((result) => result.outcome === 'scanned' && result.selected);
    let release = () => {};
    let both = () => {};
    let reads = 0;
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      both = resolve;
    });
    t.faults.afterHintRead = async () => {
      if (++reads === 2) both();
      await proceed;
    };
    const pending = Promise.all([t.tick(), t.tick()]);
    await reached;
    release();
    expect((await pending).map((result) => result.outcome).sort()).toEqual([
      'contended',
      'work',
    ]);
    expect(t.f.state.modelCalls).toBe(1);
    expect(await t.usage()).toMatchObject({
      reservations: [{ state: 'known' }],
    });
  });
  it('stops before SDK work if current enablement is revoked during the real head CAS', async () => {
    const t = await fixture();
    await t.until((result) => result.outcome === 'scanned' && result.selected);
    t.faults.afterHintWrite = () => {
      t.faults.enabled = false;
    };
    expect(await t.tick()).toEqual({
      outcome: 'unavailable',
      checkpointSaved: false,
    });
    expect(t.f.state.modelCalls).toBe(0);
    expect(t.faults.workCalls).toBe(0);
  });
  it('bounds a nonsettling real Store read by25s and removes its caller cancellation listener', async () => {
    const t = await fixture();
    vi.useFakeTimers();
    try {
      t.faults.blockedHintRead = () => new Promise<void>(() => {});
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, 'removeEventListener');
      const pending = t.tick({ signal: controller.signal });
      await vi.advanceTimersByTimeAsync(25_000);
      expect(await pending).toEqual({
        outcome: 'unavailable',
        checkpointSaved: false,
      });
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(t.f.state.modelCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it('forwards cancellation through a real awaited SDK model and retains its original reservation without a candidate', async () => {
    const t = await fixture(false, 1);
    await t.until((result) => result.outcome === 'scanned' && result.selected);
    let begin = () => {};
    let release = () => {};
    const entered = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.f.state.beforeModelReturn = async () => {
      begin();
      await proceed;
    };
    const controller = new AbortController();
    const pending = t.tick({ signal: controller.signal });
    await entered;
    controller.abort();
    expect(await pending).toEqual({
      outcome: 'unavailable',
      checkpointSaved: true,
    });
    release();
    await Promise.all(t.pendingStages);
    expect((await t.work()).candidate).toBeUndefined();
    expect(t.faults.createCalls).toBe(0);
    expect(t.f.state.modelCalls).toBe(1);
    // Revoked driver admission can also stop cleanup accounting. Reserved is
    // still an uncertain liability, never a not_called refund.
    expect(await t.usage()).toMatchObject({
      reservations: [{ state: 'reserved', reservedMicros: 10_000 }],
    });
    t.f.advance(31_000);
    await t.phase();
    expect(t.f.state.modelCalls).toBe(1);
    expect(await t.usage()).toMatchObject({
      reservations: [{ state: 'unknown' }],
    });
  });
  it('does not starve a second genuine report behind an unknown first model outcome', async () => {
    const t = await fixture(false, 1);
    const second = await t.addReport('z-second-learning-ticket');
    let first = true;
    t.f.state.beforeModelReturn = async () => {
      if (first) {
        first = false;
        throw new Error('Fictional first-report unknown');
      }
    };
    await t.until(
      (asyncResult) =>
        asyncResult.outcome === 'work' &&
        asyncResult.result.outcome === 'candidate',
    );
    expect(t.f.state.modelCalls).toBe(2);
    expect((await t.work()).candidate).toBeUndefined();
    expect(
      (
        await t.f.application.readResolutionLearningWork(
          t.f.actors.staff,
          second,
        )
      ).candidate,
    ).toBeDefined();
    expect(await t.usage()).toMatchObject({
      spentMicros: '10',
      reservations: [{ state: 'unknown' }, { state: 'known' }],
    });
  });
});

describe('separate real deferred learning checker phases', () => {
  async function deferred() {
    const t = await fixture(true, 1);
    expect(await t.phase()).toMatchObject({ result: { outcome: 'candidate' } });
    expect(await t.phase()).toMatchObject({
      result: { outcome: 'checks_pending' },
    });
    if (!t.checker) throw new Error('Expected actual checker');
    const targets = JSON.parse(String((await t.hint())?.payload))
      .targets as SupportLearningDeferredCheckHint[];
    const hint = targets.find((value) => value.kind === 'checks');
    if (!hint) throw new Error('Actual durably queued hint required');
    expect(t.checker.state.calls).toBe(0);
    expect(t.faults.createCalls).toBe(0);
    return { ...t, checker: t.checker, checkHint: hint };
  }
  it('runs the candidate, deferred check and exact KB delivery in different cold invocations', async () => {
    const t = await deferred();
    const writes = t.faults.hintWrites;
    expect(await t.tick()).toMatchObject({
      outcome: 'checks',
      result: { outcome: 'checked' },
    });
    expect(t.faults.hintWrites).toBe(writes + 1);
    expect(t.faults.createCalls).toBe(0);
    expect(await t.tick()).toMatchObject({
      outcome: 'work',
      result: { outcome: 'delivered' },
    });
    expect(t.f.state.modelCalls).toBe(1);
    expect(t.checker.state.calls).toBe(1);
    expect(t.faults.createCalls).toBe(1);
    expect((await t.checker.rows())?.entries[0]).toMatchObject({
      state: 'checked',
      request: null,
    });
    expect(String((await t.hint())?.payload)).not.toContain('exactRequest');
  });
  it('recovers an actual checked receipt after unknown precompute acknowledgement without another paid check', async () => {
    const t = await deferred();
    t.checker.state.losePrecomputeAck = true;
    expect(await t.tick()).toEqual({
      outcome: 'unavailable',
      checkpointSaved: true,
    });
    expect(t.faults.createCalls).toBe(0);
    expect((await t.checker.rows())?.entries[0]?.state).toBe('checked');
    expect(await t.tick()).toMatchObject({ result: { outcome: 'delivered' } });
    expect(t.checker.state.calls).toBe(1);
    expect(t.f.state.modelCalls).toBe(1);
  });
  it('never funds a second independent check for a genuinely unknown exact request', async () => {
    const t = await deferred();
    t.checker.state.lost = true;
    expect(await t.tick()).toMatchObject({
      outcome: 'checks',
      result: { outcome: 'unknown' },
    });
    expect(await t.tick()).toMatchObject({
      outcome: 'work',
      result: { outcome: 'held' },
    });
    await t.store.collection(learningDriverHintRows).put({
      ...learningDriverHintKey,
      format: 1,
      payload: JSON.stringify({
        generation: 70,
        cursor: null,
        targets: [t.checkHint],
      }),
    });
    expect(await t.tick()).toMatchObject({
      outcome: 'checks',
      result: { outcome: 'unknown' },
    });
    expect(t.checker.state.calls).toBe(1);
    expect(t.faults.createCalls).toBe(0);
    expect((await t.checker.rows())?.entries[0]).toMatchObject({
      state: 'unknown',
      request: null,
    });
  });
  it('withdraws private queued facts before any checker provider call', async () => {
    const t = await deferred();
    await t.f.runtime.withdraw(t.f.actors.staff, {
      ticketId: t.key.ticketId,
      clientCommandId: 'driver-withdraw-check',
      reason: 'privacy_withdrawal',
    });
    expect(await t.tick()).toMatchObject({
      outcome: 'checks',
      result: { outcome: 'held' },
    });
    expect(t.checker.state.calls).toBe(0);
    expect(t.faults.createCalls).toBe(0);
    expect((await t.checker.rows())?.entries[0]?.request).toBeNull();
  });
  it('skips an expired check hint and leaves the SDK Work resume subject to its original deadline', async () => {
    const t = await deferred();
    const before = (await t.work()).deadline;
    t.f.advance(
      Date.parse(t.checkHint.expiresAt) - Date.parse(t.f.clock.now()),
    );
    expect(await t.tick()).toMatchObject({
      outcome: 'checks',
      result: { outcome: 'held' },
    });
    expect(t.checker.state.calls).toBe(0);
    expect(t.faults.createCalls).toBe(0);
    expect((await t.work()).deadline).toBe(before);
    await t.checker.adapter.purgeExpired();
    expect((await t.checker.rows())?.entries[0]?.request).toBeNull();
  });
});

/** Protocol-only pending ports establish no domain approval or paid acceptance. */
function referenceProtocol() {
  const store = createMemoryStore();
  const page = {
    physicalRows: 32,
    pages: 1 as const,
    nextCursor: 'next-learning-page',
    candidates: Array.from({ length: 16 }, (_, n) => ({
      ticketId: 'work-' + n,
      sourceGeneration: 1,
    })),
    reconciliationSources: Array.from({ length: 16 }, (_, n) => 'source-' + n),
  };
  const runtime: SupportLearningDriverRuntime = {
    scanCandidates: vi.fn(async () => page),
    processWork: vi.fn(async () => ({
      outcome: 'pending' as const,
      stage: 'delivery' as const,
    })),
    reconcileSource: vi.fn(async () => ({
      outcome: 'pending' as const,
      processedDestinations: 0,
    })),
    precomputeChecks: vi.fn(async () => ({ outcome: 'checked' as const })),
  };
  const tick = () =>
    createSupportLearningDriver({
      store,
      clock: { now: () => '2026-11-10T12:00:00.000Z' },
      isEnabled: () => true,
      runtime: () => runtime,
    }).runTick();
  const write = async (targets: unknown[], generation = 1) =>
    store.collection(learningDriverHintRows).put({
      ...learningDriverHintKey,
      format: 1,
      payload: JSON.stringify({
        generation,
        cursor: 'learning-cursor',
        targets,
      }),
    });
  const read = async () =>
    JSON.parse(
      String(
        (
          await store
            .collection(learningDriverHintRows)
            .get(learningDriverHintKey)
        )?.payload,
      ),
    ) as {
      targets: unknown[];
      generation: number;
      cursor: string;
    };
  return { store, runtime, page, tick, write, read };
}
describe('bounded distinct learning reference checkpoint', () => {
  it('keeps omitted/disabled/throwing configuration before all Store and runtime I/O', async () => {
    const store = createMemoryStore();
    const open = vi.spyOn(store, 'collection');
    const runtime = vi.fn();
    for (const isEnabled of [
      undefined,
      () => false,
      () => {
        throw new Error('Fictional unavailable flag');
      },
    ]) {
      expect(
        await createSupportLearningDriver({
          store,
          clock: { now: () => '2026-11-10T12:00:00.000Z' },
          runtime,
          ...(isEnabled === undefined ? {} : { isEnabled }),
        }).runTick(),
      ).toEqual({ outcome: 'disabled', checkpointSaved: false });
    }
    expect(runtime).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(
      await createSupportLearningDriver({
        store,
        clock: { now: () => '2026-11-10T12:00:00.000Z' },
        isEnabled: () => true,
      }).runTick(),
    ).toEqual({ outcome: 'unavailable', checkpointSaved: false });
    expect(open).not.toHaveBeenCalled();
  });
  it('retains and drains all32 FIFO references even when the first SDK result stays pending', async () => {
    const t = referenceProtocol();
    expect(await t.tick()).toMatchObject({
      outcome: 'scanned',
      physicalRows: 32,
      selected: true,
    });
    for (let n = 0; n < 32; n++)
      expect(await t.tick()).toMatchObject({
        outcome: n < 16 ? 'reconciliation' : 'work',
        remainingTargets: 31 - n,
      });
    expect(t.runtime.scanCandidates).toHaveBeenCalledExactlyOnceWith({
      limit: 32,
    });
    expect(t.runtime.processWork).toHaveBeenCalledTimes(16);
    expect(t.runtime.reconcileSource).toHaveBeenCalledTimes(16);
    expect((await t.read()).targets).toEqual([]);
  });
  it('never reads or rewrites the engineering cursor', async () => {
    const t = referenceProtocol();
    const engineering = defineCollection<StoredRecord>({
      name: 'pegma.support-engineering-driver.v1',
      key: () => ({ partition: 'engineering', id: 'cursor' }),
      codec: {
        encode: (value) => ({ ...value }),
        decode: (value) => ({ ...value }),
      },
    });
    const sentinel = {
      partition: 'engineering',
      id: 'cursor',
      format: 2,
      payload: 'unchanged-engineering-hint',
    };
    await t.store.collection(engineering).put(sentinel);
    await t.tick();
    expect(
      await t.store
        .collection(engineering)
        .get({ partition: 'engineering', id: 'cursor' }),
    ).toEqual(sentinel);
    expect((await t.read()).cursor).toBe('next-learning-page');
  });
  it('saves a Work resume before checker precompute, with no post-paid checkpoint write', async () => {
    const t = referenceProtocol();
    const hint: SupportLearningDeferredCheckHint = {
      kind: 'checks',
      operationId: 'a'.repeat(64),
      ticketId: 'work',
      sourceGeneration: 1,
      expiresAt: '2026-11-10T12:04:00.000Z',
    };
    const other = { kind: 'reconciliation', ticketId: 'other' };
    await t.write([hint, other]);
    let atCall: unknown;
    vi.mocked(t.runtime.precomputeChecks!).mockImplementation(async () => {
      atCall = await t.read();
      return { outcome: 'unknown' };
    });
    expect(await t.tick()).toMatchObject({
      outcome: 'checks',
      result: { outcome: 'unknown' },
      remainingTargets: 2,
    });
    expect(atCall).toEqual({
      generation: 2,
      cursor: 'learning-cursor',
      targets: [{ kind: 'work', ticketId: 'work', sourceGeneration: 1 }, other],
    });
    expect(await t.read()).toEqual(atCall);
  });
  it('merges a nonpaid deferred operation into the current head without undoing a concurrent pop/cursor advance', async () => {
    const t = referenceProtocol();
    const hint: SupportLearningDeferredCheckHint = {
      kind: 'checks',
      operationId: 'a'.repeat(64),
      ticketId: 'work',
      sourceGeneration: 1,
      expiresAt: '2026-11-10T12:04:00.000Z',
    };
    await t.write([
      { kind: 'work', ticketId: hint.ticketId, sourceGeneration: 1 },
      { kind: 'reconciliation', ticketId: 'other' },
    ]);
    vi.mocked(t.runtime.processWork).mockImplementation(async () => {
      await t.store.collection(learningDriverHintRows).put({
        ...learningDriverHintKey,
        format: 1,
        payload: JSON.stringify({
          generation: 3,
          cursor: 'new-current-cursor',
          targets: [],
        }),
      });
      return { outcome: 'checks_pending', hint };
    });
    expect(await t.tick()).toMatchObject({
      outcome: 'work',
      remainingTargets: 1,
    });
    expect(await t.read()).toEqual({
      generation: 4,
      cursor: 'new-current-cursor',
      targets: [hint],
    });
  });
  it('leaves a full concurrent32-reference backlog intact when an advisory deferred insert cannot fit', async () => {
    const t = referenceProtocol();
    const hint: SupportLearningDeferredCheckHint = {
      kind: 'checks',
      operationId: 'a'.repeat(64),
      ticketId: 'work',
      sourceGeneration: 1,
      expiresAt: '2026-11-10T12:04:00.000Z',
    };
    const full = Array.from({ length: 32 }, (_, n) => ({
      kind: 'reconciliation',
      ticketId: 'other-' + n,
    }));
    await t.write([
      { kind: 'work', ticketId: hint.ticketId, sourceGeneration: 1 },
    ]);
    vi.mocked(t.runtime.processWork).mockImplementation(async () => {
      await t.write(full, 4);
      return { outcome: 'checks_pending', hint };
    });
    expect(await t.tick()).toMatchObject({
      outcome: 'work',
      remainingTargets: 32,
    });
    expect(await t.read()).toEqual({
      generation: 4,
      cursor: 'learning-cursor',
      targets: full,
    });
  });
  it.each(['count', 'targets', 'duplicates', 'private-field'] as const)(
    'refuses invalid %s SDK pages without saving a cursor',
    async (fault) => {
      const t = referenceProtocol();
      if (fault === 'count') t.page.physicalRows = 33;
      if (fault === 'targets') t.page.physicalRows = 31;
      if (fault === 'duplicates')
        t.page.candidates[1] = { ...t.page.candidates[0]! };
      if (fault === 'private-field')
        Reflect.set(t.page.candidates[0]!, 'body', 'PRIVATE_NOT_A_REFERENCE');
      expect(await t.tick()).toEqual({
        outcome: 'unavailable',
        checkpointSaved: false,
      });
      expect(
        await t.store
          .collection(learningDriverHintRows)
          .get(learningDriverHintKey),
      ).toBeNull();
      expect(t.runtime.processWork).not.toHaveBeenCalled();
    },
  );
  it.each(['unknown-field', 'oversized', 'duplicate', 'bad-time'] as const)(
    'rejects %s private checkpoints before calling the SDK',
    async (fault) => {
      const t = referenceProtocol();
      const work = { kind: 'work', ticketId: 'work', sourceGeneration: 1 };
      const hint = {
        ...work,
        kind: 'checks',
        operationId: 'a'.repeat(64),
        expiresAt: '2026-11-10T12:04:00Z',
      };
      if (fault === 'unknown-field')
        Reflect.set(work, 'body', 'PRIVATE_NOT_A_HINT');
      await t.write(
        fault === 'oversized'
          ? Array.from({ length: 33 }, (_, n) => ({
              ...work,
              ticketId: 'work-' + n,
            }))
          : fault === 'duplicate'
            ? [work, work]
            : fault === 'bad-time'
              ? [hint]
              : [work],
      );
      expect(await t.tick()).toEqual({
        outcome: 'unavailable',
        checkpointSaved: false,
      });
      expect(t.runtime.scanCandidates).not.toHaveBeenCalled();
      expect(t.runtime.processWork).not.toHaveBeenCalled();
    },
  );
});
