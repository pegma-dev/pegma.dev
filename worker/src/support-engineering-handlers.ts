import { hasPermission, type AccessContext } from '@pegma/authorization-core';
import type { DurableRateLimiter } from '@pegma/rate-limit';
import {
  supportPermissions,
  engineeringPolicyRecords,
  type EngineeringRepositoryPolicy,
  type EngineeringRepositoryDescriptor,
  type EngineeringSourceResult,
  type EngineeringStepResult,
  type EngineeringSourceRecord,
  type EngineeringWorkRecord,
} from '@pegma/support-desk-application';
import { createAgentPrincipalResolver, type AgentBrowserOptions } from './agent-authority';
import {
  ApiError, authenticate, boundedString, enforceRateLimit, exactObject, json, readJson,
} from './api-auth';
import { ADMIN_ROLE } from './support-access';
import { mapSupportError } from './support-desk';
import { supportHumanBrowser } from './support-human-auth';
import type { EngineeringFailurePacket, SupportEngineeringRuntime } from './support-engineering';
import { engineeringProposalView, engineeringReviewIntent } from './support-engineering-review';

/** Immutable server configuration. A key must never be rebound to another repository. */
export interface EngineeringHttpRepository {
  readonly key: string;
  readonly descriptor: EngineeringRepositoryDescriptor;
}

/** Opaque retained JSON, not a token or authority. Never display or log it. */
export interface EngineeringPolicyIntent {
  readonly version: 1;
  readonly actorId: string;
  readonly commandId: string;
  readonly expectedGeneration: number;
  readonly repositoryKeys: readonly string[];
  readonly policy: EngineeringRepositoryPolicy;
}
const policyIntentBytes = 131_072;

function policyKeys(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20) throw new ApiError(400, 'invalid_request');
  const keys = value.map((key) => boundedString(key, 1, 100));
  if (new Set(keys).size !== keys.length || keys.some((key) => key.trim() !== key))
    throw new ApiError(400, 'invalid_request');
  return keys;
}

function normalizedPolicy(raw: unknown): EngineeringRepositoryPolicy {
  try {
    // Public schema validation only. This synthetic envelope is never persisted
    // or claimed to be a real head, generation, digest or authorization proof.
    // Minimum legal generation avoids falsely rejecting an old accepted policy
    // merely because a current generation occupies more serialized digits.
    const value = engineeringPolicyRecords.codec.decode({ partition: 'instance', id: 'policy', json: JSON.stringify({
      kind: 'engineering_policy', partition: 'instance', id: 'policy', generation: 1,
      policyHash: '0'.repeat(64), policy: raw,
    }) });
    if (value.kind !== 'engineering_policy') throw new TypeError('Invalid validation result');
    return value.policy;
  } catch { throw new ApiError(400, 'invalid_request'); }
}

function policyIntent(raw: unknown): EngineeringPolicyIntent {
  const value = exactObject(raw, ['version', 'actorId', 'commandId', 'expectedGeneration', 'repositoryKeys', 'policy']);
  if (value.version !== 1) throw new ApiError(400, 'invalid_request');
  const policy = normalizedPolicy(value.policy);
  const repositoryKeys = policyKeys(value.repositoryKeys);
  if (repositoryKeys.length !== policy.repositories.length) throw new ApiError(400, 'invalid_request');
  const intent: EngineeringPolicyIntent = { version: 1, actorId: boundedString(value.actorId, 1, 200),
    commandId: boundedString(value.commandId, 1, 200), expectedGeneration: integer(value.expectedGeneration, 0),
    repositoryKeys, policy };
  if (new TextEncoder().encode(JSON.stringify({ intent })).byteLength > policyIntentBytes)
    throw new ApiError(413, 'request_too_large');
  return intent;
}

async function intentFingerprint(intent: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(intent)));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Inert assembly only. No route, scheduler, Store or outbound client is registered. */
export interface SupportEngineeringHandlerOptions extends AgentBrowserOptions {
  readonly enabled?: () => boolean;
  /** Separate current human review gate, with strict false as the default. */
  readonly reviewEnabled?: () => boolean;
  readonly runtime: () => SupportEngineeringRuntime;
  readonly readLimiter: DurableRateLimiter;
  readonly mutationLimiter: DurableRateLimiter;
  readonly repositories?: readonly EngineeringHttpRepository[];
}

