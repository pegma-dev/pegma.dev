import { identityLinkKeyFromVerifiedIdentityClaims } from '@pegma/authorization-identity';
import { createMemoryStore, type CollectionDefinition, type CollectionStore, type Store } from '@pegma/storage-core';
import { supportPermissions, supportRecords } from '@pegma/support-desk-application';
import { knowledgePermissions } from '@pegma/knowledge-base-contracts';
import { describe, expect, it, vi } from 'vitest';
import { createAgentPrincipalResolver } from './agent-authority';
import { isPlainObject } from './api-auth';
import { IDENTITY_ISSUER, SESSION_COOKIE } from './identity-api';
import { createIdentityRuntime } from './identity-runtime';
import {
  ADMIN_ROLE, APPLICATION_SCOPE, KNOWLEDGE_ROLE, SUPPORT_ROLE,
} from './support-access';
import { createSupportRuntime } from './support-desk';
import { controlledHumanBody } from './support-human-control-fixtures';
import { createSupportLearningRuntime } from './support-learning';
import {
  createSupportLearningFixture, learningCanary, learningTicketId,
} from './support-learning-fixtures';
import { createSupportLearningHandlers } from './support-learning-handlers';

const route = '/api/support/admin/tickets/' + learningTicketId + '/learning';
const uppercaseCommand = 'ABCDEFAB-1234-4ABC-8DEF-ABCDEF123456';
type Actor = 'staff' | 'support' | 'knowledge' | 'admin' | 'customer';

async function object(response: Response) {
  const value: unknown = await response.json();
  if (!isPlainObject(value)) throw new Error('Expected a JSON object');
  return value;
}
function result(value: Record<string, unknown>) {
  if (!isPlainObject(value.result)) throw new Error('Expected the actual SDK response');
  return value.result;
}
function number(value: unknown) {
  if (typeof value !== 'number') throw new Error('Expected a number');
  return value;
}
function text(value: unknown) {
  if (typeof value !== 'string') throw new Error('Expected a string');
  return value;
}

