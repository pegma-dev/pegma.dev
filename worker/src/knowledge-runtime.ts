import { hasPermission } from '@pegma/authorization-core';
import type { AccessContext } from '@pegma/authorization-core';
import type { DelegatedAccess } from '@pegma/agent-access';
import {
  createKnowledgeBaseApplication,
  KnowledgeBaseAuthorizationError,
  type KnowledgeBaseApplication,
  type PrivateSourcesVerifier,
} from '@pegma/knowledge-base-application';
import {
  knowledgePermissions,
  type Clock,
} from '@pegma/knowledge-base-contracts';
import {
  createKnowledgeAgentDispatcher,
  createKnowledgeAgentHttp,
  createKnowledgeAgentMcp,
  type KnowledgeAgentDispatcher,
  type KnowledgeAgentResponse,
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
import { createKnowledgeRetrievalReady } from './knowledge-retrieval-ready';

export interface KnowledgeRuntimeOptions
  extends AuthenticationOptions, AgentAuthorityOptions {
  readonly store: Store;
  readonly clock: Clock;
  readonly agentAccess: AgentAccessRuntime | null;
  readonly browserLimitCount?: number;
  readonly isEnabled?: () => boolean;
  readonly privateSources?: PrivateSourcesVerifier;
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
    authoringContext: {
      getAuthoringContext(access, input) {
        return application.getAuthoringContext(access, input);
      },
      confirmAuthoringContext(access, observation) {
        return application.confirmAuthoringContext(access, observation);
      },
    },
    async readContext(access, articleId) {
      const observed = await application.getAuthoringContext(access, {
        articleId,
        includeEvidence: hasPermission(
          access,
          knowledgePermissions.evidenceRead,
        ),
      });
      return observed.context;
    },
  });
  application = createKnowledgeBaseApplication({
    store: options.store,
    clock: options.clock,
    evidenceVerifier: evidence.verifier,
    ...(options.privateSources === undefined ? {} : { privateSources: options.privateSources }),
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
    repairArticle: createKnowledgeRetrievalReady({
      store: options.store,
      clock: options.clock,
      logger: options.logger,
      isEnabled: options.isEnabled ?? (() => true),
      ...(options.privateSources === undefined ? {} : { privateSources: options.privateSources }),
    }).enqueue,
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
        if (request.headers.get('Authorization') !== authorization)
          throw new KnowledgeBaseAuthorizationError(
            required[0] ?? knowledgePermissions.draftRead,
          );
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
            current.access.permissions.filter(
              (permission) =>
                original.permissions.includes(permission) &&
                current.scopes.includes(permission),
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
      // Each actual tool invocation owns its read group, including when the MCP
      // SDK runs the callback after constructing its outer response.
      const configuration = createKnowledgeAgentDispatcher({
        application,
        resource: AGENT_RESOURCE,
        reports: evidence.agentReports,
      });
      const dispatcher: KnowledgeAgentDispatcher = {
        limits: configuration.limits,
        ...(configuration.reportWorkflow === true
          ? { reportWorkflow: true as const }
          : {}),
        async dispatch(identity, envelope): Promise<KnowledgeAgentResponse> {
          let readContext: Promise<AccessContext> | undefined;
          let readOriginal: AccessContext | undefined;
          let deferredReportArticle: string | undefined;
          let deferredReportRead = false;
          const clauses: {
            required: readonly string[];
            requireAll: boolean;
          }[] = [];
          function recordClause(
            required: readonly string[],
            requireAll: boolean,
          ) {
            if (
              !clauses.some(
                (clause) =>
                  clause.requireAll === requireAll &&
                  clause.required.length === required.length &&
                  clause.required.every(
                    (permission, index) => permission === required[index],
                  ),
              )
            )
              clauses.push({
                required: Object.freeze([...required]),
                requireAll,
              });
          }
          function write<T>(
            original: AccessContext,
            required: readonly string[],
            operation: (access: AccessContext) => Promise<T>,
            requireAll = false,
          ): Promise<T> {
            if (deferredReportArticle !== undefined)
              throw new KnowledgeBaseAuthorizationError(
                required[0] ?? knowledgePermissions.evidenceSubmit,
              );
            recordClause(required, requireAll);
            return invoke(original, required, operation, requireAll);
          }
          async function read<T>(
            original: AccessContext,
            required: readonly string[],
            operation: (access: AccessContext) => Promise<T>,
            requireAll = false,
            finalReportArticle?: string,
          ): Promise<T> {
            if (
              deferredReportArticle !== undefined &&
              (finalReportArticle !== deferredReportArticle ||
                deferredReportRead)
            )
              throw new KnowledgeBaseAuthorizationError(
                required[0] ?? knowledgePermissions.draftRead,
              );
            if (deferredReportArticle !== undefined) deferredReportRead = true;
            if (
              request.headers.get('Authorization') !== authorization ||
              original.principalId !== identity.access.principalId
            )
              throw new KnowledgeBaseAuthorizationError(
                required[0] ?? knowledgePermissions.draftRead,
              );
            if (readContext === undefined) {
              readOriginal = original;
              readContext = freshAccess(original, required, requireAll);
            }
            const access = await readContext;
            const permitted = (permission: string) =>
              original.permissions.includes(permission) &&
              access.permissions.includes(permission);
            if (
              request.headers.get('Authorization') !== authorization ||
              !(requireAll
                ? required.every(permitted)
                : required.some(permitted))
            )
              throw new KnowledgeBaseAuthorizationError(
                required[0] ?? knowledgePermissions.draftRead,
              );
            recordClause(required, requireAll);
            return operation(access);
          }
          const currentApplication: KnowledgeBaseApplication = {
            ...application,
            async getDraft(access, input) {
              return read(
                access,
                [knowledgePermissions.draftRead],
                (fresh) => application.getDraft(fresh, input),
                false,
                input.articleId,
              );
            },
            async createDraft(access, input) {
              return write(access, [knowledgePermissions.draftWrite], (fresh) =>
                application.createDraft(fresh, input),
              );
            },
            async updateDraft(access, input) {
              return write(access, [knowledgePermissions.draftWrite], (fresh) =>
                application.updateDraft(fresh, input),
              );
            },
            async getValidationRequirements(access, input) {
              return read(
                access,
                [
                  knowledgePermissions.draftWrite,
                  knowledgePermissions.evidenceSubmit,
                ],
                (fresh) => application.getValidationRequirements(fresh, input),
              );
            },
            async submitEvidence(access, input) {
              return write(
                access,
                [knowledgePermissions.evidenceSubmit],
                (fresh) => application.submitEvidence(fresh, input),
              );
            },
          };
          const currentReports: KnowledgeEvidenceService['agentReports'] = {
            async query(access, input) {
              return read(
                access,
                [
                  knowledgePermissions.draftRead,
                  knowledgePermissions.evidenceSubmit,
                ],
                (fresh) => evidence.agentReports.query(fresh, input),
                true,
              );
            },
            async report(access, input) {
              const required = [
                knowledgePermissions.draftRead,
                knowledgePermissions.evidenceSubmit,
              ];
              if (readOriginal === undefined)
                return write(
                  access,
                  required,
                  (fresh) => evidence.agentReports.report(fresh, input),
                  true,
                );
              if (deferredReportArticle !== undefined)
                throw new KnowledgeBaseAuthorizationError(
                  knowledgePermissions.evidenceSubmit,
                );
              recordClause(required, true);
              const fresh = await freshAccess(access, required, true);
              // Only this mixed report path defers its postcommit observation.
              // Afterward, permit only the same target's bounded getDraft read;
              // the full original-credential gate runs before any logical result.
              deferredReportArticle = input.articleId;
              return evidence.agentReports.report(fresh, input);
            },
            async ledger(access, input) {
              return read(
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
              return read(
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
          const inner = createKnowledgeAgentDispatcher({
            application: currentApplication,
            resource: AGENT_RESOURCE,
            reports: currentReports,
          });
          let operation: KnowledgeAgentResponse['operation'] = null;
          async function finishReads(): Promise<void> {
            if (readOriginal !== undefined) {
              // Reauthenticate the original credential once after ALL read work,
              // before HTTP or the MCP tool callback can serialize any result.
              const final = await freshAccess(readOriginal, [], true);
              for (const clause of clauses) {
                const permitted = (permission: string) =>
                  final.permissions.includes(permission);
                if (
                  !(clause.requireAll
                    ? clause.required.every(permitted)
                    : clause.required.some(permitted))
                )
                  throw new KnowledgeBaseAuthorizationError(
                    clause.required[0] ?? knowledgePermissions.draftRead,
                  );
              }
            }
          }
          try {
            let result: KnowledgeAgentResponse;
            try {
              result = await inner.dispatch(identity, envelope);
            } catch (error) {
              // A later SDK failure cannot escape the deferred report gate.
              await finishReads();
              throw error;
            }
            operation = result.operation;
            await finishReads();
            return result;
          } catch (error) {
            const forbidden = error instanceof KnowledgeBaseAuthorizationError;
            return {
              apiVersion: '1',
              operation,
              error: {
                code: forbidden ? 'forbidden' : 'unavailable',
                status: forbidden ? 403 : 503,
                message: forbidden
                  ? 'Knowledge access is forbidden.'
                  : 'Knowledge service is unavailable.',
              },
            };
          }
        },
      };
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
