import { hasPermission, type AccessContext } from '@pegma/authorization-core';
import {
  KnowledgeBaseAuthorizationError,
  KnowledgeBaseNotFoundError,
  RepositoryConflictError,
  type KnowledgeBaseApplication,
} from '@pegma/knowledge-base-application';
import { knowledgePermissions } from '@pegma/knowledge-base-contracts';
import type { DurableRateLimiter } from '@pegma/rate-limit';
import type { Clock } from '@pegma/spine';
import { learningTargetBinding, type LearningCheckPolicyPort } from '@pegma/support-desk-ai';
import { supportPermissions, type ResolutionLearningTarget } from '@pegma/support-desk-application';
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
import type { SupportLearningRuntime } from './support-learning';

/** Trusted composition only. This module registers no route or worker. */
export interface SupportLearningHandlerOptions extends AgentBrowserOptions {
  /** Independent of generation: an enabled surface can still withdraw sources. */
  readonly enabled?: () => boolean;
  readonly runtime: () => SupportLearningRuntime;
  readonly knowledge: Pick<KnowledgeBaseApplication, 'getDraft' | 'getProvenance'>;
  readonly reviewPolicy: LearningCheckPolicyPort;
  readonly clock: Clock;
  /** An existing host durable limiter, not a second admission ledger. */
  readonly limiter: DurableRateLimiter;
}

type Operation = 'source' | 'work' | 'proposal' | 'enroll' | 'evidence' | 'review' | 'withdraw' | 'invalidate';
const path = /^\/api\/support\/admin\/tickets\/([A-Za-z0-9._~-]{1,200})\/learning(?:\/(work|proposal|enroll|evidence|review|withdraw|invalidate))?$/u;

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
  if (operation === 'review') return supportPermissions.learningReview;
  if (operation === 'withdraw') return supportPermissions.learningWithdraw;
  if (operation === 'enroll' || operation === 'evidence' || operation === 'invalidate')
    return supportPermissions.learningEvidenceSubmit;
  return supportPermissions.learningRead;
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

async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sameTarget(left: ResolutionLearningTarget | undefined, right: ResolutionLearningTarget): boolean {
  return left !== undefined && left.articleId === right.articleId && left.collectionId === right.collectionId &&
    left.articleRevision === right.articleRevision && left.contentHash === right.contentHash &&
    left.sourceSnapshotGeneration === right.sourceSnapshotGeneration && left.sourceSnapshotHash === right.sourceSnapshotHash &&
    left.orderedReferencesHash === right.orderedReferencesHash;
}

/**
 * Unregistered staff HTTP seam. Original browser credentials are fenced before
 * and after every awaited boundary, including committed writes and failures.
 * A withheld ACK does not roll back an SDK mutation: retry the original packet.
 */
