import { createMemoryStore } from '@pegma/storage-core';
import { describe, expect, it, vi } from 'vitest';
import { createSupportEngineeringFixture } from './support-engineering-fixtures';
import { createDeferredDriverChecksFixture } from './support-engineering-driver-fixtures';
import {
  createSupportEngineeringRuntime,
  type SupportEngineeringDeferredCheckHint,
} from './support-engineering';
import {
  createProductionSupportEngineering,
  type SupportEngineeringProductionOptions,
} from './support-engineering-production';
import {
  independentCheckAttempts,
  purgeSupportIndependentCheckRequests,
} from './support-independent-checks';
import { INDEPENDENT_CHECK_PURPOSE } from './support-independent-checks-model';

async function fixture() {
  const store = createMemoryStore();
  const f = await createSupportEngineeringFixture(store);
  await f.eligible();
  expect((await f.process()).outcome).toBe('candidate');
  let input: Parameters<typeof f.ports.checks.check>[0] | undefined;
  f.ports.checks.check = async (value) => {
    input = structuredClone(value);
    return { outcome: 'held' };
  };
  await f.process();
  if (!input) throw new Error('Actual SDK exact request required');
  const d = await createDeferredDriverChecksFixture(f, store, false);
  let checkerEnabled = true;
  const readReceiptKey = vi.fn(d.configuration.readReceiptKey!);
  const configuration: NonNullable<
    SupportEngineeringProductionOptions['configuration']
  > = {
    application: { enabled: true },
    productContext: { resolve: async () => null },
    serviceAccess: f.ports.serviceAccess,
    reconciliationAccess: f.ports.reconciliationAccess,
    routing: f.ports.routing,
    checks: f.ports.checks,
    // These cases test attachment, hold and redaction. No generator/repository
    // configuration is qualified; the separate registered-root tests exercise it.
    model: {},
    usagePolicy: d.configuration.usagePolicy!,
    repository: { authentication: { resolve: async () => null } },
    proposals: { readDuplicateQuery: () => null, readSettings: () => null },
    independentChecks: {
      ...d.configuration,
      enabled: () => checkerEnabled,
      readReceiptKey,
    },
  };
  const options: SupportEngineeringProductionOptions = {
    clock: f.clock,
    enabled: () => true,
    configuration,
  };
  const production = createProductionSupportEngineering(options);
  const capture = async () => {
    let hint: SupportEngineeringDeferredCheckHint | undefined;
    const checks = production.processing.configuration?.checksFor?.(
      f.key(),
      (value) => {
        hint = value;
      },
    );
    if (!checks) throw new Error('Actual scoped production checks required');
    expect(
      await checks.check(input!, {
        purpose: 'support_bug_assessment',
        deadline: new Date(Date.parse(f.clock.now()) + 4_000).toISOString(),
        signal: new AbortController().signal,
      }),
    ).toEqual({ outcome: 'held' });
    if (!hint) throw new Error('Durable scoped hint required');
    return hint;
  };
  return {
    store,
    f,
    d,
    input,
    production,
    options,
    capture,
    readReceiptKey,
    disable: () => {
      checkerEnabled = false;
    },
  };
}

describe('independent checks production composition', () => {
  it('binds once to the real Store and lazy exact actual App without constructing a substitute', async () => {
    const t = await fixture();
    let actualReads = 0;
    let otherReads = 0;
    expect(
      t.production.attachRuntime?.({
        store: t.store,
        clock: t.f.clock,
        application: () => {
          actualReads++;
          return t.f.application;
        },
      }),
    ).toBe(true);
    expect(actualReads).toBe(0);
    expect(
      t.production.attachRuntime?.({
        store: createMemoryStore(),
        clock: t.f.clock,
        application: () => {
          otherReads++;
          return t.f.application;
        },
      }),
    ).toBe(false);
    const hint = await t.capture();
    expect(actualReads).toBe(0);
    const precompute = t.production.processing.configuration?.precomputeChecks;
    if (!precompute) throw new Error('Actual production precompute required');
    // Current missing repository authority holds this real Source read. No
    // verifier or provider result is manufactured to complete the fixture.
    expect(
      (
        await precompute(hint, {
          deadline: new Date(Date.parse(t.f.clock.now()) + 4_000).toISOString(),
          signal: new AbortController().signal,
          current: () => true,
        })
      ).outcome,
    ).toBe('held');
    expect(actualReads).toBeGreaterThan(0);
    expect(otherReads).toBe(0);
    expect(t.d.state.calls).toBe(0);
  });
  it('holds supplied unready independent configuration without falling back to a ready legacy checker', async () => {
    const t = await fixture();
    expect(
      (
        await t.f.ports.checks.resolvePolicy(
          undefined,
          new AbortController().signal,
        )
      ).outcome,
    ).toBe('ready');
    t.disable();
    expect(
      t.production.attachRuntime?.({
        store: t.store,
        clock: t.f.clock,
        application: () => t.f.application,
      }),
    ).toBe(true);
    const configured = t.production.processing.configuration;
    if (!configured) throw new Error('Configured source required');
    expect(
      (
        await configured.ports.checks.resolvePolicy(
          undefined,
          new AbortController().signal,
        )
      ).outcome,
    ).toBe('unavailable');
    expect(t.d.state.calls).toBe(0);
  });
  it('redacts every retained ticket generation after an actual accepted source_deleted withdrawal', async () => {
    const t = await fixture();
    t.production.attachRuntime?.({
      store: t.store,
      clock: t.f.clock,
      application: () => t.f.application,
    });
    await t.capture();
    const runtime = createSupportEngineeringRuntime({
      application: t.f.application,
      clock: t.f.clock,
      staffAccess: { resolve: t.f.resolve },
      ports: t.f.ports,
      discardChecks: t.production.discardChecks,
    });
    const result = await runtime.withdraw(t.f.actors.staff, {
      ticketId: t.f.key().ticketId,
      clientCommandId: 'ACTUAL-DELETE-REDACTION',
      reason: 'source_deleted',
    });
    expect(result.state).toBe('withdrawn');
    const row = await t.store
      .collection(independentCheckAttempts)
      .get({ partition: INDEPENDENT_CHECK_PURPOSE, id: 'attempts' });
    expect(row?.entries).toHaveLength(1);
    expect(row?.entries[0]).toMatchObject({
      request: null,
      receipt: null,
      state: 'held',
    });
    expect(t.d.state.calls).toBe(0);
  });
  it('purges expired private text with configuration and keys unavailable in the existing nonpaid maintenance capability', async () => {
    const t = await fixture();
    t.production.attachRuntime?.({
      store: t.store,
      clock: t.f.clock,
      application: () => t.f.application,
    });
    await t.capture();
    t.disable();
    Reflect.set(t.options, 'configuration', undefined);
    t.readReceiptKey.mockImplementation(() => {
      throw new Error('Key unavailable');
    });
    t.readReceiptKey.mockClear();
    t.f.advance(60_001);
    expect(
      await purgeSupportIndependentCheckRequests({
        store: t.store,
        clock: t.f.clock,
      }),
    ).toBe(1);
    expect(t.readReceiptKey).not.toHaveBeenCalled();
    expect(t.d.state.calls).toBe(0);
    const row = await t.store
      .collection(independentCheckAttempts)
      .get({ partition: INDEPENDENT_CHECK_PURPOSE, id: 'attempts' });
    expect(row?.entries[0]?.request).toBeNull();
  });
});
