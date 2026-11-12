import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { supportAnsweringFixture } from '../worker/src/support-answering-fixtures';
import { createSupportApi } from '../worker/src/support-api';
import { disposeSupportBrowsers, supportBrowser, type BrowserCall } from './test-support-browser';

afterEach(disposeSupportBrowsers);
async function until(predicate: () => boolean) {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await delay(1);
  }
  throw new Error('Actual answering browser/HTTP fixture did not reach its state.');
}
async function fixture() {
  const f = await supportAnsweringFixture();
  const api = createSupportApi({ ...f.runtime, logger: f.logger });
  let actor: 'owner' | 'peer' = 'owner';
  let capabilityFault: 'http' | 'network' | 'malformed' | 'missing-csrf' | 'foreign-csrf' | 'unauthenticated' | 'forbidden' | null = null;
  const page = supportBrowser('create', async (call: BrowserCall) => {
    if (call.path === '/api/identity/account') {
      // Browser transport fixture only; the mutation handlers still validate
      // the actual cookie, CSRF, live Identity and roles on every request.
      const user = await f.human.identity.getUser(f.human.principals[actor]);
      if (user === null) throw new Error('The actual browser fixture account is missing.');
      return {
        body: {
          account: { subject: user.principalId, email: user.email },
          csrfToken: f.human.csrf.get(actor),
        },
      };
    }
    if (call.path === '/api/support/assistant/capability' && capabilityFault !== null) {
      if (capabilityFault === 'network')
        throw new Error('Fictional private capability failure');
      if (capabilityFault === 'unauthenticated' || capabilityFault === 'forbidden')
        return { status: capabilityFault === 'unauthenticated' ? 401 : 403, body: { error: 'Fictional current authority denial' } };
      if (capabilityFault === 'missing-csrf' || capabilityFault === 'foreign-csrf')
        return { body: { enabled: true, disclosureVersion: 'pegma-support-answering-1',
          ...(capabilityFault === 'foreign-csrf' ? { csrfToken: 'fictional-foreign-csrf' } : {}) } };
      return capabilityFault === 'http'
        ? { status: 503, body: { error: 'Fictional private capability failure' } }
        : { body: { enabled: 'malformed', csrfToken: f.human.csrf.get(actor), detail: 'Fictional private capability failure' } };
    }
    const headers = new Headers(call.headers);
    headers.set('Cookie', f.human.cookies.get(actor)!);
    headers.set('Origin', 'https://pegma.dev');
    headers.set('Sec-Fetch-Site', 'same-origin');
    const request = new Request('https://pegma.dev' + call.path, {
      method: call.method,
      headers,
      ...(call.body === undefined ? {} : { body: call.body }),
    });
    const response = call.path.startsWith('/api/support/assistant/')
      ? await f.ingress()(request)
      : await api(request);
    return { status: response.status, body: await response.json(), headers: response.headers };
  });
  await until(
    () =>
      !page.node('feedback-signed-in').hidden &&
      !page.node('create-ticket').querySelector('button')!.disabled,
  );
  const edit = () => {
    page.node('ticket-subject').value = 'Fictional question';
    page.node('ticket-body').value = 'Fictional original text';
    page.node('ticket-category').value = 'question';
  };
  const reload = async () => {
    page.window.dispatchEvent(new Event('pagehide'));
    page.window.dispatchEvent(new Event('pageshow'));
    await until(
      () =>
        !page.node('feedback-signed-in').hidden &&
        !page.node('create-ticket').querySelector('button')!.disabled,
    );
  };
  return {
    f,
    page,
    edit,
    reload,
    switchActor(value: typeof actor) {
      actor = value;
    },
    capabilityFault(value: typeof capabilityFault) {
      capabilityFault = value;
    },
  };
}

