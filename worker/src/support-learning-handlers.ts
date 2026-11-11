import { hasPermission, type AccessContext } from '@pegma/authorization-core';
import {
  KnowledgeBaseAuthorizationError,
  KnowledgeBaseNotFoundError,
  RepositoryConflictError,
} from '@pegma/knowledge-base-application';
import { knowledgePermissions } from '@pegma/knowledge-base-contracts';
import type { DurableRateLimiter } from '@pegma/rate-limit';
import type { LearningReviewIntent } from '@pegma/support-desk-ai';
import { supportPermissions } from '@pegma/support-desk-application';
import {
  createAgentPrincipalResolver,
  type AgentBrowserOptions,
} from './agent-authority';
import {
  ApiError, authenticate, boundedString, enforceRateLimit, exactObject,
  json, optionalKeysObject, readJson,
} from './api-auth';
import { mapSupportError } from './support-desk';
import { supportHumanBrowser } from './support-human-auth';
import type { LearningReviewIntentPacket, SupportLearningRuntime } from './support-learning';

/** Trusted composition only. This module registers no route or worker. */
export interface SupportLearningHandlerOptions extends AgentBrowserOptions {
  /** Independent of generation: an enabled surface can still withdraw sources. */
  readonly enabled?: () => boolean;
  readonly stagedReviewsEnabled?: () => boolean;
  readonly runtime: () => SupportLearningRuntime;
  /** An existing host durable limiter, not a second admission ledger. */
  readonly limiter: DurableRateLimiter;
}

type Operation = 'source' | 'work' | 'proposal' | 'enroll' | 'enroll-recovery' | 'evidence' | 'evidence-recovery' | 'review' | 'review-receipt' | 'review-cancel' | 'review-queue' | 'review-queue-status' | 'review-queue-cancel' | 'withdraw' | 'invalidate';
const path = /^\/api\/support\/admin\/tickets\/([A-Za-z0-9._~-]{1,200})\/learning(?:\/(work|proposal|enroll|enroll-recovery|evidence|evidence-recovery|review|review-receipt|review-cancel|review-queue|review-queue-status|review-queue-cancel|withdraw|invalidate))?$/u;

function integer(value: unknown, minimum = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
    throw new ApiError(400, 'invalid_request');
  return value;
}

function sourceGeneration(url: URL): number {
  if (url.searchParams.size !== 1 || url.searchParams.getAll('sourceGeneration').length !== 1)
    throw new ApiError(400, 'invalid_request');
  const value = url.searchParams.get('sourceGeneration');
  if (value === null || !/^[1-9][0-9]*$/u.test(value))
    throw new ApiError(400, 'invalid_request');
  return integer(Number(value));
}

function operationPermission(operation: Operation): string {
  if (operation.startsWith('review')) return supportPermissions.learningReview;
  if (operation === 'withdraw') return supportPermissions.learningWithdraw;
  if (operation === 'enroll' || operation === 'enroll-recovery' || operation === 'evidence' || operation === 'evidence-recovery' || operation === 'invalidate')
    return supportPermissions.learningEvidenceSubmit;
  return supportPermissions.learningRead;
}

function reviewIntent(raw: unknown, ticketId: string): LearningReviewIntent {
  const value = exactObject(raw, ['reviewerId', 'ticketId', 'sourceGeneration', 'expectedWorkGeneration', 'target', 'policy']);
  const target = exactObject(value.target, ['articleId', 'collectionId', 'articleRevision', 'contentHash',
    'sourceSnapshotGeneration', 'sourceSnapshotHash', 'orderedReferencesHash']);
  const policy = exactObject(value.policy, ['version', 'binding', 'verifiedAt', 'validUntil']);
  const scalar = (input: unknown) => boundedString(input, 1, 200);
  const hash = (input: unknown) => {
    const result = boundedString(input, 64, 64);
    if (!/^[0-9a-f]{64}$/u.test(result)) throw new ApiError(400, 'invalid_request');
    return result;
  };
  const stamp = (input: unknown) => {
    const result = boundedString(input, 1, 40); const parsed = Date.parse(result);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== result)
      throw new ApiError(400, 'invalid_request');
    return result; // Historical receipt/cancel must accept an expired snapshot.
  };
  if (value.ticketId !== ticketId) throw new ApiError(400, 'invalid_request');
  return { reviewerId: scalar(value.reviewerId), ticketId,
    sourceGeneration: integer(value.sourceGeneration), expectedWorkGeneration: integer(value.expectedWorkGeneration),
    target: { articleId: scalar(target.articleId), collectionId: scalar(target.collectionId),
      articleRevision: integer(target.articleRevision), contentHash: hash(target.contentHash),
      sourceSnapshotGeneration: integer(target.sourceSnapshotGeneration, 0),
      sourceSnapshotHash: hash(target.sourceSnapshotHash), orderedReferencesHash: hash(target.orderedReferencesHash) },
    policy: { version: scalar(policy.version), binding: scalar(policy.binding),
      verifiedAt: stamp(policy.verifiedAt), validUntil: stamp(policy.validUntil) } };
}

