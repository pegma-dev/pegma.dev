import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAccess } from '@pegma/authorization-core';
import { createMemoryStore } from '@pegma/storage-core';
import {
  createSupportDeskApplication,
  SupportDeskNotFoundError,
  supportPermissions,
} from '@pegma/support-desk-application';
import {
  browserGate,
  disposeSupportBrowsers,
  supportBrowser,
  type BrowserCall,
  type BrowserResponse,
} from './test-support-browser';

afterEach(disposeSupportBrowsers);

const kinds = ['create', 'customer-reply', 'staff-reply', 'note', 'patch'] as const;
type Kind = (typeof kinds)[number];
const ticketId = 'ticket-example';
const originalBody = 'A fictional original intent.';
const nextDraft = 'A separate fictional draft, not the pending intent.';

function surface(kind: Kind) {
  return kind === 'create'
    ? 'create'
    : kind === 'customer-reply'
      ? 'customer'
      : 'staff';
}
function controls(kind: Kind) {
  return {
    detail:
      kind === 'create'
        ? 'feedback-signed-in'
        : kind === 'customer-reply'
          ? 'ticket-detail'
          : 'staff-ticket-detail',
    status:
      kind === 'create'
        ? 'feedback-status'
        : kind === 'customer-reply'
          ? 'ticket-status'
          : 'staff-ticket-status',
    signedOut:
      kind === 'create'
        ? 'feedback-signed-out'
        : kind === 'customer-reply'
          ? 'ticket-signed-out'
          : 'staff-ticket-signed-out',
    draft:
      kind === 'create'
        ? 'ticket-body'
        : kind === 'customer-reply'
          ? 'reply-body'
          : 'compose-body',
    form:
      kind === 'create'
        ? 'create-ticket'
        : kind === 'customer-reply'
          ? 'reply-form'
          : 'staff-compose-form',
  };
}
type Page = ReturnType<typeof supportBrowser>;
async function until(page: Page, predicate: () => boolean) {
  // Real SDK hashing completes on the native event loop, not only microtasks.
  // Keep this bounded native wait local; the existing 77-case harness is intact.
  const deadline = performance.now() + 1000;
  for (let turn = 0; turn < 1000 && performance.now() < deadline; ++turn) {
    if (predicate()) return;
    await delay(1);
  }
  throw new Error(
    `SDK-backed browser fixture did not reach the expected event state (${page.calls.length} HTTP calls).`,
  );
}
function writes(page: Page) {
  return page.calls.filter((call) => call.method !== 'GET');
}
function edit(page: Page, kind: Kind, later = false) {
  page.node(controls(kind).draft).value = later ? nextDraft : originalBody;
  if (kind === 'create') {
    page.node('ticket-subject').value = later
      ? 'A different unsent subject'
      : 'Fictional original subject';
    page.node('ticket-category').value = later ? 'bug' : 'feedback';
  }
  if (kind === 'staff-reply' || kind === 'note')
    page.mode((kind === 'note') !== later ? 'internal' : 'public');
  if (kind === 'patch') page.node('priority-select').value = later ? 'low' : 'high';
}
function submit(page: Page, kind: Kind) {
  if (kind === 'patch') page.node('action-priority').fire('click');
  else page.node(controls(kind).form).fire('submit');
}
function reload(page: Page, kind: Kind) {
  if (kind === 'create') {
    // A bfcache return retains this actual page instance; no persistent storage.
    page.window.dispatchEvent(new Event('pagehide'));
    page.window.dispatchEvent(new Event('pageshow'));
  } else
    page
      .node(kind === 'customer-reply' ? 'ticket-reload' : 'staff-ticket-reload')
      .fire('click');
}
async function ready(page: Page, kind: Kind) {
  await until(page, () => !page.node(controls(kind).detail).hidden);
  if (surface(kind) === 'staff')
    await until(page, () =>
      page.node('staff-handoff-status').textContent.includes('No handoff'),
    );
  await page.tick();
}
function command(call: BrowserCall | undefined, kind: Kind) {
  expect(call?.headers.get('X-Pegma-Support-Command')).toBe('1');
  const parsed = JSON.parse(call?.body ?? '{}') as Record<string, unknown>;
  const actual = parsed.command as Record<string, unknown> | undefined;
  const expectedAccountId =
    kind === 'create' || kind === 'customer-reply'
      ? 'synthetic-customer'
      : 'synthetic-staff';
  const common = { version: 1, expectedAccountId, commandId: expect.any(String) };
  expect(actual).toEqual(
    kind === 'create'
      ? {
          ...common,
          expectedRequesterEmail: 'fictional-reader@example.test',
          ticketId: expect.any(String),
          messageId: expect.any(String),
        }
      : kind === 'patch'
        ? common
        : { ...common, messageId: expect.any(String) },
  );
  const ids = ['commandId', ...(kind === 'patch' ? [] : ['messageId'])].map(
    (name) => actual?.[name],
  );
  for (const value of ids) {
    expect(value).toMatch(/^[A-Za-z0-9._~-]{1,128}$/u);
    expect(value).toEqual(expect.stringMatching(new RegExp(`^${expectedAccountId}~`)));
  }
  if (kind === 'create')
    expect(actual?.ticketId).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u,
    );
  expect(new Set(ids).size).toBe(ids.length);
  return parsed;
}

