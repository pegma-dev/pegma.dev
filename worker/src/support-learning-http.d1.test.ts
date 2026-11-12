/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { AsyncLocalStorage } from 'node:async_hooks';
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { identityLinkKeyFromVerifiedIdentityClaims } from '@pegma/authorization-identity';
import { createCloudflareD1Store } from '@pegma/storage-cloudflare-d1';
import { createSupportDeskApplication, supportRecords } from '@pegma/support-desk-application';
import type { CollectionDefinition, CollectionStore, Store } from '@pegma/storage-core';
import { learningTargetBinding } from '@pegma/support-desk-ai';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAgentPrincipalResolver } from './agent-authority';
import { isPlainObject } from './api-auth';
import { IDENTITY_ISSUER, SESSION_COOKIE } from './identity-api';
import { createIdentityRuntime } from './identity-runtime';
import { APPLICATION_SCOPE, KNOWLEDGE_ROLE, SUPPORT_ROLE } from './support-access';
import { createSupportApi } from './support-api';
import { createSupportRuntime } from './support-desk';
import { composeSupportEngineeringHuman, type SupportEngineeringHumanComposition } from './support-engineering-composition';
import { createWorker } from './index';
import { createSupportLearningRuntime, type SupportLearningRuntimeOptions } from './support-learning';
import { createSupportLearningReviewQueue, type SupportLearningReviewQueueMessage } from './support-learning-review-queue';
import type { SupportLearningProcessingPorts } from './support-learning-ports';
import { controlledHumanBody } from './support-human-control-fixtures';
import {
  createSupportLearningFixture, learningCanary, learningTicketId,
} from './support-learning-fixtures';

const base = '/api/support/admin/tickets/' + learningTicketId + '/learning';
const sessionId = 's'.repeat(43);
const csrf = 'c'.repeat(43);

type BindingMethod = 'first' | 'all' | 'run' | 'raw' | 'batch';
type Phase = 'route' | 'session' | 'identity' | 'roles' | 'limiter' |
  'runtime-staff' | 'prepare-intent' | 'submit-intent' | 'read-receipt' | 'cancel-review';

interface BindingTrace {
  readonly call: number;
  readonly method: BindingMethod;
  readonly phase: readonly Phase[];
  readonly categories: readonly string[];
  readonly statements: number;
  readonly maximumParameters: number;
  readonly blocked: boolean;
}

interface InvocationBudget {
  readonly operation: string;
  calls: number;
  executed: number;
  statements: number;
  batches: number;
  maximumParameters: number;
  blocked: number;
  readonly trace: BindingTrace[];
  firstBlocked?: BindingTrace;
  status?: number;
}

const profiles: InvocationBudget[] = [];

beforeAll(async () => {
  expect(String(env.IDENTITY_EMAIL_ENABLED)).toBe('false');
  // Test schema setup is outside measured HTTP invocations.
  const store = createCloudflareD1Store({ database: env.IDENTITY_DB });
  await store.collection(supportRecords).get({
    partition: 'learning-http-schema-probe', id: 'absent',
  });
});

beforeEach(async () => {
  profiles.length = 0;
  // The Native test pool gives this file its own D1 binding.
  await env.IDENTITY_DB.prepare('DELETE FROM RECORDS').run();
  await env.IDENTITY_DB.prepare('DELETE FROM PEGMA_STORAGE_D1_TX_GUARD').run();
});

afterEach(({ task }) => {
  Object.assign(task.meta, { supportLearningHttpD1Budget: structuredClone(profiles) });
  console.info('support-learning-http-d1-budgets', JSON.stringify(profiles.map(({ trace, firstBlocked, ...budget }) => budget)));
  for (const profile of profiles) {
    const { trace, firstBlocked, ...budget } = profile;
    console.info('support-learning-http-d1-trace', JSON.stringify({ operation: profile.operation, firstBlocked, trace }));
    const detail = JSON.stringify(budget);
    expect(profile.calls, detail).toBeGreaterThan(0);
    expect(profile.calls, detail).toBeLessThanOrEqual(50);
    expect(profile.executed, detail).toBe(profile.calls);
    expect(profile.maximumParameters, detail).toBeLessThanOrEqual(100);
    expect(profile.blocked, detail).toBe(0);
  }
});

// Emit fixed categories only. Stack strings, SQL and bound values stay out of the report.
function stackCategories(): readonly string[] {
  const stack = (new Error().stack ?? '').replaceAll('\\', '/');
  const markers = [
    ['sessions', '/@pegma/sessions/'],
    ['identity', '/@pegma/identity/'],
    ['authorization', '/@pegma/authorization-core/'],
    ['rate-limit', '/@pegma/rate-limit/'],
    ['support-application', '/@pegma/support-desk-application/'],
    ['support-ai', '/@pegma/support-desk-ai/'],
    ['knowledge-application', '/@pegma/knowledge-base-application/'],
    ['browser-authority', 'support-human-auth.ts'],
    ['host-learning-runtime', 'support-learning.ts'],
    ['host-learning-handler', 'support-learning-handlers.ts'],
  ] as const;
  return markers.filter(([, marker]) => stack.includes(marker)).map(([label]) => label);
}

/** Count calls at the genuine binding, including sessions, roles and limiter.
 * Charge a batch once and enforce the parameter ceiling on every statement. */