type Operation = 'review_inbox' | 'source' | 'work' | 'proposal' | 'review' | 'enroll' | 'evidence' | 'withdraw' | 'invalidate' | 'repository' |
  'policy_read' | 'policy_prepare' | 'policy_put' | 'policy_disable';
const ticketPath = /^\/api\/support\/admin\/tickets\/([A-Za-z0-9._~-]{1,200})\/engineering(?:\/(work|proposal|review|enroll|evidence|withdraw|invalidate|repository))?$/u;
const policyPath = '/api/support/admin/engineering/policy';
const reviewInboxPath = '/api/support/admin/engineering/review-inbox';

function reviewBounds(url: URL): { limit: number; cursor?: string } {
  if (
    [...url.searchParams.keys()].some(
      (key) => key !== 'limit' && key !== 'cursor',
    ) ||
    url.searchParams.getAll('limit').length > 1 ||
    url.searchParams.getAll('cursor').length > 1
  )
    throw new ApiError(400, 'invalid_request');
  const limit = url.searchParams.get('limit');
  if (limit !== null && (!/^[1-9][0-9]?$/u.test(limit) || Number(limit) > 10))
    throw new ApiError(400, 'invalid_request');
  const cursor = url.searchParams.get('cursor');
  return {
    limit: limit === null ? 10 : Number(limit),
    ...(cursor === null ? {} : { cursor: boundedString(cursor, 1, 20_000) }),
  };
}

function integer(value: unknown, minimum = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
    throw new ApiError(400, 'invalid_request');
  return value;
}
function fingerprint(value: unknown): string {
  const text = boundedString(value, 64, 64);
  if (!/^[a-f0-9]{64}$/u.test(text)) throw new ApiError(400, 'invalid_request');
  return text;
}
function strings(value: unknown, maximum: number, characters: number, multiline = false): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum)
    throw new ApiError(400, 'invalid_request');
  const result = value.map((entry) => boundedString(entry, 1, characters, { allowMultiline: multiline }));
  if (!multiline && new Set(result).size !== result.length) throw new ApiError(400, 'invalid_request');
  return result;
}
function generation(url: URL): number {
  if (url.searchParams.size !== 1 || url.searchParams.getAll('sourceGeneration').length !== 1)
    throw new ApiError(400, 'invalid_request');
  const value = url.searchParams.get('sourceGeneration');
  if (value === null || !/^[1-9][0-9]*$/u.test(value)) throw new ApiError(400, 'invalid_request');
  return integer(Number(value));
}
function permission(operation: Operation): string {
  if (operation === 'enroll' || operation === 'evidence') return supportPermissions.engineeringEvidenceSubmit;
  if (operation === 'withdraw' || operation === 'invalidate') return supportPermissions.engineeringWithdraw;
  if (operation === 'review_inbox' || operation === 'repository' || operation === 'review') return supportPermissions.engineeringReview;
  if (operation === 'policy_read') return supportPermissions.engineeringPolicyRead;
  if (operation === 'policy_prepare' || operation === 'policy_put' || operation === 'policy_disable') return supportPermissions.engineeringPolicyManage;
  return supportPermissions.engineeringRead;
}
function sourceDto(source: EngineeringSourceRecord) {
  return { ticketId: source.ticketId, sourceGeneration: source.sourceGeneration,
    workGeneration: source.workGeneration, state: source.state, security: source.security,
    hasEvidence: source.evidence !== undefined, hasProductContext: source.product !== undefined,
    destinationCount: source.destinations.length, reconciliationPending: source.reconciliationPending };
}
function workDto(work: EngineeringWorkRecord) {
  return { ticketId: work.ticketId, sourceGeneration: work.sourceGeneration, workGeneration: work.workGeneration,
    status: work.status, stage: work.stage, security: work.security, hasCandidate: work.candidateHash !== undefined,
    hasPreparedProposal: work.proposal !== undefined, hasApproval: work.approval !== undefined,
    hasDispatch: work.dispatch !== undefined };
}
function sourceResultDto(value: EngineeringSourceResult) {
  return { ticketId: value.ticketId, sourceGeneration: value.sourceGeneration, state: value.state, security: value.security };
}
function stepDto(value: EngineeringStepResult) {
  return { ticketId: value.ticketId, sourceGeneration: value.sourceGeneration,
    workGeneration: value.workGeneration, status: value.status };
}
function mapped(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const result = mapSupportError(error);
  return new ApiError(result.status >= 500 ? 503 : result.status,
    result.status >= 500 ? 'support_engineering_unavailable' : result.code, result.retryAfterSeconds);
}

