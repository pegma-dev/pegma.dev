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
  IdentityUser,
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
  createFailure: Error | null = null;
  destroyFailure: Error | null = null;

  async create(sessionId: string, session: NewSession): Promise<SessionRecord> {
    if (this.createFailure !== null) {
      throw this.createFailure;
    }
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
    if (this.destroyFailure !== null) {
      throw this.destroyFailure;
    }
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
    beginPasskeyRegistration: vi.fn(
      async () =>
        ({
          challengeHandle: 'registration-handle',
          options: { challenge: 'registration-challenge' },
        }) as Awaited<ReturnType<IdentityPort['beginPasskeyRegistration']>>,
    ),
    finishPasskeyRegistration: vi.fn(async () => ({
      credentialId: 'credential',
      label: 'Laptop',
      transports: ['internal'] as const,
      createdAt: '2026-07-28T00:00:00.000Z',
      lastUsedAt: null,
    })),
    beginPasskeyAuthentication: vi.fn(
      async () =>
        ({
          challengeHandle: 'authentication-handle',
          options: { challenge: 'authentication-challenge' },
        }) as Awaited<ReturnType<IdentityPort['beginPasskeyAuthentication']>>,
    ),
    finishPasskeyAuthentication: vi.fn(async () => claims),
    listPasskeys: vi.fn(async () => []),
    removePasskey: vi.fn(async () => true),
    ...overrides,
  };
}

const logger: Logger = { log: vi.fn() };

function createEmailCodes(
  overrides: Partial<EmailCodeIdentityPort> = {},
): EmailCodeIdentityPort {
  return {
    beginAccountCreation: vi.fn(async () => ({
      codeHandle: 'email-handle',
      expiresAt: '2026-07-28T00:05:00.000Z',
    })),
    finishAccountCreation: vi.fn(async () => claims),
    beginEmailSignIn: vi.fn(async () => ({
      codeHandle: 'email-handle',
      expiresAt: '2026-07-28T00:05:00.000Z',
    })),
    finishEmailSignIn: vi.fn(async () => claims),
    ...overrides,
  };
}

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

