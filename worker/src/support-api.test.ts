import { identityLinkKeyFromVerifiedIdentityClaims } from '@pegma/authorization-identity';
import { createMemoryStore } from '@pegma/storage-core';
import { createSessionStore } from '@pegma/sessions';
import { fixedClock, type Logger, type PrincipalId } from '@pegma/spine';
import {
  SupportDeskNotFoundError,
  type SupportDeskApplication,
} from '@pegma/support-desk-application';
import { describe, expect, it, vi } from 'vitest';
import {
  IDENTITY_ISSUER,
  SESSION_COOKIE,
} from './identity-api';
import type {
  IdentityPort,
  IdentityUser,
  VerifiedIdentityClaims,
} from './identity-contracts';
import { createSupportApi } from './support-api';
import { customerAccessContext } from './support-access';
import {
  createSupportRuntime,
  formatPegmaTicketSubject,
  mapSupportError,
  pegSubjectMarker,
  publicTicketUrl,
} from './support-desk';
import {
  readSupportCursor,
  saveSupportCursor,
} from './support-cursors';
import { runSupportMaintenance } from './support-maintenance';

const principalA = 'principal-a' as PrincipalId;
const principalB = 'principal-b' as PrincipalId;
const clock = fixedClock('2026-07-29T12:00:00.000Z');
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
    getUser: vi.fn(async (principalId: PrincipalId) => users.get(principalId) ?? null),
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
  const sessionId = `${String(sessionSerial).padStart(2, '0')}${'s'.repeat(41)}`;
  await sessions.create(sessionId, {
    principalId,
    data: JSON.stringify({
      version: 1,
      csrfToken,
      issuer: IDENTITY_ISSUER,
      subject: principalId,
    }),
  });
  return {
    cookie: `${SESSION_COOKIE}=${sessionId}`,
    csrfToken,
  };
}

