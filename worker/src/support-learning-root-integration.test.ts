import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStore, type Store } from '@pegma/storage-core';
import { supportRecords } from '@pegma/support-desk-application';
import * as d1 from '@pegma/storage-cloudflare-d1';
import { identityLinkKeyFromVerifiedIdentityClaims } from '@pegma/authorization-identity';
import { knowledgePermissions } from '@pegma/knowledge-base-contracts';
import * as supportDesk from './support-desk';
import * as answeringComposition from './support-assistant-composition';
import { supportAnsweringFixture } from './support-answering-fixtures';
import * as learningComposition from './support-learning-composition';
import type { SupportLearningCompositionOptions } from './support-learning-composition';
import * as independentChecks from './support-independent-checks';
import * as learningDriver from './support-learning-driver';
import * as retrievalReady from './knowledge-retrieval-ready';
import * as retrievalMaintenance from './knowledge-retrieval-maintenance';
import * as identityRuntime from './identity-runtime';
import { createWorker } from './index';
import {
  createSupportLearningFixture,
  learningCanary,
  learningTicketId,
} from './support-learning-fixtures';
import { createLearningDriverFixture } from './support-learning-driver-fixtures';
import {
  APPLICATION_SCOPE,
  KNOWLEDGE_ROLE,
  SUPPORT_ROLE,
} from './support-access';
import { IDENTITY_ISSUER, SESSION_COOKIE } from './identity-api';
import {
  CLEANUP_CRON,
  RATE_LIMIT_CRON,
  cleanupLaneAt,
  rateKnowledgeLaneAt,
} from './maintenance-schedule';
import { SUPPORT_ENGINEERING_QUEUE } from './support-engineering-queue';
import {
  SUPPORT_LEARNING_ENDPOINT,
  SUPPORT_LEARNING_WIRE_VERSION,
  supportLearningRoutePolicySha256,
  type ApprovedSupportLearningRoute,
} from './support-learning-model';

