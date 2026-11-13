import { createRoleStore } from '@pegma/authorization-storage';
import {
  createSupportDeskLearning,
  type LearningAttemptContext,
  type LearningUsageIdentity,
} from '@pegma/support-desk-ai';
import {
  defineCollection,
  type CollectionDefinition,
  type CollectionStore,
  type Store,
  type StoredRecord,
} from '@pegma/storage-core';
import { supportRecords } from '@pegma/support-desk-application';
import { encode } from 'gpt-tokenizer';
import { createSupportLearningFixture } from './support-learning-fixtures';
import { createSupportLearningKnowledgePort } from './support-learning-ports';
import { createSupportModelUsageLedger } from './support-model-usage-ledger';
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
import {
  createSupportLearningDriver,
  type SupportLearningDeferredCheckHint,
  type SupportLearningDriverRuntime,
  type SupportLearningDriverResult,
} from './support-learning-driver';

export const learningDriverHintKey = { partition: 'learning', id: 'cursor' };
export const learningDriverHintRows = defineCollection<StoredRecord>({
  name: 'pegma.support-learning-driver.v1',
  key: (value) => ({
    partition: String(value.partition),
    id: String(value.id),
  }),
  codec: {
    encode: (value) => ({ ...value }),
    decode: (value) => ({ ...value }),
  },
});
const usageRows = defineCollection<StoredRecord>({
  name: 'pegma.support-learning-usage.v1',
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

/** Real public SDK App, KB, audited roles, ledger and conditional writes.
 * Model/checker provider transports are explicitly fictional local systems. */
export async function createLearningDriverFixture(
  backing: Store,
  options: {
    readonly deferredChecks?: boolean;
    readonly modelAttempts?: 1 | 2;
  } = {},
) {
  const faults = {
    enabled: true,
    loseHintAck: false,
    loseClaimAck: false,
    loseCandidateAck: false,
    loseDeliveryAcks: 0,
    workCalls: 0,
    scans: 0,
    reconciliations: 0,
    hintWrites: 0,
    createCalls: 0,
    afterHintRead: undefined as (() => Promise<void>) | undefined,
    afterHintWrite: undefined as (() => void) | undefined,
    blockedHintRead: undefined as (() => Promise<void>) | undefined,
    lastScan: undefined as
      | Awaited<
          ReturnType<
            ReturnType<typeof createSupportDeskLearning>['scanCandidates']
          >
        >
      | undefined,
  };
  const pendingStages: Promise<unknown>[] = [];
  const store: Store = {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      const actual = backing.collection(definition);
      if (definition.name === learningDriverHintRows.name) {
        const written = (accepted: boolean) => {
          if (!accepted) return;
          faults.hintWrites++;
          faults.afterHintWrite?.();
          if (faults.loseHintAck) {
            faults.loseHintAck = false;
            throw new Error('Lost actual learning head ACK');
          }
        };
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
            written(result.inserted);
            return result;
          },
          async putIfUnchanged(value, version) {
            const result = await actual.putIfUnchanged(value, version);
            written(result);
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
                action.value.kind !== 'resolution_learning_work'
              )
                continue;
              if (
                (faults.loseClaimAck && action.value.status === 'claimed') ||
                (faults.loseCandidateAck && action.value.status === 'candidate')
              ) {
                faults.loseClaimAck = false;
                faults.loseCandidateAck = false;
                throw new Error('Lost real learning SDK transaction ACK');
              }
            }
          return result;
        },
      };
    },
  };
  const f = await createSupportLearningFixture(store);
  await f.enrollAndVerify();
  const source = await f.runtime.readSource(f.actors.staff, 'learning-ticket');
  const key = {
    ticketId: source.ticketId,
    sourceGeneration: source.sourceGeneration,
  };
  const config = await f.ports.configuration.resolve(
    undefined,
    new AbortController().signal,
  );
  if (config.outcome !== 'ready')
    throw new Error('Expected actual fixture configuration');
  const selectedConfiguration = (value: typeof config.configuration) =>
    options.modelAttempts === undefined
      ? value
      : {
          ...value,
          version: value.version + '-attempts-' + options.modelAttempts,
          budgets: { ...value.budgets, maxAttempts: options.modelAttempts },
          dataControls: {
            ...value.dataControls,
            configurationBinding:
              value.version + '-attempts-' + options.modelAttempts,
          },
        };
  const c = selectedConfiguration(config.configuration);
  const policy = {
    version: 'fictional-learning-driver-pool',
    scopeRef: 'synthetic-learning-only-usage',
    configurationVersion: c.version,
    modelVersion: c.modelVersion,
    pricingRef: c.pricingRef,
    currency: 'USD',
    maxCostMicros: 100_000,
    maxReservationCostMicros: c.budgets.maxCostMicros,
    maxReservations: 8,
    validFrom: c.dataControls.verifiedAt,
    validUntil: c.dataControls.validUntil,
    terminalRetentionMilliseconds: 60_000,
  };
  const usage = createSupportModelUsageLedger<
    LearningAttemptContext,
    LearningUsageIdentity
  >(
    { store, clock: f.clock, policy },
    {
      purpose: 'support_learning',
      collection: usageRows.name,
      key: { partition: 'support_learning', id: 'budget' },
      identity: (value) => value,
      binding: (value) =>
        JSON.stringify([
          value.purpose,
          value.invocationId,
          value.attempt,
          value.inputManifestHash,
          value.configurationVersion,
          value.promptVersion,
          value.modelVersion,
          value.checkPolicyVersion,
          value.authorityVersion,
          value.usageScopeRef,
          value.deadline,
          value.fence,
          value.sourceFence,
          value.budgets,
        ]),
    },
  );
  const checker = options.deferredChecks
    ? await learningDriverCheckerFixture(f, store, key)
    : undefined;
  const knowledge = createSupportLearningKnowledgePort({
    ...f.knowledge,
    async createDraft(...args) {
      faults.createCalls++;
      const result = await f.knowledge.createDraft(...args);
      if (faults.loseDeliveryAcks > 0) {
        faults.loseDeliveryAcks--;
        throw new Error('Lost actual committed KB create ACK');
      }
      return result;
    },
  });
  const work = () =>
    f.application.readResolutionLearningWork(f.actors.staff, key);
  function driver() {
    return createSupportLearningDriver({
      store,
      clock: f.clock,
      isEnabled: () => faults.enabled,
      runtime(current) {
        const sdk = (checks = f.ports.checks) =>
          createSupportDeskLearning({
            application: f.application,
            knowledge,
            sources: f.sources,
            clock: f.clock,
            ...f.ports,
            checks,
            usage,
            storageCommandAttempts: 2,
            serviceAccess: {
              async resolve(signal) {
                if (!current()) return { outcome: 'inactive' };
                const value = await f.ports.serviceAccess.resolve(signal);
                return current() ? value : { outcome: 'inactive' };
              },
            },
            configuration: {
              async resolve(expected, signal) {
                if (!f.state.enabled || !current())
                  return { outcome: 'disabled' };
                const value = await f.ports.configuration.resolve(
                  undefined,
                  signal,
                );
                if (!current() || !f.state.enabled)
                  return { outcome: 'disabled' };
                if (value.outcome !== 'ready') return value;
                const configuration = selectedConfiguration(
                  value.configuration,
                );
                return expected !== undefined &&
                  expected !== configuration.version
                  ? { outcome: 'unavailable' }
                  : { outcome: 'ready', configuration };
              },
            },
          });
        const runtime: SupportLearningDriverRuntime = {
          async scanCandidates(bounds) {
            faults.scans++;
            const page = await sdk().scanCandidates(bounds);
            faults.lastScan = structuredClone(page);
            return page;
          },
          async processWork(command, run) {
            faults.workCalls++;
            if (!f.state.enabled)
              return { outcome: 'held', reason: 'learning_disabled' };
            let hint: SupportLearningDeferredCheckHint | undefined;
            const checks =
              checker?.adapter.learningFor(
                {
                  ticketId: command.ticketId,
                  sourceGeneration: command.sourceGeneration,
                },
                {
                  onDurablyDeferred(value) {
                    if (value.kind === 'learning')
                      hint = {
                        kind: 'checks',
                        operationId: value.operationId,
                        ...value.scope,
                        expiresAt: value.expiresAt,
                      };
                  },
                },
              ) ?? f.ports.checks;
            const pending = sdk(checks).processWork(command, run);
            pendingStages.push(pending);
            const result = await pending;
            return hint &&
              (result.outcome === 'held' || result.outcome === 'pending')
              ? { outcome: 'checks_pending', hint }
              : result;
          },
          async reconcileSource(ticketId, run) {
            faults.reconciliations++;
            return sdk().reconcileSource(ticketId, run);
          },
          async precomputeChecks(hint, run) {
            if (!checker) return { outcome: 'held' };
            const signal = run?.signal ?? new AbortController().signal;
            const pending = checker.adapter.precomputePending(
              hint.operationId,
              {
                deadline: new Date(
                  Math.min(
                    Date.parse(f.clock.now()) + 25_000,
                    Date.parse(hint.expiresAt),
                  ),
                ).toISOString(),
                signal,
              },
              {
                ticketId: hint.ticketId,
                sourceGeneration: hint.sourceGeneration,
              },
              () => current() && f.state.enabled,
            );
            pendingStages.push(pending);
            const result = await pending;
            if (checker.state.losePrecomputeAck) {
              checker.state.losePrecomputeAck = false;
              throw new Error('Lost actual checker precompute ACK');
            }
            return { outcome: result.outcome };
          },
        };
        return runtime;
      },
    });
  }
  const tick = (run?: { readonly signal?: AbortSignal }) =>
    driver().runTick(run);
  async function until(
    match: (result: SupportLearningDriverResult) => boolean,
  ) {
    const observations: unknown[] = [];
    for (let physical = 0; physical < 160; physical++) {
      const result = await tick();
      if (observations.length < 6) observations.push(result);
      if (match(result)) return result;
    }
    throw new Error(
      'The bounded real learning scan did not reach its stage: ' +
        JSON.stringify({
          observations,
          lastScan: faults.lastScan,
          modelCalls: f.state.modelCalls,
        }),
    );
  }
  const phase = () => until((result) => result.outcome === 'work');
  async function addReport(ticketId: string) {
    const question = ticketId + '-question',
      solution = ticketId + '-solution';
    await f.application.createCustomerTicket(f.actors.customer, {
      ...f.command('another-ticket'),
      ticketId,
      messageId: question,
      subject: 'Another fictional export question',
      body: 'How do I export?',
    });
    await f.application.replyAsStaff(f.actors.staff, {
      ...f.command('another-solution'),
      ticketId,
      messageId: solution,
      body: 'Open Workspace and choose Export.',
    });
    await f.application.resolveTicket(f.actors.staff, {
      ...f.command('another-resolve'),
      ticketId,
    });
    const ticket = (
      await f.application.readStaffTicket(f.actors.staff, ticketId)
    ).ticket;
    await f.runtime.enroll(f.actors.staff, {
      ticketId,
      clientCommandId: ticketId + '-enroll',
      expectedRevision: ticket.revision,
    });
    const current = await f.runtime.readSource(f.actors.staff, ticketId);
    const accepted = await f.runtime.submitVerifiedFix(f.actors.staff, {
      ticketId,
      clientCommandId: ticketId + '-verify',
      expectedRevision: ticket.revision,
      resolutionCycle: current.resolutionCycle,
      evidence: {
        kind: 'staff_verified_fix',
        solutionMessageId: solution,
        verificationReference: 'FICTIONAL_ADDITIONAL_VERIFY',
      },
    });
    return { ticketId, sourceGeneration: accepted.sourceGeneration };
  }
  return {
    store,
    backing,
    f,
    key,
    faults,
    checker,
    driver,
    tick,
    until,
    phase,
    pendingStages,
    work,
    addReport,
    hint: () =>
      backing.collection(learningDriverHintRows).get(learningDriverHintKey),
    async usage() {
      const row = await backing
        .collection(usageRows)
        .get({ partition: 'support_learning', id: 'budget' });
      return row === null ? null : (JSON.parse(String(row.payload)) as unknown);
    },
    async revokeProcessing() {
      const roles = createRoleStore(store, 'pegma-learning-fixture');
      const row = await roles.getRoleAssignment(
        'fixture-learning-role-supportService',
      );
      if (!row) throw new Error('Role required');
      return roles.revokeRoleAssignmentWithAudit({
        assignmentId: 'fixture-learning-role-supportService',
        expectedConcurrencyToken: row.concurrencyToken,
        revokedBy: { kind: 'system', systemId: 'fictional-learning-driver' },
        revokedAtEpochMs: Date.parse(f.clock.now()),
        auditEventId: 'driver-revoke-process',
      });
    },
  };
}

async function learningDriverCheckerFixture(
  f: Awaited<ReturnType<typeof createSupportLearningFixture>>,
  store: Store,
  keyScope: { ticketId: string; sourceGeneration: number },
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
    policyVersion: 'synthetic-learning-check-policy-v1',
    policyBinding: 'synthetic-independent-learning-checks',
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
            access: await f.resolve(f.actors.staff.principalId),
            authorityVersion: 'fictional-current-role-policy',
            usageScopeRef: route.usageScopeRef,
          },
        };
      },
    },
    knowledge: f.knowledge,
    knowledgeAccess: f.ports.knowledgeAccess,
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
  Object.assign(
    f.ports.checks,
    adapter.learningFor(keyScope),
    adapter.learningSdkVerifier,
  );
  return {
    state,
    adapter,
    configuration: configurationOptions,
    rows: () =>
      store
        .collection(independentCheckAttempts)
        .get({ partition: INDEPENDENT_CHECK_PURPOSE, id: 'attempts' }),
  };
}
