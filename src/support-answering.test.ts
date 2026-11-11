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
  };
}

describe('optional current customer answering browser entry', () => {
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

  it('retains the exact disclosed mode/IDs/URL after lost real SDK ACK and config OFF, while preserving a later draft', async () => {
    const { f, page, edit, reload } = await fixture();
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
    f.state.enabled = false;
    await reload();
    expect(page.node('assistant-choice').hidden).toBe(true);
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
    const { f, page, edit, switchActor } = await fixture();
    edit();
    page.node('assistant-preference').checked = true;
    f.state.loseAck = true;
    page.nativeSubmit('create-ticket');
    await until(() =>
      page.node('feedback-status').textContent.includes('Could not confirm ticket creation.'),
    );
    switchActor('peer');
    page.window.dispatchEvent(new Event('pagehide'));
    page.window.dispatchEvent(new Event('pageshow'));
    await until(() => page.node('feedback-status').textContent.includes('original account'));
    expect(page.node('feedback-signed-in').hidden).toBe(true);
    expect(page.node('feedback-email').textContent).toBe('');
    page.node('create-ticket').fire('submit');
    await delay(10);
    expect(page.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });
});