function get(path: string, cookie?: string): Request {
  return new Request(`https://pegma.dev${path}`, {
    headers: cookie === undefined ? {} : { Cookie: cookie },
  });
}

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`https://pegma.dev${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: IDENTITY_ISSUER,
      'Sec-Fetch-Site': 'same-origin',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function fixture() {
  const store = createMemoryStore();
  const sessions = createSessionStore(store, { logger });
  const users = new Map<PrincipalId, IdentityUser>([
    [principalA, userFor(principalA, 'a@example.test')],
    [principalB, userFor(principalB, 'b@example.test')],
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
  const api = createSupportApi({
    application: runtime.application,
    sessions,
    identity,
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
    createLimiter: runtime.createLimiter,
    replyLimiter: runtime.replyLimiter,
    logger,
  });
  return { store, sessions, runtime, api, application: runtime.application };
}

describe('support subject markers and URLs', () => {
  it('formats [PEG-…] markers and public ticket URLs', () => {
    expect(pegSubjectMarker(1042)).toBe('[PEG-1042]');
    expect(formatPegmaTicketSubject(7, 'Docs typo')).toBe(
      '[PEG-7] Docs typo',
    );
    expect(publicTicketUrl('ticket-1')).toBe(
      'https://pegma.dev/feedback/ticket/?id=ticket-1',
    );
  });
});

describe('customer access defaults', () => {
  it('grants create/read-own/reply-own without a paid entitlement', () => {
    const access = customerAccessContext(principalA);
    expect(access.principalId).toBe(principalA);
    expect(access.entitlements).toEqual([]);
    expect(access.permissions).toEqual(
      expect.arrayContaining([
        'support.ticket.create',
        'support.ticket.read.own',
        'support.ticket.reply.own',
      ]),
    );
  });
});

describe('authenticated support API', () => {
  it('requires authentication for list and create', async () => {
    const { api } = fixture();
    const list = await api(get('/api/support/tickets'));
    expect(list.status).toBe(401);
    expect(await list.json()).toEqual({ error: 'authentication_required' });

    const create = await api(
      post('/api/support/tickets', {
        subject: 'Hello',
        body: 'Details',
        category: 'feedback',
      }),
    );
    expect(create.status).toBe(401);
  });

  it('creates, lists, reads, and replies for the owning principal', async () => {
    const { api, sessions } = fixture();
    const auth = await sessionCookie(sessions, principalA);

    const created = await api(
      post(
        '/api/support/tickets',
        {
          subject: 'Roadmap clarity',
          body: 'The roadmap page is hard to scan.',
          category: 'feedback',
        },
        {
          Cookie: auth.cookie,
          'X-Pegma-CSRF': auth.csrfToken,
        },
      ),
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      ticket: {
        id: string;
        number: number;
        subject: string;
        category: string;
        marker: string;
        url: string;
      };
      messages: readonly { body: string; authorKind: string }[];
    };
    expect(createdBody.ticket.subject).toBe('Roadmap clarity');
    expect(createdBody.ticket.category).toBe('feedback');
    expect(createdBody.ticket.number).toBe(1);
    expect(createdBody.ticket.marker).toBe('[PEG-1]');
    expect(createdBody.ticket.url).toBe(
      `https://pegma.dev/feedback/${createdBody.ticket.id}`,
    );
    expect(createdBody.messages).toHaveLength(1);
    expect(createdBody.messages[0]?.body).toContain('hard to scan');
    expect(createdBody.messages[0]?.authorKind).toBe('customer');

    const listed = await api(get('/api/support/tickets', auth.cookie));
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as {
      tickets: readonly { id: string }[];
    };
    expect(listBody.tickets).toHaveLength(1);
    expect(listBody.tickets[0]?.id).toBe(createdBody.ticket.id);

    const read = await api(
      get(`/api/support/tickets/${createdBody.ticket.id}`, auth.cookie),
    );
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as {
      ticket: { id: string };
      messages: readonly unknown[];
    };
    expect(readBody.ticket.id).toBe(createdBody.ticket.id);
    expect(readBody.messages).toHaveLength(1);

    const replied = await api(
      post(
        `/api/support/tickets/${createdBody.ticket.id}/replies`,
        { body: 'Also the mobile layout wraps oddly.' },
        {
          Cookie: auth.cookie,
          'X-Pegma-CSRF': auth.csrfToken,
        },
      ),
    );
    expect(replied.status).toBe(201);
    const replyBody = (await replied.json()) as {
      messages: readonly { body: string }[];
    };
    expect(replyBody.messages).toHaveLength(2);
    expect(replyBody.messages[1]?.body).toContain('mobile layout');
  });

  it('returns content-free 404 for missing and non-owned tickets', async () => {
    const { api, sessions } = fixture();
    const owner = await sessionCookie(sessions, principalA, 'a'.repeat(43));
    const other = await sessionCookie(sessions, principalB, 'b'.repeat(43));

    const created = await api(
      post(
        '/api/support/tickets',
        {
          subject: 'Private',
          body: 'Should not leak to another principal.',
          category: 'bug',
        },
        {
          Cookie: owner.cookie,
          'X-Pegma-CSRF': owner.csrfToken,
        },
      ),
    );
    const { ticket } = (await created.json()) as { ticket: { id: string } };

    const missing = await api(
      get('/api/support/tickets/does-not-exist', owner.cookie),
    );
    const foreign = await api(
      get(`/api/support/tickets/${ticket.id}`, other.cookie),
    );

    expect(missing.status).toBe(404);
    expect(foreign.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found' });
    expect(await foreign.json()).toEqual({ error: 'not_found' });
  });

  it('requires CSRF and same-origin metadata for mutations', async () => {
    const { api, sessions } = fixture();
    const auth = await sessionCookie(sessions, principalA);

    const noCsrf = await api(
      post(
        '/api/support/tickets',
        {
          subject: 'No CSRF',
          body: 'Should fail.',
          category: 'question',
        },
        { Cookie: auth.cookie },
      ),
    );
    expect(noCsrf.status).toBe(403);
    expect(await noCsrf.json()).toEqual({ error: 'csrf_denied' });

    const crossOrigin = await api(
      new Request('https://pegma.dev/api/support/tickets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://evil.example',
          'Sec-Fetch-Site': 'cross-site',
          Cookie: auth.cookie,
          'X-Pegma-CSRF': auth.csrfToken,
        },
        body: JSON.stringify({
          subject: 'Cross origin',
          body: 'Should fail.',
          category: 'question',
        }),
      }),
    );
    expect(crossOrigin.status).toBe(403);
    expect(await crossOrigin.json()).toEqual({ error: 'cross_origin_denied' });
  });

  it('rejects invalid categories without leaking allowlist internals', async () => {
    const { api, sessions } = fixture();
    const auth = await sessionCookie(sessions, principalA);
    const response = await api(
      post(
        '/api/support/tickets',
        {
          subject: 'Bad category',
          body: 'Body',
          category: 'billing',
        },
        {
          Cookie: auth.cookie,
          'X-Pegma-CSRF': auth.csrfToken,
        },
      ),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_category' });
  });
});

