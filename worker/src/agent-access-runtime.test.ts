import { describe, expect, it, vi } from 'vitest';
import { createMemoryStore } from '@pegma/storage-core';
import { createSessionStore } from '@pegma/sessions';
import { createRoleStore } from '@pegma/authorization-storage';
import { identityLinkKeyFromVerifiedIdentityClaims } from '@pegma/authorization-identity';
import { hasPermission } from '@pegma/authorization-core';
import type { PublicClient } from '@pegma/agent-access';
import type {
  IdentityPort,
  IdentityUser,
  VerifiedIdentityClaims,
} from './identity-contracts';
import { IDENTITY_ISSUER, SESSION_COOKIE } from './identity-api';
import { isPlainObject } from './api-auth';
import { createAgentPrincipalResolver } from './agent-authority';
import {
  ADMIN_ROLE,
  AGENT_KNOWLEDGE_PERMISSIONS,
  AGENT_LINK_PERMISSION,
  APPLICATION_SCOPE,
  AUTHORIZATION_APPLICATION_ID,
  KNOWLEDGE_EVIDENCE_CONFIRM_PERMISSION,
  KNOWLEDGE_ROLE,
  PEGMA_ACCESS_POLICY,
  SUPPORT_ROLE,
  SUPPORT_STAFF_PERMISSIONS,
} from './support-access';
import {
  AGENT_RESOURCE,
  createAgentAccessRuntime,
  readAgentClients,
} from './agent-access-runtime';

const client: PublicClient = {
  clientId: 'synthetic-unit-client',
  name: 'Synthetic protocol client',
  redirectUris: ['https://client.example.test/callback'],
  allowedScopes: [...AGENT_KNOWLEDGE_PERMISSIONS],
  grantTypes: ['device_code', 'authorization_code'],
};

async function body(
  response: Response | null,
): Promise<Record<string, unknown>> {
  if (response === null) throw new Error('Expected a routed response.');
  const result: unknown = await response.json();
  if (!isPlainObject(result)) throw new Error('Expected an object response.');
  return result;
}
function text(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string') throw new Error('Expected a response string.');
  return field;
}

