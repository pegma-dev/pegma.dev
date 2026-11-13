import { createMemoryStore, type Store } from '@pegma/storage-core';
import { describe, expect, it, vi } from 'vitest';
import { createSupportEngineeringDriver } from './support-engineering-driver';
import type { SupportEngineeringDeferredCheckHint } from './support-engineering';
import {
  driverHintRows,
  driverHintKey,
  engineeringDriverFixture,
  registerEngineeringDriverCases,
} from './support-engineering-driver-fixtures';

registerEngineeringDriverCases('actual Memory', async () => ({
  store: createMemoryStore(),
}));

/** Driver reference protocol only; these ports report pending and establish no
 * domain acceptance, proof, paid usage or Native capacity qualification. */
function referenceProtocol() {
  const store = createMemoryStore();
  const page = {
    pages: 1 as const,
    physicalRows: 32,
    nextCursor: 'after-the-page',
    candidates: Array.from({ length: 16 }, (_, index) => ({
      ticketId: 'fictional-work-' + index,
      sourceGeneration: 1,
    })),
    reconciliationSources: Array.from(
      { length: 16 },
      (_, index) => 'fictional-reconcile-' + index,
    ),
    reviewCandidates: [],
    reviewSources: [],
  };
  const runtime = {
    scanCandidates: vi.fn(async () => structuredClone(page)),
    processWork: vi.fn(
      async (_input: { ticketId: string; sourceGeneration: number }) => ({
        outcome: 'pending' as const,
        stage: 'finish' as const,
      }),
    ),
    reconcileSource: vi.fn(async (_ticketId: string) => ({
      outcome: 'pending' as const,
      processed: 0,
    })),
  };
  const tick = () =>
    createSupportEngineeringDriver({
      store,
      clock: { now: () => '2026-11-10T12:00:00.000Z' },
      isEnabled: () => true,
      runtime: () => runtime,
    }).runTick();
  return { store, page, runtime, tick };
}

/** Checkpoint protocol only. Genuine checker/Source/Work cases are registered
 * separately; these declared ports test concurrent reference ownership. */
async function deferredProtocol() {
  const store = createMemoryStore();
  const now = '2026-11-10T12:00:00.000Z';
  const hint: SupportEngineeringDeferredCheckHint = {
    kind: 'checks',
    operationId: 'a'.repeat(64),
    ticketId: 'fictional-work',
    sourceGeneration: 1,
    expiresAt: '2026-11-10T12:05:00.000Z',
  };
  const runtime = {
    scanCandidates: vi.fn(async () => ({
      outcome: 'held' as const,
      reason: 'engineering_disabled' as const,
    })),
    processWork: vi.fn(async () => ({
      outcome: 'checks_pending' as const,
      hint,
    })),
    reconcileSource: vi.fn(async () => ({
      outcome: 'pending' as const,
      processed: 0,
    })),
    precomputeChecks: vi.fn(async () => ({ outcome: 'checked' as const })),
  };
  const rows = store.collection(driverHintRows);
  async function write(targets: unknown[], generation = 1) {
    await rows.put({
      ...driverHintKey,
      format: 2,
      payload: JSON.stringify({ generation, cursor: 'saved-cursor', targets }),
    });
  }
  const read = async () =>
    JSON.parse(String((await rows.get(driverHintKey))?.payload)) as {
      generation: number;
      cursor: string;
      targets: unknown[];
    };
  const tick = () =>
    createSupportEngineeringDriver({
      store,
      clock: { now: () => now },
      isEnabled: () => true,
      runtime: () => runtime,
    }).runTick();
  await write([{ kind: 'work', ticketId: hint.ticketId, sourceGeneration: 1 }]);
  return { store, rows, hint, runtime, write, read, tick };
}

