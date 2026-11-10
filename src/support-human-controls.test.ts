import { describe, expect, it } from 'vitest';
import {
  browserGate,
  supportBrowser,
  type BrowserCall,
  type BrowserResponse,
} from './test-support-browser';

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
    const page = supportBrowser('customer', (call) => {
      if (call.path === '/api/identity/account') return { body: account };
      if (call.path.endsWith('/request-person')) {
        ++attempts;
        return attempts === 1
          ? lost.promise
          : { body: customerView('human-pending') };
      }
      return { body: customerView() };
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
          call.path === '/api/identity/account' ? account : customerView(state),
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
      if (call.path === '/api/identity/account') return { body: account };
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
        if (call.path === '/api/identity/account') return { body: account };
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
      if (call.path === '/api/identity/account')
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
      body: call.path === '/api/identity/account' ? account : view,
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
      if (call.path === '/api/identity/account') return { body: account };
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
      if (call.path === '/api/identity/account') return { body: account };
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
        if (call.path === '/api/identity/account')
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
      if (call.path === '/api/identity/account') return { body: account };
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
        call.path === '/api/identity/account'
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
        if (call.path === '/api/identity/account') return { body: account };
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
          call.path === '/api/identity/account'
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
        if (call.path === '/api/identity/account') return { body: account };
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
      if (call.path === '/api/identity/account') return { body: account };
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
      if (call.path === '/api/identity/account') return { body: account };
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
        if (call.path === '/api/identity/account') return { body: account };
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
      if (call.path === '/api/identity/account') return { body: account };
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
