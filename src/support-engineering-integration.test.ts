import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { supportPermissions } from '@pegma/support-desk-application';
import { describe, expect, it } from 'vitest';
import { authenticate } from '../worker/src/api-auth';
import { IDENTITY_ISSUER } from '../worker/src/identity-api';
import { createSupportApi } from '../worker/src/support-api';
import { SUPPORT_ROLE } from '../worker/src/support-access';
import { engineeringCanary, engineeringTicketId } from '../worker/src/support-engineering-fixtures';
import { createSupportEngineeringHandlers } from '../worker/src/support-engineering-handlers';
import { createSupportEngineeringHttpFixture, type EngineeringHttpActor } from '../worker/src/support-engineering-http-fixtures';
import { BrowserNode } from './test-support-browser';

interface Owner { domain: string; actorSubject: string; ticketId?: string; acknowledged: boolean }
interface Panel {
  showTicket(value: { ticketId: string; revision: number; actorSubject: string }): Promise<void>;
  refresh(): Promise<void>; suspend(): void; pendingOwners(): readonly Owner[]; hasPending(): boolean;
}
async function harness(autoEnrolled = false) {
  const f = await createSupportEngineeringHttpFixture();
  const ticket = autoEnrolled ? await f.engineering.createTicket() : await f.legacyTicket();
  const support = createSupportApi({ ...f.options, application: f.engineering.application,
    createLimiter: f.host.createLimiter, replyLimiter: f.host.replyLimiter });
  const root = new BrowserNode('section');
  const calls: { path: string; method: string; body?: string; serverStatus?: number }[] = [];
  const ownership: (readonly Owner[])[] = [];
  const state = { actor: 'staff' as EngineeringHttpActor, enabled: true, ids: 0, handle: f.handle,
    fault: undefined as ((path: string, response: Response) => Promise<void>) | undefined };
  function incoming(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers); headers.set('Cookie', f.cookies.get(state.actor)!);
    if (init.method === 'POST') { headers.set('Origin', IDENTITY_ISSUER); headers.set('Sec-Fetch-Site', 'same-origin'); }
    return new Request(IDENTITY_ISSUER + path, { ...init, headers });
  }
  async function request(path: string, init: RequestInit = {}) {
    const call = { path, method: init.method ?? 'GET', ...(typeof init.body === 'string' ? { body: init.body } : {}), serverStatus: 0 };
    calls.push(call);
    const pathname = new URL(path, IDENTITY_ISSUER).pathname;
    const engineering = /^\/api\/support\/admin\/tickets\/[^/]+\/engineering(?:\/|$)/u.test(pathname) ||
      /^\/api\/support\/admin\/engineering(?:\/|$)/u.test(pathname);
    const response = engineering ? await state.handle(incoming(path, init)) : await support(incoming(path, init));
    if (response === null) throw new Error('Expected an owned HTTP route');
    call.serverStatus = response.status; await state.fault?.(path, response);
    if (!response.ok) throw Object.assign(new Error('request_failed'), { status: response.status });
    return response.json();
  }
  const readSession = async () => {
    const value = await authenticate(incoming('/api/identity/session'), f.options);
    if (value === null) throw Object.assign(new Error('session_required'), { status: 401 });
    return { subject: value.link.subject, csrfToken: value.csrfToken };
  };
  const vm: Record<string, unknown> = { document: { createElement: (tag: string) => new BrowserNode(tag) }, AbortController, TextEncoder };
  runInNewContext(readFileSync(new URL('../public/staff-support-engineering.js', import.meta.url), 'utf8'), vm);
  const panel = (vm.PegmaSupportEngineering as { createPanel(options: unknown): Panel }).createPanel({
    root, request, readSession, readCurrentTicket: (id: string) => request('/api/support/admin/tickets/' + encodeURIComponent(id)),
    isEnabled: () => state.enabled, commandId: () => 'ENGINEERING-INTEGRATION-UPPERCASE-' + ++state.ids,
    onPendingChange: (owners: readonly Owner[]) => ownership.push(owners) });
  function node(key: string, field = false) {
    const value = root.all().find((item) => item.dataset[field ? 'engineeringField' : 'engineeringAction'] === key);
    if (!value) throw new Error('Missing engineering control ' + key); return value;
  }
  async function settle() {
    for (let attempt = 0; attempt < 1200; attempt++) {
      if (!node('refresh').disabled) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    throw new Error('Actual engineering event did not settle');
  }
  const action = async (key: string) => { node(key).fire('click'); await settle(); };
  const open = () => panel.showTicket({ ticketId: engineeringTicketId, revision: ticket.revision, actorSubject: f.principals[state.actor] });
  function evidence(security = 'ordinary') {
    node('expected', true).value = 'The fictional export contains its rows.';
    node('actual', true).value = 'The fictional downloaded file is empty.';
    node('steps', true).value = 'Open the fictional workspace.\nExport and inspect the file.';
    node('verification', true).value = 'PUBLIC-INTEGRATION-STAFF-VERIFICATION';
    node('security', true).value = security;
    const message = root.all().find((item) => item.dataset.engineeringMessage === 'engineering-question');
    if (!message) throw new Error('Expected actual customer-visible message choice'); message.checked = true;
  }
  return { f, root, state, panel, calls, ownership, node, action, open, evidence,
    writes: () => calls.filter((call) => call.method === 'POST') };
}

