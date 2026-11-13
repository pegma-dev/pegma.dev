import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStore } from '@pegma/storage-core';
import * as d1 from '@pegma/storage-cloudflare-d1';
import { identityLinkKeyFromVerifiedIdentityClaims } from '@pegma/authorization-identity';
import { createIdentityRuntime } from './identity-runtime';
import { createSupportRuntime } from './support-desk';
import { createWorker } from './index';
import * as checkModule from './support-independent-checks';
import * as graphModule from './support-learning-composition';
import * as engineeringProduction from './support-engineering-production';
import { createSupportLearningFixture, learningTicketId } from './support-learning-fixtures';
import {
  paidBootstrapFixture,
  engineeringPaidFixture,
  PAID_START,
} from './support-paid-bootstrap-fixtures';
import { IDENTITY_ISSUER, SESSION_COOKIE } from './identity-api';
import { APPLICATION_SCOPE, KNOWLEDGE_ROLE, SUPPORT_ROLE } from './support-access';
import { CLEANUP_CRON } from './maintenance-schedule';
import { SUPPORT_ENGINEERING_QUEUE } from './support-engineering-queue';
vi.mock('@pegma/storage-cloudflare-d1', async (original) => ({
  ...(await original<typeof import('@pegma/storage-cloudflare-d1')>()),
  createCloudflareD1Store: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
type Environment = Parameters<ReturnType<typeof createWorker>['fetch']>[1];
async function fixture() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(PAID_START));
  const data = await paidBootstrapFixture();
  const store = createMemoryStore();
  const f = await createSupportLearningFixture(store);
  const ticket = await f.terminal();
  vi.mocked(d1.createCloudflareD1Store).mockReturnValue(store);
  const identity = createIdentityRuntime(
    {
      store,
      emailCodeSecretBase64: btoa('s'.repeat(32)),
      emailFrom: 'Pegma <synthetic@example.test>',
      emailEnabled: false,
    },
    { log() {} },
  );
  const support = createSupportRuntime({
    store,
    clock: f.clock,
    identity: identity.identity,
    sessions: identity.sessions,
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
    logger: { log() {} },
  });
  const actor = f.actors.staff.principalId,
    csrf = 'c'.repeat(43),
    sid = 's'.repeat(43);
  await identity.identity.provisionVerifiedUser({
    principalId: actor,
    email: 'staff@example.test',
  });
  await identity.sessions.create(sid, {
    principalId: actor,
    data: JSON.stringify({ version: 1, issuer: IDENTITY_ISSUER, subject: actor, csrfToken: csrf }),
  });
  for (const role of [SUPPORT_ROLE, KNOWLEDGE_ROLE])
    await support.roleStore.grantRoleAssignmentWithAudit({
      assignment: {
        id: 'paid-root-' + role,
        principalId: actor,
        role,
        scope: APPLICATION_SCOPE,
        grantedBy: { kind: 'system', systemId: 'fictional-paid-root' },
        grantedAtEpochMs: Date.now(),
        status: 'active',
      },
      auditEventId: 'paid-root-grant-' + role,
    });
  const sends: unknown[] = [];
  const unavailable = () => {
    throw new Error('Memory adapter only; no Native database');
  };
  const env = {
    ...data.env,
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
    PEGMA_AGENT_CLIENTS_JSON: '[]',
    PEGMA_SUPPORT_ASSISTANT_ENABLED: 'false',
    PEGMA_SUPPORT_ENGINEERING_PROCESSING_ENABLED: 'false',
    SUPPORT_ENGINEERING_JOBS: {
      async send(body: unknown) {
        sends.push(body);
      },
    },
  } as unknown as Environment;
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => tasks.push(p),
    passThroughOnException() {},
    props: {},
    exports: {},
    tracing: {},
    abort() {},
  } as unknown as ExecutionContext;
  const drain = async () => {
    await Promise.all(tasks.splice(0));
  };
  const worker = createWorker();
  const call = async (path: string, body?: unknown) => {
    const r = await worker.fetch(
      new Request(IDENTITY_ISSUER + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Cookie: SESSION_COOKIE + '=' + sid,
          Origin: IDENTITY_ISSUER,
          'Sec-Fetch-Site': 'same-origin',
          'X-Pegma-CSRF': csrf,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
      ctx,
    );
    await drain();
    return r;
  };
  return {
    ...data,
    store,
    f,
    ticket,
    env,
    worker,
    ctx,
    drain,
    call,
    sends,
    identity,
    support,
    actor,
  };
}
describe('normal default Worker paid profile selection with actual Memory SDK/auth', () => {
  it('retries failed receipt-key construction on the next unchanged public selection', async () => {
    const t = await fixture();
    const graphs = vi.spyOn(graphModule, 'createSupportLearningComposition');
    const importKey = vi
      .spyOn(crypto.subtle, 'importKey')
      .mockRejectedValueOnce(
        new Error('Fictional transient local key import failure'),
      );
    const path = '/api/support/admin/tickets/' + learningTicketId + '/learning';
    expect(
      (
        await t.call(path + '/enroll', {
          commandId: 'fictional-recover-key-enroll',
          expectedRevision: t.ticket.revision,
        })
      ).status,
    ).toBe(200);
    const unavailable = graphs.mock.results.at(-1)!.value!;
    expect(unavailable.processingEnabled()).toBe(false);
    expect((await t.call(path)).status).toBe(200);
    const recovered = graphs.mock.results.at(-1)!.value!;
    expect(recovered.processingEnabled()).toBe(true);
    expect(unavailable.processingEnabled()).toBe(false);
    const imports = importKey.mock.calls.length;
    expect((await t.call(path)).status).toBe(200);
    expect(graphs.mock.results.at(-1)!.value!.processingEnabled()).toBe(true);
    expect(importKey).toHaveBeenCalledTimes(imports);
  });

  it('requalifies an inline receipt-key replacement and fences the prior default paid selection', async () => {
    const t = await fixture();
    const graphs = vi.spyOn(graphModule, 'createSupportLearningComposition');
    const path = '/api/support/admin/tickets/' + learningTicketId + '/learning';
    expect(
      (
        await t.call(path + '/enroll', {
          commandId: 'fictional-replace-key-enroll',
          expectedRevision: t.ticket.revision,
        })
      ).status,
    ).toBe(200);
    const previous = graphs.mock.results.at(-1)!.value!;
    expect(previous.processingEnabled()).toBe(true);
    Reflect.set(
      t.env,
      'SUPPORT_INDEPENDENT_CHECK_RECEIPT_KEY_BASE64',
      btoa('r'.repeat(32)),
    );
    expect(previous.processingEnabled()).toBe(false);
    expect((await t.call(path)).status).toBe(200);
    expect(graphs.mock.results.at(-1)!.value!.processingEnabled()).toBe(true);
    expect(previous.processingEnabled()).toBe(false);
  });

  it('selects Source intake and paired checkers without injected composition, then seeds/consumes the default learning queue', async () => {
    const t = await fixture();
    const calls: unknown[] = [];
    const controllers = vi.spyOn(checkModule, 'createSupportIndependentChecks');
    const graphs = vi.spyOn(graphModule, 'createSupportLearningComposition');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const request = JSON.parse(String(init.body));
        const input = JSON.parse(request.messages[1].content);
        calls.push(input);
        const output = input.kind
          ? {
              privacy: 'passed',
              factual: 'passed',
              security: 'clear',
              applicability: 'passed',
              duplication: 'passed',
              publicReproduction: 'not_applicable',
              findings: [],
            }
          : { ...t.f.candidate, problem: 'p'.repeat(220) };
        return Response.json({
          id: 'gen-fictional-paid-root',
          object: 'chat.completion',
          created: 1,
          model: 'openai/gpt-4.1-mini',
          provider: 'Azure',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: JSON.stringify(output) },
            },
          ],
          usage: {
            prompt_tokens: 200,
            completion_tokens: 100,
            total_tokens: 300,
            cost: 0.0001,
            currency: 'USD',
            is_byok: false,
            prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0, video_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: 0, image_tokens: 0, audio_tokens: 0 },
          },
        });
      }),
    );
    const detail = await t.call('/api/support/admin/tickets/' + learningTicketId);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ learningEnabled: true });
    const base = '/api/support/admin/tickets/' + learningTicketId + '/learning';
    expect(
      (
        await t.call(base + '/enroll', {
          commandId: 'default-paid-enroll',
          expectedRevision: t.ticket.revision,
        })
      ).status,
    ).toBe(200);
    const evidence = await t.call(base + '/evidence', {
      commandId: 'default-paid-evidence',
      expectedRevision: t.ticket.revision,
      resolutionCycle: 1,
      solutionMessageId: 'learning-solution',
      verificationReference: 'EXPLICIT_FICTIONAL_STAFF_CHECK',
    });
    expect(evidence.status).toBe(200);
    expect(await evidence.json()).toMatchObject({ result: { state: 'eligible' } });
    await t.worker.scheduled(
      { cron: CLEANUP_CRON, scheduledTime: Date.now(), noRetry() {} },
      t.env,
      t.ctx,
    );
    await t.drain();
    expect(t.sends).toContainEqual({ version: 1, kind: 'support-learning-wake' });
    let proposal = false;
    for (let tick = 0; tick < 32; tick++) {
      const message = {
        id: 'fictional-default-' + tick,
        body: { version: 1, kind: 'support-learning-wake' },
        timestamp: new Date(PAID_START),
        attempts: 1,
        ack: vi.fn(),
        retry: vi.fn(),
      };
      await t.worker.queue(
        {
          queue: SUPPORT_ENGINEERING_QUEUE,
          messages: [message],
          ackAll: vi.fn(),
          retryAll: vi.fn(),
          metadata: {},
        } as unknown as MessageBatch<unknown>,
        t.env,
        t.ctx,
      );
      await t.drain();
      const observed = await t.call(base + '/work?sourceGeneration=1');
      const state = (await observed.json()) as { result?: { hasProposal?: boolean } };
      if (state.result?.hasProposal === true) {
        proposal = true;
        break;
      }
    }
    expect(calls).toHaveLength(2);
    expect(
      calls.filter((input) => typeof input === 'object' && input !== null && 'kind' in input),
    ).toHaveLength(1);
    expect(proposal).toBe(true);
    const pair = controllers.mock.calls.slice(-2).map((call) => call[0]);
    expect(pair).toHaveLength(2);
    expect(pair[0]!.application()).toBe(pair[1]!.application());
    expect(pair[0]!.store).toBe(t.store);
    expect(pair[1]!.store).toBe(t.store);
    expect(pair[0]!.knowledge).toBe(pair[1]!.knowledge);
    expect(pair[0]!.knowledgeSources).toBe(graphs.mock.results.at(-1)!.value!.sources);
    expect(pair[0]!.knowledgeSources).toBe(pair[1]!.knowledgeSources);
    expect(pair[0]!.clock).toBe(pair[1]!.clock);
    expect(pair[0]!.usagePolicy).toBe(pair[1]!.usagePolicy);
    const source = await t.call(base);
    expect(source.status).toBe(200);
    const final = graphs.mock.results.at(-1)!.value!;
    const runtime = final.runtime()!;
    const work = await runtime.readWork(t.f.actors.staff, {
      ticketId: learningTicketId,
      sourceGeneration: 1,
    });
    expect(work.target).toBeDefined();
    const articleId = work.target!.articleId;
    const draft = await t.f.knowledge.getDraft(t.f.actors.staff, { articleId });
    expect(draft.revision.title).toBe(t.profile.learning.target.title);
    expect(draft.revision.content.text).toContain('p'.repeat(220));
    const provenance = await t.f.knowledge.getProvenance(t.f.actors.staff, { articleId });
    Reflect.set(t.env, 'PEGMA_SUPPORT_LEARNING_WORKER_ENABLED', 'false');
    Reflect.set(t.env, 'PEGMA_SUPPORT_INDEPENDENT_CHECKS_ENABLED', 'false');
    Reflect.set(t.env, 'SUPPORT_ASSISTANT_OPENROUTER_API_KEY', undefined);
    Reflect.set(t.env, 'SUPPORT_INDEPENDENT_CHECK_RECEIPT_KEY_BASE64', undefined);
    await t.call(base);
    const offlineGraph = graphs.mock.results.at(-1)!.value!;
    expect(
      await offlineGraph.sources.isCurrent({
        article: draft.revision,
        snapshot: provenance.snapshot,
      }),
    ).toBe(true);
    await t.f.application.reopenTicket(t.f.actors.staff, {
      ...t.f.command('paid-root-reopen'),
      ticketId: learningTicketId,
    });
    expect(
      await offlineGraph.sources.isCurrent({
        article: draft.revision,
        snapshot: provenance.snapshot,
      }),
    ).toBe(false);
    expect(calls).toHaveLength(2);
  });
  it('keeps an explicit absent legacy composition selected and does not read paid secrets', async () => {
    const t = await fixture();
    const key = vi.fn(() => {
      throw new Error('Explicit legacy selection must win');
    });
    Object.defineProperty(t.env, 'SUPPORT_INDEPENDENT_CHECK_RECEIPT_KEY_BASE64', { get: key });
    const worker = createWorker({ learning: undefined });
    const response = await worker.fetch(
      new Request(IDENTITY_ISSUER + '/api/not-a-route'),
      t.env,
      t.ctx,
    );
    await t.drain();
    expect(response.status).toBe(404);
    expect(key).not.toHaveBeenCalled();
  });
  it('runs the default engineering model under its own intrinsic ceiling and retains human routing without new issue authority', async () => {
    const t = await fixture();
    const productions = vi.spyOn(engineeringProduction, 'createProductionSupportEngineering');
    const graphs = vi.spyOn(graphModule, 'createSupportLearningComposition');
    const initial = await engineeringPaidFixture(t, 'a'.repeat(64));
    const policy = await t.f.application.putRepositoryPolicy(t.f.actors.admin, {
      ...t.f.command('paid-engineering-policy'),
      expectedGeneration: 0,
      policy: { enabled: true, repositories: [initial.descriptor] },
    });
    const data = await engineeringPaidFixture(t, policy.policyHash);
    Reflect.set(t.env, 'SUPPORT_PAID_CONFIGURATION_JSON', JSON.stringify(data.profile));
    Reflect.set(t.env, 'PEGMA_SUPPORT_ENGINEERING_PROCESSING_ENABLED', 'true');
    Reflect.set(t.env, 'PEGMA_SUPPORT_LEARNING_WORKER_ENABLED', 'false');
    const calls: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
        const wire = JSON.parse(String(init.body));
        calls.push(wire);
        const candidate = {
          title: 'Fictional export failure',
          summary: 'A fictional export is empty.',
          expectedBehavior: 'Export has rows.',
          actualBehavior: 'Export is empty.',
          reproductionSteps: ['Export a fictional workspace.'],
          applicability: t.source.product,
          security: 'ordinary',
          routing: {
            outcome: 'ambiguous',
            alternativeRepositoryIds: ['101'],
            rationale: 'Existing staff must choose the repository.',
          },
        };
        return Response.json({
          id: 'gen-fictional-engineering-root',
          object: 'chat.completion',
          created: 1,
          model: 'openai/gpt-4.1-mini',
          provider: 'Azure',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: JSON.stringify(candidate) },
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
        });
      }),
    );
    const base = '/api/support/admin/tickets/' + learningTicketId + '/engineering';
    const enrolled = await t.call(base + '/enroll', {
      commandId: 'paid-engineer-enroll',
      expectedRevision: t.ticket.revision,
    });
    expect(enrolled.status).toBe(200);
    const evidence = await t.call(base + '/evidence', {
      commandId: 'paid-engineer-evidence',
      expectedRevision: t.ticket.revision,
      security: 'ordinary',
      expectedBehavior: 'Export has rows.',
      actualBehavior: 'Export is empty.',
      reproductionSteps: ['Export a fictional workspace.'],
      visibleMessageIds: ['learning-question'],
      verificationReference: 'EXPLICIT_FICTIONAL_FAILURE',
    });
    expect(evidence.status).toBe(200);
    expect(await evidence.json()).toMatchObject({ result: { state: 'eligible' } });
    await t.worker.scheduled(
      { cron: CLEANUP_CRON, scheduledTime: Date.now(), noRetry() {} },
      t.env,
      t.ctx,
    );
    await t.drain();
    expect(t.sends).toContainEqual({ version: 1, kind: 'support-engineering-wake' });
    for (let tick = 0; tick < 8; tick++) {
      const message = {
        id: 'fictional-engineering-' + tick,
        body: { version: 1, kind: 'support-engineering-wake' },
        timestamp: new Date(PAID_START),
        attempts: 1,
        ack: vi.fn(),
        retry: vi.fn(),
      };
      await t.worker.queue(
        {
          queue: SUPPORT_ENGINEERING_QUEUE,
          messages: [message],
          ackAll: vi.fn(),
          retryAll: vi.fn(),
          metadata: {},
        } as unknown as MessageBatch<unknown>,
        t.env,
        t.ctx,
      );
      await t.drain();
      const observed = await t.call(base + '/work?sourceGeneration=1');
      const state = (await observed.json()) as { result?: { status?: string } };
      if (state.result?.status === 'held') break;
    }
    expect(calls).toHaveLength(1);
    expect(t.env.PEGMA_SUPPORT_ENGINEERING_ISSUE_WRITE_ENABLED).not.toBe('true');
    const work = await t.call(base + '/work?sourceGeneration=1');
    expect(work.status).toBe(200);
    const body = (await work.json()) as { result?: { status?: string } };
    const actualWork = await t.f.application.readEngineeringWork(t.f.actors.admin, {
      ticketId: learningTicketId,
      sourceGeneration: 1,
    });
    expect(actualWork.heldReason).toBe('routing_human_required');
    expect(actualWork.candidateHash).toBeDefined();
    expect(body.result?.status).toBe('held');
    const wired = productions.mock.calls.findLast(
      (call) => call[0]?.configuration?.readChecks !== undefined,
    )?.[0]?.configuration;
    const graph = graphs.mock.results.at(-1)!.value!;
    expect(wired?.readChecks?.()).toBe(graph.readEngineeringChecks());
    expect(wired?.readChecks?.()).not.toBe(graph.readChecks());
  });
});
