import { hasPermission } from '@pegma/authorization-core';
import {
  KnowledgeBaseAuthorizationError,
  KnowledgeBaseNotFoundError,
  KnowledgeBasePrerequisiteError,
  RepositoryCapacityError,
  RepositoryConflictError,
  type KnowledgeBaseApplication,
} from '@pegma/knowledge-base-application';
import { KnowledgeBaseError } from '@pegma/knowledge-base-core';
import { knowledgePermissions } from '@pegma/knowledge-base-contracts';
import { knowledgeAgentScopes } from '@pegma/knowledge-base-mcp';
import {
  ApiError,
  boundedString,
  exactObject,
  isPlainObject,
  json,
  optionalKeysObject,
  readJson,
  requireSameOriginMutation,
  TOKEN_PATTERN,
} from './api-auth';
import {
  requireCurrentBrowserAccess,
  type AgentBrowserOptions,
} from './agent-authority';
import {
  AGENT_RESOURCE,
  type AgentAccessRuntime,
} from './agent-access-runtime';
import { KNOWLEDGE_EVIDENCE_CONFIRM_PERMISSION } from './support-access';
import {
  KnowledgeLedgerError,
  type KnowledgeEvidenceService,
} from './knowledge-evidence';
import { IDENTITY_ISSUER } from './identity-api';

export interface KnowledgeApiOptions extends AgentBrowserOptions {
  readonly application: KnowledgeBaseApplication;
  readonly evidence: KnowledgeEvidenceService;
  readonly agentAccess: AgentAccessRuntime | null;
  readonly limitBrowser: (request: Request) => Promise<void>;
  /** Server-only bounded repair; never accepts caller authority or returns DTOs. */
  readonly repairArticle?: (articleId: string) => Promise<void>;
}

function secured(response: Response): Response {
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  return response;
}
function response(value: unknown): Response {
  const encoded = JSON.stringify(value);
  if (new TextEncoder().encode(encoded).byteLength > 512 * 1024)
    throw new ApiError(503, 'response_capacity');
  return json(value);
}
const commandFields = ['commandId', 'correlationId', 'expectedGeneration'];
const inputFields: Readonly<Record<string, readonly string[]>> = {
  getCollection: ['collectionId'],
  getValidationPolicy: ['policyId'],
  getGovernanceConfiguration: ['collectionId'],
  getDraft: ['articleId'],
  getEvidence: ['articleId'],
  getProvenance: ['articleId'],
  getReview: ['articleId'],
  getPublishedArticle: ['articleId'],
  getValidationRequirements: ['collectionId', 'kind'],
  createCollection: [...commandFields, 'collectionId', 'name'],
  previewCollectionPolicy: ['collectionId', 'uses'],
  updateCollectionPolicy: [...commandFields, 'collectionId', 'preview'],
  putValidationPolicy: [...commandFields, 'policy'],
  putGovernanceConfiguration: [
    ...commandFields,
    'collectionId',
    'configuration',
  ],
  createDraft: [...commandFields, 'articleId', 'collectionId', 'draft'],
  updateDraft: [...commandFields, 'articleId', 'collectionId', 'draft'],
  submitEvidence: [...commandFields, 'articleId', 'evidence', 'receipt'],
  submitForReview: [...commandFields, 'articleId'],
  publishArticle: [...commandFields, 'articleId', 'review'],
  rejectReview: [...commandFields, 'articleId', 'reason'],
  retireArticle: [...commandFields, 'articleId'],
  revokeEvidence: [
    ...commandFields,
    'articleId',
    'articleRevision',
    'evidenceId',
    'evidenceVersion',
    'evidenceHash',
    'reason',
  ],
  listPortalCollections: [],
  searchPublishedArticles: ['collectionId', 'query', 'applicability'],
};
function sdkInput(operation: string, input: unknown): unknown {
  const fields = inputFields[operation];
  if (fields === undefined) throw new ApiError(400, 'unknown_operation');
  const optional =
    operation === 'updateCollectionPolicy'
      ? ['approvePublic']
      : operation === 'listPortalCollections' ||
          operation === 'searchPublishedArticles'
        ? ['limit']
        : [];
  const value = optionalKeysObject(input, fields, optional);
  for (const name of [
    'commandId',
    'correlationId',
    'articleId',
    'collectionId',
    'policyId',
  ])
    if (name in value) boundedString(value[name], 1, 200);
  for (const name of [
    'expectedGeneration',
    'articleRevision',
    'evidenceVersion',
    'limit',
  ]) {
    const count = value[name];
    if (
      name in value &&
      (typeof count !== 'number' ||
        !Number.isSafeInteger(count) ||
        count < (name === 'expectedGeneration' ? 0 : 1))
    )
      throw new ApiError(400, 'invalid_request');
  }
  if ('approvePublic' in value && typeof value.approvePublic !== 'boolean')
    throw new ApiError(400, 'invalid_request');
  return value;
}

