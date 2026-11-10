import { identityLinkKeyFromVerifiedIdentityClaims } from '@pegma/authorization-identity';
import { createSessionStore } from '@pegma/sessions';
import {
  createMemoryStore,
  type CollectionDefinition,
  type CollectionStore,
  type Store,
} from '@pegma/storage-core';
import { describe, expect, it, vi } from 'vitest';
import {
  createIdentityApi,
  IDENTITY_ISSUER,
  SESSION_COOKIE,
} from './identity-api';
import { createIdentityRuntime } from './identity-runtime';

const SUBJECT = 'synthetic-session-probe-owner';
const SESSION = 's'.repeat(43);
const CSRF = 'c'.repeat(43);

async function fixture() {
  const backing = createMemoryStore();
  let interruptProvisioning = false;
  // Leave a real SDK-created pending user when its public provisioning call
  // encounters a storage failure. No private record or key is manufactured.
  const store: Store = {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      const target = backing.collection(definition);
      if (definition.name !== 'pegma_identity_users') return target;
      return {
        ...target,
        async insertIfAbsent(record) {
          const result = await target.insertIfAbsent(record);
          if (interruptProvisioning)
            throw new Error('Synthetic storage interruption');
          return result;
        },
      };
    },
  };
  const logger = { log: vi.fn() };
  const runtime = createIdentityRuntime(
    {
      store,
      emailCodeSecretBase64: btoa('s'.repeat(32)),
      emailFrom: 'Pegma <identity@example.test>',
      emailEnabled: false,
    },
    logger,
  );
  const identity = runtime.identity;
  const sessions = createSessionStore(store, { logger });
  await identity.provisionVerifiedUser({
    principalId: SUBJECT,
    email: 'session-owner@example.test',
  });
  async function issue(
    sessionId = SESSION,
    subject = SUBJECT,
    csrfToken = CSRF,
  ) {
    await sessions.create(sessionId, {
      principalId: subject,
      data: JSON.stringify({
        version: 1,
        issuer: IDENTITY_ISSUER,
        subject,
        csrfToken,
      }),
    });
    return SESSION_COOKIE + '=' + sessionId;
  }
  const cookie = await issue();
  let rejectPasskeyListing = false;
  const listPasskeys = vi.fn(
    (principalId: Parameters<typeof identity.listPasskeys>[0]) => {
      if (rejectPasskeyListing)
        throw new Error('Synthetic passkey-list failure');
      return identity.listPasskeys(principalId);
    },
  );
  const getUser = vi.fn((principalId: Parameters<typeof identity.getUser>[0]) =>
    identity.getUser(principalId),
  );
  const claimsFor = vi.fn(
    (principalId: Parameters<typeof identity.claimsFor>[0]) =>
      identity.claimsFor(principalId),
  );
  const getSession = vi.fn((...args: Parameters<typeof sessions.get>) =>
    sessions.get(...args),
  );
  const api = createIdentityApi({
    sessions: { ...sessions, get: getSession },
    identity: { ...identity, listPasskeys, getUser, claimsFor },
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
    logger,
  });
  function request(headers: HeadersInit = { Cookie: cookie }) {
    return new Request(IDENTITY_ISSUER + '/api/identity/session', { headers });
  }
  return {
    api,
    identity,
    sessions,
    issue,
    cookie,
    request,
    listPasskeys,
    claimsFor,
    getUser,
    getSession,
    rejectPasskeyListing: () => {
      rejectPasskeyListing = true;
    },
    async pendingUser() {
      interruptProvisioning = true;
      try {
        await expect(
          identity.provisionVerifiedUser({
            principalId: 'synthetic-pending-user',
            email: 'pending-session@example.test',
          }),
        ).rejects.toThrow('Synthetic storage interruption');
      } finally {
        interruptProvisioning = false;
      }
      const pending = await identity.getUser('synthetic-pending-user');
      if (pending === null)
        throw new Error('Expected the actual retained pending user');
      expect(pending).toMatchObject({
        status: 'pending',
        emailVerified: false,
      });
      return pending.principalId;
    },
  };
}