/** The HTTP adapter invokes the released SDK on a real Memory Store. It is
 * deliberately not a copy of the host HTTP parser or an authentication proof.
 * Missing command fields model the old server's independently minted IDs, so
 * the delayed-write regression can observe duplicate real SDK effects. */
async function ledger(kind: Kind) {
  const application = createSupportDeskApplication({
    store: createMemoryStore(),
    clock: { now: () => new Date().toISOString() },
    allowedCategories: ['feedback', 'bug'],
  });
  const customer = resolveAccess(
    { principalId: 'synthetic-customer' },
    {
      version: 'synthetic-browser-customer',
      defaults: [
        supportPermissions.create,
        supportPermissions.readOwn,
        supportPermissions.replyOwn,
      ],
    },
  );
  const staff = resolveAccess(
    { principalId: 'synthetic-staff' },
    {
      version: 'synthetic-browser-staff',
      defaults: [
        supportPermissions.queueRead,
        supportPermissions.replyAny,
        supportPermissions.note,
        supportPermissions.manage,
      ],
    },
  );
  const identity = {
    account: {
      subject:
        kind === 'create' || kind === 'customer-reply'
          ? customer.principalId
          : staff.principalId,
      email: 'fictional-reader@example.test',
    },
    csrfToken: 'synthetic-current-csrf',
  };
  if (kind !== 'create')
    await application.createCustomerTicket(customer, {
      commandId: randomUUID(),
      correlationId: randomUUID(),
      ticketId,
      messageId: randomUUID(),
      subject: 'Fictional existing ticket',
      body: 'Fictional original question.',
    });
  const baseline =
    kind === 'create'
      ? 0
      : (await application.readStaffTicket(staff, ticketId)).ticket.revision;
  const observedCommands: Record<string, unknown>[] = [];
  function wire<T extends { ticket: { number: number } }>(view: T) {
    return {
      ...view,
      ticket: { ...view.ticket, marker: `[PEG-${view.ticket.number}]` },
      csrfToken: identity.csrfToken,
    };
  }
  async function read(call: BrowserCall): Promise<BrowserResponse> {
    if (call.path.startsWith('/api/identity/')) return { body: identity };
    if (call.path.endsWith('/handoff'))
      return { body: { handoff: [], csrfToken: identity.csrfToken } };
    if (call.path === '/api/support/tickets') {
      const tickets = await application.listCustomerTickets(customer);
      return {
        body: {
          tickets: tickets.map((ticket) => ({
            ...ticket,
            marker: `[PEG-${ticket.number}]`,
          })),
          csrfToken: identity.csrfToken,
        },
      };
    }
    return {
      body: wire(
        kind === 'customer-reply'
          ? await application.readCustomerTicket(customer, ticketId)
          : await application.readStaffTicket(staff, ticketId),
      ),
    };
  }
  async function commit(call: BrowserCall): Promise<BrowserResponse> {
    const parsed = JSON.parse(call.body ?? '{}') as {
      command?: {
        commandId?: string;
        ticketId?: string;
        messageId?: string;
        expectedRequesterEmail?: string | null;
      };
      body: string;
      subject: string;
      category: string;
      action: string;
      priority: 'low' | 'normal' | 'high' | 'urgent';
    };
    const coordinates = {
      commandId: parsed.command?.commandId ?? randomUUID(),
      correlationId: randomUUID(),
      ticketId: parsed.command?.ticketId ?? ticketId,
      messageId: parsed.command?.messageId ?? randomUUID(),
    };
    observedCommands.push({ ...coordinates });
    if (kind === 'create')
      return {
        status: 201,
        body: wire(
          await application.createCustomerTicket(customer, {
            ...coordinates,
            ticketId: parsed.command?.ticketId ?? randomUUID(),
            subject: parsed.subject,
            body: parsed.body,
            category: parsed.category,
            ...(parsed.command?.expectedRequesterEmail === null
              ? {}
              : { requesterEmail: parsed.command?.expectedRequesterEmail ?? identity.account.email }),
          }),
        ),
      };
    if (kind === 'patch')
      return {
        body: wire(
          await application.changePriority(staff, {
            commandId: coordinates.commandId,
            correlationId: coordinates.correlationId,
            ticketId,
            priority: parsed.priority,
          }),
        ),
      };
    const view =
      kind === 'customer-reply'
        ? await application.replyToCustomerTicket(customer, {
            ...coordinates,
            body: parsed.body,
          })
        : kind === 'note'
          ? await application.addNote(staff, {
              ...coordinates,
              body: parsed.body,
            })
          : await application.replyAsStaff(staff, {
              ...coordinates,
              body: parsed.body,
            });
    return { status: 201, body: wire(view) };
  }
  async function effects() {
    if (kind === 'create')
      return (await application.listCustomerTickets(customer)).length;
    return (
      (await application.readStaffTicket(staff, ticketId)).ticket.revision -
      baseline
    );
  }
  async function readCustomerAs(principalId: string) {
    const access = resolveAccess(
      { principalId },
      { version: 'synthetic-other-customer', defaults: [supportPermissions.readOwn] },
    );
    return application.readCustomerTicket(access, ticketId);
  }
  async function storedContact(createdTicketId: string) {
    return (await application.readStaffTicket(staff, createdTicketId)).ticket.requester.email;
  }
  return { read, commit, effects, identity, observedCommands, readCustomerAs, storedContact };
}

