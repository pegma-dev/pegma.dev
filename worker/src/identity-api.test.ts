import { describe, expect, it, vi } from 'vitest';
import type { Logger, PrincipalId } from '@pegma/spine';
import type { NewSession, SessionRecord, SessionStore } from '@pegma/sessions';
import {
  createIdentityApi,
  IDENTITY_ISSUER,
  SESSION_COOKIE,
} from './identity-api';
import type {
  EmailCodeIdentityPort,
  IdentityPort,
  VerifiedIdentityClaims,
} from './identity-contracts';

const principalId = 'principal-1' as PrincipalId;
const claims: VerifiedIdentityClaims = {
  issuer: IDENTITY_ISSUER,
  subject: principalId,
  emailVerified: true,
};

class TestSessions implements SessionStore {
  readonly records = new Map<string, SessionRecord>();
  readonly destroyed: string[] = [];

  async create(sessionId: string, session: NewSession): Promise<SessionRecord> {
    const record: SessionRecord = {
      ...session,
      createdAt: '2026-07-28T00:00:00.000Z',
      expiresAt: '2026-08-04T00:00:00.000Z',
      lastSeenAt: '2026-07-28T00:00:00.000Z',
    };
    this.records.set(sessionId, record);
    return record;
  }

  async get(sessionId: string): Promise<SessionRecord | null> {
    return this.records.get(sessionId) ?? null;
  }

  async destroy(sessionId: string): Promise<void> {
    this.destroyed.push(sessionId);
    this.records.delete(sessionId);
  }