describe('deferred checker checkpoint protocol', () => {
  it('adds the durable proposal hint after consuming work and retains all other FIFO references', async () => {
    const t = await deferredProtocol();
    const rest = Array.from({ length: 31 }, (_, index) => ({
      kind: 'reconciliation',
      ticketId: 'other-' + index,
    }));
    await t.write([
      { kind: 'work', ticketId: t.hint.ticketId, sourceGeneration: 1 },
      ...rest,
    ]);
    expect(await t.tick()).toMatchObject({
      outcome: 'work',
      result: { outcome: 'checks_pending' },
      remainingTargets: 32,
    });
    expect((await t.read()).targets).toEqual([...rest, t.hint]);
    expect(t.runtime.precomputeChecks).not.toHaveBeenCalled();
  });
  it('replaces only the checks head with its work resume before precompute and never writes after it', async () => {
    const t = await deferredProtocol();
    const rest = { kind: 'reconciliation', ticketId: 'another' };
    await t.write([t.hint, rest]);
    let atCall: unknown;
    t.runtime.precomputeChecks.mockImplementation(async () => {
      atCall = await t.read();
      return { outcome: 'checked' };
    });
    expect(await t.tick()).toMatchObject({
      outcome: 'checks',
      result: { outcome: 'checked' },
      remainingTargets: 2,
    });
    expect(atCall).toEqual({
      generation: 2,
      cursor: 'saved-cursor',
      targets: [
        { kind: 'work', ticketId: t.hint.ticketId, sourceGeneration: 1 },
        rest,
      ],
    });
    expect(await t.read()).toEqual(atCall);
    expect(t.runtime.processWork).not.toHaveBeenCalled();
    expect(t.runtime.precomputeChecks).toHaveBeenCalledExactlyOnceWith(t.hint, {
      signal: expect.any(AbortSignal),
    });
  });
  it('merges into the current checkpoint after a concurrent pop without restoring consumed references', async () => {
    const t = await deferredProtocol();
    const other = { kind: 'reconciliation', ticketId: 'other' };
    await t.write([
      { kind: 'work', ticketId: t.hint.ticketId, sourceGeneration: 1 },
      other,
    ]);
    t.runtime.processWork.mockImplementation(async () => {
      await t.write([], 3); // Another owner genuinely consumed the other ref.
      return { outcome: 'checks_pending', hint: t.hint };
    });
    expect(await t.tick()).toMatchObject({
      outcome: 'work',
      remainingTargets: 1,
    });
    expect(await t.read()).toEqual({
      generation: 4,
      cursor: 'saved-cursor',
      targets: [t.hint],
    });
  });
  it('re-reads after a real merge CAS collision and preserves the concurrent cursor and FIFO', async () => {
    const t = await deferredProtocol();
    const other = { kind: 'reconciliation', ticketId: 'another' };
    let writes = 0;
    const store: Store = {
      collection(definition) {
        const actual = t.store.collection(definition);
        if (definition.name !== driverHintRows.name) return actual;
        return {
          ...actual,
          async putIfUnchanged(value, version) {
            if (++writes === 2)
              await t.rows.put({
                ...driverHintKey,
                format: 2,
                payload: JSON.stringify({
                  generation: 3,
                  cursor: 'concurrent-cursor',
                  targets: [other],
                }),
              });
            return actual.putIfUnchanged(value, version);
          },
        };
      },
    };
    expect(
      await createSupportEngineeringDriver({
        store,
        clock: { now: () => '2026-11-10T12:00:00.000Z' },
        isEnabled: () => true,
        runtime: () => t.runtime,
      }).runTick(),
    ).toMatchObject({ outcome: 'work', remainingTargets: 2 });
    expect(await t.read()).toEqual({
      generation: 4,
      cursor: 'concurrent-cursor',
      targets: [other, t.hint],
    });
    expect(writes).toBe(3);
  });
  it('does not discard a concurrent full backlog to insert an advisory deferred hint', async () => {
    const t = await deferredProtocol();
    const full = Array.from({ length: 32 }, (_, index) => ({
      kind: 'work',
      ticketId: 'other-' + index,
      sourceGeneration: 1,
    }));
    t.runtime.processWork.mockImplementation(async () => {
      await t.write(full, 7);
      return { outcome: 'checks_pending', hint: t.hint };
    });
    expect(await t.tick()).toMatchObject({
      outcome: 'work',
      remainingTargets: 32,
    });
    expect(await t.read()).toEqual({
      generation: 7,
      cursor: 'saved-cursor',
      targets: full,
    });
  });
  it('leaves a concurrent same-Work resume to recapture its own deferred operation', async () => {
    const t = await deferredProtocol();
    const work = {
      kind: 'work',
      ticketId: t.hint.ticketId,
      sourceGeneration: 1,
    };
    t.runtime.processWork.mockImplementation(async () => {
      await t.write([work], 8);
      return { outcome: 'checks_pending', hint: t.hint };
    });
    expect(await t.tick()).toMatchObject({
      outcome: 'work',
      remainingTargets: 1,
    });
    expect(await t.read()).toEqual({
      generation: 8,
      cursor: 'saved-cursor',
      targets: [work],
    });
  });
  it('holds an optional legacy runtime without a checker after saving the Work resume', async () => {
    const t = await deferredProtocol();
    await t.write([t.hint]);
    const { precomputeChecks: _ignored, ...legacy } = t.runtime;
    expect(
      await createSupportEngineeringDriver({
        store: t.store,
        clock: { now: () => '2026-11-10T12:00:00.000Z' },
        isEnabled: () => true,
        runtime: () => legacy,
      }).runTick(),
    ).toMatchObject({
      outcome: 'checks',
      result: { outcome: 'held' },
      remainingTargets: 1,
    });
    expect(t.runtime.precomputeChecks).not.toHaveBeenCalled();
    expect((await t.read()).targets).toEqual([
      { kind: 'work', ticketId: t.hint.ticketId, sourceGeneration: 1 },
    ]);
  });
  it('holds an expired check without calling a provider and leaves the work resume for fresh SDK guards', async () => {
    const t = await deferredProtocol();
    await t.write([{ ...t.hint, expiresAt: '2026-11-10T12:00:00.000Z' }]);
    expect(await t.tick()).toMatchObject({
      outcome: 'checks',
      result: { outcome: 'held' },
      remainingTargets: 1,
    });
    expect(t.runtime.precomputeChecks).not.toHaveBeenCalled();
    expect((await t.read()).targets).toEqual([
      { kind: 'work', ticketId: t.hint.ticketId, sourceGeneration: 1 },
    ]);
  });
  it('refuses a deferred operation bound to a different Work without scheduling it', async () => {
    const t = await deferredProtocol();
    t.runtime.processWork.mockResolvedValueOnce({
      outcome: 'checks_pending',
      hint: { ...t.hint, sourceGeneration: 2 },
    });
    expect(await t.tick()).toEqual({
      outcome: 'unavailable',
      checkpointSaved: true,
    });
    expect((await t.read()).targets).toEqual([]);
    expect(t.runtime.precomputeChecks).not.toHaveBeenCalled();
  });
  it.each(['operation', 'time', 'fields'] as const)(
    'rejects malformed %s check references before runtime work',
    async (fault) => {
      const t = await deferredProtocol();
      const hint = { ...t.hint };
      if (fault === 'operation') hint.operationId = 'not-a-hash';
      if (fault === 'time') hint.expiresAt = '2026-11-10T12:05:00Z';
      if (fault === 'fields')
        Reflect.set(hint, 'request', 'PRIVATE_NOT_CHECKPOINT_DATA');
      await t.write([hint]);
      expect(await t.tick()).toEqual({
        outcome: 'unavailable',
        checkpointSaved: false,
      });
      expect(t.runtime.precomputeChecks).not.toHaveBeenCalled();
      expect(t.runtime.processWork).not.toHaveBeenCalled();
    },
  );
});

