import { resolveAccess, type AccessContext } from '@pegma/authorization-core';
import { createAgentPrincipalResolver } from './agent-authority';
import { createKnowledgeEvidenceService } from './knowledge-evidence';
import type { ResolutionProductContextPort } from '@pegma/support-desk-application';
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
import { SUPPORT_LEARNING_SOURCE_SETTING, type SupportLearningSourceConfiguration } from './support-learning-bootstrap';
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

async function testEvidenceRootFixture(useDefaultBootstrap = false) {
  const t = await rootFixture();
  const resolve = createAgentPrincipalResolver(t.support);
  const reporterId = t.f.actors.runner.principalId;
  await t.identity.identity.provisionVerifiedUser({
    principalId: reporterId,
    email: "reporter@example.test",
  });
  await t.support.roleStore.grantRoleAssignmentWithAudit({
    assignment: {
      id: "root-reporting-knowledge",
      principalId: reporterId,
      role: KNOWLEDGE_ROLE,
      scope: APPLICATION_SCOPE,
      grantedBy: { kind: "system", systemId: "fictional-root-test" },
      grantedAtEpochMs: Date.now(),
      status: "active",
    },
    auditEventId: "root-reporting-knowledge-grant",
  });
  const staff = await resolve(t.f.actors.staff.principalId);
  const reporter = await resolve(reporterId);
  if (staff === null || reporter === null)
    throw new Error("Actual root principals missing");
  const reports = createKnowledgeEvidenceService({
    store: t.f.store,
    clock: t.f.clock,
    resolvePrincipal: resolve,
    authoringContext: t.f.knowledge,
    async readContext(access, articleId) {
      return (
        await t.f.knowledge.getAuthoringContext(access, {
          articleId,
          includeEvidence: true,
        })
      ).context;
    },
  });
  const articleId = "registered-test-report-guide";
  const collectionId = "learning-guides";
  await t.f.knowledge.createDraft(t.f.actors.admin, {
    ...t.f.command("registered-test-draft"),
    articleId,
    collectionId,
    draft: {
      kind: "explanation",
      title: "Fictional export test",
      summary: "Controlled public SDK test.",
      content: {
        format: "plain_text",
        text: "Export the fictional workspace.",
      },
      tags: ["synthetic"],
      applicability: t.f.product,
    },
  });
  const draft = await t.f.knowledge.getDraft(staff, { articleId });
  const requirements = await t.f.knowledge.getValidationRequirements(staff, {
    collectionId,
    kind: draft.revision.kind,
  });
  const check = requirements.checks[0];
  if (check === undefined) throw new Error("Actual test requirement missing");
  const reported = await reports.report(reporter, {
    commandId: "registered-root-report",
    articleId,
    ledgerEpoch: 1,
    evidence: {
      id: "registered-root-test-evidence",
      articleId,
      articleRevision: draft.revision.number,
      contentHash: draft.revision.contentHash,
      validationPolicy: draft.revision.validationPolicy,
      checkId: check.id,
      testKind: check.testKind,
      applicability: draft.revision.applicability,
      stagingBuildId: requirements.expectedStagingBuildId,
      steps: ["Export the fictional workspace."],
      result: "passed",
      executedAt: t.f.clock.now(),
      runnerId: reporterId,
      artifacts: [],
    },
    report: {
      summary: "The fictional export passed",
      details: "FICTIONAL_PRIVATE_REPORT_DETAILS",
    },
  });
  const key = {
    articleId,
    ledgerEpoch: reported.ledgerEpoch,
    reportId: reported.reportId,
  };
  const observed = await reports.read(staff, key);
  await reports.decide(
    staff,
    {
      ...key,
      commandId: "registered-root-confirm",
      expectedReportGeneration: observed.reportGeneration,
      reviewBindingHash: observed.reviewBindingHash,
    },
    "confirmed",
  );
  const report = await reports.read(staff, key);
  const productContext: ResolutionProductContextPort = {
    async resolve(context) {
      return {
        productId: t.f.product.productId,
        version: t.f.product.productVersion,
        buildId: t.f.product.buildId,
        binding: "registered-root-product-v1",
        contextVersion: "registered-root-context-v1",
        receiptId: "registered-root-product",
        verifiedAt: context.acceptedAt,
        validUntil: new Date(
          Date.parse(context.acceptedAt) + 60_000,
        ).toISOString(),
      };
    },
  };
  const access = resolveAccess(
    { principalId: "fictional-intrinsic-governance", roles: ["reader"] },
    {
      version: "fictional-governance-service-v1",
      roles: { reader: [knowledgePermissions.validationManage] },
    },
  );
  const hooks = {
    beforeGovernance: undefined as (() => Promise<void>) | undefined,
  };
  const governance = vi.fn(
    async (selectedCollection: string, signal: AbortSignal) => {
      await hooks.beforeGovernance?.();
      if (signal.aborted || selectedCollection !== collectionId) return null;
      return { access, authorityVersion: "fictional-governance-authority-v1" };
    },
  );
  const options = {
    ...t.options,
    intake: { enabled: true, productContext },
    testEvidence: {
      retentionMilliseconds: 120_000,
      governanceAccess: { resolve: governance },
    },
  };
  Reflect.set(t.env, "PEGMA_SUPPORT_LEARNING_INTAKE_ENABLED", "true");
  if (useDefaultBootstrap) {
    Reflect.set(t.env, SUPPORT_LEARNING_SOURCE_SETTING, sourceConfiguration(t, {
      testEvidence: { retentionMilliseconds: 120_000 },
    }));
  }
  const worker = useDefaultBootstrap ? createWorker() : createWorker({ learning: options });
  const ticket = await t.f.terminal();
  const enrolled = await t.call(
    worker,
    t.request(
      "/api/support/admin/tickets/" + learningTicketId + "/learning/enroll",
      {
        commandId: "REGISTERED-TEST-ENROLL",
        expectedRevision: ticket.revision,
      },
    ),
  );
  expect(enrolled.status).toBe(200);
  const source = (await enrolled.json()) as {
    result: { resolutionCycle: number };
  };
  const packet = {
    commandId: "REGISTERED-TEST-PREPARE",
    expectedPrincipalId: staff.principalId,
    expectedRevision: ticket.revision,
    resolutionCycle: source.result.resolutionCycle,
    solutionMessageId: "learning-solution",
    report: {
      ...key,
      expectedReportGeneration: report.reportGeneration,
      reviewBindingHash: report.reviewBindingHash,
      receipt: report.receipt,
    },
  };
  const path =
    "/api/support/admin/tickets/" + learningTicketId + "/learning/test-receipt";
  return {
    ...t,
    reports,
    key,
    staff,
    reporter,
    options,
    worker,
    packet,
    path,
    hooks,
    governance,
  };
}

