/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { AsyncLocalStorage } from 'node:async_hooks';
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { createWorker } from './index';
import { createCloudflareD1Store } from '@pegma/storage-cloudflare-d1';
import { supportRecords } from '@pegma/support-desk-application';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isPlainObject } from './api-auth';
import { IDENTITY_ISSUER } from './identity-api';
import { ADMIN_ROLE, SUPPORT_ROLE } from './support-access';
import { createSupportApi } from './support-api';
import { engineeringCanary, engineeringProofReference, engineeringRepositories } from './support-engineering-fixtures';
import {
  createSupportEngineeringHttpFixture, engineeringHttpCommand,
  engineeringHttpObject, engineeringHttpResult, engineeringHttpRoute,
} from './support-engineering-http-fixtures';
import { createSupportEngineeringRouter } from './support-engineering-router';

interface Budget {
  readonly operation: string;
  calls: number;
  executed: number;
  statements: number;
  batches: number;
  maximumParameters: number;
  blocked: number;
  status?: number;
}
const profiles: Budget[][] = [];

beforeAll(async () => {
  expect(String(env.IDENTITY_EMAIL_ENABLED)).toBe('false');
  // Test schema only, through the genuine adapter, outside measured requests.
  const store = createCloudflareD1Store({ database: env.IDENTITY_DB });
  await store.collection(supportRecords).get({ partition: 'engineering-http-schema-probe', id: 'absent' });
});
beforeEach(async () => {
  profiles.length = 0;
  // Per-file isolated D1 pool reset, matching existing Native suites.
  await env.IDENTITY_DB.prepare('DELETE FROM RECORDS').run();
  await env.IDENTITY_DB.prepare('DELETE FROM PEGMA_STORAGE_D1_TX_GUARD').run();
});
afterEach(({ task }) => {
  Object.assign(task.meta, { supportEngineeringHttpD1Budget: structuredClone(profiles.flat()) });
  console.info('support-engineering-http-d1-budgets', JSON.stringify(profiles.flat()));
});

/** Observe actual binding calls, never SQL, results, codecs or Store decisions.
 * A D1 batch counts one call; each statement keeps its real bound-parameter
 * count. A refused 51st attempt is recorded but never delegated to D1. */
function meter(backing: D1Database) {
  const scope = new AsyncLocalStorage<Budget>();
  const budgets: Budget[] = []; profiles.push(budgets);
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const parameters = new WeakMap<D1PreparedStatement, number>();
  function charge(statements: readonly D1PreparedStatement[]) {
    const budget = scope.getStore(); if (budget === undefined) return;
    budget.calls += 1; budget.statements += statements.length;
    budget.maximumParameters = Math.max(budget.maximumParameters,
      ...statements.map((statement) => parameters.get(statement) ?? 0));
    if (budget.calls > 50 || budget.maximumParameters > 100) {
      budget.blocked += 1;
      throw new Error('Synthetic Workers Free engineering binding guard refused execution.');
    }
    budget.executed += 1;
  }
  function observed(original: D1PreparedStatement, count = 0): D1PreparedStatement {
    const statement: D1PreparedStatement = {
      bind(...values: unknown[]) { return observed(original.bind(...values), values.length); },
      first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
        charge([statement]); return column === undefined ? original.first<T>() : original.first<T>(column);
      },
      all<T = Record<string, unknown>>() { charge([statement]); return original.all<T>(); },
      run<T = Record<string, unknown>>() { charge([statement]); return original.run<T>(); },
      raw: original.raw,
    };
    statement.raw = new Proxy(original.raw, { apply(target, _receiver, args) {
      charge([statement]); return Reflect.apply(target, original, args);
    } });
    originals.set(statement, original); parameters.set(statement, count); return statement;
  }
  const database: D1Database = {
    prepare(query) { return observed(backing.prepare(query)); },
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      charge(statements); const budget = scope.getStore(); if (budget !== undefined) budget.batches += 1;
      const native = statements.map((statement) => {
        const actual = originals.get(statement);
        if (actual === undefined) throw new Error('Expected an observed genuine D1 statement.');
        return actual;
      });
      return backing.batch<T>(native);
    },
    exec() { throw new Error('Runtime schema work is excluded from engineering request profiles.'); },
    dump() { throw new Error('Runtime D1 dump is excluded from engineering request profiles.'); },
    withSession() { throw new Error('The public adapter uses the direct D1 binding.'); },
  };
  return {
    database,
    budgets,
    run(operation: string, action: () => Promise<Response>) {
      const budget: Budget = { operation, calls: 0, executed: 0, statements: 0,
        batches: 0, maximumParameters: 0, blocked: 0 };
      budgets.push(budget);
      return scope.run(budget, async () => {
        const response = await action();
        await response.clone().arrayBuffer();
        budget.status = response.status;
        return response;
      });
    },
    assertBounds() {
      for (const budget of budgets) {
        const detail = JSON.stringify(budget);
        expect(budget.calls, detail).toBeLessThanOrEqual(50);
        expect(budget.executed, detail).toBe(budget.calls);
        expect(budget.maximumParameters, detail).toBeLessThanOrEqual(100);
        expect(budget.blocked, detail).toBe(0);
      }
    },
  };
}