describe('real Source and Work through deferred driver checks', () => {
  async function deferredCandidate() {
    const t = await engineeringDriverFixture(
      { store: createMemoryStore() },
      { deferredChecks: true },
    );
    expect(await t.phase()).toMatchObject({
      outcome: 'work',
      result: { outcome: 'candidate' },
    });
    expect(t.f.state.modelCalls).toBe(1);
    expect(await t.phase()).toMatchObject({
      outcome: 'work',
      result: { outcome: 'checks_pending' },
    });
    if (!t.deferred) throw new Error('Expected actual deferred adapter');
    const raw = await t.hint();
    const targets = JSON.parse(String(raw?.payload))
      .targets as SupportEngineeringDeferredCheckHint[];
    const hint = targets.find((target) => target.kind === 'checks');
    if (!hint) throw new Error('Expected durable check hint');
    expect((await t.f.work()).proposal).toBeUndefined();
    expect(t.deferred.state.calls).toBe(0);
    return { ...t, deferred: t.deferred, checkHint: hint };
  }
  it('runs a separate paid precompute, then prepares the exact proposal behind human approval', async () => {
    const t = await deferredCandidate();
    const writes = t.faults.hintWrites;
    expect(await t.tick()).toMatchObject({
      outcome: 'checks',
      result: { outcome: 'checked' },
    });
    expect(t.faults.hintWrites).toBe(writes + 1);
    expect(t.deferred.state.calls).toBe(1);
    expect((await t.f.work()).proposal).toBeUndefined();
    expect(await t.tick()).toMatchObject({
      outcome: 'work',
      result: { outcome: 'prepared' },
    });
    expect(t.f.state.modelCalls).toBe(1);
    expect(t.deferred.state.calls).toBe(1);
    expect(t.f.state.creates).toEqual([]);
    expect((await t.deferred.rows())?.entries[0]).toMatchObject({
      state: 'checked',
      request: null,
    });
    await t.approve();
    expect((await t.f.work()).approval?.decision).toBe('approve');
  });
  it('recovers a lost precompute acknowledgement from the actual durable receipt without a second paid call', async () => {
    const t = await deferredCandidate();
    t.deferred.state.losePrecomputeAck = true;
    const checked = await t.tick();
    expect(checked).toMatchObject({
      outcome: 'checks',
      result: { outcome: 'unknown' },
    });
    expect((await t.f.work()).proposal).toBeUndefined();
    expect((await t.deferred.rows())?.entries[0]?.state).toBe('checked');
    expect(await t.tick()).toMatchObject({
      outcome: 'work',
      result: { outcome: 'prepared' },
    });
    expect(t.deferred.state.calls).toBe(1);
    expect(t.f.state.modelCalls).toBe(1);
  });
  it('holds an unknown same-operation charge and never repeats its paid checker or creates a proposal', async () => {
    const t = await deferredCandidate();
    t.deferred.state.lost = true;
    expect(await t.tick()).toMatchObject({
      outcome: 'checks',
      result: { outcome: 'unknown' },
    });
    expect(await t.tick()).toMatchObject({
      outcome: 'work',
      result: { outcome: 'held' },
    });
    await t.store.collection(driverHintRows).put({
      ...driverHintKey,
      format: 2,
      payload: JSON.stringify({
        generation: 99,
        cursor: null,
        targets: [t.checkHint],
      }),
    });
    expect(await t.tick()).toMatchObject({
      outcome: 'checks',
      result: { outcome: 'unknown' },
    });
    expect(t.deferred.state.calls).toBe(1);
    expect(t.f.state.modelCalls).toBe(1);
    expect((await t.f.work()).proposal).toBeUndefined();
    expect((await t.deferred.rows())?.entries[0]).toMatchObject({
      state: 'unknown',
      request: null,
    });
  });
  it.each(['withdrawal', 'role', 'expiry'] as const)(
    'does not pay for %s of a genuine queued request',
    async (change) => {
      const t = await deferredCandidate();
      if (change === 'withdrawal')
        await t.f.runtime.withdraw(t.f.actors.staff, {
          ticketId: t.checkHint.ticketId,
          clientCommandId: 'withdraw-queued-check',
          reason: 'privacy_withdrawal',
        });
      if (change === 'role') await t.f.revoke('staff');
      if (change === 'expiry')
        t.f.advance(
          Date.parse(t.checkHint.expiresAt) - Date.parse(t.f.clock.now()),
        );
      expect(await t.tick()).toMatchObject({
        outcome: 'checks',
        result: { outcome: 'held' },
      });
      expect(t.deferred.state.calls).toBe(0);
      expect((await t.f.work()).proposal).toBeUndefined();
      if (change === 'expiry') await t.deferred.adapter.purgeExpired();
      expect((await t.deferred.rows())?.entries[0]?.request).toBeNull();
    },
  );
  it('does no checkpoint or provider work for an already cancelled queued invocation', async () => {
    const t = await deferredCandidate();
    const raw = await t.hint();
    const controller = new AbortController();
    controller.abort();
    expect(await t.tick({ signal: controller.signal })).toEqual({
      outcome: 'unavailable',
      checkpointSaved: false,
    });
    expect(await t.hint()).toEqual(raw);
    expect(t.deferred.state.calls).toBe(0);
  });
  it.each(['proof', 'key'] as const)(
    'stops before paying when processing is disabled at the awaited %s boundary',
    async (boundary) => {
      const t = await deferredCandidate();
      if (boundary === 'proof') {
        const original = t.f.resolve;
        vi.spyOn(t.f, 'resolve').mockImplementation(async (principalId) => {
          const access = await original(principalId);
          if (principalId === 'engineering-staff') t.faults.enabled = false;
          return access;
        });
      } else
        t.deferred.state.beforeKey = () => {
          t.faults.enabled = false;
        };
      expect(await t.tick()).toEqual({
        outcome: 'unavailable',
        checkpointSaved: true,
      });
      expect(t.deferred.state.calls).toBe(0);
      expect((await t.f.work()).proposal).toBeUndefined();
      expect(t.f.state.modelCalls).toBe(1);
      expect(t.f.state.creates).toEqual([]);
    },
  );
  it('cancels an awaited checker without a false proposal or any post-paid checkpoint write', async () => {
    const t = await deferredCandidate();
    let begin = () => {};
    let release = () => {};
    const entered = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.deferred.state.hook = async () => {
      begin();
      await proceed;
    };
    const controller = new AbortController();
    const pending = t.tick({ signal: controller.signal });
    await entered;
    const writes = t.faults.hintWrites;
    controller.abort();
    expect(await pending).toMatchObject({
      outcome: 'unavailable',
      checkpointSaved: true,
    });
    release();
    // Wait for the actual adapter's conservative settlement/redaction path.
    await Promise.all(t.deferred.pendingChecks);
    expect(t.faults.hintWrites).toBe(writes);
    expect(t.deferred.state.calls).toBe(1);
    expect((await t.f.work()).proposal).toBeUndefined();
    expect(t.f.state.creates).toEqual([]);
  });
  it('does not pay again when a concurrent Work resume observes the same pending checker', async () => {
    const t = await deferredCandidate();
    let begin = () => {};
    let release = () => {};
    const entered = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.deferred.state.hook = async () => {
      begin();
      await proceed;
    };
    const pending = t.tick();
    await entered;
    expect(await t.tick()).toMatchObject({
      outcome: 'work',
      result: { outcome: 'held' },
    });
    expect(t.deferred.state.calls).toBe(1);
    release();
    expect(await pending).toMatchObject({
      outcome: 'checks',
      result: { outcome: 'checked' },
    });
    expect(await t.phase()).toMatchObject({
      outcome: 'work',
      result: { outcome: 'prepared' },
    });
    expect(t.deferred.state.calls).toBe(1);
    expect(t.f.state.modelCalls).toBe(1);
  });
  it('repairs a consumed checks hint after its actual resume CAS acknowledgement is lost', async () => {
    const t = await deferredCandidate();
    t.faults.loseHintAck = true;
    expect(await t.tick()).toMatchObject({ outcome: 'unavailable' });
    expect(t.deferred.state.calls).toBe(0);
    // The actual durable queued operation re-emits from the SDK check path.
    expect(await t.tick()).toMatchObject({
      outcome: 'work',
      result: { outcome: 'checks_pending' },
    });
    expect(await t.tick()).toMatchObject({
      outcome: 'checks',
      result: { outcome: 'checked' },
    });
    expect(await t.tick()).toMatchObject({
      outcome: 'work',
      result: { outcome: 'prepared' },
    });
    expect(t.deferred.state.calls).toBe(1);
  });
  it('keeps a genuinely committed deferred merge with a lost acknowledgement and later prepares once', async () => {
    const t = await engineeringDriverFixture(
      { store: createMemoryStore() },
      { deferredChecks: true },
    );
    await t.phase();
    await t.selectWork();
    let writes = 0;
    t.faults.afterHintWrite = () => {
      if (++writes === 2) t.faults.loseHintAck = true;
    };
    expect(await t.tick()).toMatchObject({
      outcome: 'unavailable',
      checkpointSaved: true,
    });
    t.faults.afterHintWrite = undefined;
    expect(t.deferred?.state.calls).toBe(0);
    expect(await t.tick()).toMatchObject({
      outcome: 'checks',
      result: { outcome: 'checked' },
    });
    expect(await t.tick()).toMatchObject({
      outcome: 'work',
      result: { outcome: 'prepared' },
    });
    expect(t.deferred?.state.calls).toBe(1);
    expect(t.f.state.modelCalls).toBe(1);
  });
});