function meter(backing: D1Database) {
  const scope = new AsyncLocalStorage<{ profile: InvocationBudget; phase: readonly Phase[] }>();
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const parameters = new WeakMap<D1PreparedStatement, number>();

  function charge(method: BindingMethod, statements: readonly D1PreparedStatement[]) {
    const current = scope.getStore();
    if (current === undefined) return;
    const { profile, phase } = current;
    profile.calls += 1;
    profile.statements += statements.length;
    let maximumParameters = 0;
    for (const statement of statements) {
      maximumParameters = Math.max(maximumParameters, parameters.get(statement) ?? 0);
    }
    profile.maximumParameters = Math.max(profile.maximumParameters, maximumParameters);
    const blocked = profile.calls > 50 || profile.maximumParameters > 100;
    const trace = { call: profile.calls, method, phase, categories: stackCategories(),
      statements: statements.length, maximumParameters, blocked };
    profile.trace.push(trace);
    if (blocked) {
      profile.blocked += 1;
      profile.firstBlocked ??= trace;
      throw new Error('Workers Free learning HTTP D1 budget exceeded');
    }
    profile.executed += 1;
  }

  function observed(original: D1PreparedStatement, count = 0): D1PreparedStatement {
    const statement: D1PreparedStatement = {
      bind(...values: unknown[]) {
        return observed(original.bind(...values), values.length);
      },
      first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
        charge('first', [statement]);
        return column === undefined ? original.first<T>() : original.first<T>(column);
      },
      all<T = Record<string, unknown>>() {
        charge('all', [statement]);
        return original.all<T>();
      },
      run<T = Record<string, unknown>>() {
        charge('run', [statement]);
        return original.run<T>();
      },
      raw: original.raw,
    };
    statement.raw = new Proxy(original.raw, { apply(target, _receiver, args) {
      charge('raw', [statement]);
      return Reflect.apply(target, original, args);
    } });
    originals.set(statement, original);
    parameters.set(statement, count);
    return statement;
  }

  const database: D1Database = {
    prepare(query) { return observed(backing.prepare(query)); },
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      charge('batch', statements);
      const profile = scope.getStore()?.profile;
      if (profile !== undefined) profile.batches += 1;
      const native = statements.map((statement) => {
        const original = originals.get(statement);
        if (original === undefined) throw new Error('Expected a metered D1 statement');
        return original;
      });
      return backing.batch<T>(native);
    },
    exec() { throw new Error('Runtime schema work is outside this test'); },
    dump() { throw new Error('Runtime D1 dump is outside this test'); },
    withSession() { throw new Error('Expected the direct D1 binding'); },
  };
  return {
    database,
    // Deliberate peer mutations are independent fixture actors, not calls made
    // by the measured HTTP request. Their effects remain genuine native writes.
    outside<Value>(action: () => Value): Value {
      return scope.exit(action);
    },
    phase<Value>(name: Phase, action: () => Value): Value {
      const current = scope.getStore();
      return current === undefined ? action() : scope.run({ ...current, phase: [...current.phase, name] }, action);
    },
    run<Value>(operation: string, action: () => Promise<Value>) {
      const profile: InvocationBudget = {
        operation, calls: 0, executed: 0, statements: 0, batches: 0,
        maximumParameters: 0, blocked: 0, trace: [],
      };
      profiles.push(profile);
      return scope.run({ profile, phase: ['route'] }, async () => {
        const result = await action();
        if (result instanceof Response) {
          profile.status = result.status;
          await result.clone().arrayBuffer();
        }
        return result;
      });
    },
  };
}