async function fixture() {
  const budget = meter(env.IDENTITY_DB);
  const store = createCloudflareD1Store({ database: budget.database,
    createSchemaIfMissing: false, readBatchSize: 512 });
  const f = await createSupportEngineeringHttpFixture(store);
  const { enabled, ...configuration } = f.options; void enabled;
  const legacy = createSupportApi({ application: f.engineering.application, sessions: f.sessions,
    identity: f.identity, identityLinkFromClaims: f.options.identityLinkFromClaims,
    logger: f.options.logger, roleStore: f.host.roleStore,
    createLimiter: f.host.createLimiter, replyLimiter: f.host.replyLimiter });
  function router(repositories = configuration.repositories) {
    return createSupportEngineeringRouter({ enabled: () => f.state.enabled,
      configuration: { ...configuration, repositories } });
  }
  const defaultRouter = router();
  async function invoke(operation: string, incoming: Request, route = defaultRouter) {
    return budget.run(operation, async () => (await route(incoming)) ?? legacy(incoming));
  }
  async function prepare(commandId: string, expectedGeneration: number) {
    const response = await invoke('policy.prepare', f.request('policy/prepare', {
      commandId, expectedGeneration, enabled: true,
      repositoryKeys: [engineeringRepositories[0]!.repositoryId],
    }, 'both'));
    expect(response.status).toBe(200);
    const value = engineeringHttpResult(await engineeringHttpObject(response));
    if (!isPlainObject(value.intent)) throw new Error('Expected the actual full policy intent.');
    return { intent: value.intent };
  }
  return { ...f, budget, invoke, router, prepare };
}

/** Keep the fixture's exact JSON POST bytes and browser headers while avoiding
 * clone()'s widened Cloudflare metadata generic at the handler boundary. */
async function retainedPost(request: Request): Promise<Request> {
  const body = await request.clone().text();
  return new Request(request.url, {
    method: request.method, headers: new Headers(request.headers), body,
  });
}

function evidence(revision: number) {
  return {
    commandId: 'NATIVE-HTTP-EVIDENCE-EXACT', expectedRevision: revision, security: 'ordinary',
    expectedBehavior: 'The export contains the workspace rows.', actualBehavior: 'The downloaded export is empty.',
    reproductionSteps: ['Create a fictional workspace with one row.', 'Export it and inspect the file.'],
    visibleMessageIds: ['engineering-question'], verificationReference: engineeringProofReference,
  };
}

