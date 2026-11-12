import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { unstable_readConfig } from 'wrangler';
import { createMemoryStore } from '@pegma/storage-core';
import { createRoleStore } from '@pegma/authorization-storage';
import { identityLinkKeyFromVerifiedIdentityClaims } from '@pegma/authorization-identity';
import {
  AGENT_ENDPOINTS,
  AGENT_RESOURCE,
  AGENT_RESOURCE_METADATA_URL,
  createAgentAccessRuntime,
  readAgentClients,
} from '../worker/src/agent-access-runtime';
import { createIdentityRuntime } from '../worker/src/identity-runtime';
import {
  AGENT_KNOWLEDGE_PERMISSIONS,
  AGENT_LINK_PERMISSION,
  AUTHORIZATION_APPLICATION_ID,
} from '../worker/src/support-access';

function deploymentConfiguration() {
  return unstable_readConfig({
    config: fileURLToPath(new URL('../worker/wrangler.jsonc', import.meta.url)),
  });
}

function configuredRuntime(
  raw = deploymentConfiguration().vars.PEGMA_AGENT_CLIENTS_JSON,
) {
  if (typeof raw !== 'string') throw new Error('Expected registered client JSON.');
  const store = createMemoryStore();
  const logger = { log() {} };
  const identity = createIdentityRuntime(
    {
      store,
      emailCodeSecretBase64: btoa('f'.repeat(32)),
      emailFrom: 'Pegma <fictional@example.test>',
      emailEnabled: false,
    },
    logger,
  );
  const runtime = createAgentAccessRuntime({
    store,
    sessions: identity.sessions,
    identity: identity.identity,
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
    roleStore: createRoleStore(store, AUTHORIZATION_APPLICATION_ID),
    logger,
    clients: readAgentClients(raw),
  });
  if (runtime === null) throw new Error('Expected configured Agent Access.');
  return runtime;
}

function authorizationRequest(clientId: string, redirectUri: string) {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    resource: AGENT_RESOURCE,
    scope: AGENT_KNOWLEDGE_PERMISSIONS.join(' '),
    code_challenge: 'A'.repeat(43),
    code_challenge_method: 'S256',
    state: 'fictional-config-regression',
  });
  return new Request(`${AGENT_ENDPOINTS.authorize}?${query}`);
}

