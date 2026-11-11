import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { authenticate } from '../worker/src/api-auth';
import { IDENTITY_ISSUER } from '../worker/src/identity-api';
import { createSupportApi } from '../worker/src/support-api';
import { engineeringTicketId } from '../worker/src/support-engineering-fixtures';
import { createSupportEngineeringHttpFixture, type EngineeringHttpActor } from '../worker/src/support-engineering-http-fixtures';
import { BrowserNode, browserGate } from './test-support-browser';

// The real template and all three real scripts run over real HTTP/auth/SDK
// factories. This inert DOM models event ordering for a fictional ticket.
function documentFromTemplate() {
  const template = readFileSync(new URL('./pages/staff/support/ticket.astro', import.meta.url), 'utf8');
  const root = new BrowserNode('document'); const stack = [root];
  const voidTags = new Set(['input', 'img', 'link', 'meta', 'br', 'hr']);
  for (const match of template.matchAll(/<(\/?)([a-z][a-z0-9-]*)([^>]*?)>/giu)) {
    const tag = match[2]?.toLowerCase() ?? '';
    if (match[1]) { const last = stack.findLastIndex((node) => node.tagName === tag); if (last > 0) stack.splice(last); continue; }
    const node = new BrowserNode(tag); const attributes = match[3] ?? '';
    for (const attr of attributes.matchAll(/([\w:-]+)(?:="([^"]*)")?/gu)) if (attr[1]) node.attributes.set(attr[1], attr[2] ?? '');
    node.hidden = node.attributes.has('hidden'); node.disabled = node.attributes.has('disabled');
    node.checked = node.attributes.has('checked'); node.value = node.attributes.get('value') ?? '';
    stack.at(-1)?.append(node);
    if (!voidTags.has(tag) && !attributes.endsWith('/')) stack.push(node);
  }
  for (const node of root.all().filter((value) => value.tagName === 'select'))
    node.value = node.all().find((value) => value.tagName === 'option')?.value ?? '';
  return Object.assign(root, { createElement: (tag: string) => new BrowserNode(tag) });
}
const disposers = new Set<() => void>();
afterEach(() => { for (const dispose of [...disposers]) dispose(); });
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 1500; attempt++) {
    if (check()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('Actual engineering controller did not settle');
}
async function fixture() {
  const f = await createSupportEngineeringHttpFixture(); await f.legacyTicket();
  const state = { actor: 'staff' as EngineeringHttpActor, loseEngineering: false,
    holdOrdinary: undefined as ReturnType<typeof browserGate<void>> | undefined,
    ordinaryResponse: undefined as ReturnType<typeof browserGate<Response>> | undefined };
  const api = createSupportApi({ ...f.options, application: f.engineering.application,
    createLimiter: f.host.createLimiter, replyLimiter: f.host.replyLimiter,
    engineering: { enabled: () => true, configuration: f.options } });
  const document = documentFromTemplate(); const calls: { path: string; method: string; body?: string }[] = [];
  const window = Object.assign(new EventTarget(), { location: {
    href: IDENTITY_ISSUER + '/staff/support/ticket/?id=' + engineeringTicketId,
    reload() { throw new Error('Retained owner must remain in this page'); },
  } });
  let active = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  class FormDataAdapter {
    constructor(readonly form: BrowserNode) {}
    get(name: string) { return this.form.all().find((node) => node.attributes.get('name') === name)?.value ?? null; }
  }
  const context = createContext({ document, window, URL, URLSearchParams, Headers, Date, AbortController, TextEncoder,
    FormData: FormDataAdapter, crypto: { randomUUID: () => randomUUID().toUpperCase() },
    setTimeout(run: () => void, duration: number) {
      const timer = setTimeout(() => { timers.delete(timer); run(); }, duration); timers.add(timer); return timer;
    },
    clearTimeout(timer: ReturnType<typeof setTimeout>) { timers.delete(timer); clearTimeout(timer); },
    async fetch(path: string, init: RequestInit = {}) {
      ++active;
      try {
        const headers = new Headers(init.headers); headers.set('Cookie', f.cookies.get(state.actor)!);
        const method = init.method ?? 'GET';
        if (method === 'POST' || method === 'PATCH') { headers.set('Origin', IDENTITY_ISSUER); headers.set('Sec-Fetch-Site', 'same-origin'); }
        calls.push({ path, method, ...(typeof init.body === 'string' ? { body: init.body } : {}) });
        const request = new Request(IDENTITY_ISSUER + path, { ...init, headers });
        let response: Response;
        if (path === '/api/identity/session') {
          const value = await authenticate(request, f.options);
          response = value === null ? Response.json({ error: 'authentication_required' }, { status: 401 })
            : Response.json({ account: { subject: value.link.subject }, csrfToken: value.csrfToken });
        } else response = await api(request);
        if (method === 'POST' && path.endsWith('/messages') && state.holdOrdinary) {
          state.ordinaryResponse?.resolve(response);
          await state.holdOrdinary.promise;
        }
        if (method === 'POST' && path.includes('/engineering/') && response.ok && state.loseEngineering) {
          state.loseEngineering = false; return Response.json({ error: 'synthetic_lost_ack' }, { status: 503 });
        }
        return response;
      } finally { --active; }
    },
  });
  for (const name of ['staff-support-learning.js', 'staff-support-engineering.js', 'staff-support-ticket.js'])
    runInContext(readFileSync(new URL('../public/' + name, import.meta.url), 'utf8'), context, { filename: name });
  const node = (id: string) => {
    const value = document.querySelector('#' + id); if (!value) throw new Error('Missing actual page node ' + id); return value;
  };
  const control = (action: string) => {
    const value = node('staff-engineering-panel').all().find((item) => item.dataset.engineeringAction === action);
    if (!value) throw new Error('Missing engineering action ' + action); return value;
  };
  const dispose = () => { window.dispatchEvent(new Event('pagehide')); for (const timer of timers) clearTimeout(timer); timers.clear(); disposers.delete(dispose); };
  disposers.add(dispose);
  const idle = () => until(() => active === 0 && !control('refresh').disabled);
  await until(() => !node('staff-engineering-panel').hidden && !control('refresh').disabled && active === 0);
  return { f, state, api, calls, node, control, idle, window };
}

describe('registered staff controller and engineering panel composition', () => {
  it('admits source-zero evidence only after actual enrollment and a fresh same-actor staff detail', async () => {
    const h = await fixture();
    expect(h.control('enroll').disabled).toBe(false); expect(h.control('evidence').disabled).toBe(true);
    h.control('enroll').fire('click'); await h.idle();
    expect(h.control('evidence').disabled).toBe(false);
    const index = h.calls.findIndex((call) => call.method === 'POST' && call.path.endsWith('/engineering/enroll'));
    expect(index).toBeGreaterThanOrEqual(0);
    expect(h.calls.slice(index + 1).some((call) => call.path === '/api/support/admin/tickets/' + engineeringTicketId)).toBe(true);
    expect(h.f.engineering.state.modelCalls).toBe(0); expect(h.f.engineering.state.creates).toEqual([]);
  });

  it('holds ordinary writes during a committed engineering ACK and recovers the exact original packet', async () => {
    const h = await fixture(); const entered = browserGate<void>(); const release = browserGate<void>();
    h.f.hooks.commit = async () => { entered.resolve(); await release.promise; };
    h.state.loseEngineering = true; h.control('enroll').fire('click');
    try {
      await entered.promise;
      const before = h.calls.length; h.node('compose-body').value = 'A fictional reply retained while engineering is pending.';
      h.node('staff-compose-form').fire('submit');
      expect(h.calls).toHaveLength(before); expect(h.node('compose-submit').disabled).toBe(true);
    } finally { delete h.f.hooks.commit; release.resolve(); }
    await until(() => !h.control('retry-ticket').hidden && !h.control('retry-ticket').disabled);
    const original = h.calls.find((call) => call.method === 'POST' && call.path.endsWith('/engineering/enroll'));
    if (!original) throw new Error('Missing actual retained enrollment');
    const rows = await h.f.rows(); h.control('retry-ticket').fire('click'); await h.idle();
    expect(h.calls.filter((call) => call.method === 'POST' && call.path === original.path)).toEqual([original, original]);
    expect(await h.f.rows()).toEqual(rows);
    expect(h.node('compose-body').value).toBe('A fictional reply retained while engineering is pending.');
    expect(h.f.engineering.state.modelCalls).toBe(0); expect(h.f.engineering.state.creates).toEqual([]);
  });

  it('holds engineering admission while an ordinary real SDK reply awaits its ACK', async () => {
    const h = await fixture(); const release = browserGate<void>(); const returned = browserGate<Response>();
    h.state.holdOrdinary = release; h.state.ordinaryResponse = returned;
    const form = h.node('staff-compose-form');
    h.node('compose-body').value = 'A fictional current staff reply.';
    form.fire('input');
    expect(h.node('compose-submit').disabled).toBe(true);
    // The real page deliberately has no default public/internal compose mode.
    for (const input of form.all())
      if (input.attributes.get('name') === 'composeMode') input.checked = input.value === 'public';
    form.fire('change');
    expect(h.node('compose-submit').disabled).toBe(false);
    form.fire('submit');
    let ordinary: (typeof h.calls)[number] | undefined;
    let committedRows: Awaited<ReturnType<typeof h.f.rows>> | undefined;
    try {
      // Hold only the transport ACK after the actual HTTP/SDK mutation returns.
      expect((await returned.promise).status).toBe(201);
      ordinary = h.calls.find((call) => call.method === 'POST' && call.path.endsWith('/messages'));
      expect(ordinary).toBeDefined();
      committedRows = await h.f.rows();
      expect(committedRows.some((row) => row.kind === 'message' && row.message.body === 'A fictional current staff reply.')).toBe(true);
      expect(h.node('compose-submit').disabled).toBe(true);
      const writes = h.calls.filter((call) => call.method === 'POST').length;
      h.control('enroll').fire('click');
      expect(h.calls.filter((call) => call.method === 'POST')).toHaveLength(writes);
      expect(h.calls.some((call) => call.method === 'POST' && call.path.endsWith('/engineering/enroll'))).toBe(false);
    } finally { h.state.holdOrdinary = undefined; h.state.ordinaryResponse = undefined; release.resolve(); }
    await h.idle();
    expect(h.calls.filter((call) => call.method === 'POST' && call.path.endsWith('/messages'))).toEqual([ordinary]);
    expect(await h.f.rows()).toEqual(committedRows);
    expect(h.f.engineering.state.modelCalls).toBe(0);
  });
});
