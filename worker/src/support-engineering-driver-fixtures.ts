import type {
  CollectionDefinition,
  CollectionStore,
  Store,
  StoredRecord,
} from '@pegma/storage-core';
import { defineCollection } from '@pegma/storage-core';
import { supportRecords } from '@pegma/support-desk-application';
import { describe, expect, it } from 'vitest';
import { encode } from 'gpt-tokenizer';
import { createSupportEngineeringFixture } from './support-engineering-fixtures';
import {
  createSupportEngineeringRuntime,
  type SupportEngineeringProcessResult,
  type SupportEngineeringRuntime,
  type SupportEngineeringRuntimeOptions,
} from './support-engineering';
import {
  createSupportIndependentChecks,
  independentCheckAttempts,
  type SupportIndependentChecksOptions,
} from './support-independent-checks';
import {
  independentCheckRoutePolicyHash,
  INDEPENDENT_CHECK_PURPOSE,
  INDEPENDENT_CHECK_ENDPOINT,
  INDEPENDENT_CHECK_WIRE,
  type IndependentCheckRoute,
} from './support-independent-checks-model';
import { createSupportEngineeringUsage } from './support-engineering-usage';
import {
  createSupportEngineeringDriver,
  type SupportEngineeringDriverResult,
} from './support-engineering-driver';

