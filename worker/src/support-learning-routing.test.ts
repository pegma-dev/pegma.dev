import { identityLinkKeyFromVerifiedIdentityClaims } from '@pegma/authorization-identity';
import { createMemoryStore } from '@pegma/storage-core';
import { describe, expect, it } from 'vitest';
import { createAgentPrincipalResolver } from './agent-authority';
import { isPlainObject } from './api-auth';
import { IDENTITY_ISSUER, SESSION_COOKIE } from './identity-api';
import { createIdentityRuntime } from './identity-runtime';
import { ADMIN_ROLE, APPLICATION_SCOPE, KNOWLEDGE_ROLE, SUPPORT_ROLE } from './support-access';
import { createSupportApi } from './support-api';
import { createSupportRuntime } from './support-desk';
import { createSupportLearningRuntime } from './support-learning';
import { createSupportLearningFixture, learningTicketId } from './support-learning-fixtures';
import { createSupportLearningHandlers } from './support-learning-handlers';

type Actor = 'staff' | 'support' | 'customer' | 'admin' | 'knowledge';
const base = '/api/support/admin/tickets/' + learningTicketId;
async function json(response: Response) {
  const value: unknown = await response.json();
  if (!isPlainObject(value)) throw new Error('Expected actual route JSON');
  return value;
}
async function fixture() {
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

describe('optional public learning namespace through actual Support router/auth/SDK', () => {
  it('keeps the old staff and customer detail JSON unchanged when the callback is omitted', async () => {
    const f = await fixture(); await f.learning.terminal();
    const legacy = createSupportApi(f.options);
    const before = await json(await legacy(f.request()));
    expect(before).not.toHaveProperty('learningEnabled');
    expect(Object.keys(before).sort()).toEqual(['csrfToken', 'messages', 'ticket']);
    const customerPath = '/api/support/tickets/' + learningTicketId;
    const customer = await json(await legacy(f.request(customerPath, 'customer')));
    const configuredCustomer = await json(await f.api(f.request(customerPath, 'customer')));
    expect(configuredCustomer).toEqual(customer);
    expect(configuredCustomer).not.toHaveProperty('learningEnabled');
  });

  it('preserves actual legacy customer reply receipts through the optional router', async () => {
    const f = await fixture(); await f.learning.terminal();
    const legacy = createSupportApi(f.options);
    const principal = f.principals.customer;
    const packet = { command: { version: 1, expectedAccountId: principal,
      commandId: principal + '~ABCDEFAB-1234-4ABC-8DEF-ABCDEF123456',
      messageId: principal + '~ABCDEFAB-1234-4ABC-8DEF-ABCDEF123457' }, body: 'A fictional follow-up question.' };
    const path = '/api/support/tickets/' + learningTicketId + '/replies';
    const first = await legacy(f.request(path, 'customer', packet, { 'X-Pegma-Support-Command': '1' }));
    expect(first.status).toBe(201);
    const rows = JSON.stringify(await f.learning.rows());
    const repeated = await f.api(f.request(path, 'customer', packet, { 'X-Pegma-Support-Command': '1' }));
    expect(repeated.status).toBe(201);
    const current = await json(repeated);
    expect(current).toEqual(await json(first));
    expect(current).not.toHaveProperty('learningEnabled');
    expect(JSON.stringify(await f.learning.rows())).toBe(rows);
  });
  it('issues a current boolean from actual stored Support and session authority without role claims', async () => {
    const f = await fixture(); await f.learning.terminal();
    const current = await json(await f.api(f.request()));
    expect(current.learningEnabled).toBe(true);
    expect(current.csrfToken).toBe(f.csrf.get('staff'));
    expect(current).not.toHaveProperty('roles');
    const supportOnly = await json(await f.api(f.request(base, 'support')));
    expect(supportOnly.learningEnabled).toBe(true);
    for (const actor of ['admin', 'knowledge', 'customer'] as const)
      expect((await f.api(f.request(base, actor))).status).toBe(403);
  });

  it.each(['absent', 'flag-only', 'handler-only', 'false', 'throws', 'non-true'] as const)(
    'keeps the %s composition OFF404, including the legacy browser-command header', async (mode) => {
      const f = await fixture(); await f.learning.terminal();
      f.state.flagResult = mode === 'false' ? false : mode === 'non-true' ? 'true' : true;
      f.state.flagThrows = mode === 'throws';
      const composition = mode === 'absent' ? {} : mode === 'flag-only' ? { learningEnabled: f.configured.learningEnabled }
        : mode === 'handler-only' ? { learningHandler: f.configured.learningHandler } : f.configured;
      const api = createSupportApi({ ...f.options, ...composition });
      for (const suffix of ['', '/enroll', '/unknown']) {
        const response = await api(f.request(base + '/learning' + suffix, 'staff', suffix === '' ? undefined
          : { commandId: 'EXACT-UPPERCASE', expectedRevision: 1 }, { 'X-Pegma-Support-Command': '1' }));
        expect(response.status).toBe(404);
        expect(await json(response)).toEqual({ error: 'not_found' });
      }
      const detail = await json(await api(f.request()));
      if (mode === 'absent' || mode === 'handler-only') expect(detail).not.toHaveProperty('learningEnabled');
      else expect(detail.learningEnabled).toBe(false);
    },
  );

  it('dispatches genuine enrollment/evidence/proposal/review and exact replay before generic browser routing', async () => {
    const f = await fixture(); const ticket = await f.learning.terminal();
    const enroll = { commandId: 'ENROLL-EXACT-UPPERCASE', expectedRevision: ticket.revision };
    const enrolled = await f.api(f.request(base + '/learning/enroll', 'staff', enroll, { 'X-Pegma-Support-Command': '1' }));
    expect(enrolled.status).toBe(200);
    const source = (await json(enrolled)).result;
    if (!isPlainObject(source)) throw new Error('Expected actual source result');
    const evidence = { commandId: 'EVIDENCE-EXACT-UPPERCASE', expectedRevision: ticket.revision,
      resolutionCycle: source.resolutionCycle, solutionMessageId: 'learning-solution', verificationReference: 'SYNTHETIC_STAFF_VERIFICATION' };
    expect((await f.api(f.request(base + '/learning/evidence', 'staff', evidence))).status).toBe(200);
    const delivered = await f.learning.delivered();
    const shown = await json(await f.api(f.request(base + '/learning/proposal?sourceGeneration=' + delivered.source.sourceGeneration)));
    if (!isPlainObject(shown.result)) throw new Error('Expected actual checked proposal');
    if (!isPlainObject(shown.result.intent)) throw new Error('Expected the actual complete SDK review intent');
    const packet = { commandId: 'REVIEW-EXACT-UPPERCASE', intent: shown.result.intent, decision: 'approve' };
    const first = await f.api(f.request(base + '/learning/review', 'staff', packet));
    expect(first.status).toBe(200);
    const rows = JSON.stringify(await f.learning.rows());
    const replay = await f.api(f.request(base + '/learning/review', 'staff', packet));
    expect(replay.status).toBe(200);
    expect(await json(replay)).toEqual(await json(first));
    expect(JSON.stringify(await f.learning.rows())).toBe(rows);
    const draft = await f.learning.knowledge.getDraft(f.learning.actors.staff, { articleId: delivered.articleId });
    expect(draft.state).not.toBe('published');
  });

  it('keeps source/work separate from actual Knowledge permission and never derives access from a query', async () => {
    const f = await fixture(); const ticket = await f.learning.terminal();
    expect((await f.api(f.request(base + '/learning/enroll', 'staff', { commandId: 'ENROLL', expectedRevision: ticket.revision }))).status).toBe(200);
    const source = await f.learning.runtime.readSource(f.learning.actors.staff, learningTicketId);
    expect((await f.api(f.request(base + '/learning', 'support'))).status).toBe(200);
    expect((await f.api(f.request(base + '/learning/proposal?sourceGeneration=' + source.sourceGeneration, 'support'))).status).toBe(403);
    const forgedQuery = await f.api(f.request(base + '/learning?role=Support', 'admin'));
    // The closing real current-authority fence wins over the malformed query.
    expect(forgedQuery.status).toBe(403);
    expect(await json(forgedQuery)).toEqual({ error: 'forbidden' });
    expect((await f.api(f.request(base + '/learning', 'admin'))).status).toBe(403);
  });

  it.each(['session', 'role'] as const)('withholds the capability and private detail after actual %s loss during the read', async (kind) => {
    const f = await fixture(); await f.learning.terminal();
    f.state.afterDetail = async () => {
      f.state.afterDetail = undefined;
      if (kind === 'session') await f.sessions.destroy(f.ids.get('staff')!);
      else await f.revoke('staff', SUPPORT_ROLE);
    };
    const response = await f.api(f.request());
    expect(response.status).toBe(kind === 'session' ? 401 : 403);
    const denied = await json(response);
    expect(denied).not.toHaveProperty('ticket');
    expect(denied).not.toHaveProperty('learningEnabled');
  });

  it('rechecks the current route flag after an actual committed mutation without inventing rollback', async () => {
    const f = await fixture(); const ticket = await f.learning.terminal();
    const packet = { commandId: 'COMMIT-EXACT-UPPERCASE', expectedRevision: ticket.revision };
    f.state.afterHandler = async () => { f.state.flagResult = false; };
    expect((await f.api(f.request(base + '/learning/enroll', 'staff', packet))).status).toBe(404);
    const actual = await f.learning.runtime.readSource(f.learning.actors.staff, learningTicketId);
    expect(actual.state).toBe('unverified');
    f.state.afterHandler = undefined; f.state.flagResult = true;
    const rows = JSON.stringify(await f.learning.rows());
    expect((await f.api(f.request(base + '/learning/enroll', 'staff', packet))).status).toBe(200);
    expect(JSON.stringify(await f.learning.rows())).toBe(rows);
  });

  it('never falls unknown learning subpaths through to a legacy mutation', async () => {
    const f = await fixture(); await f.learning.terminal();
    const before = JSON.stringify(await f.learning.rows());
    expect((await f.api(f.request(base + '/learning/not-an-operation', 'staff', { action: 'close' }, { 'X-Pegma-Support-Command': '1' }))).status).toBe(404);
    expect(JSON.stringify(await f.learning.rows())).toBe(before);
  });
});