async function fixture(withEngineering = false) {
  const binding = meter(env.IDENTITY_DB);
  const backing = createCloudflareD1Store({
    database: binding.database, createSchemaIfMissing: false, readBatchSize: 512,
  });
  const hooks: {
    afterLimiter?: () => Promise<void>;
    afterDraft?: () => Promise<void>;
    beforeCommit?: () => Promise<void>;
    afterCommit?: () => Promise<void>;
    targetArticleId?: string;
    armed: boolean;
    policyCalls: number;
    draftCalls: number;
    reviewDepth: number;
    committed: number;
    conflicts: number;
  } = { armed: false, policyCalls: 0, draftCalls: 0, reviewDepth: 0, committed: 0, conflicts: 0 };
  const store: Store = {
    collection<Value>(definition: CollectionDefinition<Value>): CollectionStore<Value> {
      const actual = backing.collection(definition);
      if (definition.name !== supportRecords.name) return actual;
      return { ...actual, async transact(partition, actions) {
        const acceptedReview = actions.some((action) => action.action !== 'delete' &&
          isPlainObject(action.value) && action.value.kind === 'resolution_learning_review');
        if (hooks.armed && partition === learningTicketId && acceptedReview) await hooks.beforeCommit?.();
        const result = await actual.transact(partition, actions);
        if (hooks.armed && partition === learningTicketId && acceptedReview) {
          if (result.committed) {
            hooks.committed += 1;
            await hooks.afterCommit?.();
          } else hooks.conflicts += 1;
        }
        return result;
      } };
    },
  };
  const learning = await createSupportLearningFixture(store, { stagedReviews: true, readScheduling: 'sdk' });
  const logger = { log() {} };
  const { identity, sessions } = createIdentityRuntime({
    store, emailCodeSecretBase64: btoa('r'.repeat(32)),
    emailFrom: 'Pegma <synthetic@pegma.dev>', emailEnabled: false,
  }, logger);
  const identityLinkFromClaims = identityLinkKeyFromVerifiedIdentityClaims;
  const host = createSupportRuntime({ store, identity, sessions, logger, identityLinkFromClaims });
  const principalId = learning.actors.staff.principalId;
  await identity.provisionVerifiedUser({ principalId, email: 'learning-http@example.test' });
  await sessions.create(sessionId, {
    principalId,
    data: JSON.stringify({ version: 1, issuer: IDENTITY_ISSUER, subject: principalId, csrfToken: csrf }),
  });
  for (const role of [SUPPORT_ROLE, KNOWLEDGE_ROLE]) {
    const grant = await host.roleStore.grantRoleAssignmentWithAudit({
      assignment: {
        id: 'native-learning-http-' + role, principalId, role, scope: APPLICATION_SCOPE,
        grantedBy: { kind: 'system', systemId: 'synthetic-learning-http' },
        grantedAtEpochMs: Date.now(), status: 'active',
      },
      auditEventId: 'native-learning-http-grant-' + role,
    });
    expect(grant.status).toBe('granted');
  }

  const authority = {
    identity: { ...identity, claimsFor: (id: string) => binding.phase('identity', () => identity.claimsFor(id)) },
    sessions: { ...sessions, get: (id: string) => binding.phase('session', () => sessions.get(id)) },
    identityLinkFromClaims,
    logger,
    roleStore: { ...host.roleStore, listActiveRoleAssignments: (...args: Parameters<typeof host.roleStore.listActiveRoleAssignments>) =>
      binding.phase('roles', () => host.roleStore.listActiveRoleAssignments(...args)) },
  };
  const resolve = createAgentPrincipalResolver(authority);
  const ports: SupportLearningProcessingPorts = {
    ...learning.ports,
    checks: { ...learning.ports.checks, async resolvePolicy(...args) {
      hooks.policyCalls += 1;
      return learning.ports.checks.resolvePolicy(...args);
    } },
    targets: {
      async resolveScope(...args) {
        const result = await learning.ports.targets.resolveScope(...args);
        return result.outcome === 'ready' && hooks.targetArticleId !== undefined
          ? { ...result, scope: { ...result.scope, explicitDraftIds: [hooks.targetArticleId] } }
          : result;
      },
      async select(input, context) {
        const result = await learning.ports.targets.select(input, context);
        if (hooks.targetArticleId === undefined || result.outcome !== 'selected') return result;
        const existing = input.explicitDrafts.find((draft) => draft.articleId === hooks.targetArticleId);
        if (existing === undefined) return { outcome: 'held' };
        // Script only the trusted external target policy. The real coordinator
        // reads, merges provenance, checks and delivers this actual KB update.
        return { ...result, operation: 'update', articleId: existing.articleId,
          draft: { ...result.draft, content: { format: 'plain_text',
            text: existing.revision.content.text + '\n\n' + result.draft.content.text } } };
      },
    },
  };
  const staged = (() => {
    const capability = learning.application.stagedResolutionLearningReviews;
    if (capability === undefined) throw new Error('Expected the real opted-in SDK staged review capability');
    return capability;
  })();
  const application = { ...learning.application,
    stagedResolutionLearningReviews: { ...staged,
      async complete(...args: Parameters<typeof staged.complete>) {
        hooks.reviewDepth += 1;
        try { return await staged.complete(...args); }
        finally { hooks.reviewDepth -= 1; }
      },
    },
    async reviewResolutionLearningProposal(...args: Parameters<typeof learning.application.reviewResolutionLearningProposal>) {
      hooks.reviewDepth += 1;
      try { return await learning.application.reviewResolutionLearningProposal(...args); }
      finally { hooks.reviewDepth -= 1; }
    },
  };
  const knowledge = { ...learning.knowledge,
    async getDraft(...args: Parameters<typeof learning.knowledge.getDraft>) {
      const result = await learning.knowledge.getDraft(...args);
      hooks.draftCalls += 1;
      await hooks.afterDraft?.();
      return result;
    },
  };
  const messages: SupportLearningReviewQueueMessage[] = [];
  const sender = { async send(message: SupportLearningReviewQueueMessage) { messages.push(structuredClone(message)); } };
  let queue: ReturnType<typeof createSupportLearningReviewQueue>;
  const learningRuntime: Omit<SupportLearningRuntimeOptions, 'staffAccess'> = {
    application, knowledge, sources: learning.sources, clock: learning.clock, ports,
    processingEnabled: () => learning.state.enabled,
    readScheduling: 'sdk',
    stagedReviews: { enabled: () => true, enqueue: (key) => queue.enqueue(key) },
  };
  // SDK-only diagnostics retain the standalone factory's genuine current
  // resolver. HTTP uses the normal router's private Request-only composition.
  const runtime = createSupportLearningRuntime({ ...learningRuntime,
    staffAccess: { resolve: (id) => binding.phase('runtime-staff', () => resolve(id)) },
  });
  queue = createSupportLearningReviewQueue({ enabled: () => true, store: () => store,
    clock: learning.clock, logger, sender, runtime: () => runtime.stagedReviewDispatch() });
  const observedRuntime = {
    ...runtime,
    prepareReviewIntent: (...args: Parameters<typeof runtime.prepareReviewIntent>) =>
      binding.phase('prepare-intent', () => runtime.prepareReviewIntent(...args)),
    submitReviewIntent: (...args: Parameters<typeof runtime.submitReviewIntent>) =>
      binding.phase('submit-intent', () => runtime.submitReviewIntent(...args)),
    readReviewReceipt: (...args: Parameters<typeof runtime.readReviewReceipt>) =>
      binding.phase('read-receipt', () => runtime.readReviewReceipt(...args)),
    cancelReview: (...args: Parameters<typeof runtime.cancelReview>) =>
      binding.phase('cancel-review', () => runtime.cancelReview(...args)),
  };
  const enabled = () => true;
  const limiter = { ...host.replyLimiter, async allow(...args: Parameters<typeof host.replyLimiter.allow>) {
    const result = await binding.phase('limiter', () => host.replyLimiter.allow(...args));
    await hooks.afterLimiter?.();
    return result;
  } };
  const api = (engineering?: SupportEngineeringHumanComposition) => createSupportApi({
    ...authority, application: learning.application,
    createLimiter: host.createLimiter, replyLimiter: limiter,
    learningRuntime, learningEnabled: enabled, learningStagedReviewsEnabled: enabled,
    ...(engineering === undefined ? {} : {
      engineering: composeSupportEngineeringHuman({ ...host, application: learning.application }, logger, engineering),
    }),
  });
  const engineeringState = { enabled: true };
  const engineering = { enabled: () => engineeringState.enabled,
    configuration: { application: { enabled: true }, repositories: [] } };
  const worker = () => createWorker({
    ...(withEngineering ? { engineering } : {}),
    learningReviews: { enabled, create: (_environment, _logger, engineering) => ({ api: api(engineering), queue }) },
  });
  const broker: Queue<SupportLearningReviewQueueMessage> = {
    async metrics() { return { backlogCount: messages.length, backlogBytes: 0 }; },
    async send(message) {
      await sender.send(message);
      return { metadata: { metrics: { backlogCount: messages.length, backlogBytes: 0 } } };
    },
    async sendBatch() { throw new Error('Expected one opaque review hint'); },
  };
  const environment: Parameters<ReturnType<typeof createWorker>['queue']>[1] = {
    ...env, IDENTITY_DB: binding.database, IDENTITY_EMAIL_CODE_SECRET_BASE64: btoa('r'.repeat(32)),
    PEGMA_SUPPORT_LEARNING_REVIEWS_ENABLED: 'true', SUPPORT_LEARNING_REVIEWS: broker,
  };

  let peerOrdinal = 0;
  async function revokeRole(role: typeof SUPPORT_ROLE | typeof KNOWLEDGE_ROLE) {
    return binding.outside(async () => {
      const id = 'native-learning-http-' + role;
      const row = await host.roleStore.getRoleAssignment(id);
      if (row === null) throw new Error('Expected the stored human assignment');
      await host.roleStore.revokeRoleAssignmentWithAudit({
        assignmentId: id, expectedConcurrencyToken: row.concurrencyToken,
        revokedBy: { kind: 'system', systemId: 'synthetic-learning-http' },
        revokedAtEpochMs: Date.now(), auditEventId: 'native-learning-http-revoke-' + ++peerOrdinal,
      });
      expect((await resolve(principalId))?.roles).not.toContain(role);
    });
  }
  async function grantRole(role: typeof SUPPORT_ROLE | typeof KNOWLEDGE_ROLE) {
    return binding.outside(async () => {
      const id = 'native-learning-http-restored-' + ++peerOrdinal;
      const result = await host.roleStore.grantRoleAssignmentWithAudit({
        assignment: { id, principalId, role, scope: APPLICATION_SCOPE,
          grantedBy: { kind: 'system', systemId: 'synthetic-learning-http' },
          grantedAtEpochMs: Date.now(), status: 'active' },
        auditEventId: id + '-audit',
      });
      expect(result.status).toBe('granted');
    });
  }
  const revokeKnowledge = () => revokeRole(KNOWLEDGE_ROLE);
  const destroySession = () => binding.outside(() => sessions.destroy(sessionId));
  function request(suffix: string, retainedBody?: string) {
    return new Request(IDENTITY_ISSUER + base + suffix, {
      method: retainedBody === undefined ? 'GET' : 'POST',
      headers: {
        Cookie: SESSION_COOKIE + '=' + sessionId,
        ...(retainedBody === undefined ? {} : {
          Origin: IDENTITY_ISSUER, 'Sec-Fetch-Site': 'same-origin',
          'X-Pegma-CSRF': csrf, 'Content-Type': 'application/json',
        }),
      },
      ...(retainedBody === undefined ? {} : { body: retainedBody }),
    });
  }
  const send = (operation: string, value: Request) => binding.run(operation, async () => {
    const context = createExecutionContext();
    try { return await worker().fetch(value, environment, context); }
    finally { await waitOnExecutionContext(context); }
  });
  const invoke = (operation: string, suffix: string, retainedBody?: string) =>
    send(operation, request(suffix, retainedBody));
  const deliver = (operation: string) => binding.run(operation, async () => {
    const message = messages.at(-1);
    if (message === undefined) throw new Error('Expected a genuine admitted review hint');
    const result = { acknowledgements: 0, delays: [] as number[] };
    const batch: MessageBatch<unknown> = {
      queue: 'pegma-dev-support-learning-reviews',
      metadata: { metrics: { backlogCount: 1, backlogBytes: 0 } },
      messages: [{ id: 'native-review-delivery', body: message, timestamp: new Date(learning.clock.now()), attempts: 1,
        ack() { result.acknowledgements += 1; },
        retry(options) {
          if (options?.delaySeconds === undefined) throw new Error('Expected bounded same-message retry');
          result.delays.push(options.delaySeconds);
        } }],
      ackAll() { throw new Error('Expected individual acknowledgement'); },
      retryAll() { throw new Error('Expected individual retry'); },
    };
    const context = createExecutionContext();
    try { await worker().queue(batch, environment, context); }
    finally { await waitOnExecutionContext(context); }
    return result;
  });

  async function prepareSdk(sourceGeneration: number) {
    // Set up the actual host AccessContext outside this SDK-only scope. The
    // runtime still performs its own current staff checks inside the meter.
    const access = await resolve(principalId);
    if (access === null) throw new Error('Expected a real current staff actor');
    return binding.run('proposal.sdk-only', () => observedRuntime.prepareReviewIntent(access, {
      ticketId: learningTicketId, sourceGeneration,
    }));
  }

  async function rewriteTicketVersion() {
    return binding.outside(async () => {
      const rows = backing.collection(supportRecords);
      const ticket = await rows.getVersioned({ partition: learningTicketId, id: 'ticket' });
      if (ticket === null || ticket.value.kind !== 'ticket') throw new Error('Expected the actual ticket');
      // Same decoded SDK value, fresh opaque native version: a real competing
      // writer forces the target transaction's original version condition to fail.
      expect(await rows.putIfUnchanged(ticket.value, ticket.version)).toBe(true);
    });
  }
  return { learning, principalId, invoke, request, send, deliver, revokeKnowledge, revokeRole,
    grantRole, destroySession, prepareSdk, runtime, hooks, rewriteTicketVersion, engineeringState };

}

