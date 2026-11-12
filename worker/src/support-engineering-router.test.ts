import { describe, expect, it } from 'vitest';
import { IDENTITY_ISSUER } from './identity-api';
import { SUPPORT_ROLE } from './support-access';
import { createSupportApi } from './support-api';
import { engineeringTicketId } from './support-engineering-fixtures';
import {
  createSupportEngineeringHttpFixture, engineeringHttpCommand, engineeringHttpObject,
  engineeringHttpPolicyRoute, engineeringHttpResult, engineeringHttpRoute,
} from './support-engineering-http-fixtures';
import { createSupportEngineeringRouter, isSupportEngineeringRequest } from './support-engineering-router';

async function fixture() {
  const f = await createSupportEngineeringHttpFixture();
  const { enabled, ...configuration } = f.options; void enabled;
  const router = createSupportEngineeringRouter({ configuration, enabled: () => f.state.enabled });
  const legacy = createSupportApi({ application: f.engineering.application, sessions: f.sessions,
    identity: f.identity, identityLinkFromClaims: f.options.identityLinkFromClaims, logger: f.options.logger,
    roleStore: f.host.roleStore, createLimiter: f.host.createLimiter, replyLimiter: f.host.replyLimiter });
  async function routed(request: Request) { return (await router(request)) ?? legacy(request); }
  return { ...f, configuration, router, legacy, routed };
}

