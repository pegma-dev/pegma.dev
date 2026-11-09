import { hasPermission } from '@pegma/authorization-core';
import type { AccessContext } from '@pegma/authorization-core';
import type { DelegatedAccess } from '@pegma/agent-access';
import {
  createKnowledgeBaseApplication,
  KnowledgeBaseAuthorizationError,
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
import {
  createDurableLimiter,
  defineRateLimitPolicy,
  type DurableRateLimiter,
} from '@pegma/rate-limit-paged';
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
import { knowledgeAdmissionPolicyName } from './knowledge-admission';
import { createKnowledgeRetrievalMaintenance } from './knowledge-retrieval-maintenance';

export interface KnowledgeRuntimeOptions
  extends AuthenticationOptions, AgentAuthorityOptions {
  readonly store: Store;
  readonly clock: Clock;
  readonly agentAccess: AgentAccessRuntime | null;
  readonly browserLimitCount?: number;
  readonly isEnabled?: () => boolean;
}
export interface KnowledgeRuntime {
  readonly application: KnowledgeBaseApplication;
  readonly evidence: KnowledgeEvidenceService;
  readonly limiters: readonly DurableRateLimiter[];
  handle(request: Request): Promise<Response | null>;
}

/** Compose released services over the host's existing Store and live roles. */
export function createKnowledgeRuntime(
  options: KnowledgeRuntimeOptions,
): KnowledgeRuntime {
  const browserLimitCount = options.browserLimitCount ?? 120;
  if (
    !Number.isSafeInteger(browserLimitCount) ||
    browserLimitCount < 1 ||
    browserLimitCount > 10_000
  )
    throw new TypeError(
      'Knowledge browser limit must be an integer from 1 to 10000.',
    );
  let application: KnowledgeBaseApplication;
  const evidence = createKnowledgeEvidenceService({
    store: options.store,
    clock: options.clock,
    logger: options.logger,
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
      // The final draft generation fences the requirements/evidence reads.
      // The SDK separately rechecks governance around evidence acceptance.
      const latestDraft = await application.getDraft(access, { articleId });
      if (draft.generation !== latestDraft.generation)
        throw new ApiError(409, 'report_target_changed');
      return {
        draft: latestDraft,
        requirements,
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
      name: knowledgeAdmissionPolicyName(
        'pegma.knowledge.browser',
        browserLimitCount,
      ),
      limit: browserLimitCount,
      windowMs: 5 * 60_000,
    }),
    options.store,
    { clock: options.clock },
  );
  const browser = createKnowledgeApi({
    ...options,
    application,
    evidence,
    repairArticle: createKnowledgeRetrievalMaintenance({
      store: options.store,
      clock: options.clock,
      logger: options.logger,
      isEnabled: options.isEnabled ?? (() => true),
      application,
    }).repairArticleBestEffort,
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
  return Object.freeze({
    application,
    evidence,
    limiters: Object.freeze([browserLimit]),
    async handle(request: Request) {
      const path = new URL(request.url).pathname;
      if (
        path !== new URL(AGENT_API_URL).pathname &&
        path !== new URL(AGENT_RESOURCE).pathname
      )
        return browser(request);
      if (agents === null)
        return json(
          { error: 'agent_access_not_configured' },
          { status: 503, headers: { 'Referrer-Policy': 'no-referrer' } },
        );
      const configuredAgents = agents;
      const authorization = request.headers.get('Authorization');
      // A binding belongs to this exact request, including while the SDK awaits
      // its body. No authority is stored across requests or captured globally.
      let binding:
        | Readonly<
            Pick<DelegatedAccess, 'grantId' | 'clientId' | 'resource'> & {
              readonly principalId: AccessContext['principalId'];
            }
          >
        | undefined;
      async function freshAccess(
        original: AccessContext,
        required: readonly string[],
        requireAll = false,
      ): Promise<AccessContext> {
        const current =
          await configuredAgents.protectedResource.authenticate(request);
        if (
          current instanceof Response ||
          binding === undefined ||
          request.headers.get('Authorization') !== authorization ||
          current.access.principalId !== binding.principalId ||
          original.principalId !== binding.principalId ||
          current.grantId !== binding.grantId ||
          current.clientId !== binding.clientId ||
          current.resource !== binding.resource ||
          current.resource !== AGENT_RESOURCE
        )
          throw new KnowledgeBaseAuthorizationError(
            knowledgePermissions.draftRead,
          );
        const access = Object.freeze({
          ...current.access,
          roles: Object.freeze([]),
          entitlements: Object.freeze([]),
          permissions: Object.freeze(
            current.access.permissions.filter((permission) =>
              original.permissions.includes(permission),
            ),
          ),
        });
        const permitted = (permission: string) =>
          access.permissions.includes(permission);
        if (
          !(requireAll ? required.every(permitted) : required.some(permitted))
        )
          throw new KnowledgeBaseAuthorizationError(
            required[0] ?? knowledgePermissions.draftRead,
          );
        return access;
      }
      async function invoke<T>(
        original: AccessContext,
        required: readonly string[],
        operation: (access: AccessContext) => Promise<T>,
        requireAll = false,
      ): Promise<T> {
        const result = await operation(
          await freshAccess(original, required, requireAll),
        );
        // This can refuse a completed write's acknowledgement; it does not
        // roll back that write or promise an atomic grant/article transaction.
        await freshAccess(original, required, requireAll);
        return result;
      }
      // The real dispatcher continues to own all five schemas and attenuation;
      // these request-bound methods only refresh authority before the real KB call.
      const currentApplication: KnowledgeBaseApplication = {
        ...application,
        async getDraft(access, input) {
          return invoke(access, [knowledgePermissions.draftRead], (fresh) =>
            application.getDraft(fresh, input),
          );
        },
        async createDraft(access, input) {
          return invoke(access, [knowledgePermissions.draftWrite], (fresh) =>
            application.createDraft(fresh, input),
          );
        },
        async updateDraft(access, input) {
          return invoke(access, [knowledgePermissions.draftWrite], (fresh) =>
            application.updateDraft(fresh, input),
          );
        },
        async getValidationRequirements(access, input) {
          return invoke(
            access,
            [
              knowledgePermissions.draftWrite,
              knowledgePermissions.evidenceSubmit,
            ],
            (fresh) => application.getValidationRequirements(fresh, input),
          );
        },
        async submitEvidence(access, input) {
          return invoke(
            access,
            [knowledgePermissions.evidenceSubmit],
            (fresh) => application.submitEvidence(fresh, input),
          );
        },
      };
      const currentReports: KnowledgeEvidenceService['agentReports'] = {
        async report(access, input) {
          return invoke(
            access,
            [
              knowledgePermissions.draftRead,
              knowledgePermissions.evidenceSubmit,
            ],
            (fresh) => evidence.agentReports.report(fresh, input),
            true,
          );
        },
        async ledger(access, input) {
          return invoke(
            access,
            [
              knowledgePermissions.draftRead,
              knowledgePermissions.evidenceSubmit,
            ],
            (fresh) => evidence.agentReports.ledger(fresh, input),
            true,
          );
        },
        async status(access, input) {
          return invoke(
            access,
            [
              knowledgePermissions.draftRead,
              knowledgePermissions.evidenceSubmit,
            ],
            (fresh) => evidence.agentReports.status(fresh, input),
            true,
          );
        },
      };
      const dispatcher = createKnowledgeAgentDispatcher({
        application: currentApplication,
        resource: AGENT_RESOURCE,
        reports: currentReports,
      });
      const transportOptions = {
        dispatcher,
        resource: AGENT_RESOURCE,
        protectedResourceMetadataUrl: AGENT_RESOURCE_METADATA_URL,
        allowedOrigins: [IDENTITY_ISSUER],
        async authenticate(originalRequest: Request) {
          if (originalRequest !== request)
            throw new KnowledgeBaseAuthorizationError(
              knowledgePermissions.draftRead,
            );
          const identity =
            await configuredAgents.protectedResource.authenticate(
              originalRequest,
            );
          if (request.headers.get('Authorization') !== authorization)
            throw new KnowledgeBaseAuthorizationError(
              knowledgePermissions.draftRead,
            );
          if (!(identity instanceof Response))
            binding = Object.freeze({
              principalId: identity.access.principalId,
              grantId: identity.grantId,
              clientId: identity.clientId,
              resource: identity.resource,
            });
          return identity;
        },
        limit: (originalRequest: Request) =>
          configuredAgents.resourceLimit(originalRequest),
      };
      const http = createKnowledgeAgentHttp({
        ...transportOptions,
        apiUrl: AGENT_API_URL,
      });
      const mcp = createKnowledgeAgentMcp({
        ...transportOptions,
        mcpUrl: AGENT_RESOURCE,
      });
      return (await http.handle(request)) ?? (await mcp.handle(request));
    },
  });
}
