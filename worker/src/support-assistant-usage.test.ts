import type {
  AssistantAttemptContext,
  AssistantModelUsage,
  AssistantUsageIdentity,
  AssistantUsagePort,
} from '@pegma/support-desk-ai';
import {
  createMemoryStore,
  defineCollection,
  type CollectionDefinition,
  type CollectionStore,
  type Store,
  type StoredRecord,
} from '@pegma/storage-core';
import { describe, expect, it } from 'vitest';
import {
  createSupportAssistantUsage,
  type SupportAssistantUsagePolicy,
} from './support-assistant-usage';

const START = '2026-11-10T00:00:00.000Z';
const KEY = { partition: 'support_answer', id: 'budget' };
const rawRecords = defineCollection<StoredRecord>({
  name: 'pegma.support-assistant-usage.v1',
  key: (value) => ({
    partition: String(value.partition),
    id: String(value.id),
  }),
  codec: {
    encode: (value) => ({ ...value }),
    decode: (value) => ({ ...value }),
  },
});

function policy(
  overrides: Partial<SupportAssistantUsagePolicy> = {},
): SupportAssistantUsagePolicy {
  return {
    version: 'synthetic-budget-v1',
    scopeRef: 'synthetic-scope',
    configurationVersion: 'synthetic-config-v1',
    modelVersion: 'synthetic-model-v1',
    pricingRef: 'synthetic-price-v1',
    currency: 'USD',
    maxCostMicros: 100,
    maxReservationCostMicros: 10,
    maxReservations: 4,
    validFrom: START,
    validUntil: '2026-11-10T00:10:00.000Z',
    terminalRetentionMilliseconds: 1_000,
    ...overrides,
  };
}

function context(id = 'a', at = START): AssistantAttemptContext {
  return {
    purpose: 'support_answer',
    operationId: `operation-${id}`,
    attemptId: `attempt-${id}`,
    attempt: 1,
    fence: {
      commandId: `command-${id}`,
      correlationId: `correlation-${id}`,
      ticketId: `ticket-${id}`,
      turnId: `turn-${id}`,
      workerId: 'synthetic-worker',
      claimId: `claim-${id}`,
      claimGeneration: 1,
      attempt: 1,
      attemptId: `attempt-${id}`,
      expectedRevision: 1,
      expectedHandlingGeneration: 0,
      triggerMessageId: `message-${id}`,
    },
    inputFingerprint: `fingerprint-${id}`,
    configurationVersion: 'synthetic-config-v1',
    promptVersion: 'synthetic-prompt-v1',
    modelVersion: 'synthetic-model-v1',
    audienceVersion: 'synthetic-audience-v1',
    policyVersion: 'synthetic-audience-policy-v1',
    usageScopeRef: 'synthetic-scope',
    usageReservationId: `reservation-${id}`,
    applicability: { productId: 'synthetic-product', productVersion: '1' },
    allSourceReferences: [],
    deadline: new Date(Date.parse(at) + 25_000).toISOString(),
    signal: new AbortController().signal,
    budgets: {
      maxMessages: 2,
      maxInputBytes: 1_000,
      maxInputTokens: 500,
      maxContextTokens: 1_000,
      maxOutputBytes: 500,
      maxOutputTokens: 100,
      maxDurationMilliseconds: 25_000,
      maxCostMicros: 10,
      currency: 'USD',
      maxAttempts: 2,
      maxAssistantTurns: 2,
      maxMessageCharacters: 500,
      maxAnswerTextCharacters: 400,
    },
  };
}

function identity(value: AssistantAttemptContext): AssistantUsageIdentity {
  return {
    operationId: value.operationId,
    attemptId: value.attemptId,
    inputFingerprint: value.inputFingerprint,
    usageReservationId: value.usageReservationId,
  };
}

function usage(costMicros = 5): AssistantModelUsage {
  return { inputTokens: 12, outputTokens: 3, costMicros, currency: 'USD' };
}

interface Hooks {
  readonly beforeDecision?: (number: number) => Promise<void>;
  readonly afterUpdate?: () => Promise<void>;
  readonly unavailable?: () => boolean;
}