async function fixture() {
  const store = createMemoryStore();
  const logger = { log: vi.fn() };
  const sessions = createSessionStore(store, { logger });
  const roleStore = createRoleStore(store, AUTHORIZATION_APPLICATION_ID);
  const users = new Map<string, IdentityUser>();
  for (const id of ['admin', 'other-admin', 'staff', 'knowledge', 'member'])
    users.set(id, {
      principalId: id,
      email: `${id}@example.test`,
      emailVerified: true,
      status: 'active',
      createdAt: '2026-07-31T00:00:00.000Z',
      updatedAt: '2026-07-31T00:00:00.000Z',
    });
  const identity: IdentityPort = {
    claimsFor: vi.fn(async (principalId: string) => {
      const current = users.get(principalId);
      if (current === undefined)
        throw Object.assign(new Error('not found'), { code: 'not_found' });
      if (current.status !== 'active' || !current.emailVerified)
        throw Object.assign(new Error('not active and verified'), {
          code: 'invalid_state',
        });
      return {
        issuer: IDENTITY_ISSUER,
        subject: principalId,
        emailVerified: true,
      } satisfies VerifiedIdentityClaims;
    }),
    getUser: vi.fn(
      async (principalId: string) => users.get(principalId) ?? null,
    ),
    findUserByEmail: vi.fn(async () => null),
    beginPasskeyRegistration: vi.fn(),
    finishPasskeyRegistration: vi.fn(),
    beginPasskeyAuthentication: vi.fn(),
    finishPasskeyAuthentication: vi.fn(),
    listPasskeys: vi.fn(async () => []),
    removePasskey: vi.fn(async () => true),
  };
  async function grant(principalId: string, role: string) {
    return roleStore.grantRoleAssignmentWithAudit({
      assignment: {
        id: `${principalId}-${role}`,
        principalId,
        role,
        scope: APPLICATION_SCOPE,
        grantedBy: { kind: 'principal', principalId: 'test-operator' },
        grantedAtEpochMs: 1000,
        status: 'active',
      },
      auditEventId: `grant-${principalId}-${role}`,
    });
  }
  await grant('admin', ADMIN_ROLE);
  await grant('other-admin', ADMIN_ROLE);
  await grant('staff', SUPPORT_ROLE);
  await grant('knowledge', KNOWLEDGE_ROLE);
  const cookies = new Map<string, string>();
  const rawSessions = new Map<string, string>();
  for (const [index, id] of [
    'admin',
    'other-admin',
    'staff',
    'knowledge',
    'member',
  ].entries()) {
    const raw = String(index).padStart(2, '0') + 's'.repeat(41);
    await sessions.create(raw, {
      principalId: id,
      data: JSON.stringify({
        version: 1,
        csrfToken: 'c'.repeat(43),
        issuer: IDENTITY_ISSUER,
        subject: id,
      }),
    });
    cookies.set(id, `${SESSION_COOKIE}=${raw}`);
    rawSessions.set(id, raw);
  }
  const options = {
    store,
    sessions,
    identity,
    roleStore,
    logger,
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
    clients: [client],
  };
  const candidateRuntime = createAgentAccessRuntime(options);
  if (candidateRuntime === null)
    throw new Error('Expected a configured runtime.');
  const runtime = candidateRuntime;
  function request(path: string, actor = 'admin', init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    const cookie = cookies.get(actor);
    if (cookie !== undefined) headers.set('Cookie', cookie);
    if (init.method === 'POST' || init.method === 'DELETE') {
      headers.set('Origin', IDENTITY_ISSUER);
      headers.set('Sec-Fetch-Site', 'same-origin');
      headers.set('X-Pegma-CSRF', 'c'.repeat(43));
      if (init.body !== undefined)
        headers.set('Content-Type', 'application/json');
    }
    return new Request(`${IDENTITY_ISSUER}${path}`, { ...init, headers });
  }
  async function prepared() {
    const device = await runtime.service.beginDeviceAuthorization({
      clientId: client.clientId,
      resource: AGENT_RESOURCE,
      scopes: [...AGENT_KNOWLEDGE_PERMISSIONS],
    });
    const view = await body(
      await runtime.api(
        request(`/api/agent-access/approval?user_code=${device.user_code}`),
      ),
    );
    return { device, requestId: text(view, 'requestId') };
  }
  async function approved() {
    const pending = await prepared();
    const result = await runtime.api(
      request('/api/agent-access/approval', 'admin', {
        method: 'POST',
        body: JSON.stringify({
          requestId: pending.requestId,
          decision: 'approve',
          userCode: pending.device.user_code,
          approvedScopes: [AGENT_KNOWLEDGE_PERMISSIONS[0]],
        }),
      }),
    );
    expect(result?.status).toBe(200);
    const tokens = await runtime.service.pollDeviceToken({
      clientId: client.clientId,
      resource: AGENT_RESOURCE,
      deviceCode: pending.device.device_code,
    });
    return { ...pending, tokens };
  }
  return {
    store,
    logger,
    sessions,
    rawSessions,
    roleStore,
    users,
    identity,
    options,
    runtime,
    request,
    prepared,
    approved,
  };
}