  async destroyAllForPrincipal(subject: PrincipalId): Promise<number> {
    let removed = 0;
    for (const [id, record] of this.records) {
      if (record.principalId === subject) {
        this.records.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  async purgeExpired(): Promise<number> {
    return 0;
  }
}

function identity(overrides: Partial<IdentityPort> = {}): IdentityPort {
  return {
    claimsFor: vi.fn(async () => claims),
    getUser: vi.fn(async () => ({
      principalId,
      email: 'person@example.test',
      emailVerified: true,
      status: 'active' as const,
      createdAt: '2026-07-28T00:00:00.000Z',
      updatedAt: '2026-07-28T00:00:00.000Z',
    })),
    beginPasskeyRegistration: vi.fn(async () => ({
      challengeHandle: 'registration-handle',
      options: { challenge: 'registration-challenge' },
    })),
    finishPasskeyRegistration: vi.fn(async () => ({
      credentialId: 'credential',
      label: 'Laptop',
      transports: ['internal'],
      createdAt: '2026-07-28T00:00:00.000Z',
      lastUsedAt: null,
    })),
    beginPasskeyAuthentication: vi.fn(async () => ({
      challengeHandle: 'authentication-handle',
      options: { challenge: 'authentication-challenge' },
    })),
    finishPasskeyAuthentication: vi.fn(async () => claims),
    listPasskeys: vi.fn(async () => []),
    removePasskey: vi.fn(async () => true),
    ...overrides,
  };
}

const logger: Logger = { log: vi.fn() };

function deterministicRandom(): (target: Uint8Array) => Uint8Array {
  let next = 1;
  return (target) => {
    target.fill(next);
    next += 1;
    return target;
  };
}

function mutation(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  method = 'POST',
): Request {
  return new Request(`${IDENTITY_ISSUER}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Origin: IDENTITY_ISSUER,
      'Sec-Fetch-Site': 'same-origin',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get('Set-Cookie');
  expect(setCookie).not.toBeNull();
  return setCookie!.split(';', 1)[0]!;
}

function cookieToken(cookie: string): string {
  return cookie.slice(cookie.indexOf('=') + 1);
}

function createFixture(emailCodes?: EmailCodeIdentityPort) {
  const sessions = new TestSessions();
  const identityPort = identity();
  const projector = vi.fn((verified: VerifiedIdentityClaims) =>
    Object.freeze({
      issuer: verified.issuer,
      subject: verified.subject,
    }),
  );
  return {
    sessions,
    identityPort,
    projector,
    api: createIdentityApi({
      sessions,
      identity: identityPort,
      identityLinkFromClaims: projector,
      emailCodes,
      logger,
      randomBytes: deterministicRandom(),
    }),
  };
}

async function signIn(fixture: ReturnType<typeof createFixture>) {
  const response = await fixture.api(
    mutation('/api/identity/passkeys/authentication/verify', {
      challengeHandle: 'handle',
      response: { id: 'credential' },
    }),
  );
  const body = await response.json<{
    authenticated: boolean;
    csrfToken: string;
  }>();
  return { response, body, cookie: cookieFrom(response) };
}

describe('identity API security boundary', () => {
  it('rejects cross-origin login before calling Identity', async () => {
    const fixture = createFixture();
    const response = await fixture.api(
      new Request(
        `${IDENTITY_ISSUER}/api/identity/passkeys/authentication/options`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://attacker.example',
            'Sec-Fetch-Site': 'cross-site',
          },
          body: '{}',
        },
      ),
    );

    expect(response.status).toBe(403);
    expect(
      fixture.identityPort.beginPasskeyAuthentication,
    ).not.toHaveBeenCalled();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('rotates to an opaque secure host cookie after verified claims', async () => {
    const fixture = createFixture();
    const { response, body, cookie } = await signIn(fixture);
    const setCookie = response.headers.get('Set-Cookie')!;
    const token = cookieToken(cookie);

    expect(response.status).toBe(200);
    expect(body.authenticated).toBe(true);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(token).not.toContain(principalId);
    expect(body.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(body.csrfToken).not.toBe(token);
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(fixture.projector).toHaveBeenCalledWith(claims);

    const stored = fixture.sessions.records.get(token);
    expect(stored?.principalId).toBe(principalId);
    expect(stored?.data).not.toContain('person@example.test');
  });

  it('revalidates claims and returns a no-store account snapshot', async () => {
    const fixture = createFixture();
    const { cookie, body: signedInBody } = await signIn(fixture);
    const response = await fixture.api(
      new Request(`${IDENTITY_ISSUER}/api/identity/account`, {
        headers: { Cookie: cookie },
      }),
    );
    const body = await response.json<{
      account: { subject: string; email: string };
      csrfToken: string;
    }>();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body.account).toEqual({
      subject: principalId,
      email: 'person@example.test',
    });
    expect(body.csrfToken).toBe(signedInBody.csrfToken);
    expect(fixture.identityPort.claimsFor).toHaveBeenCalledWith(principalId);
  });

  it('requires the server-side synchronizer token for account mutation', async () => {
    const fixture = createFixture();
    const { cookie } = await signIn(fixture);
    const response = await fixture.api(
      mutation(
        '/api/identity/passkeys/registration/options',
        {},
        { Cookie: cookie, 'X-Pegma-CSRF': 'A'.repeat(43) },
      ),
    );

    expect(response.status).toBe(403);
    expect(
      fixture.identityPort.beginPasskeyRegistration,
    ).not.toHaveBeenCalled();
  });

  it('keeps a valid session when Identity has a transient failure', async () => {
    const fixture = createFixture();
    const { cookie } = await signIn(fixture);
    const token = cookieToken(cookie);
    vi.mocked(fixture.identityPort.claimsFor).mockRejectedValueOnce(
      new Error('temporary storage outage'),
    );

    const response = await fixture.api(
      new Request(`${IDENTITY_ISSUER}/api/identity/account`, {
        headers: { Cookie: cookie },
      }),
    );

    expect(response.status).toBe(500);
    expect(fixture.sessions.records.has(token)).toBe(true);
    expect(fixture.sessions.destroyed).not.toContain(token);
  });

  it('destroys the server-side session and expires the cookie on logout', async () => {
    const fixture = createFixture();
    const { cookie, body } = await signIn(fixture);
    const token = cookieToken(cookie);
    const response = await fixture.api(
      mutation(
        '/api/identity/logout',
        {},
        {
          Cookie: cookie,
          'X-Pegma-CSRF': body.csrfToken,
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(fixture.sessions.destroyed).toContain(token);
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });

  it('fails closed while email delivery and Identity releases are absent', async () => {
    const sessions = new TestSessions();
    const api = createIdentityApi({ sessions, logger });

    const capabilities = await api(
      new Request(`${IDENTITY_ISSUER}/api/identity/capabilities`),
    );
    expect(await capabilities.json()).toEqual({
      issuer: IDENTITY_ISSUER,
      rpID: 'pegma.dev',
      passkeys: false,
      emailCode: false,
    });

    const response = await api(
      mutation('/api/identity/email-code/options', {
        email: 'person@example.test',
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'email_code_unavailable',
    });
  });

  it('does not start a challenge or send mail for a partial composition', async () => {
    const sessions = new TestSessions();
    const identityPort = identity();
    const emailCodes: EmailCodeIdentityPort = {
      begin: vi.fn(async () => ({ challengeHandle: 'email-handle' })),
      finish: vi.fn(async () => claims),
    };
    const api = createIdentityApi({
      sessions,
      identity: identityPort,
      emailCodes,
      logger,
    });

    const passkey = await api(
      mutation('/api/identity/passkeys/authentication/options', {}),
    );
    const email = await api(
      mutation('/api/identity/email-code/options', {
        email: 'person@example.test',
      }),
    );

    expect(passkey.status).toBe(503);
    expect(email.status).toBe(503);
    expect(identityPort.beginPasskeyAuthentication).not.toHaveBeenCalled();
    expect(emailCodes.begin).not.toHaveBeenCalled();
  });

  it('blocks passkey removal until an alternate email recovery flow is live', async () => {
    const fixture = createFixture();
    const { cookie, body } = await signIn(fixture);
    const response = await fixture.api(
      mutation(
        '/api/identity/passkeys',
        { credentialId: 'credential' },
        {
          Cookie: cookie,
          'X-Pegma-CSRF': body.csrfToken,
        },
        'DELETE',
      ),
    );

    expect(response.status).toBe(409);
    expect(fixture.identityPort.removePasskey).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ error: 'recovery_required' });
  });

  it('establishes the same session boundary from an injected email-code flow', async () => {
    const emailCodes: EmailCodeIdentityPort = {
      begin: vi.fn(async () => ({ challengeHandle: 'email-handle' })),
      finish: vi.fn(async () => claims),
    };
    const fixture = createFixture(emailCodes);
    const response = await fixture.api(
      mutation('/api/identity/email-code/verify', {
        challengeHandle: 'email-handle',
        code: '123456',
      }),
    );

    expect(response.status).toBe(200);
    expect(cookieToken(cookieFrom(response))).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(emailCodes.finish).toHaveBeenCalledTimes(1);
  });

  it('bounds JSON request bodies before parsing', async () => {
    const fixture = createFixture();
    const response = await fixture.api(
      new Request(
        `${IDENTITY_ISSUER}/api/identity/passkeys/authentication/options`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: IDENTITY_ISSUER,
            'Sec-Fetch-Site': 'same-origin',
            'Content-Length': '65537',
          },
          body: '{}',
        },
      ),
    );

    expect(response.status).toBe(413);
    expect(
      fixture.identityPort.beginPasskeyAuthentication,
    ).not.toHaveBeenCalled();
  });
});