describe('opt-in engineering namespace composition', () => {
  it('defaults OFF without dependencies and leaves unrelated paths unclaimed', async () => {
    const router = createSupportEngineeringRouter();
    for (const pathname of [engineeringHttpRoute, engineeringHttpRoute + '/enroll', engineeringHttpPolicyRoute]) {
      const response = await router(new Request(IDENTITY_ISSUER + pathname));
      expect(response?.status).toBe(404);
      if (response === null) throw new Error('Expected owned disabled namespace');
      expect(await engineeringHttpObject(response)).toEqual({ error: 'not_found' });
      expect(response.headers.get('Cache-Control')).toContain('no-store');
    }
    expect(await router(new Request(IDENTITY_ISSUER + '/api/support/tickets'))).toBeNull();
  });

  it.each(['absent', 'flag-only', 'configuration-only', 'false', 'throws'] as const)(
    'keeps %s composition absent404 before runtime/auth despite the old command header', async (mode) => {
      const f = await fixture();
      const enabled = () => { if (mode === 'throws') throw new Error('Synthetic unavailable flag'); return mode !== 'false'; };
      const options = mode === 'absent' ? {} : mode === 'flag-only' ? { enabled }
        : mode === 'configuration-only' ? { configuration: f.configuration } : { enabled, configuration: f.configuration };
      const router = createSupportEngineeringRouter(options);
      const incoming = f.request('enroll', { commandId: 'DISABLED-EXACT', expectedRevision: 1 });
      incoming.headers.set('X-Pegma-Support-Command', '1');
      const response = await router(incoming);
      expect(response?.status).toBe(404); expect(f.state.runtimeCalls).toBe(0);
      if (response === null) throw new Error('Expected owned engineering namespace');
      expect(await engineeringHttpObject(response)).toEqual({ error: 'not_found' });
      expect(f.engineering.state.modelCalls).toBe(0);
    });

  it('owns unknown and excluded engineering subpaths before legacy Support routing', async () => {
    const f = await fixture();
    for (const pathname of [engineeringHttpRoute + '/dispatch', engineeringHttpRoute + '/process', engineeringHttpPolicyRoute + '/unknown']) {
      expect(isSupportEngineeringRequest(pathname)).toBe(true);
      const response = await f.routed(new Request(IDENTITY_ISSUER + pathname, {
        method: 'POST', headers: { 'X-Pegma-Support-Command': '1' }, body: '{}' }));
      expect(response.status).toBe(404); expect(await engineeringHttpObject(response)).toEqual({ error: 'not_found' });
    }
    for (const pathname of [engineeringHttpRoute + '/review', engineeringHttpRoute + '/proposal']) {
      expect(isSupportEngineeringRequest(pathname)).toBe(true);
      const response = await f.routed(new Request(IDENTITY_ISSUER + pathname, {
        method: 'POST', headers: { 'X-Pegma-Support-Command': '1' }, body: '{}' }));
      expect(response.status).toBe(503);
      expect(await engineeringHttpObject(response)).toEqual({ error: 'support_engineering_review_disabled' });
    }
    expect(f.state.runtimeCalls).toBe(0); expect(f.engineering.state.creates).toEqual([]);
  });

  it('fails closed on an invalid trusted catalog without constructing the private runtime', async () => {
    const f = await fixture(); const first = f.configuration.repositories[0]!;
    const router = createSupportEngineeringRouter({ enabled: () => true,
      configuration: { ...f.configuration, repositories: [first, first] } });
    const response = await router(f.request()); expect(response?.status).toBe(503);
    if (response === null) throw new Error('Expected owned engineering namespace');
    expect(await engineeringHttpObject(response)).toEqual({ error: 'support_engineering_unavailable' });
    expect(f.state.runtimeCalls).toBe(0);
  });

  it('keeps actual existing customer and staff ticket detail responses unchanged', async () => {
    const f = await fixture(); await f.engineering.createTicket();
    for (const [pathname, actor] of [
      ['/api/support/tickets/' + engineeringTicketId, 'customer'],
      ['/api/support/admin/tickets/' + engineeringTicketId, 'staff'],
    ] as const) {
      const request = () => new Request(IDENTITY_ISSUER + pathname, { headers: { Cookie: f.cookies.get(actor)! } });
      const original = await f.legacy(request()); const throughRouter = await f.routed(request());
      expect(original.status).toBe(200); expect(throughRouter.status).toBe(200);
      const value = await engineeringHttpObject(throughRouter);
      expect(value).toEqual(await engineeringHttpObject(original));
      expect(value).not.toHaveProperty('engineeringEnabled');
      expect(value).not.toHaveProperty('engineering');
    }
    expect(f.state.runtimeCalls).toBe(0);
  });

  it('delegates real legacy enrollment and exact replay to the authenticated SDK handler', async () => {
    const f = await fixture(); const ticket = await f.legacyTicket();
    const packet = { commandId: engineeringHttpCommand, expectedRevision: ticket.revision };
    const first = await f.routed(f.request('enroll', packet));
    expect(first.status).toBe(200);
    const value = await engineeringHttpObject(first);
    expect(value.csrfToken).toBe(f.csrf.get('staff'));
    expect(engineeringHttpResult(value)).toMatchObject({ ticketId: engineeringTicketId, state: 'unverified' });
    const rows = await f.rows(); expect(rows.filter((row) => row.kind === 'engineering_receipt')).toHaveLength(1);
    const replay = await f.routed(f.request('enroll', packet));
    expect(replay.status).toBe(200); expect(await engineeringHttpObject(replay)).toEqual(value);
    expect(await f.rows()).toEqual(rows); expect(f.engineering.state.modelCalls).toBe(0);
  });

  it.each(['admin', 'knowledge', 'customer'] as const)('preserves current %s staff denial through the router', async (actor) => {
    const f = await fixture(); const response = await f.routed(f.request('', undefined, actor));
    expect(response.status).toBe(403); expect(await engineeringHttpObject(response)).toEqual({ error: 'forbidden' });
    expect(f.state.runtimeCalls).toBe(0);
  });

  it.each(['Origin', 'Authorization'] as const)('preserves the existing browser %s fence on a real mutation', async (header) => {
    const f = await fixture(); const ticket = await f.legacyTicket(); const before = await f.rows();
    const incoming = f.request('enroll', { commandId: 'BROWSER-EXACT', expectedRevision: ticket.revision });
    incoming.headers.set(header, header === 'Origin' ? 'https://foreign.example' : 'Bearer synthetic');
    expect((await f.routed(incoming)).status).toBe(403); expect(await f.rows()).toEqual(before);
  });

  it('observes fresh stored-role revocation across successive router invocations', async () => {
    const f = await fixture(); await f.verified();
    expect((await f.routed(f.request())).status).toBe(200);
    await f.revoke('staff', SUPPORT_ROLE);
    expect((await f.routed(f.request())).status).toBe(403);
  });

  it('withholds an awaited private result if the current server flag turns OFF', async () => {
    const f = await fixture(); await f.verified(); const original = f.state.runtime;
    f.state.runtime = { ...original, async readSource(access, ticketId) {
      const value = await original.readSource(access, ticketId); f.state.enabled = false; return value;
    } };
    const response = await f.routed(f.request());
    expect(response.status).toBe(404); expect(await engineeringHttpObject(response)).toEqual({ error: 'not_found' });
  });

  it('preserves the final original-session fence after the real source read', async () => {
    const f = await fixture(); await f.verified(); const original = f.state.runtime;
    f.state.runtime = { ...original, async readSource(access, ticketId) {
      const value = await original.readSource(access, ticketId); await f.destroy('staff'); return value;
    } };
    const response = await f.routed(f.request());
    expect(response.status).toBe(401); expect(await engineeringHttpObject(response)).toEqual({ error: 'authentication_required' });
  });

  it('routes declarative policy controls only through actual current Admin plus Support authority', async () => {
    const f = await fixture();
    expect((await f.routed(f.request('policy', undefined, 'admin'))).status).toBe(403);
    const read = await f.routed(f.request('policy', undefined, 'both'));
    expect(read.status).toBe(200);
    const before = engineeringHttpResult(await engineeringHttpObject(read));
    const rows = await f.policyRows();
    const prepare = await f.routed(f.request('policy/prepare', { commandId: 'ROUTED-PREPARE-EXACT',
      expectedGeneration: before.generation, enabled: false, repositoryKeys: [] }, 'both'));
    expect(prepare.status).toBe(200);
    expect(engineeringHttpResult(await engineeringHttpObject(prepare))).toHaveProperty('intent');
    expect(await f.policyRows()).toEqual(rows);
    const packet = { commandId: 'ROUTED-DISABLE-EXACT', expectedGeneration: before.generation };
    const disabled = await f.routed(f.request('policy/disable', packet, 'both'));
    expect(disabled.status).toBe(200);
    expect(engineeringHttpResult(await engineeringHttpObject(disabled)).enabled).toBe(false);
    expect((await f.engineering.runtime.readPolicy(f.engineering.actors.admin)).policy.enabled).toBe(false);
    expect(f.engineering.state.creates).toEqual([]);
  });
});
