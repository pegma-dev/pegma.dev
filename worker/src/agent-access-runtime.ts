import {
  createAgentAccess,
  createAgentAccessHttp,
  createProtectedResourceAuthenticator,
  type AgentAccessConfiguration,
  type AgentAccessHttp,
  type AgentAccessLimitResult,
  type AgentAccessServicePort,
  type GrantType,
  type ProtectedResourceAuthenticator,
  type PublicClient,
  type ScopeDefinition,
} from '@pegma/agent-access';
import {
  createDurableLimiter,
  defineRateLimitPolicy,
  type DurableRateLimiter,
} from '@pegma/rate-limit';
import { systemClock, type Clock } from '@pegma/spine';
import type { Store } from '@pegma/storage-core';
import {
  ApiError,
  exactObject,
  isPlainObject,
  json,
  boundedString,
} from './api-auth';
import {
  createAgentPrincipalResolver,
  requireAgentBrowserContext,
  type AgentBrowserOptions,
} from './agent-authority';
import { createAgentAccessApi } from './agent-access-api';
import { IDENTITY_ISSUER } from './identity-api';
import {
  AGENT_KNOWLEDGE_PERMISSIONS,
  AGENT_LINK_PERMISSION,
} from './support-access';

export const AGENT_RESOURCE = 'https://pegma.dev/api/knowledge/mcp';
export const AGENT_API_URL = 'https://pegma.dev/api/knowledge/v1';
export const AGENT_RESOURCE_METADATA_URL =
  'https://pegma.dev/.well-known/oauth-protected-resource/api/knowledge/mcp';
export const AGENT_ENDPOINTS = Object.freeze({
  authorize: `${IDENTITY_ISSUER}/api/agent-access/authorize`,
  deviceAuthorization: `${IDENTITY_ISSUER}/api/agent-access/device-authorizations`,
  token: `${IDENTITY_ISSUER}/api/agent-access/token`,
  revocation: `${IDENTITY_ISSUER}/api/agent-access/revoke`,
  verification: `${IDENTITY_ISSUER}/account/agents/device`,
  approval: `${IDENTITY_ISSUER}/account/agents/authorize`,
  resourceMetadata: AGENT_RESOURCE_METADATA_URL,
});
export const AGENT_SCOPES: readonly ScopeDefinition[] = Object.freeze(
  AGENT_KNOWLEDGE_PERMISSIONS.map((permission, index) =>
    Object.freeze({
      name: permission,
      version: '1',
      description:
        [
          'Read Knowledge Base drafts.',
          'Create and update Knowledge Base drafts.',
          'Submit test evidence for independent staff confirmation.',
        ][index] ?? 'Knowledge Base authoring.',
      permissions: Object.freeze([permission]),
    }),
  ),
);

function strings(
  value: unknown,
  maximum: number,
  itemMaximum: number,
): string[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new TypeError('Invalid agent client configuration.');
  const result = value.map((item: unknown) =>
    boundedString(item, 1, itemMaximum),
  );
  if (new Set(result).size !== result.length)
    throw new TypeError('Invalid agent client configuration.');
  return result;
}

/** Optional explicit public registrations. Missing/empty input disables linking. */
export function readAgentClients(
  raw: string | undefined,
): readonly PublicClient[] | null {
  if (raw === undefined || raw.trim() === '') return null;
  if (raw.length > 16384 || new TextEncoder().encode(raw).byteLength > 16384)
    throw new TypeError('Agent client configuration exceeds its bound.');
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length > 16)
    throw new TypeError('Invalid agent client configuration.');
  if (parsed.length === 0) return null;
  return Object.freeze(
    parsed.map((value: unknown): PublicClient => {
      if (!isPlainObject(value))
        throw new TypeError('Invalid agent client configuration.');
      const client = exactObject(value, [
        'clientId',
        'name',
        'redirectUris',
        'allowedScopes',
        'grantTypes',
      ]);
      const allowedScopes = strings(client.allowedScopes, 3, 128);
      if (
        allowedScopes.some(
          (scope) =>
            !AGENT_KNOWLEDGE_PERMISSIONS.some((known) => known === scope),
        )
      )
        throw new TypeError('Invalid agent client scopes.');
      const grantTypes = strings(client.grantTypes, 2, 32).map(
        (type): GrantType => {
          if (type !== 'device_code' && type !== 'authorization_code')
            throw new TypeError('Invalid agent grant type.');
          return type;
        },
      );
      return Object.freeze({
        clientId: boundedString(client.clientId, 1, 128),
        name: boundedString(client.name, 1, 200),
        redirectUris: Object.freeze(strings(client.redirectUris, 8, 2048)),
        allowedScopes: Object.freeze(allowedScopes),
        grantTypes: Object.freeze(grantTypes),
      });
    }),
  );
}