describe('bounded discovery backlog protocol', () => {
  it('retains all 32 references and drains FIFO across cold ticks despite a pending first result', async () => {
    const t = referenceProtocol();
    expect(await t.tick()).toMatchObject({
      outcome: 'scanned',
      physicalRows: 32,
      selected: true,
    });
    expect(t.runtime.scanCandidates).toHaveBeenCalledExactlyOnceWith({
      limit: 32,
    });
    expect(t.runtime.processWork).not.toHaveBeenCalled();
    expect(t.runtime.reconcileSource).not.toHaveBeenCalled();
    for (let index = 0; index < 32; index++) {
      const result = await t.tick();
      expect(result).toMatchObject({
        outcome: index < 16 ? 'reconciliation' : 'work',
        remainingTargets: 31 - index,
      });
    }
    expect(
      t.runtime.reconcileSource.mock.calls.map(([ticketId]) => ticketId),
    ).toEqual(t.page.reconciliationSources);
    expect(
      t.runtime.processWork.mock.calls.map(([key]) => ({
        ticketId: key.ticketId,
        sourceGeneration: key.sourceGeneration,
      })),
    ).toEqual(t.page.candidates);
    expect(t.runtime.scanCandidates).toHaveBeenCalledOnce();
    const raw = await t.store.collection(driverHintRows).get(driverHintKey);
    expect(raw?.format).toBe(2);
    expect(JSON.parse(String(raw?.payload))).toEqual({
      generation: 33,
      cursor: 'after-the-page',
      targets: [],
    });
  });
  it.each(['over-page', 'over-targets', 'duplicate', 'unknown-key'] as const)(
    'refuses malformed %s pages without advancing the cursor',
    async (fault) => {
      const t = referenceProtocol();
      if (fault === 'over-page') t.page.physicalRows = 33;
      if (fault === 'over-targets') t.page.physicalRows = 31;
      if (fault === 'duplicate')
        t.page.candidates[1] = { ...t.page.candidates[0]! };
      if (fault === 'unknown-key')
        Reflect.set(t.page.candidates[0]!, 'body', 'not-a-reference');
      expect(await t.tick()).toEqual({
        outcome: 'unavailable',
        checkpointSaved: false,
      });
      expect(
        await t.store.collection(driverHintRows).get(driverHintKey),
      ).toBeNull();
      expect(t.runtime.processWork).not.toHaveBeenCalled();
      expect(t.runtime.reconcileSource).not.toHaveBeenCalled();
    },
  );
  it.each(['empty', 'work'] as const)(
    'reads strict legacy v1 %s hints and migrates through real CAS before an SDK stage',
    async (kind) => {
      const t = await engineeringDriverFixture({ store: createMemoryStore() });
      await t.store.collection(driverHintRows).put({
        ...driverHintKey,
        format: 1,
        payload: JSON.stringify({
          generation: 7,
          cursor: null,
          target: kind === 'empty' ? null : { kind: 'work', ...t.f.key() },
        }),
      });
      expect((await t.tick()).outcome).toBe(
        kind === 'empty' ? 'scanned' : 'work',
      );
      const raw = await t.hint();
      expect(raw?.format).toBe(2);
      expect(JSON.parse(String(raw?.payload))).toMatchObject({
        generation: 8,
        targets: kind === 'empty' ? [{ kind: 'work', ...t.f.key() }] : [],
      });
      expect(t.f.state.modelCalls).toBe(kind === 'empty' ? 0 : 1);
    },
  );
  it.each(['duplicate', 'over-limit', 'null', 'unknown-field'] as const)(
    'rejects invalid v2 %s without treating hints as authority',
    async (fault) => {
      const t = referenceProtocol();
      const first = {
        kind: 'work',
        ticketId: 'fictional-work',
        sourceGeneration: 1,
      };
      const payload = {
        generation: 1,
        cursor: null,
        targets:
          fault === 'duplicate'
            ? [first, first]
            : fault === 'over-limit'
              ? Array.from({ length: 33 }, (_, index) => ({
                  ...first,
                  ticketId: 'fictional-' + index,
                }))
              : fault === 'null'
                ? [null]
                : [first],
      };
      if (fault === 'unknown-field')
        Reflect.set(payload, 'authority', 'untrusted');
      await t.store
        .collection(driverHintRows)
        .put({ ...driverHintKey, format: 2, payload: JSON.stringify(payload) });
      expect(await t.tick()).toEqual({
        outcome: 'unavailable',
        checkpointSaved: false,
      });
      expect(t.runtime.scanCandidates).not.toHaveBeenCalled();
      expect(t.runtime.processWork).not.toHaveBeenCalled();
    },
  );
});