describe('create contact expectation (actual script and released SDK)', () => {
  it('pins the verified current profile contact once with the create IDs', async () => {
    const sdk = await ledger('create');
    const originalEmail = sdk.identity.account.email;
    const page = supportBrowser('create', (call) =>
      call.method === 'GET' ? sdk.read(call) : sdk.commit(call),
    );
    await ready(page, 'create');
    edit(page, 'create');
    submit(page, 'create');
    await until(page, () => page.node('feedback-status').textContent.includes('Ticket created.'));
    const first = writes(page)[0]!;
    const parsed = command(first, 'create');
    const envelope = parsed.command as { expectedRequesterEmail: string; ticketId: string };
    expect(envelope.expectedRequesterEmail).toBe(originalEmail);
    expect(await sdk.storedContact(envelope.ticketId)).toBe(originalEmail);
    expect(await sdk.effects()).toBe(1);
  });

  it.each([false, true])(
    'recovers an original create after verified profile contact changes (account round trip=%s)',
    async (roundTrip) => {
      const sdk = await ledger('create');
      const owner = sdk.identity.account.subject;
      const originalEmail = sdk.identity.account.email;
      let attempts = 0;
      let retrySettled = false;
      let retryAcknowledged = false;
      const page = supportBrowser('create', async (call) => {
        if (call.method === 'GET') return sdk.read(call);
        const attempt = ++attempts;
        try {
          const ack = await sdk.commit(call);
          if (attempt === 2) retryAcknowledged = true;
          return attempt === 1 ? { status: 503, body: {} } : ack;
        } finally {
          if (attempt === 2) retrySettled = true;
        }
      });
      await ready(page, 'create');
      edit(page, 'create');
      submit(page, 'create');
      await until(page, () => attempts === 1 && page.node('feedback-signed-in').hidden);
      const first = writes(page)[0]!;
      if (roundTrip) {
        sdk.identity.account.subject = 'different-synthetic-account';
        sdk.identity.account.email = 'different-profile@example.test';
        sdk.identity.csrfToken = 'different-profile-csrf';
        reload(page, 'create');
        await until(page, () => !page.node('feedback-signed-out').hidden);
        expect(page.node('feedback-signed-in').hidden).toBe(true);
        expect(page.node('feedback-email').textContent).toBe('');
        submit(page, 'create');
        await page.tick();
        expect(writes(page)).toHaveLength(1);
      }
      sdk.identity.account.subject = owner;
      sdk.identity.account.email = 'changed-owner-contact@example.test';
      sdk.identity.csrfToken = 'original-owner-current-contact-csrf';
      reload(page, 'create');
      await ready(page, 'create');
      expect(page.node('feedback-email').textContent).toBe('changed-owner-contact@example.test');
      edit(page, 'create', true);
      submit(page, 'create');
      await until(page, () => retrySettled);
      expect(retryAcknowledged).toBe(true);
      await until(page, () => page.node('feedback-status').textContent.includes('Ticket created.'));
      expect(writes(page)).toHaveLength(2);
      expect(writes(page)[1]?.body).toBe(first.body);
      expect(writes(page)[1]?.headers.get('X-Pegma-CSRF')).toBe('original-owner-current-contact-csrf');
      const parsed = command(first, 'create');
      const envelope = parsed.command as { expectedRequesterEmail: string; ticketId: string };
      expect(envelope.expectedRequesterEmail).toBe(originalEmail);
      expect(await sdk.storedContact(envelope.ticketId)).toBe(originalEmail);
      expect(await sdk.effects()).toBe(1);
      expect(page.node('ticket-body').value).toBe(nextDraft);
    },
  );

  it.each([undefined, null, '', '   '])(
    'does not invent a null contact from an unavailable current profile email (%s)',
    async (email) => {
      const sdk = await ledger('create');
      const page = supportBrowser('create', async (call) => {
        if (call.method !== 'GET') return sdk.commit(call);
        if (call.path === '/api/identity/account')
          return {
            body: {
              ...sdk.identity,
              account: {
                subject: sdk.identity.account.subject,
                ...(email === undefined ? {} : { email }),
              },
            },
          };
        return sdk.read(call);
      });
      await until(page, () =>
        !page.node('feedback-signed-in').hidden ||
        page.node('feedback-status').dataset.tone === 'error',
      );
      edit(page, 'create');
      submit(page, 'create');
      await page.tick();
      expect(page.node('feedback-signed-in').hidden).toBe(true);
      expect(writes(page)).toHaveLength(0);
      expect(await sdk.effects()).toBe(0);
    },
  );
});

