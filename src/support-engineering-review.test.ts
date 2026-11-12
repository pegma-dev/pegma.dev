import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { authenticate } from '../worker/src/api-auth';
import { IDENTITY_ISSUER } from '../worker/src/identity-api';
import { createSupportApi } from '../worker/src/support-api';
import { engineeringTicketId } from '../worker/src/support-engineering-fixtures';
import { createSupportEngineeringHttpFixture, type EngineeringHttpActor } from '../worker/src/support-engineering-http-fixtures';
import { createSupportEngineeringRuntime } from '../worker/src/support-engineering';
import { BrowserNode } from './test-support-browser';

interface Panel {
  showTicket(value: { ticketId: string; revision: number; actorSubject: string }): Promise<void>;
  refresh(): Promise<void>; suspend(): void; hasPending(): boolean;
  pendingOwners(): readonly { domain: string; actorSubject: string; ticketId?: string; acknowledged: boolean }[];
}
async function harness() {
  const f = await createSupportEngineeringHttpFixture();
  Object.assign(f.options, { reviewEnabled: () => true });
  await f.verified(); const checked = await f.prepared();
  const ticket = (await f.engineering.application.readStaffTicket(f.engineering.actors.staff, engineeringTicketId)).ticket;
  const support = createSupportApi({ ...f.options, application: f.engineering.application,
    createLimiter: f.host.createLimiter, replyLimiter: f.host.replyLimiter });
  const root = new BrowserNode('section'); const calls: { path: string; method: string; body?: string; serverStatus?: number }[] = [];
  const changes: unknown[] = [];
  const state = { actor: 'staff' as EngineeringHttpActor, enabled: true, reviewEnabled: true,
    fault: undefined as ((path: string, response: Response) => Promise<void>) | undefined };
  function incoming(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers); headers.set('Cookie', f.cookies.get(state.actor)!);
    if (init.method === 'POST') { headers.set('Origin', IDENTITY_ISSUER); headers.set('Sec-Fetch-Site', 'same-origin'); }
    return new Request(IDENTITY_ISSUER + path, { ...init, headers });
  }
  async function request(path: string, init: RequestInit = {}) {
    const call = { path, method: init.method ?? 'GET', ...(typeof init.body === 'string' ? { body: init.body } : {}), serverStatus: 0 };
    calls.push(call);
    const original = incoming(path, init);
    const response = /\/engineering(?:\/|$)/u.test(new URL(original.url).pathname)
      ? await f.handle(original) : await support(original);
    if (response === null) throw new Error('Expected an actual registered HTTP adapter');
    call.serverStatus = response.status;
    await state.fault?.(path, response);
    if (!response.ok) throw Object.assign(new Error('request_failed'), { status: response.status });
    return response.json();
  }
  async function readSession() {
    const value = await authenticate(incoming('/api/identity/session'), f.options);
    if (value === null) throw Object.assign(new Error('session_required'), { status: 401 });
    return { subject: value.link.subject, csrfToken: value.csrfToken };
  }
  const vm: Record<string, unknown> = { document: { createElement: (tag: string) => new BrowserNode(tag) },
    AbortController, TextEncoder, crypto: { randomUUID } };
  runInNewContext(readFileSync(new URL('../public/staff-support-engineering.js', import.meta.url), 'utf8'), vm);
  const factory = vm.PegmaSupportEngineering as { createPanel(options: unknown): Panel };
  const panel = factory.createPanel({ root, request, readSession,
    readCurrentTicket: (id: string) => request('/api/support/admin/tickets/' + encodeURIComponent(id)),
    isEnabled: () => state.enabled, isReviewEnabled: () => state.reviewEnabled, onPendingChange: (owners: unknown) => changes.push(owners) });
  function node(key: string) {
    const found = root.all().find((item) => item.dataset.engineeringAction === key);
    if (found === undefined) throw new Error('Missing engineering action ' + key); return found;
  }
  async function action(key: string) {
    node(key).fire('click');
    for (let attempt = 0; attempt < 1200; attempt++) {
      if (!node('refresh').disabled) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    throw new Error('Actual engineering event failed to settle');
  }
  const open = () => panel.showTicket({ ticketId: engineeringTicketId, revision: ticket.revision, actorSubject: f.principals[state.actor] });
  return { f, checked, root, state, calls, changes, panel, node, action, open,
    writes: () => calls.filter((item) => item.method === 'POST') };
}