describe('optional current customer answering browser entry', () => {
  it('clears an unsubmitted AI choice before another account can create a new ticket', async () => {
    const { f, page, edit, reload, switchActor } = await fixture();
    page.node('assistant-preference').checked = true;
    switchActor('peer');
    await reload();
    expect(page.node('assistant-choice').hidden).toBe(false);
    expect(page.node('assistant-preference').checked).toBe(false);
    edit();
    page.nativeSubmit('create-ticket');
    await until(() => page.node('feedback-status').textContent.includes('Ticket created.'));
    const posts = page.calls.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.path).toBe('/api/support/tickets');
    expect(JSON.parse(posts[0]!.body!)).not.toHaveProperty('preference');
    expect(f.state.calls).toBe(0);
    expect(f.state.keys).toBe(0);
  });

  it.each(['http', 'network', 'malformed', 'missing-csrf', 'foreign-csrf'] as const)(
    'explains a capability %s failure while keeping authenticated human feedback available',
    async (fault) => {
      const { f, page, edit, reload, capabilityFault } = await fixture();
      capabilityFault(fault);
      await reload();
      const status = page.document.querySelector('#assistant-status');
      expect(status?.textContent ?? '').toContain('AI assistance is temporarily unavailable.');
      expect(status?.hidden).toBe(false);
      expect(status?.attributes.get('role')).toBe('status');
      expect(status?.attributes.get('aria-live')).toBe('polite');
      expect(status?.textContent).not.toContain('Fictional private');
      expect(page.node('assistant-choice').hidden).toBe(true);
      edit();
      page.nativeSubmit('create-ticket');
      await until(() => page.node('feedback-status').textContent.includes('Ticket created.'));
      expect(page.calls.filter((call) => call.method === 'POST').map((call) => call.path)).toEqual(['/api/support/tickets']);
      expect(f.state.calls).toBe(0);
      expect(f.state.keys).toBe(0);
    },
  );

  it('treats the rendered disclosure dataset as the displayed version and holds a mismatch', async () => {
    const { page, reload } = await fixture();
    expect(page.node('assistant-choice').dataset.disclosureVersion).toBe(
      page.node('assistant-choice').attributes.get('data-disclosure-version'),
    );
    page.node('assistant-choice').dataset.disclosureVersion = 'fictional-new-disclosure';
    await reload();
    expect(page.node('assistant-choice').hidden).toBe(true);
    expect(page.document.querySelector('#assistant-status')?.textContent ?? '').toContain('AI assistance is temporarily unavailable.');
    expect(page.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('keeps a normally disabled assistant separate from a capability failure', async () => {
    const { f, page, reload } = await fixture();
    f.state.enabled = false;
    await reload();
    expect(page.node('assistant-choice').hidden).toBe(true);
    expect(page.document.querySelector('#assistant-status')?.textContent ?? '').toBe('');
    expect(page.node('create-ticket').querySelector('button')!.disabled).toBe(false);
  });

  it.each(['unauthenticated', 'forbidden'] as const)(
    'keeps capability %s denials outside the human feedback fallback',
    async (fault) => {
      const { page, capabilityFault } = await fixture();
      capabilityFault(fault);
      page.window.dispatchEvent(new Event('pagehide'));
      page.window.dispatchEvent(new Event('pageshow'));
      await until(() => page.node('feedback-status').textContent.includes(
        fault === 'unauthenticated' ? 'Sign in, then reload' : 'Current account access could not be confirmed',
      ));
      expect(page.node('feedback-signed-in').hidden).toBe(true);
      expect(page.node('assistant-status').hidden).toBe(true);
      page.node('create-ticket').fire('submit');
      await page.drain();
      expect(page.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    },
  );

  it('requires an explicit unchecked disclosure choice and leaves an ordinary packet on its original route', async () => {
    const { f, page, edit } = await fixture();
    expect(page.node('assistant-choice').hidden).toBe(false);
    expect(page.node('assistant-preference').checked).toBe(false);
    edit();
    page.nativeSubmit('create-ticket');
    await until(() => page.node('feedback-status').textContent.includes('Ticket created.'));
    const posts = page.calls.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.path).toBe('/api/support/tickets');
    expect(JSON.parse(posts[0]!.body!)).not.toHaveProperty('preference');
    expect(f.state.calls).toBe(0);
    expect(f.state.keys).toBe(0);
  });

  it.each(['config OFF', 'capability outage'] as const)('retains the exact disclosed mode/IDs/URL after lost real SDK ACK and %s, while preserving a later draft', async (mode) => {
    const { f, page, edit, reload, capabilityFault } = await fixture();
    edit();
    page.node('assistant-preference').checked = true;
    f.state.loseAck = true;
    page.nativeSubmit('create-ticket');
    await until(() =>
      page.node('feedback-status').textContent.includes('Could not confirm ticket creation.'),
    );
    const first = page.calls.find((call) => call.method === 'POST')!;
    expect(first.path).toBe('/api/support/assistant/tickets');
    const original = JSON.parse(first.body!);
    expect(original).toMatchObject({
      preference: 'assistant_if_available',
      disclosureVersion: 'pegma-support-answering-1',
    });
    page.node('ticket-body').value = 'Fictional separate later draft';
    if (mode === 'config OFF') f.state.enabled = false;
    else capabilityFault('http');
    await reload();
    expect(page.node('assistant-choice').hidden).toBe(true);
    if (mode === 'capability outage')
      expect(page.node('assistant-status').textContent).toContain('Retry the original ticket request');
    page.nativeSubmit('create-ticket');
    await until(() => page.node('feedback-status').textContent.includes('Ticket created.'));
    const posts = page.calls.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[1]!.path).toBe(first.path);
    expect(posts[1]!.body).toBe(first.body);
    expect(page.node('ticket-body').value).toBe('Fictional separate later draft');
    expect(page.node('assistant-preference').checked).toBe(false);
    const rows = await f.human.rows(original.command.ticketId);
    expect(rows.filter((row) => row.kind === 'ticket')).toHaveLength(1);
    expect(rows.filter((row) => row.kind === 'message')).toHaveLength(1);
    expect(f.state.calls).toBe(0);
    expect(f.state.keys).toBe(0);
  });

  it('does not expose or replay an unknown original-actor packet under a different current account', async () => {
    const { f, page, edit, reload, switchActor } = await fixture();
    edit();
    page.node('assistant-preference').checked = true;
    f.state.loseAck = true;
    page.nativeSubmit('create-ticket');
    await until(() =>
      page.node('feedback-status').textContent.includes('Could not confirm ticket creation.'),
    );
    const original = page.calls.find((call) => call.method === 'POST')!;
    switchActor('peer');
    page.window.dispatchEvent(new Event('pagehide'));
    page.window.dispatchEvent(new Event('pageshow'));
    await until(() => page.node('feedback-status').textContent.includes('original account'));
    expect(page.node('feedback-signed-in').hidden).toBe(true);
    expect(page.node('feedback-email').textContent).toBe('');
    page.node('create-ticket').fire('submit');
    await delay(10);
    expect(page.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    switchActor('owner');
    await reload();
    expect(page.node('assistant-preference').checked).toBe(false);
    page.nativeSubmit('create-ticket');
    await until(() => page.node('feedback-status').textContent.includes('Ticket created.'));
    const posts = page.calls.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[1]!.path).toBe(original.path);
    expect(posts[1]!.body).toBe(original.body);
    const rows = await f.human.rows(JSON.parse(original.body!).command.ticketId);
    expect(rows.filter((row) => row.kind === 'ticket')).toHaveLength(1);
    expect(rows.filter((row) => row.kind === 'message')).toHaveLength(1);
    expect(f.state.calls).toBe(0);
  });
});
