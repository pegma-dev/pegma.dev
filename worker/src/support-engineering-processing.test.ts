import {
  createMemoryStore,
  defineCollection,
  type StoredRecord,
} from '@pegma/storage-core';
import type { EngineeringCandidate } from '@pegma/support-desk-application';
import { describe, expect, it, vi } from 'vitest';
import { createSupportEngineeringHttpFixture } from './support-engineering-http-fixtures';
import { engineeringRepositories } from './support-engineering-fixtures';
import {
  composeSupportEngineeringProcessing,
  type SupportEngineeringProcessingComposition,
} from './support-engineering-processing';
import {
  supportEngineeringRoutePolicySha256,
  SUPPORT_ENGINEERING_ENDPOINT,
  SUPPORT_ENGINEERING_WIRE_VERSION,
  type ApprovedSupportEngineeringRoute,
} from './support-engineering-config';

const key = { partition: 'support_bug_assessment', id: 'budget' };
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

/** Public SDKs, host factories, real Identity/roles/Store and receipt codecs run.
 * Provider/route/price/tokenizer and independent proof/remote systems are
 * fictional external ports, not qualification or a production-ready policy.
 */
async function fixture() {
  const f = await createSupportEngineeringHttpFixture(createMemoryStore());
  await f.verified();
  const host = {
    ...f.host,
    application: f.engineering.application,
    clock: f.engineering.clock,
  };
  const config = f.engineering.configuration;
  const state = {
    enabled: true,
    cost: 0.00047344,
    lostResponse: false,
    security: 'ordinary' as 'ordinary' | 'restricted' | 'uncertain',
    ambiguous: false,
    content: undefined as string | undefined,
  };
  const base: Omit<ApprovedSupportEngineeringRoute, 'approval'> = {
    host: 'pegma.dev',
    purpose: 'support_bug_assessment',
    endpoint: SUPPORT_ENGINEERING_ENDPOINT,
    endpointTag: 'fictional/region-one',
    outputTokenParameter: 'max_tokens',
    credentialRef: 'fictional-engineering-credential',
    usageScopeRef: 'synthetic-engineering-budget',
    configuration: config,
  };
  const route: ApprovedSupportEngineeringRoute = {
    ...base,
    approval: {
      configurationVersion: config.version,
      wireVersion: SUPPORT_ENGINEERING_WIRE_VERSION,
      evidenceRef: 'fictional-approval',
      effectivePolicyRef: 'fictional-effective-policy',
      evaluationRef: 'fictional-route-evaluation',
      responseIdentityRef: 'fictional-native-identity',
      tokenizerRef: 'fictional-counter',
      requestPolicySha256: await supportEngineeringRoutePolicySha256(base),
      nativeCostCurrency: 'USD',
      nativeCostUnit: 'openrouter_credits_usd',
      rounding: 'ceil_micro',
      zdr: true,
      safetyRetention: false,
      inputOutputLogging: false,
      inputOutputUse: false,
      broadcast: false,
      responseCache: false,
      unreviewedFeatures: false,
      implicitCache: 'absent',
      verifiedAt: config.dataControls.verifiedAt,
      validUntil: config.dataControls.validUntil,
    },
  };
  const readApiKey = vi.fn((_credentialRef: string) => 'fictional-no-real-key');
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe(SUPPORT_ENGINEERING_ENDPOINT);
    expect(init.redirect).toBe('error');
    if (state.lostResponse)
      throw new Error('Fictional accepted provider with lost response');
    const candidate: EngineeringCandidate = {
      title: 'Workspace export produces an empty file',
      summary: 'A fictional export omits rows.',
      expectedBehavior: 'The export contains the workspace rows.',
      actualBehavior: 'The downloaded export is empty.',
      reproductionSteps: [
        'Create a fictional workspace with one row.',
        'Export it and inspect the file.',
      ],
      applicability: {
        productId: 'workspace',
        version: '2.3.0',
        buildId: 'synthetic-build-230',
      },
      security: state.security,
      routing: state.ambiguous
        ? {
            outcome: 'ambiguous',
            alternativeRepositoryIds: engineeringRepositories.map(
              (row) => row.repositoryId,
            ),
            rationale: 'Staff must choose between the allowed components.',
          }
        : {
            outcome: 'selected',
            repositoryId: engineeringRepositories[0]!.repositoryId,
            alternativeRepositoryIds: [],
            rationale: 'The configured core owns file generation.',
          },
    };
    return Response.json({
      id: 'gen-fictional-engineering',
      object: 'chat.completion',
      provider: config.provider,
      model: config.model,
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: state.content ?? JSON.stringify(candidate),
          },
        },
      ],
      usage: {
        prompt_tokens: 200,
        completion_tokens: 160,
        total_tokens: 360,
        cost: state.cost,
        currency: 'USD',
      },
    });
  });
  const settings: NonNullable<
    SupportEngineeringProcessingComposition['configuration']
  > = {
    model: {
      readRoute: () => route,
      readApiKey,
      fetch,
      allowlist: [
        {
          model: config.model,
          provider: config.provider,
          endpointTag: base.endpointTag,
          outputTokenParameter: base.outputTokenParameter,
        },
      ],
      counter: {
        qualification: {
          model: config.model,
          modelVersion: config.modelVersion,
          wireVersion: SUPPORT_ENGINEERING_WIRE_VERSION,
          framingTokens: config.framingTokens,
          evidenceRef: route.approval.tokenizerRef,
          verifiedAt: route.approval.verifiedAt,
          validUntil: route.approval.validUntil,
        },
        count: (text) =>
          Math.max(1, Math.ceil(new TextEncoder().encode(text).byteLength / 4)),
      },
    },
    usagePolicy: {
      version: 'fictional-engineering-pool',
      scopeRef: base.usageScopeRef,
      configurationVersion: config.version,
      modelVersion: config.modelVersion,
      pricingRef: config.pricingRef,
      currency: 'USD',
      maxCostMicros: 100_000,
      maxReservationCostMicros: 1_000,
      maxReservations: 8,
      validFrom: config.dataControls.verifiedAt,
      validUntil: config.dataControls.validUntil,
      terminalRetentionMilliseconds: 60_000,
    },
    ports: f.engineering.ports,
  };
  const compose = (
    options: SupportEngineeringProcessingComposition = {
      enabled: () => state.enabled,
      configuration: settings,
    },
  ) => composeSupportEngineeringProcessing(host, options);
  const process = () =>
    compose().processWork({
      ...f.key(),
      workerId: 'fictional-processing-worker',
      leaseMilliseconds: 30_000,
    });
  return {
    f,
    host,
    state,
    settings,
    route,
    fetch,
    readApiKey,
    compose,
    process,
    row: () => host.store.collection(raw).get(key),
    async ledger(): Promise<unknown> {
      const row = await host.store.collection(raw).get(key);
      if (row === null) return null;
      if (typeof row.payload !== 'string')
        throw new Error('Expected the actual ledger envelope');
      return JSON.parse(row.payload);
    },
  };
}

