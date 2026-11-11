import { identityLinkKeyFromVerifiedIdentityClaims } from '@pegma/authorization-identity';
import { createMemoryStore } from '@pegma/storage-core';
import { createSupportDeskApplication } from '@pegma/support-desk-application';
import { describe, expect, it } from 'vitest';
import { createAgentPrincipalResolver } from '../worker/src/agent-authority';
import { IDENTITY_ISSUER, SESSION_COOKIE } from '../worker/src/identity-api';
import { createIdentityRuntime } from '../worker/src/identity-runtime';
import { ADMIN_ROLE, APPLICATION_SCOPE, KNOWLEDGE_ROLE, SUPPORT_ROLE } from '../worker/src/support-access';
import { createSupportApi } from '../worker/src/support-api';
import { createSupportRuntime } from '../worker/src/support-desk';
import { createSupportLearningRuntime } from '../worker/src/support-learning';
import { createSupportLearningFixture, learningTicketId } from '../worker/src/support-learning-fixtures';
import { createSupportLearningHandlers } from '../worker/src/support-learning-handlers';

type Actor = 'staff' | 'support' | 'customer' | 'admin' | 'knowledge';
const base = '/api/support/admin/tickets/' + learningTicketId;
function isLearningPath(path: string) {
  const pathname = new URL(path, IDENTITY_ISSUER).pathname;
  return pathname === base + '/learning' || pathname.startsWith(base + '/learning/');
}
async function backend() {
  const store = createMemoryStore();
  const learning = await createSupportLearningFixture(store);
  const logger = { log() {} };
  const identityRuntime = createIdentityRuntime({ store, emailCodeSecretBase64: btoa('r'.repeat(32)),
    emailFrom: 'Pegma <synthetic@pegma.dev>', emailEnabled: false }, logger);
  const { identity, sessions } = identityRuntime;
  const host = createSupportRuntime({ store, identity, sessions, logger,
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims });
  const principals = { staff: learning.actors.staff.principalId, support: 'synthetic-routing-support',
    customer: learning.actors.customer.principalId, admin: 'synthetic-routing-admin', knowledge: 'synthetic-routing-knowledge' };
  const cookies = new Map<Actor, string>();
  const csrf = new Map<Actor, string>();
  const ids = new Map<Actor, string>();
  for (const [index, actor] of (Object.keys(principals) as Actor[]).entries()) {
    const principalId = principals[actor];
    await identity.provisionVerifiedUser({ principalId, email: actor + '@example.test' });
    const sessionId = String(index + 1).repeat(43);
    const token = String.fromCharCode(97 + index).repeat(43);
    await sessions.create(sessionId, { principalId, data: JSON.stringify({ version: 1,
      issuer: IDENTITY_ISSUER, subject: principalId, csrfToken: token }) });
    cookies.set(actor, SESSION_COOKIE + '=' + sessionId); csrf.set(actor, token); ids.set(actor, sessionId);
    const roles = actor === 'staff' ? [SUPPORT_ROLE, KNOWLEDGE_ROLE] : actor === 'support' ? [SUPPORT_ROLE]
      : actor === 'admin' ? [ADMIN_ROLE] : actor === 'knowledge' ? [KNOWLEDGE_ROLE] : [];
    for (const role of roles) await host.roleStore.grantRoleAssignmentWithAudit({ assignment: {
      id: 'routing-' + actor + '-' + role, principalId, role, scope: APPLICATION_SCOPE,
      grantedBy: { kind: 'system', systemId: 'synthetic-routing' }, grantedAtEpochMs: Date.now(), status: 'active',
    }, auditEventId: 'routing-grant-' + actor + '-' + role });
  }
  const authority = { identity, sessions, logger, roleStore: host.roleStore,
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims };
  const resolve = createAgentPrincipalResolver(authority);
  const runtime = createSupportLearningRuntime({ application: learning.application, knowledge: learning.knowledge,
    sources: learning.sources, clock: learning.clock, ports: learning.ports,
    staffAccess: { resolve }, processingEnabled: () => learning.state.enabled });
  const state = { enabled: true, flagResult: true as unknown, flagThrows: false,
    afterDetail: undefined as (() => Promise<void>) | undefined,
    afterHandler: undefined as (() => Promise<void>) | undefined };
  const actualHandler = createSupportLearningHandlers({ ...authority,
    enabled: () => state.enabled, runtime: () => runtime, limiter: host.replyLimiter });
  const learningHandler = async (request: Request) => {
    const response = await actualHandler(request); await state.afterHandler?.(); return response;
  };
  const options = { ...authority, createLimiter: host.createLimiter, replyLimiter: host.replyLimiter,
    application: { ...learning.application, async readStaffTicket(...args: Parameters<typeof learning.application.readStaffTicket>) {
      const value = await learning.application.readStaffTicket(...args); await state.afterDetail?.(); return value;
    } } };
  const configured = { learningHandler, learningEnabled: () => {
    if (state.flagThrows) throw new Error('Synthetic flag unavailable');
    return state.flagResult === true;
  } };
  const api = createSupportApi({ ...options, ...configured });
  function request(path = base, actor: Actor = 'staff', body?: unknown, extra: Record<string, string> = {}) {
    return new Request(IDENTITY_ISSUER + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: cookies.get(actor)!, ...extra, ...(body === undefined ? {} : {
        Origin: IDENTITY_ISSUER, 'Sec-Fetch-Site': 'same-origin', 'X-Pegma-CSRF': csrf.get(actor)!, 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function revoke(actor: Actor, role: string) {
    const id = 'routing-' + actor + '-' + role;
    const row = await host.roleStore.getRoleAssignment(id);
    if (row === null) throw new Error('Missing actual audited assignment');
    await host.roleStore.revokeRoleAssignmentWithAudit({ assignmentId: id, expectedConcurrencyToken: row.concurrencyToken,
      revokedBy: { kind: 'system', systemId: 'synthetic-routing' }, revokedAtEpochMs: Date.now(), auditEventId: 'routing-revoke-' + actor + '-' + role });
  }
  return { learning, identityRuntime, identity, sessions, host, options, configured, api, request, state, revoke,
    cookies, csrf, ids, principals, actualHandler };
}

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { afterEach } from 'vitest';
import { BrowserNode, browserGate } from './test-support-browser';

// Reuse the current Support test's inert DOM model with the real staff template.
// Both actual public scripts and actual HTTP/auth/SDK routes run in these cases;
// this is still a synthetic browser, not deployed layout or D1/Free admission proof.
function documentFromStaffTemplate() {
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
async function eventually(check: () => boolean, snapshot?: () => Promise<unknown>) {
  for (let index = 0; index < 250; index++) {
    if (check()) return;
    // Real SDK hashing and actual storage callbacks can yield past microtasks.
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  let details: unknown;
  if (snapshot) {
    try { details = await snapshot(); } catch { details = { diagnosticUnavailable: true }; }
  }
  throw new Error('Actual staff learning integration did not settle.' +
    (details === undefined ? '' : ' Body-free snapshot: ' + JSON.stringify(details)));
}
async function browser(f: Awaited<ReturnType<typeof backend>>, legacy = false) {
  const document = documentFromStaffTemplate();
  const calls: { path: string; method: string; body?: string; csrf: string | null;
    status?: number; serverStatus?: number; transportError?: boolean }[] = [];
  const state = { actor: 'staff' as Actor, lostAck: false, loseOrdinaryAck: false, postCommitLogout: false,
    loseReviewAck: false, loseCancelAck: false, postReviewLogout: false,
    pauseLearning: undefined as ReturnType<typeof browserGate<void>> | undefined,
    pauseOrdinaryAck: undefined as ReturnType<typeof browserGate<void>> | undefined,
    pauseCurrentDetail: undefined as ReturnType<typeof browserGate<void>> | undefined,
    loseMutationAck: false };
  let reloads = 0;
  let activeRequests = 0;
  const window = Object.assign(new EventTarget(), { location: {
    href: IDENTITY_ISSUER + '/staff/support/ticket/?id=' + learningTicketId,
    reload: () => { ++reloads; },
  } });
  const api = legacy ? createSupportApi(f.options) : f.api;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  class FormDataAdapter {
    constructor(readonly form: BrowserNode) {}
    get(name: string) { return this.form.all().find((node) => node.attributes.get('name') === name)?.value ?? null; }
  }
  const vm = createContext({ document, window, URL, URLSearchParams, Headers, Date, AbortController,
    FormData: FormDataAdapter, crypto: { randomUUID: () => randomUUID().toUpperCase() },
    setTimeout: (run: () => void, duration: number) => {
      const timer = setTimeout(() => { timers.delete(timer); run(); }, duration); timers.add(timer); return timer;
    },
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => { timers.delete(timer); clearTimeout(timer); },
    fetch: async (path: string, init: RequestInit = {}) => {
      ++activeRequests;
      let observed: (typeof calls)[number] | undefined;
      try {
      const headers = new Headers(init.headers); headers.set('Cookie', f.cookies.get(state.actor)!);
      if (init.method === 'POST' || init.method === 'PATCH') { headers.set('Origin', IDENTITY_ISSUER); headers.set('Sec-Fetch-Site', 'same-origin'); }
      observed = { path, method: init.method ?? 'GET', ...(typeof init.body === 'string' ? { body: init.body } : {}), csrf: headers.get('X-Pegma-CSRF') };
      calls.push(observed);
      if (isLearningPath(path) && state.pauseLearning) await state.pauseLearning.promise;
      const incoming = new Request(IDENTITY_ISSUER + path, { ...init, headers });
      const response = path.startsWith('/api/identity/') ? await f.identityRuntime.api(incoming) : await api(incoming);
      observed.serverStatus = response.status;
      const pathname = new URL(path, IDENTITY_ISSUER).pathname;
      const ordinaryMutation = (init.method === 'PATCH' && pathname === base) ||
        (init.method === 'POST' && (pathname === base + '/messages' || pathname === base + '/take-over'));
      // Defer delivery only after genuine route/SDK execution. No auth or
      // persistence result is synthesized by these ordering barriers.
      if (ordinaryMutation && state.pauseOrdinaryAck) await state.pauseOrdinaryAck.promise;
      // The real controller omits method for GET, as fetch permits. Hold the
      // normalized request method already recorded above, including default GET.
      if (observed.method === 'GET' && pathname === base && state.pauseCurrentDetail)
        await state.pauseCurrentDetail.promise;
      if (ordinaryMutation && response.ok && state.loseMutationAck) {
        state.loseMutationAck = false;
        observed.status = 503;
        return new Response(JSON.stringify({ error: 'synthetic_lost_ack' }), { status: 503 });
      }
      if (path.endsWith('/learning/enroll') && init.method === 'POST' && response.ok) {
        if (state.postCommitLogout) {
          state.postCommitLogout = false;
          await f.sessions.destroy(f.ids.get(state.actor)!);
          // The client must also fence an ACK against the closing real session.
        }
        if (state.lostAck) { state.lostAck = false; observed.status = 503; return new Response(JSON.stringify({ error: 'synthetic_lost_ack' }), { status: 503 }); }
      }
      if (init.method === 'POST' && path.endsWith('/learning/review') && response.ok && state.postReviewLogout) {
        state.postReviewLogout = false;
        await f.sessions.destroy(f.ids.get(state.actor)!);
      }
      if (init.method === 'POST' && response.ok &&
        ((path.endsWith('/learning/review') && state.loseReviewAck) ||
          (path.endsWith('/learning/review-cancel') && state.loseCancelAck))) {
        state.loseReviewAck = false; state.loseCancelAck = false; observed.status = 503;
        return new Response(JSON.stringify({ error: 'synthetic_lost_review_ack' }), { status: 503 });
      }
      if (path.endsWith('/messages') && init.method === 'POST' && response.ok && state.loseOrdinaryAck) {
        state.loseOrdinaryAck = false;
        observed.status = 503;
        return new Response(JSON.stringify({ error: 'synthetic_lost_ack' }), { status: 503 });
      }
      observed.status = response.status;
      return response;
      } catch (error) {
        if (observed) observed.transportError = true;
        throw error;
      } finally { --activeRequests; }
    },
  });
  runInContext(readFileSync(new URL('../public/staff-support-learning.js', import.meta.url), 'utf8'), vm);
  runInContext(readFileSync(new URL('../public/staff-support-ticket.js', import.meta.url), 'utf8'), vm);
  const node = (id: string) => { const value = document.querySelector('#' + id); if (!value) throw new Error('Missing actual staff node ' + id); return value; };
  const control = (key: string) => { const value = node('staff-learning-panel').all().find((value) => value.dataset.learningAction === key); if (!value) throw new Error('Missing learning action ' + key); return value; };
  const action = (key: string) => { control(key).fire('click'); };
  const field = (key: string) => { const value = node('staff-learning-panel').all().find((value) => value.dataset.learningField === key); if (!value) throw new Error('Missing learning field ' + key); return value; };
  const pending = () => runInContext('learningPending()', vm) as boolean;
  const writes = () => calls.filter((call) => call.method !== 'GET');
  const ordinaryPending = () => runInContext('ordinaryPacket !== null || takeoverPacket !== null', vm) as boolean;
  const admittedLearning = runInContext('learningRequest', vm) as (run: () => Promise<unknown>) => Promise<unknown>;
  const actualApi = runInContext('api', vm) as (path: string, init: RequestInit) => Promise<unknown>;
  const probeLearningAdmission = (expectedRevision: number) => admittedLearning(() => actualApi(base + '/learning/enroll', {
    method: 'POST', body: JSON.stringify({ commandId: 'QUEUED-ENROLL-MUST-STAY-BLOCKED', expectedRevision }),
  }));
  async function diagnose() {
    // Failure-only metadata: no DOM inputs, request bodies, credentials, hashes,
    // article text, candidate content, provenance or arbitrary SDK payloads.
    const sdkRead = (async () => {
      try {
        const source = await f.learning.runtime.readSource(f.learning.actors.staff, learningTicketId);
        const sourceFlags = { exists: true, generation: source.sourceGeneration,
          cycle: source.resolutionCycle, state: source.state,
          held: source.heldReason !== undefined, reconciliationPending: source.reconciliationPending };
        try {
          const work = await f.learning.runtime.readWork(f.learning.actors.staff,
            { ticketId: learningTicketId, sourceGeneration: source.sourceGeneration });
          return { source: sourceFlags, work: { exists: true, generation: work.workGeneration,
            status: work.status, stage: work.stage, hasTarget: work.target !== undefined } };
        } catch { return { source: sourceFlags, work: { exists: false, unavailable: true } }; }
      } catch { return { source: { exists: false, unavailable: true }, work: { unavailable: true } }; }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const diagnosticDeadline = new Promise<{ unavailable: true }>((resolve) => {
      timer = setTimeout(() => resolve({ unavailable: true }), 100);
    });
    let sdk: unknown;
    try { sdk = await Promise.race([sdkRead, diagnosticDeadline]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
    const panel = node('staff-learning-panel');
    const panelStatus = panel.all().find((value) => 'role' in value && value.role === 'status');
    return {
      actor: state.actor, pending: pending(), activeRequests, reloads,
      panelHidden: panel.hidden, detailHidden: node('staff-ticket-detail').hidden,
      signedOutHidden: node('staff-ticket-signed-out').hidden,
      forbiddenHidden: node('staff-ticket-forbidden').hidden,
      panelStatus: panelStatus?.textContent.slice(0, 240) ?? null,
      staffStatus: node('staff-ticket-status').textContent.slice(0, 240),
      controller: {
        authorityReloadRequired: runInContext('authorityReloadRequired', vm) as boolean,
        suspended: runInContext('suspended', vm) as boolean,
        generation: runInContext('readGeneration', vm) as number,
        busy: runInContext('busy !== null', vm) as boolean,
        learningRequests: runInContext('learningRequests', vm) as number,
        viewerMatchesActor: runInContext('viewer?.subject', vm) === f.principals[state.actor],
        csrfMatchesActor: runInContext('csrfToken', vm) === f.csrf.get(state.actor),
      },
      buttons: Object.fromEntries(['refresh', 'enroll', 'evidence', 'work', 'proposal',
        'approve', 'reject', 'withdraw', 'invalidate', 'retry'].map((key) => {
        const value = panel.all().find((value) => value.dataset.learningAction === key);
        return [key, value ? { hidden: value.hidden, disabled: value.disabled } : { missing: true }];
      })),
      requestCount: calls.length,
      requests: calls.slice(-32).map((call) => ({ method: call.method,
        path: call.path.slice(0, 300), status: call.status ?? null,
        serverStatus: call.serverStatus ?? null, transportError: call.transportError === true })),
      sdk,
    };
  }
  const wait = (check: () => boolean) => eventually(check, diagnose);
  const dispose = () => {
    state.pauseLearning?.resolve(); state.pauseOrdinaryAck?.resolve(); state.pauseCurrentDetail?.resolve();
    window.dispatchEvent(new Event('pagehide'));
    for (const timer of timers) clearTimeout(timer); timers.clear(); disposers.delete(dispose);
  };
  disposers.add(dispose);
  await wait(() => node('staff-ticket-detail').hidden === false || node('staff-ticket-signed-out').hidden === false || node('staff-ticket-forbidden').hidden === false);
  return { node, action, control, field, pending, ordinaryPending, probeLearningAdmission, state, calls, writes, window, document, dispose, wait, get reloads() { return reloads; },
    async idle() { await wait(() => activeRequests === 0); },
    async ready(phase: 'fresh' | 'unresolved' = 'fresh') {
      const unresolved = phase === 'unresolved';
      const expected = unresolved
        ? 'An earlier action is unresolved. Reads do not acknowledge it; retry the same action explicitly.'
        : 'Current source read. Each action is checked again by the server.';
      await wait(() => !node('staff-learning-panel').hidden && pending() === unresolved &&
        node('staff-learning-panel').all().some((value) => value.textContent === expected) &&
        (unresolved ? !control('retry').hidden && !control('retry').disabled && control('enroll').disabled
          : control('retry').hidden && !control('enroll').disabled));
    },
    async reload() { node('staff-ticket-reload').fire('click'); await wait(() => node('staff-ticket-detail').hidden === false); },
  };
}

describe('registered public staff ticket and learning panel with real auth/SDK routes', () => {

  it.each(['enroll', 'evidence'] as const)('reconciles a genuinely stale %s packet and restores fresh actions without rebinding its original bytes', async (operation) => {
    const f = await backend(); const ticket = await f.learning.terminal();
    const page = await browser(f); await page.ready();
    if (operation === 'evidence') {
      page.action('enroll'); await page.wait(() => !page.pending() && page.writes().length === 1);
      await page.reload(); await page.ready();
      page.field('solution').value = 'learning-solution'; page.field('verification').value = 'SYNTHETIC_STAFF_VERIFICATION';
    }
    const legacy = createSupportDeskApplication({ store: f.learning.store, clock: f.learning.clock });
    await legacy.addNote(f.learning.actors.staff, { ...f.learning.command('competing-intake-revision'), ticketId: learningTicketId,
      messageId: 'competing-intake-note', body: 'An independent fictional staff edit advances the ticket revision.' });
    page.action(operation);
    await page.wait(() => page.writes().some((call) => call.path.endsWith('/learning/' + operation) && call.status === 409));
    await page.idle(); expect(page.pending()).toBe(true); expect(page.node('action-reopen').disabled).toBe(true);
    const original = page.writes().find((call) => call.path.endsWith('/learning/' + operation))!;
    const before = await f.learning.rows();
    await page.reload(); await page.ready('unresolved'); page.action('retry');
    await page.wait(() => !page.pending()); await page.idle();
    const recovery = page.writes().find((call) => call.path.endsWith('/learning/' + operation + '-recovery'))!;
    expect(recovery.body).toBe(original.body); expect(recovery.serverStatus).toBe(200);
    expect(page.node('staff-learning-panel').textContent).toContain('fenced from future application');
    expect(page.node('staff-learning-panel').textContent).toContain('earlier outcome remains unknown');
    expect(page.node('action-reopen').disabled).toBe(false); expect(await f.learning.rows()).toEqual(before);
    await page.reload(); await page.ready();
    if (operation === 'evidence') {
      page.field('solution').value = 'learning-solution'; page.field('verification').value = 'SYNTHETIC_STAFF_VERIFICATION';
    }
    page.action(operation);
    await page.wait(() => !page.pending() && page.writes().some((call) => call.path.endsWith('/learning/' + operation) && call.status === 200));
    const fresh = page.writes().filter((call) => call.path.endsWith('/learning/' + operation)).at(-1)!;
    expect(JSON.parse(fresh.body ?? '{}').expectedRevision).toBe(ticket.revision + 1);
    expect(JSON.parse(fresh.body ?? '{}').commandId).not.toBe(JSON.parse(original.body ?? '{}').commandId);
    expect(f.learning.state.modelCalls).toBe(0);
  });


  it('retains a genuinely accepted review when its original session is destroyed before the client closing fence', async () => {
    const f = await backend(); await f.learning.enrollAndVerify(); await f.learning.delivered();
    const page = await browser(f); await page.ready();
    page.action('work'); await page.wait(() => page.node('staff-learning-panel').textContent.includes('Current learning work read.'));
    page.action('proposal'); await page.wait(() => page.node('staff-learning-panel').textContent.includes('Checked private KB proposal shown.'));
    page.state.postReviewLogout = true; page.action('approve');
    await page.wait(() => page.node('staff-ticket-signed-out').hidden === false); await page.idle();
    expect(page.pending()).toBe(true);
    expect(page.node('staff-learning-panel').hidden).toBe(true);
    expect(page.node('staff-learning-panel').textContent).not.toContain('Download and verify');
    expect(page.writes().find((call) => call.path.endsWith('/learning/review'))?.serverStatus).toBe(200);
    expect((await f.learning.rows()).filter((row) => row.kind === 'resolution_learning_review')).toHaveLength(1);
  });
  it('recovers a lost real review ACK through the actual controller after reopen and actual Knowledge revocation', async () => {
    const f = await backend(); await f.learning.enrollAndVerify(); await f.learning.delivered();
    const page = await browser(f); await page.ready();
    page.action('work'); await page.wait(() => page.node('staff-learning-panel').textContent.includes('Current learning work read.'));
    page.action('proposal'); await page.wait(() => page.node('staff-learning-panel').textContent.includes('Checked private KB proposal shown.'));
    page.state.loseReviewAck = true; page.action('approve');
    await page.wait(() => page.writes().some((call) => call.path.endsWith('/learning/review') && call.status === 503)); await page.idle();
    const original = page.writes().find((call) => call.path.endsWith('/learning/review'))!;
    await f.learning.application.reopenTicket(f.learning.actors.staff,
      { ...f.learning.command('controller-after-review-reopen'), ticketId: learningTicketId });
    await f.revoke('staff', KNOWLEDGE_ROLE);
    const before = await f.learning.rows(); const start = page.calls.length;
    page.action('check-review'); await page.wait(() => !page.pending()); await page.idle();
    const recovery = page.writes().find((call) => call.path.endsWith('/learning/review-receipt'))!;
    expect(recovery.body).toBe(original.body); expect(recovery.serverStatus).toBe(200);
    expect(page.calls.slice(start).some((call) => /\/learning(?:\/(?:work|proposal))?(?:\?|$)/u.test(call.path))).toBe(false);
    expect(await f.learning.rows()).toEqual(before);
  });

  it('keeps the actual controller pending after lost cancellation ACK and retries cancellation only', async () => {
    const f = await backend(); await f.learning.enrollAndVerify(); const delivered = await f.learning.delivered();
    const page = await browser(f); await page.ready();
    page.action('work'); await page.wait(() => page.node('staff-learning-panel').textContent.includes('Current learning work read.'));
    page.action('proposal'); await page.wait(() => page.node('staff-learning-panel').textContent.includes('Checked private KB proposal shown.'));
    const draft = await f.learning.knowledge.getDraft(f.learning.actors.staff, { articleId: delivered.articleId });
    await f.learning.knowledge.updateDraft(f.learning.actors.staff,
      { ...f.learning.command('controller-stale-target', draft.generation), articleId: delivered.articleId,
        collectionId: draft.revision.collectionId, draft: { kind: draft.revision.kind, title: 'Independently updated',
          summary: draft.revision.summary, content: draft.revision.content, tags: draft.revision.tags,
          applicability: draft.revision.applicability } });
    page.action('approve');
    await page.wait(() => page.writes().some((call) => call.path.endsWith('/learning/review') && call.status === 503)); await page.idle();
    const original = page.writes()[0]!;
    page.state.loseCancelAck = true; page.action('cancel-review');
    await page.wait(() => page.writes().some((call) => call.path.endsWith('/learning/review-cancel') && call.status === 503)); await page.idle();
    expect(page.pending()).toBe(true); const before = await f.learning.rows();
    page.action('retry'); await page.wait(() => !page.pending()); await page.idle();
    const reviews = page.writes().filter((call) => /\/learning\/review(?:-cancel)?$/u.test(call.path));
    expect(reviews.map((call) => call.path.split('/').at(-1))).toEqual(['review', 'review-cancel', 'review-cancel']);
    expect(reviews.every((call) => call.body === original.body)).toBe(true);
    expect(await f.learning.rows()).toEqual(before);
    expect(before.filter((row) => row.kind === 'resolution_learning_review')).toHaveLength(0);
  });

  it('mounts one persistent panel only from the current detail capability and leaves the legacy absence OFF', async () => {
    const f = await backend(); await f.learning.terminal();
    const old = await browser(f, true);
    expect(old.node('staff-learning-panel').hidden).toBe(true);
    expect(old.calls.some((call) => isLearningPath(call.path))).toBe(false);
    const current = await browser(f); await current.ready();
    expect(current.node('staff-learning-panel').hidden).toBe(false);
    const heading = current.node('staff-learning-panel').children[0];
    await current.reload(); await current.ready();
    expect(current.node('staff-learning-panel').children[0]).toBe(heading);
    expect(current.calls.some((call) => /roles|permissions/u.test(call.path))).toBe(false);
  });

  it('enrolls actual unverified0, accepts first staff evidence and opens only actual eligible1 work', async () => {
    const f = await backend(); const ticket = await f.learning.terminal();
    const page = await browser(f); await page.ready();
    page.action('enroll');
    await page.wait(() => !page.pending() && page.writes().length === 1 &&
      page.node('staff-learning-panel').textContent.includes('Action acknowledged.'));
    const initial = await f.learning.runtime.readSource(f.learning.actors.staff, learningTicketId);
    expect(initial).toMatchObject({ state: 'unverified', sourceGeneration: 0, resolutionCycle: 1 });
    await page.reload(); await page.ready();
    expect(page.control('evidence').disabled).toBe(false);
    expect(page.control('work').disabled).toBe(true);
    expect(page.control('proposal').disabled).toBe(true);
    page.action('work'); page.action('proposal');
    expect(page.calls.some((call) => /\/learning\/(work|proposal)\?/u.test(call.path))).toBe(false);
    page.field('solution').value = 'learning-solution';
    page.field('verification').value = 'SYNTHETIC_STAFF_VERIFICATION';
    page.action('evidence');
    await page.wait(() => !page.pending() && page.writes().length === 2 &&
      page.node('staff-learning-panel').textContent.includes('Action acknowledged.'));
    const packet = JSON.parse(page.writes()[1]?.body ?? '{}');
    expect(packet).toMatchObject({ expectedRevision: ticket.revision, resolutionCycle: 1,
      solutionMessageId: 'learning-solution', verificationReference: 'SYNTHETIC_STAFF_VERIFICATION' });
    expect(packet).not.toHaveProperty('sourceGeneration');
    const eligible = await f.learning.runtime.readSource(f.learning.actors.staff, learningTicketId);
    expect(eligible).toMatchObject({ state: 'eligible', sourceGeneration: 1, resolutionCycle: 1 });
    expect(f.learning.state.modelCalls).toBe(0);
    await page.reload(); await page.ready();
    expect(page.control('work').disabled).toBe(false);
    expect(page.control('proposal').disabled).toBe(true);
    page.action('work');
    await page.wait(() => page.node('staff-learning-panel').textContent.includes('Current learning work read.'));
    expect(page.calls.some((call) => call.path === base + '/learning/work?sourceGeneration=1')).toBe(true);
    expect(page.calls.some((call) => /sourceGeneration=0(?:&|$)/u.test(call.path))).toBe(false);
    expect(f.learning.state.modelCalls).toBe(0);
  });

  it('acknowledges actual held0 evidence without inventing eligibility or work', async () => {
    const f = await backend(); await f.learning.terminal();
    const page = await browser(f); await page.ready();
    page.action('enroll'); await page.wait(() => !page.pending() && page.writes().length === 1 &&
      page.node('staff-learning-panel').textContent.includes('Action acknowledged.'));
    await page.reload(); await page.ready();
    f.learning.state.product = 'missing';
    page.field('solution').value = 'learning-solution';
    page.field('verification').value = 'SYNTHETIC_STAFF_VERIFICATION';
    page.action('evidence'); await page.wait(() => !page.pending() && page.writes().length === 2 &&
      page.node('staff-learning-panel').textContent.includes('Action acknowledged.'));
    const held = await f.learning.runtime.readSource(f.learning.actors.staff, learningTicketId);
    expect(held).toMatchObject({ state: 'held', sourceGeneration: 0, resolutionCycle: 1,
      heldReason: 'product_context_unavailable' });
    await page.reload(); await page.ready();
    expect(page.control('evidence').disabled).toBe(false);
    expect(page.control('work').disabled).toBe(true);
    expect(page.control('proposal').disabled).toBe(true);
    expect(page.calls.some((call) => /\/learning\/(work|proposal)\?/u.test(call.path))).toBe(false);
    expect(f.learning.state.modelCalls).toBe(0);
  });
  it('uses real current session/CSRF to enroll and records one SDK effect after lost ACK and exact uppercase retry', async () => {
    const f = await backend(); await f.learning.terminal();
    const page = await browser(f); await page.ready();
    page.state.lostAck = true; page.action('enroll');
    await page.wait(() => page.pending() && page.node('staff-learning-panel').textContent.includes('may have completed'));
    const first = page.writes().find((call) => call.path.endsWith('/learning/enroll'))!;
    const command = JSON.parse(first.body ?? '{}').commandId as string;
    expect(command).toBe(command.toUpperCase());
    expect(first.csrf).toBe(f.csrf.get('staff'));
    const source = await f.learning.runtime.readSource(f.learning.actors.staff, learningTicketId);
    expect(source.state).toBe('unverified');
    const rows = JSON.stringify(await f.learning.rows());
    const unload = new Event('beforeunload', { cancelable: true }); page.window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await page.reload(); await page.ready('unresolved');
    expect(page.pending()).toBe(true);
    expect(page.node('compose-submit').disabled).toBe(true);
    expect(page.node('action-take-over').disabled).toBe(true);
    page.action('retry'); await page.wait(() => !page.pending());
    const retries = page.writes().filter((call) => /\/learning\/enroll(?:-recovery)?$/u.test(call.path));
    expect(retries).toHaveLength(2); expect(retries[1]?.body).toBe(first.body);
    expect(JSON.stringify(await f.learning.rows())).toBe(rows);
    expect(page.reloads).toBe(0);
  });

  it('retains an unknown packet through actual logout and account A to B to A without automatic unload', async () => {
    const f = await backend(); await f.learning.terminal();
    const page = await browser(f); await page.ready();
    page.state.postCommitLogout = true; page.action('enroll');
    await page.wait(() => page.node('staff-ticket-signed-out').hidden === false);
    expect(page.pending()).toBe(true); expect(page.reloads).toBe(0);
    const signIn = page.node('staff-ticket-signed-out').querySelector('a') as BrowserNode & { target?: string };
    expect(signIn.target).toBe('_blank');
    const first = page.writes()[0]!;
    page.state.actor = 'support'; page.node('staff-ticket-reload').fire('click');
    await page.wait(() => page.node('staff-ticket-signed-out').hidden === false && page.calls.some((call) => call.path === base));
    expect(page.pending()).toBe(true);
    expect(page.writes()).toHaveLength(1);
    expect(page.node('staff-learning-panel').hidden).toBe(true);
    const newId = 'Z'.repeat(43); const newCsrf = 'z'.repeat(43);
    await f.sessions.create(newId, { principalId: f.principals.staff, data: JSON.stringify({ version: 1,
      issuer: IDENTITY_ISSUER, subject: f.principals.staff, csrfToken: newCsrf }) });
    f.cookies.set('staff', SESSION_COOKIE + '=' + newId); f.csrf.set('staff', newCsrf);
    page.state.actor = 'staff'; page.node('staff-ticket-reload').fire('click'); await page.ready('unresolved');
    page.action('retry'); await page.wait(() => !page.pending());
    expect(page.writes()[1]?.body).toBe(first.body); expect(page.writes()[1]?.csrf).toBe(newCsrf);
    expect(page.reloads).toBe(0);
  });

  it('reviews the actual separately checked draft using only its shown binding and never publishes it', async () => {
    const f = await backend(); await f.learning.enrollAndVerify(); const delivered = await f.learning.delivered();
    const page = await browser(f); await page.ready();
    page.action('work'); await page.wait(() => page.node('staff-learning-panel').textContent.includes('Current learning work read.'));
    expect(page.calls.some((call) => call.path.includes('/proposal?'))).toBe(false);
    page.action('proposal'); await page.wait(() => page.node('staff-learning-panel').textContent.includes('Checked private KB proposal shown.'));
    page.action('approve'); await page.wait(() => !page.pending() && page.writes().length === 1);
    const packet = JSON.parse(page.writes()[0]?.body ?? '{}');
    expect(Object.keys(packet).sort()).toEqual(['commandId', 'decision', 'intent']);
    expect(packet.intent.reviewerId).toBe(f.principals.staff);
    expect(packet.intent.target.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    const draft = await f.learning.knowledge.getDraft(f.learning.actors.staff, { articleId: delivered.articleId });
    expect(draft.state).toBe('draft');
  });

  it('keeps source/work available to stored Support while an actual separate Knowledge denial hides all private DOM', async () => {
    const f = await backend(); await f.learning.enrollAndVerify(); await f.learning.delivered();
    const page = await browser(f); await page.ready();
    page.state.actor = 'support'; page.node('staff-ticket-reload').fire('click'); await page.ready();
    page.action('work'); await page.wait(() => page.node('staff-learning-panel').textContent.includes('Current learning work read.'));
    page.action('proposal'); await page.wait(() => page.node('staff-ticket-forbidden').hidden === false);
    expect(page.node('staff-learning-panel').hidden).toBe(true);
    expect(page.node('staff-learning-panel').textContent).not.toContain('Download and verify');
    expect(page.writes()).toEqual([]);
  });

  it('preserves the existing unknown ordinary staff reply packet with the optional panel enabled', async () => {
    const f = await backend(); await f.learning.terminal();
    const page = await browser(f); await page.ready(); await page.idle();
    for (const input of page.node('staff-compose-form').all())
      if (input.attributes.get('name') === 'composeMode') input.checked = input.value === 'public';
    page.node('compose-body').value = 'A fictional public staff follow-up.';
    page.node('staff-compose-form').fire('change');
    page.state.loseOrdinaryAck = true; page.node('staff-compose-form').fire('submit');
    await page.wait(() => page.node('staff-ticket-detail').hidden && page.writes().length === 1);
    const first = page.writes()[0]!;
    expect(first.path).toBe(base + '/messages');
    await page.reload(); await page.idle();
    expect(page.node('staff-learning-panel').hidden).toBe(true);
    expect(page.node('compose-submit').disabled).toBe(false);
    const rows = JSON.stringify(await f.learning.rows());
    page.node('staff-compose-form').fire('submit');
    await page.wait(() => page.node('staff-ticket-status').textContent.includes('Public reply sent.'));
    const repeated = page.writes().filter((call) => call.path.endsWith('/messages'));
    expect(repeated).toHaveLength(2); expect(repeated[1]?.body).toBe(first.body);
    expect(JSON.stringify(await f.learning.rows())).toBe(rows);
  });
  it.each(['patch', 'reply', 'take-over'] as const)(
    'suspends learning during an actual %s and admits it only after the ACK and complete current GET', async (kind) => {
      const f = await backend(); await f.learning.terminal();
      if (kind === 'take-over') await f.learning.application.reopenTicket(f.learning.actors.staff,
        { ...f.learning.command('open-deferred-takeover'), ticketId: learningTicketId });
      const before = await f.learning.application.readStaffTicket(f.learning.actors.staff, learningTicketId);
      const page = await browser(f); await page.ready(); await page.idle();
      const staleEnroll = page.control('enroll');
      const ack = browserGate<void>(); page.state.pauseOrdinaryAck = ack;
      if (kind === 'patch') page.node('action-assign').fire('click');
      else if (kind === 'take-over') page.node('action-take-over').fire('click');
      else {
        for (const input of page.node('staff-compose-form').all())
          if (input.attributes.get('name') === 'composeMode') input.checked = input.value === 'public';
        page.node('compose-body').value = 'A fictional deferred ordinary reply.';
        page.node('staff-compose-form').fire('change'); page.node('staff-compose-form').fire('submit');
      }
      await page.wait(() => page.writes().length === 1 && page.writes()[0]?.serverStatus === (kind === 'reply' ? 201 : 200));
      expect(page.node('staff-learning-panel').hidden).toBe(true);
      expect(staleEnroll.disabled).toBe(true);
      staleEnroll.fire('click');
      await expect(page.probeLearningAdmission(before.ticket.revision)).rejects.toMatchObject({ stale: true });
      expect(page.writes().filter((call) => isLearningPath(call.path))).toEqual([]);
      expect(page.pending()).toBe(false);
      const current = browserGate<void>(); page.state.pauseCurrentDetail = current;
      page.state.pauseOrdinaryAck = undefined; ack.resolve();
      await page.wait(() => page.calls.some((call) => call.path === base && call.method === 'GET' &&
        call.serverStatus === 200 && call.status === undefined));
      expect(page.node('staff-learning-panel').hidden).toBe(true);
      staleEnroll.fire('click');
      await expect(page.probeLearningAdmission(before.ticket.revision)).rejects.toMatchObject({ stale: true });
      expect(page.writes().filter((call) => isLearningPath(call.path))).toEqual([]);
      page.state.pauseCurrentDetail = undefined; current.resolve();
      await page.ready(); await page.idle();
      expect(page.ordinaryPending()).toBe(false);
      const after = await f.learning.application.readStaffTicket(f.learning.actors.staff, learningTicketId);
      expect(after.ticket.revision).toBeGreaterThan(before.ticket.revision);
      page.action('enroll');
      await page.wait(() => !page.pending() && page.writes().filter((call) => isLearningPath(call.path)).length === 1 &&
        page.node('staff-learning-panel').textContent.includes('Action acknowledged.'));
      const enrollment = page.writes().find((call) => isLearningPath(call.path))!;
      expect(enrollment.path).toBe(base + '/learning/enroll');
      expect(JSON.parse(enrollment.body ?? '{}').expectedRevision).toBe(after.ticket.revision);
      expect(f.learning.state.modelCalls).toBe(0);
    },
  );

  it.each(['patch', 'reply', 'take-over'] as const)(
    'keeps learning blocked through an unknown actual %s ACK and a current GET until exact ordinary recovery', async (kind) => {
      const f = await backend(); await f.learning.terminal();
      if (kind === 'take-over') await f.learning.application.reopenTicket(f.learning.actors.staff,
        { ...f.learning.command('open-unknown-takeover'), ticketId: learningTicketId });
      const before = await f.learning.application.readStaffTicket(f.learning.actors.staff, learningTicketId);
      const page = await browser(f); await page.ready(); await page.idle();
      page.state.loseMutationAck = true;
      if (kind === 'patch') page.node('action-assign').fire('click');
      else if (kind === 'take-over') page.node('action-take-over').fire('click');
      else {
        for (const input of page.node('staff-compose-form').all())
          if (input.attributes.get('name') === 'composeMode') input.checked = input.value === 'public';
        page.node('compose-body').value = 'A fictional unknown ordinary reply.';
        page.node('staff-compose-form').fire('change'); page.node('staff-compose-form').fire('submit');
      }
      await page.wait(() => page.node('staff-ticket-detail').hidden && page.ordinaryPending() && page.writes().length === 1);
      const original = page.writes()[0]!;
      expect(original.serverStatus).toBe(kind === 'reply' ? 201 : 200);
      expect(original.status).toBe(503);
      await page.reload(); await page.idle();
      expect(page.ordinaryPending()).toBe(true);
      expect(page.node('staff-learning-panel').hidden).toBe(true);
      expect(page.control('enroll').disabled).toBe(true);
      page.action('enroll');
      await expect(page.probeLearningAdmission(before.ticket.revision)).rejects.toMatchObject({ stale: true });
      expect(page.writes()).toHaveLength(1);
      expect(page.pending()).toBe(false);
      const rows = JSON.stringify(await f.learning.rows());
      if (kind === 'patch') page.node('action-assign').fire('click');
      else if (kind === 'take-over') page.node('action-take-over').fire('click');
      else page.node('staff-compose-form').fire('submit');
      await page.ready(); await page.idle();
      expect(page.ordinaryPending()).toBe(false);
      const repeated = page.writes().filter((call) => !isLearningPath(call.path));
      expect(repeated).toHaveLength(2);
      expect(repeated[1]?.path).toBe(original.path);
      expect(repeated[1]?.method).toBe(original.method);
      expect(repeated[1]?.body).toBe(original.body);
      expect(JSON.stringify(await f.learning.rows())).toBe(rows);
      expect(page.writes().filter((call) => isLearningPath(call.path))).toEqual([]);
      expect(f.learning.state.modelCalls).toBe(0);
    },
  );
  it('does not let ordinary controls race an awaited learning request and clears the panel on page suspension', async () => {
    const f = await backend(); await f.learning.terminal();
    const page = await browser(f); await page.ready();
    page.state.pauseLearning = browserGate<void>();
    page.action('enroll');
    await page.wait(() => page.writes().length === 1);
    expect(page.node('action-assign').disabled).toBe(true);
    page.node('action-assign').fire('click');
    expect(page.writes()).toHaveLength(1);
    page.window.dispatchEvent(new Event('pagehide'));
    expect(page.node('staff-learning-panel').hidden).toBe(true);
    expect(page.node('staff-learning-panel').textContent).not.toContain('Source ');
    page.state.pauseLearning.resolve();
    await page.idle();
  });
});
