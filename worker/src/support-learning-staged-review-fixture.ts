import { identityLinkKeyFromVerifiedIdentityClaims } from '@pegma/authorization-identity';
import { createIdentity, createHmacEmailCodeProtector } from '@pegma/identity';
import { createSessionStore } from '@pegma/sessions';
import type { Clock } from '@pegma/spine';
import type { Store } from '@pegma/storage-core';
import { createSupportDeskApplication } from '@pegma/support-desk-application';
import { learningTargetBinding } from '@pegma/support-desk-ai';
import { createAgentPrincipalResolver } from './agent-authority';
import { isPlainObject } from './api-auth';
import { IDENTITY_ISSUER, SESSION_COOKIE } from './identity-api';
import { createIdentityRuntime } from './identity-runtime';
import { createWorker } from './index';
import { CLEANUP_CRON, cleanupLaneAt } from './maintenance-schedule';
import { APPLICATION_SCOPE, KNOWLEDGE_ROLE, SUPPORT_ROLE } from './support-access';
import { createSupportApi } from './support-api';
import { createSupportRuntime } from './support-desk';
import { createSupportLearningRuntime, type SupportLearningRuntimeOptions } from './support-learning';
import { createSupportLearningFixture, learningTicketId } from './support-learning-fixtures';
import { createSupportLearningReviewQueue, type SupportLearningReviewQueueMessage } from './support-learning-review-queue';

const sessionId = 's'.repeat(43);
const csrf = 'c'.repeat(43);
const base = '/api/support/admin/tickets/' + learningTicketId + '/learning';

type WorkerEnvironment = Parameters<ReturnType<typeof createWorker>['queue']>[1];
export interface StagedReviewWorkerHarness {
  /** Native supplies its actual environment, including the metered D1 binding. */
  environment(sender: { send(message: SupportLearningReviewQueueMessage): Promise<void> }): WorkerEnvironment;
  /** Native supplies the public Workers-pool context and continuation waiter. */
  context(): { readonly value: ExecutionContext; finish(): Promise<void> };
}
export interface StagedReviewFixtureOptions {
  /** Real Identity/Sessions clock: current calendar plus learning elapsed time. */
  readonly clockedAuthentication?: boolean;
  /** Delay only; every source observation still comes from the actual SDK. */
  readonly beforeSourceRead?: (ticketId: string) => void | Promise<void>;
}

export async function responseObject(response: Response) {
  const value: unknown = await response.json();
  if (!isPlainObject(value)) throw new Error('Expected the actual HTTP response');
  return value;
}
export function resultObject(value: Record<string, unknown>) {
  if (!isPlainObject(value.result)) throw new Error('Expected the actual SDK result');
  return value.result;
}

/** Shared real SDK/Identity/Sessions/RoleStore fixture. Only broker and the
 * existing fictional product/check/model connectors are scripted. */