describe('enabled human engineering router and HTTP over genuine D1', () => {
  it('enrolls a real legacy source0, keeps its uncertain read forbidden, then accepts exact visible evidence within each request budget', async () => {
    const f = await fixture(); const ticket = await f.legacyTicket(); const before = await f.rows();
    expect(before.some((row) => row.kind === 'engineering_source')).toBe(false);
    const request = f.request('enroll', { commandId: engineeringHttpCommand, expectedRevision: ticket.revision });
    const accepted = await f.invoke('enroll.source0', await retainedPost(request));
    expect(accepted.status).toBe(200);
    const enrolled = await engineeringHttpObject(accepted);
    expect(enrolled.csrfToken).toBe(f.csrf.get('staff'));
    expect(engineeringHttpResult(enrolled)).toMatchObject({ sourceGeneration: 0, state: 'unverified' });
    const committed = await f.rows();
    expect(committed.filter((row) => row.kind === 'engineering_receipt')).toHaveLength(1);
    const unreadable = await f.invoke('source0.ordinary-denied', f.request());
    expect(unreadable.status).toBe(403);
    expect(await engineeringHttpObject(unreadable)).toEqual({ error: 'forbidden' });
    const replay = await f.invoke('enroll.exact-replay', await retainedPost(request));
    expect(replay.status).toBe(200); expect(await engineeringHttpObject(replay)).toEqual(enrolled);
    expect(await f.rows()).toEqual(committed);
    const verified = await f.invoke('evidence.intake', f.request('evidence', evidence(ticket.revision)));
    expect(verified.status).toBe(200);
    const source = engineeringHttpResult(await engineeringHttpObject(verified));
    expect(source.state).toBe('eligible'); expect(source.sourceGeneration).toBeGreaterThan(0);
    const read = await f.invoke('source.eligible-read', f.request()); expect(read.status).toBe(200);
    const body = JSON.stringify(await engineeringHttpObject(read));
    expect(body).not.toContain(engineeringCanary); expect(body).not.toContain(engineeringProofReference);
    expect(f.engineering.state.modelCalls).toBe(0); expect(f.engineering.state.creates).toEqual([]);
    f.budget.assertBounds();
  });

  it.each(['changed-descriptor', 'removed-key'] as const)(
    'prepares a full policy, loses a real committed ACK and exactly recovers after catalog %s without another policy write',
    async (change) => {
      const f = await fixture();
      const initial = await f.engineering.runtime.readPolicy(f.engineering.actors.admin);
      const before = await f.policyRows();
      const retained = await f.prepare('NATIVE-POLICY-LOST-EXACT', initial.generation);
      // Keep an independent NEVER-submitted intent at the same original head.
      // After A commits, B must take the stale/no-receipt branch, not a fresh
      // same-generation catalog-admission branch.
      const fresh = await f.prepare('NATIVE-FRESH-OBSOLETE-CATALOG', initial.generation);
      expect(await f.policyRows()).toEqual(before);
      const request = f.request('policy', retained, 'both');
      const originalBytes = await request.clone().text();
      const original = f.state.runtime; let lose = true;
      let acknowledgement: Awaited<ReturnType<typeof original.putPolicy>> | undefined;
      f.state.runtime = { ...original, async putPolicy(...args: Parameters<typeof original.putPolicy>) {
        const value = await original.putPolicy(...args); acknowledgement ??= value;
        if (lose) { lose = false; throw new Error('Synthetic real committed policy transport ACK loss'); }
        return value;
      } };
      const unknown = await f.invoke('policy.commit-lost-ack', await retainedPost(request));
      expect(unknown.status).toBe(503);
      expect(await engineeringHttpObject(unknown)).toEqual({ error: 'support_engineering_unavailable' });
      const committed = await f.policyRows(); expect(committed).not.toEqual(before);
      const actual = await f.engineering.runtime.readPolicy(f.engineering.actors.admin);
      expect(actual.generation).toBe(initial.generation + 1);
      const repositories = change === 'removed-key' ? [] : f.options.repositories.map((entry) => ({ ...entry,
        descriptor: { ...entry.descriptor, responsibilities: 'A different current deployment responsibility.' } }));
      const later = f.router(repositories);
      expect(await request.clone().text()).toBe(originalBytes);
      const replay = await f.invoke('policy.catalog-drift-exact-replay', await retainedPost(request), later);
      expect(replay.status).toBe(200);
      expect(acknowledgement).toBeDefined();
      expect(engineeringHttpResult(await engineeringHttpObject(replay))).toEqual(acknowledgement);
      expect(await f.policyRows()).toEqual(committed);
      // A different original intent without a retained receipt cannot use the
      // replay branch to commit an obsolete catalog snapshot.
      const refused = await f.invoke('policy.unaccepted-old-catalog-refused', f.request('policy', fresh, 'both'), later);
      expect(refused.status).toBe(409); expect(await f.policyRows()).toEqual(committed);
      expect(f.engineering.state.creates).toEqual([]); expect(f.engineering.state.modelCalls).toBe(0);
      f.budget.assertBounds();
    },
  );

  it('rechecks actual stored Support and Admin role revocation on successive private router requests', async () => {
    const f = await fixture(); const ticket = await f.legacyTicket();
    expect((await f.invoke('enroll.before-role-revocation', f.request('enroll', {
      commandId: 'NATIVE-ROLE-ENROLL', expectedRevision: ticket.revision,
    }))).status).toBe(200);
    expect((await f.invoke('evidence.before-role-revocation', f.request('evidence', evidence(ticket.revision)))).status).toBe(200);
    expect((await f.invoke('source.before-role-revocation', f.request())).status).toBe(200);
    await f.revoke('staff', SUPPORT_ROLE);
    const before = await f.rows();
    const denied = await f.invoke('source.after-support-revocation', f.request());
    expect(denied.status).toBe(403); expect(await engineeringHttpObject(denied)).toEqual({ error: 'forbidden' });
    expect(await f.rows()).toEqual(before);
    expect((await f.invoke('policy.before-admin-revocation', f.request('policy', undefined, 'both'))).status).toBe(200);
    await f.revoke('both', ADMIN_ROLE);
    const policyRows = await f.policyRows();
    const policyDenied = await f.invoke('policy.after-admin-revocation', f.request('policy', undefined, 'both'));
    expect(policyDenied.status).toBe(403); expect(await engineeringHttpObject(policyDenied)).toEqual({ error: 'forbidden' });
    expect(await f.policyRows()).toEqual(policyRows);
    f.budget.assertBounds();
  });

  it('keeps disabled or excluded router paths inert and rejects a bearer on the enabled browser surface', async () => {
    const f = await fixture(); const before = await f.policyRows();
    f.state.enabled = false;
    const disabled = await f.invoke('router.disabled', f.request('policy', undefined, 'both'));
    expect(disabled.status).toBe(404);
    f.state.enabled = true;
    const excluded = await f.invoke('router.excluded-dispatch', new Request(IDENTITY_ISSUER + engineeringHttpRoute + '/dispatch', {
      method: 'POST', headers: { 'X-Pegma-Support-Command': '1' }, body: '{}',
    }));
    expect(excluded.status).toBe(404);
    const bearer = f.request('policy', undefined, 'both'); bearer.headers.set('Authorization', 'Bearer synthetic-not-browser');
    const denied = await f.invoke('router.bearer-denied', bearer); expect(denied.status).toBe(403);
    expect(await f.policyRows()).toEqual(before);
    expect(f.state.runtimeCalls).toBe(0);
    expect(f.engineering.state.modelCalls).toBe(0);
    f.budget.assertBounds();
  });
});