// Only the platform adapter selection is replaced. Every Identity, Session,
// RoleStore, Support, KB, source verifier, driver and conditional write is real.
vi.mock('@pegma/storage-cloudflare-d1', async (original) => ({
  ...(await original<typeof import('@pegma/storage-cloudflare-d1')>()),
  createCloudflareD1Store: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const now = '2026-11-10T12:00:00.000Z';
const csrf = 'c'.repeat(43);
type Environment = Parameters<ReturnType<typeof createWorker>['fetch']>[1];
function environment(): Environment {
  const unavailable = (): never => {
    throw new Error('Only the actual Memory adapter is selected');
  };
  return {
    IDENTITY_DB: {
      prepare: unavailable,
      batch: unavailable,
      exec: unavailable,
      dump: unavailable,
      withSession: unavailable,
    },
    IDENTITY_EMAIL_CODE_SECRET_BASE64: btoa('s'.repeat(32)),
    IDENTITY_EMAIL_FROM: 'Pegma <synthetic@example.test>',
    IDENTITY_EMAIL_ENABLED: 'false',
    PEGMA_KNOWLEDGE_ENABLED: 'true',
    PEGMA_AGENT_CLIENTS_JSON: '[]',
    PEGMA_SUPPORT_ASSISTANT_ENABLED: 'false',
    PEGMA_SUPPORT_ENGINEERING_PROCESSING_ENABLED: 'false',
    PEGMA_SUPPORT_LEARNING_INTAKE_ENABLED: 'false',
    PEGMA_SUPPORT_LEARNING_WORKER_ENABLED: 'false',
  } as unknown as Environment;
}
function invocation() {
  const pending: Promise<unknown>[] = [];
  const context = {
    waitUntil: (value: Promise<unknown>) => pending.push(value),
    passThroughOnException() {},
    props: {},
    exports: {},
    tracing: {},
    abort() {},
  } as unknown as ExecutionContext;
  return {
    context,
    async drain() {
      await Promise.all(pending.splice(0));
    },
  };
}
function scheduled(cron: string, time: number): ScheduledController {
  return { cron, scheduledTime: time, noRetry() {} };
}
function delivery() {
  const message = {
    id: 'fictional-learning-wake',
    timestamp: new Date(now),
    attempts: 1,
    body: { version: 1, kind: 'support-learning-wake' },
    ack: vi.fn(),
    retry: vi.fn(),
  };
  const batch: MessageBatch<unknown> = {
    queue: SUPPORT_ENGINEERING_QUEUE,
    messages: [message],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
    metadata: {} as MessageBatchMetadata,
  };
  return { message, batch };
}
async function rootFixture(processing = false) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
  const actual = createMemoryStore();
  const driverFixture = processing
    ? await createLearningDriverFixture(actual, { deferredChecks: true })
    : undefined;
  const f = driverFixture?.f ?? (await createSupportLearningFixture(actual));
  vi.mocked(d1.createCloudflareD1Store).mockReturnValue(f.store);
  const logger = { log() {} };
  const identity = identityRuntime.createIdentityRuntime(
    {
      store: f.store,
      emailCodeSecretBase64: btoa('s'.repeat(32)),
      emailFrom: 'Pegma <synthetic@example.test>',
      emailEnabled: false,
    },
    logger,
  );
  const support = supportDesk.createSupportRuntime({
    store: f.store,
    clock: f.clock,
    identity: identity.identity,
    sessions: identity.sessions,
    logger,
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
  });
  const actors = {
    customer: f.actors.customer.principalId,
    staff: f.actors.staff.principalId,
  };
  const cookies = new Map<keyof typeof actors, string>();
  for (const [index, actor] of (
    Object.keys(actors) as (keyof typeof actors)[]
  ).entries()) {
    const principalId = actors[actor];
    await identity.identity.provisionVerifiedUser({
      principalId,
      email: actor + '@example.test',
    });
    const sessionId = String(index + 1).repeat(43);
    await identity.sessions.create(sessionId, {
      principalId,
      data: JSON.stringify({
        version: 1,
        csrfToken: csrf,
        issuer: IDENTITY_ISSUER,
        subject: principalId,
      }),
    });
    cookies.set(actor, SESSION_COOKIE + '=' + sessionId);
    if (actor === 'staff')
      for (const role of [SUPPORT_ROLE, KNOWLEDGE_ROLE])
        await support.roleStore.grantRoleAssignmentWithAudit({
          assignment: {
            id: 'root-learning-' + role,
            principalId,
            role,
            scope: APPLICATION_SCOPE,
            grantedBy: { kind: 'system', systemId: 'fictional-root' },
            grantedAtEpochMs: Date.now(),
            status: 'active',
          },
          auditEventId: 'root-learning-grant-' + role,
        });
  }
  let policyReady = true;
  const source: NonNullable<SupportLearningCompositionOptions['source']> = {
    serviceAccess: f.ports.serviceAccess,
    knowledgeAccess: f.ports.knowledgeAccess,
    retirementAccess: f.ports.retirementAccess,
    reviewPolicy: {
      resolvePolicy: (...args) =>
        policyReady
          ? f.ports.checks.resolvePolicy(...args)
          : Promise.resolve({ outcome: 'unavailable' as const }),
    },
  };
  const options: SupportLearningCompositionOptions = {
    source,
    readScheduling: 'sdk',
  };
  const env = environment();
  const calls = invocation();
  function request(
    path: string,
    body?: unknown,
    actor: keyof typeof actors = 'staff',
  ) {
    return new Request(IDENTITY_ISSUER + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Cookie: cookies.get(actor)!,
        Origin: IDENTITY_ISSUER,
        'Sec-Fetch-Site': 'same-origin',
        'X-Pegma-CSRF': csrf,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function call(worker: ReturnType<typeof createWorker>, input: Request) {
    const response = await worker.fetch(input, env, calls.context);
    await calls.drain();
    return response;
  }
  async function published() {
    // The actual collection policy deliberately uses this host's ordinary
    // article-read grant. No synthetic permission is added to a caller.
    const preview = await f.knowledge.previewCollectionPolicy(f.actors.admin, {
      collectionId: 'learning-guides',
      uses: {
        portal: {
          enabled: true,
          audience: {
            kind: 'permission',
            permission: knowledgePermissions.articleRead,
          },
        },
        bot: {
          enabled: true,
          audience: {
            kind: 'permission',
            permission: knowledgePermissions.articleRead,
          },
        },
      },
    });
    await f.knowledge.updateCollectionPolicy(f.actors.admin, {
      ...f.command('root-audience', preview.generation),
      collectionId: 'learning-guides',
      preview: preview.preview,
    });
    await f.enrollAndVerify();
    const target = await f.delivered();
    await f.review(target.articleId);
    await f.evidenceAndPublish(target.articleId);
    return target.articleId;
  }
  return {
    f,
    driverFixture,
    env,
    options,
    calls,
    request,
    call,
    published,
    identity,
    support,
    policyUnavailable() {
      policyReady = false;
    },
  };
}
async function processingOptions(t: Awaited<ReturnType<typeof rootFixture>>) {
  const f = t.f;
  const observed = await f.ports.configuration.resolve(
    undefined,
    new AbortController().signal,
  );
  if (observed.outcome !== 'ready' || t.driverFixture === undefined)
    throw new Error('Actual processing fixture required');
  const configuration = {
    ...structuredClone(observed.configuration),
    dataControls: {
      ...structuredClone(observed.configuration.dataControls),
      intermediaryRefs: ['fictional-root-intermediary'],
    },
  };
  const validUntil = configuration.dataControls.validUntil;
  const base: Omit<ApprovedSupportLearningRoute, 'approval'> = {
    host: 'pegma.dev',
    purpose: 'support_learning',
    endpoint: SUPPORT_LEARNING_ENDPOINT,
    endpointTag: 'fictional/learning-region',
    outputTokenParameter: 'max_tokens',
    credentialRef: 'fictional-root-model',
    usageScopeRef: 'synthetic-learning-only-usage',
    configuration,
  };
  const route: ApprovedSupportLearningRoute = {
    ...base,
    approval: {
      wireVersion: SUPPORT_LEARNING_WIRE_VERSION,
      configurationVersion: configuration.version,
      requestPolicySha256: await supportLearningRoutePolicySha256(base),
      evidenceRef: 'fictional-root-evidence',
      effectivePolicyRef: 'fictional-root-policy',
      evaluationRef: 'fictional-root-evaluation',
      responseIdentityRef: 'fictional-root-identity',
      tokenizerRef: 'fictional-root-tokenizer',
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
  const generate = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          id: 'gen-fictional-root',
          object: 'chat.completion',
          provider: configuration.provider,
          model: configuration.model,
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
        { headers: { 'Content-Type': 'application/json' } },
      ),
  );
  const readApiKey = vi.fn(() => 'FICTIONAL_ROOT_KEY');
  const checker = t.driverFixture.checker;
  const {
    store: _store,
    clock: _clock,
    application: _application,
    knowledge: _knowledge,
    knowledgeAccess: _access,
    ...checks
  } = checker!.configuration;
  const options: SupportLearningCompositionOptions = {
    ...t.options,
    independentChecks: checks,
    production: {
      intakeEnabled: true,
      enabled: () => true,
      configuration: {
        productContext: {
          resolve: async () => {
            const source = await f.application.readResolutionLearningSource(
              f.actors.staff,
              learningTicketId,
            );
            return source.product ?? null;
          },
        },
        serviceAccess: f.ports.serviceAccess,
        knowledgeAccess: f.ports.knowledgeAccess,
        retirementAccess: f.ports.retirementAccess,
        targets: f.ports.targets,
        model: {
          readRoute: () => route,
          allowlist: [
            {
              model: configuration.model,
              provider: configuration.provider,
              endpointTag: route.endpointTag,
              outputTokenParameter: route.outputTokenParameter,
            },
          ],
          counter: {
            count: (value) =>
              Math.ceil(new TextEncoder().encode(value).length / 4),
            qualification: {
              model: configuration.model,
              modelVersion: configuration.modelVersion,
              wireVersion: SUPPORT_LEARNING_WIRE_VERSION,
              framingTokens: configuration.framingTokens,
              evidenceRef: route.approval.tokenizerRef,
              verifiedAt: f.clock.now(),
              validUntil,
            },
          },
          readApiKey,
          fetch: generate,
        },
        usagePolicy: {
          version: 'fictional-root-learning-funding',
          scopeRef: route.usageScopeRef,
          configurationVersion: configuration.version,
          modelVersion: configuration.modelVersion,
          pricingRef: configuration.pricingRef,
          currency: 'USD',
          maxCostMicros: 100_000,
          maxReservationCostMicros: 10_000,
          maxReservations: 8,
          validFrom: f.clock.now(),
          validUntil,
          terminalRetentionMilliseconds: 60_000,
        },
      },
    },
  };
  return { options, generate, readApiKey, checker: checker! };
}

describe('normal root learning composition', () => {
  it('keeps absent/OFF learning and disabled KB entries before optional ports and D1', async () => {
    const graph = vi.spyOn(
      learningComposition,
      'createSupportLearningComposition',
    );
    const env = environment();
    Reflect.set(env, 'PEGMA_KNOWLEDGE_ENABLED', 'false');
    Reflect.set(env, 'IDENTITY_DB', undefined);
    const calls = invocation();
    const worker = createWorker();
    expect(
      (
        await worker.fetch(
          new Request(IDENTITY_ISSUER + '/api/knowledge/portal'),
          env,
          calls.context,
        )
      ).status,
    ).toBe(503);
    const incoming = delivery();
    await worker.queue(incoming.batch, env, calls.context);
    expect(incoming.message.ack).toHaveBeenCalled();
    expect(graph).not.toHaveBeenCalled();
    expect(d1.createCloudflareD1Store).not.toHaveBeenCalled();
  });

  it('preserves actual ordinary human creation when all learning inputs are absent', async () => {
    const t = await rootFixture();
    const graph = vi.spyOn(
      learningComposition,
      'createSupportLearningComposition',
    );
    const response = await t.call(
      createWorker(),
      t.request(
        '/api/support/tickets',
        {
          subject: 'Fictional normal root question',
          body: 'How do I export?',
          category: 'question',
        },
        'customer',
      ),
    );
    expect(response.status).toBe(201);
    expect(await response.text()).not.toContain(learningCanary);
    expect(graph).not.toHaveBeenCalled();
  });

  it('serves a real published learned article with generation OFF and hides it after an ordinary reopen', async () => {
    const t = await rootFixture();
    const articleId = await t.published();
    const runtimes = vi.spyOn(supportDesk, 'createSupportRuntime');
    const graphs = vi.spyOn(
      learningComposition,
      'createSupportLearningComposition',
    );
    const checkers = vi.spyOn(
      independentChecks,
      'createSupportIndependentChecks',
    );
    const worker = createWorker({ learning: t.options });
    const read = () =>
      t.call(
        worker,
        t.request(
          '/api/knowledge/portal',
          {
            operation: 'getPublishedArticle',
            input: { articleId },
          },
          'customer',
        ),
      );
    const result = await read();
    expect(result.status).toBe(200);
    expect(await result.text()).not.toContain(learningCanary);
    const graph = graphs.mock.results.at(-1)?.value;
    const runtime = runtimes.mock.results.at(-1)?.value;
    expect(graph?.ready()).toBe(true);
    expect(graph?.processingEnabled()).toBe(false);
    expect(graph?.browserRuntime()?.application).toBe(runtime?.application);
    expect(runtimes.mock.calls.at(-1)?.[0].resolutionLearning).toBe(
      graph?.application,
    );
    expect(graph?.retrievalOptions()?.store).toBe(t.f.store);
    expect(graph?.retrievalOptions()?.privateSources).toBe(graph?.sources);
    expect(checkers).not.toHaveBeenCalled();
    expect(
      (
        await t.call(
          worker,
          t.request(
            '/api/support/tickets/' + learningTicketId + '/replies',
            { body: 'The fictional export needs another look.' },
            'customer',
          ),
        )
      ).status,
    ).toBe(201);
    const unavailable = await read();
    expect(unavailable.status).toBe(404);
    expect(await unavailable.text()).not.toContain(learningCanary);
  });

  it('isolates invalid learning application limits from ordinary human intake and preserves source-only KB reopen guards', async () => {
    const t = await rootFixture();
    const articleId = await t.published();
    const observed = await t.f.ports.configuration.resolve(
      undefined,
      new AbortController().signal,
    );
    if (observed.outcome !== 'ready')
      throw new Error('Actual fixture configuration required');
    const config = observed.configuration;
    const validUntil = config.dataControls.validUntil;
    const keyReads = vi.fn(() => undefined);
    const modelCalls = vi.fn(async (): Promise<Response> => {
      throw new Error('Generation must stay OFF');
    });
    const source = await t.f.application.readResolutionLearningSource(
      t.f.actors.staff,
      learningTicketId,
    );
    const learning: SupportLearningCompositionOptions = {
      ...t.options,
      production: {
        intakeEnabled: true,
        enabled: () => false,
        configuration: {
          // The real released App accepts at most 300000ms; the host factory's
          // supported numeric option must not take down ordinary first messages.
          application: { maxLeaseMilliseconds: 300_001 },
          productContext: { resolve: async () => source.product ?? null },
          serviceAccess: t.f.ports.serviceAccess,
          knowledgeAccess: t.f.ports.knowledgeAccess,
          retirementAccess: t.f.ports.retirementAccess,
          targets: t.f.ports.targets,
          model: {
            readRoute: () => undefined,
            allowlist: [
              {
                model: config.model,
                provider: config.provider,
                endpointTag: 'fictional/learning',
                outputTokenParameter: 'max_tokens',
              },
            ],
            counter: {
              count: (value) => value.length,
              qualification: {
                model: config.model,
                modelVersion: config.modelVersion,
                wireVersion: SUPPORT_LEARNING_WIRE_VERSION,
                framingTokens: config.framingTokens,
                evidenceRef: 'fictional-root-tokenizer',
                verifiedAt: t.f.clock.now(),
                validUntil,
              },
            },
            readApiKey: keyReads,
            fetch: modelCalls,
          },
          usagePolicy: {
            version: 'fictional-root-invalid-limit-funding',
            scopeRef: 'synthetic-learning-only-usage',
            configurationVersion: config.version,
            modelVersion: config.modelVersion,
            pricingRef: config.pricingRef,
            currency: 'USD',
            maxCostMicros: 100_000,
            maxReservationCostMicros: 10_000,
            maxReservations: 8,
            validFrom: t.f.clock.now(),
            validUntil,
            terminalRetentionMilliseconds: 60_000,
          },
        },
      },
      independentChecks: {
        authority: t.f.ports.serviceAccess,
        enabled: () => false,
        readApiKey: keyReads,
        fetch: modelCalls,
      },
    };
    Reflect.set(t.env, 'PEGMA_SUPPORT_LEARNING_INTAKE_ENABLED', 'true');
    const runtimes = vi.spyOn(supportDesk, 'createSupportRuntime');
    const graphs = vi.spyOn(
      learningComposition,
      'createSupportLearningComposition',
    );
    const worker = createWorker({ learning });
    const created = await t.call(
      worker,
      t.request(
        '/api/support/tickets',
        {
          subject:
            'Fictional first human question with invalid optional learning',
          body: 'How do I export?',
          category: 'question',
        },
        'customer',
      ),
    );
    expect(created.status).toBe(201);
    const createdView = (await created.json()) as { ticket: { id: string } };
    expect(runtimes.mock.results.some((entry) => entry.type === 'throw')).toBe(
      true,
    );
    expect(runtimes.mock.calls.at(-1)?.[0].resolutionLearning).toBeUndefined();
    expect(
      graphs.mock.results.at(-1)?.value?.browserRuntime()?.application,
    ).toBe(runtimes.mock.results.at(-1)?.value?.application);
    const detail = await t.call(
      worker,
      t.request('/api/support/admin/tickets/' + createdView.ticket.id),
    );
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ learningEnabled: false });
    const read = () =>
      t.call(
        worker,
        t.request(
          '/api/knowledge/portal',
          {
            operation: 'getPublishedArticle',
            input: { articleId },
          },
          'customer',
        ),
      );
    expect((await read()).status).toBe(200);
    expect(
      (
        await t.call(
          worker,
          t.request(
            '/api/support/tickets/' + learningTicketId + '/replies',
            {
              body: 'The fictional solution needs another look.',
            },
            'customer',
          ),
        )
      ).status,
    ).toBe(201);
    expect((await read()).status).toBe(404);
    expect(keyReads).not.toHaveBeenCalled();
    expect(modelCalls).not.toHaveBeenCalled();
    // A real base Store failure still refuses intake after the bounded retry.
    const unavailable: Store = {
      collection(definition) {
        if (definition.name === supportRecords.name)
          throw new Error('Fictional Support Store unavailable');
        return t.f.store.collection(definition);
      },
    };
    vi.mocked(d1.createCloudflareD1Store).mockReturnValue(unavailable);
    const failed = await t.call(
      worker,
      t.request(
        '/api/support/tickets',
        {
          subject: 'Fictional unavailable base',
          body: 'Export question.',
          category: 'question',
        },
        'customer',
      ),
    );
    expect(failed.status).toBe(503);
  });

  it('honors current source review-policy revocation while route/key and worker flags are absent', async () => {
    const t = await rootFixture();
    const articleId = await t.published();
    const worker = createWorker({ learning: t.options });
    const read = () =>
      t.call(
        worker,
        t.request(
          '/api/knowledge/portal',
          { operation: 'getPublishedArticle', input: { articleId } },
          'customer',
        ),
      );
    expect((await read()).status).toBe(200);
    t.policyUnavailable();
    expect((await read()).status).toBe(404);
  });

  it('refuses an explicitly malformed source graph without an unverified KB fallback or breaking ordinary Support', async () => {
    const t = await rootFixture();
    const malformed = { ...t.options, source: { ...t.options.source! } };
    Reflect.set(malformed.source, 'reviewPolicy', {});
    const worker = createWorker({ learning: malformed });
    const denied = await t.call(
      worker,
      t.request(
        '/api/knowledge/portal',
        { operation: 'listPortalCollections', input: {} },
        'customer',
      ),
    );
    expect(denied.status).toBe(503);
    const created = await t.call(
      worker,
      t.request(
        '/api/support/tickets',
        {
          subject: 'Fictional healthy human question',
          body: 'Export question.',
          category: 'question',
        },
        'customer',
      ),
    );
    expect(created.status).toBe(201);
  });

  it('retains explicit KB failure when a selected trusted configuration getter throws', async () => {
    const t = await rootFixture();
    Object.defineProperty(t.options, 'production', {
      get() {
        throw new Error('Fictional unavailable configuration');
      },
    });
    const worker = createWorker({ learning: t.options });
    const denied = await t.call(
      worker,
      t.request(
        '/api/knowledge/portal',
        { operation: 'listPortalCollections', input: {} },
        'customer',
      ),
    );
    expect(denied.status).toBe(503);
    expect(await denied.json()).toEqual({ error: 'knowledge_unavailable' });
  });

  it('shares the selected source verifier with the actual answering composition while customer AI stays OFF', async () => {
    const t = await rootFixture();
    const answer = await supportAnsweringFixture(createMemoryStore());
    const compositions = vi.spyOn(
      answeringComposition,
      'composeSupportAnswering',
    );
    const graphs = vi.spyOn(
      learningComposition,
      'createSupportLearningComposition',
    );
    const worker = createWorker({
      learning: t.options,
      answering: answer.composition,
    });
    // The endpoint uses normal login requirements after constructing the exact
    // shared graph. No provider admission or paid turn is requested.
    expect(
      (
        await worker.fetch(
          new Request(IDENTITY_ISSUER + '/api/support/categories'),
          t.env,
          t.calls.context,
        )
      ).status,
    ).toBe(401);
    const graph = graphs.mock.results.at(-1)?.value;
    expect(graph?.ready()).toBe(true);
    expect(
      compositions.mock.calls.at(-1)?.[2].configuration?.privateSources,
    ).toBe(graph?.sources);
    expect(answer.state.calls).toBe(0);
    expect(answer.state.keys).toBe(0);
  });

  it('independently gates the normal human learning surface and retains fresh stored staff checks', async () => {
    const t = await rootFixture();
    await t.f.enrollAndVerify();
    const worker = createWorker({ learning: t.options });
    const read = () =>
      t.call(
        worker,
        t.request(
          '/api/support/admin/tickets/' + learningTicketId + '/learning',
        ),
      );
    expect((await read()).status).toBe(404);
    Reflect.set(t.env, 'PEGMA_SUPPORT_LEARNING_INTAKE_ENABLED', 'true');
    expect((await read()).status).toBe(200);
    const row = await t.support.roleStore.getRoleAssignment(
      'root-learning-Support',
    );
    if (row === null) throw new Error('Actual staff assignment required');
    await t.support.roleStore.revokeRoleAssignmentWithAudit({
      assignmentId: 'root-learning-Support',
      expectedConcurrencyToken: row.concurrencyToken,
      revokedBy: { kind: 'system', systemId: 'fictional-root' },
      revokedAtEpochMs: Date.now(),
      auditEventId: 'root-learning-revoke',
    });
    expect((await read()).status).toBe(403);
  });

  it('keeps configured worker OFF before graph/key/store construction and reuses the existing queue domain', async () => {
    const t = await rootFixture();
    const graphs = vi.spyOn(
      learningComposition,
      'createSupportLearningComposition',
    );
    const worker = createWorker({ learning: t.options });
    const callsBefore = vi.mocked(d1.createCloudflareD1Store).mock.calls.length;
    const incoming = delivery();
    await worker.queue(incoming.batch, t.env, t.calls.context);
    expect(incoming.message.ack).toHaveBeenCalled();
    expect(graphs).not.toHaveBeenCalled();
    expect(vi.mocked(d1.createCloudflareD1Store).mock.calls.length).toBe(
      callsBefore,
    );
    Reflect.set(t.env, 'PEGMA_SUPPORT_LEARNING_WORKER_ENABLED', 'true');
    const sent = vi.fn(async () => undefined);
    Reflect.set(t.env, 'SUPPORT_ENGINEERING_JOBS', { send: sent });
    const base = Date.parse(now);
    const time = Array.from({ length: 60 }, (_, i) => base + i * 60_000).find(
      (v) => cleanupLaneAt(v).kind === 'support',
    )!;
    await worker.scheduled(
      scheduled(CLEANUP_CRON, time),
      t.env,
      t.calls.context,
    );
    await t.calls.drain();
    expect(sent).toHaveBeenCalledWith(
      { version: 1, kind: 'support-learning-wake' },
      { contentType: 'json' },
    );
  });

  it('runs one real queue phase per invocation and durably defers checks before a later checker invocation', async () => {
    const t = await rootFixture(true);
    const p = await processingOptions(t);
    Reflect.set(t.env, 'PEGMA_SUPPORT_LEARNING_WORKER_ENABLED', 'true');
    const originalDriver = learningDriver.createSupportLearningDriver;
    const phases: unknown[] = [];
    const drivers = vi
      .spyOn(learningDriver, 'createSupportLearningDriver')
      .mockImplementation((options) => {
        const actual = originalDriver(options);
        return {
          ...actual,
          async runTick() {
            const result = await actual.runTick();
            if (phases.length < 6) phases.push(result);
            return result;
          },
        };
      });
    const checkers = vi.spyOn(
      independentChecks,
      'createSupportIndependentChecks',
    );
    const runtimes = vi.spyOn(supportDesk, 'createSupportRuntime');
    const graphs = vi.spyOn(
      learningComposition,
      'createSupportLearningComposition',
    );
    const worker = createWorker({ learning: p.options });
    // The released App's enabled option also gates claiming existing work.
    // Worker-only activation must therefore remain nonpaid until intake is enabled.
    for (let i = 0; i < 2; i++)
      await worker.queue(delivery().batch, t.env, t.calls.context);
    expect(p.generate).not.toHaveBeenCalled();
    Reflect.set(t.env, 'PEGMA_SUPPORT_LEARNING_INTAKE_ENABLED', 'true');
    let deferred = false;
    for (let i = 0; i < 200 && !deferred; i++) {
      const incoming = delivery();
      await worker.queue(incoming.batch, t.env, t.calls.context);
      const head = await t.driverFixture!.hint();
      deferred = String(head?.payload).includes('"kind":"checks"');
      if (!deferred) expect(p.checker.state.calls).toBe(0);
    }
    expect(deferred, JSON.stringify(phases)).toBe(true);
    expect(p.generate).toHaveBeenCalledTimes(1);
    expect(p.checker.state.calls).toBe(0);
    const instance = drivers.mock.results.at(-1)?.value;
    expect(instance).toBeDefined();
    const graphInputs = checkers.mock.calls.at(-1)?.[0];
    expect(graphInputs?.store).toBe(t.f.store);
    expect(graphInputs?.knowledge).toBe(
      graphs.mock.results.at(-1)?.value?.browserRuntime()?.knowledge,
    );
    expect(graphInputs?.application()).toBe(
      runtimes.mock.results.at(-1)?.value?.application,
    );
    expect(checkers.mock.calls.length).toBe(drivers.mock.calls.length);
    const next = delivery();
    await worker.queue(next.batch, t.env, t.calls.context);
    expect(p.checker.state.calls).toBe(1);
    expect(p.generate).toHaveBeenCalledTimes(1);
    Reflect.set(t.env, 'PEGMA_SUPPORT_LEARNING_WORKER_ENABLED', 'false');
    const disabled = delivery();
    await worker.queue(disabled.batch, t.env, t.calls.context);
    expect(disabled.message.ack).toHaveBeenCalled();
    expect(p.checker.state.calls).toBe(1);
  });

  it('passes the same source verifier into normal ready and maintenance lanes with generation OFF', async () => {
    const t = await rootFixture();
    const ready = vi.spyOn(retrievalReady, 'createKnowledgeRetrievalReady');
    const maintenance = vi.spyOn(
      retrievalMaintenance,
      'createKnowledgeRetrievalMaintenance',
    );
    const graphs = vi.spyOn(
      learningComposition,
      'createSupportLearningComposition',
    );
    const worker = createWorker({ learning: t.options });
    const start = Date.parse(now);
    const rate = Array.from({ length: 58 }, (_, i) => start + i * 60_000).find(
      (v) => rateKnowledgeLaneAt(v) === 'retrieval_ready',
    )!;
    await worker.scheduled(
      scheduled(RATE_LIMIT_CRON, rate),
      t.env,
      t.calls.context,
    );
    await t.calls.drain();
    const first = graphs.mock.results.at(-1)?.value;
    expect(ready.mock.calls.at(-1)?.[0].privateSources).toBe(first?.sources);
    expect(ready.mock.calls.at(-1)?.[0].store).toBe(t.f.store);
    const clean = Array.from({ length: 60 }, (_, i) => start + i * 60_000).find(
      (v) => cleanupLaneAt(v).kind === 'knowledge',
    )!;
    await worker.scheduled(
      scheduled(CLEANUP_CRON, clean),
      t.env,
      t.calls.context,
    );
    await t.calls.drain();
    const second = graphs.mock.results.at(-1)?.value;
    expect(maintenance.mock.calls.at(-1)?.[0].privateSources).toBe(
      second?.sources,
    );
    expect(maintenance.mock.calls.at(-1)?.[0].store).toBe(t.f.store);
    Reflect.set(t.env, 'PEGMA_SUPPORT_ASSISTANT_ENABLED', 'true');
    const alternate = Array.from(
      { length: 60 },
      (_, i) => start + i * 60_000,
    ).find((v) => cleanupLaneAt(v, true).kind === 'knowledge_ready')!;
    await worker.scheduled(
      scheduled(CLEANUP_CRON, alternate),
      t.env,
      t.calls.context,
    );
    await t.calls.drain();
    expect(ready.mock.calls.at(-1)?.[0].privateSources).toBe(
      graphs.mock.results.at(-1)?.value?.sources,
    );
    expect(ready.mock.calls.at(-1)?.[0].store).toBe(t.f.store);
  });

  it('retains the ordinary projection-only constructor when no learning source is configured', async () => {
    const t = await rootFixture();
    const identity = vi.spyOn(
      identityRuntime,
      'createProductionIdentityRuntime',
    );
    const ready = vi.spyOn(retrievalReady, 'createKnowledgeRetrievalReady');
    const start = Date.parse(now);
    const time = Array.from({ length: 58 }, (_, i) => start + i * 60_000).find(
      (v) => rateKnowledgeLaneAt(v) === 'retrieval_ready',
    )!;
    await createWorker().scheduled(
      scheduled(RATE_LIMIT_CRON, time),
      t.env,
      t.calls.context,
    );
    await t.calls.drain();
    expect(ready.mock.calls.at(-1)?.[0].store).toBe(t.f.store);
    expect(ready.mock.calls.at(-1)?.[0].privateSources).toBeUndefined();
    expect(identity).not.toHaveBeenCalled();
  });
});
