import { identityLinkKeyFromVerifiedIdentityClaims } from '@pegma/authorization-identity';
import { hasPermission } from '@pegma/authorization-core';
import { createRoleStore } from '@pegma/authorization-storage';
import { createSessionStore } from '@pegma/sessions';
import {
  createMemoryStore,
  type CollectionDefinition,
  type CollectionStore,
  type Store,
} from '@pegma/storage-core';
import { fixedClock, type PrincipalId } from '@pegma/spine';
import { describe, expect, it, vi } from 'vitest';
import { createKnowledgeRuntime } from './knowledge-runtime';
import { IDENTITY_ISSUER, SESSION_COOKIE } from './identity-api';
import type { IdentityPort, IdentityUser } from './identity-contracts';
import {
  APPLICATION_SCOPE,
  AUTHORIZATION_APPLICATION_ID,
  KNOWLEDGE_ROLE,
  SUPPORT_STAFF_PERMISSIONS,
  staffAccessContextFromRoles,
} from './support-access';

async function fixture(options: { browserLimitCount?: number } = {}) {
  const backing = createMemoryStore();
  interface ReportRow {
    readonly articleId: string;
    readonly id: string;
    readonly payload: string;
  }
  let reportDefinition: CollectionDefinition<ReportRow> | undefined;
  const store: Store = {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      if (definition.name === 'pegma-dev.knowledge-evidence.v1')
        reportDefinition =
          definition as unknown as CollectionDefinition<ReportRow>;
      return backing.collection(definition);
    },
  };
  function reportRows() {
    if (reportDefinition === undefined)
      throw new Error('The public report factory did not open its collection.');
    return backing.collection(reportDefinition);
  }
  const clock = fixedClock('2026-11-08T12:00:00.000Z');
  const logger = { log: vi.fn() };
  const sessions = createSessionStore(store, { logger, clock });
  const roleStore = createRoleStore(store, AUTHORIZATION_APPLICATION_ID);
  const users = new Map<PrincipalId, IdentityUser>(
    ['admin', 'knowledge', 'support', 'customer'].map((principalId) => [
      principalId,
      {
        principalId,
        email: principalId + '@example.test',
        emailVerified: true,
        status: 'active',
        createdAt: clock.now(),
        updatedAt: clock.now(),
      },
    ]),
  );
  const identity: IdentityPort = {
    claimsFor: vi.fn(async (id: PrincipalId) => {
      const current = users.get(id);
      if (current === undefined)
        throw Object.assign(new Error('not found'), { code: 'not_found' });
      if (current.status !== 'active' || !current.emailVerified)
        throw Object.assign(new Error('not active and verified'), {
          code: 'invalid_state',
        });
      return {
        issuer: IDENTITY_ISSUER,
        subject: id,
        emailVerified: true as const,
      };
    }),
    getUser: vi.fn(async (id: PrincipalId) => users.get(id) ?? null),
    findUserByEmail: vi.fn(async () => null),
    beginPasskeyRegistration: vi.fn(),
    finishPasskeyRegistration: vi.fn(),
    beginPasskeyAuthentication: vi.fn(),
    finishPasskeyAuthentication: vi.fn(),
    listPasskeys: vi.fn(async () => []),
    removePasskey: vi.fn(async () => true),
  };
  for (const [id, role] of [
    ['admin', 'Admin'],
    ['knowledge', KNOWLEDGE_ROLE],
    ['support', 'Support'],
  ]) {
    if (id === undefined || role === undefined)
      throw new Error('Invalid synthetic assignment.');
    await roleStore.grantRoleAssignmentWithAudit({
      assignment: {
        id: 'role-' + id,
        principalId: id,
        role,
        scope: APPLICATION_SCOPE,
        grantedBy: { kind: 'system', systemId: 'synthetic-test' },
        grantedAtEpochMs: Date.parse(clock.now()),
        status: 'active',
      },
      auditEventId: 'grant-' + id,
    });
  }
  const cookies = new Map<string, string>();
  let index = 0;
  for (const id of users.keys()) {
    index += 1;
    const sessionId = String(index).repeat(43);
    await sessions.create(sessionId, {
      principalId: id,
      data: JSON.stringify({
        version: 1,
        csrfToken: 'c'.repeat(43),
        issuer: IDENTITY_ISSUER,
        subject: id,
      }),
    });
    cookies.set(id, SESSION_COOKIE + '=' + sessionId);
  }
  const runtime = createKnowledgeRuntime({
    store,
    clock,
    sessions,
    identity,
    roleStore,
    logger,
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
    agentAccess: null,
    ...options,
  });
  async function request(
    path: string,
    options: {
      principal?: string;
      body?: unknown;
      headers?: Record<string, string>;
      method?: string;
    } = {},
  ) {
    const method =
      options.method ?? (options.body === undefined ? 'GET' : 'POST');
    const response = await runtime.handle(
      new Request(IDENTITY_ISSUER + path, {
        method,
        headers: {
          Cookie: cookies.get(options.principal ?? 'admin') ?? '',
          Origin: IDENTITY_ISSUER,
          'Sec-Fetch-Site': 'same-origin',
          'X-Pegma-CSRF': 'c'.repeat(43),
          ...(options.body === undefined
            ? {}
            : { 'Content-Type': 'application/json' }),
          ...options.headers,
        },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
      }),
    );
    if (response === null)
      throw new Error('Expected matching knowledge route.');
    return response;
  }
  const command = (operation: string, input: unknown, principal = 'admin') =>
    request('/api/staff/knowledge/command', {
      principal,
      body: { operation, input },
    });
  return {
    store,
    reportRows,
    runtime,
    request,
    command,
    roleStore,
    users,
    logger,
  };
}