describe('modeled native required-field ordering for retained intents', () => {
  it.each(['create', 'customer-reply', 'staff-reply', 'note'] as const)(
    'retries the stored %s packet despite a cleared new draft, then restores fresh validation',
    async (kind) => {
      const sdk = await ledger(kind);
      let attempts = 0;
      const page = supportBrowser(surface(kind), async (call) => {
        if (call.method === 'GET') return sdk.read(call);
        const ack = await sdk.commit(call);
        return ++attempts === 1 ? { status: 503, body: {} } : ack;
      });
      await ready(page, kind);
      const ids = controls(kind);
      const form = page.node(ids.form);
      // These attributes come from the actual Astro templates, not a parallel
      // test form. Only their required-empty ordering is modeled by nativeSubmit.
      expect(page.node(ids.draft).attributes.has('required')).toBe(true);
      if (kind === 'create') {
        expect(page.node('ticket-subject').attributes.has('required')).toBe(true);
        expect(page.node('ticket-category').attributes.has('required')).toBe(true);
      }
      expect(form.noValidate).toBe(false);
      edit(page, kind);
      form.fire('input');
      form.fire('change');
      expect(page.nativeSubmit(ids.form).dispatched).toBe(true);
      await until(page, () => attempts === 1 && page.node(ids.detail).hidden);
      const first = writes(page)[0]!;
      expect(await sdk.effects()).toBe(1);
      reload(page, kind);
      await ready(page, kind);
      page.node(ids.draft).value = '';
      if (kind === 'create') page.node('ticket-subject').value = '';
      form.fire('input');
      form.fire('change');
      const submitter = form.querySelector('button');
      expect(submitter?.disabled).toBe(false);
      // The old source stops here: native validation never invokes its correct
      // stored-packet submit branch, even though the retry button is enabled.
      expect(page.nativeSubmit(ids.form).dispatched).toBe(true);
      await until(page, () => attempts === 2);
      await ready(page, kind);
      await until(page, () => !form.noValidate);
      expect(writes(page)).toHaveLength(2);
      expect(writes(page)[1]?.path).toBe(first.path);
      expect(writes(page)[1]?.method).toBe(first.method);
      expect(writes(page)[1]?.body).toBe(first.body);
      command(first, kind);
      expect(await sdk.effects()).toBe(1);
      expect(page.node(ids.draft).value).toBe('');
      expect(form.noValidate).toBe(false);
      expect(page.nativeSubmit(ids.form).dispatched).toBe(false);
      await page.tick();
      expect(writes(page)).toHaveLength(2);
    },
  );
});