describe('explicit source-owned engineering processing composition', () => {
  it.each(['absent', 'flag-only', 'off', 'throwing', 'missing-port'] as const)(
    'keeps %s processing OFF without provider work or budget writes',
    async (mode) => {
      const t = await fixture();
      const options: SupportEngineeringProcessingComposition =
        mode === 'absent'
          ? {}
          : mode === 'flag-only'
            ? { enabled: () => true }
            : {
                enabled: () => {
                  if (mode === 'throwing')
                    throw new Error('Fictional flag outage');
                  return mode !== 'off';
                },
                configuration: t.settings,
              };
      if (mode === 'missing-port')
        Reflect.set(t.settings.ports, 'checks', undefined);
      expect(
        await t.compose(options).processWork({
          ...t.f.key(),
          workerId: 'worker',
          leaseMilliseconds: 30_000,
        }),
      ).toMatchObject({ outcome: 'held' });
      expect(t.fetch).not.toHaveBeenCalled();
      expect(t.readApiKey).not.toHaveBeenCalled();
      expect(await t.row()).toBeNull();
    },
  );

  it.each([
    'scope',
    'configuration',
    'model',
    'price',
    'currency',
    'cost',
    'window',
  ] as const)(
    'refuses a mismatched funded %s before reserve or provider work',
    async (mismatch) => {
      const t = await fixture();
      const field =
        mismatch === 'scope'
          ? 'scopeRef'
          : mismatch === 'configuration'
            ? 'configurationVersion'
            : mismatch === 'model'
              ? 'modelVersion'
              : mismatch === 'price'
                ? 'pricingRef'
                : mismatch === 'currency'
                  ? 'currency'
                  : mismatch === 'cost'
                    ? 'maxReservationCostMicros'
                    : 'validUntil';
      Reflect.set(
        t.settings.usagePolicy,
        field,
        mismatch === 'cost'
          ? 999
          : mismatch === 'window'
            ? t.host.clock.now()
            : 'different',
      );
      expect((await t.process()).outcome).not.toBe('candidate');
      expect(t.fetch).not.toHaveBeenCalled();
      // Credential readiness may read the bound local secret before funding refusal.
      expect(t.readApiKey.mock.calls.length).toBeLessThanOrEqual(1);
      for (const call of t.readApiKey.mock.calls)
        expect(call).toEqual([t.route.credentialRef]);
      expect(await t.row()).toBeNull();
    },
  );

  it('uses the real host ledger and SDK from verified failure to candidate, exact human approval and one fictional dispatch', async () => {
    const t = await fixture();
    Reflect.set(t.settings.usagePolicy, 'maxReservationCostMicros', 2_000);
    expect((await t.process()).outcome).toBe('candidate');
    expect(await t.ledger()).toMatchObject({
      spentMicros: '474',
      reservations: [{ state: 'known', reservedMicros: 2_000 }],
    });
    expect((await t.process()).outcome).toBe('prepared');
    expect(t.f.engineering.state.creates).toEqual([]);
    const work = await t.f.work();
    if (!work.proposal)
      throw new Error('The actual SDK did not prepare a proposal');
    const command = {
      ...t.f.key(),
      commandId: 'fictional-human-review',
      correlationId: 'fictional-human-review',
      expectedWorkGeneration: work.workGeneration,
      proposalHash: work.proposal.proposalHash,
      decision: 'approve' as const,
    };
    await t.compose().reviewCommand(t.f.engineering.actors.staff, command);
    expect((await t.process()).outcome).toBe('dispatched');
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(t.f.engineering.state.modelCalls).toBe(0);
    expect(t.f.engineering.state.reservations).toEqual([]);
    expect(t.f.engineering.state.accounting).toEqual([]);
    expect(t.f.engineering.state.creates).toHaveLength(1);
  });

  it.each(['calibration', 'authority'] as const)(
    'does not pay when current %s is unavailable',
    async (unavailable) => {
      const t = await fixture();
      if (unavailable === 'calibration')
        t.f.engineering.state.calibrationReady = false;
      else await t.f.engineering.revoke('processor');
      expect((await t.process()).outcome).not.toBe('candidate');
      expect(t.fetch).not.toHaveBeenCalled();
      expect(await t.row()).toBeNull();
    },
  );

  it.each(['restricted', 'uncertain', 'ambiguous', 'checks-held'] as const)(
    'keeps %s output from becoming an approved export',
    async (held) => {
      const t = await fixture();
      if (held === 'restricted' || held === 'uncertain')
        t.state.security = held;
      if (held === 'ambiguous') t.state.ambiguous = true;
      const first = await t.process();
      if (held === 'restricted' || held === 'uncertain')
        expect(first.outcome).toBe('restricted');
      else {
        expect(first.outcome).toBe('candidate');
        if (held === 'checks-held') t.f.engineering.state.checks = 'held';
        expect((await t.process()).outcome).toBe('held');
      }
      expect(t.fetch).toHaveBeenCalledTimes(1);
      expect(t.f.engineering.state.creates).toEqual([]);
      expect(await t.ledger()).toMatchObject({ spentMicros: '474' });
    },
  );

  it('settles a released SDK charge of 150,000 micros with no candidate and no duplicate provider call', async () => {
    const t = await fixture();
    t.state.cost = 0.15;
    expect((await t.process()).outcome).toBe('held');
    const retained = await t.row();
    expect(await t.ledger()).toMatchObject({
      spentMicros: '150000',
      reservations: [
        {
          state: 'known',
          usage: {
            inputTokens: 200,
            outputTokens: 160,
            costMicros: 150_000,
            currency: 'USD',
          },
        },
      ],
    });
    expect((await t.f.work()).candidate).toBeUndefined();
    await t.process();
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(await t.row()).toEqual(retained);
  });

  it('retains unknown native liability on a lost response across cold compositions', async () => {
    const t = await fixture();
    t.state.lostResponse = true;
    expect((await t.process()).outcome).toBe('held');
    expect(await t.ledger()).toMatchObject({
      spentMicros: '0',
      reservations: [{ state: 'unknown', reservedMicros: 1_000 }],
    });
    const retained = await t.row();
    await t.process();
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(await t.row()).toEqual(retained);
    expect(t.f.engineering.state.creates).toEqual([]);
  });

  it('retains read-only unknown-dispatch recovery when generation is OFF and the source is withdrawn', async () => {
    const t = await fixture();
    await t.process();
    await t.process();
    const work = await t.f.work();
    if (!work.proposal)
      throw new Error('The actual SDK did not prepare a proposal');
    await t.compose().reviewCommand(t.f.engineering.actors.staff, {
      ...t.f.key(),
      commandId: 'fictional-review-before-unknown',
      correlationId: 'fictional-review-before-unknown',
      expectedWorkGeneration: work.workGeneration,
      proposalHash: work.proposal.proposalHash,
      decision: 'approve',
    });
    t.f.engineering.state.createMode = 'accept_then_lose';
    expect((await t.process()).outcome).toBe('pending');
    expect(t.f.engineering.state.creates).toHaveLength(1);
    await t.f.engineering.runtime.withdraw(t.f.engineering.actors.staff, {
      ticketId: t.f.key().ticketId,
      clientCommandId: 'fictional-withdraw-after-unknown',
      reason: 'privacy_withdrawal',
    });
    t.state.enabled = false;
    t.readApiKey.mockClear();
    expect(
      (await t.compose().reconcileSource(t.f.key().ticketId)).outcome,
    ).toBe('reconciled');
    expect(t.readApiKey).not.toHaveBeenCalled();
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(t.f.engineering.state.creates).toHaveLength(1);
  });
});