/**
 * Checked proposal reads and explicit approval or rejection require current
 * human authority. The original full SDK command supports receipt-first retry.
 * The public coordinator carries the fresh browser guard to the commit boundary.
 * Worker processing and dispatch use their separate SDK paths.
 */
export function createSupportEngineeringHandlers(options: SupportEngineeringHandlerOptions) {
  const resolve = createAgentPrincipalResolver(options);
  const configured = structuredClone(options.repositories ?? []);
  if (!Array.isArray(configured) || configured.length > 20)
    throw new TypeError('Invalid engineering repository catalog');
  const keys = new Set<string>();
  const identities = new Set<string>();
  for (const entry of configured) {
    const key = entry?.key;
    const id = entry?.descriptor?.repositoryId;
    if (typeof key !== 'string' || key.length < 1 || key.length > 100 || key.trim() !== key ||
      /[\u0000-\u001F\u007F-\u009F]/u.test(key) || keys.has(key) ||
      typeof id !== 'string' || id.length < 1 || id.length > 200 || id.trim() !== id || id.includes('://') ||
      /[\u0000-\u001F\u007F-\u009F]/u.test(id) || identities.has(id) ||
      typeof entry.descriptor.enabled !== 'boolean' || entry.descriptor.publicationMode !== 'approval_required')
      throw new TypeError('Invalid engineering repository catalog');
    keys.add(key); identities.add(id);
  }
  function enabled() { try { return options.enabled?.() === true; } catch { return false; } }
  function repository(key: unknown): EngineeringHttpRepository {
    const name = boundedString(key, 1, 100);
    if (configured.length === 0) throw new ApiError(503, 'repository_configuration_unavailable');
    const found = configured.filter((entry) => entry.key === name);
    if (found.length !== 1) throw new ApiError(400, 'invalid_request');
    return found[0]!;
  }
  return async function handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const match = ticketPath.exec(url.pathname);
    const policy = url.pathname === policyPath || url.pathname === policyPath + '/disable' || url.pathname === policyPath + '/prepare';
    const inbox = url.pathname === reviewInboxPath;
    if (match === null && !policy && !inbox) return null;
    if (!enabled()) return json({ error: 'support_engineering_disabled' }, { status: 503 });
    const ticketId = match?.[1];
    const suffix = match?.[2];
    const operation: Operation = inbox ? 'review_inbox' : policy
      ? url.pathname.endsWith('/disable') ? 'policy_disable' : url.pathname.endsWith('/prepare') ? 'policy_prepare'
        : request.method === 'GET' ? 'policy_read' : 'policy_put'
      : suffix === 'work' || suffix === 'proposal' || suffix === 'review' || suffix === 'enroll' || suffix === 'evidence' || suffix === 'withdraw' ||
        suffix === 'invalidate' || suffix === 'repository' ? suffix : 'source';
    if (operation === 'proposal' || operation === 'review') {
      let admitted = false;
      try { admitted = options.reviewEnabled?.() === true; } catch { /* Default OFF. */ }
      if (!admitted) return json({ error: 'support_engineering_review_disabled' }, { status: 503 });
    }
    const mutation = ![
      'review_inbox',
      'source',
      'work',
      'proposal',
      'policy_read',
    ].includes(operation);
    const required = permission(operation);
    const browser = supportHumanBrowser(request, {
      sessions: options.sessions, mutation, permission: required,
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
    });
    let ceiling: AccessContext | undefined;
    async function current() {
      if (!enabled()) throw new ApiError(503, 'support_engineering_disabled');
      const reviewIsCurrent = () => {
        if (operation !== 'proposal' && operation !== 'review') return;
        let admitted = false;
        try { admitted = options.reviewEnabled?.() === true; } catch { /* Default OFF. */ }
        if (!admitted) throw new ApiError(503, 'support_engineering_review_disabled');
      };
      reviewIsCurrent();
      const fresh = await browser.current();
      reviewIsCurrent();
      if (!enabled()) throw new ApiError(503, 'support_engineering_disabled');
      ceiling ??= structuredClone(fresh.access);
      const access: AccessContext = { principalId: ceiling.principalId, policyVersion: fresh.access.policyVersion,
        roles: fresh.access.roles.filter((entry) => ceiling?.roles.includes(entry)),
        entitlements: fresh.access.entitlements.filter((entry) => ceiling?.entitlements.includes(entry)),
        permissions: fresh.access.permissions.filter((entry) => ceiling?.permissions.includes(entry)) };
      for (const needed of [required, supportPermissions.queueRead])
        if (!hasPermission(access, needed)) throw new ApiError(403, 'forbidden');
      if (policy && !access.roles.includes(ADMIN_ROLE)) throw new ApiError(403, 'forbidden');
      return { access, csrfToken: fresh.authenticated.csrfToken };
    }
    async function awaited<Value>(run: (access: AccessContext) => Promise<Value>): Promise<Value> {
      // Each protected operation starts with current authority. Its successor
      // repeats that fence; the final/catch fence protects every response.
      // Between them, callers only validate/project locally: no output, SDK
      // write or external operation may occur without its own fresh precheck.
      const actor = await current(); return run(actor.access);
    }
    try {
      if (request.method !== (mutation ? 'POST' : 'GET')) throw new ApiError(405, 'method_not_allowed');
      if (url.hash !== '' || (!['review_inbox', 'work', 'proposal'].includes(operation) && url.search !== '')) throw new ApiError(400, 'invalid_request');
      const initial = await current();
      const principalId = initial.access.principalId;
      await enforceRateLimit(mutation ? options.mutationLimiter : options.readLimiter, principalId);
      let result: unknown;
      if (operation === 'review_inbox') {
        const page = await awaited((access) =>
          options.runtime().scanReview(access, reviewBounds(url)),
        );
        result = {
          reviewSources: [...page.reviewSources],
          reviewCandidates: page.reviewCandidates.map(
            ({ ticketId, sourceGeneration }) => ({
              ticketId,
              sourceGeneration,
            }),
          ),
          physicalRows: page.physicalRows,
          pages: page.pages,
          nextCursor: page.nextCursor,
        };
      } else if (operation === 'policy_read') {
        const value = await awaited((access) => options.runtime().readPolicy(access));
        const repositories = value.policy.repositories.flatMap((descriptor) => {
          const entry = configured.find((item) => item.descriptor.repositoryId === descriptor.repositoryId);
          return entry === undefined ? [] : [{ key: entry.key, enabled: descriptor.enabled }];
        });
        result = { generation: value.generation, policyHash: value.policyHash, enabled: value.policy.enabled,
          repositories, unmappedRepositoryCount: value.policy.repositories.length - repositories.length,
          // Full server configuration, including unselected entries. This is
          // not installation, visibility, calibration or export authority.
          catalog: configured.map((entry) => ({ key: entry.key, enabled: entry.descriptor.enabled })) };
      } else if (operation === 'source') {
        if (ticketId === undefined) throw new ApiError(400, 'invalid_request');
        result = sourceDto(await awaited((access) => options.runtime().readSource(access, ticketId)));
      } else if (operation === 'proposal') {
        if (ticketId === undefined) throw new ApiError(400, 'invalid_request');
        const work = await awaited((access) => options.runtime().readWork(access, { ticketId, sourceGeneration: generation(url) }));
        const actor = await current();
        if (!hasPermission(actor.access, supportPermissions.engineeringReview)) throw new ApiError(403, 'forbidden');
        result = await engineeringProposalView(work, actor.access.principalId);
      } else if (operation === 'work') {
        if (ticketId === undefined) throw new ApiError(400, 'invalid_request');
        const sourceGeneration = generation(url);
        const work = await awaited((access) => options.runtime().readWork(access, { ticketId, sourceGeneration }));
        const actor = await current();
        const choice = hasPermission(actor.access, supportPermissions.engineeringReview) &&
          hasPermission(actor.access, supportPermissions.engineeringPolicyRead)
          ? await awaited((access) => options.runtime().readPolicy(access)) : null;
        const repositoryChoices = choice === null ? [] : await Promise.all(configured.flatMap((entry) => {
          const allowed = choice.policy.repositories.find((descriptor) => descriptor.repositoryId === entry.descriptor.repositoryId);
          if (!entry.descriptor.enabled || allowed?.enabled !== true) return [];
          const declared = normalizedPolicy({ enabled: true, repositories: [entry.descriptor] }).repositories[0]!;
          if (JSON.stringify(declared) !== JSON.stringify(allowed)) return [];
          return [intentFingerprint(declared).then((descriptorHash) => ({ key: entry.key,
            repositoryId: entry.descriptor.repositoryId, descriptorHash }))];
        }));
        result = { ...workDto(work), ...(choice === null ? {} : { selection: {
          policyGeneration: choice.generation, policyHash: choice.policyHash,
          repositoryKeys: repositoryChoices.map((entry) => entry.key), repositoryChoices,
        } }) };
      } else {
        const body = await awaited(() => readJson(request, { timeoutMs: 10_000,
          ...(operation === 'policy_put' ? { maxBytes: policyIntentBytes } : {}) }));
        if (operation === 'policy_prepare') {
          const packet = exactObject(body, ['commandId', 'expectedGeneration', 'enabled', 'repositoryKeys']);
          const commandId = boundedString(packet.commandId, 1, 200);
          const expectedGeneration = integer(packet.expectedGeneration, 0);
          if (typeof packet.enabled !== 'boolean') throw new ApiError(400, 'invalid_request');
          const active = packet.enabled;
          const keys = policyKeys(packet.repositoryKeys);
          const currentPolicy = await awaited((access) => options.runtime().readPolicy(access));
          if (currentPolicy.generation !== expectedGeneration) throw new ApiError(409, 'policy_changed');
          const actor = await current();
          result = { intent: policyIntent({ version: 1, actorId: actor.access.principalId, commandId, expectedGeneration,
            repositoryKeys: keys, policy: { enabled: active, repositories: keys.map((key) => repository(key).descriptor) } }) };
        } else if (operation === 'policy_put') {
          const packet = exactObject(body, ['intent']);
          const intent = policyIntent(packet.intent);
          // Identity equality only: never reuse admission roles/permissions.
          // The following protected SDK call performs fresh browser auth.
          if (intent.actorId !== principalId) throw new ApiError(403, 'forbidden');
          // Immutable validation and hashing precede the public SDK receipt.
          // Only a NEW command reaches the actual026 catalog/browser guard.
          const binding = await intentFingerprint(intent);
          const value = await awaited((access) => options.runtime().putPolicy(access, {
            clientCommandId: intent.commandId, expectedGeneration: intent.expectedGeneration, policy: intent.policy,
          }, binding, async () => {
            let declared: EngineeringRepositoryPolicy;
            try { declared = normalizedPolicy({ enabled: intent.policy.enabled,
              repositories: intent.repositoryKeys.map((key) => repository(key).descriptor) }); }
            catch { throw new ApiError(409, 'policy_intent_changed'); }
            if (JSON.stringify(declared) !== JSON.stringify(intent.policy))
              throw new ApiError(409, 'policy_intent_changed');
            return (await current()).access;
          }));
          result = { generation: value.generation, policyHash: value.policyHash, enabled: value.enabled };
        } else if (operation === 'policy_disable') {
          const packet = exactObject(body, ['commandId', 'expectedGeneration']);
          const value = await awaited((access) => options.runtime().disableExports(access, {
            clientCommandId: boundedString(packet.commandId, 1, 200), expectedGeneration: integer(packet.expectedGeneration, 0),
          }, async () => (await current()).access));
          result = { generation: value.generation, policyHash: value.policyHash, enabled: value.enabled };
        } else {
          if (ticketId === undefined) throw new ApiError(400, 'invalid_request');
          if (operation === 'review') {
            const packet = exactObject(body, ['intent']);
            const intent = engineeringReviewIntent(packet.intent, ticketId);
            if (intent.actorId !== principalId) throw new ApiError(403, 'forbidden');
            // No Work, Source, repository catalog or policy pre-read here. A
            // committed historical ACK must survive changes to those resources.
            result = stepDto(await awaited((access) => options.runtime().reviewCommand(access, intent.command,
              async () => (await current()).access)));
          } else if (operation === 'enroll') {
            const packet = exactObject(body, ['commandId', 'expectedRevision']);
            result = sourceResultDto(await awaited((access) => options.runtime().enroll(access, { ticketId,
              clientCommandId: boundedString(packet.commandId, 1, 200), expectedRevision: integer(packet.expectedRevision) },
              async () => (await current()).access)));
          } else if (operation === 'evidence') {
            const packet = exactObject(body, ['commandId', 'expectedRevision', 'expectedBehavior', 'actualBehavior',
              'reproductionSteps', 'visibleMessageIds', 'verificationReference', 'security']);
            if (packet.security !== 'ordinary' && packet.security !== 'restricted' && packet.security !== 'uncertain')
              throw new ApiError(400, 'invalid_request');
            const input: EngineeringFailurePacket = { ticketId, clientCommandId: boundedString(packet.commandId, 1, 200),
              expectedRevision: integer(packet.expectedRevision), security: packet.security,
              evidence: { kind: 'staff_verified_failure' as const,
                expectedBehavior: boundedString(packet.expectedBehavior, 1, 2_000, { allowMultiline: true }),
                actualBehavior: boundedString(packet.actualBehavior, 1, 2_000, { allowMultiline: true }),
                reproductionSteps: strings(packet.reproductionSteps, 16, 1_000, true),
                visibleMessageIds: strings(packet.visibleMessageIds, 16, 200),
                verificationReference: boundedString(packet.verificationReference, 1, 200) } };
            result = sourceResultDto(await awaited((access) => options.runtime().submitVerifiedFailure(access, input,
              async () => (await current()).access)));
          } else if (operation === 'repository') {
            const packet = exactObject(body, ['commandId', 'sourceGeneration', 'expectedWorkGeneration',
              'repositoryKey', 'repositoryId', 'repositoryDescriptorHash', 'policyGeneration', 'policyHash', 'reason']);
            const repositoryKey = boundedString(packet.repositoryKey, 1, 100);
            const repositoryDescriptorHash = fingerprint(packet.repositoryDescriptorHash);
            const input = { ticketId,
              clientCommandId: boundedString(packet.commandId, 1, 200), sourceGeneration: integer(packet.sourceGeneration),
              expectedWorkGeneration: integer(packet.expectedWorkGeneration), repositoryId: boundedString(packet.repositoryId, 1, 200),
              policyGeneration: integer(packet.policyGeneration, 0), policyHash: fingerprint(packet.policyHash),
              reason: boundedString(packet.reason, 1, 200) };
            const binding = await intentFingerprint({ actorId: principalId, repositoryKey, repositoryDescriptorHash, input });
            result = stepDto(await awaited((access) => options.runtime().selectRepository(access, input, {
              intentFingerprint: binding, beforeCommit: async () => {
                const entry = configured.find((candidate) => candidate.key === repositoryKey);
                if (entry === undefined || !entry.descriptor.enabled || entry.descriptor.repositoryId !== input.repositoryId)
                  throw new ApiError(409, 'engineering_selection_changed');
                const declared = normalizedPolicy({ enabled: true, repositories: [entry.descriptor] }).repositories[0]!;
                if (await intentFingerprint(declared) !== repositoryDescriptorHash)
                  throw new ApiError(409, 'engineering_selection_changed');
                // SDK policy generation/hash checks have already followed its
                // receipt lookup. This final browser read follows local hashing.
                return (await current()).access;
              },
            })));
          } else if (operation === 'invalidate') {
            const packet = exactObject(body, ['commandId', 'reason']);
            if (packet.reason !== 'evidence_revoked' && packet.reason !== 'product_binding_revoked' && packet.reason !== 'check_policy_revoked')
              throw new ApiError(400, 'invalid_request');
            const reason = packet.reason;
            result = sourceResultDto(await awaited((access) => options.runtime().invalidate(access, { ticketId,
              clientCommandId: boundedString(packet.commandId, 1, 200), reason }, async () => (await current()).access)));
          } else {
            const packet = exactObject(body, ['commandId', 'reason']);
            if (packet.reason !== 'privacy_withdrawal' && packet.reason !== 'source_access_revoked' && packet.reason !== 'source_deleted')
              throw new ApiError(400, 'invalid_request');
            const reason = packet.reason;
            result = sourceResultDto(await awaited((access) => options.runtime().withdraw(access, { ticketId,
              clientCommandId: boundedString(packet.commandId, 1, 200), reason }, async () => (await current()).access)));
          }
        }
      }
      const final = await current();
      if (operation === 'policy_prepare' &&
        new TextEncoder().encode(JSON.stringify({ result, csrfToken: final.csrfToken })).byteLength > policyIntentBytes)
        throw new ApiError(413, 'request_too_large');
      return json({ result, csrfToken: final.csrfToken });
    } catch (error) {
      let failure = error;
      try { await current(); } catch (authorityError) { failure = authorityError; }
      const value = mapped(failure);
      return json({ error: value.code }, { status: value.status,
        headers: value.retryAfterSeconds === undefined ? {} : { 'Retry-After': String(value.retryAfterSeconds) } });
    }
  };
}
