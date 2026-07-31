import { identityLinkKeyFromVerifiedIdentityClaims } from '@pegma/authorization-identity';
import { createMemoryStore } from '@pegma/storage-core';
import { createSessionStore } from '@pegma/sessions';
import { fixedClock, type Logger, type PrincipalId } from '@pegma/spine';
import { describe, expect, it, vi } from 'vitest';
import { classifyLookup, createAdminApi } from './admin-api';
import { IDENTITY_ISSUER, SESSION_COOKIE } from './identity-api';
import type {
  IdentityPort,
  IdentityUser,
  VerifiedIdentityClaims,
} from './identity-contracts';
import { createRoleHolderIndex } from './role-holder-index';
import { ADMIN_ROLE, SUPPORT_ROLE } from './support-access';
import {
  createAdminLookupLimiter,
  createAdminMutationLimiter,
  createSupportRuntime,
} from './support-desk';

const admin = 'principal-admin' as PrincipalId;
const secondAdmin = 'principal-admin-2' as PrincipalId;
const member = 'principal-member' as PrincipalId;
const clock = fixedClock('2026-07-31T12:00:00.000Z');
const logger: Logger = { log: vi.fn() };

function userFor(principalId: PrincipalId, email: string): IdentityUser {
  return {
    principalId,
    email,
    emailVerified: true,
    status: 'active',
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
  };
}

function identityFor(
  users: ReadonlyMap<PrincipalId, IdentityUser>,
): IdentityPort {
  return {
    claimsFor: vi.fn(async (principalId: PrincipalId) => {
      const user = users.get(principalId);
      if (user === undefined) {
        throw Object.assign(new Error('not found'), { code: 'not_found' });
      }
      return {
        issuer: IDENTITY_ISSUER,
        subject: principalId,
        emailVerified: true,
      } satisfies VerifiedIdentityClaims;
    }),
    findUserByEmail: vi.fn(async (email: string) => {
      for (const user of users.values()) {
        if (user.email === email.trim().toLowerCase()) return user;
      }
      return null;
    }),
    getUser: vi.fn(
      async (principalId: PrincipalId) => users.get(principalId) ?? null,
    ),
    beginPasskeyRegistration: vi.fn(),
    finishPasskeyRegistration: vi.fn(),
    beginPasskeyAuthentication: vi.fn(),
    finishPasskeyAuthentication: vi.fn(),
    listPasskeys: vi.fn(async () => []),
    removePasskey: vi.fn(async () => true),
  };
}

let sessionSerial = 0;

async function sessionCookie(
  sessions: ReturnType<typeof createSessionStore>,
  principalId: PrincipalId,
  csrfToken = 'c'.repeat(43),
): Promise<{ cookie: string; csrfToken: string }> {
  sessionSerial += 1;
  const sessionId = `${String(sessionSerial).padStart(2, '0')}${'a'.repeat(41)}`;
  await sessions.create(sessionId, {
    principalId,
    data: JSON.stringify({
      version: 1,
      csrfToken,
      issuer: IDENTITY_ISSUER,
      subject: principalId,
    }),
  });
  return { cookie: `${SESSION_COOKIE}=${sessionId}`, csrfToken };
}

function get(path: string, cookie?: string): Request {
  return new Request(`https://pegma.dev${path}`, {
    headers: cookie === undefined ? {} : { Cookie: cookie },
  });
}