describe('registered optional engineering Worker route over genuine D1', () => {
  it('meters cold root enrollment, exact replay, current capability and Admin+Support policy reads', async () => {
    const f = await fixture(); const ticket = await f.legacyTicket();
    const human = { enabled: () => true,
      configuration: { application: { enabled: true }, repositories: f.options.repositories } };
    const worker = createWorker({ engineering: human });
    const environment = { ...env, IDENTITY_DB: f.budget.database,
      IDENTITY_EMAIL_CODE_SECRET_BASE64: btoa('e'.repeat(32)) };
    const invoke = (label: string, request: Request) => f.budget.run(label, async () => {
      const context = createExecutionContext();
      try { return await worker.fetch(request, environment, context); }
      finally { await waitOnExecutionContext(context); }
    });
    const original = f.request('enroll', { commandId: 'NATIVE-ROOT-EXACT-UPPERCASE', expectedRevision: ticket.revision });
    const accepted = await invoke('root.enroll', await retainedPost(original));
    expect(accepted.status).toBe(200); const acknowledgement = await engineeringHttpObject(accepted);
    expect(engineeringHttpResult(acknowledgement)).toMatchObject({ sourceGeneration: 0, state: 'unverified' });
    const rows = await f.rows();
    const replay = await invoke('root.enroll.exact-replay', await retainedPost(original));
    expect(replay.status).toBe(200); expect(await replay.json()).toEqual(acknowledgement);
    expect(await f.rows()).toEqual(rows);
    const detail = await invoke('root.detail.capability', new Request(IDENTITY_ISSUER + '/api/support/admin/tickets/' + ticket.id,
      { headers: { Cookie: f.cookies.get('staff')! } }));
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ engineeringEnabled: true, engineeringReviewEnabled: false });
    const policy = await invoke('root.policy.current', f.request('policy', undefined, 'both'));
    expect(policy.status).toBe(200);
    expect(engineeringHttpResult(await engineeringHttpObject(policy)).catalog).toHaveLength(f.options.repositories.length);
    f.budget.assertBounds(); expect(f.engineering.state.modelCalls).toBe(0); expect(f.engineering.state.creates).toEqual([]);
  });
});