export interface EngineeringDriverBackend {
  readonly store: Store;
  readonly invoke?: <Value>(action: () => Promise<Value>) => Promise<Value>;
}
export const driverHintKey = { partition: 'engineering', id: 'cursor' };
export const driverHintRows = defineCollection<StoredRecord>({
  name: 'pegma.support-engineering-driver.v1',
  key: (value) => ({
    partition: String(value.partition),
    id: String(value.id),
  }),
  codec: {
    encode: (value) => ({ ...value }),
    decode: (value) => ({ ...value }),
  },
});
const rawUsage = defineCollection<StoredRecord>({
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
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/** Real SDK App/RoleStore/Store and durable usage; model, calibration/check and
 * GitHub systems are declared fictional externals. Only transport ACK loss is
 * injected after genuine conditional writes/transactions have completed.
 */
export async function engineeringDriverFixture(
  backend: EngineeringDriverBackend,
  options: { readonly deferredChecks?: boolean } = {},
) {
  const pendingWork: Promise<SupportEngineeringProcessResult>[] = [];
  const faults = {
    loseHintAck: false,
    loseClaimAck: false,
    loseCandidateAck: false,
    enabled: true,
    overage: false,
    modelGate: undefined as (() => Promise<void>) | undefined,
    afterHintRead: undefined as (() => Promise<void>) | undefined,
    afterHintWrite: undefined as (() => void) | undefined,
    blockedHintRead: undefined as (() => Promise<void>) | undefined,
    scans: 0,
    workCalls: 0,
    reconcileCalls: 0,
    hintWrites: 0,
    sdkLostAcks: 0,
    lastScan: undefined as
      | Awaited<ReturnType<SupportEngineeringRuntime['scanCandidates']>>
      | undefined,
  };
  const store: Store = {
    collection<Value>(
      definition: CollectionDefinition<Value>,
    ): CollectionStore<Value> {
      const actual = backend.store.collection(definition);
      if (definition.name === driverHintRows.name) {
        async function written(wasWritten: boolean) {
          if (!wasWritten) return;
          faults.hintWrites++;
          faults.afterHintWrite?.();
          if (faults.loseHintAck) {
            faults.loseHintAck = false;
            throw new Error('Lost actual hint ACK');
          }
        }
        return {
          ...actual,
          async getVersioned(key) {
            const result = await actual.getVersioned(key);
            await faults.blockedHintRead?.();
            await faults.afterHintRead?.();
            return result;
          },
          async insertIfAbsent(value) {
            const result = await actual.insertIfAbsent(value);
            await written(result.inserted);
            return result;
          },
          async putIfUnchanged(value, version) {
            const result = await actual.putIfUnchanged(value, version);
            await written(result);
            return result;
          },
        };
      }
      if (definition.name !== supportRecords.name) return actual;
      return {
        ...actual,
        async transact(partition, actions) {
          const result = await actual.transact(partition, actions);
          if (result.committed)
            for (const action of actions) {
              if (
                action.action === 'delete' ||
                !object(action.value) ||
                action.value.kind !== 'engineering_work'
              )
                continue;
              if (
                (faults.loseClaimAck && action.value.status === 'claimed') ||
                (faults.loseCandidateAck && action.value.status === 'candidate')
              ) {
                faults.loseClaimAck = false;
                faults.loseCandidateAck = false;
                faults.sdkLostAcks++;
                throw new Error('Lost actual committed SDK ACK');
              }
            }
          return result;
        },
      };
    },
  };
  const f = await createSupportEngineeringFixture(store);
  await f.eligible();
  const deferred = options.deferredChecks
    ? await createDeferredDriverChecksFixture(f, store)
    : undefined;
  const policy = {
    version: 'fictional-driver-pool',
    scopeRef: 'synthetic-engineering-budget',
    configurationVersion: f.configuration.version,
    modelVersion: f.configuration.modelVersion,
    pricingRef: f.configuration.pricingRef,
    currency: 'USD',
    maxCostMicros: 100_000,
    maxReservationCostMicros: 1_000,
    maxReservations: 8,
    validFrom: f.configuration.dataControls.verifiedAt,
    validUntil: f.configuration.dataControls.validUntil,
    terminalRetentionMilliseconds: 60_000,
  };
  function driver() {
    return createSupportEngineeringDriver({
      store,
      clock: f.clock,
      isEnabled: () => faults.enabled,
      runtime(current) {
        const runtime = createSupportEngineeringRuntime({
          application: f.application,
          clock: f.clock,
          staffAccess: { resolve: f.resolve },
          processingEnabled: () => f.state.enabled && current(),
          ...deferred?.runtimeOptions,
          ports: {
            ...f.ports,
            usage: createSupportEngineeringUsage({
              store,
              clock: f.clock,
              policy,
            }),
            model: {
              async generate(input, context, config) {
                await faults.modelGate?.();
                const result = await f.ports.model.generate(
                  input,
                  context,
                  config,
                );
                return faults.overage
                  ? {
                      ...result,
                      usage: { ...result.usage, costMicros: 150_000 },
                    }
                  : result;
              },
            },
          },
        });
        return {
          scanCandidates: async (input) => {
            faults.scans++;
            const page = await runtime.scanCandidates(input);
            faults.lastScan = structuredClone(page);
            return page;
          },
          processWork: async (input, run) => {
            faults.workCalls++;
            const pending = runtime.processWork(input, run);
            pendingWork.push(pending);
            return pending;
          },
          reconcileSource: async (ticketId, run) => {
            faults.reconcileCalls++;
            return runtime.reconcileSource(ticketId, run);
          },
          precomputeChecks: (hint, run) => runtime.precomputeChecks(hint, run),
        };
      },
    });
  }
  const tick = (run?: Parameters<ReturnType<typeof driver>['runTick']>[0]) => {
    const operation = () => driver().runTick(run);
    return backend.invoke === undefined
      ? operation()
      : backend.invoke(operation);
  };
  async function until(
    match: (result: SupportEngineeringDriverResult) => boolean,
  ) {
    for (let physical = 0; physical < 160; ++physical) {
      const result = await tick();
      if (match(result)) return result;
    }
    throw new Error(
      'The bounded physical scan did not reach its real SDK work',
    );
  }
  async function selectWork() {
    await until((result) => result.outcome === 'scanned' && result.selected);
  }
  async function phase() {
    return until((result) => result.outcome === 'work');
  }
  async function addReport(ticketId: string) {
    const messageId = ticketId + '-question';
    await f.application.createCustomerTicket(f.actors.customer, {
      ...f.command('page-ticket'),
      ticketId,
      messageId,
      subject: 'Another fictional export failure',
      body: 'The export is empty.',
    });
    const ticket = (
      await f.application.readStaffTicket(f.actors.staff, ticketId)
    ).ticket;
    await f.runtime.enroll(f.actors.staff, {
      ticketId,
      clientCommandId: 'enroll-' + ticketId,
      expectedRevision: ticket.revision,
    });
    const source = await f.runtime.submitVerifiedFailure(f.actors.staff, {
      ticketId,
      clientCommandId: 'failure-' + ticketId,
      expectedRevision: ticket.revision,
      security: 'ordinary',
      evidence: {
        kind: 'staff_verified_failure',
        expectedBehavior: 'Export retains rows.',
        actualBehavior: 'Export is empty.',
        reproductionSteps: ['Export a fictional workspace.'],
        visibleMessageIds: [messageId],
        verificationReference: 'fictional-page-verification',
      },
    });
    return { ticketId, sourceGeneration: source.sourceGeneration };
  }
  return {
    pendingWork,
    deferred,
    f,
    faults,
    store,
    driver,
    tick,
    until,
    selectWork,
    phase,
    addReport,
    hint: () => backend.store.collection(driverHintRows).get(driverHintKey),
    async usage(): Promise<unknown> {
      const row = await backend.store
        .collection(rawUsage)
        .get({ partition: 'support_bug_assessment', id: 'budget' });
      if (row === null) return null;
      if (typeof row.payload !== 'string')
        throw new Error('Expected actual usage envelope');
      return JSON.parse(row.payload);
    },
    async approve() {
      const work = await f.work();
      if (!work.proposal) throw new Error('Actual proposal required');
      return f.runtime.reviewCommand(f.actors.staff, {
        ...f.key(),
        commandId: 'fictional-driver-human-review',
        correlationId: 'fictional-driver-human-review',
        expectedWorkGeneration: work.workGeneration,
        proposalHash: work.proposal.proposalHash,
        decision: 'approve',
      });
    },
  };
}

/** Local fictional provider transport around the REAL independent-check adapter,
 * App, roles, usage and deferred receipts. It never calls a network endpoint. */
export async function createDeferredDriverChecksFixture(
  f: Awaited<ReturnType<typeof createSupportEngineeringFixture>>,
  store: Store,
  bindApplication = true,
) {
  const verifiedAt = f.clock.now();
  const validUntil = new Date(Date.parse(verifiedAt) + 3_600_000).toISOString();
  const state = {
    calls: 0,
    lost: false,
    losePrecomputeAck: false,
    hook: undefined as (() => Promise<void>) | undefined,
    beforeKey: undefined as (() => void) | undefined,
  };
  const configuration: IndependentCheckRoute['configuration'] = {
    purpose: INDEPENDENT_CHECK_PURPOSE,
    version: 'fictional-driver-check-config',
    promptVersion: 'fictional-driver-check-prompt',
    parserVersion: 'fictional-driver-check-parser',
    modelVersion: 'fictional-driver-check-model',
    policyVersion: 'synthetic-check-policy-v1',
    policyBinding: 'synthetic-independent-check-binding',
    rubricVersion: 'fictional-driver-check-rubric',
    provider: 'Fictional Provider',
    model: 'fictional/independent',
    pricingRef: 'fictional-check-price',
    trustedInstructions:
      'Check the complete fictional request against authorized Source facts.',
    framingTokens: 512,
    budgets: {
      maxMessages: 20,
      maxInputBytes: 65_536,
      maxInputTokens: 16_000,
      maxContextTokens: 20_000,
      maxOutputBytes: 4_000,
      maxOutputTokens: 1_000,
      maxDurationMilliseconds: 2_000,
      maxCostMicros: 1_000,
      currency: 'USD',
      maxAttempts: 1,
    },
    dataControls: {
      status: 'verified',
      purpose: INDEPENDENT_CHECK_PURPOSE,
      configurationBinding: 'fictional-driver-check-config',
      accountRef: 'fictional-account',
      projectRef: 'fictional-project',
      endpointRef: 'fictional-endpoint',
      modelRef: 'fictional-model',
      featuresRef: 'fictional-features',
      exceptionsRef: 'fictional-exceptions',
      intermediaryRefs: ['fictional-intermediary'],
      verifiedAt,
      validUntil,
    },
  };
  const base: Omit<IndependentCheckRoute, 'approval'> = {
    host: 'pegma.dev',
    purpose: INDEPENDENT_CHECK_PURPOSE,
    endpoint: INDEPENDENT_CHECK_ENDPOINT,
    endpointTag: 'fictional/region',
    outputTokenParameter: 'max_tokens' as const,
    credentialRef: 'fictional-check-credential',
    usageScopeRef: 'fictional-driver-check-budget',
    configuration,
  };
  const route: IndependentCheckRoute = {
    ...base,
    approval: {
      wireVersion: INDEPENDENT_CHECK_WIRE,
      configurationVersion: configuration.version,
      requestPolicySha256: await independentCheckRoutePolicyHash(base),
      evidenceRef: 'fictional-check-approval',
      effectivePolicyRef: 'fictional-effective-policy',
      evaluationRef: 'fictional-check-evaluation',
      responseIdentityRef: 'fictional-check-identity',
      tokenizerRef: 'fictional-check-tokenizer',
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
      verifiedAt,
      validUntil,
    },
  };
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('FICTIONAL_DRIVER_CHECK_HMAC_KEY__'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  const configurationOptions: SupportIndependentChecksOptions = {
    store,
    clock: f.clock,
    enabled: () => f.state.enabled,
    readRoute: () => route,
    readApiKey: () => {
      state.beforeKey?.();
      return 'FICTIONAL_CHECK_PROVIDER_KEY';
    },
    allowlist: [
      {
        model: configuration.model,
        provider: configuration.provider,
        endpointTag: route.endpointTag,
        outputTokenParameter: route.outputTokenParameter,
      },
    ],
    counter: {
      qualification: {
        model: configuration.model,
        modelVersion: configuration.modelVersion,
        wireVersion: INDEPENDENT_CHECK_WIRE,
        framingTokens: configuration.framingTokens,
        evidenceRef: 'fictional-check-tokenizer',
        verifiedAt,
        validUntil,
      },
      count: (text) => encode(text).length,
    },
    fetch: async () => {
      state.calls++;
      await state.hook?.();
      if (state.lost) throw new Error('Fictional unknown paid check');
      return new Response(
        JSON.stringify({
          id: 'fictional-check-response',
          object: 'chat.completion',
          created: 1,
          provider: configuration.provider,
          model: configuration.model,
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  privacy: 'passed',
                  factual: 'passed',
                  security: 'clear',
                  applicability: 'passed',
                  duplication: 'passed',
                  publicReproduction: 'passed',
                  findings: [],
                }),
              },
            },
          ],
          usage: {
            prompt_tokens: 200,
            completion_tokens: 100,
            total_tokens: 300,
            cost: 0.0001,
            currency: 'USD',
            is_byok: false,
            prompt_tokens_details: { cached_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: 0 },
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
    application: () => f.application,
    deferred: true,
    authority: {
      async resolve() {
        return {
          outcome: 'ready',
          authority: {
            access: await f.resolve('engineering-staff'),
            authorityVersion: 'fictional-current-role-policy',
            usageScopeRef: route.usageScopeRef,
          },
        };
      },
    },
    repositories: {
      async resolve(id) {
        return f.state.installationActive ? (f.metadata.get(id) ?? null) : null;
      },
    },
    usagePolicy: {
      version: 'fictional-driver-check-funding',
      scopeRef: route.usageScopeRef,
      configurationVersion: configuration.version,
      modelVersion: configuration.modelVersion,
      pricingRef: configuration.pricingRef,
      currency: 'USD',
      maxCostMicros: 8_000,
      maxReservationCostMicros: 1_000,
      maxReservations: 8,
      validFrom: verifiedAt,
      validUntil,
      terminalRetentionMilliseconds: 3_600_000,
    },
    readReceiptKey: () => ({
      id: 'fictional-driver-check-key',
      key,
      validUntil,
    }),
  };
  const adapter = createSupportIndependentChecks(configurationOptions);
  const pendingChecks: ReturnType<typeof adapter.precomputePending>[] = [];
  if (bindApplication)
    Object.assign(
      f.ports.checks,
      adapter.engineeringFor(f.key()),
      adapter.engineeringSdkVerifier,
    );
  const runtimeOptions: Pick<
    SupportEngineeringRuntimeOptions,
    'checksFor' | 'precomputeChecks' | 'discardChecks'
  > = {
    checksFor: (scope, onDurablyDeferred) =>
      adapter.engineeringFor(scope, {
        onDurablyDeferred(hint) {
          if (hint.kind === 'engineering')
            onDurablyDeferred({
              kind: 'checks',
              operationId: hint.operationId,
              ...hint.scope,
              expiresAt: hint.expiresAt,
            });
        },
      }),
    async precomputeChecks(hint, run) {
      const pending = adapter.precomputePending(
        hint.operationId,
        run,
        {
          ticketId: hint.ticketId,
          sourceGeneration: hint.sourceGeneration,
        },
        run.current,
      );
      pendingChecks.push(pending);
      const result = await pending;
      if (state.losePrecomputeAck) {
        state.losePrecomputeAck = false;
        throw new Error('Fictional lost precompute ACK');
      }
      return { outcome: result.outcome };
    },
    discardChecks: async (ticketId) => {
      await adapter.discardPending({
        ticketId,
        sourceGeneration: f.key().sourceGeneration,
      });
    },
  };
  return {
    state,
    adapter,
    configuration: configurationOptions,
    pendingChecks,
    runtimeOptions,
    rows: () =>
      store
        .collection(independentCheckAttempts)
        .get({ partition: INDEPENDENT_CHECK_PURPOSE, id: 'attempts' }),
  };
}

export function registerEngineeringDriverCases(
  name: string,
  backend: () => Promise<EngineeringDriverBackend>,
) {
  describe('bounded engineering driver (' + name + ')', () => {
    it.each([false, true])(
      'retains every actual SDK reference from a 32 physical-record discovery page with lost ACK=%s',
      async (loseAck) => {
        const t = await engineeringDriverFixture(await backend());
        for (let index = 0; index < 8; index++)
          await t.addReport('driver-page-report-' + index);
        t.faults.loseHintAck = loseAck;
        const result = await t.tick();
        if (loseAck) expect(result.outcome).toBe('unavailable');
        else
          expect(result).toMatchObject({
            outcome: 'scanned',
            physicalRows: 32,
            selected: true,
          });
        const page = t.faults.lastScan;
        if (page === undefined || !('candidates' in page))
          throw new Error('Expected actual SDK page');
        const raw = await t.hint();
        if (raw === null || typeof raw.payload !== 'string')
          throw new Error('Expected actual saved backlog');
        const expected = [
          ...page.reconciliationSources.map((ticketId) => ({
            kind: 'reconciliation',
            ticketId,
          })),
          ...page.candidates.map((key) => ({ kind: 'work', ...key })),
        ];
        expect(expected.length).toBeGreaterThan(1);
        expect(expected.length).toBeLessThanOrEqual(32);
        console.info(
          'engineering-driver-discovery-page',
          JSON.stringify({
            physicalRows: page.physicalRows,
            workTargets: page.candidates.length,
            reconciliationTargets: page.reconciliationSources.length,
            retainedTargets: expected.length,
            lostAck: loseAck,
          }),
        );
        expect(raw.format).toBe(2);
        expect(JSON.parse(raw.payload)).toMatchObject({
          targets: expected,
          cursor: page.nextCursor,
        });
        expect(t.faults.workCalls).toBe(0);
        expect(t.faults.reconcileCalls).toBe(0);
        expect(t.f.state.modelCalls).toBe(0);
        expect(t.f.state.creates).toEqual([]);
      },
    );
    it('separates discovery from one real SDK phase across cold starts and requires exact human approval before one dispatch', async () => {
      const t = await engineeringDriverFixture(await backend());
      await t.selectWork();
      expect(t.f.state.modelCalls).toBe(0);
      expect(t.faults.workCalls).toBe(0);
      const first = await t.tick();
      expect(first).toMatchObject({
        outcome: 'work',
        result: { outcome: 'candidate' },
      });
      expect(t.f.state.modelCalls).toBe(1);
      expect(t.faults.workCalls).toBe(1);
      expect(await t.usage()).toMatchObject({
        spentMicros: '10',
        reservations: [{ state: 'known' }],
      });
      expect(await t.phase()).toMatchObject({
        outcome: 'work',
        result: { outcome: 'prepared' },
      });
      expect(t.f.state.creates).toEqual([]);
      await t.approve();
      expect(await t.phase()).toMatchObject({
        outcome: 'work',
        result: { outcome: 'dispatched' },
      });
      expect(t.f.state.creates).toHaveLength(1);
      expect(t.f.state.modelCalls).toBe(1);
      expect(t.f.state.reservations).toEqual([]);
      expect(t.f.state.accounting).toEqual([]);
    });
    it.each(['calibration', 'role'] as const)(
      'does not pay after current %s is lost following discovery',
      async (missing) => {
        const t = await engineeringDriverFixture(await backend());
        await t.selectWork();
        if (missing === 'calibration') t.f.state.calibrationReady = false;
        else await t.f.revoke('processor');
        expect((await t.tick()).outcome).toBe('work');
        expect(t.f.state.modelCalls).toBe(0);
        expect(await t.usage()).toBeNull();
      },
    );
    it('recovers a genuinely committed hint with a lost ACK without duplicating paid work', async () => {
      const t = await engineeringDriverFixture(await backend());
      t.faults.loseHintAck = true;
      expect((await t.tick()).outcome).toBe('unavailable');
      expect(await t.hint()).not.toBeNull();
      expect(await t.phase()).toMatchObject({
        outcome: 'work',
        result: { outcome: 'candidate' },
      });
      expect(t.f.state.modelCalls).toBe(1);
    });
    it('rediscoveries remain safe after consuming a target hint whose CAS ACK is lost', async () => {
      const t = await engineeringDriverFixture(await backend());
      await t.selectWork();
      t.faults.loseHintAck = true;
      expect((await t.tick()).outcome).toBe('unavailable');
      expect(t.f.state.modelCalls).toBe(0);
      expect(await t.phase()).toMatchObject({
        outcome: 'work',
        result: { outcome: 'candidate' },
      });
      expect(t.f.state.modelCalls).toBe(1);
    });
    it('recovers an actual lost SDK claim ACK without a second paid opportunity', async () => {
      const t = await engineeringDriverFixture(await backend());
      await t.selectWork();
      t.faults.loseClaimAck = true;
      expect(await t.tick()).toMatchObject({
        outcome: 'work',
        result: { outcome: 'pending' },
      });
      expect(t.faults.sdkLostAcks).toBe(1);
      expect(t.f.state.modelCalls).toBe(0);
      t.f.advance(31_000);
      expect(await t.phase()).toMatchObject({
        outcome: 'work',
        result: { outcome: 'candidate' },
      });
      expect(t.f.state.modelCalls).toBe(1);
    });
    it('recovers the actual model completion receipt after lost ACK without another model call or charge', async () => {
      const t = await engineeringDriverFixture(await backend());
      await t.selectWork();
      t.faults.loseCandidateAck = true;
      expect(await t.tick()).toMatchObject({
        outcome: 'work',
        result: { outcome: 'candidate' },
      });
      expect(t.faults.sdkLostAcks).toBe(1);
      expect(t.f.state.modelCalls).toBe(1);
      expect(await t.phase()).toMatchObject({
        outcome: 'work',
        result: { outcome: 'prepared' },
      });
      expect(t.f.state.modelCalls).toBe(1);
      expect(await t.usage()).toMatchObject({ spentMicros: '10' });
    });
    it('retains known over-budget native usage with no candidate or duplicate call', async () => {
      const t = await engineeringDriverFixture(await backend());
      t.faults.overage = true;
      expect(await t.phase()).toMatchObject({
        outcome: 'work',
        result: { outcome: 'held' },
      });
      expect(await t.usage()).toMatchObject({
        spentMicros: '150000',
        reservations: [{ state: 'known' }],
      });
      expect(t.f.state.modelCalls).toBe(1);
      expect((await t.f.work()).candidate).toBeUndefined();
    });
    it('does not starve another real report behind unknown dispatch reconciliation', async () => {
      const t = await engineeringDriverFixture(await backend());
      await t.phase();
      await t.phase();
      await t.approve();
      t.f.state.createMode = 'accept_then_lose';
      expect(await t.phase()).toMatchObject({
        outcome: 'work',
        result: { outcome: 'pending', stage: 'dispatch' },
      });
      t.f.state.reconciliation = 'unknown';
      expect(
        await t.until((result) => result.outcome === 'reconciliation'),
      ).toMatchObject({
        outcome: 'reconciliation',
        result: { outcome: 'pending' },
      });
      const ticketId = 'fictional-second-engineering-ticket';
      const messageId = 'fictional-second-question';
      await t.f.application.createCustomerTicket(t.f.actors.customer, {
        ...t.f.command('second-ticket'),
        ticketId,
        messageId,
        subject: 'Another fictional export failure',
        body: 'The export is empty.',
      });
      const ticket = (
        await t.f.application.readStaffTicket(t.f.actors.staff, ticketId)
      ).ticket;
      await t.f.runtime.enroll(t.f.actors.staff, {
        ticketId,
        clientCommandId: 'SECOND-ENROLL',
        expectedRevision: ticket.revision,
      });
      const source = await t.f.runtime.submitVerifiedFailure(t.f.actors.staff, {
        ticketId,
        clientCommandId: 'SECOND-FAILURE',
        expectedRevision: ticket.revision,
        security: 'ordinary',
        evidence: {
          kind: 'staff_verified_failure',
          expectedBehavior: 'The export contains rows.',
          actualBehavior: 'The export is empty.',
          reproductionSteps: ['Export a fictional workspace.'],
          visibleMessageIds: [messageId],
          verificationReference: 'fictional-second-verification',
        },
      });
      await t.until(() => t.f.state.modelCalls === 2);
      expect(t.faults.reconcileCalls).toBeGreaterThan(0);
      expect(t.f.state.creates).toHaveLength(1);
      expect(
        (
          await t.f.application.readEngineeringWork(t.f.actors.security, {
            ticketId,
            sourceGeneration: source.sourceGeneration,
          })
        ).candidate,
      ).toBeDefined();
      expect((await t.f.work()).status).toBe('unknown');
    });
    it('withholds a candidate after real source withdrawal during the paid external await while retaining actual usage', async () => {
      const t = await engineeringDriverFixture(await backend());
      let begin = () => {};
      let release = () => {};
      const entered = new Promise<void>((resolve) => {
        begin = resolve;
      });
      const proceed = new Promise<void>((resolve) => {
        release = resolve;
      });
      t.faults.modelGate = async () => {
        begin();
        await proceed;
      };
      const pending = t.phase();
      await Promise.race([
        entered,
        pending.then(() => {
          throw new Error('The real model boundary was not reached');
        }),
      ]);
      await t.f.runtime.withdraw(t.f.actors.staff, {
        ticketId: t.f.key().ticketId,
        clientCommandId: 'DRIVER-WITHDRAW-DURING-MODEL',
        reason: 'privacy_withdrawal',
      });
      release();
      await pending;
      expect((await t.f.source()).state).toBe('withdrawn');
      expect((await t.f.work()).candidate).toBeUndefined();
      expect(t.f.state.creates).toEqual([]);
      expect(t.f.state.modelCalls).toBe(1);
      expect(await t.usage()).toMatchObject({
        spentMicros: '10',
        reservations: [{ state: 'known' }],
      });
    });
  });
}
