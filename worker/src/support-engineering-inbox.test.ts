import { describe, expect, it } from 'vitest';
import { IDENTITY_ISSUER } from './identity-api';
import { SUPPORT_ROLE } from './support-access';
import {
  createSupportEngineeringHttpFixture as fixture,
  engineeringHttpObject,
  engineeringHttpResult,
} from './support-engineering-http-fixtures';
import {
  engineeringTicketId,
  engineeringCanary,
  engineeringProofReference,
} from './support-engineering-fixtures';
const inbox = '/api/support/admin/engineering/review-inbox';
type Fixture = Awaited<ReturnType<typeof fixture>>;
const request = (
  f: Fixture,
  query = '',
  actor: 'staff' | 'admin' | 'customer' = 'staff',
) =>
  new Request(IDENTITY_ISSUER + inbox + query, {
    headers: f.request('', undefined, actor).headers,
  });
describe('bounded engineering inbox through actual current host authority', () => {
  it('exposes only staff-review sources and candidates from the real SDK scan', async () => {
    const f = await fixture();
    await f.verified();
    expect(
      (
        await f.send(
          f.request('invalidate', {
            commandId: 'Inbox:Invalidate',
            reason: 'evidence_revoked',
          }),
        )
      ).status,
    ).toBe(200);
    const response = await f.send(request(f));
    expect(response.status).toBe(200);
    const page = engineeringHttpResult(await engineeringHttpObject(response));
    expect(page.reviewSources).toContain(engineeringTicketId);
    expect(Object.keys(page).sort()).toEqual([
      'nextCursor',
      'pages',
      'physicalRows',
      'reviewCandidates',
      'reviewSources',
    ]);
    expect(page.pages).toBe(1);
    expect(page.physicalRows).toBeLessThanOrEqual(10);
    for (const value of [
      engineeringCanary,
      engineeringProofReference,
      'candidate',
      'reconciliationSources',
    ])
      expect(JSON.stringify(page)).not.toContain(value);
    const prepared = await fixture();
    await prepared.verified();
    await prepared.prepared();
    const candidate = engineeringHttpResult(
      await engineeringHttpObject(await prepared.send(request(prepared))),
    );
    expect(candidate.reviewCandidates).toContainEqual({
      ticketId: engineeringTicketId,
      sourceGeneration: prepared.key().sourceGeneration,
    });
    expect(prepared.engineering.state.creates).toEqual([]);
  });
  it.each([
    '?limit=0',
    '?limit=11',
    '?limit=01',
    '?limit=1&limit=2',
    '?cursor=',
    '?cursor=a&cursor=b',
    '?operation=process',
  ])('rejects malformed/oversized scan query %s', async (query) => {
    const f = await fixture();
    expect((await f.send(request(f, query))).status).toBe(400);
  });
  it.each(['admin', 'customer'] as const)(
    'denies %s without current staff review and queue access',
    async (actor) => {
      const f = await fixture();
      expect((await f.send(request(f, '', actor))).status).toBe(403);
      expect(f.state.runtimeCalls).toBe(0);
    },
  );
  it('rechecks current stored roles after the awaited actual SDK scan', async () => {
    const f = await fixture();
    await f.enrolled();
    const original = f.state.runtime;
    f.state.runtime = {
      ...original,
      async scanReview(...args: Parameters<typeof original.scanReview>) {
        const page = await original.scanReview(...args);
        await f.revoke('staff', SUPPORT_ROLE);
        return page;
      },
    };
    const response = await f.send(request(f));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden' });
  });
});
