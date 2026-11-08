import { hasPermission } from '@pegma/authorization-core';
import {
  createKnowledgeBaseApplication,
  type KnowledgeBaseApplication,
} from '@pegma/knowledge-base-application';
import {
  knowledgePermissions,
  type Clock,
} from '@pegma/knowledge-base-contracts';
import {
  createKnowledgeAgentDispatcher,
  createKnowledgeAgentHttp,
  createKnowledgeAgentMcp,
} from '@pegma/knowledge-base-mcp';
import { createDurableLimiter, defineRateLimitPolicy } from '@pegma/rate-limit';
import type { Store } from '@pegma/storage-core';
import { ApiError, json, type AuthenticationOptions } from './api-auth';
import {
  createAgentPrincipalResolver,
  type AgentAuthorityOptions,
} from './agent-authority';
import {
  AGENT_API_URL,
  AGENT_RESOURCE,
  AGENT_RESOURCE_METADATA_URL,
  type AgentAccessRuntime,
} from './agent-access-runtime';
import {
  createKnowledgeEvidenceService,
  knowledgeDigest,
  type KnowledgeEvidenceService,
} from './knowledge-evidence';
import { createKnowledgeApi } from './knowledge-api';
import { IDENTITY_ISSUER } from './identity-api';

export interface KnowledgeRuntimeOptions
  extends AuthenticationOptions, AgentAuthorityOptions {
  readonly store: Store;
  readonly clock: Clock;
  readonly agentAccess: AgentAccessRuntime | null;
}
export interface KnowledgeRuntime {
  readonly application: KnowledgeBaseApplication;
  readonly evidence: KnowledgeEvidenceService;
  handle(request: Request): Promise<Response | null>;
}

/** Compose released services over the host's existing Store and live roles. */
export function createKnowledgeRuntime(
  options: KnowledgeRuntimeOptions,
): KnowledgeRuntime {
  let application: KnowledgeBaseApplication;
  const evidence = createKnowledgeEvidenceService({
    store: options.store,
    clock: options.clock,
    resolvePrincipal: createAgentPrincipalResolver(options),
    async readContext(access, articleId) {
      const draft = await application.getDraft(access, { articleId });
      const requirements = await application.getValidationRequirements(access, {
        collectionId: draft.revision.collectionId,
        kind: draft.revision.kind,
      });
      const accepted = hasPermission(access, knowledgePermissions.evidenceRead)
        ? await application.getEvidence(access, { articleId })
        : undefined;
      // These are authoritative reads, not a copied governance cache. An
      // observed draft/governance change aborts the host report operation.
      const latestDraft = await application.getDraft(access, { articleId });
      const latestRequirements = await application.getValidationRequirements(
        access,
        {
          collectionId: latestDraft.revision.collectionId,
          kind: latestDraft.revision.kind,
        },
      );
      if (
        draft.generation !== latestDraft.generation ||
        (await knowledgeDigest(requirements)) !==
          (await knowledgeDigest(latestRequirements))
      )
        throw new ApiError(409, 'report_target_changed');
      return {
        draft: latestDraft,
        requirements: latestRequirements,
        ...(accepted === undefined ? {} : { evidence: accepted }),
      };
    },
  });
  application = createKnowledgeBaseApplication({
    store: options.store,
    clock: options.clock,
    evidenceVerifier: evidence.verifier,
  });
  const browserLimit = createDurableLimiter(
    defineRateLimitPolicy({
      name: 'pegma.knowledge.browser',
      limit: 120,
      windowMs: 5 * 60_000,
    }),
    options.store,
    { clock: options.clock },
  );
  const browser = createKnowledgeApi({
    ...options,
    application,
    evidence,
    async limitBrowser(request) {
      const key = await knowledgeDigest(
        (request.headers.get('CF-Connecting-IP') ?? 'unavailable').slice(
          0,
          128,
        ),
      );
      const decision = await browserLimit.allow(key);
      if (!decision.allowed)
        throw new ApiError(
          429,
          'rate_limited',
          decision.retryAfter === undefined
            ? undefined
            : Math.max(1, Math.ceil(decision.retryAfter / 1000)),
        );
    },
  });
  const agents = options.agentAccess;
  const dispatcher = createKnowledgeAgentDispatcher({
    application,
    resource: AGENT_RESOURCE,
  });
  const transportOptions = {
    dispatcher,
    resource: AGENT_RESOURCE,
    protectedResourceMetadataUrl: AGENT_RESOURCE_METADATA_URL,
    allowedOrigins: [IDENTITY_ISSUER],
    authenticate: (request: Request) =>
      agents === null
        ? json({ error: 'agent_access_not_configured' }, { status: 503 })
        : agents.protectedResource.authenticate(request),
    limit: (request: Request) =>
      agents === null ? { allowed: false } : agents.resourceLimit(request),
  };
  const http = createKnowledgeAgentHttp({
    ...transportOptions,
    apiUrl: AGENT_API_URL,
  });
  const mcp = createKnowledgeAgentMcp({
    ...transportOptions,
    mcpUrl: AGENT_RESOURCE,
  });
  return Object.freeze({
    application,
    evidence,
    async handle(request: Request) {
      const path = new URL(request.url).pathname;
      if (
        agents === null &&
        (path === new URL(AGENT_API_URL).pathname ||
          path === new URL(AGENT_RESOURCE).pathname)
      )
        return json(
          { error: 'agent_access_not_configured' },
          { status: 503, headers: { 'Referrer-Policy': 'no-referrer' } },
        );
      return (
        (await http.handle(request)) ??
        (await mcp.handle(request)) ??
        (await browser(request))
      );
    },
  });
}
