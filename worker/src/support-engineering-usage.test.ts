import type {
  AssistantAttemptContext,
  EngineeringAttemptContext,
  EngineeringUsageIdentity,
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
import { createSupportAssistantUsage } from './support-assistant-usage';
import {
  createSupportEngineeringUsage,
  type SupportEngineeringUsagePolicy,
} from './support-engineering-usage';

const START = '2026-11-10T00:00:00.000Z';
const KEY = { partition: 'support_bug_assessment', id: 'budget' };
const raw = defineCollection<StoredRecord>({
  name: 'pegma.support-engineering-usage.v1',
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
  overrides: Partial<SupportEngineeringUsagePolicy> = {},
): SupportEngineeringUsagePolicy {
  return {
    version: 'fictional-engineering-pool',
    scopeRef: 'fictional-scope',
    configurationVersion: 'fictional-config',
    modelVersion: 'fictional-model',
    pricingRef: 'fictional-price',
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
function context(id = 'a', now = START): EngineeringAttemptContext {
  return {
    purpose: 'support_bug_assessment',
    invocationId: 'invocation-' + id,
    operationId: 'operation-' + id,
    attemptId: 'attempt-' + id,
    attempt: 1,
    inputFingerprint: 'fingerprint-' + id,
    inputManifestHash: 'manifest-' + id,
    configurationVersion: 'fictional-config',
    promptVersion: 'fictional-prompt',
    modelVersion: 'fictional-model',
    parserVersion: 'fictional-parser',
    policyVersion: 'fictional-check-policy',
    authorityVersion: 'fictional-authority',
    usageScopeRef: 'fictional-scope',
    usageReservationId: 'reservation-' + id,
    deadline: new Date(Date.parse(now) + 25_000).toISOString(),
    signal: new AbortController().signal,
    budgets: {
      maxMessages: 10,
      maxInputBytes: 10_000,
      maxInputTokens: 1_000,
      maxContextTokens: 2_000,
      maxOutputBytes: 1_000,
      maxOutputTokens: 500,
      maxCandidateBytes: 1_000,
      maxDurationMilliseconds: 20_000,
      maxCostMicros: 5,
      currency: 'USD',
      maxAttempts: 1,
      maxRepositories: 2,
      maxRepositoryBytes: 1_000,
    },
  };
}
const identity = (
  input: EngineeringAttemptContext,
): EngineeringUsageIdentity => ({
  purpose: input.purpose,
  operationId: input.operationId,
  attemptId: input.attemptId,
  inputFingerprint: input.inputFingerprint,
  usageReservationId: input.usageReservationId,
});
const usage = (costMicros = 5) => ({
  inputTokens: 100,
  outputTokens: 30,
  costMicros,
  currency: 'USD',
});
function fixture(overrides: Partial<SupportEngineeringUsagePolicy> = {}) {
  const backing = createMemoryStore();
  const selected = policy(overrides);
  let now = START;
  const state = {
    updates: 0,
    decisions: 0,
    scans: 0,
    loseAck: false,
    unavailable: false,
    before: undefined as (() => Promise<void>) | undefined,
  };
  const store: Store = {
    collection<Value>(
      definition: CollectionDefinition<Value>,
    ): CollectionStore<Value> {
      const actual = backing.collection(definition);
      return {
        ...actual,
        async update(key, decide, options) {
          state.updates += 1;
          if (state.unavailable) throw new Error('Fictional storage outage');
          expect(options?.maxAttempts).toBe(2);
          const result = await actual.update(
            key,
            async (current) => {
              state.decisions += 1;
              await state.before?.();
              return decide(current);
            },
            options,
          );
          if (state.loseAck) {
            state.loseAck = false;
            throw new Error('Lost actual committed ACK');
          }
          return result;
        },
        async scan() {
          state.scans++;
          throw new Error('Unexpected scan');
        },
        async list() {
          state.scans++;
          throw new Error('Unexpected list');
        },
        async listVersioned() {
          state.scans++;
          throw new Error('Unexpected list');
        },
      };
    },
  };
  const clock = { now: () => now };
  const create = () =>
    createSupportEngineeringUsage({ store, clock, policy: selected });
  return {
    backing,
    store,
    clock,
    selected,
    state,
    create,
    port: create(),
    advance: (ms: number) => {
      now = new Date(Date.parse(now) + ms).toISOString();
    },
    row: () => backing.collection(raw).get(KEY),
    async ledger(): Promise<unknown> {
      const row = await backing.collection(raw).get(KEY);
      if (row === null) return null;
      if (typeof row.payload !== 'string')
        throw new Error('Expected the actual ledger envelope');
      return JSON.parse(row.payload);
    },
  };
}

describe('purpose-isolated durable engineering usage', () => {
  it('is unavailable before Store access when no policy is configured', async () => {
    const f = fixture();
    const port = createSupportEngineeringUsage({
      store: f.store,
      clock: f.clock,
    });
    expect(await port.reserve(context())).toEqual({ outcome: 'unavailable' });
    expect(
      await port.reconcile(identity(context()), { state: 'unknown' }),
    ).toBe('pending');
    expect(f.state.updates).toBe(0);
    expect(await f.row()).toBeNull();
  });
  it('reserves the conservative hold and recovers exact ACKs without a write or another debit', async () => {
    const f = fixture();
    const input = context();
    const expected = {
      outcome: 'reserved',
      usageReservationId: input.usageReservationId,
    };
    expect(await f.port.reserve(input)).toEqual(expected);
    const row = await f.row();
    expect(await f.create().reserve(input)).toEqual(expected);
    expect(await f.row()).toEqual(row);
    expect(await f.ledger()).toMatchObject({
      spentMicros: '0',
      reservations: [{ reservedMicros: 10, state: 'reserved' }],
    });
    expect(f.state.updates).toBe(2);
    expect(f.state.scans).toBe(0);
  });
  it.each([
    'invocationId',
    'inputManifestHash',
    'parserVersion',
    'policyVersion',
    'authorityVersion',
    'promptVersion',
  ] as const)('refuses a reused identity with changed %s', async (field) => {
    const f = fixture();
    const input = context();
    await f.port.reserve(input);
    expect(
      (await f.create().reserve({ ...input, [field]: 'changed' })).outcome,
    ).toBe('denied');
    expect(await f.ledger()).toMatchObject({
      reservations: [{ reservedMicros: 10 }],
    });
  });
  it.each([0, -1, 1.5, NaN, Infinity, 11])(
    'refuses invalid or unfunded cost %s before storage',
    async (maxCostMicros) => {
      const f = fixture();
      const input = context();
      expect(
        (
          await f.port.reserve({
            ...input,
            budgets: { ...input.budgets, maxCostMicros },
          })
        ).outcome,
      ).toBe('denied');
      expect(f.state.updates).toBe(0);
    },
  );
  it('admits only one competing reservation using genuine Memory OCC', async () => {
    const f = fixture({ maxCostMicros: 15 });
    let release = () => {};
    let both = () => {};
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      both = resolve;
    });
    f.state.before = async () => {
      if (f.state.decisions > 2) return;
      if (f.state.decisions === 2) both();
      await proceed;
    };
    const pending = Promise.all([
      f.port.reserve(context('a')),
      f.port.reserve(context('b')),
    ]);
    await ready;
    release();
    const results = await pending;
    expect(results.map((value) => value.outcome).sort()).toEqual([
      'denied',
      'reserved',
    ]);
    expect(f.state.updates).toBe(2);
    expect(f.state.decisions).toBeLessThanOrEqual(4);
  });
  it('retains an actual committed reserve after lost ACK and outage', async () => {
    const f = fixture();
    f.state.loseAck = true;
    expect((await f.port.reserve(context())).outcome).toBe('unavailable');
    expect(await f.ledger()).toMatchObject({
      reservations: [{ state: 'reserved' }],
    });
    f.state.unavailable = true;
    expect((await f.create().reserve(context())).outcome).toBe('unavailable');
    f.state.unavailable = false;
    expect((await f.create().reserve(context())).outcome).toBe('reserved');
  });
  it('accounts actual overage despite lost settlement ACK and never rolls it back on duplicate or unknown', async () => {
    const f = fixture();
    const input = context();
    await f.port.reserve(input);
    f.state.loseAck = true;
    expect(
      await f.port.reconcile(identity(input), {
        state: 'known',
        usage: usage(150),
      }),
    ).toBe('pending');
    const stored = await f.row();
    expect(
      await f
        .create()
        .reconcile(identity(input), { state: 'known', usage: usage(150) }),
    ).toBe('reconciled');
    expect(
      await f.create().reconcile(identity(input), { state: 'unknown' }),
    ).toBe('reconciled');
    expect(await f.row()).toEqual(stored);
    expect(await f.ledger()).toMatchObject({
      spentMicros: '150',
      reservations: [{ state: 'known', usage: usage(150) }],
    });
    expect((await f.create().reserve(context('b'))).outcome).toBe('denied');
    expect(
      await f
        .create()
        .reconcile(identity(input), { state: 'known', usage: usage(5) }),
    ).toBe('pending');
    expect(await f.ledger()).toMatchObject({
      accountingHold: true,
      spentMicros: '150',
    });
  });
  it('retains unknown and terminal identities for the whole admission window', async () => {
    const f = fixture({ maxReservations: 2 });
    const a = context('a');
    const b = context('b');
    await f.port.reserve(a);
    await f.port.reserve(b);
    await f.port.reconcile(identity(a), { state: 'unknown' });
    await f.port.reconcile(identity(b), { state: 'not_called' });
    f.advance(120_000);
    expect(
      (await f.create().reserve(context('c', f.clock.now()))).outcome,
    ).toBe('denied');
    expect(
      (
        await f.create().reserve({
          ...context('b', f.clock.now()),
          inputFingerprint: 'renewed',
        })
      ).outcome,
    ).toBe('denied');
    expect(await f.port.reconcile(identity(a), { state: 'not_called' })).toBe(
      'pending',
    );
    expect(await f.ledger()).toMatchObject({
      reservations: [{ state: 'unknown' }, { state: 'not_called' }],
    });
  });
  it('keeps malformed and wrong-currency evidence unknown and preserves immutable policy spend', async () => {
    const f = fixture();
    const a = context();
    await f.port.reserve(a);
    expect(
      await f.port.reconcile(identity(a), {
        state: 'known',
        usage: { ...usage(), currency: 'EUR' },
      }),
    ).toBe('pending');
    expect(
      await f.port.reconcile(identity(a), {
        state: 'known',
        usage: usage(Infinity),
      }),
    ).toBe('pending');
    expect(await f.ledger()).toMatchObject({
      spentMicros: '0',
      reservations: [{ state: 'reserved' }],
    });
    await f.port.reconcile(identity(a), { state: 'known', usage: usage() });
    const changed = createSupportEngineeringUsage({
      store: f.store,
      clock: f.clock,
      policy: { ...f.selected, version: 'new', maxCostMicros: 1_000 },
    });
    expect((await changed.reserve(context('b'))).outcome).toBe('unavailable');
    expect(await f.ledger()).toMatchObject({ spentMicros: '5' });
  });
  it('isolates identical identifiers and separate holds from the existing answering namespace', async () => {
    const f = fixture();
    const e = context();
    const answer: AssistantAttemptContext = {
      ...e,
      purpose: 'support_answer',
      audienceVersion: 'fictional-audience',
      applicability: { productId: 'fictional', productVersion: '1' },
      allSourceReferences: [],
      fence: {
        commandId: 'command',
        correlationId: 'correlation',
        ticketId: 'ticket',
        turnId: 'turn',
        workerId: 'worker',
        claimId: 'claim',
        claimGeneration: 1,
        attempt: e.attempt,
        attemptId: e.attemptId,
        expectedRevision: 1,
        expectedHandlingGeneration: 0,
        triggerMessageId: 'message',
      },
      budgets: {
        ...e.budgets,
        maxAssistantTurns: 1,
        maxMessageCharacters: 500,
        maxAnswerTextCharacters: 500,
      },
    };
    const answering = createSupportAssistantUsage({
      store: f.store,
      clock: f.clock,
      policy: f.selected,
    });
    expect((await answering.reserve(answer)).outcome).toBe('reserved');
    expect((await f.port.reserve(e)).outcome).toBe('reserved');
    await f.port.reconcile(identity(e), { state: 'known', usage: usage(150) });
    expect(
      (
        await answering.reserve({
          ...answer,
          attemptId: 'other',
          operationId: 'other',
          usageReservationId: 'other',
          fence: { ...answer.fence, attemptId: 'other' },
        })
      ).outcome,
    ).toBe('reserved');
    const wrong = identity(e);
    Reflect.set(wrong, 'purpose', 'support_answer');
    expect(await f.port.reconcile(wrong, { state: 'unknown' })).toBe('pending');
  });
});

describe('engineering invalid-budget classification', () => {
  it.each([NaN, 1.5, Infinity, -Infinity])(
    'retains denied for %s with no mutation',
    async (budget) => {
      const f = fixture();
      const input = context();
      Reflect.set(input.budgets, 'maxCostMicros', budget);
      expect(await f.port.reserve(input)).toEqual({ outcome: 'denied' });
      expect(f.state.updates).toBe(0);
      expect(await f.row()).toBeNull();
    },
  );
});