export async function createStagedReviewFixture(store: Store, workerHarness?: StagedReviewWorkerHarness,
  fixtureOptions: StagedReviewFixtureOptions = {}) {
  const learning = await createSupportLearningFixture(store, { stagedReviews: true, readScheduling: 'sdk',
    ...(fixtureOptions.beforeSourceRead === undefined ? {} : { beforeSourceRead: fixtureOptions.beforeSourceRead }) });
  const state = { enabled: true, stagedEnabled: true, sendFailure: false, throwingLogger: false,
    targetArticleId: undefined as string | undefined,
    afterDraft: undefined as (() => Promise<void>) | undefined };
  const logger = { log() { if (state.throwingLogger) throw new Error('Synthetic logger failure'); } };
  const identityLinkFromClaims = identityLinkKeyFromVerifiedIdentityClaims;
  const authenticationLearningStartedAt = Date.parse(learning.clock.now());
  const authenticationWallStartedAt = Date.now();
  const authenticationClockStartedAt = fixtureOptions.clockedAuthentication === true
    ? new Date(authenticationWallStartedAt).toISOString() : learning.clock.now();
  const authClock: Clock | undefined = fixtureOptions.clockedAuthentication === true ? {
    now() {
      // Preserve every real touch and logical SDK advance, but anchor absolute
      // session expiry to the same current calendar as the browser fence.
      learning.advance(1);
      return new Date(authenticationWallStartedAt + Date.parse(learning.clock.now()) -
        authenticationLearningStartedAt).toISOString();
    },
  } : undefined;
  const sessionObservations: { readonly at: string; readonly previousLastSeenAt: string | null }[] = [];
  function authority() {
    const base = createIdentityRuntime({ store,
      emailCodeSecretBase64: btoa('q'.repeat(32)), emailFrom: 'Pegma <synthetic@example.test>', emailEnabled: false }, logger);
    let identity = base.identity;
    let sessions = base.sessions;
    if (authClock !== undefined) {
      const [registrationLimiter, authenticationLimiter, emailCodeRequestLimiter, emailCodeVerificationLimiter] = base.limiters;
      if (registrationLimiter === undefined || authenticationLimiter === undefined ||
        emailCodeRequestLimiter === undefined || emailCodeVerificationLimiter === undefined)
        throw new Error('Expected the actual host Identity limiter graph');
      identity = createIdentity({ store, issuer: IDENTITY_ISSUER, rpName: 'Pegma', rpID: 'pegma.dev',
        origins: [IDENTITY_ISSUER], registrationLimiter, authenticationLimiter,
        emailCodeRequestLimiter, emailCodeVerificationLimiter,
        emailCodeProtector: createHmacEmailCodeProtector(new Uint8Array(32).fill(113)), clock: authClock });
      const actualSessions = createSessionStore(store, { logger, clock: authClock });
      sessions = { ...actualSessions, async get(id, at = authClock.now()) {
        const result = await actualSessions.get(id, at);
        sessionObservations.push({ at, previousLastSeenAt: result?.lastSeenAt ?? null });
        return result;
      } };
    }
    const host = createSupportRuntime({ store, identity, sessions, logger, identityLinkFromClaims });
    return { identity, sessions, host, options: { identity, sessions, logger, identityLinkFromClaims, roleStore: host.roleStore } };
  }
  const seed = authority();
  const principalId = learning.actors.staff.principalId;
  const seededIdentity = await seed.identity.provisionVerifiedUser({ principalId, email: 'reviewer@example.test' });
  await seed.sessions.create(sessionId, { principalId, data: JSON.stringify({ version: 1,
    issuer: IDENTITY_ISSUER, subject: principalId, csrfToken: csrf }) });
  for (const role of [SUPPORT_ROLE, KNOWLEDGE_ROLE]) {
    const granted = await seed.host.roleStore.grantRoleAssignmentWithAudit({ assignment: {
      id: 'staged-review-' + role, principalId, role, scope: APPLICATION_SCOPE,
      grantedBy: { kind: 'system', systemId: 'fictional-staged-review' }, grantedAtEpochMs: Date.now(), status: 'active',
    }, auditEventId: 'staged-review-grant-' + role });
    if (granted.status !== 'granted') throw new Error('Real fixture role grant failed');
  }
  const messages: SupportLearningReviewQueueMessage[] = [];
  const sender = { async send(message: SupportLearningReviewQueueMessage) {
    if (state.sendFailure) throw new Error('Synthetic broker failure');
    messages.push(structuredClone(message));
  } };
  const enabled = () => state.enabled;
  const stagedEnabled = () => state.enabled && state.stagedEnabled;
  function graph() {
    const current = authority();
    const resolve = createAgentPrincipalResolver(current.options);
    let queue: ReturnType<typeof createSupportLearningReviewQueue>;
    const learningOptions: Omit<SupportLearningRuntimeOptions, 'staffAccess'> = {
      application: learning.application,
      knowledge: { ...learning.knowledge, async getDraft(...args: Parameters<typeof learning.knowledge.getDraft>) {
        const value = await learning.knowledge.getDraft(...args); await state.afterDraft?.(); return value;
      } },
      sources: learning.sources, clock: learning.clock,
      ports: { ...learning.ports, targets: {
        async resolveScope(...args) {
          const value = await learning.ports.targets.resolveScope(...args);
          return value.outcome === 'ready' && state.targetArticleId !== undefined
            ? { ...value, scope: { ...value.scope, explicitDraftIds: [state.targetArticleId] } } : value;
        },
        async select(input, context) {
          const value = await learning.ports.targets.select(input, context);
          if (value.outcome !== 'selected' || state.targetArticleId === undefined) return value;
          const prior = input.explicitDrafts.find((draft) => draft.articleId === state.targetArticleId);
          if (prior === undefined) return { outcome: 'held' };
          return { ...value, operation: 'update', articleId: prior.articleId,
            draft: { ...value.draft, content: { format: 'plain_text', text: prior.revision.content.text + '\n\n' + value.draft.content.text } } };
        },
      } },
      processingEnabled: () => learning.state.enabled,
      readScheduling: 'sdk',
      stagedReviews: { enabled: stagedEnabled, enqueue: (key) => queue.enqueue(key) },
    };
    const runtime = createSupportLearningRuntime({ ...learningOptions, staffAccess: { resolve } });
    queue = createSupportLearningReviewQueue({ enabled: stagedEnabled, store: () => store, clock: learning.clock, logger,
      sender, runtime: () => runtime.stagedReviewDispatch() });
    const api = createSupportApi({ ...current.options, application: learning.application,
      createLimiter: current.host.createLimiter, replyLimiter: current.host.replyLimiter,
      learningRuntime: learningOptions, learningEnabled: enabled, learningStagedReviewsEnabled: stagedEnabled });
    return { api, queue, runtime };
  }
  function request(suffix: string, body?: string) {
    return new Request(IDENTITY_ISSUER + base + suffix, { method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: SESSION_COOKIE + '=' + sessionId,
        ...(body === undefined ? {} : { Origin: IDENTITY_ISSUER, 'Sec-Fetch-Site': 'same-origin',
          'X-Pegma-CSRF': csrf, 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body }) });
  }
  const worker = () => createWorker({ learningReviews: { enabled: stagedEnabled, create: () => graph() } });
  async function invoke(suffix: string, body?: string) {
    // Memory owns actual HTTP/SDK adapters without inventing a D1 binding.
    // Native exercises the root Worker with its actual environment/context.
    if (workerHarness === undefined) {
      const response = await graph().api(request(suffix, body));
      await response.clone().arrayBuffer(); return response;
    }
    const ctx = workerHarness.context();
    try {
      const response = await worker().fetch(request(suffix, body), workerHarness.environment(sender), ctx.value);
      await response.clone().arrayBuffer(); return response;
    } finally { await ctx.finish(); }
  }
  async function deliver(message: SupportLearningReviewQueueMessage) {
    const observed = { acknowledgements: 0, delays: [] as number[] };
    const batch: MessageBatch<unknown> = { queue: 'pegma-dev-support-learning-reviews',
      metadata: { metrics: { backlogCount: 1, backlogBytes: 0 } },
      messages: [{ id: 'fictional-delivery', attempts: 1, timestamp: new Date(learning.clock.now()), body: message,
        ack() { observed.acknowledgements += 1; }, retry(options) {
          if (options?.delaySeconds === undefined) throw new Error('Expected bounded same-message retry');
          observed.delays.push(options.delaySeconds);
        } }], ackAll() { throw new Error('Expected individual acknowledgement'); },
      retryAll() { throw new Error('Expected individual bounded retry'); } };
    if (workerHarness === undefined) await graph().queue.consume(batch);
    else {
      const ctx = workerHarness.context();
      try { await worker().queue(batch, workerHarness.environment(sender), ctx.value); }
      finally { await ctx.finish(); }
    }
    return observed;
  }
  async function scan() {
    let time = Date.parse('2026-11-11T00:00:00.000Z');
    for (let minute = 0; minute < 32; minute++) {
      const candidate = time + minute * 60_000;
      if (new Date(candidate).getUTCMinutes() !== 59 && cleanupLaneAt(candidate).kind === 'learning_reviews') {
        time = candidate; break;
      }
    }
    if (cleanupLaneAt(time).kind !== 'learning_reviews') throw new Error('Expected exclusive review dispatch lane');
    if (workerHarness === undefined) { await graph().queue.runPage(); return; }
    const ctx = workerHarness.context();
    worker().scheduled({ cron: CLEANUP_CRON, scheduledTime: time, noRetry() {} }, workerHarness.environment(sender), ctx.value);
    await ctx.finish();
  }
  async function checked() {
    await learning.enrollAndVerify();
    return learning.delivered();
  }
  async function multipleContributors(published: boolean) {
    const ticketId = 'staged-secondary-ticket'; const solutionId = 'staged-secondary-solution';
    const old = createSupportDeskApplication({ store, clock: learning.clock });
    await old.createCustomerTicket(learning.actors.customer, { ...learning.command('secondary-create'), ticketId,
      messageId: 'staged-secondary-question', subject: 'A second fictional export', body: 'How do I export another workspace?' });
    await old.replyAsStaff(learning.actors.staff, { ...learning.command('secondary-reply'), ticketId,
      messageId: solutionId, body: 'Choose Export and verify the downloaded workspace.' });
    await old.resolveTicket(learning.actors.staff, { ...learning.command('secondary-resolve'), ticketId });
    const ticket = (await old.readStaffTicket(learning.actors.staff, ticketId)).ticket;
    await learning.runtime.enroll(learning.actors.staff, { ticketId, clientCommandId: 'SECONDARY-ENROLL', expectedRevision: ticket.revision });
    const enrolled = await learning.runtime.readSource(learning.actors.staff, ticketId);
    await learning.runtime.submitVerifiedFix(learning.actors.staff, { ticketId, clientCommandId: 'SECONDARY-EVIDENCE',
      expectedRevision: ticket.revision, resolutionCycle: enrolled.resolutionCycle,
      evidence: { kind: 'staff_verified_fix', solutionMessageId: solutionId, verificationReference: 'FICTIONAL-SECONDARY-VERIFICATION' } });
    const source = await learning.runtime.readSource(learning.actors.staff, ticketId);
    const process = () => learning.runtime.processWork({ ticketId, sourceGeneration: source.sourceGeneration,
      workerId: 'fictional-secondary-worker', leaseMilliseconds: 30_000 });
    if ((await process()).outcome !== 'candidate' || (await process()).outcome !== 'delivered')
      throw new Error('Expected actual secondary KB delivery');
    const secondary = await learning.runtime.readWork(learning.actors.staff, { ticketId, sourceGeneration: source.sourceGeneration });
    if (secondary.target === undefined || secondary.checkPolicyVersion === undefined) throw new Error('Expected actual secondary target');
    const articleId = secondary.target.articleId;
    if (published) {
      const draft = await learning.knowledge.getDraft(learning.actors.staff, { articleId });
      const provenance = await learning.knowledge.getProvenance(learning.actors.staff, { articleId });
      await learning.runtime.reviewProposal(learning.actors.staff, { ticketId, clientCommandId: 'SECONDARY-REVIEW',
        sourceGeneration: source.sourceGeneration, expectedWorkGeneration: secondary.workGeneration,
        target: await learningTargetBinding(draft.revision, provenance.snapshot),
        policyVersion: secondary.checkPolicyVersion, decision: 'approve' });
      await learning.evidenceAndPublish(articleId);
    }
    state.targetArticleId = articleId;
    await learning.enrollAndVerify();
    const primary = await learning.runtime.readSource(learning.actors.staff, learningTicketId);
    const primaryProcess = () => graph().runtime.processWork({ ticketId: learningTicketId,
      sourceGeneration: primary.sourceGeneration, workerId: 'fictional-primary-worker', leaseMilliseconds: 30_000 });
    if ((await primaryProcess()).outcome !== 'candidate' || (await primaryProcess()).outcome !== 'delivered')
      throw new Error('Expected actual merged primary KB delivery');
    const provenance = await learning.knowledge.getProvenance(learning.actors.staff, { articleId });
    return { source: await learning.runtime.readSource(learning.actors.staff, learningTicketId), articleId, provenance, secondaryTicketId: ticketId };
  }
  async function prepare(sourceGeneration: number) {
    const response = await invoke('/proposal?sourceGeneration=' + sourceGeneration);
    if (response.status !== 200) throw new Error('Actual HTTP proposal unavailable: ' + response.status);
    const value = resultObject(await responseObject(response));
    if (!isPlainObject(value.intent)) throw new Error('Expected the actual prepared SDK intent');
    return { body: JSON.stringify({ commandId: 'EXACT-UPPERCASE-STAGED-REVIEW', intent: value.intent, decision: 'approve' }) };
  }
  async function revoke(role: typeof SUPPORT_ROLE | typeof KNOWLEDGE_ROLE) {
    const id = 'staged-review-' + role;
    const row = await seed.host.roleStore.getRoleAssignment(id);
    if (row === null) throw new Error('Expected actual role assignment');
    await seed.host.roleStore.revokeRoleAssignmentWithAudit({ assignmentId: id,
      expectedConcurrencyToken: row.concurrencyToken, revokedBy: { kind: 'system', systemId: 'fictional-staged-review' },
      revokedAtEpochMs: Date.now(), auditEventId: id + '-revoke' });
  }
  return { learning, state, principalId, messages, graph, request, invoke, deliver, scan, checked, multipleContributors, prepare, revoke,
    sessionObservations, authenticationClockStartedAt, identityCreatedAt: seededIdentity.createdAt,
    readSessionAt: (at: string) => seed.sessions.get(sessionId, at),
    destroySession: () => seed.sessions.destroy(sessionId) };
}
