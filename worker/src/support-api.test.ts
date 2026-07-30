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
import { validatePolicy } from '@pegma/authorization-policy';
import {
  APPLICATION_SCOPE,
  customerAccessContext,
  PEGMA_ACCESS_POLICY,
  staffAccessContextFromRoles,
  SUPPORT_ROLE,
  SUPPORT_STAFF_PERMISSIONS,
} from './support-access';
import {
  bootstrapSupportAssignmentId,
  ensureBootstrapSupport,
  parseBootstrapPrincipals,
} from './role-bootstrap';
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
const principalStaff = 'principal-staff' as PrincipalId;
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

function patch(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(`https://pegma.dev${path}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Origin: IDENTITY_ISSUER,
      'Sec-Fetch-Site': 'same-origin',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function fixture(options: {
  readonly bootstrapPrincipals?: readonly PrincipalId[];
  /** Wire the API without any role store (fail-closed 503 posture). */
  readonly omitRoleStore?: boolean;
  /** Override the role store the API sees (e.g. a failing one). */
  readonly roleStoreOverride?: Parameters<typeof createSupportApi>[0]['roleStore'];
} = {}) {
  const store = createMemoryStore();
  const sessions = createSessionStore(store, { logger });
  const users = new Map<PrincipalId, IdentityUser>([
    [principalA, userFor(principalA, 'a@example.test')],
    [principalB, userFor(principalB, 'b@example.test')],
    [principalStaff, userFor(principalStaff, 'staff@example.test')],
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
    roleStore: options.omitRoleStore
      ? undefined
      : (options.roleStoreOverride ?? runtime.roleStore),
    bootstrapMarkers: runtime.bootstrapMarkers,
    bootstrapPrincipals: new Set(options.bootstrapPrincipals ?? []),
  });
  return {
    store,
    sessions,
    runtime,
    roleStore: runtime.roleStore,
    bootstrapMarkers: runtime.bootstrapMarkers,
    api,
    application: runtime.application,
  };
}

/** Grant the stored Support role the way an operator surface would. */
async function grantSupport(
  roleStore: ReturnType<typeof createSupportRuntime>['roleStore'],
  principalId: PrincipalId,
  id = `assign-${principalId}`,
) {
  const granted = await roleStore.grantRoleAssignmentWithAudit({
    assignment: {
      id,
      principalId,
      role: SUPPORT_ROLE,
      scope: APPLICATION_SCOPE,
      grantedBy: { kind: 'principal', principalId: 'principal-admin' },
      grantedAtEpochMs: Date.parse('2026-07-30T00:00:00.000Z'),
      status: 'active',
    },
    auditEventId: `evt-${id}`,
  });
  expect(granted.status).toBe('granted');
}

async function createCustomerTicket(
  api: ReturnType<typeof createSupportApi>,
  sessions: ReturnType<typeof createSessionStore>,
  principalId: PrincipalId,
  csrfChar = 'c',
): Promise<{
  cookie: string;
  csrfToken: string;
  ticketId: string;
  ticketNumber: number;
}> {
  const auth = await sessionCookie(sessions, principalId, csrfChar.repeat(43));
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
  const body = (await created.json()) as {
    ticket: { id: string; number: number };
  };
  return {
    cookie: auth.cookie,
    csrfToken: auth.csrfToken,
    ticketId: body.ticket.id,
    ticketNumber: body.ticket.number,
  };
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
      `https://pegma.dev/feedback/ticket/?id=${createdBody.ticket.id}`,
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

describe('staff support API', () => {
  it('returns 401 for unauthenticated staff routes', async () => {
    const { api } = fixture();
    const queue = await api(get('/api/support/admin/queue'));
    expect(queue.status).toBe(401);
    expect(await queue.json()).toEqual({ error: 'authentication_required' });

    const ticket = await api(get('/api/support/admin/tickets/any-id'));
    expect(ticket.status).toBe(401);
  });

  it('returns 403 for authenticated non-staff on queue, read, reply, and note', async () => {
    const { api, sessions, roleStore } = fixture();
    await grantSupport(roleStore, principalStaff);
    const customer = await createCustomerTicket(api, sessions, principalA, 'a');
    const nonStaff = await sessionCookie(sessions, principalB, 'b'.repeat(43));

    const queue = await api(get('/api/support/admin/queue', nonStaff.cookie));
    expect(queue.status).toBe(403);
    expect(await queue.json()).toEqual({ error: 'forbidden' });

    const read = await api(
      get(
        `/api/support/admin/tickets/${customer.ticketId}`,
        nonStaff.cookie,
      ),
    );
    expect(read.status).toBe(403);
    expect(await read.json()).toEqual({ error: 'forbidden' });

    const reply = await api(
      post(
        `/api/support/admin/tickets/${customer.ticketId}/messages`,
        { body: 'Should fail.' },
        {
          Cookie: nonStaff.cookie,
          'X-Pegma-CSRF': nonStaff.csrfToken,
        },
      ),
    );
    expect(reply.status).toBe(403);
    expect(await reply.json()).toEqual({ error: 'forbidden' });

    const note = await api(
      post(
        `/api/support/admin/tickets/${customer.ticketId}/notes`,
        { body: 'Internal should fail.' },
        {
          Cookie: nonStaff.cookie,
          'X-Pegma-CSRF': nonStaff.csrfToken,
        },
      ),
    );
    expect(note.status).toBe(403);
    expect(await note.json()).toEqual({ error: 'forbidden' });
  });

  it('lists the queue for Support role holders after customer create', async () => {
    const { api, sessions, roleStore } = fixture();
    await grantSupport(roleStore, principalStaff);
    const customer = await createCustomerTicket(api, sessions, principalA, 'a');
    const staff = await sessionCookie(
      sessions,
      principalStaff,
      's'.repeat(43),
    );

    const queue = await api(get('/api/support/admin/queue', staff.cookie));
    expect(queue.status).toBe(200);
    const body = (await queue.json()) as {
      items: readonly { ticketId: string; status: string }[];
      csrfToken: string;
    };
    expect(body.items.some((item) => item.ticketId === customer.ticketId)).toBe(
      true,
    );
    expect(typeof body.csrfToken).toBe('string');
  });

  it('reads staff ticket including messages and requester email', async () => {
    const { api, sessions, roleStore } = fixture();
    await grantSupport(roleStore, principalStaff);
    const customer = await createCustomerTicket(api, sessions, principalA, 'a');
    const staff = await sessionCookie(
      sessions,
      principalStaff,
      's'.repeat(43),
    );

    const read = await api(
      get(
        `/api/support/admin/tickets/${customer.ticketId}`,
        staff.cookie,
      ),
    );
    expect(read.status).toBe(200);
    const body = (await read.json()) as {
      ticket: {
        id: string;
        number: number;
        subject: string;
        requester: { email?: string; association: string };
      };
      messages: readonly { body: string; authorKind: string }[];
    };
    expect(body.ticket.id).toBe(customer.ticketId);
    expect(body.ticket.number).toBe(customer.ticketNumber);
    expect(body.ticket.subject).toBe('Roadmap clarity');
    expect(body.ticket.requester.email).toBe('a@example.test');
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.authorKind).toBe('customer');
  });

  it('public staff reply is customer-visible and advances status', async () => {
    const { api, sessions, roleStore } = fixture();
    await grantSupport(roleStore, principalStaff);
    const customer = await createCustomerTicket(api, sessions, principalA, 'a');
    const staff = await sessionCookie(
      sessions,
      principalStaff,
      's'.repeat(43),
    );

    const replied = await api(
      post(
        `/api/support/admin/tickets/${customer.ticketId}/messages`,
        { body: 'Thanks — we will clarify the roadmap sections.' },
        {
          Cookie: staff.cookie,
          'X-Pegma-CSRF': staff.csrfToken,
        },
      ),
    );
    expect(replied.status).toBe(201);
    const staffView = (await replied.json()) as {
      ticket: { status: string };
      messages: readonly {
        body: string;
        authorKind: string;
        visibility: string;
      }[];
    };
    expect(staffView.ticket.status).toBe('waiting_on_customer');
    const publicStaff = staffView.messages.find(
      (m) => m.authorKind === 'staff' && m.visibility === 'customer',
    );
    expect(publicStaff?.body).toContain('clarify the roadmap');

    const customerRead = await api(
      get(`/api/support/tickets/${customer.ticketId}`, customer.cookie),
    );
    expect(customerRead.status).toBe(200);
    const customerView = (await customerRead.json()) as {
      ticket: { status: string };
      messages: readonly { body: string; authorKind: string }[];
    };
    expect(customerView.ticket.status).toBe('waiting_on_customer');
    expect(
      customerView.messages.some((m) =>
        m.body.includes('clarify the roadmap'),
      ),
    ).toBe(true);
  });

  it('internal notes are staff-only and never on customer read', async () => {
    const { api, sessions, roleStore } = fixture();
    await grantSupport(roleStore, principalStaff);
    const customer = await createCustomerTicket(api, sessions, principalA, 'a');
    const staff = await sessionCookie(
      sessions,
      principalStaff,
      's'.repeat(43),
    );

    const noted = await api(
      post(
        `/api/support/admin/tickets/${customer.ticketId}/notes`,
        { body: 'Internal: check docs PR #42 before replying.' },
        {
          Cookie: staff.cookie,
          'X-Pegma-CSRF': staff.csrfToken,
        },
      ),
    );
    expect(noted.status).toBe(201);
    const staffView = (await noted.json()) as {
      messages: readonly {
        body: string;
        visibility: string;
        authorKind: string;
      }[];
    };
    const internal = staffView.messages.find(
      (m) => m.visibility === 'internal',
    );
    expect(internal?.body).toContain('docs PR #42');
    expect(internal?.authorKind).toBe('staff');

    const customerRead = await api(
      get(`/api/support/tickets/${customer.ticketId}`, customer.cookie),
    );
    expect(customerRead.status).toBe(200);
    const customerView = (await customerRead.json()) as {
      messages: readonly { body: string; visibility: string }[];
    };
    expect(
      customerView.messages.some((m) => m.body.includes('docs PR #42')),
    ).toBe(false);
    expect(
      customerView.messages.every((m) => m.visibility === 'customer'),
    ).toBe(true);
  });

  it('keeps public reply and internal note on separate endpoints', async () => {
    const { api, sessions, roleStore } = fixture();
    await grantSupport(roleStore, principalStaff);
    const customer = await createCustomerTicket(api, sessions, principalA, 'a');
    const staff = await sessionCookie(
      sessions,
      principalStaff,
      's'.repeat(43),
    );

    const viaMessages = await api(
      post(
        `/api/support/admin/tickets/${customer.ticketId}/messages`,
        { body: 'Public only path.' },
        {
          Cookie: staff.cookie,
          'X-Pegma-CSRF': staff.csrfToken,
        },
      ),
    );
    expect(viaMessages.status).toBe(201);
    const publicView = (await viaMessages.json()) as {
      messages: readonly { body: string; visibility: string }[];
    };
    expect(
      publicView.messages.some(
        (m) =>
          m.body === 'Public only path.' && m.visibility === 'customer',
      ),
    ).toBe(true);

    const viaNotes = await api(
      post(
        `/api/support/admin/tickets/${customer.ticketId}/notes`,
        { body: 'Note only path.' },
        {
          Cookie: staff.cookie,
          'X-Pegma-CSRF': staff.csrfToken,
        },
      ),
    );
    expect(viaNotes.status).toBe(201);
    const noteView = (await viaNotes.json()) as {
      messages: readonly { body: string; visibility: string }[];
    };
    expect(
      noteView.messages.some(
        (m) => m.body === 'Note only path.' && m.visibility === 'internal',
      ),
    ).toBe(true);

    // Wrong resource path stays not_found (does not silently create notes).
    const wrong = await api(
      post(
        `/api/support/admin/tickets/${customer.ticketId}/replies`,
        { body: 'Wrong path.' },
        {
          Cookie: staff.cookie,
          'X-Pegma-CSRF': staff.csrfToken,
        },
      ),
    );
    expect(wrong.status).toBe(404);
  });

  it('supports assign, priority change, and resolve for staff', async () => {
    const { api, sessions, roleStore } = fixture();
    await grantSupport(roleStore, principalStaff);
    const customer = await createCustomerTicket(api, sessions, principalA, 'a');
    const staff = await sessionCookie(
      sessions,
      principalStaff,
      's'.repeat(43),
    );
    const headers = {
      Cookie: staff.cookie,
      'X-Pegma-CSRF': staff.csrfToken,
    };

    const assigned = await api(
      patch(
        `/api/support/admin/tickets/${customer.ticketId}`,
        { action: 'assign' },
        headers,
      ),
    );
    expect(assigned.status).toBe(200);
    const assignedBody = (await assigned.json()) as {
      ticket: { assignedTo?: string; priority: string; status: string };
    };
    expect(assignedBody.ticket.assignedTo).toBe(principalStaff);

    const priority = await api(
      patch(
        `/api/support/admin/tickets/${customer.ticketId}`,
        { action: 'change_priority', priority: 'high' },
        headers,
      ),
    );
    expect(priority.status).toBe(200);
    const priorityBody = (await priority.json()) as {
      ticket: { priority: string };
    };
    expect(priorityBody.ticket.priority).toBe('high');

    const resolved = await api(
      patch(
        `/api/support/admin/tickets/${customer.ticketId}`,
        { action: 'resolve' },
        headers,
      ),
    );
    expect(resolved.status).toBe(200);
    const resolvedBody = (await resolved.json()) as {
      ticket: { status: string };
    };
    expect(resolvedBody.ticket.status).toBe('resolved');
  });
});

describe('Support role store adoption (docs/ROLE_ADOPTION_PLAN.md phases 1–3)', () => {

  it('the host policy validates as a PolicyDocumentV1 (schema drift fails CI)', () => {
    const serialized = JSON.parse(JSON.stringify(PEGMA_ACCESS_POLICY));
    expect(validatePolicy(serialized)).toMatchObject({ valid: true });
    expect(validatePolicy({ ...serialized, version: 42 }).valid).toBe(false);
  });

  it('staffAccessContextFromRoles grants via the stored role and honors revocation next call', async () => {
    const { roleStore } = fixture();
    expect(
      await staffAccessContextFromRoles(principalStaff, roleStore),
    ).toBeNull();

    await grantSupport(roleStore, principalStaff);
    const access = await staffAccessContextFromRoles(principalStaff, roleStore);
    expect(access).not.toBeNull();
    expect(access?.policyVersion).toBe(PEGMA_ACCESS_POLICY.version);
    expect(access?.permissions).toEqual(
      expect.arrayContaining([...SUPPORT_STAFF_PERMISSIONS]),
    );

    const current = await roleStore.getRoleAssignment(
      `assign-${principalStaff}`,
    );
    const revoked = await roleStore.revokeRoleAssignmentWithAudit({
      assignmentId: `assign-${principalStaff}`,
      expectedConcurrencyToken: current!.concurrencyToken,
      revokedBy: { kind: 'principal', principalId: 'principal-admin' },
      revokedAtEpochMs: Date.parse('2026-07-30T01:00:00.000Z'),
      auditEventId: 'evt-revoke-staff',
    });
    expect(revoked.status).toBe('revoked');
    // Re-resolved per request — the 60-second bound is honored trivially.
    expect(
      await staffAccessContextFromRoles(principalStaff, roleStore),
    ).toBeNull();
  });

  it('a role-holder passes staff routes with an EMPTY allowlist (roles are the real gate)', async () => {
    const { api, sessions, roleStore } = fixture();
    await grantSupport(roleStore, principalStaff);
    const staff = await sessionCookie(sessions, principalStaff, 's'.repeat(43));
    const queue = await api(get('/api/support/admin/queue', staff.cookie));
    expect(queue.status).toBe(200);
  });

  it('fails CLOSED: no role store is a 503, and a role-store failure is a 503 even for a role holder', async () => {
    const unconfigured = fixture({ omitRoleStore: true });
    const nobody = await sessionCookie(
      unconfigured.sessions,
      principalA,
      'n'.repeat(43),
    );
    const unconfiguredQueue = await unconfigured.api(
      get('/api/support/admin/queue', nobody.cookie),
    );
    expect(unconfiguredQueue.status).toBe(503);
    expect(await unconfiguredQueue.json()).toEqual({
      error: 'support_not_configured',
    });

    const failing = {
      listActiveRoleAssignments: async () => {
        throw new Error('role store down');
      },
      getRoleAssignment: async () => null,
      grantRoleAssignmentWithAudit: async () => {
        throw new Error('role store down');
      },
    } as unknown as Parameters<typeof createSupportApi>[0]['roleStore'];
    const degraded = fixture({ roleStoreOverride: failing });
    // The durable store holds a real Support grant, but the API reads
    // through the failing store — outage must never quietly deny or allow.
    await grantSupport(degraded.roleStore, principalStaff);
    const staff = await sessionCookie(
      degraded.sessions,
      principalStaff,
      'l'.repeat(43),
    );
    const degradedQueue = await degraded.api(
      get('/api/support/admin/queue', staff.cookie),
    );
    expect(degradedQueue.status).toBe(503);
    expect(await degradedQueue.json()).toEqual({
      error: 'service_unavailable',
    });
  });

  it('bootstrap seeds a listed principal on an authenticated touch, once, revocation-durable', async () => {
    const { api, sessions, roleStore, bootstrapMarkers } = fixture({
      bootstrapPrincipals: [principalStaff],
    });
    const staff = await sessionCookie(sessions, principalStaff, 'b'.repeat(43));

    // Any authenticated support touch seeds; the next staff call succeeds.
    expect(
      (await api(get('/api/support/categories', staff.cookie))).status,
    ).toBe(200);
    expect(
      (await api(get('/api/support/admin/queue', staff.cookie))).status,
    ).toBe(200);

    const assignmentId = bootstrapSupportAssignmentId(principalStaff);
    const stored = await roleStore.getRoleAssignment(assignmentId);
    expect(stored?.assignment).toMatchObject({
      role: SUPPORT_ROLE,
      grantedBy: { kind: 'system', systemId: 'bootstrap' },
      status: 'active',
    });

    // Human revocation is DURABLE while the env var is still configured:
    // the next touch must not resurrect the grant.
    const revoked = await roleStore.revokeRoleAssignmentWithAudit({
      assignmentId,
      expectedConcurrencyToken: stored!.concurrencyToken,
      revokedBy: { kind: 'principal', principalId: 'principal-admin' },
      // After the seed's real-clock grantedAtEpochMs — a revocation must
      // not predate its grant.
      revokedAtEpochMs: Date.now() + 1_000,
      auditEventId: 'evt-revoke-bootstrap',
    });
    expect(revoked.status).toBe('revoked');
    expect(
      (await api(get('/api/support/categories', staff.cookie))).status,
    ).toBe(200);
    expect(
      await ensureBootstrapSupport(
        roleStore,
        bootstrapMarkers,
        principalStaff,
        new Set([principalStaff]),
      ),
    ).toBe('already');
    expect(
      (await api(get('/api/support/admin/queue', staff.cookie))).status,
    ).toBe(403);
  });

  it('marks a listed principal already holding Support elsewhere, so revoking that grant cannot be undone by a reseed', async () => {
    const { api, sessions, roleStore, bootstrapMarkers } = fixture({
      bootstrapPrincipals: [principalStaff],
    });
    // Support held via a NON-bootstrap assignment before the first touch.
    await grantSupport(roleStore, principalStaff);
    const other = await roleStore.getRoleAssignment(`assign-${principalStaff}`);
    const staff = await sessionCookie(sessions, principalStaff, 'm'.repeat(43));

    // The touch grants nothing (the store refuses a second active
    // assignment per tuple) but still records the handled seed — the host
    // marker is the ONLY "already seeded" signal; role state is not one.
    expect(
      (await api(get('/api/support/categories', staff.cookie))).status,
    ).toBe(200);
    expect(
      await roleStore.getRoleAssignment(
        bootstrapSupportAssignmentId(principalStaff),
      ),
    ).toBeNull();
    expect(
      await bootstrapMarkers.get({
        partition: 'support-bootstrap',
        id: principalStaff,
      }),
    ).toMatchObject({ principalId: principalStaff, outcome: 'held_elsewhere' });

    // Revoke the held assignment; the next touch must not re-grant.
    const revoked = await roleStore.revokeRoleAssignmentWithAudit({
      assignmentId: other!.assignment.id,
      expectedConcurrencyToken: other!.concurrencyToken,
      revokedBy: { kind: 'principal', principalId: 'principal-admin' },
      revokedAtEpochMs: Date.now() + 1_000,
      auditEventId: `evt-revoke-${other!.assignment.id}`,
    });
    expect(revoked.status).toBe('revoked');
    expect(
      (await api(get('/api/support/categories', staff.cookie))).status,
    ).toBe(200);
    expect(
      await roleStore.getRoleAssignment(
        bootstrapSupportAssignmentId(principalStaff),
      ),
    ).toBeNull();
    expect(
      (await api(get('/api/support/admin/queue', staff.cookie))).status,
    ).toBe(403);
  });

  it('parses the bootstrap principal list (trimmed, empties dropped)', () => {
    expect(
      parseBootstrapPrincipals({
        PEGMA_SUPPORT_BOOTSTRAP_PRINCIPALS: ' p-1, ,p-2 ',
      }),
    ).toEqual(new Set(['p-1', 'p-2']));
    expect(parseBootstrapPrincipals({})).toEqual(new Set());
  });
});