async function envelope(response: Response) {
  const body: unknown = await response.json();
  if (!isPlainObject(body)) throw new Error('Expected a Support route JSON envelope');
  return body;
}

type NativeFixture = Awaited<ReturnType<typeof fixture>>;
type Delivered = Awaited<ReturnType<NativeFixture['learning']['delivered']>>;

async function inspect(f: NativeFixture, delivered: Delivered, commandId: string) {
  const response = await f.invoke('proposal.prepare',
    '/proposal?sourceGeneration=' + delivered.source.sourceGeneration);
  expect(response.status).toBe(200);
  const body = await envelope(response);
  if (!isPlainObject(body.result) || !isPlainObject(body.result.intent))
    throw new Error('Expected the actual prepared SDK intent');
  expect(body.csrfToken).toBe(csrf);
  return { intent: body.result.intent,
    packet: JSON.stringify({ commandId, intent: body.result.intent,
      decision: 'approve', reason: 'A synthetic exact Native review.' }) };
}

async function changeDraft(f: NativeFixture, delivered: Delivered) {
  const draft = await f.learning.knowledge.getDraft(f.learning.actors.staff, { articleId: delivered.articleId });
  await f.learning.knowledge.updateDraft(f.learning.actors.staff, {
    ...f.learning.command('native-http-current-edit', draft.generation),
    articleId: delivered.articleId, collectionId: draft.revision.collectionId,
    draft: { kind: draft.revision.kind, title: 'A separately edited synthetic guide',
      summary: draft.revision.summary, content: draft.revision.content,
      tags: draft.revision.tags, applicability: draft.revision.applicability },
  });
}