/** Browser operations are a closed allowlist over the released SDK validators. */
export function createKnowledgeApi(
  options: KnowledgeApiOptions,
): (request: Request) => Promise<Response | null> {
  const app = options.application;
  const operations = {
    getCollection: {
      method: app.getCollection,
      permission: knowledgePermissions.collectionRead,
    },
    getValidationPolicy: {
      method: app.getValidationPolicy,
      permission: knowledgePermissions.validationManage,
    },
    getGovernanceConfiguration: {
      method: app.getGovernanceConfiguration,
      permission: knowledgePermissions.validationManage,
    },
    getDraft: {
      method: app.getDraft,
      permission: knowledgePermissions.draftRead,
    },
    getEvidence: {
      method: app.getEvidence,
      permission: knowledgePermissions.evidenceRead,
    },
    getProvenance: {
      method: app.getProvenance,
      permission: knowledgePermissions.provenanceRead,
    },
    getReview: {
      method: app.getReview,
      permission: knowledgePermissions.review,
    },
    getValidationRequirements: {
      method: app.getValidationRequirements,
      permission: knowledgePermissions.evidenceSubmit,
    },
    createCollection: {
      method: app.createCollection,
      permission: knowledgePermissions.collectionManage,
    },
    previewCollectionPolicy: {
      method: app.previewCollectionPolicy,
      permission: knowledgePermissions.collectionManage,
    },
    updateCollectionPolicy: {
      method: app.updateCollectionPolicy,
      permission: knowledgePermissions.collectionManage,
    },
    putValidationPolicy: {
      method: app.putValidationPolicy,
      permission: knowledgePermissions.validationManage,
    },
    putGovernanceConfiguration: {
      method: app.putGovernanceConfiguration,
      permission: knowledgePermissions.validationManage,
    },
    createDraft: {
      method: app.createDraft,
      permission: knowledgePermissions.draftWrite,
    },
    updateDraft: {
      method: app.updateDraft,
      permission: knowledgePermissions.draftWrite,
    },
    submitEvidence: {
      method: app.submitEvidence,
      permission: knowledgePermissions.evidenceSubmit,
    },
    submitForReview: {
      method: app.submitForReview,
      permission: knowledgePermissions.reviewSubmit,
    },
    publishArticle: {
      method: app.publishArticle,
      permission: knowledgePermissions.publish,
    },
    rejectReview: {
      method: app.rejectReview,
      permission: knowledgePermissions.review,
    },
    retireArticle: {
      method: app.retireArticle,
      permission: knowledgePermissions.retire,
    },
    revokeEvidence: {
      method: app.revokeEvidence,
      permission: knowledgePermissions.evidenceRevoke,
    },
  };
  const portal = {
    listPortalCollections: app.listPortalCollections,
    searchPublishedArticles: app.searchPublishedArticles,
    getPublishedArticle: app.getPublishedArticle,
  };
  const reportOperations = new Set([
    'reportList',
    'reportRead',
    'confirmReport',
    'rejectReport',
    'reassessReport',
    'reportLedger',
    'resetReports',
    'drainReports',
  ]);
  return async (request) => {
    const url = new URL(request.url);
    if (
      ![
        '/api/staff/knowledge/state',
        '/api/staff/knowledge/command',
        '/api/knowledge/portal',
        '/api/knowledge/reports',
      ].includes(url.pathname)
    )
      return null;
    try {
      if (url.origin !== IDENTITY_ISSUER)
        throw new ApiError(403, 'cross_origin_denied');
      if (url.pathname === '/api/knowledge/reports') {
        if (request.method !== 'POST' && request.method !== 'GET')
          return secured(
            json(
              { error: 'method_not_allowed' },
              { status: 405, headers: { Allow: 'GET, POST' } },
            ),
          );
        const agents = options.agentAccess;
        if (agents === null)
          throw new ApiError(503, 'agent_access_not_configured');
        const decision = await agents.resourceLimit(request);
        if (!decision.allowed)
          throw new ApiError(429, 'rate_limited', decision.retryAfterSeconds);
        const origin = request.headers.get('Origin');
        if (origin !== null && origin !== IDENTITY_ISSUER)
          throw new ApiError(403, 'cross_origin_denied');
        const identity = await agents.protectedResource.authenticate(request);
        if (identity instanceof Response) return secured(identity);
        if (
          identity.resource !== AGENT_RESOURCE ||
          !identity.scopes.includes(knowledgeAgentScopes.evidenceSubmit) ||
          !hasPermission(identity.access, knowledgePermissions.evidenceSubmit)
        )
          throw new ApiError(403, 'forbidden');
        // Recheck the same delegated credential after awaited input/storage.
        // A current human principal alone does not establish a live grant.
        const currentAgent = async () => {
          const latest = await agents.protectedResource.authenticate(request);
          if (latest instanceof Response) return latest;
          if (
            latest.grantId !== identity.grantId ||
            latest.clientId !== identity.clientId ||
            latest.resource !== identity.resource ||
            latest.access.principalId !== identity.access.principalId ||
            !latest.scopes.includes(knowledgeAgentScopes.evidenceSubmit) ||
            !hasPermission(latest.access, knowledgePermissions.evidenceSubmit)
          )
            throw new ApiError(403, 'forbidden');
          return latest;
        };
        if (request.method === 'POST') {
          if (url.search !== '') throw new ApiError(400, 'invalid_request');
          const input = await readJson(request, { timeoutMs: 10_000 });
          const latest = await currentAgent();
          if (latest instanceof Response) return secured(latest);
          const value = await options.evidence.report(latest.access, input);
          const final = await currentAgent();
          if (final instanceof Response) return secured(final);
          return secured(response(value));
        }
        const keys = [...url.searchParams.keys()];
        if (keys.length === 1 && keys[0] === 'articleId') {
          const value = await options.evidence.ledger(identity.access, {
            articleId: boundedString(url.searchParams.get('articleId'), 1, 200),
          });
          const final = await currentAgent();
          if (final instanceof Response) return secured(final);
          return secured(response(value));
        }
        if (
          keys.length !== 3 ||
          url.searchParams.getAll('articleId').length !== 1 ||
          url.searchParams.getAll('reportId').length !== 1 ||
          url.searchParams.getAll('ledgerEpoch').length !== 1 ||
          !/^[1-9][0-9]*$/u.test(url.searchParams.get('ledgerEpoch') ?? '')
        )
          throw new ApiError(400, 'invalid_request');
        const value = await options.evidence.status(identity.access, {
          articleId: boundedString(url.searchParams.get('articleId'), 1, 200),
          reportId: boundedString(url.searchParams.get('reportId'), 1, 200),
          ledgerEpoch: Number(url.searchParams.get('ledgerEpoch')),
        });
        const final = await currentAgent();
        if (final instanceof Response) return secured(final);
        return secured(response(value));
      }
      const state = url.pathname === '/api/staff/knowledge/state';
      if (request.method !== (state ? 'GET' : 'POST'))
        return secured(
          json(
            { error: 'method_not_allowed' },
            { status: 405, headers: { Allow: state ? 'GET' : 'POST' } },
          ),
        );
      if (url.search !== '') throw new ApiError(400, 'invalid_request');
      const staffCommand = url.pathname === '/api/staff/knowledge/command';
      const credentialHeaders = staffCommand
        ? Object.freeze(
            [
              'Cookie',
              'Origin',
              'X-Pegma-CSRF',
              'Sec-Fetch-Site',
              'Authorization',
            ].map((name) =>
              Object.freeze({ name, value: request.headers.get(name) }),
            ),
          )
        : undefined;
      function sameBrowserHeaders() {
        if (
          credentialHeaders?.some(
            ({ name, value }) => request.headers.get(name) !== value,
          )
        )
          throw new ApiError(403, 'browser_credential_changed');
      }
      if (staffCommand) {
        if (request.headers.has('Authorization'))
          throw new ApiError(403, 'browser_session_required');
        requireSameOriginMutation(request);
        const cookie = request.headers.get('Cookie');
        if (cookie === null || cookie.trim() === '' || cookie.length > 8_192)
          throw new ApiError(401, 'authentication_required');
        if (!TOKEN_PATTERN.test(request.headers.get('X-Pegma-CSRF') ?? ''))
          throw new ApiError(403, 'csrf_denied');
      }
      await options.limitBrowser(request);
      if (state) {
        const { authenticated, access } = await requireCurrentBrowserAccess(
          request,
          options,
          knowledgePermissions.collectionRead,
        );
        return secured(
          response({
            csrfToken: authenticated.csrfToken,
            attesterId: access.principalId,
            permissions: {
              collectionManage: hasPermission(
                access,
                knowledgePermissions.collectionManage,
              ),
              validationManage: hasPermission(
                access,
                knowledgePermissions.validationManage,
              ),
              review: hasPermission(access, knowledgePermissions.review),
              publish: hasPermission(access, knowledgePermissions.publish),
              evidenceConfirm: hasPermission(
                access,
                KNOWLEDGE_EVIDENCE_CONFIRM_PERMISSION,
              ),
              retire: hasPermission(access, knowledgePermissions.retire),
              evidenceRevoke: hasPermission(
                access,
                knowledgePermissions.evidenceRevoke,
              ),
              draftWrite: hasPermission(
                access,
                knowledgePermissions.draftWrite,
              ),
            },
          }),
        );
      }
      // Staff POSTs parse at most64KiB after static browser/admission checks.
      // Full current session/CSRF/operation authority follows the body and
      // precedes EVERY protected read or application/report mutation.
      if (!staffCommand)
        await requireCurrentBrowserAccess(
          request,
          options,
          knowledgePermissions.articleRead,
          true,
        );
      const envelope = exactObject(
        await readJson(request, { timeoutMs: 10_000 }),
        ['operation', 'input'],
      );
      sameBrowserHeaders();
      let commandIdentity:
        { sessionId: string; principalId: string } | undefined;
      async function commandAccess(permission: string) {
        sameBrowserHeaders();
        const current = await requireCurrentBrowserAccess(
          request,
          options,
          permission,
          true,
        );
        sameBrowserHeaders();
        if (!hasPermission(current.access, knowledgePermissions.collectionRead))
          throw new ApiError(403, 'forbidden');
        if (commandIdentity === undefined)
          commandIdentity = Object.freeze({
            sessionId: current.authenticated.rawSessionId,
            principalId: current.access.principalId,
          });
        else if (
          current.authenticated.rawSessionId !== commandIdentity.sessionId ||
          current.access.principalId !== commandIdentity.principalId
        )
          throw new ApiError(403, 'browser_credential_changed');
        return current;
      }
      const operation = boundedString(envelope.operation, 1, 64);
      if (url.pathname === '/api/knowledge/portal') {
        if (!Object.hasOwn(portal, operation))
          throw new ApiError(400, 'unknown_operation');
        const method = portal[operation as keyof typeof portal];
        const { authenticated, access } = await requireCurrentBrowserAccess(
          request,
          options,
          knowledgePermissions.articleRead,
          true,
        );
        const authority = Object.freeze({
          sessionId: authenticated.rawSessionId,
          principalId: access.principalId,
          permissions: Object.freeze([...access.permissions]),
        });
        // The released method owns exact DTO validation. Reflect.apply forwards
        // unknown JSON without asserting it is an already validated SDK DTO.
        const result: unknown = await Reflect.apply(method, app, [
          access,
          sdkInput(operation, envelope.input),
        ]);
        const final = await requireCurrentBrowserAccess(
          request,
          options,
          knowledgePermissions.articleRead,
          true,
        );
        if (
          final.authenticated.rawSessionId !== authority.sessionId ||
          final.access.principalId !== authority.principalId
        )
          throw new ApiError(403, 'browser_credential_changed');
        // Audience permissions can be narrower than the default article-read
        // grant. A successful fresh login alone must not release their old DTO.
        if (
          authority.permissions.some(
            (permission) => !hasPermission(final.access, permission),
          )
        )
          throw new ApiError(403, 'forbidden');
        return secured(response(result));
      }
      if (reportOperations.has(operation)) {
        const { access } = await commandAccess(
          KNOWLEDGE_EVIDENCE_CONFIRM_PERMISSION,
        );
        const result =
          operation === 'reportList'
            ? await options.evidence.list(access, envelope.input)
            : operation === 'reportRead'
              ? await options.evidence.read(access, envelope.input)
              : operation === 'reportLedger'
                ? await options.evidence.ledger(access, envelope.input)
                : operation === 'resetReports'
                  ? await options.evidence.reset(access, envelope.input)
                  : operation === 'drainReports'
                    ? await options.evidence.drain(access, envelope.input)
                    : await options.evidence.decide(
                        access,
                        envelope.input,
                        operation === 'confirmReport'
                          ? 'confirmed'
                          : operation === 'rejectReport'
                            ? 'rejected'
                            : 'pending',
                      );
        await commandAccess(KNOWLEDGE_EVIDENCE_CONFIRM_PERMISSION);
        return secured(response(result));
      }
      if (!Object.hasOwn(operations, operation))
        throw new ApiError(400, 'unknown_operation');
      if (
        (operation === 'createDraft' || operation === 'updateDraft') &&
        isPlainObject(envelope.input) &&
        Object.hasOwn(envelope.input, 'sourceReferences')
      )
        throw new ApiError(400, 'unsupported_source_references');
      const selected = operations[operation as keyof typeof operations];
      const { access } = await commandAccess(selected.permission);
      const result: unknown = await Reflect.apply(selected.method, app, [
        access,
        sdkInput(operation, envelope.input),
      ]);
      if (
        ['publishArticle', 'retireArticle', 'revokeEvidence'].includes(
          operation,
        ) &&
        isPlainObject(envelope.input) &&
        typeof envelope.input.articleId === 'string'
      ) {
        try {
          await options.repairArticle?.(envelope.input.articleId);
        } catch {
          // Publication/retirement/revocation already committed. A failed hint
          // repair is recovered by the durable page worker, not a rollback.
          try {
            options.logger.log(
              'warn',
              'knowledge.retrieval_maintenance.failed',
              {
                stage: 'keyed',
              },
            );
          } catch {
            // The article command committed before this diagnostic.
          }
        }
      }
      await commandAccess(selected.permission);
      return secured(response(result));
    } catch (error) {
      let status = 503;
      let code = 'service_unavailable';
      if (error instanceof ApiError) {
        status = error.status;
        code = error.code;
      } else if (error instanceof KnowledgeBaseAuthorizationError) {
        status = 403;
        code = 'forbidden';
      } else if (error instanceof KnowledgeBaseNotFoundError) {
        status = 404;
        code = 'not_found';
      } else if (error instanceof KnowledgeBasePrerequisiteError) {
        status = 409;
        code = 'prerequisite_unavailable';
      } else if (error instanceof RepositoryConflictError) {
        status = 409;
        code = 'conflict';
      } else if (error instanceof RepositoryCapacityError) {
        status = 409;
        code = 'capacity';
      } else if (error instanceof KnowledgeBaseError) {
        status = error.code === 'invalid' ? 400 : 409;
        code = 'knowledge_' + error.code;
      }
      if (status === 503)
        options.logger.log('error', 'knowledge.api_unavailable', {
          error: error instanceof Error ? error.name : 'unknown',
          stage: error instanceof KnowledgeLedgerError ? error.stage : 'api',
        });
      return secured(
        json(
          { error: code },
          {
            status,
            ...(error instanceof ApiError &&
            error.retryAfterSeconds !== undefined
              ? { headers: { 'Retry-After': String(error.retryAfterSeconds) } }
              : {}),
          },
        ),
      );
    }
  };
}