describe('legacy Support intent retry packets (actual scripts, released SDK)', () => {
  it('loads the genuine released customer message DTO before any mutation', async () => {
    const sdk = await ledger('customer-reply');
    let readVisibility: unknown;
    const page = supportBrowser('customer', async (call) => {
      const result = await sdk.read(call);
      if (call.path.startsWith('/api/support/')) {
        const body = result.body as { messages: { visibility: string }[] };
        readVisibility = body.messages[0]?.visibility;
      }
      return result;
    });
    await ready(page, 'customer-reply');
    expect(readVisibility).toBe('customer');
    expect(page.node('message-list').textContent).toContain(
      'Fictional original question.',
    );
    expect(writes(page)).toEqual([]);
  });

  it('refuses an internal message in a customer response without painting it', async () => {
    const sdk = await ledger('customer-reply');
    const page = supportBrowser('customer', async (call) => {
      const result = await sdk.read(call);
      if (!call.path.startsWith('/api/support/')) return result;
      const body = result.body as { messages: Record<string, unknown>[] };
      return {
        body: {
          ...body,
          messages: body.messages.map((message) => ({
            ...message,
            visibility: 'internal',
            body: 'SYNTHETIC_INTERNAL_MUST_STAY_HIDDEN',
          })),
        },
      };
    });
    await until(page, () =>
      page.node('ticket-status').textContent.includes('Could not confirm'),
    );
    expect(page.node('ticket-detail').hidden).toBe(true);
    expect(page.node('message-list').textContent).toBe('');
    expect(writes(page)).toEqual([]);
  });

  it.each(kinds)(
    'keeps the same %s intent when the original write commits after a successful GET and retry',
    async (kind) => {
      const sdk = await ledger(kind);
      const original = browserGate<void>();
      let firstServer: Promise<BrowserResponse> | undefined;
      let attempts = 0;
      const page = supportBrowser(surface(kind), (call) => {
        if (call.method === 'GET') return sdk.read(call);
        if (++attempts === 1) {
          firstServer = original.promise.then(() => sdk.commit(call));
          return firstServer;
        }
        return sdk.commit(call);
      });
      try {
        await ready(page, kind);
        edit(page, kind);
        submit(page, kind);
        await until(page, () => attempts === 1);
        const first = writes(page)[0]!;
        const readCount = page.calls.filter((call) => call.method === 'GET').length;
        reload(page, kind);
        await until(page,
          () =>
            page.calls.filter((call) => call.method === 'GET').length > readCount,
        );
        await ready(page, kind);
        expect(await sdk.effects()).toBe(0);
        expect(writes(page)).toHaveLength(1);
        edit(page, kind, true);
        submit(page, kind);
        await until(page, () => attempts === 2);
        await until(page, () => sdk.observedCommands.length === 1);
        original.resolve();
        await firstServer;
        await page.drain();
        const sent = writes(page);
        expect(sent).toHaveLength(2);
        expect(sent[1]?.path).toBe(first.path);
        expect(sent[1]?.method).toBe(first.method);
        expect(sent[1]?.body).toBe(first.body);
        command(first, kind);
        expect(await sdk.effects()).toBe(1);
        expect(page.node(controls(kind).draft).value).toBe(nextDraft);
        expect(
          page.calls.slice(page.calls.indexOf(sent[1]!)).some(
            (call) => call.method === 'GET' && !call.path.startsWith('/api/identity/'),
          ),
        ).toBe(true);
      } finally {
        original.resolve();
        await firstServer;
        page.dispose();
      }
    },
  );

  it.each(kinds.flatMap((kind) => [401, 403, 503].map((status) => ({ kind, status }))))(
    'retains exact $kind JSON after a potentially committed $status response and restores only current credentials',
    async ({ kind, status }) => {
      const sdk = await ledger(kind);
      let attempts = 0;
      const page = supportBrowser(surface(kind), async (call) => {
        if (call.method === 'GET') return sdk.read(call);
        const ack = await sdk.commit(call);
        return ++attempts === 1 ? { status, body: {} } : ack;
      });
      await ready(page, kind);
      edit(page, kind);
      const originalUrl = page.window.location.href;
      submit(page, kind);
      await until(page, () =>
        attempts === 1 && page.node(controls(kind).detail).hidden &&
        (status === 401
          ? !page.node(controls(kind).signedOut).hidden
          : page.node(controls(kind).status).dataset.tone === 'error'),
      );
      await page.tick();
      const first = writes(page)[0]!;
      expect(await sdk.effects()).toBe(1);
      expect(page.window.location.href).toBe(originalUrl);
      expect(page.reloads).toBe(0);
      expect(writes(page)).toHaveLength(1);
      if (status === 401) {
        const login = page.node(controls(kind).signedOut).querySelector('a');
        expect(login).not.toBeNull();
        expect(Reflect.get(login!, 'target')).toBe('_blank');
        expect(Reflect.get(login!, 'rel')).toBe('noopener noreferrer');
      }
      sdk.identity.csrfToken = 'synthetic-fresh-csrf';
      reload(page, kind);
      await ready(page, kind);
      edit(page, kind, true);
      submit(page, kind);
      await until(page, () => attempts === 2);
      await page.drain();
      const sent = writes(page);
      expect(sent).toHaveLength(2);
      expect(sent[1]?.path).toBe(first.path);
      expect(sent[1]?.body).toBe(first.body);
      expect(sent[1]?.headers.get('X-Pegma-CSRF')).toBe('synthetic-fresh-csrf');
      command(first, kind);
      expect(await sdk.effects()).toBe(1);
      expect(page.node(controls(kind).draft).value).toBe(nextDraft);
    },
  );

  it.each(kinds)(
    'recovers only the original %s intent after an A to B to A account round trip',
    async (kind) => {
      const sdk = await ledger(kind);
      const owner = sdk.identity.account.subject;
      let attempts = 0;
      const page = supportBrowser(surface(kind), async (call) => {
        if (call.method === 'GET') return sdk.read(call);
        const ack = await sdk.commit(call);
        return ++attempts === 1 ? { status: 503, body: {} } : ack;
      });
      await ready(page, kind);
      edit(page, kind);
      submit(page, kind);
      await until(page, () =>
        attempts === 1 && page.node(controls(kind).status).dataset.tone === 'error',
      );
      const first = writes(page)[0]!;
      expect(await sdk.effects()).toBe(1);
      sdk.identity.account.subject = 'different-synthetic-account';
      sdk.identity.csrfToken = 'different-account-csrf';
      reload(page, kind);
      await until(page, () => page.node(controls(kind).detail).hidden);
      await page.tick();
      submit(page, kind);
      await page.tick();
      expect(writes(page)).toHaveLength(1);
      expect(page.node(controls(kind).detail).hidden).toBe(true);
      sdk.identity.account.subject = owner;
      sdk.identity.csrfToken = 'original-owner-current-csrf';
      reload(page, kind);
      await ready(page, kind);
      edit(page, kind, true);
      submit(page, kind);
      await until(page, () => attempts === 2);
      await page.drain();
      expect(writes(page)).toHaveLength(2);
      expect(writes(page)[1]?.path).toBe(first.path);
      expect(writes(page)[1]?.method).toBe(first.method);
      expect(writes(page)[1]?.body).toBe(first.body);
      expect(writes(page)[1]?.headers.get('X-Pegma-CSRF')).toBe(
        'original-owner-current-csrf',
      );
      expect(await sdk.effects()).toBe(1);
      expect(page.node(controls(kind).draft).value).toBe(nextDraft);
      command(first, kind);
    },
  );

  it.each(kinds)(
    'does not resend a retained %s packet under another principal',
    async (kind) => {
      const sdk = await ledger(kind);
      const page = supportBrowser(surface(kind), async (call) =>
        call.method === 'GET'
          ? sdk.read(call)
          : { status: 503, body: {} },
      );
      await ready(page, kind);
      edit(page, kind);
      submit(page, kind);
      await until(page, () => page.node(controls(kind).status).dataset.tone === 'error');
      sdk.identity.account.subject = 'another-synthetic-principal';
      sdk.identity.csrfToken = 'another-principal-csrf';
      reload(page, kind);
      await page.tick();
      submit(page, kind);
      await page.tick();
      expect(writes(page)).toHaveLength(1);
      command(writes(page)[0], kind);
    },
  );

  it('keeps an A-owned reply when a cookie switch after its identity probe causes a genuine SDK 404', async () => {
    const sdk = await ledger('customer-reply');
    const owner = sdk.identity.account.subject;
    const cookieB = 'synthetic-other-cookie-owner';
    let attempts = 0;
    let raceArmed = false;
    let genuineNotFound = false;
    const probedSubjects: string[] = [];
    const page = supportBrowser('customer', async (call) => {
      if (call.method !== 'GET') {
        const ack = await sdk.commit(call);
        return ++attempts === 1 ? { status: 503, body: {} } : ack;
      }
      if (call.path === '/api/identity/session' && raceArmed)
        probedSubjects.push(sdk.identity.account.subject);
      if (call.path === `/api/support/tickets/${ticketId}` && raceArmed) {
        // The pre-read identity response was A; this target read now uses B's
        // actual SDK permission context. No missing ticket or fake404 needed.
        raceArmed = false;
        sdk.identity.account.subject = cookieB;
        sdk.identity.csrfToken = 'synthetic-cookie-b-csrf';
        try {
          await sdk.readCustomerAs(cookieB);
          throw new Error('The real SDK unexpectedly exposed another owner ticket.');
        } catch (error) {
          if (!(error instanceof SupportDeskNotFoundError)) throw error;
          genuineNotFound = true;
          return { status: 404, body: { error: 'not_found' } };
        }
      }
      return sdk.read(call);
    });
    await ready(page, 'customer-reply');
    edit(page, 'customer-reply');
    submit(page, 'customer-reply');
    await until(page, () => attempts === 1 && page.node('ticket-detail').hidden);
    const first = writes(page)[0]!;
    expect(await sdk.effects()).toBe(1);
    raceArmed = true;
    reload(page, 'customer-reply');
    await until(page, () => genuineNotFound && page.node('ticket-status').textContent.includes('not found'));
    expect(probedSubjects).toEqual([owner]);
    expect(page.node('ticket-detail').hidden).toBe(true);
    expect(page.node('message-list').textContent).toBe('');
    submit(page, 'customer-reply');
    await page.tick();
    expect(writes(page)).toHaveLength(1);
    sdk.identity.account.subject = owner;
    sdk.identity.csrfToken = 'owner-current-after-cookie-race';
    reload(page, 'customer-reply');
    await ready(page, 'customer-reply');
    edit(page, 'customer-reply', true);
    submit(page, 'customer-reply');
    await until(page, () => attempts === 2);
    await page.drain();
    expect(writes(page)[1]?.body).toBe(first.body);
    expect(writes(page)[1]?.headers.get('X-Pegma-CSRF')).toBe('owner-current-after-cookie-race');
    command(first, 'customer-reply');
    expect(await sdk.effects()).toBe(1);
    expect(page.node('reply-body').value).toBe(nextDraft);
  });

  it.each(
    kinds.filter((kind) => kind !== 'create').flatMap((kind) =>
      ['mutation', 'read'].map((phase) => ({ kind, phase })),
    ),
  )(
    'retains an unknown $kind intent through an HTTP404 from its $phase path',
    async ({ kind, phase }) => {
      const sdk = await ledger(kind);
      let attempts = 0;
      let failRead = false;
      const target = kind === 'customer-reply'
        ? `/api/support/tickets/${ticketId}`
        : `/api/support/admin/tickets/${ticketId}`;
      const page = supportBrowser(surface(kind), async (call) => {
        if (call.method !== 'GET') {
          const ack = await sdk.commit(call);
          return ++attempts === 1
            ? { status: phase === 'mutation' ? 404 : 503, body: {} }
            : ack;
        }
        if (failRead && call.path === target) return { status: 404, body: {} };
        return sdk.read(call);
      });
      await ready(page, kind);
      edit(page, kind);
      submit(page, kind);
      await until(page, () => attempts === 1 && page.node(controls(kind).detail).hidden);
      const first = writes(page)[0]!;
      if (phase === 'read') {
        failRead = true;
        reload(page, kind);
      }
      await until(page, () => page.node(controls(kind).status).textContent.includes('not found'));
      expect(page.node(controls(kind).detail).hidden).toBe(true);
      submit(page, kind);
      await page.tick();
      expect(writes(page)).toHaveLength(1);
      failRead = false;
      sdk.identity.csrfToken = 'current-csrf-after-404';
      reload(page, kind);
      await ready(page, kind);
      edit(page, kind, true);
      submit(page, kind);
      await until(page, () => attempts === 2);
      await page.drain();
      expect(writes(page)[1]?.path).toBe(first.path);
      expect(writes(page)[1]?.method).toBe(first.method);
      expect(writes(page)[1]?.body).toBe(first.body);
      command(first, kind);
      expect(await sdk.effects()).toBe(1);
      expect(page.node(controls(kind).draft).value).toBe(nextDraft);
    },
  );

  it.each(kinds.filter((kind) => kind !== 'create'))(
    'retains the acknowledged %s intent through GET404 until a fresh read completes its original draft',
    async (kind) => {
      const sdk = await ledger(kind);
      let accepted = false;
      let failRead = true;
      let missingReads = 0;
      const target = kind === 'customer-reply'
        ? `/api/support/tickets/${ticketId}`
        : `/api/support/admin/tickets/${ticketId}`;
      const page = supportBrowser(surface(kind), async (call) => {
        if (call.method !== 'GET') {
          const ack = await sdk.commit(call);
          accepted = true;
          return ack;
        }
        if (accepted && failRead && call.path === target) {
          ++missingReads;
          return { status: 404, body: {} };
        }
        return sdk.read(call);
      });
      await ready(page, kind);
      edit(page, kind);
      submit(page, kind);
      await until(page, () =>
        missingReads === 1 && page.node(controls(kind).detail).hidden &&
        (page.node(controls(kind).status).textContent.includes('not found') ||
          page.node(controls(kind).status).textContent.includes('accepted. Current ticket refresh failed')),
      );
      expect(page.node(controls(kind).draft).value).toBe(originalBody);
      submit(page, kind);
      await page.tick();
      expect(writes(page)).toHaveLength(1);
      failRead = false;
      sdk.identity.csrfToken = 'current-csrf-after-ack-404';
      reload(page, kind);
      await ready(page, kind);
      expect(writes(page)).toHaveLength(1);
      expect(await sdk.effects()).toBe(1);
      expect(page.node(controls(kind).draft).value).toBe(kind === 'patch' ? originalBody : '');
      command(writes(page)[0], kind);
    },
  );

  it('does not treat a create 404 or a list containing the ticket as proof the unknown create is settled', async () => {
    const sdk = await ledger('create');
    let attempts = 0;
    const page = supportBrowser('create', async (call) => {
      if (call.method === 'GET') return sdk.read(call);
      const ack = await sdk.commit(call);
      return ++attempts === 1 ? { status: 404, body: {} } : ack;
    });
    await ready(page, 'create');
    edit(page, 'create');
    submit(page, 'create');
    await until(page, () => page.node('feedback-status').dataset.tone === 'error');
    reload(page, 'create');
    await ready(page, 'create');
    expect(page.node('ticket-list').textContent).toContain('Fictional original subject');
    edit(page, 'create', true);
    submit(page, 'create');
    await until(page, () => attempts === 2);
    await page.drain();
    expect(writes(page)[1]?.body).toBe(writes(page)[0]?.body);
    command(writes(page)[0], 'create');
    expect(await sdk.effects()).toBe(1);
    expect(page.node('ticket-body').value).toBe(nextDraft);
  });

  it.each(kinds)(
    'keeps %s writes blocked after a receipt ACK until the post-ACK current read succeeds',
    async (kind) => {
      const sdk = await ledger(kind);
      let accepted = false;
      let readsFail = true;
      const page = supportBrowser(surface(kind), async (call) => {
        if (call.method !== 'GET') {
          const ack = await sdk.commit(call);
          accepted = true;
          return ack;
        }
        if (accepted && readsFail && call.path.startsWith('/api/support/'))
          return { status: 503, body: {} };
        return sdk.read(call);
      });
      await ready(page, kind);
      edit(page, kind);
      submit(page, kind);
      await until(page, () => accepted);
      await page.tick();
      const first = writes(page)[0]!;
      expect(
        page.calls.slice(page.calls.indexOf(first)).some(
          (call) => call.method === 'GET' && call.path.startsWith('/api/support/'),
        ),
      ).toBe(true);
      edit(page, kind, true);
      submit(page, kind);
      await page.tick();
      expect(writes(page)).toHaveLength(1);
      expect(page.node(controls(kind).draft).value).toBe(nextDraft);
      readsFail = false;
      reload(page, kind);
      await ready(page, kind);
      expect(writes(page)).toHaveLength(1);
      expect(await sdk.effects()).toBe(1);
      expect(page.node(controls(kind).draft).value).toBe(nextDraft);
      command(first, kind);
    },
  );
});

