import { describe, expect, it, vi } from 'vitest';
import { createMemoryStore, type Store } from '@pegma/storage-core';
import {
  createSupportReleaseFollowupDriver,
  supportReleaseFollowupCheckpoints,
  type SupportReleaseFollowupDriverOptions,
} from './support-release-followup-driver';

type Runtime = NonNullable<
  ReturnType<SupportReleaseFollowupDriverOptions['runtime']>
>;
const key = { partition: 'release-followup', id: 'cursor' };
const work = { ticketId: 'fictional-ticket', workId: 'fictional-work' };
const now = '2026-11-12T12:00:00.000Z';
const expiresAt = '2026-11-12T12:05:00.000Z';

/** Controller ownership coverage over the actual Memory Store. Runtime replies
 * are controlled protocol fixtures; real SDK/Root/Native tests qualify work. */
function fixture() {
  const backing = createMemoryStore();
  const events: string[] = [];
  const store: Store = {
    collection(definition) {
      const rows = backing.collection(definition);
      return {
        ...rows,
        async getVersioned(key) {
          events.push('cursor-read');
          return rows.getVersioned(key);
        },
        async putIfUnchanged(value, version) {
          events.push('cursor-write');
          return rows.putIfUnchanged(value, version);
        },
      };
    },
  };
  const rows = backing.collection(supportReleaseFollowupCheckpoints);
  const process = vi.fn<Runtime['process']>(async () => ({
    outcome: 'not_claimed',
  }));
  const precomputeChecks = vi.fn<NonNullable<Runtime['precomputeChecks']>>(
    async () => ({ outcome: 'held' }),
  );
  const runtime: Runtime = {
    scanProcessing: vi.fn(async () => ({
      associations: [],
      candidates: [],
      reviewCandidates: [],
      attentionSources: [],
      physicalRows: 0,
      pages: 1 as const,
      nextCursor: null,
    })),
    process,
    scanChecks: vi.fn(async () => []),
    precomputeChecks,
  };
  const driver = createSupportReleaseFollowupDriver({
    store,
    clock: { now: () => now },
    enabled: () => true,
    invocationMode: 'staged',
    runtime: () => runtime,
  });
  const seed = (targets: Parameters<typeof rows.put>[0]['targets'] = [work]) =>
    rows.put({ generation: 1, cursor: null, targets });
  return {
    backing,
    rows,
    driver,
    runtime,
    process,
    precomputeChecks,
    events,
    seed,
  };
}

