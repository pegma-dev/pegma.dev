import { describe, expect, it } from 'vitest';
import type { Clock } from '@pegma/spine';
import { createSupportApi } from './support-api';
import { createSupportRuntime, SUPPORT_ENGINEERING_READ_LIMIT,
  SUPPORT_ENGINEERING_MUTATION_LIMIT } from './support-desk';
import { SUPPORT_ROLE } from './support-access';
import { createWorker, createSupportRequestHandler } from './index';
import { composeSupportEngineeringHuman, supportEngineeringIntakeOptions } from './support-engineering-composition';
import { createSupportEngineeringHttpFixture, engineeringHttpObject, engineeringHttpResult } from './support-engineering-http-fixtures';
import { engineeringTicketId } from './support-engineering-fixtures';

async function fixture(clock?: Clock) {
  const f = await createSupportEngineeringHttpFixture(); const ticket = await f.legacyTicket();
  const state = { enabled: true };
  const human = { enabled: () => state.enabled, configuration: { application: { enabled: true }, repositories: f.options.repositories } };
  const intake = supportEngineeringIntakeOptions(human);
  if (intake === undefined) throw new Error('Expected explicit synthetic human intake configuration');
  const runtime = createSupportRuntime({ store: f.host.store, identity: f.identity, sessions: f.sessions,
    identityLinkFromClaims: f.options.identityLinkFromClaims, logger: f.options.logger,
    engineering: intake, ...(clock === undefined ? {} : { clock }) });
  const engineering = composeSupportEngineeringHuman(runtime, f.options.logger, human);
  const api = createSupportApi({ ...f.options, application: runtime.application, roleStore: runtime.roleStore, createLimiter: runtime.createLimiter,
    replyLimiter: runtime.replyLimiter, engineering });
  return { f, ticket, state, human, runtime, engineering, api };
}