describe('validated processing boundary regressions', () => {
  async function unknownDispatch() {
    const t = await fixture();
    expect((await t.process()).outcome).toBe('candidate');
    expect((await t.process()).outcome).toBe('prepared');
    const work = await t.f.work();
    if (!work.proposal) throw new Error('Expected a real SDK proposal');
    await t.compose().reviewCommand(t.f.engineering.actors.staff, {
      ...t.f.key(),
      commandId: 'fictional-boundary-review',
      correlationId: 'fictional-boundary-review',
      expectedWorkGeneration: work.workGeneration,
      proposalHash: work.proposal.proposalHash,
      decision: 'approve',
    });
    t.f.engineering.state.createMode = 'accept_then_lose';
    expect((await t.process()).outcome).toBe('pending');
    await t.f.engineering.runtime.withdraw(t.f.engineering.actors.staff, {
      ticketId: t.f.key().ticketId,
      clientCommandId: 'fictional-boundary-withdraw',
      reason: 'privacy_withdrawal',
    });
    t.state.enabled = false;
    return t;
  }
  it.each(['ports', 'model', 'usage'] as const)(
    'retains real unknown-dispatch recovery after %s composition becomes unavailable',
    async (stage) => {
      const t = await unknownDispatch();
      const diagnostic = vi.fn();
      if (stage === 'ports') Reflect.set(t.settings.ports, 'checks', undefined);
      if (stage === 'usage')
        Reflect.set(t.settings.usagePolicy, 'maxCostMicros', NaN);
      if (stage === 'model')
        Object.defineProperty(t.settings.model, 'fetch', {
          get() {
            throw new Error('fictional-private-composition-cause');
          },
        });
      const retained = await t.row();
      t.readApiKey.mockClear();
      const runtime = t.compose({
        enabled: () => t.state.enabled,
        configuration: t.settings,
        logger: { log: diagnostic },
      });
      expect((await runtime.reconcileSource(t.f.key().ticketId)).outcome).toBe(
        'reconciled',
      );
      expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
        'error',
        'support.engineering.composition_unavailable',
        { stage },
      );
      expect(JSON.stringify(diagnostic.mock.calls)).not.toContain(
        'fictional-private-composition-cause',
      );
      expect(t.readApiKey).not.toHaveBeenCalled();
      expect(t.fetch).toHaveBeenCalledTimes(1);
      expect(t.f.engineering.state.creates).toHaveLength(1);
      expect(await t.row()).toEqual(retained);
    },
  );
  it('keeps recovery even when its finite diagnostic sink throws', async () => {
    const t = await unknownDispatch();
    Reflect.set(t.settings.usagePolicy, 'maxCostMicros', NaN);
    const log = vi.fn(() => {
      throw new Error('fictional logger outage');
    });
    const runtime = t.compose({ configuration: t.settings, logger: { log } });
    expect((await runtime.reconcileSource(t.f.key().ticketId)).outcome).toBe(
      'reconciled',
    );
    expect(log).toHaveBeenCalledTimes(1);
    expect(t.fetch).toHaveBeenCalledTimes(1);
    expect(t.f.engineering.state.creates).toHaveLength(1);
  });
  it('emits only the finite JSON event when no logger is supplied', async () => {
    const t = await fixture();
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      Reflect.set(t.settings.ports, 'checks', undefined);
      expect((await t.process()).outcome).not.toBe('candidate');
      expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({
          event: 'support.engineering.composition_unavailable',
          stage: 'ports',
        }),
      );
    } finally {
      diagnostic.mockRestore();
    }
  });
  it.each(['initially-off', 'after-service-await'] as const)(
    'retains the single PG gate at %s before reservation',
    async (mode) => {
      const t = await fixture();
      if (mode === 'initially-off') t.state.enabled = false;
      else {
        const resolve = t.settings.ports.serviceAccess.resolve;
        Reflect.set(
          t.settings.ports.serviceAccess,
          'resolve',
          async (signal: AbortSignal) => {
            const current = await resolve(signal);
            t.state.enabled = false;
            return current;
          },
        );
      }
      expect((await t.process()).outcome).not.toBe('candidate');
      expect(await t.row()).toBeNull();
      expect(t.fetch).not.toHaveBeenCalled();
    },
  );
  it.each(['missing', 'empty', 'malformed', 'throwing', 'revoked'] as const)(
    'refuses %s credentials before creating a real ledger reservation',
    async (mode) => {
      const t = await fixture();
      const read = vi.fn(() => {
        if (mode === 'throwing')
          throw new Error('fictional secret binding outage');
        if (mode === 'revoked') t.state.enabled = false;
        return mode === 'missing'
          ? undefined
          : mode === 'empty'
            ? ''
            : mode === 'malformed'
              ? 'invalid\nkey'
              : 'fictional-key';
      });
      Reflect.set(t.settings.model, 'readApiKey', read);
      expect((await t.process()).outcome).not.toBe('candidate');
      expect(read).toHaveBeenCalled();
      expect(await t.row()).toBeNull();
      expect(t.fetch).not.toHaveBeenCalled();
    },
  );
  it.each(['invalid-json', 'aggregate-limit'] as const)(
    'settles the native charge for %s without a candidate or another paid attempt',
    async (mode) => {
      const t = await fixture();
      t.state.content =
        mode === 'invalid-json'
          ? '{'
          : JSON.stringify({
              title: 'Fictional export',
              summary: 's'.repeat(4_000),
              expectedBehavior: 'e'.repeat(2_000),
              actualBehavior: 'a'.repeat(2_000),
              reproductionSteps: ['r'.repeat(1_000)],
              applicability: {
                productId: 'workspace',
                version: '2.3.0',
                buildId: 'synthetic-build-230',
              },
              security: 'ordinary',
              routing: {
                outcome: 'selected',
                repositoryId: engineeringRepositories[0]!.repositoryId,
                alternativeRepositoryIds: [],
                rationale: 'A fictional route',
              },
            });
      expect((await t.process()).outcome).not.toBe('candidate');
      expect(await t.ledger()).toMatchObject({
        spentMicros: '474',
        reservations: [
          { state: 'known', usage: { costMicros: 474, currency: 'USD' } },
        ],
      });
      expect((await t.f.work()).candidate).toBeUndefined();
      const retained = await t.row();
      await t.process();
      expect(t.fetch).toHaveBeenCalledTimes(1);
      expect(await t.row()).toEqual(retained);
      expect(t.f.engineering.state.creates).toEqual([]);
    },
  );
});