describe('public engineering panel through actual Memory SDK and HTTP authority', () => {
  it('keeps an engineering-prefixed ticket ID on the actual staff detail route before engineering intake', async () => {
    const h = await harness(); await h.open();
    expect(h.calls.find((call) => call.path === '/api/support/admin/tickets/' + engineeringTicketId)?.serverStatus).toBe(200);
    expect(h.calls.find((call) => call.path.endsWith('/engineering'))?.serverStatus).toBe(404);
    expect(h.node('enroll').disabled).toBe(false); expect(h.writes()).toEqual([]);
    expect(h.root.all().some((item) => item.dataset.engineeringMessage === 'engineering-question')).toBe(true);
  });
  it('requires an explicit SDK enrollment confirmation before evidence when an auto-enrolled source0 read is protected', async () => {
    const h = await harness(true); await h.open();
    expect(h.calls.some((call) => call.path.endsWith('/engineering') && call.serverStatus === 403)).toBe(true);
    expect(h.node('evidence').disabled).toBe(true);
    expect(h.node('enroll').disabled).toBe(false);
    await h.action('enroll'); expect(h.panel.hasPending()).toBe(false);
    expect(h.node('evidence').disabled).toBe(false);
    h.evidence(); await h.action('evidence'); expect((await h.f.engineering.source()).state).toBe('eligible');
    expect((await h.f.resolve(h.f.principals.staff))?.permissions).not.toContain(supportPermissions.engineeringRestrictedRead);
  });
  it('recovers known enrollment0 through protected source403 and a NEW real same-actor staff-ticket read before explicit evidence', async () => {
    const h = await harness(); await h.open();
    expect(h.node('enroll').disabled).toBe(false); expect(h.node('evidence').disabled).toBe(true);
    await h.action('enroll'); const start = h.calls.findIndex((call) => call.path.endsWith('/engineering/enroll'));
    expect(h.calls[start]?.serverStatus).toBe(200);
    expect(h.calls.slice(start + 1).some((call) => call.path.endsWith('/engineering') && call.serverStatus === 403)).toBe(true);
    expect(h.calls.slice(start + 1).some((call) => call.path === '/api/support/admin/tickets/' + engineeringTicketId && call.serverStatus === 200)).toBe(true);
    const enrolled = await h.f.engineering.source();
    expect(enrolled).toMatchObject({ sourceGeneration: 0, state: 'unverified', security: 'uncertain' });
    const current = await h.f.resolve(h.f.principals.staff);
    expect(current?.permissions).not.toContain(supportPermissions.engineeringRestrictedRead);
    expect(h.panel.hasPending()).toBe(false); expect(h.node('evidence').disabled).toBe(false);
    h.evidence(); await h.action('evidence');
    const source = await h.f.engineering.source(); expect(source.state).toBe('eligible');
    expect(source.evidence).toMatchObject({ kind: 'staff_verified_failure', actorId: h.f.principals.staff });
    expect(h.f.engineering.state.modelCalls).toBe(0); expect(h.f.engineering.state.creates).toEqual([]);
    expect(h.root.textContent).not.toContain(engineeringCanary);
  });

  it('keeps a real product hold distinct from eligibility and never starts processing', async () => {
    const h = await harness(); await h.open(); await h.action('enroll'); h.f.engineering.state.product = 'missing';
    h.evidence(); await h.action('evidence');
    expect((await h.f.engineering.source()).state).toBe('held');
    expect((await h.f.rows()).filter((row) => row.kind === 'engineering_work')).toEqual([]);
    expect(h.f.engineering.state.modelCalls).toBe(0); expect(h.f.engineering.state.creates).toEqual([]);
  });

  it('retains the exact uppercase unknown evidence packet across actual withdrawal and replay without a new command', async () => {
    const h = await harness(); await h.open(); await h.action('enroll'); h.evidence();
    let lose = true;
    h.state.fault = async (path, response) => {
      if (lose && path.endsWith('/evidence') && response.ok) { lose = false; throw Object.assign(new Error('Synthetic committed ACK loss'), { status: 503 }); }
    };
    await h.action('evidence'); const original = h.writes().at(-1)!; expect(h.panel.hasPending()).toBe(true);
    await h.f.engineering.application.withdrawEngineeringSource(h.f.engineering.actors.staff,
      { ...h.f.engineering.command('ui-withdraw-after-ack-loss'), ticketId: engineeringTicketId, reason: 'privacy_withdrawal' });
    const before = await h.f.rows(); h.state.fault = undefined;
    await h.open(); expect(h.panel.hasPending()).toBe(true); await h.action('retry-ticket');
    expect(h.writes().at(-1)?.body).toBe(original.body); expect(h.state.ids).toBe(2);
    expect(await h.f.rows()).toEqual(before); expect((await h.f.engineering.source()).state).toBe('withdrawn');
    expect(h.panel.hasPending()).toBe(false);
  });

  it('uses GET-only recovery after a genuine enrollment ACK followed by a transport failure', async () => {
    const h = await harness(); await h.open();
    let fail = false;
    h.state.fault = async (path, response) => {
      if (path.endsWith('/enroll') && response.ok) fail = true;
      else if (fail && path.endsWith('/engineering')) throw Object.assign(new Error('Synthetic post-ACK read failure'), { status: 503 });
    };
    await h.action('enroll'); expect(h.panel.pendingOwners()[0]?.acknowledged).toBe(true);
    const before = await h.f.rows(); h.state.fault = undefined; const posts = h.writes().length;
    await h.action('retry-ticket'); expect(h.writes()).toHaveLength(posts);
    expect(h.panel.hasPending()).toBe(false); expect(await h.f.rows()).toEqual(before);
    expect(h.node('evidence').disabled).toBe(false);
  });

  it('replays the original opaque policy intent after lost ACK and a removed catalog without rendering it', async () => {
    const h = await harness(); h.state.actor = 'both'; await h.open(); await h.action('policy-read');
    await h.action('policy-prepare'); let lose = true;
    h.state.fault = async (path, response) => {
      if (lose && path === '/api/support/admin/engineering/policy' && response.ok) {
        // This transport fault is armed only for the already prepared POST.
        lose = false; throw Object.assign(new Error('Synthetic policy response loss'), { status: 503 });
      }
    };
    await h.action('policy-save'); const original = h.writes().at(-1)!;
    expect(h.panel.hasPending()).toBe(true); const before = await h.f.policyRows();
    h.state.fault = undefined;
    h.state.handle = createSupportEngineeringHandlers({ ...h.f.options, repositories: [] });
    await h.action('retry-policy');
    expect(h.writes().at(-1)?.body).toBe(original.body); expect(await h.f.policyRows()).toEqual(before);
    expect(h.panel.hasPending()).toBe(false); expect(h.node('policy-prepare').disabled).toBe(true);
    expect(h.root.textContent).toContain('No server-configured repositories.');
    expect(h.root.textContent).toContain('saved repositories are unmapped');
    expect(h.node('policy-disable').disabled).toBe(false);
    for (const secret of ['responsibilities', 'allowedTemplates', 'actorId', 'installationBinding']) expect(h.root.textContent).not.toContain(secret);
  });

  it('performs GET-only policy recovery after a bound ACK and a failed current policy read', async () => {
    const h = await harness(); h.state.actor = 'both'; await h.open(); await h.action('policy-read'); await h.action('policy-prepare');
    let committed = false;
    h.state.fault = async (path, response) => {
      if (path !== '/api/support/admin/engineering/policy' || !response.ok) return;
      if (h.calls.at(-1)?.method === 'POST') committed = true;
      else if (committed) throw Object.assign(new Error('Synthetic current policy read outage'), { status: 503 });
    };
    await h.action('policy-save'); expect(h.panel.pendingOwners()[0]?.acknowledged).toBe(true);
    const posts = h.writes().length; const before = await h.f.policyRows(); h.state.fault = undefined;
    await h.action('retry-policy'); expect(h.writes()).toHaveLength(posts);
    expect(h.panel.hasPending()).toBe(false); expect(await h.f.policyRows()).toEqual(before);
  });

  it('keeps a restricted evidence ACK known while protected GET recovery remains unreadable', async () => {
    const h = await harness(); await h.open(); await h.action('enroll'); h.evidence('uncertain'); await h.action('evidence');
    expect((await h.f.engineering.source()).state).toBe('restricted');
    expect(h.panel.pendingOwners()[0]?.acknowledged).toBe(true);
    const posts = h.writes().length; await h.action('retry-ticket');
    expect(h.writes()).toHaveLength(posts); expect(h.panel.hasPending()).toBe(true);
    expect(h.node('evidence').disabled).toBe(true); expect(h.f.engineering.state.creates).toEqual([]);
  });

  it('retains owner A across A to peer B to A and never submits A under B credentials', async () => {
    const h = await harness(); await h.open();
    h.state.fault = async (path, response) => { if (path.endsWith('/enroll') && response.ok) throw Object.assign(new Error('Synthetic ACK loss'), { status: 503 }); };
    await h.action('enroll'); const original = h.writes()[0]!;
    h.state.actor = 'peer'; h.state.fault = undefined; await h.open(); await h.action('retry-ticket');
    expect(h.writes()).toHaveLength(1); expect(h.panel.pendingOwners()[0]?.actorSubject).toBe(h.f.principals.staff);
    h.state.actor = 'staff'; await h.open(); await h.action('retry-ticket');
    expect(h.writes().at(-1)?.body).toBe(original.body); expect(h.panel.hasPending()).toBe(false);
  });

  it('keeps ticket A ownership while another actual ticket is selected and never replays under ticket B', async () => {
    const h = await harness(); await h.open();
    h.state.fault = async (path, response) => { if (path.endsWith('/enroll') && response.ok) throw Object.assign(new Error('Synthetic ACK loss'), { status: 503 }); };
    await h.action('enroll'); const original = h.writes()[0]!; h.state.fault = undefined;
    await h.f.engineering.application.createCustomerTicket(h.f.engineering.actors.customer,
      { ...h.f.engineering.command('second-ui-ticket'), ticketId: 'engineering-other-ticket', messageId: 'other-question', subject: 'Another fictional question', body: 'A separate public question.' });
    const second = await h.f.engineering.application.readStaffTicket(h.f.engineering.actors.staff, 'engineering-other-ticket');
    await h.panel.showTicket({ ticketId: second.ticket.id, revision: second.ticket.revision, actorSubject: h.f.principals.staff });
    await h.action('retry-ticket'); expect(h.writes()).toHaveLength(1);
    expect(h.panel.pendingOwners()[0]?.ticketId).toBe(engineeringTicketId);
    await h.open(); await h.action('retry-ticket');
    expect(h.writes().at(-1)?.path).toBe(original.path); expect(h.writes().at(-1)?.body).toBe(original.body);
  });

  it('withholds a genuine committed ACK after actual Support revocation and retains the original owner', async () => {
    const h = await harness(); await h.open();
    h.f.hooks.commit = async () => { delete h.f.hooks.commit; await h.f.revoke('staff', SUPPORT_ROLE); };
    await h.action('enroll'); expect(h.panel.hasPending()).toBe(true);
    expect((await h.f.engineering.source()).sourceGeneration).toBe(0);
    expect(h.root.textContent).not.toContain(engineeringCanary); expect(h.node('evidence').disabled).toBe(true);
    expect(h.panel.pendingOwners()[0]?.actorSubject).toBe(h.f.principals.staff);
  });
});
