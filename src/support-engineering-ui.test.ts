import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createDurableLimiter, defineRateLimitPolicy } from '@pegma/rate-limit';
import { describe, expect, it } from 'vitest';
import { authenticate } from '../worker/src/api-auth';
import { IDENTITY_ISSUER } from '../worker/src/identity-api';
import { createSupportApi } from '../worker/src/support-api';
import { engineeringTicketId } from '../worker/src/support-engineering-fixtures';
import { createSupportEngineeringHttpFixture, type EngineeringHttpActor } from '../worker/src/support-engineering-http-fixtures';
import { BrowserNode, browserGate } from './test-support-browser';

interface Panel {
  showTicket(value: { ticketId: string; revision: number; actorSubject: string }): Promise<void>;
  refresh(): Promise<void>; readPolicy(): Promise<void>; suspend(): void; hasPending(): boolean;
  pendingOwners(): readonly { domain: string; actorSubject: string; ticketId?: string; acknowledged: boolean }[];
}
async function harness() {
  const f = await createSupportEngineeringHttpFixture(); const ticket = await f.legacyTicket();
  const support = createSupportApi({ ...f.options, application: f.engineering.application,
    createLimiter: f.host.createLimiter, replyLimiter: f.host.replyLimiter });
  const root = new BrowserNode('section'); const calls: { path: string; method: string; body?: string; serverStatus?: number; retryAfter?: string | null }[] = [];
  const changes: unknown[] = [];
  const state = { actor: 'staff' as EngineeringHttpActor, enabled: true, ids: 0, sessionReads: 0, time: Date.now(),
    fault: undefined as ((path: string, response: Response) => Promise<void>) | undefined };
  function incoming(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers); headers.set('Cookie', f.cookies.get(state.actor)!);
    if (init.method === 'POST') { headers.set('Origin', IDENTITY_ISSUER); headers.set('Sec-Fetch-Site', 'same-origin'); }
    return new Request(IDENTITY_ISSUER + path, { ...init, headers });
  }
  async function request(path: string, init: RequestInit = {}) {
    const call = { path, method: init.method ?? 'GET', ...(typeof init.body === 'string' ? { body: init.body } : {}),
      serverStatus: 0, retryAfter: null as string | null };
    calls.push(call);
    const request = incoming(path, init);
    const pathname = new URL(path, IDENTITY_ISSUER).pathname;
    const engineering = /^\/api\/support\/admin\/tickets\/[^/]+\/engineering(?:\/|$)/u.test(pathname) ||
      /^\/api\/support\/admin\/engineering(?:\/|$)/u.test(pathname);
    const response = engineering ? await f.handle(request) : await support(request);
    if (response === null) throw new Error('Expected a registered adapter path');
    call.serverStatus = response.status; call.retryAfter = response.headers.get('Retry-After');
    await state.fault?.(path, response);
    if (!response.ok) throw Object.assign(new Error('request_failed'), { status: response.status,
      ...(response.status === 429 ? { retryAt: state.time + Number(call.retryAfter) * 1000 } : {}) });
    return response.json();
  }
  async function readSession() {
    state.sessionReads += 1;
    const value = await authenticate(incoming('/api/identity/session'), f.options);
    if (value === null) throw Object.assign(new Error('session_required'), { status: 401 });
    return { subject: value.link.subject, csrfToken: value.csrfToken };
  }
  const vm: Record<string, unknown> = { document: { createElement: (tag: string) => new BrowserNode(tag) },
    AbortController, TextEncoder };
  runInNewContext(readFileSync(new URL('../public/staff-support-engineering.js', import.meta.url), 'utf8'), vm);
  const factory = vm.PegmaSupportEngineering as { createPanel(options: unknown): Panel };
  const panel = factory.createPanel({ root, request, readSession,
    readCurrentTicket: (id: string) => request('/api/support/admin/tickets/' + encodeURIComponent(id)),
    isEnabled: () => state.enabled, now: () => state.time, commandId: () => 'PUBLIC-ENGINEERING-UPPERCASE-' + ++state.ids,
    onPendingChange: (owners: unknown) => changes.push(owners) });
  function node(key: string, field = false) {
    const found = root.all().find((item) => item.dataset[field ? 'engineeringField' : 'engineeringAction'] === key);
    if (!found) throw new Error('Missing engineering control ' + key); return found;
  }
  async function settle() {
    for (let attempt = 0; attempt < 1200; attempt++) {
      if (!node('refresh').disabled) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    throw new Error('Engineering event did not settle');
  }
  async function action(key: string) { node(key).fire('click'); await settle(); }
  const open = () => panel.showTicket({ ticketId: engineeringTicketId, revision: ticket.revision, actorSubject: f.principals[state.actor] });
  return { f, root, calls, changes, state, panel, node, action, open,
    writes: () => calls.filter((call) => call.method === 'POST'),
    field: (key: string) => node(key, true),
    message: () => root.all().find((item) => item.dataset.engineeringMessage === 'engineering-question')! };
}