/** A real terminal ticket keeps the customer request-person control relevant.
 * Host-only draft validation remains outside the published SDK fixture. */
async function resolvedCustomerDraftLedger() {
  const application = createSupportDeskApplication({
    store: createMemoryStore(), clock: { now: () => new Date().toISOString() },
  });
  const customer = resolveAccess({ principalId: 'synthetic-customer' }, {
    version: 'synthetic-rejected-draft-customer', defaults: [
      supportPermissions.create, supportPermissions.readOwn,
      supportPermissions.replyOwn, supportPermissions.requestPerson,
    ],
  });
  const staff = resolveAccess({ principalId: 'synthetic-staff' }, {
    version: 'synthetic-rejected-draft-staff',
    defaults: [supportPermissions.queueRead, supportPermissions.manage],
  });
  await application.createCustomerTicket(customer, {
    commandId: randomUUID(), correlationId: randomUUID(), ticketId,
    messageId: randomUUID(), subject: 'Fictional resolved question',
    body: 'Fictional original question.',
  });
  await application.resolveTicket(staff, {
    commandId: randomUUID(), correlationId: randomUUID(), ticketId,
  });
  const baseline = (await application.readStaffTicket(staff, ticketId)).ticket.revision;
  const identity = { account: { subject: customer.principalId, email: 'fictional-reader@example.test' },
    csrfToken: 'synthetic-current-csrf' };
  function wire<T extends { ticket: { number: number } }>(view: T) {
    return { ...view, ticket: { ...view.ticket, marker: `[PEG-${view.ticket.number}]` }, csrfToken: identity.csrfToken };
  }
  return {
    async read(call: BrowserCall): Promise<BrowserResponse> {
      return { body: call.path.startsWith('/api/identity/')
        ? identity : wire(await application.readCustomerTicket(customer, ticketId)) };
    },
    async commit(call: BrowserCall): Promise<BrowserResponse> {
      const input = JSON.parse(call.body ?? '{}') as {
        body: string; command: { commandId: string; messageId: string };
      };
      const view = await application.replyToCustomerTicket(customer, {
        commandId: input.command.commandId, messageId: input.command.messageId,
        correlationId: randomUUID(), ticketId, body: input.body,
      });
      return { status: 201, body: wire(view) };
    },
    async effects() {
      return (await application.readStaffTicket(staff, ticketId)).ticket.revision - baseline;
    },
  };
}