function mutate(
  method: 'POST' | 'DELETE',
  path: string,
  auth: { cookie: string; csrfToken: string },
  body?: unknown,
): Request {
  return new Request(`https://pegma.dev${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      Origin: IDENTITY_ISSUER,
      'Sec-Fetch-Site': 'same-origin',
      Cookie: auth.cookie,
      'X-Pegma-CSRF': auth.csrfToken,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function fixture(options: { bootstrapPrincipals?: readonly PrincipalId[] } = {}) {
  const store = createMemoryStore();
  const sessions = createSessionStore(store, { logger });
  const users = new Map<PrincipalId, IdentityUser>([
    [admin, userFor(admin, 'admin@example.test')],
    [secondAdmin, userFor(secondAdmin, 'admin2@example.test')],
    [member, userFor(member, 'member@example.test')],
  ]);
  const identity = identityFor(users);
  const runtime = createSupportRuntime({
    store,
    sessions,
    identity,
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
    logger,
    clock,
  });
  const api = createAdminApi({
    sessions,
    identity,
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
    logger,
    roleStore: runtime.roleStore,
    holderIndex: createRoleHolderIndex(store),
    mutationLimiter: createAdminMutationLimiter(store, clock),
    lookupLimiter: createAdminLookupLimiter(store, clock),
    bootstrapPrincipals: new Set(options.bootstrapPrincipals ?? []),
  });
  return { api, sessions, identity, roleStore: runtime.roleStore };
}

/** Seed the first administrator the way the bootstrap touch would. */
async function bootstrappedAdmin(
  options: { bootstrapArmed?: boolean } = {},
) {
  const world = fixture({ bootstrapPrincipals: [admin] });
  const auth = await sessionCookie(world.sessions, admin, 'b'.repeat(43));
  // The first authenticated admin-surface touch seeds Admin, then passes
  // the permission check on the same request.
  const state = await world.api(get('/api/admin/state', auth.cookie));
  expect(state.status).toBe(200);
  expect(((await state.json()) as { bootstrapArmed: boolean }).bootstrapArmed).toBe(
    options.bootstrapArmed ?? true,
  );
  return { ...world, auth };
}

describe('classifyLookup', () => {
  it('routes anything containing @ to email and everything else to id', () => {
    expect(classifyLookup('person@example.test')).toBe('email');
    expect(classifyLookup('a41f406e-6e58-4090-b5b9-62bf7a8ab65d')).toBe(
      'principalId',
    );
    // Identity's normalization rejects malformed addresses; the classifier
    // only decides which endpoint answers, never whether input is valid.
    expect(classifyLookup('@')).toBe('email');
    expect(classifyLookup('not-an-email')).toBe('principalId');
  });
});

describe('one search box', () => {
  it('resolves a principal id', async () => {
    const { api, auth } = await bootstrappedAdmin();
    const response = await api(
      mutate('POST', '/api/admin/lookup', auth, { query: admin }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      matchedBy: string;
      principal: { principalId: string; email: string };
      roles: readonly { role: string }[];
    };
    expect(body.matchedBy).toBe('principalId');
    expect(body.principal.principalId).toBe(admin);
    expect(body.roles.map((role) => role.role)).toEqual([ADMIN_ROLE]);
  });

  it('resolves an email and hands Identity the value verbatim', async () => {
    const { api, auth, identity } = await bootstrappedAdmin();
    const response = await api(
      mutate('POST', '/api/admin/lookup', auth, {
        query: '  Member@Example.TEST  ',
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      matchedBy: string;
      principal: { principalId: string };
    };
    expect(body.matchedBy).toBe('email');
    expect(body.principal.principalId).toBe(member);
    // Exactly one email normalization function exists and it lives in
    // Identity: the host trims the text-box value and passes it through
    // untouched — no host-side lowercasing.
    expect(identity.findUserByEmail).toHaveBeenCalledWith('Member@Example.TEST');
  });

  it('answers 404 for an unknown principal and 400 for unusable input', async () => {
    const { api, auth } = await bootstrappedAdmin();
    expect(
      (
        await api(
          mutate('POST', '/api/admin/lookup', auth, {
            query: 'nobody@example.test',
          }),
        )
      ).status,
    ).toBe(404);
    expect(
      (await api(mutate('POST', '/api/admin/lookup', auth, { query: '   ' })))
        .status,
    ).toBe(400);
    expect(
      (
        await api(
          mutate('POST', '/api/admin/lookup', auth, {
            query: `${'x'.repeat(320)}@example.test`,
          }),
        )
      ).status,
    ).toBe(400);
  });

  it('maps an Identity input rejection to 400, not 500', async () => {
    const world = await bootstrappedAdmin();
    world.identity.findUserByEmail = vi.fn(async () => {
      throw Object.assign(new Error('bad'), { code: 'invalid_input' });
    });
    const response = await world.api(
      mutate('POST', '/api/admin/lookup', world.auth, { query: 'a@b@c' }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_query' });
  });

  it('is gated on the Admin role and CSRF like every other admin route', async () => {
    const { api, sessions } = fixture();
    const nobody = await sessionCookie(sessions, member, 'q'.repeat(43));
    expect(
      (
        await api(
          mutate(
            'POST',
            '/api/admin/lookup',
            { cookie: nobody.cookie, csrfToken: nobody.csrfToken },
            { query: member },
          ),
        )
      ).status,
    ).toBe(403);

    // A separate world: its session store owns the admin cookie below.
    const bootstrapped = await bootstrappedAdmin();
    const noCsrf = new Request('https://pegma.dev/api/admin/lookup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: IDENTITY_ISSUER,
        'Sec-Fetch-Site': 'same-origin',
        Cookie: bootstrapped.auth.cookie,
      },
      body: JSON.stringify({ query: admin }),
    });
    expect((await bootstrapped.api(noCsrf)).status).toBe(403);
  });
});

describe('admin API access', () => {
  it('requires authentication and the Admin role, fail-closed order', async () => {
    const { api, sessions } = fixture();
    expect((await api(get('/api/admin/state'))).status).toBe(401);

    const nobody = await sessionCookie(sessions, member, 'n'.repeat(43));
    const forbidden = await api(get('/api/admin/state', nobody.cookie));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: 'forbidden' });
  });

  it('bootstrap seeds a listed principal on the first touch; the marker is history-durable', async () => {
    const { api, roleStore, auth } = await bootstrappedAdmin();
    const held = await roleStore.listActiveRoleAssignments(admin, {
      kind: 'application',
    });
    expect(held.map((assignment) => assignment.role)).toEqual([ADMIN_ROLE]);
    expect(held[0]!.grantedBy).toEqual({
      kind: 'system',
      systemId: 'bootstrap',
    });

    // Grant a second admin, then revoke the seeded one; a further touch
    // must NOT reseed — lifecycle history is the durable evidence.
    const assign = await api(
      mutate('POST', `/api/admin/principals/${secondAdmin}/roles`, auth, {
        role: ADMIN_ROLE,
      }),
    );
    expect(assign.status).toBe(201);
    const revoke = await api(
      mutate(
        'DELETE',
        `/api/admin/assignments/${held[0]!.id}`,
        auth,
      ),
    );
    expect(revoke.status).toBe(200);
    const after = await api(get('/api/admin/state', auth.cookie));
    expect(after.status).toBe(403);
    expect(
      await roleStore.listActiveRoleAssignments(admin, { kind: 'application' }),
    ).toEqual([]);
  });
});

describe('principal views', () => {
  it('returns the principal with managedBy-labelled roles, 404 for unknown', async () => {
    const { api, auth } = await bootstrappedAdmin();
    const detail = await api(
      get(`/api/admin/principals/${admin}`, auth.cookie),
    );
    expect(detail.status).toBe(200);
    const body = (await detail.json()) as {
      principal: { email: string };
      roles: readonly { role: string; managedBy: string }[];
    };
    expect(body.principal.email).toBe('admin@example.test');
    expect(body.roles).toEqual([
      expect.objectContaining({ role: ADMIN_ROLE, managedBy: 'human' }),
    ]);

    expect(
      (await api(get('/api/admin/principals/unknown-principal', auth.cookie)))
        .status,
    ).toBe(404);
  });

  it('renders the audited lifecycle history', async () => {
    const { api, auth } = await bootstrappedAdmin();
    const assign = await api(
      mutate('POST', `/api/admin/principals/${member}/roles`, auth, {
        role: SUPPORT_ROLE,
      }),
    );
    expect(assign.status).toBe(201);
    const assigned = (await assign.json()) as {
      roles: readonly { assignmentId: string }[];
    };
    const revoke = await api(
      mutate(
        'DELETE',
        `/api/admin/assignments/${assigned.roles[0]!.assignmentId}`,
        auth,
      ),
    );
    expect(revoke.status).toBe(200);

    const history = await api(
      get(`/api/admin/principals/${member}/history`, auth.cookie),
    );
    const events = ((await history.json()) as {
      events: readonly { kind: string; role: string }[];
    }).events;
    expect(events.map((event) => event.kind)).toEqual(['granted', 'revoked']);
  });
});

describe('role mutations', () => {
  it('assigns allowlisted roles only, to real principals only, once', async () => {
    const { api, auth } = await bootstrappedAdmin();
    expect(
      (
        await api(
          mutate('POST', `/api/admin/principals/${member}/roles`, auth, {
            role: 'Owner',
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await api(
          mutate('POST', '/api/admin/principals/unknown-principal/roles', auth, {
            role: SUPPORT_ROLE,
          }),
        )
      ).status,
    ).toBe(404);

    const first = await api(
      mutate('POST', `/api/admin/principals/${member}/roles`, auth, {
        role: SUPPORT_ROLE,
      }),
    );
    expect(first.status).toBe(201);
    const duplicate = await api(
      mutate('POST', `/api/admin/principals/${member}/roles`, auth, {
        role: SUPPORT_ROLE,
      }),
    );
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({ error: 'duplicate_role' });
  });

  it('refuses to revoke the last administrator with a typed 409', async () => {
    const { api, roleStore, auth } = await bootstrappedAdmin();
    const held = await roleStore.listActiveRoleAssignments(admin, {
      kind: 'application',
    });
    const refusal = await api(
      mutate('DELETE', `/api/admin/assignments/${held[0]!.id}`, auth),
    );
    expect(refusal.status).toBe(409);
    expect(await refusal.json()).toEqual({ error: 'last_administrator' });
  });

  it('enforces CSRF on mutations', async () => {
    const { api, auth } = await bootstrappedAdmin();
    const missingCsrf = new Request(
      `https://pegma.dev/api/admin/principals/${member}/roles`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: IDENTITY_ISSUER,
          'Sec-Fetch-Site': 'same-origin',
          Cookie: auth.cookie,
        },
        body: JSON.stringify({ role: SUPPORT_ROLE }),
      },
    );
    expect((await api(missingCsrf)).status).toBe(403);
  });
});