/** Actual Identity, session, audited host roles, limiter and both SDK factories. */
async function fixture() {
  const backing = createMemoryStore();
  const hooks: { commit?: () => Promise<void>; draft?: () => Promise<void> } = {};
  const store: Store = {
    collection<Value>(definition: CollectionDefinition<Value>): CollectionStore<Value> {
      const actual = backing.collection(definition);
      if (definition.name !== supportRecords.name) return actual;
      return { ...actual, async transact(partition, actions) {
        const value = await actual.transact(partition, actions);
        if (value.committed && partition === learningTicketId) await hooks.commit?.();
        return value;
      } };
    },
  };
  const learning = await createSupportLearningFixture(store);
  const logger = { log() {} };
  const identityRuntime = createIdentityRuntime({ store,
    emailCodeSecretBase64: btoa('l'.repeat(32)), emailFrom: 'Pegma <synthetic@pegma.dev>', emailEnabled: false }, logger);
  const { identity, sessions } = identityRuntime;
  const host = createSupportRuntime({ store, identity, sessions, logger,
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims });
  const principals = {
    staff: learning.actors.staff.principalId,
    support: 'synthetic-learning-support-only', knowledge: 'synthetic-learning-knowledge-only',
    admin: 'synthetic-learning-admin-only', customer: learning.actors.customer.principalId,
  };
  const cookies = new Map<Actor, string>();
  const csrf = new Map<Actor, string>();
  const sessionIds = new Map<Actor, string>();
  for (const [index, actor] of (Object.keys(principals) as Actor[]).entries()) {
    const principalId = principals[actor];
    await identity.provisionVerifiedUser({ principalId, email: actor + '@example.test' });
    const sessionId = String(index + 1).repeat(43);
    const token = String.fromCharCode(97 + index).repeat(43);
    await sessions.create(sessionId, { principalId, data: JSON.stringify({ version: 1,
      csrfToken: token, issuer: IDENTITY_ISSUER, subject: principalId }) });
    sessionIds.set(actor, sessionId); cookies.set(actor, SESSION_COOKIE + '=' + sessionId); csrf.set(actor, token);
    const roles = actor === 'staff' ? [SUPPORT_ROLE, KNOWLEDGE_ROLE] : actor === 'support' ? [SUPPORT_ROLE]
      : actor === 'knowledge' ? [KNOWLEDGE_ROLE] : actor === 'admin' ? [ADMIN_ROLE] : [];
    for (const role of roles) await host.roleStore.grantRoleAssignmentWithAudit({ assignment: {
      id: 'learning-http-' + actor + '-' + role, principalId, role, scope: APPLICATION_SCOPE,
      grantedBy: { kind: 'system', systemId: 'synthetic-learning-http' }, grantedAtEpochMs: Date.now(), status: 'active',
    }, auditEventId: 'learning-http-grant-' + actor + '-' + role });
  }
  const authority = { identity, sessions, logger, roleStore: host.roleStore,
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims };
  const resolve = createAgentPrincipalResolver(authority);
  const runtime = createSupportLearningRuntime({ application: learning.application, knowledge: learning.knowledge,
    sources: learning.sources, clock: learning.clock, ports: learning.ports,
    staffAccess: { resolve: (principalId) => resolve(principalId) }, processingEnabled: () => learning.state.enabled });
  const state = { enabled: true, runtimeCalls: 0, runtime, captured: [] as string[] };
  const options = {
    ...authority,
    enabled: () => state.enabled,
    runtime: () => { state.runtimeCalls += 1; return state.runtime; },
    knowledge: { getProvenance: learning.knowledge.getProvenance, async getDraft(...args: Parameters<typeof learning.knowledge.getDraft>) {
      const draft = await learning.knowledge.getDraft(...args); await hooks.draft?.(); return draft;
    } },
    reviewPolicy: learning.ports.checks,
    clock: learning.clock,
    limiter: host.replyLimiter,
  };
  const handle = createSupportLearningHandlers(options);
  function request(operation = '', body?: unknown, actor: Actor = 'staff', query = '') {
    const headers: Record<string, string> = { Cookie: cookies.get(actor)! };
    if (body !== undefined) Object.assign(headers, { Origin: IDENTITY_ISSUER,
      'X-Pegma-CSRF': csrf.get(actor)!, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' });
    return new Request(IDENTITY_ISSUER + route + (operation === '' ? '' : '/' + operation) + query,
      { method: body === undefined ? 'GET' : 'POST', headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function send(input: Request) {
    const response = await handle(input);
    if (response === null) throw new Error('Expected an owned learning route');
    return response;
  }
  async function revoke(actor: Actor, role: string) {
    const assignmentId = 'learning-http-' + actor + '-' + role;
    const row = await host.roleStore.getRoleAssignment(assignmentId);
    if (row === null) throw new Error('Missing real role assignment');
    return host.roleStore.revokeRoleAssignmentWithAudit({ assignmentId, expectedConcurrencyToken: row.concurrencyToken,
      revokedBy: { kind: 'system', systemId: 'synthetic-learning-http' }, revokedAtEpochMs: Date.now(),
      auditEventId: 'learning-http-revoke-' + actor + '-' + role });
  }
  async function verified() {
    const ticket = await learning.terminal();
    const enrolled = await send(request('enroll', { commandId: uppercaseCommand, expectedRevision: ticket.revision }));
    expect(enrolled.status).toBe(200);
    const source = result(await object(enrolled));
    const verifiedPacket = { commandId: 'VERIFIED-FIX-EXACT', expectedRevision: ticket.revision,
      resolutionCycle: number(source.resolutionCycle), solutionMessageId: 'learning-solution',
      verificationReference: 'SYNTHETIC_STAFF_VERIFICATION' };
    const accepted = await send(request('evidence', verifiedPacket));
    expect(accepted.status).toBe(200);
    return { ticket, source: result(await object(accepted)), verifiedPacket };
  }
  async function proposal() {
    await verified();
    const delivered = await learning.delivered();
    const response = await send(request('proposal', undefined, 'staff', '?sourceGeneration=' + delivered.source.sourceGeneration));
    expect(response.status).toBe(200);
    const view = result(await object(response));
    return { delivered, view, packet: { commandId: 'REVIEW-EXACT', sourceGeneration: number(view.sourceGeneration),
      expectedWorkGeneration: number(view.expectedWorkGeneration), reviewBindingHash: text(view.reviewBindingHash), decision: 'approve' } };
  }
  return { learning, host, identity, sessions, principals, cookies, csrf, hooks, state, options, resolve, handle,
    request, send, revoke, verified, proposal,
    destroy: (actor: Actor) => sessions.destroy(sessionIds.get(actor)!),
  };
}

describe('unregistered staff learning HTTP with current public host authority', () => {
  it('defaults OFF before lazy runtime construction and leaves unrelated routes unclaimed', async () => {
    const f = await fixture();
    const { enabled, ...options } = f.options;
    void enabled;
    const handle = createSupportLearningHandlers(options);
    const response = await handle(f.request());
    expect(response?.status).toBe(503);
    expect(f.state.runtimeCalls).toBe(0);
    expect(await handle(new Request(IDENTITY_ISSUER + '/api/support/tickets'))).toBeNull();
    expect(f.learning.state.modelCalls).toBe(0);
  });

  it('uses real separate Support/Knowledge grants without granting human process or administrator Support powers', async () => {
    const f = await fixture();
    const staff = await f.resolve(f.principals.staff);
    const support = await f.resolve(f.principals.support);
    const knowledge = await f.resolve(f.principals.knowledge);
    const admin = await f.resolve(f.principals.admin);
    expect(staff?.permissions).toContain(supportPermissions.learningRead);
    expect(staff?.permissions).toContain(knowledgePermissions.draftRead);
    expect(support?.permissions).not.toContain(knowledgePermissions.draftRead);
    expect(knowledge?.permissions).not.toContain(supportPermissions.learningReview);
    expect(admin?.permissions).not.toContain(supportPermissions.learningRead);
    expect(staff?.permissions).not.toContain(supportPermissions.learningProcess);
  });

  it('enrolls and records an actual staff-verified fix, preserving uppercase command bytes and exact replay', async () => {
    const f = await fixture(); const ticket = await f.learning.terminal();
    const original = f.state.runtime;
    f.state.runtime = { ...original, async enroll(access, packet) {
      f.state.captured.push(packet.clientCommandId); return original.enroll(access, packet);
    } };
    const packet = { commandId: uppercaseCommand, expectedRevision: ticket.revision };
    const first = await object(await f.send(f.request('enroll', packet)));
    const rows = await f.learning.rows();
    expect(await object(await f.send(f.request('enroll', packet)))).toEqual(first);
    expect(await f.learning.rows()).toEqual(rows);
    expect(f.state.captured).toEqual([uppercaseCommand, uppercaseCommand]);
    const source = result(first);
    const response = await f.send(f.request('evidence', { commandId: 'FIX-EXACT', expectedRevision: ticket.revision,
      resolutionCycle: source.resolutionCycle, solutionMessageId: 'learning-solution', verificationReference: 'SYNTHETIC_VERIFIED_FIX' }));
    expect(result(await object(response))).toMatchObject({ state: 'eligible', ticketId: learningTicketId });
    const actual = await f.learning.runtime.readSource(f.learning.actors.staff, learningTicketId);
    expect(actual.evidence).toMatchObject({ kind: 'staff_verified_fix', actorId: f.principals.staff });
    expect(f.learning.state.modelCalls).toBe(0);
  });

  it('returns the actual checked private draft, reviews its exact server target and replays a lost ACK without duplicate rows', async () => {
    const f = await fixture(); const { packet, delivered, view } = await f.proposal();
    expect(view.draft).toEqual(await f.learning.knowledge.getDraft(f.learning.actors.staff, { articleId: delivered.articleId }));
    expect(JSON.stringify(view)).not.toContain(learningCanary);
    const original = f.state.runtime; let lose = true;
    f.state.runtime = { ...original, async reviewProposal(access, input) {
      const value = await original.reviewProposal(access, input);
      if (lose) { lose = false; throw new Error('Synthetic post-commit response loss'); }
      return value;
    } };
    expect((await f.send(f.request('review', packet))).status).toBe(503);
    const rows = await f.learning.rows();
    expect(rows.some((row) => row.kind === 'resolution_learning_review')).toBe(true);
    expect((await f.send(f.request('review', packet))).status).toBe(200);
    expect(await f.learning.rows()).toEqual(rows);
    expect(f.learning.state.modelCalls).toBe(1);
  });

  it('keeps ordinary source/work projections body-free and requires separate KB authority for proposal and review', async () => {
    const f = await fixture(); const { packet, delivered } = await f.proposal();
    for (const operation of ['', 'work']) {
      const response = await f.send(f.request(operation, undefined, 'support', operation === '' ? '' : '?sourceGeneration=' + delivered.source.sourceGeneration));
      expect(response.status).toBe(200);
      const projected = result(await object(response));
      expect(projected).not.toHaveProperty('candidate'); expect(projected).not.toHaveProperty('exactRequest');
      expect(JSON.stringify(projected)).not.toContain('draftPayload');
      expect(JSON.stringify(projected)).not.toContain(learningCanary);
    }
    const before = await f.learning.rows();
    expect((await f.send(f.request('proposal', undefined, 'support', '?sourceGeneration=' + delivered.source.sourceGeneration))).status).toBe(403);
    expect((await f.send(f.request('review', packet, 'support'))).status).toBe(403);
    expect(await f.learning.rows()).toEqual(before);
  });

  it.each(['customer', 'knowledge', 'admin'] as const)('denies %s without current Support authority before any private factory call', async (actor) => {
    const f = await fixture();
    expect((await f.send(f.request('', undefined, actor))).status).toBe(403);
    expect(f.state.runtimeCalls).toBe(0);
  });

  it.each(['Origin', 'Authorization', 'X-Pegma-CSRF', 'Cookie'] as const)('rejects invalid browser %s before enrollment', async (header) => {
    const f = await fixture(); const ticket = await f.learning.terminal(); const rows = await f.learning.rows();
    const request = f.request('enroll', { commandId: 'INVALID-BROWSER', expectedRevision: ticket.revision });
    request.headers.set(header, header === 'Origin' ? 'https://foreign.example' : header === 'Authorization' ? 'Bearer synthetic' : 'invalid');
    const response = await f.send(request);
    expect([401, 403]).toContain(response.status);
    expect(await f.learning.rows()).toEqual(rows);
  });

  it.each([
    { actorId: 'forged' }, { productId: 'forged' }, { buildId: 'forged' }, { verifiedAt: '2026-11-10T12:00:00Z' },
    { provenance: [] }, { correlationId: 'forged' },
  ])('refuses extra authority/proof fields without a write: %j', async (extra) => {
    const f = await fixture(); const ticket = await f.learning.terminal(); const rows = await f.learning.rows();
    const response = await f.send(f.request('enroll', { commandId: 'CLOSED-PACKET', expectedRevision: ticket.revision, ...extra }));
    expect(response.status).toBe(400); expect(await f.learning.rows()).toEqual(rows);
  });

  it.each(['?sourceGeneration=0', '?sourceGeneration=1&sourceGeneration=1', '?sourceGeneration=9007199254740992', '?sourceGeneration=1&actor=forged'])('bounds the server-validated work key %s', async (query) => {
    const f = await fixture(); const rows = await f.learning.rows();
    expect((await f.send(f.request('work', undefined, 'staff', query))).status).toBe(400);
    expect(f.state.runtimeCalls).toBe(0); expect(await f.learning.rows()).toEqual(rows);
  });

  it('refuses changed exact command fields instead of silently rebinding a retained command', async () => {
    const f = await fixture(); const ticket = await f.learning.terminal();
    const packet = { commandId: uppercaseCommand, expectedRevision: ticket.revision };
    expect((await f.send(f.request('enroll', packet))).status).toBe(200);
    const rows = await f.learning.rows();
    expect((await f.send(f.request('enroll', { ...packet, expectedRevision: ticket.revision + 1 }))).status).toBe(409);
    expect(await f.learning.rows()).toEqual(rows);
  });

  it('rejects the shown review binding after a real KB draft edit', async () => {
    const f = await fixture(); const { packet, delivered } = await f.proposal();
    const draft = await f.learning.knowledge.getDraft(f.learning.actors.staff, { articleId: delivered.articleId });
    await f.learning.knowledge.updateDraft(f.learning.actors.staff, { ...f.learning.command('http-draft-edit', draft.generation),
      articleId: delivered.articleId, collectionId: draft.revision.collectionId,
      draft: { kind: draft.revision.kind, title: 'A separately edited guide', summary: draft.revision.summary,
        content: draft.revision.content, tags: draft.revision.tags, applicability: draft.revision.applicability } });
    const rows = await f.learning.rows();
    expect((await f.send(f.request('review', packet))).status).toBe(409);
    expect(await f.learning.rows()).toEqual(rows);
  });

  it('refuses forged or client-supplied review provenance and a mismatched review hash', async () => {
    const f = await fixture(); const { packet } = await f.proposal(); const rows = await f.learning.rows();
    expect((await f.send(f.request('review', { ...packet, target: { articleId: 'forged' } }))).status).toBe(400);
    expect((await f.send(f.request('review', { ...packet, reviewBindingHash: '0'.repeat(64) }))).status).toBe(409);
    expect(await f.learning.rows()).toEqual(rows);
  });

  it('holds the private review surface when the independent trusted check policy is unavailable', async () => {
    const f = await fixture(); const { packet, delivered } = await f.proposal(); const rows = await f.learning.rows();
    const handle = createSupportLearningHandlers({ ...f.options,
      reviewPolicy: { async resolvePolicy() { return { outcome: 'unavailable' }; } } });
    const read = await handle(f.request('proposal', undefined, 'staff', '?sourceGeneration=' + delivered.source.sourceGeneration));
    expect(read?.status).toBe(503);
    if (read === null) throw new Error('Expected an owned route');
    expect(await object(read)).toEqual({ error: 'review_policy_unavailable' });
    expect((await handle(f.request('review', packet)))?.status).toBe(503);
    expect(await f.learning.rows()).toEqual(rows);
  });

  it('retains the actual product-trust hold instead of creating learning work from browser evidence', async () => {
    const f = await fixture(); f.learning.state.product = 'missing';
    const { source } = await f.verified();
    expect(source.state).toBe('held');
    expect((await f.learning.rows()).filter((row) => row.kind === 'resolution_learning_work')).toEqual([]);
    expect(f.learning.state.modelCalls).toBe(0);
  });

  it('enforces packet scalar and existing body-byte bounds before creating a source', async () => {
    const f = await fixture(); const ticket = await f.learning.terminal(); const rows = await f.learning.rows();
    expect((await f.send(f.request('enroll', { commandId: 'x'.repeat(201), expectedRevision: ticket.revision }))).status).toBe(400);
    const oversized = f.request('enroll', { commandId: 'x'.repeat(65_536), expectedRevision: ticket.revision });
    expect((await f.send(oversized)).status).toBe(413);
    expect(await f.learning.rows()).toEqual(rows); expect(f.state.runtimeCalls).toBe(0);
  });

  it.each(['logout', 'role', 'header'] as const)('rechecks %s after the bounded request body before any enrollment', async (change) => {
    const f = await fixture(); const ticket = await f.learning.terminal(); const rows = await f.learning.rows();
    const body = await controlledHumanBody(f.request('enroll', { commandId: 'BODY-RACE', expectedRevision: ticket.revision }));
    const pending = f.send(body.request);
    try {
      await body.waitFor(pending);
      if (change === 'logout') await f.destroy('staff');
      else if (change === 'role') await f.revoke('staff', SUPPORT_ROLE);
      else body.request.headers.set('Cookie', f.cookies.get('support')!);
    } finally { body.complete(); }
    const response = await pending;
    expect([401, 403]).toContain(response.status); expect(await f.learning.rows()).toEqual(rows);
  });

  it('withholds a committed SDK enrollment ACK after real role revocation without pretending to roll it back', async () => {
    const f = await fixture(); const ticket = await f.learning.terminal();
    f.hooks.commit = async () => { delete f.hooks.commit; await f.revoke('staff', SUPPORT_ROLE); };
    expect((await f.send(f.request('enroll', { commandId: 'COMMITTED-DENIED', expectedRevision: ticket.revision }))).status).toBe(403);
    const source = await f.learning.runtime.readSource(f.learning.actors.staff, learningTicketId);
    expect(source.ticketId).toBe(learningTicketId);
    expect((await f.learning.rows()).some((row) => row.kind === 'resolution_learning_source')).toBe(true);
  });

  it('rechecks current Knowledge authority after an actual private KB read before disclosing the draft', async () => {
    const f = await fixture(); await f.verified(); const delivered = await f.learning.delivered();
    f.hooks.draft = async () => { delete f.hooks.draft; await f.revoke('staff', KNOWLEDGE_ROLE); };
    const response = await f.send(f.request('proposal', undefined, 'staff', '?sourceGeneration=' + delivered.source.sourceGeneration));
    expect(response.status).toBe(403); expect(await object(response)).toEqual({ error: 'forbidden' });
  });

  it.each([false, true])('applies the final original-session fence to read results/failures (throws=%s)', async (fail) => {
    const f = await fixture(); await f.verified(); const original = f.state.runtime;
    f.state.runtime = { ...original, async readSource(access, ticketId) {
      const source = await original.readSource(access, ticketId);
      await f.destroy('staff');
      if (fail) throw new Error('SYNTHETIC_PRIVATE_DEPENDENCY_FAILURE');
      return source;
    } };
    const response = await f.send(f.request());
    expect(response.status).toBe(401);
    expect(JSON.stringify(await object(response))).not.toContain('SYNTHETIC_PRIVATE');
  });

  it.each(['invalidate', 'withdraw'] as const)('keeps authorized %s available while model generation is OFF', async (operation) => {
    const f = await fixture(); await f.verified(); f.learning.state.enabled = false;
    const response = await f.send(f.request(operation, { commandId: operation.toUpperCase() + '-EXACT',
      reason: operation === 'withdraw' ? 'privacy_withdrawal' : 'evidence_revoked' }));
    expect(response.status).toBe(200);
    expect(result(await object(response)).state).toBe(operation === 'withdraw' ? 'withdrawn' : 'held');
    expect(f.learning.state.modelCalls).toBe(0);
  });

  it('shares an actual durable limiter and returns Retry-After without a private source result', async () => {
    const f = await fixture();
    for (let index = 0; index < 30; index += 1) await f.host.replyLimiter.allow(f.principals.staff);
    const response = await f.send(f.request());
    expect(response.status).toBe(429); expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(await object(response)).toEqual({ error: 'rate_limited' }); expect(f.state.runtimeCalls).toBe(0);
  });

  it('uses a finite body deadline and never enrolls from an unfinished body', async () => {
    const f = await fixture(); const ticket = await f.learning.terminal(); const rows = await f.learning.rows();
    const body = await controlledHumanBody(f.request('enroll', { commandId: 'UNFINISHED', expectedRevision: ticket.revision }));
    vi.useFakeTimers();
    const pending = f.send(body.request);
    try {
      await body.waitFor(pending);
      await vi.advanceTimersByTimeAsync(10_001);
      expect((await pending).status).toBe(408);
      expect(body.cancellations).toBeGreaterThan(0);
      expect(await f.learning.rows()).toEqual(rows);
    } finally { body.complete(); vi.useRealTimers(); }
  });
});