describe('Agent Access host composition', () => {
  it('applies an explicit resource budget using the existing durable limiter', async () => {
    const f = await fixture();
    const runtime = createAgentAccessRuntime({
      ...f.options,
      resourceLimitCount: 1,
    });
    if (runtime === null) throw new Error('Expected a configured runtime.');
    const request = new Request(AGENT_RESOURCE, {
      headers: { 'CF-Connecting-IP': '192.0.2.17' },
    });
    expect(await runtime.resourceLimit(request)).toMatchObject({
      allowed: true,
    });
    expect(await runtime.resourceLimit(request)).toMatchObject({
      allowed: false,
    });
    expect(runtime.limiters).toHaveLength(6);
  });

  it('requires explicit bounded public client registration', async () => {
    const f = await fixture();
    expect(readAgentClients(undefined)).toBeNull();
    expect(readAgentClients('[]')).toBeNull();
    expect(
      createAgentAccessRuntime({ ...f.options, clients: null }),
    ).toBeNull();
    expect(readAgentClients(JSON.stringify([client]))).toEqual([client]);
    expect(() => readAgentClients('x'.repeat(16385))).toThrow();
    expect(() =>
      readAgentClients(
        JSON.stringify([{ ...client, clientSecret: 'not-supported' }]),
      ),
    ).toThrow();
    expect(() =>
      readAgentClients(
        JSON.stringify([{ ...client, allowedScopes: [AGENT_LINK_PERMISSION] }]),
      ),
    ).toThrow();
    expect(() =>
      createAgentAccessRuntime({
        ...f.options,
        clients: [
          { ...client, redirectUris: ['https://client.example.test/*'] },
        ],
      }),
    ).toThrow();
  });

  it('preserves existing role lifecycle while only current Admin can link', async () => {
    const f = await fixture();
    const history = await f.roleStore.listRoleAssignments(
      'admin',
      APPLICATION_SCOPE,
    );
    expect(
      (await f.runtime.api(f.request('/api/agent-access/state')))?.status,
    ).toBe(200);
    expect(
      (await f.runtime.api(f.request('/api/agent-access/state', 'staff')))
        ?.status,
    ).toBe(403);
    expect(
      (await f.runtime.api(f.request('/api/agent-access/state', 'knowledge')))
        ?.status,
    ).toBe(403);
    expect(
      (await f.runtime.api(f.request('/api/agent-access/state', 'member')))
        ?.status,
    ).toBe(403);
    expect(
      (await f.runtime.api(f.request('/api/agent-access/state', 'absent')))
        ?.status,
    ).toBe(401);
    expect(
      await f.roleStore.listRoleAssignments('admin', APPLICATION_SCOPE),
    ).toEqual(history);
    const staff = await createAgentPrincipalResolver(f.options)('staff');
    expect(PEGMA_ACCESS_POLICY.roles?.[SUPPORT_ROLE]).toEqual(
      SUPPORT_STAFF_PERMISSIONS,
    );
    expect(staff?.permissions).not.toContain(
      KNOWLEDGE_EVIDENCE_CONFIRM_PERMISSION,
    );
    expect(staff?.permissions).not.toContain('knowledge.article.draft.write');
    expect(staff?.permissions).not.toContain('knowledge.article.publish');
    expect(staff?.permissions).not.toContain(AGENT_LINK_PERMISSION);
    expect(staff?.permissions).not.toContain('knowledge.collection.manage');
    expect(
      (await f.roleStore.listRoleAssignments('staff', APPLICATION_SCOPE)).map(
        (assignment) => assignment.role,
      ),
    ).toEqual([SUPPORT_ROLE]);
    const knowledge = await createAgentPrincipalResolver(f.options)(
      'knowledge',
    );
    expect(knowledge?.permissions).toContain(
      KNOWLEDGE_EVIDENCE_CONFIRM_PERMISSION,
    );
    expect(knowledge?.permissions).toContain('knowledge.article.publish');
    expect(knowledge?.permissions).not.toContain(AGENT_LINK_PERMISSION);
    expect(knowledge?.permissions).not.toContain('admin.role.assign');
    expect(knowledge?.permissions).not.toContain('knowledge.collection.manage');
  });

  it('rejects bearer substitution, missing CSRF, cross-origin consent and caller actors', async () => {
    const f = await fixture();
    const pending = await f.prepared();
    const command = {
      requestId: pending.requestId,
      decision: 'approve',
      userCode: pending.device.user_code,
    };
    const bearer = f.request('/api/agent-access/state');
    bearer.headers.set('Authorization', 'Bearer not-a-browser-session');
    expect((await f.runtime.api(bearer))?.status).toBe(403);
    const noCsrf = f.request('/api/agent-access/approval', 'admin', {
      method: 'POST',
      body: JSON.stringify(command),
    });
    noCsrf.headers.delete('X-Pegma-CSRF');
    expect((await f.runtime.api(noCsrf))?.status).toBe(403);
    const cross = f.request('/api/agent-access/approval', 'admin', {
      method: 'POST',
      body: JSON.stringify(command),
    });
    cross.headers.set('Origin', 'https://attacker.example.test');
    expect((await f.runtime.api(cross))?.status).toBe(403);
    expect(
      (
        await f.runtime.api(
          f.request('/api/agent-access/approval', 'admin', {
            method: 'POST',
            body: JSON.stringify({ ...command, actorId: 'other-admin' }),
          }),
        )
      )?.status,
    ).toBe(400);
    const view = await body(
      await f.runtime.api(
        f.request(
          `/api/agent-access/approval?user_code=${pending.device.user_code}`,
        ),
      ),
    );
    expect(view.status).toBe('pending');
  });

  it('uses current consent subset and never delegates staff, governance or linking authority', async () => {
    const f = await fixture();
    const { tokens } = await f.approved();
    const access = await f.runtime.protectedResource.authenticate(
      new Request(`${IDENTITY_ISSUER}/api/knowledge/v1`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      }),
    );
    if (access instanceof Response)
      throw new Error('Expected delegated access.');
    expect(access.access.permissions).toEqual([AGENT_KNOWLEDGE_PERMISSIONS[0]]);
    expect(access.access.roles).toEqual([]);
    expect(access.access.entitlements).toEqual([]);
    expect(hasPermission(access.access, AGENT_LINK_PERMISSION)).toBe(false);
    expect(
      hasPermission(access.access, KNOWLEDGE_EVIDENCE_CONFIRM_PERMISSION),
    ).toBe(false);
  });

  it('enforces owner-only grant reads and revocation, then rejects access and refresh', async () => {
    const f = await fixture();
    const { tokens, requestId } = await f.approved();
    expect(
      (
        await f.runtime.api(
          f.request(`/api/agent-access/grants/${requestId}`, 'other-admin'),
        )
      )?.status,
    ).toBe(403);
    expect(
      (
        await f.runtime.api(
          f.request(`/api/agent-access/grants/${requestId}`, 'other-admin', {
            method: 'DELETE',
          }),
        )
      )?.status,
    ).toBe(403);
    expect(
      (await f.runtime.api(f.request(`/api/agent-access/grants/${requestId}`)))
        ?.status,
    ).toBe(200);
    expect(
      (
        await f.runtime.api(
          f.request(`/api/agent-access/grants/${requestId}`, 'admin', {
            method: 'DELETE',
          }),
        )
      )?.status,
    ).toBe(204);
    await expect(
      f.runtime.service.authenticate({
        token: tokens.access_token,
        resource: AGENT_RESOURCE,
      }),
    ).rejects.toThrow();
    await expect(
      f.runtime.service.refresh({
        clientId: client.clientId,
        resource: AGENT_RESOURCE,
        refreshToken: tokens.refresh_token,
      }),
    ).rejects.toThrow();
  });

  it('honors real stored Admin revocation without caching or reseeding', async () => {
    const f = await fixture();
    const { tokens } = await f.approved();
    const record = await f.roleStore.getRoleAssignment('admin-Admin');
    if (record === null) throw new Error('Expected stored Admin assignment.');
    await f.roleStore.revokeRoleAssignmentWithAudit({
      assignmentId: 'admin-Admin',
      expectedConcurrencyToken: record.concurrencyToken,
      revokedBy: { kind: 'principal', principalId: 'other-admin' },
      revokedAtEpochMs: 2000,
      auditEventId: 'revoke-admin',
    });
    await expect(
      f.runtime.service.authenticate({
        token: tokens.access_token,
        resource: AGENT_RESOURCE,
      }),
    ).rejects.toThrow();
    await expect(
      f.runtime.service.refresh({
        clientId: client.clientId,
        resource: AGENT_RESOURCE,
        refreshToken: tokens.refresh_token,
      }),
    ).rejects.toThrow();
    expect(
      (await f.runtime.api(f.request('/api/agent-access/state')))?.status,
    ).toBe(403);
    expect(
      (await f.roleStore.getRoleAssignment('admin-Admin'))?.assignment.status,
    ).toBe('revoked');
  });

  it('rechecks active account and browser session independently', async () => {
    const f = await fixture();
    const { tokens } = await f.approved();
    const raw = f.rawSessions.get('admin');
    if (raw === undefined) throw new Error('Expected browser session.');
    await f.sessions.destroy(raw);
    expect(
      (await f.runtime.api(f.request('/api/agent-access/state')))?.status,
    ).toBe(401);
    await expect(
      f.runtime.service.authenticate({
        token: tokens.access_token,
        resource: AGENT_RESOURCE,
      }),
    ).resolves.toMatchObject({ clientId: client.clientId });
    const prior = f.users.get('admin');
    if (prior === undefined) throw new Error('Expected account.');
    f.users.set('admin', { ...prior, status: 'pending' });
    await expect(
      f.runtime.service.authenticate({
        token: tokens.access_token,
        resource: AGENT_RESOURCE,
      }),
    ).rejects.toThrow();
    await expect(
      f.runtime.service.refresh({
        clientId: client.clientId,
        resource: AGENT_RESOURCE,
        refreshToken: tokens.refresh_token,
      }),
    ).rejects.toThrow();
  });

  it('fails closed on authority infrastructure outage without logging submitted credentials', async () => {
    const f = await fixture();
    const runtime = createAgentAccessRuntime({
      ...f.options,
      roleStore: {
        listActiveRoleAssignments: async (id, scope) => {
          await f.roleStore.listActiveRoleAssignments(id, scope);
          throw new Error('private-backend-detail');
        },
      },
    });
    if (runtime === null) throw new Error('Expected configured runtime.');
    expect(
      (await runtime.api(f.request('/api/agent-access/state')))?.status,
    ).toBe(503);
    expect(JSON.stringify(f.logger.log.mock.calls)).not.toContain(
      'private-backend-detail',
    );
  });

  it('preserves the validated PKCE request through existing-login redirect', async () => {
    const f = await fixture();
    const values = new URLSearchParams({
      response_type: 'code',
      client_id: client.clientId,
      redirect_uri: client.redirectUris[0] ?? '',
      resource: AGENT_RESOURCE,
      scope: AGENT_KNOWLEDGE_PERMISSIONS.join(' '),
      code_challenge: 'A'.repeat(43),
      code_challenge_method: 'S256',
      state: 'synthetic-state',
    });
    const request = new Request(
      `${IDENTITY_ISSUER}/api/agent-access/authorize?${values}`,
    );
    const response = await f.runtime.protocol.handle(request);
    expect(response?.status).toBe(303);
    const location = response?.headers.get('Location');
    if (location === null || location === undefined)
      throw new Error('Expected login redirect.');
    const login = new URL(location);
    expect(login.origin + login.pathname).toBe(`${IDENTITY_ISSUER}/account`);
    expect(login.searchParams.get('returnTo')).toBe(
      new URL(request.url).pathname + new URL(request.url).search,
    );
    expect(
      await f.runtime.protocol.handle(
        new Request(`${IDENTITY_ISSUER}/api/mcp`),
      ),
    ).toBeNull();
  });
});