/** Observes only public ports; the actual Memory Store owns reads/writes/OCC. */
function observe(backing: Store, hooks: Hooks = {}) {
  const counts = { collections: 0, updates: 0, decisions: 0, enumerations: 0 };
  const attempts: (number | undefined)[] = [];
  const store: Store = {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      counts.collections += 1;
      const target = backing.collection(definition);
      return {
        ...target,
        async update(key, decide, options) {
          counts.updates += 1;
          attempts.push(options?.maxAttempts);
          if (hooks.unavailable?.())
            throw new Error('synthetic storage outage');
          const result = await target.update(
            key,
            async (current) => {
              counts.decisions += 1;
              await hooks.beforeDecision?.(counts.decisions);
              return decide(current);
            },
            options,
          );
          await hooks.afterUpdate?.();
          return result;
        },
        async scan() {
          counts.enumerations += 1;
          throw new Error('Unexpected scan');
        },
        async list() {
          counts.enumerations += 1;
          throw new Error('Unexpected list');
        },
        async listVersioned() {
          counts.enumerations += 1;
          throw new Error('Unexpected list');
        },
      };
    },
  };
  return { store, counts, attempts };
}

function fixture(
  overrides: Partial<SupportAssistantUsagePolicy> = {},
  hooks: Hooks = {},
) {
  const backing = createMemoryStore();
  const observed = observe(backing, hooks);
  let at = START;
  const clock = { now: () => at };
  const selected = policy(overrides);
  const create = () =>
    createSupportAssistantUsage({
      store: observed.store,
      clock,
      policy: selected,
    });
  return {
    backing,
    observed,
    clock,
    selected,
    create,
    port: create(),
    setTime: (value: string) => {
      at = value;
    },
    advance: (milliseconds: number) => {
      at = new Date(Date.parse(at) + milliseconds).toISOString();
    },
  };
}

interface StoredLedger {
  readonly accountingHold: boolean;
  readonly spentMicros: string;
  readonly reservations: readonly {
    readonly state: string;
    readonly reservedMicros: number;
    readonly usage: AssistantModelUsage | null;
  }[];
}

async function ledger(store: Store): Promise<StoredLedger | null> {
  const record = await store.collection(rawRecords).get(KEY);
  return record === null
    ? null
    : (JSON.parse(String(record.payload)) as StoredLedger);
}