describe('engineering driver hint ownership and stop boundaries', () => {
  it('keeps default, disabled and throwing enablement before runtime or Store work', async () => {
    const store = createMemoryStore();
    const runtime = vi.fn();
    for (const isEnabled of [
      undefined,
      () => false,
      () => {
        throw new Error('Fictional flag outage');
      },
    ]) {
      const driver = createSupportEngineeringDriver({
        store,
        clock: { now: () => '2026-11-10T00:00:00.000Z' },
        runtime,
        ...(isEnabled === undefined ? {} : { isEnabled }),
      });
      expect(await driver.runTick()).toEqual({
        outcome: 'disabled',
        checkpointSaved: false,
      });
    }
    expect(runtime).not.toHaveBeenCalled();
    expect(
      await store.collection(driverHintRows).get(driverHintKey),
    ).toBeNull();
  });
  it('admits only one concurrent cold owner of a target hint through genuine Store CAS', async () => {
    const t = await engineeringDriverFixture({ store: createMemoryStore() });
    await t.selectWork();
    let release = () => {};
    let both = () => {};
    let reads = 0;
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      both = resolve;
    });
    t.faults.afterHintRead = async () => {
      reads++;
      if (reads === 2) both();
      await proceed;
    };
    const pending = Promise.all([t.tick(), t.tick()]);
    await ready;
    release();
    const results = await pending;
    expect(results.map((result) => result.outcome).sort()).toEqual([
      'contended',
      'work',
    ]);
    expect(t.f.state.modelCalls).toBe(1);
    expect(t.faults.workCalls).toBe(1);
  });
  it('does not call the SDK after disablement during the actual target CAS', async () => {
    const t = await engineeringDriverFixture({ store: createMemoryStore() });
    await t.selectWork();
    t.faults.afterHintWrite = () => {
      t.faults.enabled = false;
    };
    expect((await t.tick()).outcome).toBe('unavailable');
    expect(t.f.state.modelCalls).toBe(0);
    expect(t.faults.workCalls).toBe(0);
  });
  it('refuses corrupted or exhausted hint generations without treating them as SDK state', async () => {
    const store = createMemoryStore();
    const t = await engineeringDriverFixture({ store });
    for (const value of [
      { generation: Number.MAX_SAFE_INTEGER, cursor: null, target: null },
      {
        generation: 1,
        cursor: 'cursor',
        target: { kind: 'work', ticketId: 'fake', sourceGeneration: 0 },
      },
      { generation: 1, cursor: 'x'.repeat(16_385), target: null },
    ]) {
      await store
        .collection(driverHintRows)
        .put({ ...driverHintKey, format: 1, payload: JSON.stringify(value) });
      expect(await t.tick()).toEqual({
        outcome: 'unavailable',
        checkpointSaved: false,
      });
    }
    expect(t.faults.scans).toBe(0);
    expect(t.faults.workCalls).toBe(0);
    expect(t.f.state.modelCalls).toBe(0);
  });
  it('forwards caller abort to the actual SDK model boundary and retains its unknown paid liability', async () => {
    const t = await engineeringDriverFixture({ store: createMemoryStore() });
    await t.selectWork();
    let begin = () => {};
    let release = () => {};
    let observedSignal: AbortSignal | undefined;
    const entered = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = t.f.ports.model.generate;
    vi.spyOn(t.f.ports.model, 'generate').mockImplementation(
      async (input, context, config) => {
        const result = await original(input, context, config);
        observedSignal = context.signal;
        begin();
        await proceed;
        return result;
      },
    );
    const controller = new AbortController();
    const pending = t.tick({ signal: controller.signal });
    await Promise.race([
      entered,
      pending.then(() => {
        throw new Error('Actual paid model boundary was not reached');
      }),
    ]);
    expect(t.f.state.modelCalls).toBe(1);
    controller.abort();
    expect((await pending).outcome).toBe('unavailable');
    expect(observedSignal?.aborted).toBe(true);
    release();
    await Promise.all(t.pendingWork);
    // Abort may stop the SDK's settlement write itself. The original durable
    // reservation is still an uncertain liability, never a not_called refund.
    expect(await t.usage()).toMatchObject({
      spentMicros: '0',
      reservations: [{ state: 'reserved', reservedMicros: 1_000 }],
    });
    expect((await t.f.work()).candidate).toBeUndefined();
    expect(t.f.state.creates).toEqual([]);
  });
  it('bounds a nonsettling real Store read and removes the abort listener after its total deadline', async () => {
    const t = await engineeringDriverFixture({ store: createMemoryStore() });
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
});
