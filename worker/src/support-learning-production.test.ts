import { createMemoryStore, defineCollection } from '@pegma/storage-core';
import { createRoleStore } from '@pegma/authorization-storage';
import {
  createKnowledgeBaseApplication,
  KnowledgeBaseNotFoundError,
} from '@pegma/knowledge-base-application';
import {
  createSupportDeskApplication,
  type ResolutionLearningKey,
} from '@pegma/support-desk-application';
import type { LearningChecksPort } from '@pegma/support-desk-ai';
import { describe, expect, it, vi } from 'vitest';
import {
  createProductionSupportLearning,
  type SupportLearningProductionOptions,
} from './support-learning-production';
import {
  createSupportLearningRuntime,
  createSupportLearningSourceBridge,
} from './support-learning';
import {
  createSupportLearningFixture,
  learningCanary,
  learningTicketId,
} from './support-learning-fixtures';
import {
  SUPPORT_LEARNING_ENDPOINT,
  SUPPORT_LEARNING_WIRE_VERSION,
  supportLearningRoutePolicySha256,
  type ApprovedSupportLearningRoute,
} from './support-learning-model';

type Shared = NonNullable<
  ReturnType<
    NonNullable<SupportLearningProductionOptions['configuration']>['readChecks']
  >
>;
async function fixture() {
  const f = await createSupportLearningFixture(createMemoryStore());
  await f.enrollAndVerify();
  const observed = await f.ports.configuration.resolve(
    undefined,
    new AbortController().signal,
  );
  if (observed.outcome !== 'ready')
    throw new Error('Actual learning fixture configuration required');
  const config = {
    ...structuredClone(observed.configuration),
    dataControls: {
      ...structuredClone(observed.configuration.dataControls),
      intermediaryRefs: ['fictional-learning-intermediary'],
    },
  };
  const validUntil = config.dataControls.validUntil;
  const base: Omit<ApprovedSupportLearningRoute, 'approval'> = {
    host: 'pegma.dev',
    purpose: 'support_learning',
    endpoint: SUPPORT_LEARNING_ENDPOINT,
    endpointTag: 'fictional/learning-region',
    outputTokenParameter: 'max_tokens',
    credentialRef: 'fictional-learning-key-ref',
    usageScopeRef: 'synthetic-learning-only-usage',
    configuration: config,
  };
  const route: ApprovedSupportLearningRoute = {
    ...base,
    approval: {
      wireVersion: SUPPORT_LEARNING_WIRE_VERSION,
      configurationVersion: config.version,
      requestPolicySha256: await supportLearningRoutePolicySha256(base),
      evidenceRef: 'fictional-evidence',
      effectivePolicyRef: 'fictional-policy',
      evaluationRef: 'fictional-evaluation',
      responseIdentityRef: 'fictional-response',
      tokenizerRef: 'fictional-learning-tokenizer',
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
      verifiedAt: f.clock.now(),
      validUntil,
    },
  };
  const scopes: ResolutionLearningKey[] = [];
  const controls = {
    enabled: true,
    ready: true,
    precompute: vi.fn(async () => ({ outcome: 'held' as const })),
    discard: vi.fn(
      async (_kind: 'engineering' | 'learning', _ticket: string) => 0,
    ),
  };
  const controller: Shared = {
    learningSdkVerifier: f.ports.checks,
    resolvePolicy: f.ports.checks.resolvePolicy,
    learningFor(key) {
      scopes.push(structuredClone(key));
      return f.ports.checks;
    },
    precomputePending: controls.precompute,
    discardTicket: controls.discard,
  };
  const readApiKey = vi.fn((_ref: string) => 'FICTIONAL_LEARNING_KEY');
  const fetch = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(
        JSON.stringify({
          id: 'gen-fictional-learning-production',
          object: 'chat.completion',
          provider: config.provider,
          model: config.model,
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: JSON.stringify(f.candidate),
              },
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 70,
            total_tokens: 170,
            cost: 0.00001,
            currency: 'USD',
            is_byok: false,
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  );
  const supplied: NonNullable<
    SupportLearningProductionOptions['configuration']
  > = {
    productContext: {
      async resolve(context) {
        return {
          productId: f.product.productId,
          version: f.product.productVersion,
          buildId: f.product.buildId,
          binding: 'synthetic-workspace-build-1',
          contextVersion: 'synthetic-product-context-v1',
          receiptId: 'fictional-product',
          verifiedAt: context.acceptedAt,
          validUntil,
        };
      },
    },
    serviceAccess: f.ports.serviceAccess,
    knowledgeAccess: f.ports.knowledgeAccess,
    retirementAccess: f.ports.retirementAccess,
    targets: f.ports.targets,
    readChecks: () => (controls.ready ? controller : undefined),
    model: {
      readRoute: () => route,
      allowlist: [
        {
          model: config.model,
          provider: config.provider,
          endpointTag: route.endpointTag,
          outputTokenParameter: route.outputTokenParameter,
        },
      ],
      counter: {
        qualification: {
          model: config.model,
          modelVersion: config.modelVersion,
          wireVersion: SUPPORT_LEARNING_WIRE_VERSION,
          framingTokens: config.framingTokens,
          evidenceRef: route.approval.tokenizerRef,
          verifiedAt: f.clock.now(),
          validUntil,
        },
        count: (value) => Math.ceil(new TextEncoder().encode(value).length / 4),
      },
      readApiKey,
      fetch,
    },
    usagePolicy: {
      version: 'fictional-learning-funding',
      scopeRef: route.usageScopeRef,
      configurationVersion: config.version,
      modelVersion: config.modelVersion,
      pricingRef: config.pricingRef,
      currency: 'USD',
      maxCostMicros: 100_000,
      maxReservationCostMicros: 10_000,
      maxReservations: 8,
      validFrom: f.clock.now(),
      validUntil,
      terminalRetentionMilliseconds: 60_000,
    },
  };
  const production = createProductionSupportLearning({
    intakeEnabled: true,
    enabled: () => controls.enabled,
    configuration: supplied,
  });
  // The new factory's real application options and one source bridge configure
  // this exact App + KB graph. Only external provider/checker outcomes are fictional.
  const application = createSupportDeskApplication({
    store: f.store,
    clock: f.clock,
    resolutionLearning: production.application,
  });
  const sources = createSupportLearningSourceBridge({
    application,
    clock: f.clock,
    serviceAccess: supplied.serviceAccess,
    reviewPolicy: f.ports.checks,
  });
  const knowledge = createKnowledgeBaseApplication({
    store: f.store,
    clock: f.clock,
    privateSources: sources,
  });
  const source = await application.readResolutionLearningSource(
    f.actors.staff,
    learningTicketId,
  );
  const key = {
    ticketId: learningTicketId,
    sourceGeneration: source.sourceGeneration,
  };
  function runtime(keyOverride = key) {
    const ports = production.createProcessingPorts(keyOverride);
    if (!ports) throw new Error('Actual scoped processing ports required');
    return createSupportLearningRuntime({
      application,
      knowledge,
      sources,
      clock: f.clock,
      ports,
      processingEnabled: production.processingEnabled,
      staffAccess: { resolve: (id) => f.resolve(id) },
    });
  }
  const process = () =>
    runtime().processWork({
      ...key,
      workerId: 'fictional-production-worker',
      leaseMilliseconds: 30_000,
    });
  return {
    f,
    controls,
    controller,
    supplied,
    production,
    application,
    sources,
    knowledge,
    key,
    scopes,
    readApiKey,
    fetch,
    runtime,
    process,
    route,
  };
}

interface LedgerEnvelope {
  readonly partition: string;
  readonly id: string;
  readonly format: number;
  readonly payload: string;
}
const ledgerRows = defineCollection<LedgerEnvelope>({
  name: 'pegma.support-learning-usage.v1',
  key: () => ({ partition: 'support_learning', id: 'budget' }),
  codec: {
    encode: (value) => ({ ...value }),
    decode(value) {
      if (
        typeof value.partition !== 'string' ||
        typeof value.id !== 'string' ||
        typeof value.format !== 'number' ||
        typeof value.payload !== 'string'
      )
        throw new Error('Actual ledger envelope required');
      return {
        partition: value.partition,
        id: value.id,
        format: value.format,
        payload: value.payload,
      };
    },
  },
});

describe('explicit source-injected learning production factory', () => {
  it('defaults OFF with no runtime, checker, route, key, Store or provider work', async () => {
    const composition = createProductionSupportLearning();
    expect(composition.application.enabled).toBe(false);
    expect(composition.processingEnabled()).toBe(false);
    expect(composition.sourcePorts).toBeUndefined();
    expect(
      composition.createProcessingPorts({
        ticketId: 'fictional',
        sourceGeneration: 1,
      }),
    ).toBeUndefined();
    expect(
      await composition.precomputePending('fictional', {
        deadline: '2026-11-10T13:00:00.000Z',
        signal: new AbortController().signal,
      }),
    ).toEqual({ outcome: 'held' });
    expect(await composition.discardChecks('fictional')).toBe(0);
  });
  it('creates a candidate and private draft through the existing SDK without notes, receipts or authority in the model input', async () => {
    const t = await fixture();
    expect(t.production.processingEnabled()).toBe(false);
    expect(t.readApiKey).not.toHaveBeenCalled();
    expect(t.production.attachRuntime(t.f)).toBe(true);
    expect(t.production.attachRuntime(t.f)).toBe(false);
    expect(t.production.processingEnabled()).toBe(true);
    expect((await t.process()).outcome).toBe('candidate');
    expect(t.fetch).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(String(t.fetch.mock.calls[0]![1].body));
    const input = JSON.parse(sent.messages[1].content);
    expect(Object.keys(input).sort()).toEqual([
      'messages',
      'trustedInstructions',
      'workingSolution',
    ]);
    expect(JSON.stringify(input)).not.toContain(learningCanary);
    expect(JSON.stringify(input)).not.toContain(
      'SYNTHETIC_PRIVATE_VERIFICATION',
    );
    expect(JSON.stringify(input)).not.toContain(learningTicketId);
    expect(input.workingSolution).toEqual([
      'Open Workspace and choose Export.',
    ]);
    const delivered = await t.process();
    expect(delivered.outcome).toBe('delivered');
    const work = await t.application.readResolutionLearningWork(
      t.f.actors.staff,
      t.key,
    );
    if (!work.target) throw new Error('Actual delivered target required');
    expect(work.status).toBe('completed');
    await expect(
      t.knowledge.getPublishedArticle(t.f.actors.customer, {
        articleId: work.target.articleId,
      }),
    ).rejects.toBeInstanceOf(KnowledgeBaseNotFoundError);
    const ledger = await t.f.store
      .collection(ledgerRows)
      .get({ partition: 'support_learning', id: 'budget' });
    expect(ledger).not.toBeNull();
    const funding = JSON.parse(String(ledger!.payload));
    expect(funding.spentMicros).toBe('10');
    expect(funding.reservations).toHaveLength(1);
    expect(funding.reservations[0].state).toBe('known');
    expect(
      t.scopes.every(
        (scope) =>
          scope.ticketId === t.key.ticketId &&
          scope.sourceGeneration === t.key.sourceGeneration,
      ),
    ).toBe(true);
  });
  it.each(['service-revoked', 'source-reopened'])(
    'rechecks actual authority and source after the provider await: %s',
    async (fault) => {
      const t = await fixture();
      t.production.attachRuntime(t.f);
      const transport = t.fetch.getMockImplementation();
      if (!transport) throw new Error('Fictional provider response required');
      let mutation: 'revoked' | 'reopened' | undefined;
      t.fetch.mockImplementationOnce(async (url, init) => {
        const response = await transport(url, init);
        if (fault === 'source-reopened') {
          await t.application.reopenTicket(t.f.actors.staff, {
            ...t.f.command('model-await-reopen'),
            ticketId: learningTicketId,
          });
          mutation = 'reopened';
        } else {
          const roles = createRoleStore(t.f.store, 'pegma-learning-fixture');
          const assignment = await roles.getRoleAssignment(
            'fixture-learning-role-supportService',
          );
          if (!assignment)
            throw new Error('Actual service role assignment required');
          const revoked = await roles.revokeRoleAssignmentWithAudit({
            assignmentId: assignment.assignment.id,
            expectedConcurrencyToken: assignment.concurrencyToken,
            revokedBy: {
              kind: 'system',
              systemId: 'fictional-learning-production',
            },
            revokedAtEpochMs: Date.parse(t.f.clock.now()),
            auditEventId: 'fictional-production-service-revoke',
          });
          if (revoked.status === 'revoked') mutation = 'revoked';
        }
        return response;
      });
      expect((await t.process()).outcome).not.toBe('candidate');
      expect(mutation).toBe(
        fault === 'source-reopened' ? 'reopened' : 'revoked',
      );
      expect(t.fetch).toHaveBeenCalledTimes(1);
      const work = (await t.f.rows()).filter(
        (row) => row.kind === 'resolution_learning_work',
      );
      expect(work.length).toBeGreaterThan(0);
      expect(work.every((row) => row.candidate === undefined)).toBe(true);
    },
  );
  it('keeps source and retirement authority available when model processing is OFF', async () => {
    const t = await fixture();
    t.production.attachRuntime(t.f);
    t.controls.enabled = false;
    expect(t.production.application.enabled).toBe(true);
    expect(t.production.processingEnabled()).toBe(false);
    expect((await t.process()).outcome).toBe('held');
    expect(t.readApiKey).not.toHaveBeenCalled();
    expect(t.fetch).not.toHaveBeenCalled();
    const read = await t.production.sourcePorts!.serviceAccess.resolve(
      new AbortController().signal,
    );
    const retirement = await t.production.sourcePorts!.retirementAccess.resolve(
      new AbortController().signal,
    );
    expect(read.outcome).toBe('ready');
    expect(retirement.outcome).toBe('ready');
    await t.application.reopenTicket(t.f.actors.staff, {
      ...t.f.command('production-reopen'),
      ticketId: learningTicketId,
    });
    const current = await t.application.readResolutionLearningSource(
      t.f.actors.staff,
      learningTicketId,
    );
    expect(current.sourceGeneration).toBeGreaterThan(t.key.sourceGeneration);
    await expect(
      t.runtime().reconcileSource(learningTicketId),
    ).resolves.toBeDefined();
    expect(t.fetch).not.toHaveBeenCalled();
  });
  it('does not synthesize checker readiness during lazy initialization', async () => {
    const t = await fixture();
    t.controls.ready = false;
    t.production.attachRuntime(t.f);
    expect(t.production.processingEnabled()).toBe(false);
    expect(t.production.createProcessingPorts(t.key)).toBeUndefined();
    const binding = {
      candidateHash: 'a'.repeat(64),
      sourceBindingHash: 'b'.repeat(64),
      policyVersion: 'fictional-policy',
      applicabilityHash: 'c'.repeat(64),
      targetDecisionHash: 'd'.repeat(64),
      requestHash: 'e'.repeat(64),
    };
    expect(
      await t.production.application.checks!.verify(
        'fictional-receipt',
        binding,
      ),
    ).toBeNull();
    t.controls.ready = true;
    expect(t.production.processingEnabled()).toBe(true);
    expect(t.production.createProcessingPorts(t.key)).toBeDefined();
    expect(t.readApiKey).not.toHaveBeenCalled();
  });
  it('uses independent immutable work scopes and forwards only learning lifecycle calls', async () => {
    const t = await fixture();
    t.production.attachRuntime(t.f);
    const other = { ticketId: 'fictional-other-ticket', sourceGeneration: 7 };
    expect(t.production.createProcessingPorts(t.key)).toBeDefined();
    expect(t.production.createProcessingPorts(other)).toBeDefined();
    expect(t.scopes).toEqual([t.key, other]);
    expect(await t.production.discardChecks(t.key.ticketId)).toBe(0);
    expect(t.controls.discard).toHaveBeenCalledExactlyOnceWith(
      'learning',
      t.key.ticketId,
    );
    await t.production.precomputePending(
      'fictional-operation',
      {
        deadline: t.route.approval.validUntil,
        signal: new AbortController().signal,
      },
      t.key,
    );
    expect(t.controls.precompute).toHaveBeenCalledTimes(1);
  });
  it.each(['wrong-scope', 'wrong-price', 'expired-funding'])(
    'refuses %s before model execution without disabling read authority',
    async (fault) => {
      const t = await fixture();
      const policy = {
        ...t.supplied.usagePolicy,
        ...(fault === 'wrong-scope' ? { scopeRef: 'another-scope' } : {}),
        ...(fault === 'wrong-price' ? { pricingRef: 'another-price' } : {}),
        ...(fault === 'expired-funding'
          ? {
              validUntil: new Date(
                Date.parse(t.f.clock.now()) + 1_000,
              ).toISOString(),
            }
          : {}),
      };
      const c = createProductionSupportLearning({
        enabled: () => true,
        configuration: { ...t.supplied, usagePolicy: policy },
      });
      c.attachRuntime(t.f);
      if (fault === 'expired-funding') t.f.advance(1_001);
      const ports = c.createProcessingPorts(t.key)!;
      expect(
        (
          await ports.configuration.resolve(
            undefined,
            new AbortController().signal,
          )
        ).outcome,
      ).toBe('unavailable');
      expect(t.fetch).not.toHaveBeenCalled();
      expect(
        (
          await c.sourcePorts!.serviceAccess.resolve(
            new AbortController().signal,
          )
        ).outcome,
      ).toBe('ready');
    },
  );
  it('stops missing key readiness before any funded model opportunity', async () => {
    const t = await fixture();
    const c = createProductionSupportLearning({
      enabled: () => true,
      configuration: {
        ...t.supplied,
        model: { ...t.supplied.model, readApiKey: () => undefined },
      },
    });
    c.attachRuntime(t.f);
    const ports = c.createProcessingPorts(t.key)!;
    expect(
      (
        await ports.configuration.resolve(
          undefined,
          new AbortController().signal,
        )
      ).outcome,
    ).toBe('unavailable');
    expect(t.fetch).not.toHaveBeenCalled();
    expect(
      await t.f.store.collection(ledgerRows).list('support_learning'),
    ).toEqual([]);
  });
});
