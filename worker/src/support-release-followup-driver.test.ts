import { describe, expect, it, vi } from 'vitest';
import { createMemoryStore } from '@pegma/storage-core';
import { createSupportFollowupHostFixture } from './support-release-followup-host-fixtures';
import {
  createSupportReleaseFollowupDriver,
  supportReleaseFollowupCheckpoints,
  supportReleaseFollowupWakeDue,
} from './support-release-followup-driver';
import { createSupportReleaseFollowupRuntime } from './support-release-followup';
import type { Store } from '@pegma/storage-core';

async function fixture() {
  const f = await createSupportFollowupHostFixture();
  const mapping = await f.source.mappings!.verify(
    f.context,
    f.f.identity.ticketId,
    f.mappingPacket,
  );
  const observed = await f.runtime.observe(f.context, {
    ...f.f.identity,
    commandId: crypto.randomUUID(),
    inputReference: mapping.inputReference,
  });
  if (!observed.workId)
    throw new Error('Actual follow-up work was not observed');
  const key = { ticketId: f.f.identity.ticketId, workId: observed.workId };
  const state = { enabled: true };
  const driver = createSupportReleaseFollowupDriver({
    store: f.store,
    clock: f.f.clock,
    enabled: () => state.enabled,
    runtime: (current) =>
      createSupportReleaseFollowupRuntime({
        application: f.host.application,
        store: f.store,
        clock: f.f.clock,
        configuration: f.composition.configuration,
        enabled: current,
      }),
  });
  return { ...f, key, state, driver };
}
describe('bounded production release-follow-up cursor', () => {
  it.each(['read', 'runtime'] as const)('settles parent cancellation promptly during a non-cooperative %s await and ignores its late completion', async (stage) => {
    vi.useFakeTimers();
    try {
      const store = createMemoryStore();
      let started!: () => void;
      const entered = new Promise<void>((resolve) => { started = resolve; });
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let writes = 0;
      let scans = 0;
      const measured: Store = { collection(definition) {
        const records = store.collection(definition);
        return { ...records,
          async getVersioned(key) { if (stage === 'read') { started(); await held; } return records.getVersioned(key); },
          async insertIfAbsent(value) { writes++; return records.insertIfAbsent(value); },
          async putIfUnchanged(value, version) { writes++; return records.putIfUnchanged(value, version); },
        };
      } };
      const controller = new AbortController();
      const driver = createSupportReleaseFollowupDriver({ store: measured, clock: { now: () => new Date().toISOString() }, enabled: () => true,
        runtime: () => ({
          async scanProcessing() { scans++; started(); await held; return { associations: [], candidates: [], reviewCandidates: [], attentionSources: [], physicalRows: 0, pages: 1 as const, nextCursor: null }; },
          async process() { throw new Error('No work should be processed'); },
        }),
      });
      const tick = driver.runTick({ signal: controller.signal });
      await entered;
      controller.abort();
      let result: Awaited<typeof tick> | undefined;
      void tick.then((value) => { result = value; });
      // Flush microtasks only: no 25-second deadline has elapsed.
      await vi.advanceTimersByTimeAsync(0);
      expect(result).toEqual({ outcome: 'unavailable', checkpointSaved: false });
      expect(vi.getTimerCount()).toBe(0);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(writes).toBe(0);
      expect(scans).toBe(stage === 'runtime' ? 1 : 0);
    } finally { vi.useRealTimers(); }
  });
  it('uses only existing fifteen-minute slots and refuses invalid schedule hints', () => {
    expect(
      supportReleaseFollowupWakeDue(Date.parse('2026-11-12T12:00:00.000Z')),
    ).toBe(true);
    expect(
      supportReleaseFollowupWakeDue(Date.parse('2026-11-12T12:15:00.000Z')),
    ).toBe(true);
    expect(
      supportReleaseFollowupWakeDue(Date.parse('2026-11-12T12:05:00.000Z')),
    ).toBe(false);
    expect(supportReleaseFollowupWakeDue(NaN)).toBe(false);
  });
  it('keeps OFF lazy and uses an independent purpose collection', async () => {
    const store: Store = {
      collection() {
        throw new Error('OFF must not initialize Store');
      },
    };
    const driver = createSupportReleaseFollowupDriver({
      store,
      clock: { now: () => new Date().toISOString() },
      enabled: () => false,
      runtime() {
        throw new Error('OFF must not initialize runtime');
      },
    });
    expect(await driver.runTick()).toEqual({
      outcome: 'disabled',
      checkpointSaved: false,
    });
    expect(supportReleaseFollowupCheckpoints.name).toBe(
      'pegma.support-release-followup-driver.v1',
    );
  });
  it('advances real confirmed deployed work to a draft and retest requests without sending or publishing', async () => {
    const f = await fixture();
    let complete = false;
    const outcomes: string[] = [];
    for (let tick = 0; tick < 20; tick++) {
      const before = f.f.state.modelCalls;
      const result = await f.driver.runTick();
      outcomes.push(result.outcome);
      expect(f.f.state.modelCalls - before).toBeLessThanOrEqual(1);
      if (result.outcome === 'scanned')
        expect(f.f.state.modelCalls).toBe(before);
      const work = await f.host.application.readEngineeringFollowupWork(
        f.staff,
        f.key,
      );
      if (work.status === 'bundle_prepared') {
        expect(work.preparedBundle!.bundle.retestRequests).toHaveLength(1);
        expect(work.delivered).toBeUndefined();
        complete = true;
        break;
      }
    }
    expect(complete, outcomes.join(',')).toBe(true);
    expect(f.f.state.modelCalls).toBe(1);
    const ticket = await f.host.application.readStaffTicket(
      f.staff,
      f.key.ticketId,
    );
    expect(
      ticket.messages.some((message) =>
        message.body.includes('deployed fix is ready'),
      ),
    ).toBe(false);
  });
  it('holds an unknown generation result without a second provider invocation', async () => {
    const f = await fixture();
    f.f.state.modelOutcome = 'unknown';
    for (let tick = 0; tick < 12; tick++) await f.driver.runTick();
    expect(f.f.state.modelCalls).toBe(1);
    const work = await f.host.application.readEngineeringFollowupWork(
      f.staff,
      f.key,
    );
    expect(work.preparedBundle).toBeUndefined();
    expect(work.delivered).toBeUndefined();
  });
});
