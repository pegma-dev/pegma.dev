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
  readJson,
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
import type { KnowledgeEvidenceService } from './knowledge-evidence';
import { IDENTITY_ISSUER } from './identity-api';

export interface KnowledgeApiOptions extends AgentBrowserOptions {
  readonly application: KnowledgeBaseApplication;
  readonly evidence: KnowledgeEvidenceService;
  readonly agentAccess: AgentAccessRuntime | null;
  readonly limitBrowser: (request: Request) => Promise<void>;
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
        if (request.method === 'POST') {
          if (url.search !== '') throw new ApiError(400, 'invalid_request');
          return secured(
            response(
              await options.evidence.report(
                identity.access,
                await readJson(request),
              ),
            ),
          );
        }
        if (
          [...url.searchParams.keys()].length !== 2 ||
          url.searchParams.getAll('articleId').length !== 1 ||
          url.searchParams.getAll('reportId').length !== 1
        )
          throw new ApiError(400, 'invalid_request');
        return secured(
          response(
            await options.evidence.status(identity.access, {
              articleId: boundedString(
                url.searchParams.get('articleId'),
                1,
                200,
              ),
              reportId: boundedString(url.searchParams.get('reportId'), 1, 200),
            }),
          ),
        );
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
      // Authenticate before reading any browser command body. Per-operation
      // permission is checked again before entering the actual SDK service.
      await requireCurrentBrowserAccess(
        request,
        options,
        url.pathname === '/api/knowledge/portal'
          ? knowledgePermissions.articleRead
          : knowledgePermissions.collectionRead,
        true,
      );
      const envelope = exactObject(await readJson(request), [
        'operation',
        'input',
      ]);
      const operation = boundedString(envelope.operation, 1, 64);
      if (url.pathname === '/api/knowledge/portal') {
        if (!Object.hasOwn(portal, operation))
          throw new ApiError(400, 'unknown_operation');
        const method = portal[operation as keyof typeof portal];
        const { access } = await requireCurrentBrowserAccess(
          request,
          options,
          knowledgePermissions.articleRead,
          true,
        );
        // The released method owns exact DTO validation. Reflect.apply forwards
        // unknown JSON without asserting it is an already validated SDK DTO.
        const result: unknown = await Reflect.apply(method, app, [
          access,
          envelope.input,
        ]);
        await requireCurrentBrowserAccess(
          request,
          options,
          knowledgePermissions.articleRead,
          true,
        );
        return secured(response(result));
      }
      if (reportOperations.has(operation)) {
        const { access } = await requireCurrentBrowserAccess(
          request,
          options,
          KNOWLEDGE_EVIDENCE_CONFIRM_PERMISSION,
          true,
        );
        const result =
          operation === 'reportList'
            ? await options.evidence.list(access, envelope.input)
            : operation === 'reportRead'
              ? await options.evidence.read(access, envelope.input)
              : await options.evidence.decide(
                  access,
                  envelope.input,
                  operation === 'confirmReport' ? 'confirmed' : 'rejected',
                );
        await requireCurrentBrowserAccess(
          request,
          options,
          KNOWLEDGE_EVIDENCE_CONFIRM_PERMISSION,
          true,
        );
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
      const { access } = await requireCurrentBrowserAccess(
        request,
        options,
        selected.permission,
        true,
      );
      const result: unknown = await Reflect.apply(selected.method, app, [
        access,
        envelope.input,
      ]);
      await requireCurrentBrowserAccess(
        request,
        options,
        selected.permission,
        true,
      );
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
      } else if (error instanceof TypeError || error instanceof SyntaxError) {
        status = 400;
        code = 'invalid_request';
      }
      if (status === 503)
        options.logger.log('error', 'knowledge.api_unavailable', {
          error: error instanceof Error ? error.name : 'unknown',
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