describe('staged follow-up advisory continuation ownership', () => {
  it('retains the original Work before an unknown planning ACK, then drains only a nonprovider not_claimed result', async () => {
    const f = fixture();
    await f.seed();
    f.process.mockImplementationOnce(async () => {
      expect((await f.rows.get(key))?.targets).toEqual([
        { ...work, remainingInvocations: 7 },
      ]);
      throw new Error('Fictional lost planning ACK');
    });
    expect(await f.driver.runTick()).toEqual({
      outcome: 'unavailable',
      checkpointSaved: true,
    });
    expect((await f.rows.get(key))?.targets).toHaveLength(1);
    expect(await f.driver.runTick()).toMatchObject({
      outcome: 'work',
      result: { outcome: 'not_claimed' },
      remainingTargets: 0,
    });
    expect((await f.rows.get(key))?.targets).toEqual([]);
  });

  it('does not read or write the cursor again after a possible provider phase', async () => {
    const f = fixture();
    await f.seed();
    f.process.mockImplementationOnce(async () => {
      f.events.push('provider-phase');
      return {
        outcome: 'pending',
        stage: 'complete',
        checkpoint: 'model_recorded',
        callState: 'recorded',
      };
    });
    expect(await f.driver.runTick()).toMatchObject({
      outcome: 'work',
      remainingTargets: 1,
    });
    expect(f.events).toEqual(['cursor-read', 'cursor-write', 'provider-phase']);
    expect((await f.rows.get(key))?.targets).toEqual([
      { ...work, remainingInvocations: 7 },
    ]);
  });

  it('prewrites a check continuation and returns to Work only after the separate checked receipt phase', async () => {
    const f = fixture();
    await f.seed();
    f.process.mockResolvedValueOnce({
      outcome: 'pending',
      stage: 'bundle',
      checkpoint: 'checks_planned',
      callState: 'not_called',
      checks: { operationId: 'opaque-operation', expiresAt },
    });
    await f.driver.runTick();
    expect((await f.rows.get(key))?.targets[0]).toMatchObject({
      kind: 'checks',
      ...work,
      operationId: 'opaque-operation',
    });
    f.precomputeChecks.mockImplementationOnce(async (hint) => {
      expect(hint).toMatchObject({ ...work, operationId: 'opaque-operation' });
      expect((await f.rows.get(key))?.targets[0]).toMatchObject({
        remainingInvocations: 7,
      });
      f.events.push('provider-phase');
      return { outcome: 'received' };
    });
    f.events.length = 0;
    await f.driver.runTick();
    expect(f.events).toEqual(['cursor-read', 'cursor-write', 'provider-phase']);
    expect((await f.rows.get(key))?.targets[0]).toHaveProperty(
      'kind',
      'checks',
    );
    f.precomputeChecks.mockResolvedValueOnce({ outcome: 'checked' });
    await f.driver.runTick();
    expect((await f.rows.get(key))?.targets).toEqual([
      { ...work, remainingInvocations: 8 },
    ]);
    expect(f.process).toHaveBeenCalledOnce();
  });

  it('uses a separate no-SDK settling tick when the bounded continuation count is exhausted', async () => {
    const f = fixture();
    const other = { ticketId: 'other-ticket', workId: 'other-work' };
    await f.seed([{ ...work, remainingInvocations: 0 }, other]);
    expect(await f.driver.runTick()).toEqual({
      outcome: 'settled',
      remainingTargets: 1,
      checkpointSaved: true,
    });
    expect(f.process).not.toHaveBeenCalled();
    expect(f.precomputeChecks).not.toHaveBeenCalled();
    expect((await f.rows.get(key))?.targets).toEqual([other]);
  });

  it('preserves another consumer advance instead of replacing its hint after an awaited nonprovider result', async () => {
    const f = fixture();
    await f.seed();
    const other = { ticketId: 'other-ticket', workId: 'other-work' };
    f.process.mockImplementationOnce(async () => {
      const head = await f.rows.getVersioned(key);
      if (!head) throw new Error('Actual cursor required');
      expect(
        await f.rows.putIfUnchanged(
          {
            generation: head.value.generation + 1,
            cursor: null,
            targets: [other],
          },
          head.version,
        ),
      ).toBe(true);
      return { outcome: 'not_claimed' };
    });
    expect(await f.driver.runTick()).toEqual({
      outcome: 'contended',
      checkpointSaved: true,
    });
    expect((await f.rows.get(key))?.targets).toEqual([other]);
  });

  it('never selects a pending staff reassessment for the process worker', async () => {
    const f = fixture();
    vi.mocked(f.runtime.scanChecks!).mockResolvedValueOnce([
      {
        operationId: 'staff-operation',
        scope: work,
        expiresAt,
        phase: 'provider',
        mode: 'reassessment',
      },
      {
        operationId: 'work-operation',
        scope: work,
        expiresAt,
        phase: 'provider',
        mode: 'work',
      },
    ]);
    expect(await f.driver.runTick()).toMatchObject({
      outcome: 'checks_scanned',
      hints: 1,
    });
    expect((await f.rows.get(key))?.targets).toMatchObject([
      { kind: 'checks', operationId: 'work-operation', ...work },
    ]);
    expect(f.process).not.toHaveBeenCalled();
    expect(f.precomputeChecks).not.toHaveBeenCalled();
  });
});