describe('minimal browser support-session probe over real Identity and Sessions', () => {
  it('returns only current subject and CSRF through the existing private JSON boundary', async () => {
    const f = await fixture();
    const response = await f.api(f.request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      account: { subject: SUBJECT },
      csrfToken: CSRF,
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(response.headers.get('vary')).toBe('Cookie');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(f.claimsFor).toHaveBeenCalledWith(SUBJECT);
    expect(f.getUser).toHaveBeenCalledWith(SUBJECT);
    expect(f.listPasskeys).not.toHaveBeenCalled();
  });

  it('remains usable when optional passkey listing would fail', async () => {
    const f = await fixture();
    f.rejectPasskeyListing();
    const response = await f.api(f.request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      account: { subject: SUBJECT },
      csrfToken: CSRF,
    });
    expect(f.listPasskeys).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    SESSION_COOKIE + '=invalid',
    SESSION_COOKIE + '=' + SESSION + '; ' + SESSION_COOKIE + '=' + SESSION,
  ])(
    'refuses missing, malformed or duplicate cookies without reading identity: %s',
    async (cookie) => {
      const f = await fixture();
      const response = await f.api(
        f.request(cookie === undefined ? {} : { Cookie: cookie }),
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: 'authentication_required',
      });
      expect(f.getSession).not.toHaveBeenCalled();
      expect(f.claimsFor).not.toHaveBeenCalled();
      expect(f.getUser).not.toHaveBeenCalled();
      expect(f.listPasskeys).not.toHaveBeenCalled();
    },
  );

  it.each(['', 'Bearer synthetic-agent-token', 'Basic synthetic'])(
    'rejects any Authorization header before cookie authentication: %s',
    async (authorization) => {
      const f = await fixture();
      const response = await f.api(
        f.request({ Cookie: f.cookie, Authorization: authorization }),
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: 'authentication_required',
      });
      expect(f.getSession).not.toHaveBeenCalled();
      expect(f.claimsFor).not.toHaveBeenCalled();
      expect(f.listPasskeys).not.toHaveBeenCalled();
    },
  );

  it('uses the existing CSRF/session for logout and rejects the destroyed cookie afterward', async () => {
    const f = await fixture();
    const probe = await f.api(f.request());
    expect(await probe.json()).toEqual({
      account: { subject: SUBJECT },
      csrfToken: CSRF,
    });
    const logout = await f.api(
      new Request(IDENTITY_ISSUER + '/api/identity/logout', {
        method: 'POST',
        headers: {
          Cookie: f.cookie,
          Origin: IDENTITY_ISSUER,
          'Sec-Fetch-Site': 'same-origin',
          'X-Pegma-CSRF': CSRF,
          'Content-Type': 'application/json',
        },
        body: '{}',
      }),
    );
    expect(logout.status).toBe(200);
    expect(await logout.json()).toEqual({ authenticated: false });
    expect(await f.sessions.get(SESSION)).toBeNull();
    const after = await f.api(f.request());
    expect(after.status).toBe(401);
    expect(await after.json()).toEqual({ error: 'authentication_required' });
    expect(after.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(f.listPasskeys).not.toHaveBeenCalled();
  });

  it('observes a replacement cookie identity and CSRF without reviving the old session', async () => {
    const f = await fixture();
    await f.identity.provisionVerifiedUser({
      principalId: 'synthetic-session-replacement',
      email: 'replacement@example.test',
    });
    await f.sessions.destroy(SESSION);
    const replacement = await f.issue(
      'r'.repeat(43),
      'synthetic-session-replacement',
      'n'.repeat(43),
    );
    expect((await f.api(f.request())).status).toBe(401);
    const current = await f.api(f.request({ Cookie: replacement }));
    expect(current.status).toBe(200);
    expect(await current.json()).toEqual({
      account: { subject: 'synthetic-session-replacement' },
      csrfToken: 'n'.repeat(43),
    });
    expect(f.listPasskeys).not.toHaveBeenCalled();
  });

  it('rejects real principal-wide session revocation on the next probe', async () => {
    const f = await fixture();
    expect(await f.sessions.destroyAllForPrincipal(SUBJECT)).toBe(1);
    const response = await f.api(f.request());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'authentication_required' });
    expect(f.claimsFor).not.toHaveBeenCalled();
    expect(f.listPasskeys).not.toHaveBeenCalled();
  });

  it('invalidates a session for an actual pending and unverified SDK user', async () => {
    const f = await fixture();
    const subject = await f.pendingUser();
    const id = 'p'.repeat(43);
    const cookie = await f.issue(id, subject);
    const response = await f.api(f.request({ Cookie: cookie }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'authentication_required' });
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await f.sessions.get(id)).toBeNull();
    expect(f.claimsFor).toHaveBeenCalledWith(subject);
    expect(f.listPasskeys).not.toHaveBeenCalled();
  });

  it('invalidates a session whose subject has no current real Identity account', async () => {
    const f = await fixture();
    const id = 'm'.repeat(43);
    const cookie = await f.issue(id, 'synthetic-missing-user');
    const response = await f.api(f.request({ Cookie: cookie }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'authentication_required' });
    expect(await f.sessions.get(id)).toBeNull();
    expect(f.listPasskeys).not.toHaveBeenCalled();
  });
});