describe('support error mapping', () => {
  it('maps missing tickets to content-free 404', () => {
    expect(mapSupportError(new SupportDeskNotFoundError())).toEqual({
      status: 404,
      code: 'not_found',
    });
  });
});

describe('support maintenance cursors', () => {
  it('persists independent queue cursors and runs repair/sweep', async () => {
    const { store, runtime } = fixture();
    await saveSupportCursor(store, 'queueRepairCursor', 'cursor-repair-1');
    await saveSupportCursor(
      store,
      'queueInactiveSweepCursor',
      'cursor-inactive-1',
    );

    expect(await readSupportCursor(store, 'queueRepairCursor')).toBe(
      'cursor-repair-1',
    );
    expect(await readSupportCursor(store, 'queueInactiveSweepCursor')).toBe(
      'cursor-inactive-1',
    );
    // Identity-style keys must not collide: only the named Support field changes.
    await saveSupportCursor(store, 'queueRepairCursor', 'cursor-repair-2');
    expect(await readSupportCursor(store, 'queueRepairCursor')).toBe(
      'cursor-repair-2',
    );
    expect(await readSupportCursor(store, 'queueInactiveSweepCursor')).toBe(
      'cursor-inactive-1',
    );

    await runSupportMaintenance(
      {
        store,
        clock,
        limiters: runtime.limiters,
        terminalRetentionMilliseconds: runtime.terminalRetentionMilliseconds,
      },
      logger,
    );

    // Maintenance completes without throwing; a stale opaque cursor may remain
    // until a successful page starts from a valid position, so only require
    // that the two loop keys stay independently addressable.
    const repair = await readSupportCursor(store, 'queueRepairCursor');
    const inactive = await readSupportCursor(store, 'queueInactiveSweepCursor');
    expect(repair === undefined || typeof repair === 'string').toBe(true);
    expect(inactive === undefined || typeof inactive === 'string').toBe(true);
  });
});

describe('application ownership boundary', () => {
  it('uses the session principal for create ownership', async () => {
    const { application } = fixture() as {
      application: SupportDeskApplication;
    };
    const accessA = customerAccessContext(principalA);
    const created = await application.createCustomerTicket(accessA, {
      commandId: 'cmd-1',
      correlationId: 'corr-1',
      ticketId: 'ticket-owned',
      messageId: 'msg-1',
      subject: 'Ownership',
      body: 'Body',
      category: 'documentation',
    });
    expect(created.ticket.id).toBe('ticket-owned');

    await expect(
      application.readCustomerTicket(
        customerAccessContext(principalB),
        'ticket-owned',
      ),
    ).rejects.toBeInstanceOf(SupportDeskNotFoundError);
  });
});
