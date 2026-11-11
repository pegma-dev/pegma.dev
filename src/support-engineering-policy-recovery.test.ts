import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { authenticate } from '../worker/src/api-auth';
import { IDENTITY_ISSUER } from '../worker/src/identity-api';
import { createSupportApi } from '../worker/src/support-api';
import { composeSupportEngineeringHuman } from '../worker/src/support-engineering-composition';
import { createSupportEngineeringHttpFixture } from '../worker/src/support-engineering-http-fixtures';
import { BrowserNode } from './test-support-browser';

interface Panel {
  showPolicy(value: { actorSubject: string }): Promise<void>;
  suspend(): void; hasPending(): boolean;
  pendingOwners(): readonly { domain: string; actorSubject: string; ticketId?: string; acknowledged: boolean }[];
}
async function fixture() {
  // Deliberately never create a ticket: global policy recovery cannot depend
  // on an old ticket, selected source or invented staff-ticket context.
  const f = await createSupportEngineeringHttpFixture();
  const state = { enabled: true, lose: false, ids: 0, ticketReads: 0 };
  const shared = { ...f.host, application: f.engineering.application };
  const human = { enabled: () => state.enabled,
    configuration: { application: { enabled: true }, repositories: f.options.repositories } };
  const api = createSupportApi({ ...f.options, application: shared.application,
    createLimiter: shared.createLimiter, replyLimiter: shared.replyLimiter,
    engineering: composeSupportEngineeringHuman(shared, f.options.logger, human) });
  const root = new BrowserNode('section'); const calls: { path: string; method: string; body?: string }[] = [];
  function requestFor(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers); headers.set('Cookie', f.cookies.get('both')!);
    if (init.method === 'POST') { headers.set('Origin', IDENTITY_ISSUER); headers.set('Sec-Fetch-Site', 'same-origin'); }
    return new Request(IDENTITY_ISSUER + path, { ...init, headers });
  }
  const vm: Record<string, unknown> = { document: { createElement: (tag: string) => new BrowserNode(tag) }, AbortController, TextEncoder };
  runInNewContext(readFileSync(new URL('../public/staff-support-engineering.js', import.meta.url), 'utf8'), vm);
  const panel = (vm.PegmaSupportEngineering as { createPanel(options: unknown): Panel }).createPanel({ root,
    isEnabled: () => state.enabled,
    async readSession() {
      const value = await authenticate(requestFor('/api/identity/session'), f.options);
      if (value === null) throw Object.assign(new Error('session_required'), { status: 401 });
      return { subject: value.link.subject, csrfToken: value.csrfToken };
    },
    async readCurrentTicket() { ++state.ticketReads; throw new Error('Global policy recovery must not read a ticket'); },
    async request(path: string, init: RequestInit = {}) {
      calls.push({ path, method: init.method ?? 'GET', ...(typeof init.body === 'string' ? { body: init.body } : {}) });
      const response = await api(requestFor(path, init));
      if (path === '/api/support/admin/engineering/policy' && init.method === 'POST' && response.ok && state.lose) {
        state.lose = false; throw Object.assign(new Error('Synthetic committed policy ACK loss'), { status: 503 });
      }
      if (!response.ok) throw Object.assign(new Error('request_failed'), { status: response.status });
      return response.json();
    }, commandId: () => 'GLOBAL-POLICY-EXACT-UPPERCASE-' + ++state.ids,
  });
  const node = (key: string) => {
    const value = root.all().find((item) => item.dataset.engineeringAction === key);
    if (!value) throw new Error('Missing engineering control ' + key); return value;
  };
  async function action(key: string) {
    node(key).fire('click');
    for (let attempt = 0; attempt < 1200; attempt++) {
      if (!node('policy-read').disabled) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    throw new Error('Actual global policy event did not settle');
  }
  return { f, state, panel, root, calls, node, action };
}

describe('global public engineering owner recovery', () => {
  it('recovers exact policy intent through real root auth/SDK with no ticket or selection', async () => {
    const h = await fixture(); await h.panel.showPolicy({ actorSubject: h.f.principals.both });
    expect(h.node('evidence').hidden).toBe(true); expect(h.node('enroll').hidden).toBe(true);
    await h.action('policy-prepare'); h.state.lose = true; await h.action('policy-save');
    const original = h.calls.find((call) => call.method === 'POST' && call.path === '/api/support/admin/engineering/policy')!;
    expect(h.panel.hasPending()).toBe(true);
    expect(h.panel.pendingOwners()).toEqual([{ domain: 'policy', actorSubject: h.f.principals.both, acknowledged: false }]);
    const before = await h.f.policyRows(); h.panel.suspend();
    await h.panel.showPolicy({ actorSubject: h.f.principals.both });
    expect(h.panel.hasPending()).toBe(true); await h.action('retry-policy');
    expect(h.panel.hasPending()).toBe(false); expect(await h.f.policyRows()).toEqual(before);
    expect(h.calls.filter((call) => call.method === 'POST' && call.path === original.path).every((call) => call.body === original.body)).toBe(true);
    expect(h.state.ids).toBe(1); expect(h.state.ticketReads).toBe(0);
    expect(h.calls.every((call) => !call.path.includes('/tickets/'))).toBe(true);
    expect(h.f.engineering.state.modelCalls).toBe(0); expect(h.f.engineering.state.creates).toEqual([]);
    for (const privateField of ['responsibilities', 'actorId', 'allowedTemplates', 'installationBinding'])
      expect(h.root.textContent).not.toContain(privateField);
  });
});