describe("registered staff test association", () => {
  it("prepares for different staff from a confirmed report before KB evidence acceptance and replays its lost ACK", async () => {
    const t = await testEvidenceRootFixture();
    expect(t.reporter.principalId).not.toBe(t.staff.principalId);
    expect(
      (
        await t.f.knowledge.getEvidence(t.staff, {
          articleId: t.packet.report.articleId,
        })
      ).evidence,
    ).toEqual([]);
    const first = await t.call(t.worker, t.request(t.path, t.packet));
    expect(first.status).toBe(200);
    const acknowledged = (await first.json()) as {
      result: {
        actorId: string;
        ticketId: string;
        commandId: string;
        receipt: string;
        validUntil: string;
      };
    };
    expect(Object.keys(acknowledged.result).sort()).toEqual(
      ["actorId", "ticketId", "commandId", "receipt", "validUntil"].sort(),
    );
    expect(acknowledged.result).toMatchObject({
      actorId: t.staff.principalId,
      ticketId: learningTicketId,
      commandId: t.packet.commandId,
    });
    expect(acknowledged.result.receipt.length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(acknowledged)).not.toContain(
      "FICTIONAL_PRIVATE_REPORT_DETAILS",
    );
    const retry = await t.call(t.worker, t.request(t.path, t.packet));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(acknowledged);
    const view = await t.call(
      t.worker,
      t.request("/api/support/admin/tickets/" + learningTicketId),
    );
    expect(await view.json()).toMatchObject({
      learningTestReceiptEnabled: true,
    });
  });

  it("keeps original SDK evidence ACK recovery after the preparation configuration and KB flag are removed", async () => {
    const t = await testEvidenceRootFixture();
    const response = await t.call(t.worker, t.request(t.path, t.packet));
    expect(response.status).toBe(200);
    const prepared = (await response.json()) as { result: { receipt: string } };
    const evidence = {
      kind: "successful_test",
      commandId: "REGISTERED-EVIDENCE-EXACT",
      expectedRevision: t.packet.expectedRevision,
      resolutionCycle: t.packet.resolutionCycle,
      solutionMessageId: t.packet.solutionMessageId,
      receipt: prepared.result.receipt,
    };
    const path =
      "/api/support/admin/tickets/" + learningTicketId + "/learning/evidence";
    const accepted = await t.call(t.worker, t.request(path, evidence));
    expect(accepted.status).toBe(200);
    const ack = await accepted.json();
    const before = await t.f.rows();
    const { testEvidence: omitted, ...withoutPreparation } = t.options;
    expect(omitted).toBeDefined();
    Reflect.set(t.env, "PEGMA_KNOWLEDGE_ENABLED", "false");
    const changed = createWorker({ learning: withoutPreparation });
    const recovered = await t.call(
      changed,
      t.request(path + "-recovery", evidence),
    );
    expect(recovered.status).toBe(200);
    const result = (await recovered.json()) as {
      result: { outcome: string; result: unknown };
    };
    expect(result.result).toMatchObject({
      outcome: "accepted",
      result: (ack as { result: unknown }).result,
    });
    expect(await t.f.rows()).toEqual(before);
  });

  it.each(["cookie", "role"] as const)(
    "closes actual %s loss during preparation without a link ACK",
    async (kind) => {
      const t = await testEvidenceRootFixture();
      t.hooks.beforeGovernance = async () => {
        t.hooks.beforeGovernance = undefined;
        if (kind === "cookie")
          await t.identity.sessions.destroy("2".repeat(43));
        else {
          const role = await t.support.roleStore.getRoleAssignment(
            "root-learning-" + KNOWLEDGE_ROLE,
          );
          if (role === null) throw new Error("Actual role absent");
          await t.support.roleStore.revokeRoleAssignmentWithAudit({
            assignmentId: "root-learning-" + KNOWLEDGE_ROLE,
            expectedConcurrencyToken: role.concurrencyToken,
            revokedBy: { kind: "system", systemId: "fictional-root" },
            revokedAtEpochMs: Date.now(),
            auditEventId: "root-test-receipt-revoke",
          });
        }
      };
      const response = await t.call(t.worker, t.request(t.path, t.packet));
      expect(response.status).toBe(kind === "cookie" ? 401 : 403);
      expect(await response.json()).not.toHaveProperty("result");
    },
  );

  it("rejects an actor-mismatched preparation packet and keeps OFF inputs before the governance port", async () => {
    const t = await testEvidenceRootFixture();
    const wrong = await t.call(
      t.worker,
      t.request(t.path, {
        ...t.packet,
        expectedPrincipalId: "another-account",
      }),
    );
    expect(wrong.status).toBe(403);
    expect(t.governance).not.toHaveBeenCalled();
    Reflect.set(t.env, "PEGMA_SUPPORT_LEARNING_INTAKE_ENABLED", "false");
    const off = await t.call(t.worker, t.request(t.path, t.packet));
    expect(off.status).toBe(404);
    expect(t.governance).not.toHaveBeenCalled();
  });

  it("uses the normal method, cookie, Origin, CSRF and closed-packet guards", async () => {
    const t = await testEvidenceRootFixture();
    const valid = t.request(t.path, t.packet);
    const wrongMethod = await t.call(t.worker, t.request(t.path));
    expect(wrongMethod.status).toBe(405);
    for (const [header, value, expected] of [
      ["Origin", "https://outside.example.test", 403],
      ["X-Pegma-CSRF", "not-the-session-token", 403],
      ["Cookie", "", 401],
    ] as const) {
      const headers = new Headers(valid.headers);
      headers.set(header, value);
      const response = await t.call(
        t.worker,
        new Request(valid.url, {
          method: "POST",
          headers,
          body: JSON.stringify(t.packet),
        }),
      );
      expect(response.status).toBe(expected);
    }
    const extraField = await t.call(
      t.worker,
      t.request(t.path, { ...t.packet, unexpected: true }),
    );
    expect(extraField.status).toBe(400);
    expect(t.governance).not.toHaveBeenCalled();
  });

  it("closes a changed intrinsic governance version even when its resolver reuses a record", async () => {
    const t = await testEvidenceRootFixture();
    const resolve = t.governance.getMockImplementation();
    if (resolve === undefined)
      throw new Error("Actual governance resolver missing");
    let observation:
      { access: AccessContext; authorityVersion: string } | undefined;
    t.governance.mockImplementation(async (collectionId, signal) => {
      const value = await resolve(collectionId, signal);
      if (value === null) return null;
      if (observation === undefined) observation = { ...value };
      else observation.authorityVersion = "fictional-governance-authority-v2";
      return observation;
    });
    const response = await t.call(t.worker, t.request(t.path, t.packet));
    expect(response.status).toBe(503);
    expect(await response.json()).not.toHaveProperty("result");
  });

  it("does not attach a malformed optional bridge and keeps ordinary intake usable", async () => {
    const t = await testEvidenceRootFixture();
    const malformed = createWorker({
      learning: {
        ...t.options,
        testEvidence: { ...t.options.testEvidence, retentionMilliseconds: -1 },
      },
    });
    const response = await t.call(malformed, t.request(t.path, t.packet));
    expect(response.status).toBe(503);
    const source = await t.call(
      malformed,
      t.request("/api/support/admin/tickets/" + learningTicketId + "/learning"),
    );
    expect(source.status).toBe(200);
  });
});