export function createSupportLearningHandlers(options: SupportLearningHandlerOptions) {
  const resolve = createAgentPrincipalResolver(options);
  function enabled() {
    try { return options.enabled?.() === true; } catch { return false; }
  }
  return async function handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const match = path.exec(url.pathname);
    if (match === null) return null;
    if (!enabled()) return json({ error: 'support_learning_disabled' }, { status: 503 });
    const ticketId = match[1];
    if (ticketId === undefined) return json({ error: 'invalid_request' }, { status: 400 });
    const name = match[2] ?? 'source';
    const operation: Operation = name === 'work' || name === 'proposal' || name === 'enroll' ||
      name === 'evidence' || name === 'review' || name === 'withdraw' || name === 'invalidate'
      ? name : 'source';
    const mutation = operation !== 'source' && operation !== 'work' && operation !== 'proposal';
    const permission = operationPermission(operation);
    const requiresKnowledge = operation === 'proposal' || operation === 'review';
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
      const fresh = await browser.current();
      if (!enabled()) throw new ApiError(503, 'support_learning_disabled');
      ceiling ??= structuredClone(fresh.access);
      const access: AccessContext = {
        principalId: ceiling.principalId,
        policyVersion: fresh.access.policyVersion,
        roles: fresh.access.roles.filter((role) => ceiling?.roles.includes(role)),
        entitlements: fresh.access.entitlements.filter((entry) => ceiling?.entitlements.includes(entry)),
        permissions: fresh.access.permissions.filter((entry) => ceiling?.permissions.includes(entry)),
      };
      for (const required of [permission, supportPermissions.queueRead,
        ...(requiresKnowledge ? [knowledgePermissions.draftRead, knowledgePermissions.provenanceRead] : [])]) {
        if (!hasPermission(access, required)) throw new ApiError(403, 'forbidden');
      }
      return { access, csrfToken: fresh.authenticated.csrfToken };
    }
    async function awaited<Value>(run: (access: AccessContext) => Promise<Value>): Promise<Value> {
      const actor = await current();
      const result = await run(actor.access);
      await current();
      return result;
    }
    // Resolve the current real KB target; browser input never supplies provenance,
    // product/build, reviewer identity, policy, or proof timestamps.
    async function proposal(generation: number, expectedWorkGeneration?: number) {
      const source = await awaited((access) => options.runtime().readSource(access, ticketId));
      if (source.sourceGeneration !== generation || source.state !== 'eligible')
        throw new ApiError(409, 'source_changed');
      const work = await awaited((access) => options.runtime().readWork(access, { ticketId, sourceGeneration: generation }));
      if (work.target === undefined) throw new ApiError(409, 'proposal_unavailable');
      const articleId = work.target.articleId;
      const draft = await awaited((access) => options.knowledge.getDraft(access, { articleId }));
      const provenance = await awaited((access) => options.knowledge.getProvenance(access, { articleId }));
      const target = await awaited(async () => learningTargetBinding(draft.revision, provenance.snapshot));
      if (!sameTarget(work.target, target))
        throw new ApiError(409, 'proposal_changed');
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new ApiError(503, 'review_policy_unavailable')); }, 10_000);
      });
      const policy = await (async () => {
        try {
          return await awaited(() => Promise.race([
            options.reviewPolicy.resolvePolicy(work.checkPolicyVersion, controller.signal), deadline,
          ]));
        } finally {
          if (timer !== undefined) clearTimeout(timer);
          controller.abort();
        }
      })();
      if (policy.outcome !== 'ready') throw new ApiError(503, 'review_policy_unavailable');
      const now = Date.parse(options.clock.now());
      const verifiedAt = Date.parse(policy.policy.verifiedAt);
      const until = Date.parse(policy.policy.validUntil);
      if (![now, verifiedAt, until].every(Number.isFinite) || verifiedAt > now || until <= now ||
        (work.checkPolicyVersion !== undefined && policy.policy.version !== work.checkPolicyVersion))
        throw new ApiError(503, 'review_policy_unavailable');
      const closing = await awaited((access) => options.runtime().readWork(access, { ticketId, sourceGeneration: generation }));
      if (closing.workGeneration !== work.workGeneration || !sameTarget(closing.target, target))
        throw new ApiError(409, 'proposal_changed');
      const actor = await current();
      const reviewGeneration = expectedWorkGeneration ?? work.workGeneration;
      const reviewBindingHash = await awaited(() => digest([
        'pegma.support-learning.review.v1', actor.access.principalId, ticketId,
        generation, reviewGeneration, work.sourceBindingHash, target,
        [policy.policy.version, policy.policy.binding, policy.policy.verifiedAt, policy.policy.validUntil],
      ]));
      return { work, target, draft, policyVersion: policy.policy.version, reviewBindingHash, reviewGeneration };
    }
    try {
      if (request.method !== (mutation ? 'POST' : 'GET')) throw new ApiError(405, 'method_not_allowed');
      if (url.hash !== '' || ((operation !== 'work' && operation !== 'proposal') && url.search !== ''))
        throw new ApiError(400, 'invalid_request');
      const initial = await current();
      await enforceRateLimit(options.limiter, initial.access.principalId);
      await current();
      let result: unknown;
      if (operation === 'source') {
        const source = await awaited((access) => options.runtime().readSource(access, ticketId));
        result = { ticketId, sourceGeneration: source.sourceGeneration, resolutionCycle: source.resolutionCycle,
          state: source.state, reconciliationPending: source.reconciliationPending,
          ...(source.heldReason === undefined ? {} : { heldReason: source.heldReason }) };
      } else if (operation === 'work') {
        const generation = sourceGeneration(url);
        const work = await awaited((access) => options.runtime().readWork(access, { ticketId, sourceGeneration: generation }));
        // Candidate/draft payloads and proof references require the KB-gated proposal route.
        result = { ticketId, sourceGeneration: work.sourceGeneration, workGeneration: work.workGeneration,
          status: work.status, stage: work.stage, hasProposal: work.target !== undefined,
          ...(work.heldReason === undefined ? {} : { heldReason: work.heldReason }) };
      } else if (operation === 'proposal') {
        const value = await proposal(sourceGeneration(url));
        result = { ticketId, sourceGeneration: value.work.sourceGeneration,
          expectedWorkGeneration: value.reviewGeneration, draft: value.draft,
          reviewBindingHash: value.reviewBindingHash };
      } else {
        const body = await awaited(() => readJson(request, { timeoutMs: 10_000 }));
        if (operation === 'enroll') {
          const packet = exactObject(body, ['commandId', 'expectedRevision']);
          const clientCommandId = boundedString(packet.commandId, 1, 200);
          const expectedRevision = integer(packet.expectedRevision);
          result = await awaited((access) => options.runtime().enroll(access, {
            ticketId, clientCommandId, expectedRevision,
          }));
        } else if (operation === 'evidence') {
          const packet = exactObject(body, ['commandId', 'expectedRevision', 'resolutionCycle', 'solutionMessageId', 'verificationReference']);
          const clientCommandId = boundedString(packet.commandId, 1, 200);
          const expectedRevision = integer(packet.expectedRevision);
          const resolutionCycle = integer(packet.resolutionCycle);
          const solutionMessageId = boundedString(packet.solutionMessageId, 1, 200);
          const verificationReference = boundedString(packet.verificationReference, 1, 200);
          result = await awaited((access) => options.runtime().submitVerifiedFix(access, {
            ticketId, clientCommandId, expectedRevision, resolutionCycle,
            evidence: { kind: 'staff_verified_fix', solutionMessageId, verificationReference },
          }));
        } else if (operation === 'review') {
          const packet = optionalKeysObject(body, ['commandId', 'sourceGeneration', 'expectedWorkGeneration', 'reviewBindingHash', 'decision'], ['reason']);
          const commandId = boundedString(packet.commandId, 1, 200);
          const generation = integer(packet.sourceGeneration);
          const expectedWorkGeneration = integer(packet.expectedWorkGeneration);
          const expectedHash = boundedString(packet.reviewBindingHash, 64, 64);
          if (!/^[0-9a-f]{64}$/u.test(expectedHash) || (packet.decision !== 'approve' && packet.decision !== 'reject'))
            throw new ApiError(400, 'invalid_request');
          const decision = packet.decision;
          const reason = packet.reason === undefined ? undefined : boundedString(packet.reason, 1, 200);
          const value = await proposal(generation, expectedWorkGeneration);
          if (value.reviewBindingHash !== expectedHash) throw new ApiError(409, 'proposal_changed');
          result = await awaited((access) => options.runtime().reviewProposal(access, {
            ticketId, clientCommandId: commandId, sourceGeneration: generation, expectedWorkGeneration,
            target: value.target, policyVersion: value.policyVersion, decision,
            ...(reason === undefined ? {} : { reason }),
          }));
        } else if (operation === 'invalidate') {
          const packet = exactObject(body, ['commandId', 'reason']);
          if (packet.reason !== 'evidence_revoked' && packet.reason !== 'product_binding_revoked' && packet.reason !== 'check_policy_revoked')
            throw new ApiError(400, 'invalid_request');
          const reason = packet.reason;
          const clientCommandId = boundedString(packet.commandId, 1, 200);
          result = await awaited((access) => options.runtime().invalidate(access, {
            ticketId, clientCommandId, reason,
          }));
        } else {
          const packet = exactObject(body, ['commandId', 'reason']);
          if (packet.reason !== 'privacy_withdrawal' && packet.reason !== 'source_access_revoked' && packet.reason !== 'source_deleted')
            throw new ApiError(400, 'invalid_request');
          const reason = packet.reason;
          const clientCommandId = boundedString(packet.commandId, 1, 200);
          result = await awaited((access) => options.runtime().withdraw(access, {
            ticketId, clientCommandId, reason,
          }));
        }
      }
      const final = await current();
      return json({ result, csrfToken: final.csrfToken });
    } catch (error) {
      let failure = error;
      // Denial/outage after an awaited failure wins over a stale earlier error.
      try { await current(); } catch (authorityError) { failure = authorityError; }
      const value = mapped(failure);
      return json({ error: value.code }, { status: value.status,
        headers: value.retryAfterSeconds === undefined ? {} : { 'Retry-After': String(value.retryAfterSeconds) } });
    }
  };
}