describe('invalid new draft before ordinary packet ownership', () => {
  it.each(['create', 'customer-reply', 'staff-reply', 'note'] as const)(
    'allows a corrected %s draft after host-only C1 rejection without holding a phantom pending packet',
    async (kind) => {
      // Import the actual shared host validator rather than copying its regex.
      // Support020's nonempty body check itself does not reject C1; this is
      // explicitly a host400 adapter plus real SDK success/effect proof.
      const { ApiError, boundedString } = await import('../worker/src/api-auth');
      const sdk = kind === 'customer-reply' ? await resolvedCustomerDraftLedger() : await ledger(kind);
      const invalidBody = 'A fictional rejected \u009b draft.';
      const rejected: { call: BrowserCall; body: string; status: number; code: string }[] = [];
      let successfulSdkCommands = 0;
      const page = supportBrowser(surface(kind), async (call) => {
        if (call.method === 'GET') return sdk.read(call);
        const parsed = JSON.parse(call.body ?? '{}') as { subject?: unknown; body?: unknown };
        try {
          if (kind === 'create') boundedString(parsed.subject, 1, 200);
          boundedString(parsed.body, 1, 20_000, { allowMultiline: true });
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          rejected.push({ call, body: String(parsed.body), status: error.status, code: error.code });
          return { status: error.status, body: { error: error.code } };
        }
        const result = await sdk.commit(call);
        successfulSdkCommands += 1;
        return result;
      });
      await ready(page, kind);
      const ids = controls(kind);
      edit(page, kind);
      page.node(ids.draft).value = invalidBody;
      page.node(ids.form).fire('input'); page.node(ids.form).fire('change');
      // The actual form's required/maxlength constraints do not exclude C1.
      // Its modeled native activation reaches the genuine script listener.
      expect(page.nativeSubmit(ids.form).dispatched).toBe(true);
      await until(page, () => {
        const status = page.node(ids.status);
        const visibleError = status.dataset.tone === 'error' && status.textContent !== '';
        // Native SDK hashing can yield beyond drain's microtask window. Wait
        // for the server refusal to reach the UI, or a positively observed
        // local validation error with a settled editable form and no write.
        return visibleError && (rejected.length > 0 || (
          writes(page).length === 0 && !page.node(ids.detail).hidden &&
          page.node(ids.form).querySelector('button')?.disabled === false
        ));
      });
      await page.drain();
      const invalidCalls = [...writes(page)];
      for (const refusal of rejected) {
        expect(refusal.status).toBe(400); expect(refusal.code).toBe('invalid_request');
        expect(refusal.body).toBe(invalidBody);
        expect(JSON.parse(refusal.call.body ?? '{}').body).toBe(invalidBody);
      }
      expect(successfulSdkCommands).toBe(0);
      expect(await sdk.effects()).toBe(0);
      expect(page.node(ids.draft).value).toBe(invalidBody);
      // A corrected implementation may refuse locally before packet/IDs,
      // without any HTTP write; the existing source instead gets real host400.
      expect(invalidCalls).toHaveLength(rejected.length);
      reload(page, kind); await ready(page, kind);
      const phantomOwnership = page.node(ids.form).noValidate;
      const human = kind === 'create' ? null
        : page.node(kind === 'customer-reply' ? 'request-person' : 'action-take-over');
      const humanAvailable = human === null ? null : !human.hidden && !human.disabled;
      edit(page, kind, true);
      // The shared later-draft helper deliberately flips mode for immutable
      // retry tests. This is a fresh corrected intent of this case's kind.
      if (kind === 'staff-reply' || kind === 'note')
        page.mode(kind === 'note' ? 'internal' : 'public');
      page.node(ids.form).fire('input'); page.node(ids.form).fire('change');
      const writesBeforeCorrection = writes(page).length;
      expect(page.nativeSubmit(ids.form).dispatched).toBe(true);
      await until(page, () => writes(page).length > writesBeforeCorrection);
      const corrected = writes(page).at(-1)!;
      expect(corrected.path).toBe(kind === 'create' ? '/api/support/tickets'
        : kind === 'customer-reply' ? `/api/support/tickets/${ticketId}/replies`
          : `/api/support/admin/tickets/${ticketId}/${kind === 'staff-reply' ? 'messages' : 'notes'}`);
      expect(JSON.parse(corrected.body ?? '{}').body).toBe(nextDraft);
      expect(corrected.body).not.toContain(invalidBody);
      command(corrected, kind);
      if (invalidCalls[0]) {
        const old = JSON.parse(invalidCalls[0].body ?? '{}').command;
        const next = JSON.parse(corrected.body ?? '{}').command;
        expect(next.commandId).not.toBe(old.commandId);
        expect(next.messageId).not.toBe(old.messageId);
        if (kind === 'create') expect(next.ticketId).not.toBe(old.ticketId);
      }
      expect(phantomOwnership).toBe(false);
      if (humanAvailable !== null) expect(humanAvailable).toBe(true);
      const success = kind === 'create' ? 'Ticket created.' : kind === 'customer-reply' ? 'Reply sent.'
        : kind === 'staff-reply' ? 'Public reply sent.' : 'Internal note saved.';
      await until(page, () => page.node(ids.status).textContent.includes(success));
      await page.drain();
      expect(successfulSdkCommands).toBe(1);
      expect(await sdk.effects()).toBe(1);
      expect(page.node(ids.form).noValidate).toBe(false);
      expect(page.node(ids.draft).value).toBe('');
    },
  );
});