describe('controlled authoring deployment registrations against released Agent Access', () => {
  it('constructs the exact checked-in four-client profile and serves both discovery documents', async () => {
    const config = deploymentConfiguration();
    expect(config.vars.PEGMA_KNOWLEDGE_ENABLED).toBe('true');
    expect(config.vars.PEGMA_SUPPORT_LEARNING_REVIEWS_ENABLED).toBe('false');
    const runtime = configuredRuntime();
    expect(runtime.configuration.clients).toEqual([
      {
        clientId: 'pg-kb-codex-accept-v1',
        name: 'Pegma Codex CLI',
        redirectUris: ['http://127.0.0.1/callback'],
        allowedScopes: [...AGENT_KNOWLEDGE_PERMISSIONS],
        grantTypes: ['authorization_code'],
      },
      {
        clientId: 'pg-kb-claude-accept-v1',
        name: 'Pegma Claude Code',
        redirectUris: ['http://localhost:48772/callback'],
        allowedScopes: [...AGENT_KNOWLEDGE_PERMISSIONS],
        grantTypes: ['authorization_code'],
      },
      {
        clientId: 'pg-kb-device-accept-v1',
        name: 'Pegma RFC 8628 control',
        redirectUris: [],
        allowedScopes: [...AGENT_KNOWLEDGE_PERMISSIONS],
        grantTypes: ['device_code'],
      },
      {
        clientId: 'pg-kb-grok-accept-v1',
        name: 'Pegma Grok Bot',
        redirectUris: ['https://www.cursor.com/agents/mcp/oauth/callback'],
        allowedScopes: [...AGENT_KNOWLEDGE_PERMISSIONS],
        grantTypes: ['authorization_code'],
      },
    ]);
    expect(AGENT_KNOWLEDGE_PERMISSIONS).toEqual([
      'knowledge.article.draft.read',
      'knowledge.article.draft.write',
      'knowledge.article.evidence.submit',
    ]);
    const authorization = await runtime.protocol.handle(
      new Request('https://pegma.dev/.well-known/oauth-authorization-server'),
    );
    expect(authorization?.status).toBe(200);
    expect(await authorization?.json()).toMatchObject({
      issuer: 'https://pegma.dev',
      authorization_endpoint: AGENT_ENDPOINTS.authorize,
      device_authorization_endpoint: AGENT_ENDPOINTS.deviceAuthorization,
      token_endpoint: AGENT_ENDPOINTS.token,
      scopes_supported: [...AGENT_KNOWLEDGE_PERMISSIONS],
      code_challenge_methods_supported: ['S256'],
    });
    const resource = await runtime.protocol.handle(
      new Request(AGENT_RESOURCE_METADATA_URL),
    );
    expect(resource?.status).toBe(200);
    expect(await resource?.json()).toMatchObject({
      resource: AGENT_RESOURCE,
      authorization_servers: ['https://pegma.dev'],
      scopes_supported: [...AGENT_KNOWLEDGE_PERMISSIONS],
    });
  });

  it.each([
    ['pg-kb-codex-accept-v1', 'http://127.0.0.1:48773/callback'],
    ['pg-kb-claude-accept-v1', 'http://localhost:48772/callback'],
    [
      'pg-kb-grok-accept-v1',
      'https://www.cursor.com/agents/mcp/oauth/callback',
    ],
  ])(
    'hands the registered %s PKCE request to existing login without approving it',
    async (clientId, redirectUri) => {
      const runtime = configuredRuntime();
      const request = authorizationRequest(clientId, redirectUri);
      const response = await runtime.protocol.handle(request);
      expect(response?.status).toBe(303);
      const location = response?.headers.get('Location');
      if (!location) throw new Error('Expected existing-login handoff.');
      const login = new URL(location);
      expect(login.origin + login.pathname).toBe('https://pegma.dev/account');
      expect(login.searchParams.get('returnTo')).toBe(
        new URL(request.url).pathname + new URL(request.url).search,
      );
    },
  );

  it.each([
    ['pg-kb-codex-accept-v1', 'http://localhost:48773/callback'],
    ['pg-kb-codex-accept-v1', 'http://127.0.0.1:48773/other'],
    ['pg-kb-claude-accept-v1', 'http://localhost:48773/callback'],
    ['pg-kb-grok-accept-v1', 'https://www.cursor.com/agents/mcp/oauth/other'],
    ['pg-kb-grok-accept-v1', 'https://cursor.com/agents/mcp/oauth/callback'],
  ])(
    'rejects unregistered callback %s %s before login',
    async (clientId, redirectUri) => {
      const response = await configuredRuntime().protocol.handle(
        authorizationRequest(clientId, redirectUri),
      );
      expect(response?.status).toBe(400);
      expect(response?.headers.get('Location')).toBeNull();
    },
  );

  it.each([
    ['PKCE downgrade', 'code_challenge_method', 'plain'],
    ['different resource', 'resource', 'https://pegma.dev/api/mcp'],
    ['scope escalation', 'scope', AGENT_LINK_PERMISSION],
  ])(
    'rejects hosted Grok %s before login',
    async (_name, parameter, value) => {
      const request = new URL(
        authorizationRequest(
          'pg-kb-grok-accept-v1',
          'https://www.cursor.com/agents/mcp/oauth/callback',
        ).url,
      );
      request.searchParams.set(parameter, value);
      const response = await configuredRuntime().protocol.handle(
        new Request(request),
      );
      expect(response?.status).toBe(400);
      expect(response?.headers.get('Location')).toBeNull();
    },
  );

  it('starts only the registered device control through the actual protocol with no redirect URI', async () => {
    const runtime = configuredRuntime();
    for (const [clientId, expectedStatus] of [
      ['pg-kb-device-accept-v1', 200],
      ['pg-kb-codex-accept-v1', 400],
    ] as const) {
      const response = await runtime.protocol.handle(
        new Request(AGENT_ENDPOINTS.deviceAuthorization, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            resource: AGENT_RESOURCE,
            scope: AGENT_KNOWLEDGE_PERMISSIONS.join(' '),
          }),
        }),
      );
      expect(response?.status).toBe(expectedStatus);
      if (expectedStatus === 200) {
        expect(await response?.json()).toMatchObject({
          user_code: expect.any(String),
          device_code: expect.any(String),
          verification_uri: AGENT_ENDPOINTS.verification,
        });
      }
    }
  });

  it.each([
    ['scope escalation', 0, { allowedScopes: [AGENT_LINK_PERMISSION] }],
    ['wildcard callback', 0, { redirectUris: ['http://127.0.0.1/*'] }],
    ['missing localhost port', 1, { redirectUris: ['http://localhost/callback'] }],
    [
      'authorization code without callback',
      2,
      { grantTypes: ['authorization_code'] },
    ],
  ] as const)(
    'rejects %s when a checked-in registration drifts',
    (_name, index, change) => {
      const raw = deploymentConfiguration().vars.PEGMA_AGENT_CLIENTS_JSON;
      if (typeof raw !== 'string') throw new Error('Expected registered client JSON.');
      const clients = readAgentClients(raw);
      if (clients === null) throw new Error('Expected registered clients.');
      const changed = clients.map((client, current) =>
        current === index ? { ...client, ...change } : client,
      );
      expect(() => configuredRuntime(JSON.stringify(changed))).toThrow();
    },
  );
});
