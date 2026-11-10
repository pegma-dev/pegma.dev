import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStore } from '@pegma/storage-core';
import { resolveAccess } from '@pegma/authorization-core';
import {
  createSupportDeskApplication,
  supportPermissions,
} from '@pegma/support-desk-application';
import {
  browserGate,
  disposeSupportBrowsers,
  supportBrowser,
  type BrowserCall,
  type BrowserResponse,
} from './test-support-browser';

afterEach(() => {
  disposeSupportBrowsers();
  vi.useRealTimers();
});

const id = 'ticket-example';
const account = {
  account: { subject: 'synthetic-reader', email: 'reader@example.test' },
  csrfToken: 'synthetic-csrf-a',
};
function customerView(handling = 'assistant', status = 'open') {
  return {
    ticket: {
      id,
      number: 1,
      marker: '[PEG-1]',
      subject: 'Fictional guide request',
      status,
      category: 'feedback',
      channel: 'web',
      handling,
    },
    messages: [
      {
        id: 'message-1',
        ticketId: id,
        visibility: 'public',
        authorKind: 'assistant',
        body: 'Fictional instructions.',
        createdAt: '2026-11-09T12:00:00.000Z',
      },
    ],
    csrfToken: account.csrfToken,
  };
}
function staffView(
  revision = 7,
  handling?: { state: string; generation: number },
  status = 'open',
) {
  const customer = customerView();
  return {
    ...customer,
    ticket: {
      ...customer.ticket,
      status,
      revision,
      handling,
      priority: 'normal',
      requester: {
        association: 'authenticated',
        principalId: 'synthetic-reader',
        email: 'reader@example.test',
      },
      assignedTo: 'synthetic-existing-operator',
    },
    messages: [
      ...customer.messages,
      {
        id: 'note-1',
        ticketId: id,
        visibility: 'internal',
        authorKind: 'staff',
        body: 'SYNTHETIC_INTERNAL_NOTE',
        createdAt: '2026-11-09T12:00:00.000Z',
      },
    ],
  };
}
function handoff(ticketId = id) {
  return {
    handoff: [
      {
        ticketId,
        workId: 'handoff-example',
        status: 'pending',
        reason: 'customer_requested',
        summary: '<b>SYNTHETIC_PRIVATE_HANDOFF</b>',
        attemptedGuideIds: ['fictional-guide'],
        transcript: {
          ticketId,
          throughRevision: 7,
          lastVisibleMessageId: 'message-1',
        },
        handlingGeneration: 1,
        createdAt: '2026-11-09T12:00:00.000Z',
        extra: 'UNEXPOSED_HANDOFF_FIELD',
      },
    ],
    csrfToken: account.csrfToken,
  };
}
function posts(calls: BrowserCall[], suffix: string) {
  return calls.filter(
    (call) => call.method === 'POST' && call.path.endsWith(suffix),
  );
}