export interface AgentAccessRuntimeOptions extends AgentBrowserOptions {
  readonly store: Store;
  readonly clock?: Clock;
  readonly clients?: readonly PublicClient[] | null;
}
export interface AgentAccessRuntime {
  readonly configuration: AgentAccessConfiguration;
  readonly service: AgentAccessServicePort;
  readonly protocol: AgentAccessHttp;
  readonly api: (request: Request) => Promise<Response | null>;
  readonly protectedResource: ProtectedResourceAuthenticator;
  readonly resourceLimit: (request: Request) => Promise<AgentAccessLimitResult>;
  readonly limiters: readonly DurableRateLimiter[];
}

async function requestKey(request: Request): Promise<string> {
  const address = (
    request.headers.get('CF-Connecting-IP') ?? 'unavailable'
  ).slice(0, 128);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(address),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Compose the released OAuth service; no configured client means no issuer. */
export function createAgentAccessRuntime(
  options: AgentAccessRuntimeOptions,
): AgentAccessRuntime | null {
  if (
    options.clients === undefined ||
    options.clients === null ||
    options.clients.length === 0
  )
    return null;
  if (options.clients.length > 16)
    throw new TypeError('Agent client configuration exceeds its bound.');
  const clock = options.clock ?? systemClock;
  const configuration: AgentAccessConfiguration = Object.freeze({
    issuer: IDENTITY_ISSUER,
    resource: AGENT_RESOURCE,
    endpoints: AGENT_ENDPOINTS,
    approvalPermission: AGENT_LINK_PERMISSION,
    clients: options.clients,
    scopes: AGENT_SCOPES,
  });
  const service = createAgentAccess({
    configuration,
    store: options.store,
    clock,
    resolvePrincipal: createAgentPrincipalResolver(options),
  });
  const limiters: DurableRateLimiter[] = [];
  function admission(name: string, limit: number) {
    const limiter = createDurableLimiter(
      defineRateLimitPolicy({ name, limit, windowMs: 5 * 60_000 }),
      options.store,
      { clock },
    );
    limiters.push(limiter);
    return async (request: Request): Promise<AgentAccessLimitResult> => {
      const decision = await limiter.allow(await requestKey(request));
      return {
        allowed: decision.allowed,
        ...(decision.retryAfter === undefined
          ? {}
          : {
              retryAfterSeconds: Math.max(
                1,
                Math.ceil(decision.retryAfter / 1000),
              ),
            }),
      };
    };
  }
  const protocolLimiters = {
    authorize: admission('pegma.agent.authorize', 60),
    device_authorization: admission('pegma.agent.device', 60),
    token: admission('pegma.agent.token', 300),
    revocation: admission('pegma.agent.revoke', 120),
  };
  const browserLimit = admission('pegma.agent.browser', 120);
  const resourceLimit = admission('pegma.agent.resource', 300);
  const protocol = createAgentAccessHttp({
    service,
    configuration,
    limit: (request, { endpoint }) => protocolLimiters[endpoint](request),
    authenticateBrowser: async (request) => {
      try {
        return (await requireAgentBrowserContext(request, options)).context;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          const original = new URL(request.url);
          const login = new URL('/account', IDENTITY_ISSUER);
          login.searchParams.set(
            'returnTo',
            original.pathname + original.search,
          );
          return new Response(null, {
            status: 303,
            headers: { Location: login.href },
          });
        }
        if (error instanceof ApiError)
          return json({ error: error.code }, { status: error.status });
        options.logger.log('error', 'agent_access.authority_unavailable');
        return json({ error: 'service_unavailable' }, { status: 503 });
      }
    },
  });
  const api = createAgentAccessApi({
    ...options,
    service,
    configuration,
    limit: async (request) => {
      const decision = await browserLimit(request);
      if (!decision.allowed)
        throw new ApiError(429, 'rate_limited', decision.retryAfterSeconds);
    },
  });
  return Object.freeze({
    configuration,
    service,
    protocol,
    api,
    protectedResource: createProtectedResourceAuthenticator({
      service,
      configuration,
    }),
    resourceLimit,
    limiters: Object.freeze(limiters),
  });
}
