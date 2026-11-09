import { createRoleStore } from '@pegma/authorization-storage';
import { identityLinkKeyFromVerifiedIdentityClaims } from '@pegma/authorization-identity';
import { systemClock, type Logger } from '@pegma/spine';
import {
  createProductionIdentityRuntime,
  type IdentityRuntimeEnv,
} from './identity-runtime';
import {
  createAgentAccessRuntime,
  readAgentClients,
  type AgentAccessRuntime,
} from './agent-access-runtime';
import { createKnowledgeRuntime } from './knowledge-runtime';
import { AUTHORIZATION_APPLICATION_ID } from './support-access';
import { knowledgeAdmissionCount } from './knowledge-admission';

type KnowledgeConfiguration = {
  readonly [
    Key in keyof Pick<
      Env,
      | 'PEGMA_KNOWLEDGE_ENABLED'
      | 'PEGMA_AGENT_CLIENTS_JSON'
      | 'PEGMA_KNOWLEDGE_BROWSER_LIMIT'
      | 'PEGMA_AGENT_RESOURCE_LIMIT'
    >
  ]?: string;
};

const metadataPaths = new Set([
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource/api/knowledge/mcp',
]);

export function isKnowledgeRequest(path: string): boolean {
  return (
    metadataPaths.has(path) ||
    path.startsWith('/api/agent-access/') ||
    path.startsWith('/api/knowledge/') ||
    path.startsWith('/api/staff/knowledge/')
  );
}

function unavailable(error: string): Response {
  return Response.json(
    { error },
    {
      status: 503,
      headers: {
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}

/** One explicit composition over this site's existing Identity and D1 store. */
export async function handleKnowledgeRequest(
  request: Request,
  env: IdentityRuntimeEnv & KnowledgeConfiguration,
  logger: Logger,
): Promise<Response> {
  if (env.PEGMA_KNOWLEDGE_ENABLED !== 'true')
    return unavailable('knowledge_disabled');
  try {
    const identity = createProductionIdentityRuntime(env, logger, 512);
    const options = {
      store: identity.store,
      clock: systemClock,
      sessions: identity.sessions,
      identity: identity.identity,
      identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
      roleStore: createRoleStore(identity.store, AUTHORIZATION_APPLICATION_ID),
      logger,
    };
    let agentAccess: AgentAccessRuntime | null = null;
    try {
      agentAccess = createAgentAccessRuntime({
        ...options,
        clients: readAgentClients(env.PEGMA_AGENT_CLIENTS_JSON),
        resourceLimitCount: knowledgeAdmissionCount(
          env.PEGMA_AGENT_RESOURCE_LIMIT,
          300,
        ),
      });
    } catch (error) {
      // An invalid optional agent registration must not disable browser guides
      // or human review. The issuer and bearer paths remain unavailable.
      logger.log('error', 'agent_access.configuration_unavailable', {
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
    const path = new URL(request.url).pathname;
    if (metadataPaths.has(path) || path.startsWith('/api/agent-access/')) {
      if (agentAccess === null)
        return unavailable('agent_access_not_configured');
      const response =
        (await agentAccess.protocol.handle(request)) ??
        (await agentAccess.api(request));
      return (
        response ??
        new Response('Not Found', {
          status: 404,
          headers: { 'Cache-Control': 'no-store' },
        })
      );
    }
    return (
      (await createKnowledgeRuntime({
        ...options,
        agentAccess,
        isEnabled: () => env.PEGMA_KNOWLEDGE_ENABLED === 'true',
        browserLimitCount: knowledgeAdmissionCount(
          env.PEGMA_KNOWLEDGE_BROWSER_LIMIT,
          120,
        ),
      }).handle(request)) ??
      new Response('Not Found', {
        status: 404,
        headers: { 'Cache-Control': 'no-store' },
      })
    );
  } catch (error) {
    logger.log('error', 'knowledge.runtime_unavailable', {
      error: error instanceof Error ? error.name : 'unknown',
    });
    return unavailable('knowledge_unavailable');
  }
}