describe('public Support human-control event handlers (synthetic browser adapters)', () => {
  it('retries the exact customer packet after lost ACK and preserves the reply draft', async () => {
    const lost = browserGate<BrowserResponse>();
    let attempts = 0;
    let view = customerView();
    const page = supportBrowser('customer', (call) => {
      if (call.path === '/api/identity/session') return { body: account };
      if (call.path.endsWith('/request-person')) {
        ++attempts;
        if (attempts === 2) view = customerView('human-pending');
        return attempts === 1 ? lost.promise : { body: view };
      }
      return { body: view };
    });
    await page.until(() => !page.node('ticket-detail').hidden);
    expect(page.node('message-list').textContent).toContain('Assistant');
    page.node('reply-body').value = 'Unsent fictional reply';
    page.node('request-person').fire('click');
    await page.until(() => attempts === 1);
    expect(page.node('request-person').disabled).toBe(true);
    page.node('request-person').fire('click');
    expect(attempts).toBe(1);
    lost.reject(new TypeError('Synthetic lost response'));
    await page.until(() => !page.node('request-person').disabled);
    page.node('request-person').fire('click');
    await page.until(() =>
      page.node('ticket-status').textContent.includes('requested.'),
    );
    const requests = posts(page.calls, '/request-person');
    expect(requests).toHaveLength(2);
    expect(requests[1]?.body).toBe(requests[0]?.body);
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({
      commandId: expect.stringMatching(
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u,
      ),
    });
    expect(requests[0]?.headers.get('X-Pegma-CSRF')).toBe(account.csrfToken);
    expect(page.node('reply-body').value).toBe('Unsent fictional reply');
    expect(page.node('request-person').hidden).toBe(true);
  });

  it.each(['human-pending', 'human-active'])(
    'shows truthful ordinary %s handling without a request-person action',
    async (state) => {
      const page = supportBrowser('customer', (call) => ({
        body:
          call.path === '/api/identity/session' ? account : customerView(state),
      }));
      await page.until(() => !page.node('ticket-detail').hidden);
      expect(page.node('request-person').hidden).toBe(true);
      expect(
        page.node('ticket-human-status').textContent.toLowerCase(),
      ).toContain('human support');
      expect(posts(page.calls, '/request-person')).toHaveLength(0);
    },
  );

  it('offers request-person for a terminal ticket and creates a new intent only after conflict refresh', async () => {
    let attempts = 0;
    const page = supportBrowser('customer', (call) => {
      if (call.path === '/api/identity/session') return { body: account };
      if (call.path.endsWith('/request-person')) {
        ++attempts;
        return attempts === 1
          ? { status: 409, body: { error: 'conflict' } }
          : { body: customerView('human-pending') };
      }
      return { body: customerView('human-pending', 'closed') };
    });
    await page.until(() => !page.node('ticket-detail').hidden);
    expect(page.node('request-person').hidden).toBe(false);
    page.node('request-person').fire('click');
    await page.until(() =>
      page.node('ticket-status').textContent.includes('Review it'),
    );
    expect(attempts).toBe(1);
    page.node('request-person').fire('click');
    await page.until(() => attempts === 2);
    const requests = posts(page.calls, '/request-person');
    expect(requests[0]?.body).not.toBe(requests[1]?.body);
  });

  it.each([401, 403])(
    'clears customer private content on a %s command response',
    async (status) => {
      const page = supportBrowser('customer', (call) => {
        if (call.path === '/api/identity/session') return { body: account };
        if (call.path.endsWith('/request-person'))
          return { status, body: { error: 'denied' } };
        return { body: customerView() };
      });
      await page.until(() => !page.node('ticket-detail').hidden);
      page.node('reply-body').value = 'Unsent local draft';
      page.node('request-person').fire('click');
      await page.until(() => page.node('ticket-detail').hidden);
      expect(page.node('message-list').textContent).toBe('');
      expect(page.node('ticket-heading').textContent).toBe('Ticket');
      expect(page.node('ticket-human-controls').hidden).toBe(true);
      expect(page.node('reply-body').value).toBe('Unsent local draft');
    },
  );

  it('does not replay an unresolved customer packet as a changed account/session', async () => {
    let changed = false;
    const page = supportBrowser('customer', (call) => {
      if (call.path === '/api/identity/session')
        return {
          body: changed
            ? {
                account: { subject: 'synthetic-other' },
                csrfToken: 'synthetic-other-csrf',
              }
            : account,
        };
      if (call.path.endsWith('/request-person'))
        throw new TypeError('Synthetic lost response');
      return { body: customerView() };
    });
    await page.until(() => !page.node('ticket-detail').hidden);
    page.node('request-person').fire('click');
    await page.until(() =>
      page.node('ticket-status').textContent.includes('Could not confirm'),
    );
    changed = true;
    page.node('request-person').fire('click');
    await page.until(() => !page.node('ticket-signed-out').hidden);
    expect(posts(page.calls, '/request-person')).toHaveLength(1);
    expect(page.node('message-list').textContent).toBe('');
  });

  it('rejects customer messages for another ticket and never renders their body', async () => {
    const view = customerView();
    view.messages[0] = {
      ...view.messages[0]!,
      ticketId: 'other-ticket',
      body: 'WRONG_TICKET_BODY',
    };
    const page = supportBrowser('customer', (call) => ({
      body: call.path === '/api/identity/session' ? account : view,
    }));
    await page.until(() =>
      page.node('ticket-status').textContent.includes('Could not confirm'),
    );
    expect(page.node('ticket-detail').hidden).toBe(true);
    expect(page.node('message-list').textContent).not.toContain(
      'WRONG_TICKET_BODY',
    );
  });

  it('keeps legacy generation0/revision fences across uncertain takeover and refreshes historical ACKs', async () => {
    let view = staffView();
    let attempts = 0;
    const lost = browserGate<BrowserResponse>();
    const page = supportBrowser('staff', (call) => {
      if (call.path === '/api/identity/session') return { body: account };
      if (call.path.endsWith('/handoff')) return { body: handoff() };
      if (call.path.endsWith('/take-over')) {
        ++attempts;
        if (attempts === 1) return lost.promise;
        view = staffView(12, { state: 'human-active', generation: 2 });
        return { body: staffView(8, { state: 'human-active', generation: 1 }) };
      }
      return { body: view };
    });
    await page.until(
      () =>
        page.node('staff-handoff-status').textContent ===
        'Private handoff loaded.',
    );
    page.node('compose-body').value = 'Unsent staff note';
    page.mode('internal');
    page.node('action-take-over').fire('click');
    await page.until(() => attempts === 1);
    page.node('action-take-over').fire('click');
    expect(attempts).toBe(1);
    lost.reject(new TypeError('Synthetic lost acknowledgement'));
    await page.until(() => !page.node('action-take-over').disabled);
    view = staffView(10, { state: 'human-active', generation: 1 });
    page.node('staff-ticket-reload').fire('click');
    await page.until(() =>
      page.node('staff-ticket-meta').textContent.includes('rev 10'),
    );
    page.node('action-take-over').fire('click');
    await page.until(() =>
      page
        .node('staff-ticket-status')
        .textContent.includes('Take over accepted'),
    );
    const requests = posts(page.calls, '/take-over');
    expect(requests).toHaveLength(2);
    expect(requests[0]?.body).toBe(requests[1]?.body);
    expect(JSON.parse(requests[0]?.body ?? '{}')).toEqual({
      commandId: expect.any(String),
      expectedRevision: 7,
      expectedHandlingGeneration: 0,
    });
    expect(page.node('staff-ticket-meta').textContent).toContain('rev 12');
    expect(page.node('staff-ticket-meta').textContent).toContain(
      'assigned:synthetic-existing-operator',
    );
    expect(page.node('compose-body').value).toBe('Unsent staff note');
    expect(
      page
        .node('staff-compose-form')
        .querySelector('input[name="composeMode"]:checked')?.value,
    ).toBe('internal');
    expect(page.calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('refreshes conflict fences and waits for a new takeover click/command', async () => {
    let view = staffView();
    let attempts = 0;
    const page = supportBrowser('staff', (call) => {
      if (call.path === '/api/identity/session') return { body: account };
      if (call.path.endsWith('/handoff')) return { body: handoff() };
      if (call.path.endsWith('/take-over')) {
        ++attempts;
        if (attempts === 1) {
          view = staffView(11, { state: 'human-pending', generation: 3 });
          return { status: 409, body: { error: 'conflict' } };
        }
        view = staffView(12, { state: 'human-active', generation: 4 });
      }
      return { body: view };
    });
    await page.until(() => !page.node('staff-ticket-detail').hidden);
    page.node('action-take-over').fire('click');
    await page.until(() =>
      page
        .node('staff-ticket-status')
        .textContent.includes('choosing Take over again'),
    );
    expect(attempts).toBe(1);
    page.node('action-take-over').fire('click');
    await page.until(() => attempts === 2);
    const packets = posts(page.calls, '/take-over').map((call) =>
      JSON.parse(call.body ?? '{}'),
    );
    expect(packets[1]).toMatchObject({
      expectedRevision: 11,
      expectedHandlingGeneration: 3,
    });
    expect(packets[1].commandId).not.toBe(packets[0].commandId);
  });

  it.each(['subject', 'csrfToken'])(
    'never replays an unresolved takeover after the viewer %s changes',
    async (field) => {
      let changed = false;
      const page = supportBrowser('staff', (call) => {
        if (call.path === '/api/identity/session')
          return {
            body: changed
              ? field === 'subject'
                ? {
                    ...account,
                    account: { ...account.account, subject: 'other-reader' },
                  }
                : { ...account, csrfToken: 'synthetic-new-session' }
              : account,
          };
        if (call.path.endsWith('/handoff')) return { body: handoff() };
        if (call.path.endsWith('/take-over'))
          throw new TypeError('Synthetic lost acknowledgement');
        return { body: staffView() };
      });
      await page.until(
        () =>
          page.node('staff-handoff-status').textContent ===
          'Private handoff loaded.',
      );
      page.node('compose-body').value =
        'Local draft kept across sign-in changes';
      page.node('action-take-over').fire('click');
      await page.until(() =>
        page
          .node('staff-ticket-status')
          .textContent.includes('Could not confirm'),
      );
      changed = true;
      page.node('action-take-over').fire('click');
      await page.until(() => !page.node('staff-ticket-signed-out').hidden);
      expect(posts(page.calls, '/take-over')).toHaveLength(1);
      expect(page.node('staff-message-list').textContent).toBe('');
      expect(page.node('staff-handoff-list').textContent).toBe('');
      expect(page.node('compose-body').value).toBe(
        'Local draft kept across sign-in changes',
      );
    },
  );

  it('keeps terminal takeover disabled until the separate reopen command succeeds', async () => {
    let view = staffView(7, undefined, 'closed');
    const page = supportBrowser('staff', (call) => {
      if (call.path === '/api/identity/session') return { body: account };
      if (call.path.endsWith('/handoff')) return { body: handoff() };
      if (call.method === 'PATCH') view = staffView(8);
      return { body: view };
    });
    await page.until(() => !page.node('staff-ticket-detail').hidden);
    expect(page.node('action-take-over').disabled).toBe(true);
    page.node('action-take-over').fire('click');
    expect(posts(page.calls, '/take-over')).toHaveLength(0);
    page.node('action-reopen').fire('click');
    await page.until(() => !page.node('action-take-over').disabled);
    expect(page.calls.find((call) => call.method === 'PATCH')?.body).toBe(
      '{"action":"reopen"}',
    );
  });

  it('renders private handoff as text without fetching guide references or leaking extra fields', async () => {
    const page = supportBrowser('staff', (call) => ({
      body:
        call.path === '/api/identity/session'
          ? account
          : call.path.endsWith('/handoff')
            ? handoff()
            : staffView(),
    }));
    await page.until(
      () =>
        page.node('staff-handoff-status').textContent ===
        'Private handoff loaded.',
    );
    expect(page.node('staff-message-list').textContent).toContain('Assistant');
    expect(page.node('staff-handoff-list').textContent).toContain(
      '<b>SYNTHETIC_PRIVATE_HANDOFF</b>',
    );
    expect(page.node('staff-handoff-list').textContent).not.toContain(
      'UNEXPOSED_HANDOFF_FIELD',
    );
    expect(page.node('staff-handoff-list').querySelectorAll('a')).toHaveLength(
      0,
    );
    expect(page.node('staff-message-list').textContent).not.toContain(
      'SYNTHETIC_PRIVATE_HANDOFF',
    );
    expect(page.calls.every((call) => call.path.startsWith('/api/'))).toBe(
      true,
    );
    expect(
      page.calls.some((call) => call.path.includes('fictional-guide')),
    ).toBe(false);
  });

  it.each([401, 403, 404])(
    'cannot revive a late private handoff after a newer %s ticket denial',
    async (status) => {
      const old = browserGate<BrowserResponse>();
      let denied = false;
      const page = supportBrowser('staff', (call) => {
        if (call.path === '/api/identity/session') return { body: account };
        if (call.path.endsWith('/handoff')) return old.promise;
        return denied
          ? { status, body: { error: 'denied' } }
          : { body: staffView() };
      });
      await page.until(() =>
        page.calls.some((call) => call.path.endsWith('/handoff')),
      );
      page.node('compose-body').value = 'Preserved local draft';
      denied = true;
      page.node('staff-ticket-reload').fire('click');
      await page.until(() => page.node('staff-ticket-detail').hidden);
      old.resolve({ body: handoff() });
      await page.until(
        () => page.node('staff-ticket-status').textContent !== 'Ticket loaded.',
      );
      await page.drain();
      expect(page.node('staff-handoff').hidden).toBe(true);
      expect(page.node('staff-handoff-list').textContent).toBe('');
      expect(page.node('staff-message-list').textContent).toBe('');
      expect(page.node('compose-body').value).toBe('Preserved local draft');
    },
  );

  it.each(['record', 'transcript'])(
    'clears the private pane for a wrong-ticket handoff %s',
    async (wrong) => {
      const result = handoff(wrong === 'record' ? 'another-ticket' : id);
      if (wrong === 'transcript')
        result.handoff[0]!.transcript.ticketId = 'another-ticket';
      const page = supportBrowser('staff', (call) => ({
        body:
          call.path === '/api/identity/session'
            ? account
            : call.path.endsWith('/handoff')
              ? result
              : staffView(),
      }));
      await page.until(() =>
        page.node('staff-handoff-status').textContent.includes('unavailable'),
      );
      expect(page.node('staff-handoff-list').textContent).toBe('');
      expect(page.node('staff-handoff-status').textContent).not.toContain(
        'No handoff',
      );
    },
  );

  it.each([401, 403])(
    'clears an already loaded private handoff on a %s refresh denial',
    async (status) => {
      let denied = false;
      const page = supportBrowser('staff', (call) => {
        if (call.path === '/api/identity/session') return { body: account };
        if (call.path.endsWith('/handoff'))
          return denied
            ? { status, body: { error: 'denied' } }
            : { body: handoff() };
        return { body: staffView() };
      });
      await page.until(() =>
        page
          .node('staff-handoff-list')
          .textContent.includes('SYNTHETIC_PRIVATE_HANDOFF'),
      );
      page.node('compose-body').value = 'Unsent private local note';
      denied = true;
      page.node('staff-handoff-reload').fire('click');
      await page.until(() =>
        status === 401
          ? !page.node('staff-ticket-signed-out').hidden
          : !page.node('staff-ticket-forbidden').hidden,
      );
      expect(page.node('staff-handoff').hidden).toBe(true);
      expect(page.node('staff-handoff-list').textContent).toBe('');
      expect(page.node('staff-message-list').textContent).toBe('');
      expect(page.node('compose-body').value).toBe('Unsent private local note');
    },
  );

  it('clears the old private pane when the next staff ticket response identifies another ticket', async () => {
    let wrong = false;
    const page = supportBrowser('staff', (call) => {
      if (call.path === '/api/identity/session') return { body: account };
      if (call.path.endsWith('/handoff')) return { body: handoff() };
      const view = staffView();
      return {
        body: wrong
          ? {
              ...view,
              ticket: {
                ...view.ticket,
                id: 'another-ticket',
                subject: 'WRONG_TICKET_SUBJECT',
              },
            }
          : view,
      };
    });
    await page.until(() =>
      page
        .node('staff-handoff-list')
        .textContent.includes('SYNTHETIC_PRIVATE_HANDOFF'),
    );
    wrong = true;
    page.node('staff-ticket-reload').fire('click');
    await page.until(() =>
      page
        .node('staff-ticket-status')
        .textContent.includes('Could not confirm'),
    );
    expect(page.node('staff-ticket-detail').hidden).toBe(true);
    expect(page.node('staff-ticket-heading').textContent).toBe('Staff ticket');
    expect(page.node('staff-handoff-list').textContent).toBe('');
    expect(page.document.textContent).not.toContain('WRONG_TICKET_SUBJECT');
  });

  it('invalidates a pending private read when the page changes ticket', async () => {
    const old = browserGate<BrowserResponse>();
    const page = supportBrowser('staff', (call) => {
      if (call.path === '/api/identity/session') return { body: account };
      return call.path.endsWith('/handoff')
        ? old.promise
        : { body: staffView() };
    });
    await page.until(() =>
      page.calls.some((call) => call.path.endsWith('/handoff')),
    );
    page.window.location.href =
      'https://pegma.dev/staff/support/ticket/?id=another-ticket';
    page.window.dispatchEvent(new Event('popstate'));
    old.resolve({ body: handoff() });
    await page.until(() => page.node('staff-ticket-detail').hidden);
    await page.drain();
    expect(page.node('staff-handoff-list').textContent).toBe('');
    expect(page.node('staff-ticket-heading').textContent).toBe('Staff ticket');
  });

  it.each(['customer', 'staff'] as const)(
    'does not revive the %s page from a late command conflict after pagehide',
    async (surface) => {
      const pending = browserGate<BrowserResponse>();
      const page = supportBrowser(surface, (call) => {
        if (call.path === '/api/identity/session') return { body: account };
        if (call.method === 'POST') return pending.promise;
        if (call.path.endsWith('/handoff')) return { body: handoff() };
        return { body: surface === 'customer' ? customerView() : staffView() };
      });
      const detailId =
        surface === 'customer' ? 'ticket-detail' : 'staff-ticket-detail';
      const actionId =
        surface === 'customer' ? 'request-person' : 'action-take-over';
      await page.until(() => !page.node(detailId).hidden);
      page.node(actionId).fire('click');
      await page.until(() => page.calls.some((call) => call.method === 'POST'));
      page.window.dispatchEvent(new Event('pagehide'));
      const readCount = page.calls.filter(
        (call) => call.method === 'GET',
      ).length;
      pending.resolve({ status: 409, body: { error: 'conflict' } });
      await page.drain();
      expect(page.node(detailId).hidden).toBe(true);
      expect(page.calls.filter((call) => call.method === 'GET')).toHaveLength(
        readCount,
      );
    },
  );

  it('preserves a newer compose draft while the prior public reply is awaiting acknowledgement', async () => {
    const reply = browserGate<BrowserResponse>();
    const page = supportBrowser('staff', (call) => {
      if (call.path === '/api/identity/session') return { body: account };
      if (call.path.endsWith('/handoff')) return { body: handoff() };
      return call.path.endsWith('/messages')
        ? reply.promise
        : { body: staffView() };
    });
    await page.until(() => !page.node('staff-ticket-detail').hidden);
    page.mode('public');
    page.node('compose-body').value = 'First fictional reply';
    page.node('staff-compose-form').fire('submit');
    await page.until(() => posts(page.calls, '/messages').length === 1);
    page.node('compose-body').value = 'New unsent draft';
    reply.resolve({ body: staffView(8) });
    await page.until(
      () =>
        page.node('staff-ticket-status').textContent === 'Public reply sent.',
    );
    expect(page.node('compose-body').value).toBe('New unsent draft');
    expect(page.node('staff-compose-form').resets).toBe(0);
  });

  it('shows queue handling separately and clears its private rows on lost staff access', async () => {
    let denied = false;
    const page = supportBrowser('queue', (call) => {
      if (call.path === '/api/identity/account') return { body: account };
      return denied
        ? { status: 401, body: { error: 'denied' } }
        : {
            body: {
              items: [
                {
                  ticketId: id,
                  status: 'open',
                  handling: 'human-active',
                  priority: 'normal',
                  requesterAssociation: 'authenticated',
                  updatedAt: '2026-11-09T12:00:00.000Z',
                },
              ],
              csrfToken: account.csrfToken,
            },
          };
    });
    await page.until(() => !page.node('staff-queue-panel').hidden);
    expect(page.node('queue-list').textContent).toContain(
      'Human support active',
    );
    denied = true;
    page.node('queue-filters').fire('submit');
    await page.until(() => !page.node('staff-queue-signed-out').hidden);
    expect(page.node('queue-list').textContent).toBe('');
    expect(page.node('staff-queue-email').textContent).toBe('');
  });
});

const surfaces = ['customer', 'staff'] as const;
function controls(surface: (typeof surfaces)[number]) {
  return surface === 'customer'
    ? {
        detail: 'ticket-detail',
        status: 'ticket-status',
        action: 'request-person',
        reload: 'ticket-reload',
        suffix: '/request-person',
        messages: 'message-list',
        draft: 'reply-body',
      }
    : {
        detail: 'staff-ticket-detail',
        status: 'staff-ticket-status',
        action: 'action-take-over',
        reload: 'staff-ticket-reload',
        suffix: '/take-over',
        messages: 'staff-message-list',
        draft: 'compose-body',
      };
}
function ticketFor(surface: (typeof surfaces)[number], accepted = false) {
  return surface === 'customer'
    ? customerView(accepted ? 'human-pending' : 'assistant')
    : staffView(
        accepted ? 8 : 7,
        accepted ? { state: 'human-active', generation: 1 } : undefined,
      );
}

describe('denied acknowledgement packet recovery', () => {
  async function loaded(
    page: ReturnType<typeof supportBrowser>,
    surface: (typeof surfaces)[number],
  ) {
    const ids = controls(surface);
    await page.until(
      () =>
        !page.node(ids.detail).hidden &&
        !page.node(ids.action).disabled &&
        page.node(ids.status).textContent === 'Ticket loaded.' &&
        (surface !== 'staff' ||
          page.node('staff-handoff-status').textContent ===
            'Private handoff loaded.'),
    );
    await page.tick();
  }
  async function denied(
    page: ReturnType<typeof supportBrowser>,
    surface: (typeof surfaces)[number],
  ) {
    const ids = controls(surface);
    await page.until(
      () =>
        page.node(ids.detail).hidden &&
        (page.node(ids.status).textContent.includes('Sign in, then reload') ||
          page
            .node(ids.status)
            .textContent.includes('access could not be confirmed')),
    );
    await page.tick();
  }

  it.each(
    surfaces.flatMap((surface) =>
      [401, 403].map((status) => ({ surface, status })),
    ),
  )(
    'recovers the exact $surface packet after a $status ACK denial only after the same principal regains a current view',
    async ({ surface, status }) => {
      const ids = controls(surface);
      const freshRead = browserGate<BrowserResponse>();
      let phase = 'initial';
      let identity = account;
      let attempts = 0;
      let readStarted = false;
      let view = ticketFor(surface);
      const page = supportBrowser(surface, (call) => {
        if (call.path === '/api/identity/session') return { body: identity };
        if (call.path.endsWith(ids.suffix)) {
          if (++attempts === 1) {
            // Model the real API's committed-command / denied-ACK boundary;
            // separate Memory and native-D1 API tests prove persistence/replay.
            view = ticketFor(surface, true);
            phase = 'denied';
            return { status, body: { error: 'closing_authority_denied' } };
          }
          return { body: { ...view, csrfToken: identity.csrfToken } };
        }
        if (phase === 'denied') return { status, body: {} };
        if (phase === 'unavailable') return { status: 503, body: {} };
        if (call.path.endsWith('/handoff'))
          return { body: { ...handoff(), csrfToken: identity.csrfToken } };
        if (phase === 'recover') {
          readStarted = true;
          return freshRead.promise;
        }
        return { body: { ...view, csrfToken: identity.csrfToken } };
      });
      try {
        await loaded(page, surface);
        page.node(ids.draft).value = 'LOCAL_UNSENT_DRAFT';
        page.mode('internal');
        page.node(ids.action).fire('click');
        await denied(page, surface);
        const original = posts(page.calls, ids.suffix)[0]!;
        expect(original.body).toEqual(expect.any(String));
        expect(page.node(ids.messages).textContent).toBe('');
        expect(page.node(ids.action).disabled).toBe(true);
        if (surface === 'staff') {
          expect(page.node('staff-handoff-list').textContent).toBe('');
          expect(page.node('staff-ticket-requester').textContent).toBe('');
        }
        const deniedCalls = page.calls.length;
        page.node(ids.action).dispatchEvent(new Event('click'));
        page
          .node(surface === 'customer' ? 'reply-form' : 'staff-compose-form')
          .fire('submit');
        if (surface === 'staff')
          page.node('action-assign').dispatchEvent(new Event('click'));
        await page.tick();
        expect(page.calls).toHaveLength(deniedCalls);

        // A denied reload must not erase the unresolved command either.
        page.node(ids.reload).fire('click');
        await denied(page, surface);
        expect(page.node(ids.detail).hidden).toBe(true);
        expect(posts(page.calls, ids.suffix)).toHaveLength(1);

        // Fresh credentials alone are insufficient: the current ticket read
        // must also succeed before any retry can be sent.
        identity = { ...account, csrfToken: 'synthetic-restored-session' };
        phase = 'unavailable';
        page.node(ids.reload).fire('click');
        await page.until(() =>
          page.node(ids.status).textContent.includes('Could not confirm'),
        );
        await page.tick();
        expect(page.node(ids.action).disabled).toBe(true);
        const unavailableCalls = page.calls.length;
        page.node(ids.action).dispatchEvent(new Event('click'));
        await page.tick();
        expect(page.calls).toHaveLength(unavailableCalls);

        phase = 'recover';
        page.node(ids.reload).fire('click');
        await page.until(() => readStarted);
        expect(page.node(ids.action).disabled).toBe(true);
        const pendingReadCalls = page.calls.length;
        page.node(ids.action).dispatchEvent(new Event('click'));
        await page.tick();
        expect(page.calls).toHaveLength(pendingReadCalls);
        phase = 'restored';
        freshRead.resolve({
          body: { ...view, csrfToken: identity.csrfToken },
        });
        await page.until(() => !page.node(ids.detail).hidden);
        await page.tick();
        expect(page.node(ids.detail).hidden).toBe(false);
        expect(page.node(ids.action).disabled).toBe(false);
        expect(page.node(ids.action).textContent).toContain('Retry');
        expect(page.node(ids.draft).value).toBe('LOCAL_UNSENT_DRAFT');
        page.node(ids.action).fire('click');
        await page.until(() => posts(page.calls, ids.suffix).length === 2);
        const success =
          surface === 'customer'
            ? 'Human support requested. Your unsent reply is kept.'
            : 'Take over accepted. Assignment is unchanged.';
        await page.until(() => page.node(ids.status).textContent === success);
        await page.tick();
        const sent = posts(page.calls, ids.suffix);
        expect(sent).toHaveLength(2);
        expect(sent[1]?.body).toBe(original.body);
        expect(sent[1]?.headers.get('X-Pegma-CSRF')).toBe(identity.csrfToken);
        expect(original.headers.get('X-Pegma-CSRF')).toBe(account.csrfToken);
        if (surface === 'staff')
          expect(JSON.parse(sent[1]?.body ?? '{}')).toMatchObject({
            expectedRevision: 7,
            expectedHandlingGeneration: 0,
          });
        expect(page.node(ids.status).textContent).toBe(success);
        expect(page.node(ids.status).textContent).not.toContain(
          'refresh failed',
        );
        expect(page.node(ids.detail).hidden).toBe(false);
        if (surface === 'staff') {
          expect(page.node('staff-handoff-status').textContent).toBe(
            'Private handoff loaded.',
          );
          expect(page.node('staff-handoff-list').textContent).toContain(
            'SYNTHETIC_PRIVATE_HANDOFF',
          );
        }
      } finally {
        freshRead.resolve({ body: view });
        page.dispose();
      }
    },
  );

  it.each(
    surfaces.flatMap((surface) =>
      (surface === 'staff' ? ['ticket', 'handoff'] : ['ticket']).flatMap(
        (read) => [401, 403].map((status) => ({ surface, read, status })),
      ),
    ),
  )(
    'retains an unknown $surface packet through a denied $read reload ($status)',
    async ({ surface, read, status }) => {
      const ids = controls(surface);
      let phase = 'initial';
      let attempts = 0;
      const page = supportBrowser(surface, (call) => {
        if (call.path === '/api/identity/session') return { body: account };
        if (call.path.endsWith(ids.suffix)) {
          if (++attempts === 1) return { status: 503, body: {} };
          return { body: ticketFor(surface, true) };
        }
        const isHandoff = call.path.endsWith('/handoff');
        if (phase === 'denied' && (read === 'handoff') === isHandoff)
          return { status, body: {} };
        if (isHandoff) return { body: handoff() };
        return { body: ticketFor(surface, phase !== 'initial') };
      });
      await loaded(page, surface);
      page.node(ids.action).fire('click');
      await page.until(() => posts(page.calls, ids.suffix).length === 1);
      await page.until(() =>
        page.node(ids.status).textContent.includes('Could not confirm'),
      );
      await page.tick();
      const original = posts(page.calls, ids.suffix)[0]?.body;
      expect(original).toEqual(expect.any(String));
      phase = 'denied';
      page.node(ids.reload).fire('click');
      await denied(page, surface);
      expect(page.node(ids.detail).hidden).toBe(true);
      expect(page.node(ids.messages).textContent).toBe('');
      expect(page.node(ids.action).disabled).toBe(true);
      if (surface === 'staff')
        expect(page.node('staff-handoff-list').textContent).toBe('');
      phase = 'restored';
      page.node(ids.reload).fire('click');
      await page.until(() => !page.node(ids.detail).hidden);
      await page.tick();
      expect(page.node(ids.action).disabled).toBe(false);
      expect(page.node(ids.action).textContent).toContain('Retry');
      page.node(ids.action).fire('click');
      await page.until(() => posts(page.calls, ids.suffix).length === 2);
      await page.tick();
      expect(posts(page.calls, ids.suffix)).toHaveLength(2);
      expect(posts(page.calls, ids.suffix)[1]?.body).toBe(original);
    },
  );

  it.each(surfaces)(
    'forgets the denied $surface packet when a different principal is observed and never revives it for the old principal',
    async (surface) => {
      const ids = controls(surface);
      let identity = account;
      const page = supportBrowser(surface, (call) => {
        if (call.path === '/api/identity/session') return { body: identity };
        if (call.path.endsWith(ids.suffix)) return { status: 403, body: {} };
        return {
          body: {
            ...(call.path.endsWith('/handoff')
              ? handoff()
              : ticketFor(surface)),
            csrfToken: identity.csrfToken,
          },
        };
      });
      await loaded(page, surface);
      page.node(ids.action).fire('click');
      await page.until(() => posts(page.calls, ids.suffix).length === 1);
      await denied(page, surface);
      const original = posts(page.calls, ids.suffix)[0]?.body;
      expect(original).toEqual(expect.any(String));
      identity = {
        account: { ...account.account, subject: 'synthetic-other-principal' },
        csrfToken: 'synthetic-other-session',
      };
      page.node(ids.reload).fire('click');
      await page.until(
        () => page.node(ids.status).textContent !== 'Loading ticket…',
      );
      await page.tick();
      // A changed identity may require a second explicit current-view read.
      if (page.node(ids.detail).hidden) {
        page.node(ids.reload).fire('click');
        await page.until(
          () => page.node(ids.status).textContent !== 'Loading ticket…',
        );
        await page.tick();
      }
      await loaded(page, surface);
      expect(page.node(ids.detail).hidden).toBe(false);
      expect(page.node(ids.action).textContent).not.toContain('Retry');
      expect(posts(page.calls, ids.suffix)).toHaveLength(1);
      page.node(ids.action).fire('click');
      await page.until(() => posts(page.calls, ids.suffix).length === 2);
      await denied(page, surface);
      expect(posts(page.calls, ids.suffix)).toHaveLength(2);
      expect(posts(page.calls, ids.suffix)[1]?.body).not.toBe(original);
      expect(
        posts(page.calls, ids.suffix)[1]?.headers.get('X-Pegma-CSRF'),
      ).toBe(identity.csrfToken);
      identity = account;
      page.node(ids.reload).fire('click');
      await page.until(
        () => page.node(ids.status).textContent !== 'Loading ticket…',
      );
      await page.tick();
      if (page.node(ids.detail).hidden) {
        page.node(ids.reload).fire('click');
        await page.until(
          () => page.node(ids.status).textContent !== 'Loading ticket…',
        );
        await page.tick();
      }
      await loaded(page, surface);
      expect(page.node(ids.action).textContent).not.toContain('Retry');
      page.node(ids.action).fire('click');
      await page.until(() => posts(page.calls, ids.suffix).length === 3);
      await denied(page, surface);
      expect(posts(page.calls, ids.suffix)).toHaveLength(3);
      expect(posts(page.calls, ids.suffix)[2]?.body).not.toBe(original);
    },
  );

  it.each(surfaces)(
    'forgets the denied $surface packet after the ticket is deleted (404)',
    async (surface) => {
      const ids = controls(surface);
      let deleted = false;
      const page = supportBrowser(surface, (call) => {
        if (call.path === '/api/identity/session') return { body: account };
        if (call.path.endsWith(ids.suffix)) return { status: 403, body: {} };
        if (deleted) return { status: 404, body: {} };
        return {
          body: call.path.endsWith('/handoff') ? handoff() : ticketFor(surface),
        };
      });
      await loaded(page, surface);
      page.node(ids.action).fire('click');
      await page.until(() => posts(page.calls, ids.suffix).length === 1);
      await denied(page, surface);
      const original = posts(page.calls, ids.suffix)[0]?.body;
      expect(original).toEqual(expect.any(String));
      deleted = true;
      page.node(ids.reload).fire('click');
      await page.until(
        () => page.node(ids.status).textContent !== 'Loading ticket…',
      );
      await page.tick();
      expect(page.node(ids.status).textContent).toBe('Ticket not found.');
      expect(page.node(ids.detail).hidden).toBe(true);
      expect(page.node(ids.action).disabled).toBe(true);
      deleted = false;
      page.node(ids.reload).fire('click');
      await page.until(
        () => page.node(ids.status).textContent !== 'Loading ticket…',
      );
      await page.tick();
      await loaded(page, surface);
      expect(page.node(ids.action).textContent).not.toContain('Retry');
      page.node(ids.action).fire('click');
      await page.until(() => posts(page.calls, ids.suffix).length === 2);
      await denied(page, surface);
      expect(posts(page.calls, ids.suffix)).toHaveLength(2);
      expect(posts(page.calls, ids.suffix)[1]?.body).not.toBe(original);
    },
  );
});

describe('current-input recovery, retry and lifecycle boundaries', () => {
  it.each(
    surfaces.flatMap((surface) =>
      [401, 403, 503].map((status) => ({ surface, status })),
    ),
  )(
    'ignores an older $surface reload rejection after a newer successful view ($status)',
    async ({ surface, status }) => {
      const old = browserGate<BrowserResponse>();
      const ids = controls(surface);
      let reads = 0;
      const page = supportBrowser(surface, (call) => {
        if (call.path === '/api/identity/session') return { body: account };
        if (call.path.endsWith('/handoff')) return { body: handoff() };
        if (++reads === 1) return old.promise;
        const view = ticketFor(surface);
        view.ticket.subject = 'CURRENT_VIEW';
        return { body: view };
      });
      try {
        await page.until(() => reads === 1);
        page.node(ids.reload).fire('click');
        await page.until(() => !page.node(ids.detail).hidden);
        old.resolve({ status, body: { error: 'old_denial' } });
        await page.tick();
        expect(page.node(ids.detail).hidden).toBe(false);
        expect(
          page.node(
            surface === 'customer' ? 'ticket-heading' : 'staff-ticket-heading',
          ).textContent,
        ).toContain('CURRENT_VIEW');
        expect(page.node(ids.status).textContent).toBe('Ticket loaded.');
        expect(
          page.calls.some((call) => call.path === '/api/identity/account'),
        ).toBe(false);
      } finally {
        old.resolve({ status, body: {} });
        page.dispose();
      }
    },
  );

  it.each(['reply', 'compose', 'patch'] as const)(
    'ignores a late legacy %s rejection after page invalidation',
    async (kind) => {
      const old = browserGate<BrowserResponse>();
      const surface = kind === 'reply' ? 'customer' : 'staff';
      const ids = controls(surface);
      const page = supportBrowser(surface, (call) => {
        if (call.path === '/api/identity/session') return { body: account };
        if (call.path.endsWith('/handoff')) return { body: handoff() };
        if (call.method !== 'GET') return old.promise;
        return { body: ticketFor(surface) };
      });
      try {
        await page.until(() => !page.node(ids.detail).hidden);
        page.mode('public');
        page.node(ids.draft).value = 'LOCAL_DRAFT';
        if (kind === 'patch') page.node('action-assign').fire('click');
        else
          page
            .node(kind === 'reply' ? 'reply-form' : 'staff-compose-form')
            .fire('submit');
        await page.until(() =>
          page.calls.some((call) => call.method !== 'GET'),
        );
        page.window.dispatchEvent(new Event('pagehide'));
        const neutral = page.node(ids.status).textContent;
        old.resolve({ status: 401, body: { error: 'old_denial' } });
        await page.tick();
        expect(page.node(ids.status).textContent).toBe(neutral);
        expect(neutral).toContain('view cleared');
        expect(neutral).not.toContain('loaded');
        expect(page.node(ids.messages).textContent).toBe('');
        expect(page.node(ids.draft).value).toBe('LOCAL_DRAFT');
      } finally {
        old.resolve({ body: {} });
        page.dispose();
      }
    },
  );

  it('reads current customer state after a historical request-person acknowledgement', async () => {
    let view = customerView();
    let attempts = 0;
    const current = customerView('human-active', 'closed');
    current.ticket.subject = 'CURRENT_CLOSED_TICKET';
    const page = supportBrowser('customer', (call) => {
      if (call.path === '/api/identity/session') return { body: account };
      if (call.path.endsWith('/request-person')) {
        if (++attempts === 1) throw new TypeError('Lost acknowledgement');
        view = current;
        return { body: customerView('human-pending', 'waiting_on_support') };
      }
      return { body: view };
    });
    await page.until(() => !page.node('ticket-detail').hidden);
    page.node('reply-body').value = 'UNSENT';
    page.node('request-person').fire('click');
    await page.until(() =>
      page.node('ticket-status').textContent.includes('Could not confirm'),
    );
    page.node('request-person').fire('click');
    await page.until(() =>
      page.node('ticket-status').textContent.includes('requested.'),
    );
    expect(page.node('ticket-heading').textContent).toContain(
      'CURRENT_CLOSED_TICKET',
    );
    expect(page.node('ticket-meta').textContent).toContain('closed');
    expect(page.node('ticket-meta').textContent).not.toContain(
      'waiting_on_support',
    );
    expect(page.node('reply-body').value).toBe('UNSENT');
    const sent = posts(page.calls, '/request-person');
    expect(sent[0]?.body).toBe(sent[1]?.body);
    expect(
      page.calls
        .slice(page.calls.lastIndexOf(sent[1]!))
        .some(
          (call) =>
            call.method === 'GET' && call.path === `/api/support/tickets/${id}`,
        ),
    ).toBe(true);
  });

  it.each(surfaces)(
    'reports accepted $surface command separately from a failed current-state refresh',
    async (surface) => {
      const ids = controls(surface);
      let accepted = false;
      const page = supportBrowser(surface, (call) => {
        if (call.path === '/api/identity/session') return { body: account };
        if (call.path.endsWith('/handoff')) return { body: handoff() };
        if (call.path.endsWith(ids.suffix)) {
          accepted = true;
          return { body: ticketFor(surface, true) };
        }
        return accepted
          ? { status: 503, body: {} }
          : { body: ticketFor(surface) };
      });
      await page.until(() => !page.node(ids.detail).hidden);
      page.node(ids.action).fire('click');
      await page.until(() =>
        page
          .node(ids.status)
          .textContent.includes('accepted. Current ticket refresh failed'),
      );
      expect(page.node(ids.status).textContent).not.toContain('Retry the same');
      expect(page.node(ids.detail).hidden).toBe(true);
      expect(posts(page.calls, ids.suffix)).toHaveLength(1);
    },
  );

  it.each(
    surfaces.flatMap((surface) =>
      ['seconds', 'date'].map((format) => ({ surface, format })),
    ),
  )(
    'honors $format Retry-After for $surface without a premature identity probe or changed packet',
    async ({ surface, format }) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-10T05:00:00.000Z'));
      const ids = controls(surface);
      let attempts = 0;
      let view = ticketFor(surface);
      const page = supportBrowser(surface, (call) => {
        if (call.path === '/api/identity/session') return { body: account };
        if (call.path.endsWith('/handoff')) return { body: handoff() };
        if (call.path.endsWith(ids.suffix)) {
          if (++attempts === 1)
            return {
              status: 429,
              headers: {
                'Retry-After':
                  format === 'seconds'
                    ? '3'
                    : new Date(Date.now() + 3000).toUTCString(),
              },
              body: {},
            };
          view = ticketFor(surface, true);
          return { body: view };
        }
        return { body: view };
      });
      try {
        await page.until(() => !page.node(ids.detail).hidden);
        page.node(ids.action).fire('click');
        await page.until(() =>
          page.node(ids.status).textContent.includes('rate limited'),
        );
        const calls = page.calls.length;
        page.node(ids.action).fire('click');
        await page.tick();
        expect(page.calls).toHaveLength(calls);
        expect(page.node(ids.action).disabled).toBe(true);
        expect(page.node(ids.status).textContent).toContain('3 seconds');
        await vi.advanceTimersByTimeAsync(2999);
        page.node(ids.action).fire('click');
        await page.tick();
        expect(page.calls).toHaveLength(calls);
        expect(page.node(ids.action).disabled).toBe(true);
        await vi.advanceTimersByTimeAsync(1);
        expect(page.node(ids.action).disabled).toBe(false);
        page.node(ids.action).fire('click');
        await page.until(() => attempts === 2);
        await page.drain();
        const sent = posts(page.calls, ids.suffix);
        expect(sent).toHaveLength(2);
        expect(sent[0]?.body).toBe(sent[1]?.body);
      } finally {
        page.dispose();
      }
    },
  );

  it.each(surfaces)(
    'holds ordinary %s writes while an unknown human command remains unresolved, even after reload',
    async (surface) => {
      const ids = controls(surface);
      const page = supportBrowser(surface, (call) => {
        if (call.path === '/api/identity/session') return { body: account };
        if (call.path.endsWith('/handoff')) return { body: handoff() };
        if (call.path.endsWith(ids.suffix)) return { status: 503, body: {} };
        return { body: ticketFor(surface) };
      });
      await page.until(() => !page.node(ids.detail).hidden);
      page.node(ids.draft).value = 'UNSENT';
      page.mode('public');
      page.node(ids.action).fire('click');
      await page.until(() =>
        page.node(ids.status).textContent.includes('Could not confirm'),
      );
      expect(page.node(ids.detail).hidden).toBe(true);
      page.node(ids.reload).fire('click');
      await page.until(() => !page.node(ids.detail).hidden);
      if (surface === 'staff')
        await page.until(
          () =>
            page.node('staff-handoff-status').textContent ===
            'Private handoff loaded.',
        );
      await page.drain();
      const original = posts(page.calls, ids.suffix)[0]?.body;
      expect(original).toEqual(expect.any(String));
      const count = page.calls.length;
      page
        .node(surface === 'customer' ? 'reply-form' : 'staff-compose-form')
        .fire('submit');
      if (surface === 'staff') {
        expect(page.node('action-assign').disabled).toBe(true);
        // Exercise the actual handler even though a normal browser click is disabled.
        page
          .node('action-assign')
          .dispatchEvent(new Event('click', { cancelable: true }));
      }
      await page.tick();
      expect(page.calls).toHaveLength(count);
      expect(page.node(ids.draft).value).toBe('UNSENT');
      expect(page.node(ids.action).disabled).toBe(false);
      page.node(ids.action).fire('click');
      await page.until(
        () =>
          posts(page.calls, ids.suffix).length === 2 &&
          page.node(ids.status).textContent.includes('Could not confirm'),
      );
      expect(posts(page.calls, ids.suffix)[1]?.body).toBe(original);
      expect(page.node(ids.draft).value).toBe('UNSENT');
    },
  );

  it.each(['reply', 'compose', 'patch'] as const)(
    'clears an unknown legacy %s view and describes that action without an unrelated human retry',
    async (kind) => {
      const surface = kind === 'reply' ? 'customer' : 'staff';
      const ids = controls(surface);
      const page = supportBrowser(surface, (call) => {
        if (call.path === '/api/identity/session') return { body: account };
        if (call.path.endsWith('/handoff')) return { body: handoff() };
        return call.method === 'GET'
          ? { body: ticketFor(surface) }
          : { status: 503, body: {} };
      });
      await page.until(() => !page.node(ids.detail).hidden);
      page.mode('internal');
      page.node(ids.draft).value = 'UNSENT';
      if (kind === 'patch') page.node('action-assign').fire('click');
      else
        page
          .node(kind === 'reply' ? 'reply-form' : 'staff-compose-form')
          .fire('submit');
      await page.until(() =>
        page.node(ids.status).textContent.includes('Could not confirm'),
      );
      expect(page.node(ids.detail).hidden).toBe(true);
      expect(page.node(ids.messages).textContent).toBe('');
      expect(page.node(ids.status).textContent).not.toContain('same human');
      expect(page.node(ids.status).textContent).not.toContain('same take-over');
      expect(page.node(ids.status).textContent).toContain(
        kind === 'reply'
          ? 'reply'
          : kind === 'patch'
            ? 'action assign'
            : 'internal note',
      );
      expect(page.node(ids.draft).value).toBe('UNSENT');
    },
  );

  it.each(
    surfaces.flatMap((surface) =>
      ['fetch', 'body'].map((phase) => ({ surface, phase })),
    ),
  )(
    'bounds the complete $surface $phase wait and preserves the ambiguous human packet',
    async ({ surface, phase }) => {
      vi.useFakeTimers();
      const ids = controls(surface);
      const stalled = browserGate<BrowserResponse>();
      const body = browserGate<unknown>();
      let attempts = 0;
      let bodyStarted = false;
      let view = ticketFor(surface);
      const page = supportBrowser(surface, (call) => {
        if (call.path === '/api/identity/session') return { body: account };
        if (call.path.endsWith('/handoff')) return { body: handoff() };
        if (call.path.endsWith(ids.suffix)) {
          if (++attempts === 1)
            return phase === 'fetch'
              ? stalled.promise
              : {
                  body: {},
                  json: () => {
                    bodyStarted = true;
                    return body.promise;
                  },
                };
          view = ticketFor(surface, true);
          return { body: view };
        }
        return { body: view };
      });
      try {
        await page.until(() => !page.node(ids.detail).hidden);
        page.node(ids.draft).value = 'UNSENT';
        page.node(ids.action).fire('click');
        await page.until(
          () => attempts === 1 && (phase === 'fetch' || bodyStarted),
        );
        const first = posts(page.calls, ids.suffix)[0]!;
        await vi.advanceTimersByTimeAsync(14_999);
        expect(page.node(ids.action).disabled).toBe(true);
        expect(first.signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await page.until(() =>
          page.node(ids.status).textContent.includes('request deadline'),
        );
        expect(first.signal?.aborted).toBe(true);
        expect(page.node(ids.action).disabled).toBe(false);
        expect(page.node(ids.detail).hidden).toBe(true);
        page.node(ids.action).fire('click');
        await page.until(() => attempts === 2);
        await page.drain();
        expect(posts(page.calls, ids.suffix)[1]?.body).toBe(first.body);
        expect(page.node(ids.draft).value).toBe('UNSENT');
      } finally {
        stalled.resolve({ body: {} });
        body.resolve({});
        page.dispose();
      }
    },
  );

  it.each(surfaces)(
    'lets explicit $surface Reload supersede a stalled mutation without an old finally unlocking the newer read',
    async (surface) => {
      const ids = controls(surface);
      const post = browserGate<BrowserResponse>();
      const fresh = browserGate<BrowserResponse>();
      let posted = false;
      let refreshing = false;
      const page = supportBrowser(surface, (call) => {
        if (call.path === '/api/identity/session') return { body: account };
        if (call.path.endsWith('/handoff')) return { body: handoff() };
        if (call.path.endsWith(ids.suffix)) {
          posted = true;
          return post.promise;
        }
        if (posted) {
          refreshing = true;
          return fresh.promise;
        }
        return { body: ticketFor(surface) };
      });
      try {
        await page.until(() => !page.node(ids.detail).hidden);
        page.node(ids.action).fire('click');
        await page.until(() => posted);
        page.node(ids.reload).fire('click');
        await page.until(() => refreshing);
        expect(posts(page.calls, ids.suffix)[0]?.signal?.aborted).toBe(true);
        post.resolve({ status: 401, body: {} });
        await page.tick();
        expect(page.node(ids.action).disabled).toBe(true);
        expect(page.node(ids.status).textContent).toBe('Loading ticket…');
        fresh.resolve({ body: ticketFor(surface) });
        await page.until(() => !page.node(ids.detail).hidden);
        await page.drain();
        expect(page.node(ids.action).disabled).toBe(false);
        expect(posts(page.calls, ids.suffix)).toHaveLength(1);
      } finally {
        post.resolve({ body: {} });
        fresh.resolve({ body: ticketFor(surface) });
        page.dispose();
      }
    },
  );

  it.each(surfaces)(
    'restores the $surface page with fresh GETs after pageshow while retaining an unresolved packet',
    async (surface) => {
      const ids = controls(surface);
      const page = supportBrowser(surface, (call) => {
        if (call.path === '/api/identity/session') return { body: account };
        if (call.path.endsWith('/handoff')) return { body: handoff() };
        return call.method === 'POST'
          ? { status: 503, body: {} }
          : { body: ticketFor(surface) };
      });
      await page.until(() => !page.node(ids.detail).hidden);
      page.node(ids.draft).value = 'LOCAL';
      page.node(ids.action).fire('click');
      await page.until(() =>
        page.node(ids.status).textContent.includes('Could not confirm'),
      );
      const original = posts(page.calls, ids.suffix)[0]?.body;
      page.window.dispatchEvent(new Event('pagehide'));
      expect(page.node(ids.status).textContent).toContain('view cleared');
      const getCount = page.calls.filter(
        (call) => call.method === 'GET',
      ).length;
      page.window.dispatchEvent(new Event('pageshow'));
      await page.until(() => !page.node(ids.detail).hidden);
      await page.drain();
      expect(
        page.calls.filter((call) => call.method === 'GET').length,
      ).toBeGreaterThan(getCount);
      expect(posts(page.calls, ids.suffix)).toHaveLength(1);
      page.node(ids.action).fire('click');
      await page.until(() => posts(page.calls, ids.suffix).length === 2);
      expect(posts(page.calls, ids.suffix)[1]?.body).toBe(original);
      expect(page.node(ids.draft).value).toBe('LOCAL');
    },
  );

  it.each(surfaces)(
    'uses an actual page reload after the $surface address changes instead of reading the old ticket',
    async (surface) => {
      const ids = controls(surface);
      const page = supportBrowser(surface, (call) => ({
        body:
          call.path === '/api/identity/session'
            ? account
            : call.path.endsWith('/handoff')
              ? handoff()
              : ticketFor(surface),
      }));
      await page.until(() => !page.node(ids.detail).hidden);
      page.window.location.href =
        'https://pegma.dev/feedback/ticket/?id=changed';
      page.window.dispatchEvent(new Event('popstate'));
      const count = page.calls.length;
      expect(page.node(ids.status).textContent).toContain('address changed');
      page.node(ids.reload).fire('click');
      await page.tick();
      expect(page.reloads).toBe(1);
      expect(page.calls).toHaveLength(count);
      expect(page.node(ids.detail).hidden).toBe(true);
    },
  );

  it.each(['empty', 'invalid-status'] as const)(
    'keeps a valid staff ticket visible for a %s handoff result',
    async (kind) => {
      const result =
        kind === 'empty'
          ? { handoff: [], csrfToken: account.csrfToken }
          : handoff();
      if (kind === 'invalid-status') result.handoff[0]!.status = 'completed';
      const page = supportBrowser('staff', (call) => ({
        body:
          call.path === '/api/identity/session'
            ? account
            : call.path.endsWith('/handoff')
              ? result
              : staffView(),
      }));
      await page.until(() =>
        page
          .node('staff-handoff-status')
          .textContent.includes(
            kind === 'empty' ? 'No handoff records' : 'unavailable',
          ),
      );
      expect(page.node('staff-ticket-detail').hidden).toBe(false);
      expect(page.node('staff-message-list').textContent).toContain(
        'SYNTHETIC_INTERNAL_NOTE',
      );
      expect(page.node('staff-handoff-list').textContent).toBe('');
    },
  );

  it.each(['human-pending', 'assistant', 'human-active'] as const)(
    'preserves the real SDK default human queue for %s and renders its admitted DTOs',
    async (state) => {
      const application = createSupportDeskApplication({
        store: createMemoryStore(),
        clock: { now: () => new Date().toISOString() },
        assistantHandlingEnabled: true,
      });
      const customer = resolveAccess(
        { principalId: 'synthetic-reader' },
        {
          version: 'browser-queue-fixture',
          defaults: [
            supportPermissions.create,
            supportPermissions.assistantStart,
          ],
        },
      );
      const staff = resolveAccess(
        { principalId: 'synthetic-operator' },
        {
          version: 'browser-queue-fixture',
          defaults: [supportPermissions.queueRead, supportPermissions.takeOver],
        },
      );
      const ticket = crypto.randomUUID();
      await application.createCustomerTicket(customer, {
        commandId: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        ticketId: ticket,
        messageId: crypto.randomUUID(),
        subject: 'Fictional queue case',
        body: 'Fictional guide request',
        ...(state === 'assistant'
          ? { initialHandling: 'assistant' as const }
          : {}),
      });
      if (state === 'human-active') {
        const view = await application.readStaffTicket(staff, ticket);
        await application.takeOverTicket(staff, {
          commandId: crypto.randomUUID(),
          correlationId: crypto.randomUUID(),
          ticketId: ticket,
          expectedRevision: view.ticket.revision,
          expectedHandlingGeneration: view.ticket.handling?.generation ?? 0,
        });
      }
      const result = await application.listStaffQueue(staff, {});
      if (state === 'assistant') {
        expect(result.items).toEqual([]);
        const all = await application.listStaffQueue(staff, {
          handling: 'all',
        });
        expect(all).toMatchObject({
          items: [
            expect.objectContaining({
              ticketId: ticket,
              handling: 'assistant',
            }),
          ],
        });
      } else {
        expect(result).toMatchObject({
          items: [
            expect.objectContaining({ ticketId: ticket, handling: state }),
          ],
        });
      }
      // Host HTTP preservation is independently exercised by support-human-control.test.ts.
      const page = supportBrowser('queue', (call) => ({
        body:
          call.path === '/api/identity/account'
            ? account
            : { items: result.items, csrfToken: account.csrfToken },
      }));
      await page.until(() => !page.node('staff-queue-panel').hidden);
      if (state === 'assistant') {
        expect(page.node('queue-list').textContent).toBe(
          'No tickets match these filters.',
        );
        expect(page.node('queue-list').textContent).not.toContain(
          'Assistant handling',
        );
        expect(page.node('queue-list').textContent).not.toContain(ticket);
      } else {
        expect(page.node('queue-list').textContent).toContain(
          state === 'human-active'
            ? 'Human support active'
            : 'Waiting for human support',
        );
      }
      for (const call of page.calls.filter((entry) =>
        entry.path.startsWith('/api/support/admin/queue'),
      ))
        expect(
          new URL(call.path, 'https://pegma.dev').searchParams.has('handling'),
        ).toBe(false);
      expect(page.node('queue-list').textContent).not.toContain(
        '[object Object]',
      );
    },
  );
});