/** Construct every contributor through actual public Support and KB workflows. */
async function multipleContributors(f: NativeFixture, published: boolean): Promise<Delivered> {
  const ticketId = 'native-secondary-learning-ticket';
  const messageId = 'native-secondary-learning-solution';
  const old = createSupportDeskApplication({ store: f.learning.store, clock: f.learning.clock });
  await old.createCustomerTicket(f.learning.actors.customer, {
    ...f.learning.command('secondary-ticket'), ticketId, messageId: 'native-secondary-question',
    subject: 'A second synthetic export problem', body: 'How can a second workspace be exported?',
  });
  await old.replyAsStaff(f.learning.actors.staff, {
    ...f.learning.command('secondary-solution'), ticketId, messageId,
    body: 'Open Workspace and choose Export for the second workspace.',
  });
  await old.resolveTicket(f.learning.actors.staff, { ...f.learning.command('secondary-resolve'), ticketId });
  const ticket = (await old.readStaffTicket(f.learning.actors.staff, ticketId)).ticket;
  await f.learning.runtime.enroll(f.learning.actors.staff, {
    ticketId, clientCommandId: 'SECONDARY-ENROLL:UPPER', expectedRevision: ticket.revision,
  });
  const enrolled = await f.learning.runtime.readSource(f.learning.actors.staff, ticketId);
  await f.learning.runtime.submitVerifiedFix(f.learning.actors.staff, {
    ticketId, clientCommandId: 'SECONDARY-VERIFY:UPPER', expectedRevision: ticket.revision,
    resolutionCycle: enrolled.resolutionCycle,
    evidence: { kind: 'staff_verified_fix', solutionMessageId: messageId,
      verificationReference: 'SYNTHETIC_SECONDARY_VERIFICATION' },
  });
  // Accepted evidence advances generation0 enrollment and creates work for the
  // new current generation. Never reuse the pre-evidence work key.
  const source = await f.learning.runtime.readSource(f.learning.actors.staff, ticketId);
  expect(source.state).toBe('eligible');
  expect(source.sourceGeneration).toBeGreaterThan(enrolled.sourceGeneration);
  const process = () => f.learning.runtime.processWork({
    ticketId, sourceGeneration: source.sourceGeneration,
    workerId: 'native-secondary-worker', leaseMilliseconds: 30_000,
  });
  expect(await process()).toMatchObject({ outcome: 'candidate' });
  expect(await process()).toMatchObject({ outcome: 'delivered' });
  const secondary = await f.learning.runtime.readWork(f.learning.actors.staff, {
    ticketId, sourceGeneration: source.sourceGeneration,
  });
  if (secondary.target === undefined || secondary.checkPolicyVersion === undefined)
    throw new Error('Expected the genuine second delivered target');
  const articleId = secondary.target.articleId;
  if (published) {
    const draft = await f.learning.knowledge.getDraft(f.learning.actors.staff, { articleId });
    const provenance = await f.learning.knowledge.getProvenance(f.learning.actors.staff, { articleId });
    await f.learning.runtime.reviewProposal(f.learning.actors.staff, {
      ticketId, clientCommandId: 'SECONDARY-REVIEW:UPPER', sourceGeneration: source.sourceGeneration,
      expectedWorkGeneration: secondary.workGeneration,
      target: await learningTargetBinding(draft.revision, provenance.snapshot),
      policyVersion: secondary.checkPolicyVersion, decision: 'approve',
    });
    await f.learning.evidenceAndPublish(articleId);
  }
  // The trusted test target policy selects a real explicitly permitted draft.
  // The actual coordinator merges both source references and keeps published
  // provenance. No test constructs a reference, provenance hash or accepted row.
  f.hooks.targetArticleId = articleId;
  await f.learning.enrollAndVerify();
  const primary = await f.learning.runtime.readSource(f.learning.actors.staff, learningTicketId);
  const primaryProcess = () => f.runtime.processWork({
    ticketId: learningTicketId, sourceGeneration: primary.sourceGeneration,
    workerId: 'native-primary-multi-worker', leaseMilliseconds: 30_000,
  });
  expect((await primaryProcess()).outcome).toBe('candidate');
  expect((await primaryProcess()).outcome).toBe('delivered');
  const work = await f.runtime.readWork(f.learning.actors.staff, {
    ticketId: learningTicketId, sourceGeneration: primary.sourceGeneration,
  });
  expect(work.target?.articleId).toBe(articleId);
  const provenance = await f.learning.knowledge.getProvenance(f.learning.actors.staff, { articleId });
  expect(provenance.snapshot.references.map((value) => value.resourceId).sort())
    .toEqual([learningTicketId, ticketId].sort());
  if (published)
    expect(provenance.publishedSnapshot?.references.map((value) => value.resourceId)).toEqual([ticketId]);
  else expect(provenance.publishedSnapshot).toBeUndefined();
  const completedSource = await f.runtime.readSource(f.learning.actors.staff, learningTicketId);
  return { source: completedSource, work, articleId };
}