describe('Knowledge Base browser composition', () => {
  it('keeps browser governance usable with no registered OAuth clients', async () => {
    const f = await fixture();
    const state = await f.request('/api/staff/knowledge/state');
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({
      attesterId: 'admin',
      csrfToken: 'c'.repeat(43),
      permissions: {
        collectionManage: true,
        validationManage: true,
        evidenceConfirm: true,
      },
    });
    expect(
      (
        await f.command('createCollection', {
          commandId: 'create',
          correlationId: 'test',
          expectedGeneration: 0,
          collectionId: 'guides',
          name: 'Guides',
        })
      ).status,
    ).toBe(200);
    expect(
      (await f.command('getCollection', { collectionId: 'guides' })).status,
    ).toBe(200);
    for (const path of [
      '/api/knowledge/mcp',
      '/api/knowledge/v1',
      '/api/knowledge/reports',
    ]) {
      const disabled = await f.request(path);
      expect(disabled.status).toBe(503);
      expect(await disabled.json()).toEqual({
        error: 'agent_access_not_configured',
      });
    }
    expect(
      await f.runtime.handle(new Request(IDENTITY_ISSUER + '/unmatched')),
    ).toBeNull();
  });

  it('gives explicitly granted Knowledge staff review controls without collection/governance mutation', async () => {
    const f = await fixture();
    const state = await f.request('/api/staff/knowledge/state', {
      principal: 'knowledge',
    });
    expect(await state.json()).toMatchObject({
      attesterId: 'knowledge',
      permissions: {
        collectionManage: false,
        validationManage: false,
        evidenceConfirm: true,
        review: true,
        publish: true,
      },
    });
    await f.command('createCollection', {
      commandId: 'create',
      correlationId: 'test',
      expectedGeneration: 0,
      collectionId: 'guides',
      name: 'Guides',
    });
    expect(
      (
        await f.command(
          'getCollection',
          { collectionId: 'guides' },
          'knowledge',
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await f.command(
          'getGovernanceConfiguration',
          { collectionId: 'guides' },
          'knowledge',
        )
      ).status,
    ).toBe(403);
    expect(
      (await f.command('putValidationPolicy', {}, 'knowledge')).status,
    ).toBe(403);
    expect(
      (
        await f.command(
          'createCollection',
          {
            commandId: 'forbidden',
            correlationId: 'test',
            expectedGeneration: 0,
            collectionId: 'other',
            name: 'Other',
          },
          'knowledge',
        )
      ).status,
    ).toBe(403);
    expect(
      (await f.command('getCollection', { collectionId: 'other' })).status,
    ).toBe(404);
  });

  it('keeps historical Support grants limited to human support without staff KB powers', async () => {
    const f = await fixture();
    const support = await staffAccessContextFromRoles('support', f.roleStore);
    expect(support).not.toBeNull();
    if (support === null)
      throw new Error('Historical Support authority must remain.');
    expect(
      SUPPORT_STAFF_PERMISSIONS.every((permission) =>
        hasPermission(support, permission),
      ),
    ).toBe(true);
    expect(
      (await f.request('/api/staff/knowledge/state', { principal: 'support' }))
        .status,
    ).toBe(403);
    for (const operation of [
      'getDraft',
      'getEvidence',
      'reportRead',
      'confirmReport',
      'submitForReview',
      'publishArticle',
    ]) {
      expect(
        (await f.command(operation, { articleId: 'guide' }, 'support')).status,
      ).toBe(403);
    }
  });

  it('separates the signed-in portal DTOs from private staff operations', async () => {
    const f = await fixture();
    expect(
      (await f.request('/api/staff/knowledge/state', { principal: 'customer' }))
        .status,
    ).toBe(403);
    expect(
      (await f.command('getDraft', { articleId: 'private' }, 'customer'))
        .status,
    ).toBe(403);
    const collections = await f.request('/api/knowledge/portal', {
      principal: 'customer',
      body: { operation: 'listPortalCollections', input: {} },
    });
    expect(collections.status).toBe(200);
    expect(await collections.json()).toEqual({
      outcome: 'no_result',
      collections: [],
    });
    const draft = await f.request('/api/knowledge/portal', {
      principal: 'customer',
      body: { operation: 'getDraft', input: { articleId: 'private' } },
    });
    expect(draft.status).toBe(400);
    expect(await draft.json()).toEqual({ error: 'unknown_operation' });
    const state = await f.request('/api/staff/knowledge/state', {
      headers: { Authorization: 'Bearer not-a-browser-session' },
    });
    expect(state.status).toBe(403);
    expect(await state.json()).toEqual({ error: 'browser_session_required' });
  });

  it('checks same-origin CSRF and the exact released DTO before mutation', async () => {
    const f = await fixture();
    const body = {
      operation: 'createCollection',
      input: {
        commandId: 'unsafe',
        correlationId: 'test',
        expectedGeneration: 0,
        collectionId: 'guides',
        name: 'Guides',
      },
    };
    expect(
      (
        await f.request('/api/staff/knowledge/command', {
          body,
          headers: { Origin: 'https://attacker.example' },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.request('/api/staff/knowledge/command', {
          body,
          headers: { 'X-Pegma-CSRF': 'x'.repeat(43) },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.command('createCollection', {
          ...body.input,
          administrator: true,
        })
      ).status,
    ).toBe(400);
    expect((await f.command('__proto__', {})).status).toBe(400);
    expect(
      (await f.command('getCollection', { collectionId: 'guides' })).status,
    ).toBe(404);
  });

  it('does not expose unsupported provenance writes through any browser draft command', async () => {
    const f = await fixture();
    expect(
      (
        await f.command('setProvenance', {
          commandId: 'source',
          articleId: 'guide',
          references: [],
        })
      ).status,
    ).toBe(400);
    for (const operation of ['createDraft', 'updateDraft']) {
      for (const sourceReferences of [
        [],
        [
          {
            id: 'private',
            system: 'unsupported',
            resourceId: 'resource',
            version: '1',
          },
        ],
      ]) {
        const rejected = await f.command(operation, {
          commandId: operation,
          sourceReferences,
        });
        expect(rejected.status).toBe(400);
        expect(await rejected.json()).toEqual({
          error: 'unsupported_source_references',
        });
      }
    }
  });

  it('honors actual stored role and identity revocation on the next request', async () => {
    const f = await fixture();
    const assignment = await f.roleStore.getRoleAssignment('role-knowledge');
    if (assignment === null) throw new Error('Missing actual role assignment.');
    await f.roleStore.revokeRoleAssignmentWithAudit({
      assignmentId: 'role-knowledge',
      expectedConcurrencyToken: assignment.concurrencyToken,
      revokedBy: { kind: 'principal', principalId: 'admin' },
      revokedAtEpochMs: Date.parse('2026-11-08T12:00:00.000Z'),
      reason: 'Synthetic revocation',
      auditEventId: 'revoke-knowledge',
    });
    expect(
      (
        await f.request('/api/staff/knowledge/state', {
          principal: 'knowledge',
        })
      ).status,
    ).toBe(403);
    const user = f.users.get('admin');
    if (user === undefined) throw new Error('Missing synthetic user.');
    f.users.set('admin', { ...user, status: 'pending' });
    expect((await f.request('/api/staff/knowledge/state')).status).toBe(401);
    const portal = await f.request('/api/knowledge/portal', {
      principal: 'customer',
      body: { operation: 'listPortalCollections', input: {} },
    });
    expect(portal.headers.get('Cache-Control')).toBe('no-store');
    expect(portal.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(portal.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('exposes the actual durable browser limiter with a bounded configurable budget', async () => {
    const f = await fixture({ browserLimitCount: 1 });
    expect(f.runtime.limiters).toHaveLength(1);
    expect(typeof f.runtime.limiters[0]?.sweep).toBe('function');
    expect((await f.request('/api/staff/knowledge/state')).status).toBe(200);
    const limited = await f.request('/api/staff/knowledge/state');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('300');
    await expect(fixture({ browserLimitCount: 0 })).rejects.toThrow(TypeError);
    await expect(fixture({ browserLimitCount: 10_001 })).rejects.toThrow(
      TypeError,
    );
  });

  it('reports persisted ledger corruption as an internal fault without logging its body', async () => {
    const f = await fixture();
    const privatePayload = 'private-report-corruption-marker';
    await f.reportRows().put({
      articleId: 'broken',
      id: 'head',
      payload: privatePayload,
    });
    const result = await f.command(
      'reportLedger',
      { articleId: 'broken' },
      'knowledge',
    );
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: 'service_unavailable' });
    expect(f.logger.log).toHaveBeenCalledWith(
      'error',
      'knowledge.api_unavailable',
      { error: 'KnowledgeLedgerError', stage: 'head_decode' },
    );
    expect(JSON.stringify(f.logger.log.mock.calls)).not.toContain(
      privatePayload,
    );
    const malformed = await f.command(
      'reportLedger',
      { articleId: 'broken', injected: true },
      'knowledge',
    );
    expect(malformed.status).toBe(400);
  });
});