function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('Support assistant durable usage port', () => {
  it.each([0, -1, 1.5, NaN, Infinity, 11])(
    'refuses an unfunded or invalid context cost before storage: %s',
    async (maxCostMicros) => {
      const f = fixture();
      const input = context();
      expect(
        await f.port.reserve({
          ...input,
          budgets: { ...input.budgets, maxCostMicros },
        }),
      ).toEqual({ outcome: 'denied' });
      expect(f.observed.counts.collections).toBe(0);
      expect(await ledger(f.backing)).toBeNull();
    },
  );

  it('retains the policy hold for a smaller positive request budget across exact replay', async () => {
    const f = fixture();
    const original = context();
    const input = {
      ...original,
      budgets: { ...original.budgets, maxCostMicros: 5 },
    };
    const expected = {
      outcome: 'reserved',
      usageReservationId: input.usageReservationId,
    };
    expect(await f.port.reserve(input)).toEqual(expected);
    expect((await ledger(f.backing))?.reservations[0]?.reservedMicros).toBe(10);
    const retained = await f.backing.collection(rawRecords).get(KEY);
    expect(await f.create().reserve(input)).toEqual(expected);
    expect(await f.backing.collection(rawRecords).get(KEY)).toEqual(retained);
    expect(
      (
        await f.port.reserve({
          ...input,
          budgets: { ...input.budgets, maxCostMicros: 6 },
        })
      ).outcome,
    ).toBe('denied');
    expect(await f.backing.collection(rawRecords).get(KEY)).toEqual(retained);
  });

  it('keeps the default unavailable before any Store operation', async () => {
    const backing = createMemoryStore();
    const observed = observe(backing);
    const port: AssistantUsagePort = createSupportAssistantUsage({
      store: observed.store,
      clock: { now: () => START },
    });
    expect(await port.reserve(context())).toEqual({ outcome: 'unavailable' });
    expect(
      await port.reconcile(identity(context()), { state: 'unknown' }),
    ).toBe('pending');
    expect(observed.counts.collections).toBe(0);
    expect(await ledger(backing)).toBeNull();
  });

  it.each([
    { maxReservations: 33 },
    { terminalRetentionMilliseconds: 0 },
    { validUntil: '2026-12-12T00:00:00.000Z' },
    { maxReservationCostMicros: 101 },
  ])('rejects an invalid finite host policy: %j', (invalid) => {
    expect(() => fixture(invalid)).toThrow(TypeError);
  });

  it('rejects extra policy fields rather than storing an unreviewed value', () => {
    const selected = { ...policy(), extra: 'not a ledger field' };
    expect(() =>
      createSupportAssistantUsage({
        store: createMemoryStore(),
        clock: { now: () => START },
        policy: selected,
      }),
    ).toThrow(TypeError);
  });

  it('recovers exact reservation ACKs across new factory instances without another debit', async () => {
    const f = fixture();
    const input = context();
    const expected = {
      outcome: 'reserved',
      usageReservationId: input.usageReservationId,
    };
    expect(await f.port.reserve(input)).toEqual(expected);
    expect(await f.create().reserve(input)).toEqual(expected);
    expect((await ledger(f.backing))?.reservations).toHaveLength(1);
    expect(f.observed.attempts).toEqual([2, 2]);
    expect(f.observed.counts.enumerations).toBe(0);
  });

  it('refuses a reused reservation id or attempt with changed semantic binding', async () => {
    const f = fixture();
    const a = context();
    expect((await f.port.reserve(a)).outcome).toBe('reserved');
    expect(
      (await f.port.reserve({ ...a, inputFingerprint: 'changed' })).outcome,
    ).toBe('denied');
    expect(
      (
        await f.port.reserve({
          ...context('b'),
          usageReservationId: a.usageReservationId,
        })
      ).outcome,
    ).toBe('denied');
    expect(
      (await f.port.reserve({ ...a, usageReservationId: 'other-reservation' }))
        .outcome,
    ).toBe('denied');
    expect(
      (await f.port.reserve({ ...a, audienceVersion: 'changed' })).outcome,
    ).toBe('denied');
    expect(
      (
        await f.port.reserve({
          ...a,
          budgets: { ...a.budgets, maxInputTokens: 499 },
        })
      ).outcome,
    ).toBe('denied');
    expect(
      (
        await f.port.reserve({
          ...a,
          applicability: { ...a.applicability, buildId: 'other' },
        })
      ).outcome,
    ).toBe('denied');
    expect(
      (
        await f.port.reserve({
          ...a,
          allSourceReferences: [
            {
              articleId: 'synthetic-guide',
              collectionId: 'synthetic-collection',
              contentHash: 'a'.repeat(64),
              collectionPolicyVersion: 1,
              articleRevision: 1,
              applicationGeneration: 1,
              governanceGeneration: 1,
              validationGeneration: 1,
            },
          ],
        })
      ).outcome,
    ).toBe('denied');
    expect((await ledger(f.backing))?.reservations).toHaveLength(1);
  });

  it.each(['scope', 'configuration', 'model', 'currency', 'cost'] as const)(
    'refuses a context outside the immutable %s policy before storage',
    async (field) => {
      const f = fixture();
      const a = context();
      const input =
        field === 'scope'
          ? { ...a, usageScopeRef: 'other' }
          : field === 'configuration'
            ? { ...a, configurationVersion: 'other' }
            : field === 'model'
              ? { ...a, modelVersion: 'other' }
              : field === 'currency'
                ? { ...a, budgets: { ...a.budgets, currency: 'EUR' } }
                : { ...a, budgets: { ...a.budgets, maxCostMicros: 11 } };
      expect((await f.port.reserve(input)).outcome).toBe('denied');
      expect(f.observed.counts.collections).toBe(0);
    },
  );

  it('refuses expired/window-crossing/aborted contexts and an invalid clock', async () => {
    const f = fixture();
    const a = context();
    expect((await f.port.reserve({ ...a, deadline: START })).outcome).toBe(
      'denied',
    );
    expect(
      (await f.port.reserve({ ...a, deadline: '2026-11-10T00:10:01.000Z' }))
        .outcome,
    ).toBe('denied');
    const controller = new AbortController();
    controller.abort();
    expect(
      (await f.port.reserve({ ...a, signal: controller.signal })).outcome,
    ).toBe('denied');
    f.setTime('2026-11-09T23:59:59.000Z');
    expect((await f.port.reserve(a)).outcome).toBe('denied');
    f.setTime('invalid');
    expect((await f.port.reserve(a)).outcome).toBe('unavailable');
    expect(f.observed.counts.collections).toBe(0);
  });

  it('uses real OCC to prevent concurrent reservations exceeding the pool', async () => {
    const bothRead = deferred();
    const proceed = deferred();
    const f = fixture(
      { maxCostMicros: 15 },
      {
        beforeDecision: async (number) => {
          if (number > 2) return;
          if (number === 2) bothRead.release();
          await proceed.promise;
        },
      },
    );
    const pending = Promise.all([
      f.port.reserve(context('a')),
      f.port.reserve(context('b')),
    ]);
    await bothRead.promise;
    proceed.release();
    const results = await pending;
    expect(results.map((value) => value.outcome).sort()).toEqual([
      'denied',
      'reserved',
    ]);
    expect((await ledger(f.backing))?.reservations).toHaveLength(1);
    expect(f.observed.counts.updates).toBe(2);
    expect(f.observed.counts.decisions).toBeLessThanOrEqual(4);
    expect(f.observed.attempts).toEqual([2, 2]);
  });

  it('keeps uncertain reservations at the slot cap past every retention deadline', async () => {
    const f = fixture({ maxReservations: 2 });
    const a = context('a');
    const b = context('b');
    await f.port.reserve(a);
    await f.port.reserve(b);
    expect(await f.port.reconcile(identity(a), { state: 'unknown' })).toBe(
      'reconciled',
    );
    expect(await f.port.reconcile(identity(a), { state: 'not_called' })).toBe(
      'pending',
    );
    f.advance(120_000);
    expect((await f.port.reserve(context('c', f.clock.now()))).outcome).toBe(
      'denied',
    );
    expect(
      (await ledger(f.backing))?.reservations.map((entry) => entry.state),
    ).toEqual(['unknown', 'reserved']);
  });

  it('settles exact known duplicates without a false accounting hold or downgrade', async () => {
    const f = fixture();
    const a = context();
    await f.port.reserve(a);
    expect(
      await f.port.reconcile(identity(a), { state: 'known', usage: usage() }),
    ).toBe('reconciled');
    expect(
      await f
        .create()
        .reconcile(identity(a), { state: 'known', usage: usage() }),
    ).toBe('reconciled');
    expect(await f.port.reconcile(identity(a), { state: 'not_called' })).toBe(
      'pending',
    );
    expect(await f.port.reconcile(identity(a), { state: 'unknown' })).toBe(
      'reconciled',
    );
    expect((await ledger(f.backing))?.spentMicros).toBe('5');
    expect((await ledger(f.backing))?.accountingHold).toBe(false);
    expect((await f.port.reserve(context('b'))).outcome).toBe('reserved');
  });

  it('durably blocks new cost after a contradictory higher known charge', async () => {
    const f = fixture({ maxCostMicros: 100 });
    const a = context('a');
    expect((await f.port.reserve(a)).outcome).toBe('reserved');
    expect(
      await f.port.reconcile(identity(a), { state: 'known', usage: usage(5) }),
    ).toBe('reconciled');
    // The original known charge cannot justify spending the rest of this pool
    // after another observation reports a larger liability for the same call.
    expect(
      await f.port.reconcile(identity(a), {
        state: 'known',
        usage: usage(150),
      }),
    ).toBe('pending');
    expect((await ledger(f.backing))?.accountingHold).toBe(true);
    expect((await f.create().reserve(context('b'))).outcome).toBe('denied');
    // Replaying an older observation must not clear a durable accounting hold.
    await f
      .create()
      .reconcile(identity(a), { state: 'known', usage: usage(5) });
    expect((await f.create().reserve(context('c'))).outcome).toBe('denied');
  });

  it('preserves a real OCC accounting conflict hold after a lost committed acknowledgement', async () => {
    const bothRead = deferred();
    const proceed = deferred();
    let lostHoldAck = false;
    const f: ReturnType<typeof fixture> = fixture(
      {},
      {
        beforeDecision: async (number) => {
          // The reservation is decision1; both competing observations read it.
          if (number !== 2 && number !== 3) return;
          if (number === 3) bothRead.release();
          await proceed.promise;
        },
        afterUpdate: async () => {
          if ((await ledger(f.backing))?.accountingHold && !lostHoldAck) {
            lostHoldAck = true;
            throw new Error('synthetic lost accounting-hold acknowledgement');
          }
        },
      },
    );
    const a = context();
    await f.port.reserve(a);
    const pending = Promise.all([
      f.port.reconcile(identity(a), { state: 'known', usage: usage(5) }),
      f.port.reconcile(identity(a), { state: 'known', usage: usage(150) }),
    ]);
    await bothRead.promise;
    proceed.release();
    expect(await pending).toContain('pending');
    expect(lostHoldAck).toBe(true);
    const stored = await ledger(f.backing);
    expect(stored?.accountingHold).toBe(true);
    const accepted = stored?.reservations[0]?.usage;
    if (accepted === null || accepted === undefined)
      throw new Error('Actual accepted usage was not retained');
    expect(
      await f
        .create()
        .reconcile(identity(a), { state: 'known', usage: accepted }),
    ).toBe('pending');
    expect((await f.create().reserve(context('b'))).outcome).toBe('denied');
    expect((await ledger(f.backing))?.accountingHold).toBe(true);
    expect(f.observed.attempts.every((maximum) => maximum === 2)).toBe(true);
  });

  it('retains terminal attempt identity throughout the immutable admission window', async () => {
    const f = fixture({ maxReservations: 3, maxCostMicros: 100 });
    const a = context('a');
    expect((await f.port.reserve(a)).outcome).toBe('reserved');
    expect(
      await f.port.reconcile(identity(a), { state: 'known', usage: usage(5) }),
    ).toBe('reconciled');
    f.advance(27_000); // Original deadline and terminal retention have both elapsed.
    expect((await f.port.reserve(context('b', f.clock.now()))).outcome).toBe(
      'reserved',
    );
    const renewed = {
      ...a,
      inputFingerprint: 'different-request-for-the-same-attempt',
      deadline: new Date(Date.parse(f.clock.now()) + 25_000).toISOString(),
    };
    // This is not the already-expired original context: the remaining slot,
    // budget and new deadline would otherwise admit it. Stable attempt and
    // reservation identity must survive terminal pruning until the pool closes.
    expect((await f.create().reserve(renewed)).outcome).toBe('denied');
  });

  it('restores a conservative hold for a late unknown after a not-called observation', async () => {
    const f = fixture({ maxCostMicros: 10 });
    const a = context();
    await f.port.reserve(a);
    expect(await f.port.reconcile(identity(a), { state: 'not_called' })).toBe(
      'reconciled',
    );
    expect(await f.port.reconcile(identity(a), { state: 'unknown' })).toBe(
      'reconciled',
    );
    expect((await f.port.reserve(context('b'))).outcome).toBe('denied');
    expect(await f.port.reconcile(identity(a), { state: 'not_called' })).toBe(
      'pending',
    );
  });

  it('retains active-window terminal slots and compacts only after admission closes', async () => {
    const f = fixture({ maxReservations: 2, maxCostMicros: 100 });
    const a = context();
    await f.port.reserve(a);
    await f.port.reconcile(identity(a), { state: 'known', usage: usage(10) });
    f.advance(27_000);
    const b = context('b', f.clock.now());
    expect((await f.port.reserve(b)).outcome).toBe('reserved');
    expect((await ledger(f.backing))?.reservations).toHaveLength(2);
    expect((await f.port.reserve(context('c', f.clock.now()))).outcome).toBe(
      'denied',
    );
    const updates = f.observed.counts.updates;
    expect((await f.port.reserve(a)).outcome).toBe('denied');
    expect(f.observed.counts.updates).toBe(updates);
    f.setTime('2026-11-10T00:10:01.000Z');
    expect(
      await f.port.reconcile(identity(b), { state: 'known', usage: usage(10) }),
    ).toBe('reconciled');
    expect((await ledger(f.backing))?.reservations).toHaveLength(1);
    expect((await f.port.reserve(context('d', f.clock.now()))).outcome).toBe(
      'denied',
    );
    expect((await ledger(f.backing))?.spentMicros).toBe('20');
    expect(
      await f.port.reconcile(identity(a), { state: 'known', usage: usage(10) }),
    ).toBe('pending');
  });

  it('records actual over-budget usage exactly, even beyond Number-safe cumulative sums', async () => {
    const f = fixture();
    const a = context('a');
    const b = context('b');
    await f.port.reserve(a);
    await f.port.reserve(b);
    await f.port.reconcile(identity(a), {
      state: 'known',
      usage: usage(Number.MAX_SAFE_INTEGER),
    });
    await f.port.reconcile(identity(b), {
      state: 'known',
      usage: usage(Number.MAX_SAFE_INTEGER),
    });
    expect((await ledger(f.backing))?.spentMicros).toBe(
      (2n * BigInt(Number.MAX_SAFE_INTEGER)).toString(),
    );
    expect(
      await f.port.reconcile(identity(a), { state: 'known', usage: usage(5) }),
    ).toBe('pending');
    expect((await ledger(f.backing))?.spentMicros).toBe(
      (2n * BigInt(Number.MAX_SAFE_INTEGER)).toString(),
    );
    expect((await ledger(f.backing))?.accountingHold).toBe(true);
    expect((await f.port.reserve(context('c'))).outcome).toBe('denied');
  });

  it('does not reset a pool after a policy change or automatic time boundary', async () => {
    const f = fixture();
    const a = context();
    await f.port.reserve(a);
    await f.port.reconcile(identity(a), { state: 'known', usage: usage() });
    const changed = createSupportAssistantUsage({
      store: f.observed.store,
      clock: f.clock,
      policy: { ...f.selected, version: 'other', maxCostMicros: 1_000 },
    });
    expect((await changed.reserve(context('b'))).outcome).toBe('unavailable');
    expect(
      await changed.reconcile(identity(a), { state: 'known', usage: usage() }),
    ).toBe('pending');
    f.setTime('2026-11-10T00:10:00.000Z');
    expect((await f.port.reserve(context('c', f.clock.now()))).outcome).toBe(
      'denied',
    );
    expect((await ledger(f.backing))?.spentMicros).toBe('5');
    expect(
      await f.port.reconcile(identity(a), { state: 'known', usage: usage() }),
    ).toBe('reconciled');
  });

  it('refuses a clock moving behind a committed observation', async () => {
    const f = fixture();
    const a = context();
    await f.port.reserve(a);
    f.advance(1_000);
    await f.port.reconcile(identity(a), { state: 'unknown' });
    f.setTime(START);
    expect((await f.port.reserve(context('b'))).outcome).toBe('unavailable');
    expect(
      await f.port.reconcile(identity(a), { state: 'known', usage: usage() }),
    ).toBe('pending');
    expect((await ledger(f.backing))?.spentMicros).toBe('0');
  });

  it('recovers an actually committed reserve after a lost storage ACK without new credit', async () => {
    let loseAck = true;
    const f = fixture(
      {},
      {
        afterUpdate: async () => {
          if (loseAck) {
            loseAck = false;
            throw new Error('synthetic lost ACK');
          }
        },
      },
    );
    const a = context();
    expect((await f.port.reserve(a)).outcome).toBe('unavailable');
    expect((await ledger(f.backing))?.reservations).toHaveLength(1);
    expect((await f.create().reserve(a)).outcome).toBe('reserved');
    expect((await ledger(f.backing))?.reservations).toHaveLength(1);
  });

  it('recovers an actually committed settlement after a lost ACK without double charging', async () => {
    let loseAck = false;
    const f = fixture(
      {},
      {
        afterUpdate: async () => {
          if (loseAck) {
            loseAck = false;
            throw new Error('synthetic lost ACK');
          }
        },
      },
    );
    const a = context();
    await f.port.reserve(a);
    loseAck = true;
    expect(
      await f.port.reconcile(identity(a), { state: 'known', usage: usage() }),
    ).toBe('pending');
    expect((await ledger(f.backing))?.spentMicros).toBe('5');
    expect(
      await f
        .create()
        .reconcile(identity(a), { state: 'known', usage: usage() }),
    ).toBe('reconciled');
    expect((await ledger(f.backing))?.spentMicros).toBe('5');
  });

  it('holds rather than erases state during a real Store-port outage', async () => {
    let unavailable = false;
    const f = fixture({}, { unavailable: () => unavailable });
    const a = context();
    await f.port.reserve(a);
    unavailable = true;
    expect(await f.port.reconcile(identity(a), { state: 'unknown' })).toBe(
      'pending',
    );
    expect((await f.port.reserve(context('b'))).outcome).toBe('unavailable');
    unavailable = false;
    expect((await ledger(f.backing))?.reservations).toHaveLength(1);
    expect(
      await f.port.reconcile(identity(a), { state: 'known', usage: usage() }),
    ).toBe('reconciled');
  });

  it('withholds a late ACK while keeping its committed reservation', async () => {
    let advance = () => {};
    const f = fixture({}, { afterUpdate: async () => advance() });
    advance = () => f.setTime('2026-11-10T00:10:01.000Z');
    const a = context();
    expect((await f.port.reserve(a)).outcome).toBe('unavailable');
    expect((await ledger(f.backing))?.reservations[0]?.state).toBe('reserved');
    advance = () => {};
    expect(await f.port.reconcile(identity(a), { state: 'unknown' })).toBe(
      'reconciled',
    );
  });

  it('refuses malformed/mismatched observations without mutating known liability', async () => {
    const f = fixture();
    const a = context();
    await f.port.reserve(a);
    expect(
      await f.port.reconcile(
        { ...identity(a), inputFingerprint: 'other' },
        { state: 'not_called' },
      ),
    ).toBe('pending');
    expect(
      await f.port.reconcile(identity(a), {
        state: 'known',
        usage: { ...usage(), currency: 'EUR' },
      }),
    ).toBe('pending');
    const extra = {
      state: 'known' as const,
      usage: { ...usage(), surprise: 'not allowed' },
    };
    expect(await f.port.reconcile(identity(a), extra)).toBe('pending');
    expect((await ledger(f.backing))?.reservations[0]?.state).toBe('reserved');
  });

  it('refuses persisted corruption without replacing it with an empty budget', async () => {
    const f = fixture();
    await f.backing
      .collection(rawRecords)
      .put({ ...KEY, format: 1, payload: '{}' });
    const before = await f.backing.collection(rawRecords).getVersioned(KEY);
    expect((await f.port.reserve(context())).outcome).toBe('unavailable');
    expect(
      await f.port.reconcile(identity(context()), { state: 'unknown' }),
    ).toBe('pending');
    expect(await f.backing.collection(rawRecords).getVersioned(KEY)).toEqual(
      before,
    );
  });

  it('stores one bounded record of hashes and accounting, with no raw context identifiers', async () => {
    const f = fixture({ maxReservations: 32, maxCostMicros: 1_000 });
    for (let index = 0; index < 32; index += 1)
      expect(
        (await f.port.reserve(context(`private-canary-${index}`))).outcome,
      ).toBe('reserved');
    const rows = await f.backing.collection(rawRecords).list(KEY.partition);
    expect(rows).toHaveLength(1);
    const serialized = JSON.stringify(rows[0]);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(
      60_000,
    );
    expect(serialized).not.toContain('private-canary');
    expect(serialized).not.toContain('synthetic-scope');
    expect(serialized).not.toContain('synthetic-price-v1');
    expect((await f.port.reserve(context('capacity'))).outcome).toBe('denied');
    expect(f.observed.counts.updates).toBe(33);
    expect(f.observed.attempts.every((maximum) => maximum === 2)).toBe(true);
    expect(f.observed.counts.enumerations).toBe(0);
  });
});