describe('enabled learning HTTP namespace on real Native D1', () => {
  it('measures complete SDK preparation on real Native D1', async () => {
    const f = await fixture();
    await f.learning.enrollAndVerify();
    const delivered = await f.learning.delivered();
    const rows = await f.learning.rows();
    const draft = await f.learning.knowledge.getDraft(f.learning.actors.admin, { articleId: delivered.articleId });

    const prepared = await f.prepareSdk(delivered.source.sourceGeneration);
    expect(prepared.intent).toMatchObject({
      reviewerId: f.principalId, ticketId: learningTicketId,
      sourceGeneration: delivered.source.sourceGeneration,
      expectedWorkGeneration: delivered.work.workGeneration,
    });
    expect(prepared.intent.target).toEqual(delivered.work.target);
    expect(prepared.draft).toEqual(draft);
    expect(await f.learning.rows()).toEqual(rows);
    expect(f.learning.state.modelCalls).toBe(1);
    expect(profiles).toHaveLength(1);
  });

  it('commits the inspected intent and recovers its discarded ACK after reopening and stored Knowledge revocation', async () => {
    // Seed the actual terminal ticket, evidence and delivered draft outside the
    // HTTP meter. The model and independent-check inputs use existing fictional ports.
    const f = await fixture();
    await f.learning.enrollAndVerify();
    const delivered = await f.learning.delivered();
    const beforeReview = await f.learning.rows();
    expect(beforeReview.some((row) => row.kind === 'resolution_learning_review')).toBe(false);

    const proposalResponse = await f.invoke('proposal.prepare',
      '/proposal?sourceGeneration=' + delivered.source.sourceGeneration);
    expect(proposalResponse.status).toBe(200);
    const proposal = await envelope(proposalResponse);
    if (!isPlainObject(proposal.result) || !isPlainObject(proposal.result.intent))
      throw new Error('Expected the actual server-prepared learning intent');
    const intent = proposal.result.intent;
    expect(proposal.csrfToken).toBe(csrf);
    expect(intent).toMatchObject({
      reviewerId: f.principalId, ticketId: learningTicketId,
      sourceGeneration: delivered.source.sourceGeneration,
      expectedWorkGeneration: delivered.work.workGeneration, target: delivered.work.target,
    });
    expect(JSON.stringify(proposal)).not.toContain(learningCanary);
    expect(await f.learning.rows()).toEqual(beforeReview);

    const decision = 'approve';
    const reason = 'Retain this exact Native review.';
    const originalBody = JSON.stringify({ commandId: 'NATIVE-REVIEW:UPPER', intent, decision, reason });
    const lost = await f.invoke('review.admission-discarded-ack', '/review-queue', originalBody);
    // 202 acknowledges durable intent, not review completion. Discard that
    // browser ACK, then let the two genuine worker invocations make progress.
    expect(lost.status).toBe(202);
    await lost.body?.cancel();
    expect((await f.learning.rows()).filter((row) => row.kind === 'resolution_learning_review')).toHaveLength(0);
    expect(await f.deliver('review.proof')).toEqual({ acknowledgements: 0, delays: [30] });
    expect(await f.deliver('review.commit-discarded-ack')).toEqual({ acknowledgements: 1, delays: [] });
    const committed = await f.learning.rows();
    expect(committed.filter((row) => row.kind === 'resolution_learning_review')).toMatchObject([{
      ticketId: learningTicketId, reviewerId: f.principalId, decision, reason,
      sourceGeneration: intent.sourceGeneration, target: intent.target,
    }]);
    const oldIds = new Set(beforeReview.map((row) => row.id));
    const receipt = committed.find((row) => row.kind === 'resolution_learning_receipt' && !oldIds.has(row.id));
    if (receipt?.kind !== 'resolution_learning_receipt')
      throw new Error('Expected the original durable SDK review receipt');
    const expected = { outcome: 'accepted', result: receipt.result };

    // Separate lifecycle changes and verification reads are test setup, rather
    // than D1 calls performed by the physical review and recovery requests.
    await f.learning.application.reopenTicket(f.learning.actors.staff, {
      ...f.learning.command('native-http-reopen'), ticketId: learningTicketId,
    });
    const reopened = await f.learning.runtime.readSource(f.learning.actors.staff, learningTicketId);
    expect(reopened).toMatchObject({ state: 'held', heldReason: 'reopened',
      sourceGeneration: delivered.source.sourceGeneration + 1 });
    await f.revokeKnowledge();
    f.learning.state.enabled = false;
    f.learning.state.checkReadable = false;
    const afterReopen = await f.learning.rows();
    const draftBefore = await f.learning.knowledge.getDraft(f.learning.actors.admin, { articleId: delivered.articleId });

    const recovered = await f.invoke('review.receipt-after-reopen-and-role-loss', '/review-queue-status', originalBody);
    expect(recovered.status).toBe(200);
    expect(await envelope(recovered)).toEqual({ result: expected, csrfToken: csrf });
    expect(await f.learning.rows()).toEqual(afterReopen);

    // Cancelling an already accepted original command returns its accepted
    // receipt. The current human route still runs every browser check.
    const cancel = await f.invoke('review.cancel-after-accepted', '/review-queue-cancel', originalBody);
    expect(cancel.status).toBe(200);
    expect(await envelope(cancel)).toEqual({ result: expected, csrfToken: csrf });
    expect(await f.learning.rows()).toEqual(afterReopen);
    expect(await f.learning.knowledge.getDraft(f.learning.actors.admin, { articleId: delivered.articleId })).toEqual(draftBefore);
    expect(f.learning.state.modelCalls).toBe(1);
    expect(profiles).toHaveLength(6);
  });

  for (const change of ['support', 'session'] as const) {
    it('denies ' + change + ' revocation after the real limiter before protected SDK reads', async () => {
      const f = await fixture();
      await f.learning.enrollAndVerify();
      const before = await f.learning.rows();
      let entered = false;
      f.hooks.afterLimiter = async () => {
        delete f.hooks.afterLimiter; entered = true;
        if (change === 'support') await f.revokeRole(SUPPORT_ROLE);
        else await f.destroySession();
      };
      const response = await f.invoke('authority.after-limiter', '');
      expect(entered).toBe(true);
      expect(response.status).toBe(change === 'support' ? 403 : 401);
      expect(await envelope(response)).not.toHaveProperty('result');
      expect(await f.learning.rows()).toEqual(before);
      expect(f.learning.state.modelCalls).toBe(0);
    });
  }

  it('denies current Support loss while the genuine bounded request body is delayed', async () => {
    const f = await fixture();
    await f.learning.enrollAndVerify();
    const before = await f.learning.rows();
    const body = await controlledHumanBody(f.request('/withdraw',
      JSON.stringify({ commandId: 'DELAYED-WITHDRAW:UPPER', reason: 'privacy_withdrawal' })));
    const pending = f.send('authority.delayed-body', body.request);
    try {
      await body.waitFor(pending);
      await f.revokeRole(SUPPORT_ROLE);
    } finally { body.complete(); }
    const response = await pending;
    expect(response.status).toBe(403);
    expect(await envelope(response)).not.toHaveProperty('result');
    expect(await f.learning.rows()).toEqual(before);
    expect(f.learning.state.modelCalls).toBe(0);
  });

  it('withholds a prepared private result after Knowledge is revoked in the late actual KB draft read', async () => {
    const f = await fixture();
    await f.learning.enrollAndVerify(); const delivered = await f.learning.delivered();
    const before = await f.learning.rows();
    f.hooks.policyCalls = 0; f.hooks.draftCalls = 0;
    let entered = false;
    f.hooks.afterDraft = async () => {
      // The current producer's final draft read follows its closing policy
      // observation. This assertion must not silently fall back to an early read.
      if (f.hooks.policyCalls < 2) return;
      delete f.hooks.afterDraft; entered = true;
      await f.revokeKnowledge();
    };
    const response = await f.invoke('authority.late-draft-read',
      '/proposal?sourceGeneration=' + delivered.source.sourceGeneration);
    expect(entered).toBe(true);
    expect(response.status).toBe(403);
    expect(await envelope(response)).not.toHaveProperty('result');
    expect(await f.learning.rows()).toEqual(before);
    expect(f.learning.state.modelCalls).toBe(1);
  });

  it('denies a changed original Cookie after an actual KB read', async () => {
    const f = await fixture();
    await f.learning.enrollAndVerify(); const delivered = await f.learning.delivered();
    const before = await f.learning.rows();
    const request = f.request('/proposal?sourceGeneration=' + delivered.source.sourceGeneration);
    let entered = false;
    f.hooks.afterDraft = async () => {
      delete f.hooks.afterDraft; entered = true;
      request.headers.set('Cookie', SESSION_COOKIE + '=' + 'x'.repeat(43));
    };
    const response = await f.send('authority.changed-header', request);
    expect(entered).toBe(true);
    expect(response.status).toBe(403);
    expect(await envelope(response)).not.toHaveProperty('result');
    expect(await f.learning.rows()).toEqual(before);
  });

  it('keeps the original permission ceiling when Knowledge is granted after admission', async () => {
    const f = await fixture();
    await f.learning.enrollAndVerify(); const delivered = await f.learning.delivered();
    const shown = await inspect(f, delivered, 'LATER-KNOWLEDGE-GRANT:UPPER');
    await f.revokeKnowledge();
    const before = await f.learning.rows();
    let entered = false;
    f.hooks.afterLimiter = async () => {
      delete f.hooks.afterLimiter; entered = true; await f.grantRole(KNOWLEDGE_ROLE);
    };
    const response = await f.invoke('authority.new-permission-ceiling', '/review-queue', shown.packet);
    expect(entered).toBe(true);
    expect(response.status).toBe(403);
    expect(await envelope(response)).not.toHaveProperty('result');
    expect(await f.learning.rows()).toEqual(before);
  });

  it('refuses a queued review after real Knowledge loss during its actual P2 proof', async () => {
    const f = await fixture();
    await f.learning.enrollAndVerify(); const delivered = await f.learning.delivered();
    const shown = await inspect(f, delivered, 'PROOF-KNOWLEDGE-LOSS:UPPER');
    expect((await f.invoke('review.proof-race-admission', '/review-queue', shown.packet)).status).toBe(202);
    expect(await f.deliver('review.proof-before-role-race')).toEqual({ acknowledgements: 0, delays: [30] });
    const before = await f.learning.rows();
    let entered = false;
    f.hooks.afterDraft = async () => {
      if (f.hooks.reviewDepth === 0) return;
      delete f.hooks.afterDraft; entered = true; await f.revokeKnowledge();
    };
    f.hooks.armed = true;
    const delivery = await f.deliver('authority.review-proof');
    expect(entered).toBe(true);
    expect(delivery).toEqual({ acknowledgements: 0, delays: [30] });
    expect(f.hooks.committed).toBe(0);
    const after = await f.learning.rows();
    expect(after.filter((row) => row.kind === 'resolution_learning_review')).toHaveLength(0);
    // A failed phase may retain its genuine claim, but no source, work, Audit
    // or receipt can be accepted by that failed proof.
    expect(after.filter((row) => row.kind !== 'resolution_learning_review_attempt'))
      .toEqual(before.filter((row) => row.kind !== 'resolution_learning_review_attempt'));
    const denied = await f.invoke('authority.private-read-after-proof-revocation',
      '/proposal?sourceGeneration=' + delivered.source.sourceGeneration);
    expect(denied.status).toBe(403);
    expect(await envelope(denied)).not.toHaveProperty('result');
  });

  it('withholds a browser receipt after actual queued commit role revocation and recovers the original receipt', async () => {
    const f = await fixture();
    await f.learning.enrollAndVerify(); const delivered = await f.learning.delivered();
    const shown = await inspect(f, delivered, 'POST-COMMIT-ROLE-LOSS:UPPER');
    expect((await f.invoke('review.postcommit-race-admission', '/review-queue', shown.packet)).status).toBe(202);
    expect(await f.deliver('review.proof-before-committed-role-race')).toEqual({ acknowledgements: 0, delays: [30] });
    f.hooks.armed = true;
    let entered = false;
    f.hooks.afterCommit = async () => {
      delete f.hooks.afterCommit; entered = true; await f.revokeRole(SUPPORT_ROLE);
    };
    expect(await f.deliver('review.commit-before-role-loss')).toEqual({ acknowledgements: 1, delays: [] });
    expect(entered).toBe(true);
    // The worker's transport acknowledgement is not a browser authority
    // decision. The fresh original browser still cannot receive private data.
    const response = await f.invoke('authority.after-committed-review', '/review-queue-status', shown.packet);
    expect(response.status).toBe(403);
    expect(await envelope(response)).not.toHaveProperty('result');
    const committed = await f.learning.rows();
    expect(committed.filter((value) => value.kind === 'resolution_learning_review')).toHaveLength(1);
    expect(f.hooks.committed).toBe(1);
    await f.grantRole(SUPPORT_ROLE);
    const recovered = await f.invoke('review.receipt-after-postcommit-revocation', '/review-queue-status', shown.packet);
    expect(recovered.status).toBe(200);
    const body = await envelope(recovered);
    expect(body.result).toMatchObject({ outcome: 'accepted' });
    expect(await f.learning.rows()).toEqual(committed);
    expect(f.learning.state.modelCalls).toBe(1);
  });

  it('retains a stale unaccepted exact intent and cancels it without obsolete Knowledge authority', async () => {
    const f = await fixture();
    await f.learning.enrollAndVerify(); const delivered = await f.learning.delivered();
    const shown = await inspect(f, delivered, 'STALE-UNACCEPTED:UPPER');
    await changeDraft(f, delivered);
    const before = await f.learning.rows();
    const refused = await f.invoke('review.stale-target', '/review', shown.packet);
    expect(refused.status).toBe(503);
    expect(await f.learning.rows()).toEqual(before);
    const missing = await f.invoke('review.stale-missing-receipt', '/review-receipt', shown.packet);
    expect(missing.status).toBe(200);
    expect(await envelope(missing)).toEqual({ result: null, csrfToken: csrf });
    expect(await f.learning.rows()).toEqual(before);
    await f.revokeKnowledge();
    const cancelled = await f.invoke('review.cancel-new-exact', '/review-cancel', shown.packet);
    expect(cancelled.status).toBe(200);
    expect((await envelope(cancelled)).result).toMatchObject({ outcome: 'cancelled', ticketId: learningTicketId });
    const rows = await f.learning.rows();
    expect(rows.filter((value) => value.kind === 'resolution_learning_review')).toHaveLength(0);
    const receipt = await f.invoke('review.receipt-cancelled-exact', '/review-receipt', shown.packet);
    expect(receipt.status).toBe(200);
    expect((await envelope(receipt)).result).toMatchObject({ outcome: 'cancelled', ticketId: learningTicketId });
    expect(await f.learning.rows()).toEqual(rows);
  });

  it('rebuilds a genuine public SDK transaction in a later invocation after a native opaque-version conflict', async () => {
    const f = await fixture();
    await f.learning.enrollAndVerify(); const delivered = await f.learning.delivered();
    const shown = await inspect(f, delivered, 'REAL-CONFLICT-RETRY:UPPER');
    expect((await f.invoke('review.conflict-admission', '/review-queue', shown.packet)).status).toBe(202);
    expect(await f.deliver('review.proof-before-version-conflict')).toEqual({ acknowledgements: 0, delays: [30] });
    f.hooks.armed = true;
    let entered = false;
    f.hooks.beforeCommit = async () => {
      delete f.hooks.beforeCommit; entered = true; await f.rewriteTicketVersion();
    };
    expect(await f.deliver('review.real-version-conflict')).toEqual({ acknowledgements: 0, delays: [30] });
    expect(entered).toBe(true);
    expect(f.hooks.conflicts).toBeGreaterThanOrEqual(1);
    expect(f.hooks.committed).toBe(0);
    expect((await f.learning.rows()).filter((value) => value.kind === 'resolution_learning_review')).toHaveLength(0);
    // The configured lease is25s. Keep the exact command, let that old claim
    // expire, and run a new physical P2 invocation with fresh proof and CAS.
    f.learning.advance(25_001);
    expect(await f.deliver('review.real-version-conflict-retry')).toEqual({ acknowledgements: 1, delays: [] });
    const response = await f.invoke('review.real-version-conflict-receipt', '/review-queue-status', shown.packet);
    expect(response.status).toBe(200);
    expect((await envelope(response)).result).toMatchObject({ outcome: 'accepted' });
    expect(f.hooks.conflicts).toBeGreaterThanOrEqual(1);
    expect(f.hooks.committed).toBe(1);
    expect((await f.learning.rows()).filter((value) => value.kind === 'resolution_learning_review')).toHaveLength(1);
    expect(f.learning.state.modelCalls).toBe(1);
  });

  for (const published of [false, true]) {
    it('measures real multiple contributors with ' + (published ? 'current and published provenance' : 'current provenance only'), async () => {
      const f = await fixture();
      const delivered = await multipleContributors(f, published);
      const before = await f.learning.rows();
      const shown = await inspect(f, delivered, 'MULTI-CONTRIBUTOR:' + (published ? 'PUBLISHED' : 'CURRENT'));
      expect(await f.learning.rows()).toEqual(before);
      expect(shown.intent.target).toEqual(delivered.work.target);
      expect((await f.invoke('review.multi-contributor-admission', '/review-queue', shown.packet)).status).toBe(202);
      expect(await f.deliver('review.multi-contributor-proof')).toEqual({ acknowledgements: 0, delays: [30] });
      expect(await f.deliver('review.multi-contributor-commit')).toEqual({ acknowledgements: 1, delays: [] });
      const response = await f.invoke('review.multi-contributor', '/review-queue-status', shown.packet);
      expect(response.status).toBe(200);
      expect((await envelope(response)).result).toMatchObject({ outcome: 'accepted' });
      expect((await f.learning.rows()).filter((value) => value.kind === 'resolution_learning_review')).toHaveLength(1);
      expect(f.learning.state.modelCalls).toBe(2);
    });
  }
});