describe('optional public engineering root composition', () => {
  it.each(['absent', 'flag-only', 'false', 'throwing'] as const)('keeps %s entry composition OFF before any production dependencies', async (mode) => {
    const configuration = { application: { enabled: true }, repositories: [] };
    const options = mode === 'absent' ? {} : mode === 'flag-only' ? { enabled: () => true }
      : { configuration, enabled: () => { if (mode === 'throwing') throw new Error('Synthetic flag outage'); return false; } };
    // No fake Store/auth: a disabled path must not touch these absent bindings.
    const env = {} as Parameters<typeof createSupportRequestHandler>[0];
    const route = createSupportRequestHandler(env, { log() {} }, options);
    for (const suffix of ['', '/evidence', '/unknown']) {
      const response = await route(new Request('https://pegma.dev/api/support/admin/tickets/engineering-ticket/engineering' + suffix));
      expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'not_found' });
    }
  });

  it('keeps the registered Worker engineering namespace OFF before absent production bindings', async () => {
    const worker = createWorker();
    const env = {} as Parameters<typeof worker.fetch>[1];
    const pending: Promise<unknown>[] = [];
    const context: ExecutionContext = {
      waitUntil(promise) { pending.push(promise); },
      passThroughOnException() { throw new Error('Disabled engineering must finish in its own handler'); },
      get exports(): Cloudflare.Exports { throw new Error('Disabled engineering must not read Worker exports'); },
      props: {},
      get tracing(): Tracing { throw new Error('Disabled engineering must not initialize tracing'); },
    };
    const response = await worker.fetch(new Request('https://pegma.dev/api/support/admin/engineering/policy'), env, context);
    await Promise.all(pending);
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'not_found' });
  });

  it('uses the real shared Store, application, Identity/session roles and limiter for actual human enrollment', async () => {
    const { f, ticket, runtime, api } = await fixture();
    expect(runtime.store).toBe(f.host.store); expect(runtime.sessions).toBe(f.sessions); expect(runtime.identity).toBe(f.identity);
    const response = await api(f.request('enroll', { commandId: 'ROOT-ENROLL-EXACT-UPPERCASE', expectedRevision: ticket.revision }));
    expect(response.status).toBe(200);
    expect(engineeringHttpResult(await engineeringHttpObject(response))).toMatchObject({ ticketId: engineeringTicketId, sourceGeneration: 0 });
    expect(f.engineering.state.modelCalls).toBe(0); expect(f.engineering.state.creates).toEqual([]);
  });

  it('keeps engineering reads and enrollment available after the ordinary reply quota is exhausted', async () => {
    const { f, ticket, runtime, api } = await fixture();
    for (let index = 0; index < 30; index += 1)
      expect((await runtime.replyLimiter.allow(f.principals.staff)).allowed).toBe(true);
    expect((await runtime.replyLimiter.allow(f.principals.staff)).allowed).toBe(false);
    expect((await api(f.request())).status).toBe(404);
    expect((await api(f.request('enroll', { commandId: 'SEPARATE-ENGINEERING-ENROLL',
      expectedRevision: ticket.revision }))).status).toBe(200);
  });

  it('keeps ordinary replies and engineering writes independent of repeated engineering reads', async () => {
    const { f, ticket, runtime, api } = await fixture();
    for (let index = 0; index < 31; index += 1)
      expect((await api(f.request())).status).toBe(404);
    expect((await runtime.replyLimiter.allow(f.principals.staff)).allowed).toBe(true);
    expect((await api(f.request('enroll', { commandId: 'READS-DO-NOT-SPEND-WRITES',
      expectedRevision: ticket.revision }))).status).toBe(200);
  });

  it('retains dedicated read exhaustion across cold compositions, returns real Retry-After and restores access after expiry', async () => {
    let milliseconds = Date.now();
    const clock = { now: () => new Date(milliseconds).toISOString() };
    const { f, ticket, human, runtime, api } = await fixture(clock);
    for (let index = 0; index < SUPPORT_ENGINEERING_READ_LIMIT; index += 1)
      expect((await runtime.engineeringReadLimiter.allow(f.principals.staff)).allowed).toBe(true);
    const denied = await api(f.request()); expect(denied.status).toBe(429);
    expect(Number(denied.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(Number(denied.headers.get('Retry-After'))).toBeLessThanOrEqual(3600);
    const restarted = createSupportRuntime({ store: runtime.store, identity: runtime.identity,
      sessions: runtime.sessions, identityLinkFromClaims: runtime.identityLinkFromClaims,
      logger: f.options.logger, clock, engineering: supportEngineeringIntakeOptions(human) });
    const current = createSupportApi({ ...f.options, application: restarted.application,
      createLimiter: restarted.createLimiter, replyLimiter: restarted.replyLimiter,
      engineering: composeSupportEngineeringHuman(restarted, f.options.logger, human) });
    expect((await current(f.request())).status).toBe(429);
    expect((await current(f.request('enroll', { commandId: 'READ-QUOTA-DOES-NOT-BLOCK-WITHDRAWAL-INTAKE',
      expectedRevision: ticket.revision }))).status).toBe(200);
    expect((await restarted.replyLimiter.allow(f.principals.staff)).allowed).toBe(true);
    milliseconds += 60 * 60_000 + 1;
    // The actual source is protected. Expiry restores its real authorization
    // result; a limiter success must never fabricate source-read permission.
    expect((await current(f.request())).status).toBe(403);
  });

  it('exhausts engineering writes independently while reads and ordinary replies remain available', async () => {
    const { f, ticket, runtime, api } = await fixture();
    for (let index = 0; index < SUPPORT_ENGINEERING_MUTATION_LIMIT; index += 1)
      expect((await runtime.engineeringMutationLimiter.allow(f.principals.staff)).allowed).toBe(true);
    const denied = await api(f.request('enroll', { commandId: 'ACTUAL-WRITE-QUOTA-DENIAL', expectedRevision: ticket.revision }));
    expect(denied.status).toBe(429); expect(Number(denied.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect((await api(f.request())).status).toBe(404);
    expect((await runtime.replyLimiter.allow(f.principals.staff)).allowed).toBe(true);
  });

  it('computes capability from fresh real staff authority and retains both independent defaults', async () => {
    const { f, state, api } = await fixture();
    const detail = () => api(new Request('https://pegma.dev/api/support/admin/tickets/' + engineeringTicketId,
      { headers: { Cookie: f.cookies.get('staff')! } }));
    const enabled = await detail(); expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({ engineeringEnabled: true });
    state.enabled = false;
    expect(await (await detail()).json()).toMatchObject({ engineeringEnabled: false });
    state.enabled = true; await f.revoke('staff', SUPPORT_ROLE);
    expect((await detail()).status).toBe(403);
    expect(f.engineering.state.modelCalls).toBe(0);
  });

  it('keeps unknown engineering subpaths owned and leaves model-OFF policy disable available to current Admin+Support', async () => {
    const { f, api } = await fixture(); f.engineering.state.enabled = false;
    const unknown = await api(new Request('https://pegma.dev/api/support/admin/tickets/' + engineeringTicketId + '/engineering/dispatch'));
    expect(unknown.status).toBe(404);
    const current = await api(f.request('policy', undefined, 'both'));
    expect(current.status).toBe(200); const value = engineeringHttpResult(await engineeringHttpObject(current));
    const response = await api(f.request('policy/disable', { commandId: 'ROOT-DISABLE-EXACT-UPPERCASE', expectedGeneration: value.generation }, 'both'));
    expect(response.status).toBe(200); expect(engineeringHttpResult(await engineeringHttpObject(response)).enabled).toBe(false);
    expect(f.engineering.state.modelCalls).toBe(0); expect(f.engineering.state.creates).toEqual([]);
  });
});