describe('checked human engineering review panel through real SDK and HTTP adapters', () => {
  it('renders only the exact checked proposal as inert text and requires an explicit approve action', async () => {
    const h = await harness(); expect(h.calls).toEqual([]); expect(h.node('approve').disabled).toBe(true);
    await h.open(); expect(h.node('approve').disabled).toBe(true); await h.action('proposal');
    expect(h.writes()).toEqual([]); expect(h.node('approve').disabled).toBe(false); expect(h.node('reject').disabled).toBe(false);
    const proposal = h.checked.proposal; if (proposal === undefined) throw new Error('Real proposal missing');
    expect(h.root.textContent).toContain(proposal.request.bundle.title);
    for (const privateText of [proposal.checksReceipt, proposal.request.repository.installationBinding,
      h.f.engineering.configuration.dataControls.accountRef, 'expectedWorkGeneration', 'correlationId', 'modelAttempts'])
      expect(h.root.textContent).not.toContain(privateText);
    expect(h.root.all().some((item) => item.tagName === 'img' || item.tagName === 'a')).toBe(false);
    const calls = h.f.engineering.state.modelCalls;
    await h.action('approve'); expect(h.writes()).toHaveLength(1); expect(h.writes()[0]?.path.endsWith('/review')).toBe(true);
    const packet = JSON.parse(h.writes()[0]?.body ?? '{}');
    expect(packet.intent.command).toMatchObject({ decision: 'approve', proposalHash: proposal.proposalHash,
      expectedWorkGeneration: h.checked.workGeneration, sourceGeneration: h.checked.sourceGeneration });
    expect(typeof packet.intent.command.commandId).toBe('string'); expect(typeof packet.intent.command.correlationId).toBe('string');
    expect((await h.f.work()).status).toBe('approved'); expect(h.panel.hasPending()).toBe(false);
    expect(h.f.engineering.state.modelCalls).toBe(calls); expect(h.f.engineering.state.creates).toEqual([]);
  });

  it('requires an explicit reject and retains the complete chosen SDK command', async () => {
    const h = await harness(); await h.open(); await h.action('proposal');
    expect(h.writes()).toEqual([]); await h.action('reject');
    expect(h.writes()).toHaveLength(1);
    const body = JSON.parse(h.writes()[0]?.body ?? '{}');
    expect(body.intent.command).toMatchObject({ decision: 'reject', proposalHash: h.checked.proposal?.proposalHash,
      expectedWorkGeneration: h.checked.workGeneration, sourceGeneration: h.checked.sourceGeneration });
    expect((await h.f.work()).approval).toMatchObject({ decision: 'reject' });
    expect((await h.f.work()).status).toBe('held');
    expect(h.panel.hasPending()).toBe(false);
    expect(h.f.engineering.state.creates).toEqual([]);
  });

  it.each(['invalidate', 'withdraw'] as const)('retires an unsent checked proposal after actual source %s without retaining a stale review', async (action) => {
    const h = await harness(); await h.open(); await h.action('proposal');
    const title = h.checked.proposal?.request.bundle.title;
    if (title === undefined) throw new Error('Actual checked proposal title missing');
    expect(h.root.textContent).toContain(title); expect(h.node('approve').disabled).toBe(false);
    const modelCalls = h.f.engineering.state.modelCalls;
    expect(h.node(action).disabled).toBe(false);
    await h.action(action); expect(h.writes().at(-1)?.serverStatus).toBe(200);
    expect((await h.f.engineering.source()).state).toBe(action === 'withdraw' ? 'withdrawn' : 'held');
    expect(h.root.textContent).not.toContain(title); expect(h.node('approve').disabled).toBe(true); expect(h.node('reject').disabled).toBe(true);
    const writes = h.writes().length; await h.action('approve'); await h.action('reject');
    expect(h.writes()).toHaveLength(writes); expect(h.panel.hasPending()).toBe(false);
    expect(h.f.engineering.state.modelCalls).toBe(modelCalls); expect(h.f.engineering.state.creates).toEqual([]);
  });

  it('retains byte-identical complete command after an actually committed review loses its HTTP acknowledgement', async () => {
    const h = await harness(); await h.open(); await h.action('proposal');
    h.state.fault = async (path, response) => {
      if (path.endsWith('/review') && response.ok) throw Object.assign(new Error('Synthetic lost response AFTER SDK commit'), { status: 503 });
    };
    await h.action('approve'); const original = h.writes()[0]?.body;
    expect((await h.f.work()).status).toBe('approved'); expect(h.panel.hasPending()).toBe(true);
    expect(h.panel.pendingOwners()).toEqual([{ domain: 'ticket', actorSubject: h.f.principals.staff,
      ticketId: engineeringTicketId, acknowledged: false }]);
    h.f.engineering.metadata.clear(); h.f.engineering.state.checksReadable = false;
    h.state.fault = undefined; h.panel.suspend(); await h.open();
    const before = h.calls.length; const rows = await h.f.rows();
    await h.action('retry-ticket');
    expect(h.calls[before]).toMatchObject({ method: 'POST', body: original });
    expect(h.calls[before]?.path.endsWith('/review')).toBe(true);
    expect(h.writes().at(-1)?.body).toBe(original); expect(h.panel.hasPending()).toBe(false);
    expect(await h.f.rows()).toEqual(rows); expect(h.f.engineering.state.creates).toEqual([]);
    expect(JSON.stringify(h.changes)).not.toContain('proposalHash'); expect(JSON.stringify(h.changes)).not.toContain('commandId');
  });

  it('keeps an unavailable, never-accepted review unknown across GET refresh and never fabricates cancellation', async () => {
    const h = await harness(); await h.open(); await h.action('proposal');
    h.f.state.runtime = createSupportEngineeringRuntime({ application: h.f.engineering.application, clock: h.f.engineering.clock,
      staffAccess: { resolve: (id) => h.f.resolve(id) } });
    const rows = await h.f.rows(); await h.action('approve'); const original = h.writes()[0]?.body;
    expect(h.panel.hasPending()).toBe(true); expect(await h.f.rows()).toEqual(rows);
    await h.panel.refresh(); expect(h.panel.hasPending()).toBe(true);
    expect(h.node('approve').disabled).toBe(true); expect(h.node('proposal').disabled).toBe(true);
    await h.action('reject'); expect(h.writes()).toHaveLength(1);
    await h.action('retry-ticket'); expect(h.writes().at(-1)?.body).toBe(original);
    expect(h.panel.hasPending()).toBe(true); expect(await h.f.rows()).toEqual(rows);
  });

  it('clears proposal bytes and blocks approve if the closing actual session is destroyed during its GET', async () => {
    const h = await harness(); await h.open(); const rows = await h.f.rows();
    h.state.fault = async (path, response) => { if (path.includes('/proposal?') && response.ok) await h.f.destroy('staff'); };
    await h.action('proposal'); expect(h.node('approve').disabled).toBe(true);
    const title = h.checked.proposal?.request.bundle.title;
    if (title === undefined) throw new Error('Actual proposal title missing');
    expect(h.root.textContent).not.toContain(title);
    expect(h.writes()).toEqual([]); expect(h.panel.hasPending()).toBe(false); expect(await h.f.rows()).toEqual(rows);
  });

  it('never lends an unresolved actor-owned review packet to another current staff actor', async () => {
    const h = await harness(); await h.open(); await h.action('proposal');
    h.state.fault = async (path, response) => { if (path.endsWith('/review') && response.ok)
      throw Object.assign(new Error('lost_ack'), { status: 503 }); };
    await h.action('approve'); const original = h.writes()[0]?.body;
    h.state.fault = undefined; h.state.actor = 'peer'; await h.open();
    expect(h.node('retry-ticket').hidden).toBe(true); await h.action('retry-ticket'); expect(h.writes()).toHaveLength(1);
    expect(h.panel.pendingOwners()[0]).toMatchObject({ actorSubject: h.f.principals.staff, acknowledged: false });
    h.state.actor = 'staff'; await h.open(); await h.action('retry-ticket');
    expect(h.writes().at(-1)?.body).toBe(original); expect(h.panel.hasPending()).toBe(false);
  });

  it('the independent review switch is OFF while ordinary engineering intake remains enabled', async () => {
    const h = await harness(); h.state.reviewEnabled = false; await h.open();
    const count = h.calls.length; expect(h.node('proposal').disabled).toBe(true); expect(h.node('approve').disabled).toBe(true);
    await h.action('proposal'); await h.action('approve'); expect(h.calls).toHaveLength(count);
    expect(h.writes()).toEqual([]); expect(h.f.engineering.state.creates).toEqual([]);
  });

  it('default intake OFF causes no requests or model work', async () => {
    const h = await harness(); const modelCalls = h.f.engineering.state.modelCalls;
    h.state.enabled = false; await h.open(); expect(h.calls).toEqual([]); expect(h.root.hidden).toBe(true);
    expect(h.node('approve').disabled).toBe(true); expect(h.node('reject').disabled).toBe(true);
    expect(h.f.engineering.state.modelCalls).toBe(modelCalls); expect(h.f.engineering.state.creates).toEqual([]);
  });
});