describe('combined registered staged-learning and human engineering composition', () => {
  it('emits both current capabilities and preserves both routed SDK paths within each physical budget', async () => {
    const f = await fixture(true); await f.learning.enrollAndVerify();
    const delivered = await f.learning.delivered();
    const ticketPath = '/api/support/admin/tickets/' + learningTicketId;
    const detailRequest = () => new Request(IDENTITY_ISSUER + ticketPath,
      { headers: new Headers(f.request('').headers) });
    const current = await f.send('combined.detail', detailRequest());
    expect(current.status).toBe(200);
    expect(await envelope(current)).toMatchObject({ learningEnabled: true,
      learningStagedReviewEnabled: true, engineeringEnabled: true, engineeringReviewEnabled: false });
    const inspected = await inspect(f, delivered, 'COMBINED-EXACT-UPPERCASE-REVIEW');
    expect(inspected.intent).toMatchObject({ ticketId: learningTicketId, reviewerId: f.principalId });
    const ticket = (await f.learning.application.readStaffTicket(f.learning.actors.staff, learningTicketId)).ticket;
    const enrollment = JSON.stringify({ commandId: 'COMBINED-EXACT-UPPERCASE-ENROLL', expectedRevision: ticket.revision });
    const enrollRequest = () => new Request(IDENTITY_ISSUER + ticketPath + '/engineering/enroll',
      { method: 'POST', headers: new Headers(f.request('', enrollment).headers), body: enrollment });
    const accepted = await f.send('combined.engineering.enroll', enrollRequest());
    expect(accepted.status).toBe(200); const acknowledgement = await envelope(accepted);
    const rows = await f.learning.rows();
    const replay = await f.send('combined.engineering.replay', enrollRequest());
    expect(replay.status).toBe(200); expect(await envelope(replay)).toEqual(acknowledgement);
    expect(await f.learning.rows()).toEqual(rows);
    f.engineeringState.enabled = false;
    const learningOnly = await f.send('combined.detail.engineering-off', detailRequest());
    expect(learningOnly.status).toBe(200);
    expect(await envelope(learningOnly)).toMatchObject({ learningEnabled: true,
      learningStagedReviewEnabled: true, engineeringEnabled: false, engineeringReviewEnabled: false });
    expect(f.learning.state.modelCalls).toBe(1); expect(await f.learning.rows()).toEqual(rows);
  });

  it('requires current stored Support authority on both surfaces after either factory observed it', async () => {
    const f = await fixture(true); await f.learning.enrollAndVerify(); await f.learning.delivered();
    const path = '/api/support/admin/tickets/' + learningTicketId;
    const current = await f.send('combined.detail.before-revoke', new Request(IDENTITY_ISSUER + path,
      { headers: new Headers(f.request('').headers) }));
    expect(current.status).toBe(200); expect(await envelope(current)).toMatchObject({ engineeringEnabled: true });
    await f.revokeRole(SUPPORT_ROLE); const rows = await f.learning.rows();
    for (const suffix of ['', '/engineering']) {
      const denied = await f.send('combined.role-denied' + suffix, new Request(IDENTITY_ISSUER + path + suffix,
        { headers: new Headers(f.request('').headers) }));
      expect(denied.status).toBe(403); expect(await envelope(denied)).not.toHaveProperty('result');
    }
    expect(await f.learning.rows()).toEqual(rows); expect(f.learning.state.modelCalls).toBe(1);
  });
});