function createFixture(
  codes?: EmailCodeIdentityPort,
  emailCodeReady = codes !== undefined,
) {
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
      emailCodes: codes,
      emailCodeReady,
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

  it('preserves a bounded retry delay from Identity rate limits', async () => {
    const fixture = createFixture();
    vi.mocked(
      fixture.identityPort.beginPasskeyAuthentication,
    ).mockRejectedValueOnce({
      code: 'rate_limited',
      retryAfter: 1_001,
    });

    const response = await fixture.api(
      mutation('/api/identity/passkeys/authentication/options', {}),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('2');
    expect(await response.json()).toEqual({ error: 'rate_limited' });
  });

  it('does not reflect malformed rate-limit delays', async () => {
    const fixture = createFixture();
    vi.mocked(
      fixture.identityPort.beginPasskeyAuthentication,
    ).mockRejectedValueOnce({
      code: 'rate_limited',
      retryAfter: Number.POSITIVE_INFINITY,
    });

    const response = await fixture.api(
      mutation('/api/identity/passkeys/authentication/options', {}),
    );

    expect(response.status).toBe(429);
    expect(response.headers.has('Retry-After')).toBe(false);
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

  it('keeps a valid session when the authorization adapter is temporarily absent', async () => {
    const fixture = createFixture();
    const { cookie } = await signIn(fixture);
    const token = cookieToken(cookie);
    const partialApi = createIdentityApi({
      sessions: fixture.sessions,
      identity: fixture.identityPort,
      logger,
    });

    const response = await partialApi(
      new Request(`${IDENTITY_ISSUER}/api/identity/account`, {
        headers: { Cookie: cookie },
      }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(fixture.sessions.records.has(token)).toBe(true);
    expect(fixture.sessions.destroyed).not.toContain(token);
  });

  it('keeps the old session and cookie when replacement creation fails', async () => {
    const fixture = createFixture();
    const first = await signIn(fixture);
    const oldToken = cookieToken(first.cookie);
    fixture.sessions.createFailure = new Error('temporary create failure');

    const response = await fixture.api(
      mutation(
        '/api/identity/passkeys/authentication/verify',
        {
          challengeHandle: 'second-handle',
          response: { id: 'second-credential' },
        },
        { Cookie: first.cookie },
      ),
    );

    expect(response.status).toBe(500);
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(fixture.sessions.records.has(oldToken)).toBe(true);
    expect(fixture.sessions.destroyed).not.toContain(oldToken);
  });

  it.each([
    ['missing', null],
    [
      'pending',
      {
        principalId,
        email: 'person@example.test',
        emailVerified: false,
        status: 'pending',
        createdAt: '2026-07-28T00:00:00.000Z',
        updatedAt: '2026-07-28T00:00:00.000Z',
      } satisfies IdentityUser,
    ],
    [
      'unverified',
      {
        principalId,
        email: 'person@example.test',
        emailVerified: false,
        status: 'active',
        createdAt: '2026-07-28T00:00:00.000Z',
        updatedAt: '2026-07-28T00:00:00.000Z',
      } satisfies IdentityUser,
    ],
  ])(
    'revokes and clears a session for a definitively %s account',
    async (_label, user) => {
      const fixture = createFixture();
      const { cookie } = await signIn(fixture);
      const token = cookieToken(cookie);
      vi.mocked(fixture.identityPort.getUser).mockResolvedValueOnce(user);

      const response = await fixture.api(
        new Request(`${IDENTITY_ISSUER}/api/identity/account`, {
          headers: { Cookie: cookie },
        }),
      );

      expect(response.status).toBe(401);
      expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
      expect(fixture.sessions.destroyed).toContain(token);
      expect(fixture.sessions.records.has(token)).toBe(false);
    },
  );

  it('rejects authenticated mutation when the backing account disappeared', async () => {
    const fixture = createFixture();
    const { cookie, body } = await signIn(fixture);
    vi.mocked(fixture.identityPort.getUser).mockResolvedValueOnce(null);

    const response = await fixture.api(
      mutation(
        '/api/identity/passkeys/registration/options',
        {},
        {
          Cookie: cookie,
          'X-Pegma-CSRF': body.csrfToken,
        },
      ),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(
      fixture.identityPort.beginPasskeyRegistration,
    ).not.toHaveBeenCalled();
  });

  it('preserves a copied credential for retry when authoritative invalidation fails', async () => {
    const fixture = createFixture();
    const { cookie } = await signIn(fixture);
    const token = cookieToken(cookie);
    vi.mocked(fixture.identityPort.getUser).mockResolvedValue(null);
    fixture.sessions.destroyFailure = new Error('temporary destroy failure');

    const first = await fixture.api(
      new Request(`${IDENTITY_ISSUER}/api/identity/account`, {
        headers: { Cookie: cookie },
      }),
    );

    expect(first.status).toBe(500);
    expect(first.headers.get('Set-Cookie')).toBeNull();
    expect(fixture.sessions.records.has(token)).toBe(true);

    fixture.sessions.destroyFailure = null;
    const retryWithCopiedToken = await fixture.api(
      new Request(`${IDENTITY_ISSUER}/api/identity/account`, {
        headers: { Cookie: cookie },
      }),
    );

    expect(retryWithCopiedToken.status).toBe(401);
    expect(retryWithCopiedToken.headers.get('Set-Cookie')).toContain(
      'Max-Age=0',
    );
    expect(fixture.sessions.records.has(token)).toBe(false);
    expect(fixture.sessions.destroyed).toContain(token);
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

  it('fails closed when Identity and email delivery are not composed', async () => {
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
      mutation('/api/identity/email-code/sign-in/options', {
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
    const emailCodes = createEmailCodes();
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
      mutation('/api/identity/email-code/sign-in/options', {
        email: 'person@example.test',
      }),
    );

    expect(passkey.status).toBe(503);
    expect(email.status).toBe(503);
    expect(identityPort.beginPasskeyAuthentication).not.toHaveBeenCalled();
    expect(emailCodes.beginEmailSignIn).not.toHaveBeenCalled();
  });

  it('does not advertise recovery or allow removal without durable delivery', async () => {
    const emailCodes = createEmailCodes();
    const fixture = createFixture(emailCodes, false);
    const { cookie, body } = await signIn(fixture);
    const capabilities = await fixture.api(
      new Request(`${IDENTITY_ISSUER}/api/identity/capabilities`),
    );
    const start = await fixture.api(
      mutation('/api/identity/email-code/sign-in/options', {
        email: 'person@example.test',
      }),
    );
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

    expect((await capabilities.json<{ emailCode: boolean }>()).emailCode).toBe(
      false,
    );
    expect(start.status).toBe(503);
    expect(emailCodes.beginEmailSignIn).not.toHaveBeenCalled();
    expect(response.status).toBe(409);
    expect(fixture.identityPort.removePasskey).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({ error: 'recovery_required' });
  });

  it('accepts an already-delivered code while durable Mail is unready', async () => {
    const emailCodes = createEmailCodes();
    const fixture = createFixture(emailCodes, false);
    const response = await fixture.api(
      mutation('/api/identity/email-code/sign-in/verify', {
        codeHandle: 'email-handle',
        code: '12345678',
      }),
    );

    expect(response.status).toBe(200);
    expect(cookieToken(cookieFrom(response))).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(emailCodes.finishEmailSignIn).toHaveBeenCalledTimes(1);
  });

  it('advertises email recovery only when durable Mail is ready', async () => {
    const emailCodes = createEmailCodes();
    const fixture = createFixture(emailCodes, true);

    const capabilities = await fixture.api(
      new Request(`${IDENTITY_ISSUER}/api/identity/capabilities`),
    );
    const started = await fixture.api(
      mutation('/api/identity/email-code/sign-in/options', {
        email: 'person@example.test',
      }),
    );

    expect((await capabilities.json<{ emailCode: boolean }>()).emailCode).toBe(
      true,
    );
    expect(started.status).toBe(200);
    expect(await started.json()).toEqual({
      codeHandle: 'email-handle',
      expiresAt: '2026-07-28T00:05:00.000Z',
      delivery: 'email',
    });
    expect(emailCodes.beginEmailSignIn).toHaveBeenCalledTimes(1);
  });

  it('keeps account creation distinct from enumeration-safe email sign-in', async () => {
    const emailCodes = createEmailCodes();
    const fixture = createFixture(emailCodes, true);

    const started = await fixture.api(
      mutation('/api/identity/email-code/account/options', {
        email: 'new@example.test',
      }),
    );
    const completed = await fixture.api(
      mutation('/api/identity/email-code/account/verify', {
        codeHandle: 'email-handle',
        code: '12345678',
      }),
    );

    expect(started.status).toBe(200);
    expect(emailCodes.beginAccountCreation).toHaveBeenCalledWith(
      'new@example.test',
      expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    );
    expect(emailCodes.beginEmailSignIn).not.toHaveBeenCalled();
    expect(emailCodes.finishAccountCreation).toHaveBeenCalledWith({
      codeHandle: 'email-handle',
      code: '12345678',
      rateLimitKey: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    });
    expect(completed.status).toBe(200);
    expect(cookieToken(cookieFrom(completed))).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  });

  it('maps durable email-code begin failures without claiming success', async () => {
    const emailCodes = createEmailCodes({
      beginEmailSignIn: vi.fn(async () => {
        throw new Error('outbox unavailable');
      }),
    });
    const fixture = createFixture(emailCodes, true);

    const response = await fixture.api(
      mutation('/api/identity/email-code/sign-in/options', {
        email: 'person@example.test',
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal_error' });
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