function mapped(error: unknown) {
  if (error instanceof ApiError) return error;
  if (error instanceof KnowledgeBaseAuthorizationError)
    return new ApiError(403, 'forbidden');
  if (error instanceof KnowledgeBaseNotFoundError)
    return new ApiError(404, 'not_found');
  if (error instanceof RepositoryConflictError)
    return new ApiError(409, 'conflict');
  const result = mapSupportError(error);
  // Unknown dependency failures are opaque; no raw model, source or SDK errors.
  return new ApiError(result.status >= 500 ? 503 : result.status,
    result.status >= 500 ? 'support_learning_unavailable' : result.code,
    result.retryAfterSeconds);
}

function failureResponse(error: unknown): Response {
  const value = mapped(error);
  return json({ error: value.code }, { status: value.status,
    headers: value.retryAfterSeconds === undefined ? {} : { 'Retry-After': String(value.retryAfterSeconds) } });
}

/**
 * Optional staff HTTP seam. Check current authority for the original browser
 * before each SDK operation and before returning its result or failure.
 * A committed SDK mutation can outlive its ACK. Recover the original packet.
 */
export function createSupportLearningHandlers(options: SupportLearningHandlerOptions) {
  const resolve = createAgentPrincipalResolver(options);
  function enabled() {
    try { return options.enabled?.() === true; } catch { return false; }
  }
  function stagedEnabled() {
    try { return options.stagedReviewsEnabled?.() === true; } catch { return false; }
  }
  return async function handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const match = path.exec(url.pathname);
    if (match === null) return null;
    if (!enabled()) return json({ error: 'support_learning_disabled' }, { status: 503 });
    const ticketId = match[1];
    if (ticketId === undefined) return json({ error: 'invalid_request' }, { status: 400 });
    const name = match[2] ?? 'source';
    const operation: Operation = name === 'work' || name === 'proposal' || name === 'enroll' || name === 'enroll-recovery' ||
      name === 'evidence' || name === 'evidence-recovery' || name === 'review' || name === 'review-receipt' || name === 'review-cancel' || name === 'review-queue' || name === 'review-queue-status' || name === 'review-queue-cancel' || name === 'withdraw' || name === 'invalidate'
      ? name : 'source';
    const mutation = operation !== 'source' && operation !== 'work' && operation !== 'proposal';
    const permission = operationPermission(operation);
    const queued = operation.startsWith('review-queue');
    if (queued && !stagedEnabled()) return json({ error: 'support_learning_disabled' }, { status: 503 });
    const requiresKnowledge = operation === 'proposal';
    const browser = supportHumanBrowser(request, {
      sessions: options.sessions,
      async authenticate(incoming) {
        const value = await authenticate(incoming, options);
        if (value === null) throw new ApiError(401, 'authentication_required');
        return value;
      },
      async access(authenticated) {
        const value = await resolve(authenticated.link.subject);
        if (value === null) throw new ApiError(401, 'authentication_required');
        return value;
      },
      permission,
      mutation,
    });
    let ceiling: AccessContext | undefined;
    async function current() {
      if (!enabled()) throw new ApiError(503, 'support_learning_disabled');
      if (queued && !stagedEnabled()) throw new ApiError(503, 'support_learning_disabled');
      const fresh = await browser.current();
      if (!enabled()) throw new ApiError(503, 'support_learning_disabled');
      if (queued && !stagedEnabled()) throw new ApiError(503, 'support_learning_disabled');
      ceiling ??= structuredClone(fresh.access);
      const access: AccessContext = {
        principalId: ceiling.principalId,
        policyVersion: fresh.access.policyVersion,
        roles: fresh.access.roles.filter((role) => ceiling?.roles.includes(role)),
        entitlements: fresh.access.entitlements.filter((entry) => ceiling?.entitlements.includes(entry)),
        permissions: fresh.access.permissions.filter((entry) => ceiling?.permissions.includes(entry)),
      };
      for (const required of [permission, supportPermissions.queueRead,
        ...(operation === 'proposal' ? [supportPermissions.learningReview] : []),
        ...(requiresKnowledge ? [knowledgePermissions.draftRead, knowledgePermissions.provenanceRead] : [])]) {
        if (!hasPermission(access, required)) throw new ApiError(403, 'forbidden');
      }
      return { access, csrfToken: fresh.authenticated.csrfToken };
    }
    async function withCurrentAccess<Value>(run: (access: AccessContext) => Promise<Value>): Promise<Value> {
      return run((await current()).access);
    }
    try {
      if (request.method !== (mutation ? 'POST' : 'GET')) throw new ApiError(405, 'method_not_allowed');
      if (url.hash !== '' || ((operation !== 'work' && operation !== 'proposal') && url.search !== ''))
        throw new ApiError(400, 'invalid_request');
      const principalId = (await current()).access.principalId;
      await enforceRateLimit(options.limiter, principalId);
      let result: unknown;
      let responseStatus = 200;
      if (operation === 'source') {
        const source = await withCurrentAccess((access) => options.runtime().readSource(access, ticketId));
        result = { ticketId, sourceGeneration: source.sourceGeneration, resolutionCycle: source.resolutionCycle,
          state: source.state, reconciliationPending: source.reconciliationPending,
          ...(source.heldReason === undefined ? {} : { heldReason: source.heldReason }) };
      } else if (operation === 'work') {
        const generation = sourceGeneration(url);
        const work = await withCurrentAccess((access) => options.runtime().readWork(access, { ticketId, sourceGeneration: generation }));
        // Candidate/draft payloads and proof references require the KB-gated proposal route.
        result = { ticketId, sourceGeneration: work.sourceGeneration, workGeneration: work.workGeneration,
          status: work.status, stage: work.stage, hasProposal: work.target !== undefined,
          ...(work.heldReason === undefined ? {} : { heldReason: work.heldReason }) };
      } else if (operation === 'proposal') {
        const value = await withCurrentAccess((access) => options.runtime().prepareReviewIntent(access, {
          ticketId, sourceGeneration: sourceGeneration(url),
        }));
        result = { ticketId, intent: value.intent, draft: value.draft };
      } else {
        // Recheck after the limiter and before reading the bounded body.
        // The SDK operation resolves current authority again after the read.
        const body = await withCurrentAccess(() => readJson(request, { timeoutMs: 10_000 }));
        if (operation === 'enroll' || operation === 'enroll-recovery') {
          const packet = exactObject(body, ['commandId', 'expectedRevision']);
          const clientCommandId = boundedString(packet.commandId, 1, 200);
          const expectedRevision = integer(packet.expectedRevision);
          result = await withCurrentAccess(async (access) => options.runtime()[operation === 'enroll' ? 'enroll' : 'recoverEnrollment'](access, {
            ticketId, clientCommandId, expectedRevision,
          }));
        } else if (operation === 'evidence' || operation === 'evidence-recovery') {
          const packet = exactObject(body, ['commandId', 'expectedRevision', 'resolutionCycle', 'solutionMessageId', 'verificationReference']);
          const clientCommandId = boundedString(packet.commandId, 1, 200);
          const expectedRevision = integer(packet.expectedRevision);
          const resolutionCycle = integer(packet.resolutionCycle);
          const solutionMessageId = boundedString(packet.solutionMessageId, 1, 200);
          const verificationReference = boundedString(packet.verificationReference, 1, 200);
          result = await withCurrentAccess(async (access) => options.runtime()[operation === 'evidence' ? 'submitVerifiedFix' : 'recoverVerifiedFix'](access, {
            ticketId, clientCommandId, expectedRevision, resolutionCycle,
            evidence: { kind: 'staff_verified_fix', solutionMessageId, verificationReference },
          }));
        } else if (operation.startsWith('review')) {
          const packet = optionalKeysObject(body, ['commandId', 'intent', 'decision'], ['reason']);
          const clientCommandId = boundedString(packet.commandId, 1, 200);
          const intent = reviewIntent(packet.intent, ticketId);
          if (packet.decision !== 'approve' && packet.decision !== 'reject') throw new ApiError(400, 'invalid_request');
          const reason = packet.reason === undefined ? undefined : boundedString(packet.reason, 1, 200);
          const command: LearningReviewIntentPacket = { clientCommandId, intent, decision: packet.decision,
            ...(reason === undefined ? {} : { reason }) };
          if (intent.reviewerId !== principalId) throw new ApiError(403, 'forbidden');
          const verifyHumanBeforeCommit = async () => {
            const fresh = await current();
            // Admission's receipt lookup precedes old KB prerequisites. A NEW
            // durable intent still requires current KB grants at its guard.
            if (operation === 'review-queue')
              for (const required of [knowledgePermissions.draftRead, knowledgePermissions.provenanceRead])
                if (!hasPermission(fresh.access, required)) throw new ApiError(403, 'forbidden');
          };
          if (operation === 'review-queue') {
            const status = await withCurrentAccess((access) => options.runtime().admitReviewIntent(access, command, verifyHumanBeforeCommit));
            result = status;
            responseStatus = status.outcome === 'pending' ? 202 : 200;
          } else if (operation === 'review-queue-status')
            result = await withCurrentAccess((access) => options.runtime().readStagedReviewStatus(access, command));
          else if (operation === 'review-queue-cancel')
            result = await withCurrentAccess((access) => options.runtime().cancelStagedReview(access, command, verifyHumanBeforeCommit));
          else if (operation === 'review-receipt')
            result = await withCurrentAccess((access) => options.runtime().readReviewReceipt(access, command));
          else if (operation === 'review-cancel')
            result = await withCurrentAccess((access) => options.runtime().cancelReview(access, command, verifyHumanBeforeCommit));
          else result = { outcome: 'accepted', result: await withCurrentAccess((access) =>
            options.runtime().submitReviewIntent(access, command, verifyHumanBeforeCommit)) };
        } else if (operation === 'invalidate') {
          const packet = exactObject(body, ['commandId', 'reason']);
          if (packet.reason !== 'evidence_revoked' && packet.reason !== 'product_binding_revoked' && packet.reason !== 'check_policy_revoked')
            throw new ApiError(400, 'invalid_request');
          const reason = packet.reason;
          const clientCommandId = boundedString(packet.commandId, 1, 200);
          result = await withCurrentAccess((access) => options.runtime().invalidate(access, {
            ticketId, clientCommandId, reason,
          }));
        } else {
          const packet = exactObject(body, ['commandId', 'reason']);
          if (packet.reason !== 'privacy_withdrawal' && packet.reason !== 'source_access_revoked' && packet.reason !== 'source_deleted')
            throw new ApiError(400, 'invalid_request');
          const reason = packet.reason;
          const clientCommandId = boundedString(packet.commandId, 1, 200);
          result = await withCurrentAccess((access) => options.runtime().withdraw(access, {
            ticketId, clientCommandId, reason,
          }));
        }
      }
      // This closing check fences the complete protected runtime operation
      // and its synchronous response projection.
      let final: Awaited<ReturnType<typeof current>>;
      try {
        final = await current();
      } catch (authorityError) {
        // The closing fence supplies the fresh denial. Keep synchronous kill
        // priority here and return its failure directly from this boundary.
        if (!enabled() || (queued && !stagedEnabled()))
          return failureResponse(new ApiError(503, 'support_learning_disabled'));
        return failureResponse(authorityError);
      }
      return json({ result, csrfToken: final.csrfToken }, { status: responseStatus });
    } catch (error) {
      let failure = error;
      // Denial/outage after an awaited failure wins over a stale earlier error.
      try { await current(); } catch (authorityError) { failure = authorityError; }
      return failureResponse(failure);
    }
  };
}