describe('standalone public engineering panel with actual authority adapters', () => {
  it('is inert before current feature and staff-ticket callbacks, without processor or dispatch controls', async () => {
    const h = await harness(); expect(h.calls).toEqual([]);
    h.state.enabled = false; await h.open(); expect(h.calls).toEqual([]); expect(h.root.hidden).toBe(true);
    expect(h.state.sessionReads).toBe(0);
    const actions = h.root.all().map((node) => node.dataset.engineeringAction).filter(Boolean);
    for (const forbidden of ['process', 'dispatch', 'file']) expect(actions).not.toContain(forbidden);
    expect(h.node('approve').disabled).toBe(true); expect(h.node('reject').disabled).toBe(true);
    expect(h.f.engineering.state.modelCalls).toBe(0); expect(h.f.engineering.state.creates).toEqual([]);
  });

  it('requires explicit sensitivity and actual public message selections before minting evidence IDs', async () => {
    const h = await harness(); await h.open(); await h.action('enroll');
    expect(h.root.all().some((item) => item.dataset.engineeringMessage === 'engineering-note')).toBe(false);
    h.field('expected').value = 'Rows should export.'; h.field('actual').value = 'The file is empty.';
    h.field('steps').value = 'Export the workspace.'; h.field('verification').value = 'PUBLIC-STAFF-ATTESTATION';
    h.message().checked = true;
    const before = h.writes().length; const ids = h.state.ids;
    await h.action('evidence'); expect(h.writes()).toHaveLength(before); expect(h.state.ids).toBe(ids);
    h.field('security').value = 'ordinary'; h.message().value = 'engineering-note';
    await h.action('evidence'); expect(h.writes()).toHaveLength(before); expect(h.state.ids).toBe(ids);
    h.message().value = 'engineering-question'; await h.action('evidence');
    const packet = JSON.parse(h.writes().at(-1)?.body ?? '{}');
    expect(packet).toMatchObject({ security: 'ordinary', visibleMessageIds: ['engineering-question'], commandId: 'PUBLIC-ENGINEERING-UPPERCASE-2' });
    expect((await h.f.engineering.source()).state).toBe('eligible');
    expect(h.f.engineering.state.modelCalls).toBe(0);
  });

  it('hides policy editing until current Admin and Support policy GET succeeds', async () => {
    const h = await harness(); await h.open(); await h.action('policy-read');
    expect(h.node('policy-save').disabled).toBe(true);
    expect(h.root.textContent).not.toContain('synthetic-repository-101');
    h.state.actor = 'admin'; await h.open(); await h.action('policy-read');
    expect(h.node('policy-save').disabled).toBe(true); expect(h.root.textContent).not.toContain('synthetic-repository-101');
    h.state.actor = 'both'; h.f.engineering.state.enabled = false; await h.open(); await h.action('policy-read');
    expect(h.root.textContent).toContain('synthetic-repository-101');
    expect(h.node('policy-prepare').disabled).toBe(false);
    expect(h.node('policy-save').disabled).toBe(true);
    await h.action('policy-prepare');
    expect(h.node('policy-save').disabled).toBe(false);
    for (const opaque of ['installationBinding', 'responsibilities', 'allowedTemplates', 'actorId', 'expectedGeneration'])
      expect(h.root.textContent).not.toContain(opaque);
    const prepared = h.writes().at(-1)!; expect(prepared.path.endsWith('/policy/prepare')).toBe(true);
    await h.action('policy-save');
    const saved = JSON.parse(h.writes().at(-1)?.body ?? '{}');
    expect(Object.keys(saved)).toEqual(['intent']);
    expect(saved.intent.commandId).toBe(JSON.parse(prepared.body ?? '{}').commandId);
    expect(h.panel.hasPending()).toBe(false);
    expect(h.f.engineering.state.modelCalls).toBe(0);
  });

  it('clears private presentation after feature loss while retaining the unresolved owned packet', async () => {
    const h = await harness(); await h.open();
    h.state.fault = async (path, response) => { if (path.endsWith('/enroll') && response.ok) throw Object.assign(new Error('lost_ack'), { status: 503 }); };
    await h.action('enroll'); const original = h.writes()[0]?.body;
    expect(h.panel.pendingOwners()).toEqual([{ domain: 'ticket', actorSubject: h.f.principals.staff, ticketId: engineeringTicketId, acknowledged: false }]);
    h.state.enabled = false; await h.panel.refresh();
    expect(h.root.hidden).toBe(true); expect(h.panel.hasPending()).toBe(true);
    h.state.enabled = true; h.state.fault = undefined; await h.open(); await h.action('retry-ticket');
    expect(h.writes().at(-1)?.body).toBe(original); expect(h.panel.hasPending()).toBe(false);
    expect(JSON.stringify(h.changes)).not.toContain('commandId');
  });

  it.each(['repository', 'enabled'] as const)('discards an in-flight prepared policy after the displayed %s choice changes', async (changed) => {
    const h = await harness(); h.state.actor = 'both'; await h.open(); await h.action('policy-read');
    const entered = browserGate<void>(); const release = browserGate<void>();
    h.state.fault = async (path, response) => {
      if (path.endsWith('/policy/prepare') && response.ok) { entered.resolve(); await release.promise; }
    };
    const preparing = h.action('policy-prepare');
    try {
      await entered.promise;
      if (changed === 'repository') {
        const choice = h.root.all().find((item) => item.dataset.engineeringRepository);
        if (choice === undefined) throw new Error('Actual configured policy checkbox missing');
        choice.checked = false; choice.fire('change');
      } else { h.field('policy-enabled').checked = false; h.field('policy-enabled').fire('change'); }
    } finally { release.resolve(); }
    await preparing; expect(h.node('policy-save').disabled).toBe(true);
    const posts = h.writes().length; await h.action('policy-save'); expect(h.writes()).toHaveLength(posts);
    expect(h.panel.hasPending()).toBe(false);
    h.state.fault = undefined; await h.action('policy-prepare'); expect(h.node('policy-save').disabled).toBe(false);
    await h.action('policy-save');
    const saved = JSON.parse(h.writes().at(-1)?.body ?? '{}');
    expect(saved.intent.policy.enabled).toBe(changed === 'repository');
    expect(saved.intent.repositoryKeys).toHaveLength(changed === 'repository' ? 1 : 2);
    expect(h.panel.hasPending()).toBe(false);
  });

  it('recovers an unknown mutation through its independent quota while a real read Retry-After remains active', async () => {
    const h = await harness(); await h.open();
    h.state.fault = async (path, response) => {
      if (path.endsWith('/enroll') && response.ok) throw Object.assign(new Error('Synthetic committed enrollment ACK loss'), { status: 503 });
    };
    await h.action('enroll'); const original = h.writes().at(-1)!; const rows = await h.f.rows();
    expect(h.panel.pendingOwners()[0]?.acknowledged).toBe(false); h.state.fault = undefined;
    h.state.time = Math.ceil(h.state.time / 30_000) * 30_000;
    const limiter = createDurableLimiter(defineRateLimitPolicy({ name: 'public-engineering-independent-read-retry', limit: 1, windowMs: 30_000 }),
      h.f.engineering.store, { clock: { now: () => new Date(h.state.time).toISOString() } });
    Object.assign(h.f.options, { readLimiter: limiter }); await limiter.allow(h.f.principals.staff);
    await h.panel.refresh(); expect(h.calls.at(-1)?.serverStatus).toBe(429); expect(h.calls.at(-1)?.retryAfter).toBe('30');
    const posts = h.writes().length; await h.action('retry-ticket');
    expect(h.writes()).toHaveLength(posts + 1); expect(h.writes().at(-1)?.body).toBe(original.body);
    expect(h.writes().at(-1)?.serverStatus).toBe(200); expect(h.panel.pendingOwners()[0]?.acknowledged).toBe(true);
    expect(await h.f.rows()).toEqual(rows);
    h.state.time += 30_000; await h.action('retry-ticket');
    expect(h.writes()).toHaveLength(posts + 1); expect(h.panel.hasPending()).toBe(false);
    expect(await h.f.rows()).toEqual(rows);
  });

  it('honors actual HTTP Retry-After without a premature probe and explicitly recovers the same packet when its deadline elapses', async () => {
    const h = await harness(); await h.open();
    h.state.time = Math.ceil(h.state.time / 30_000) * 30_000;
    const limiter = createDurableLimiter(defineRateLimitPolicy({ name: 'public-engineering-ui-retry', limit: 10, windowMs: 30_000 }),
      h.f.engineering.store, { clock: { now: () => new Date(h.state.time).toISOString() } });
    Object.assign(h.f.options, { mutationLimiter: limiter });
    for (let index = 0; index < 10; index++) await limiter.allow(h.f.principals.staff);
    const rows = await h.f.rows(); const ids = h.state.ids;
    await h.action('enroll'); const original = h.writes().at(-1)!;
    expect(original.serverStatus).toBe(429); expect(original.retryAfter).toBe('30');
    expect(h.panel.pendingOwners()[0]?.acknowledged).toBe(false); expect(await h.f.rows()).toEqual(rows);
    expect(h.node('retry-ticket').disabled).toBe(false);
    const calls = h.calls.length; const sessions = h.state.sessionReads; const deadline = h.state.time + 30_000;
    await h.action('retry-ticket'); h.state.time = deadline - 1; await h.action('retry-ticket');
    expect(h.calls).toHaveLength(calls); expect(h.state.sessionReads).toBe(sessions);
    expect(h.state.ids).toBe(ids + 1); expect(h.panel.hasPending()).toBe(true);
    h.state.time = deadline;
    expect(h.calls).toHaveLength(calls); // Advancing time does not retry automatically.
    await h.action('retry-ticket');
    expect(h.writes().at(-1)?.body).toBe(original.body); expect(h.writes().at(-1)?.serverStatus).toBe(200);
    expect(h.state.ids).toBe(ids + 1); expect(h.panel.hasPending()).toBe(false);
    expect(h.node('evidence').disabled).toBe(false); expect(h.f.engineering.state.creates).toEqual([]);
  });
});