function sourceConfiguration(
  t: Awaited<ReturnType<typeof rootFixture>>,
  change: Partial<SupportLearningSourceConfiguration> = {},
) {
  return JSON.stringify({
    version: 1,
    revision: 'registered-source-v1',
    namespace: 'registered-source',
    intakeEnabled: true,
    product: {
      productId: t.f.product.productId,
      version: t.f.product.productVersion,
      buildId: t.f.product.buildId,
    },
    collectionIds: ['learning-guides'],
    ...change,
  });
}
function selectDefaultSource(
  t: Awaited<ReturnType<typeof rootFixture>>,
  change: Partial<SupportLearningSourceConfiguration> = {},
) {
  Reflect.set(
    t.env,
    SUPPORT_LEARNING_SOURCE_SETTING,
    sourceConfiguration(t, change),
  );
  Reflect.set(t.env, 'PEGMA_SUPPORT_LEARNING_INTAKE_ENABLED', 'true');
}

describe('default Source bootstrap', () => {
  it('uses the registered default worker to accept real human evidence into eligible Work without a model or extra graph', async () => {
    const t = await rootFixture();
    selectDefaultSource(t);
    const ticket = await t.f.terminal();
    const runtimes = vi.spyOn(supportDesk, 'createSupportRuntime');
    const graphs = vi.spyOn(
      learningComposition,
      'createSupportLearningComposition',
    );
    const checkers = vi.spyOn(
      independentChecks,
      'createSupportIndependentChecks',
    );
    const worker = createWorker();
    const enroll = await t.call(
      worker,
      t.request(
        '/api/support/admin/tickets/' + learningTicketId + '/learning/enroll',
        {
          commandId: 'DEFAULT-SOURCE-ENROLL',
          expectedRevision: ticket.revision,
        },
      ),
    );
    expect(enroll.status).toBe(200);
    const enrolled = (await enroll.json()) as {
      result: { resolutionCycle: number };
    };
    expect(graphs).toHaveBeenCalledTimes(1);
    expect(runtimes).toHaveBeenCalledTimes(1);
    const graph = graphs.mock.results.at(-1)?.value;
    expect(graph?.browserRuntime()?.application).toBe(
      runtimes.mock.results.at(-1)?.value.application,
    );
    expect(graph?.browserRuntime()?.knowledge).toBeDefined();
    expect(graph?.browserRuntime()?.sources).toBe(graph?.sources);
    const evidence = await t.call(
      worker,
      t.request(
        '/api/support/admin/tickets/' + learningTicketId + '/learning/evidence',
        {
          commandId: 'DEFAULT-SOURCE-EVIDENCE',
          expectedRevision: ticket.revision,
          resolutionCycle: enrolled.result.resolutionCycle,
          solutionMessageId: 'learning-solution',
          verificationReference: 'SYNTHETIC_PRIVATE_VERIFICATION',
        },
      ),
    );
    expect(evidence.status).toBe(200);
    const source = await t.f.application.readResolutionLearningSource(
      t.f.actors.staff,
      learningTicketId,
    );
    expect(source.state).toBe('eligible');
    expect(
      (
        await t.f.application.readResolutionLearningWork(t.f.actors.staff, {
          ticketId: learningTicketId,
          sourceGeneration: source.sourceGeneration,
        })
      ).status,
    ).toBe('pending');
    expect(t.f.state.modelCalls).toBe(0);
    expect(checkers).not.toHaveBeenCalled();
    expect(graphs.mock.results.at(-1)?.value.processingEnabled()).toBe(false);
  });

  it('keeps false intake Source-only and missing or invalid settings on the legacy graph', async () => {
    const t = await rootFixture();
    const ticket = await t.f.terminal();
    const graphs = vi.spyOn(
      learningComposition,
      'createSupportLearningComposition',
    );
    Reflect.set(t.env, 'PEGMA_SUPPORT_LEARNING_INTAKE_ENABLED', 'true');
    for (const raw of [undefined, '{"version":1,"permissions":["Admin"]}']) {
      Reflect.set(t.env, SUPPORT_LEARNING_SOURCE_SETTING, raw);
      const response = await t.call(
        createWorker(),
        t.request(
          '/api/support/admin/tickets/' + learningTicketId + '/learning',
        ),
      );
      expect(response.status).toBe(404);
      expect(graphs).not.toHaveBeenCalled();
    }
    selectDefaultSource(t, { intakeEnabled: false });
    const denied = await t.call(
      createWorker(),
      t.request(
        '/api/support/admin/tickets/' + learningTicketId + '/learning/enroll',
        {
          commandId: 'FALSE-SOURCE-ENROLL',
          expectedRevision: ticket.revision,
        },
      ),
    );
    expect(denied.status).toBe(409);
    expect(graphs.mock.results.at(-1)?.value.ready()).toBe(true);
    expect(
      (await t.f.rows()).some(
        (row) => row.kind === 'resolution_learning_source',
      ),
    ).toBe(false);
    expect(t.f.state.modelCalls).toBe(0);
  });

  it.each(['undefined', 'inherited', 'throwing', 'unready'] as const)(
    'preserves an explicit %s selection without environment-authority fallback',
    async (kind) => {
      const t = await rootFixture();
      selectDefaultSource(t);
      await t.f.terminal();
      const graphs = vi.spyOn(
        learningComposition,
        'createSupportLearningComposition',
      );
      const options: Parameters<typeof createWorker>[0] =
        kind === 'inherited'
          ? Object.create({ learning: undefined })
          : kind === 'unready'
            ? { learning: {} }
            : { learning: undefined };
      if (kind === 'throwing')
        Object.defineProperty(options, 'learning', {
          get() {
            throw new Error('Fictional explicit selection failure');
          },
        });
      const response = await t.call(
        createWorker(options),
        t.request(
          '/api/support/admin/tickets/' + learningTicketId + '/learning',
        ),
      );
      expect(response.status).toBe(404);
      expect(graphs).not.toHaveBeenCalled();
      expect(t.f.state.modelCalls).toBe(0);
    },
  );

  it('closes captured Source ports after config revision or removal and retains real stored staff-role denial', async () => {
    const t = await rootFixture();
    selectDefaultSource(t);
    const ticket = await t.f.terminal();
    const graphs = vi.spyOn(
      learningComposition,
      'createSupportLearningComposition',
    );
    const read = () =>
      t.call(
        createWorker(),
        t.request(
          '/api/support/admin/tickets/' + learningTicketId + '/learning',
        ),
      );
    const enrolled = await t.call(
      createWorker(),
      t.request(
        '/api/support/admin/tickets/' + learningTicketId + '/learning/enroll',
        {
          commandId: 'CAPTURED-SOURCE-ENROLL',
          expectedRevision: ticket.revision,
        },
      ),
    );
    expect(enrolled.status).toBe(200);
    expect((await read()).status).toBe(200);
    const original = graphs.mock.calls.at(-1)?.[0]?.source;
    Reflect.set(
      t.env,
      SUPPORT_LEARNING_SOURCE_SETTING,
      sourceConfiguration(t, { revision: 'registered-source-v2' }),
    );
    expect(
      await original?.serviceAccess.resolve(new AbortController().signal),
    ).toEqual({ outcome: 'inactive' });
    expect((await read()).status).toBe(200);
    const changed = graphs.mock.calls.at(-1)?.[0]?.source;
    Reflect.set(t.env, SUPPORT_LEARNING_SOURCE_SETTING, undefined);
    expect(
      await changed?.retirementAccess.resolve(new AbortController().signal),
    ).toEqual({ outcome: 'inactive' });
    selectDefaultSource(t);
    const role = await t.support.roleStore.getRoleAssignment(
      'root-learning-Support',
    );
    if (role === null) throw new Error('Actual stored staff role missing');
    await t.support.roleStore.revokeRoleAssignmentWithAudit({
      assignmentId: 'root-learning-Support',
      expectedConcurrencyToken: role.concurrencyToken,
      revokedBy: { kind: 'system', systemId: 'default-source-test' },
      revokedAtEpochMs: Date.now(),
      auditEventId: 'default-source-revoke',
    });
    expect((await read()).status).toBe(403);
  });

  it('uses actual published provenance and Source privacy while a missing quality policy holds publication', async () => {
    const t = await rootFixture();
    const articleId = await t.published();
    selectDefaultSource(t);
    const graphs = vi.spyOn(
      learningComposition,
      'createSupportLearningComposition',
    );
    const worker = createWorker();
    expect(
      (
        await t.call(
          worker,
          t.request(
            '/api/support/admin/tickets/' + learningTicketId + '/learning',
          ),
        )
      ).status,
    ).toBe(200);
    const graph = graphs.mock.results.at(-1)?.value;
    const draft = await t.f.knowledge.getDraft(t.f.actors.staff, { articleId });
    const provenance = await t.f.knowledge.getProvenance(t.f.actors.staff, {
      articleId,
    });
    expect(
      await graph?.sources.isCurrent({
        article: draft.revision,
        snapshot: provenance.snapshot,
      }),
    ).toBe(true);
    expect(
      await graph?.sources.canPublish({
        article: draft.revision,
        snapshot: provenance.snapshot,
      }),
    ).toBe(false);
    const withdrew = await t.call(
      worker,
      t.request(
        '/api/support/admin/tickets/' + learningTicketId + '/learning/withdraw',
        {
          commandId: 'DEFAULT-SOURCE-WITHDRAW',
          reason: 'privacy_withdrawal',
        },
      ),
    );
    expect(withdrew.status).toBe(200);
    expect(
      await graph?.sources.isCurrent({
        article: draft.revision,
        snapshot: provenance.snapshot,
      }),
    ).toBe(false);
    expect(
      (
        await t.f.application.readResolutionLearningSource(
          t.f.actors.staff,
          learningTicketId,
        )
      ).state,
    ).toBe('withdrawn');
  });

  it('binds a genuine confirmed report through the optional default governance reader and refuses expired new evidence', async () => {
    const t = await testEvidenceRootFixture(true);
    const prepared = await t.call(t.worker, t.request(t.path, t.packet));
    expect(prepared.status).toBe(200);
    const reference = (await prepared.json()) as {
      result: { receipt: string; validUntil: string };
    };
    expect(reference.result.receipt.length).toBeLessThanOrEqual(200);
    expect(t.governance).not.toHaveBeenCalled();
    vi.setSystemTime(new Date(Date.parse(reference.result.validUntil) + 1));
    const evidence = await t.call(
      t.worker,
      t.request(
        '/api/support/admin/tickets/' + learningTicketId + '/learning/evidence',
        {
          kind: 'successful_test',
          commandId: 'DEFAULT-EXPIRED-TEST-EVIDENCE',
          expectedRevision: t.packet.expectedRevision,
          resolutionCycle: t.packet.resolutionCycle,
          solutionMessageId: t.packet.solutionMessageId,
          receipt: reference.result.receipt,
        },
      ),
    );
    expect(evidence.status).toBe(200);
    expect(await evidence.json()).toMatchObject({
      result: { state: 'held', heldReason: 'test_receipt_unverified' },
    });
    expect(
      (
        await t.f.application.readResolutionLearningSource(
          t.f.actors.staff,
          learningTicketId,
        )
      ).generationCount,
    ).toBe(0);
    expect(t.f.state.modelCalls).toBe(0);
  });

  it('qualifies fresh successful-test evidence through the default graph without granting governance to staff or jobs', async () => {
    const t = await testEvidenceRootFixture(true);
    const prepared = await t.call(t.worker, t.request(t.path, t.packet));
    expect(prepared.status).toBe(200);
    const reference = (await prepared.json()) as {
      result: { receipt: string };
    };
    const accepted = await t.call(
      t.worker,
      t.request(
        '/api/support/admin/tickets/' + learningTicketId + '/learning/evidence',
        {
          kind: 'successful_test',
          commandId: 'DEFAULT-FRESH-TEST-EVIDENCE',
          expectedRevision: t.packet.expectedRevision,
          resolutionCycle: t.packet.resolutionCycle,
          solutionMessageId: t.packet.solutionMessageId,
          receipt: reference.result.receipt,
        },
      ),
    );
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      result: { state: 'eligible' },
    });
    expect(t.staff.permissions).not.toContain(
      knowledgePermissions.validationManage,
    );
    expect(t.reporter.permissions).not.toContain(
      knowledgePermissions.validationManage,
    );
    expect(t.governance).not.toHaveBeenCalled();
    expect(t.f.state.modelCalls).toBe(0);
  });
});
