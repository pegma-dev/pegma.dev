/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import {
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { createCloudflareD1Store } from '@pegma/storage-cloudflare-d1';
import { supportRecords } from '@pegma/support-desk-application';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWorker } from './index';
import {
  createSupportAssistantStageDatabase,
  type SupportAssistantStageBudget,
} from './support-assistant-stage-budget';
import {
  engineeringHttpObject,
  engineeringHttpResult,
} from './support-engineering-http-fixtures';
import {
  createSupportReleaseFollowupFixture,
  followupCommandId,
  followupPrivateMarker,
} from './support-release-followup-fixtures';
import { SUPPORT_ROLE } from './support-access';
import { IDENTITY_ISSUER, SESSION_COOKIE } from './identity-api';
import type { SupportReleaseFollowupComposition } from './support-release-followup-ports';

interface PhysicalTrace {
  readonly operation: string;
  readonly keys: readonly unknown[];
  readonly callsite: readonly string[];
}
const profiles: {
  operation: string;
  status: number;
  budget: SupportAssistantStageBudget;
  trace: PhysicalTrace[];
}[] = [];

/** Observation only, above the unchanged intrinsic guard. Every statement,
 * parameter, native result and batch is delegated to that guarded binding. */
function traceDatabase(
  database: D1Database,
  trace: PhysicalTrace[],
  afterMessageCommit?: {
    readonly messageId: string;
    run(): Promise<void>;
  },
): D1Database {
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const details = new WeakMap<
    D1PreparedStatement,
    { query: string; values: readonly unknown[] }
  >();
  function observe(operation: string, statements: D1PreparedStatement[]) {
    const stack =
      new Error('followup physical boundary').stack?.split('\n').slice(3, 11) ??
      [];
    trace.push({
      operation,
      keys: statements.map((statement) => {
        const row = details.get(statement);
        return {
          query: row?.query,
          keys: row?.values
            .slice(0, 3)
            .map((value) =>
              typeof value === 'string'
                ? value.startsWith('{')
                  ? '[encoded write omitted]'
                  : value.slice(0, 160)
                : value,
            ),
        };
      }),
      callsite: stack,
    });
  }
  function statement(
    actual: D1PreparedStatement,
    query: string,
    values: readonly unknown[] = [],
  ): D1PreparedStatement {
    const wrapped = new Proxy(actual, {
      get(target, key) {
        if (key === 'bind')
          return (...bound: unknown[]) =>
            statement(target.bind(...bound), query, bound);
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (['first', 'all', 'run', 'raw'].includes(String(key)))
            observe(String(key), [wrapped]);
          return Reflect.apply(value, target, args);
        };
      },
    });
    originals.set(wrapped, actual);
    details.set(wrapped, { query, values });
    return wrapped;
  }
  return new Proxy(database, {
    get(target, key) {
      if (key === 'prepare')
        return (query: string) => statement(target.prepare(query), query);
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          observe('batch', statements);
          const results = await target.batch(
            statements.map((value) => {
              const original = originals.get(value);
              if (original === undefined)
                throw new Error('Expected a traced genuine guarded statement');
              return original;
            }),
          );
          if (
            afterMessageCommit !== undefined &&
            statements.some((statement) => {
              const row = details.get(statement);
              return (
                row?.query.trimStart().startsWith('INSERT INTO RECORDS') &&
                row.values[1] === 'message:' + afterMessageCommit.messageId
              );
            })
          )
            await afterMessageCommit.run();
          return results;
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
beforeAll(async () => {
  const store = createCloudflareD1Store({ database: env.IDENTITY_DB });
  await store
    .collection(supportRecords)
    .get({ partition: 'followup-schema', id: 'probe' });
});
beforeEach(async () => {
  profiles.length = 0;
  await env.IDENTITY_DB.prepare('DELETE FROM RECORDS').run();
  await env.IDENTITY_DB.prepare('DELETE FROM PEGMA_STORAGE_D1_TX_GUARD').run();
});
afterEach(({ task }) => {
  Object.assign(task.meta, {
    supportReleaseFollowupD1: structuredClone(profiles),
  });
  console.info(
    'support-release-followup-d1',
    JSON.stringify(
      profiles.map(({ operation, status, budget }) => ({
        operation,
        status,
        budget,
      })),
    ),
  );
});

async function fixture() {
  // Setup alone is outside measured invocations. Each request constructs the
  // actual registered Worker with a fresh metered binding and cold services.
  const f = await createSupportReleaseFollowupFixture(
    createCloudflareD1Store({
      database: env.IDENTITY_DB,
      createSchemaIfMissing: false,
      readBatchSize: 512,
    }),
  );
  async function invoke(
    operation: string,
    request: Request,
    enabled = true,
    composition: SupportReleaseFollowupComposition = f.composition,
    afterMessageCommit?: {
      readonly messageId: string;
      run(): Promise<void>;
    },
  ) {
    const meter = createSupportAssistantStageDatabase(env.IDENTITY_DB);
    const trace: PhysicalTrace[] = [];
    const environment = {
      ...env,
      IDENTITY_DB: traceDatabase(meter.database, trace, afterMessageCommit),
      IDENTITY_EMAIL_CODE_SECRET_BASE64: btoa('e'.repeat(32)),
    };
    const worker = createWorker({
      ...(enabled ? { releaseFollowup: composition } : {}),
    });
    const context = createExecutionContext();
    try {
      const response = await worker.fetch(request, environment, context);
      await response.clone().arrayBuffer();
      const budget = meter.snapshot();
      profiles.push({ operation, status: response.status, budget, trace });
      const detail = JSON.stringify({
        operation,
        status: response.status,
        budget,
      });
      expect(budget.physicalQueries, detail).toBeLessThanOrEqual(50);
      expect(budget.maximumParameters, detail).toBeLessThanOrEqual(100);
      expect(budget.blockedQueries, detail).toBe(0);
      expect(budget.blockedParameters, detail).toBe(0);
      return response;
    } finally {
      await waitOnExecutionContext(context);
    }
  }
  return { ...f, invoke };
}

describe('full registered follow-up Worker invocations on actual D1', () => {
  it('keeps the default-off route outside all database initialization', async () => {
    const f = await fixture();
    expect(
      (await f.invoke('default-off.scan', f.request('scan'), false)).status,
    ).toBe(404);
    expect(profiles[0]!.budget.physicalQueries).toBe(0);
  });

  it('reads a real nonempty private bundle and current role denial with every cold-root call counted', async () => {
    const f = await fixture();
    const work = await f.prepare();
    const response = await f.invoke(
      'root.work.read',
      f.request('work', undefined, 'staff', '?workId=' + work.workId),
    );
    expect(response.status).toBe(200);
    const value = await engineeringHttpObject(response);
    expect(engineeringHttpResult(value)).toMatchObject({
      workId: work.workId,
      status: 'bundle_prepared',
    });
    expect(JSON.stringify(value)).not.toContain(followupPrivateMarker);
    await f.f.revoke('staff', SUPPORT_ROLE);
    const before = await f.rows();
    expect(
      (
        await f.invoke(
          'root.work.revoked',
          f.request('work', undefined, 'staff', '?workId=' + work.workId),
        )
      ).status,
    ).toBe(403);
    expect(await f.rows()).toEqual(before);
  });

  it('posts and exactly replays one web notice within the original invocation bound', async () => {
    const f = await fixture();
    const work = await f.prepare();
    if (work.preparedBundle === undefined)
      throw new Error('Expected actual full checked SDK bundle');
    const packet = {
      commandId: followupCommandId,
      workId: work.workId,
      expectedWorkGeneration: work.workGeneration,
      expectedTicketRevision: work.acceptedTicketRevision,
      bundleHash: work.preparedBundle.bundleHash,
      messageId: 'cd5f67c1-5a0a-43ce-8548-1e0f88f9c2f2',
    };
    const response = await f.invoke('root.post.new', f.request('post', packet));
    expect(response.status).toBe(200);
    const accepted = engineeringHttpResult(
      await engineeringHttpObject(response),
    );
    const rows = await f.rows();
    f.state.proofAvailable = false;
    const replay = await f.invoke(
      'root.post.exact-receipt',
      f.request('post', structuredClone(packet)),
    );
    expect(replay.status).toBe(200);
    expect(engineeringHttpResult(await engineeringHttpObject(replay))).toEqual(
      accepted,
    );
    expect(await f.rows()).toEqual(rows);
    expect(
      rows.filter(
        (row) => row.kind === 'message' && row.message.id === packet.messageId,
      ),
    ).toHaveLength(1);
  });

  it('observes trusted deployed input, holds and explicitly retries draftless work through fresh root invocations', async () => {
    const f = await fixture();
    const input = {
      commandId: followupCommandId,
      ...f.identity.association,
      inputReference: f.identity.inputReference,
    };
    const observed = await f.invoke(
      'root.observe.new',
      f.request('observe', input),
    );
    expect(observed.status).toBe(200);
    const observation = engineeringHttpResult(
      await engineeringHttpObject(observed),
    );
    if (typeof observation.workId !== 'string')
      throw new Error('Expected actual observed SDK work');
    const key = { ticketId: 'engineering-ticket', workId: observation.workId };
    const actor = await f.f.resolve(f.f.principals.staff);
    if (actor === null) throw new Error('Expected actual Support role');
    const current = await f.host.application.readEngineeringFollowupWork(
      actor,
      key,
    );
    const hold = {
      commandId: '8cb7f8f1-d8ac-4edb-8e16-84d061a753e6',
      workId: key.workId,
      expectedWorkGeneration: current.workGeneration,
      reason: 'Staff paused the fictional draftless work.',
    };
    const held = await f.invoke('root.abandon.new', f.request('abandon', hold));
    expect(held.status).toBe(200);
    const heldResult = engineeringHttpResult(await engineeringHttpObject(held));
    const retry = {
      commandId: '3818b32e-7df1-4554-b320-0c83c38032db',
      workId: key.workId,
      expectedWorkGeneration: heldResult.workGeneration,
    };
    const retried = await f.invoke('root.retry.new', f.request('retry', retry));
    expect(retried.status).toBe(200);
    const accepted = engineeringHttpResult(
      await engineeringHttpObject(retried),
    );
    const committed = await f.rows();
    f.state.proofAvailable = false;
    const replay = await f.invoke(
      'root.retry.exact',
      f.request('retry', structuredClone(retry)),
    );
    expect(replay.status).toBe(200);
    expect(engineeringHttpResult(await engineeringHttpObject(replay))).toEqual(
      accepted,
    );
    expect(await f.rows()).toEqual(committed);
    expect(f.state.modelCalls).toBe(0);
  });

  it('checks retained edits with generation off and exactly recovers the preparation through the registered root', async () => {
    const f = await fixture();
    const work = await f.prepare();
    const { generation, ...configuration } = f.configured;
    void generation;
    const composition = { enabled: () => true, configuration };
    const input = {
      commandId: followupCommandId,
      workId: work.workId,
      expectedWorkGeneration: work.workGeneration,
      content: {
        customerDraft: {
          body: 'The deployed correction is ready for your next fictional export.',
        },
        kbProposal: null,
        retestRequests: [],
      },
    };
    const prepared = await f.invoke(
      'root.reassess.new',
      f.request('reassess', input),
      true,
      composition,
    );
    expect(prepared.status).toBe(200);
    const accepted = engineeringHttpResult(
      await engineeringHttpObject(prepared),
    );
    const committed = await f.rows();
    f.state.proofAvailable = false;
    const replay = await f.invoke(
      'root.reassess.exact',
      f.request('reassess', structuredClone(input)),
      true,
      composition,
    );
    expect(replay.status).toBe(200);
    expect(engineeringHttpResult(await engineeringHttpObject(replay))).toEqual(
      accepted,
    );
    expect(await f.rows()).toEqual(committed);
    expect(f.state.modelCalls).toBe(1);
  });

  it('rejects a real checked bundle and replays its exact decision without rechecking obsolete proof', async () => {
    const f = await fixture();
    const work = await f.prepare();
    if (work.preparedBundle === undefined)
      throw new Error('Expected actual prepared SDK bundle');
    const input = {
      commandId: followupCommandId,
      workId: work.workId,
      expectedWorkGeneration: work.workGeneration,
      bundleHash: work.preparedBundle.bundleHash,
      reason: 'Staff rejected the fictional update.',
    };
    const rejected = await f.invoke(
      'root.reject.new',
      f.request('reject', input),
    );
    expect(rejected.status).toBe(200);
    const accepted = engineeringHttpResult(
      await engineeringHttpObject(rejected),
    );
    const committed = await f.rows();
    f.state.proofAvailable = false;
    const replay = await f.invoke(
      'root.reject.exact',
      f.request('reject', structuredClone(input)),
    );
    expect(replay.status).toBe(200);
    expect(engineeringHttpResult(await engineeringHttpObject(replay))).toEqual(
      accepted,
    );
    expect(await f.rows()).toEqual(committed);
  });

  it.each(['session', 'role', 'header', 'configuration'] as const)(
    'denies a new notice after actual %s loss during awaited release proof',
    async (change) => {
      const f = await fixture();
      const work = await f.prepare();
      if (work.preparedBundle === undefined)
        throw new Error('Expected an actual checked SDK bundle');
      const packet = {
        commandId: followupCommandId,
        workId: work.workId,
        expectedWorkGeneration: work.workGeneration,
        expectedTicketRevision: work.acceptedTicketRevision,
        bundleHash: work.preparedBundle.bundleHash,
        messageId: 'cbcf89a4-33ea-4ac5-b332-46765e310bf7',
      };
      const request = f.request('post', packet);
      const before = await f.rows();
      let observed = false;
      f.state.confirm = async () => {
        if (observed) return;
        observed = true;
        // These are genuine concurrent authority changes through the original
        // SDK fixture. They are outside the measured HTTP invocation's Store.
        if (change === 'session') await f.f.destroy('staff');
        else if (change === 'role') await f.f.revoke('staff', SUPPORT_ROLE);
        else if (change === 'header')
          request.headers.set('X-Pegma-CSRF', 'changed-during-release-proof');
        else f.state.enabled = false;
      };
      const response = await f.invoke('root.post.lost-' + change, request);
      expect(observed).toBe(true);
      expect(response.status).toBe(
        change === 'session' ? 401 : change === 'configuration' ? 503 : 403,
      );
      expect(await f.rows()).toEqual(before);
      expect(
        (await f.rows()).filter(
          (row) =>
            row.kind === 'message' && row.message.id === packet.messageId,
        ),
      ).toHaveLength(0);
    },
  );

  it('recovers an actual committed notice after the closing session fence denies its ACK', async () => {
    const f = await fixture();
    const work = await f.prepare();
    if (work.preparedBundle === undefined)
      throw new Error('Expected an actual checked SDK bundle');
    const packet = {
      commandId: followupCommandId,
      workId: work.workId,
      expectedWorkGeneration: work.workGeneration,
      expectedTicketRevision: work.acceptedTicketRevision,
      bundleHash: work.preparedBundle.bundleHash,
      messageId: '793b9b6c-a158-4791-906e-b80a7fbc350c',
    };
    let revoked = false;
    const response = await f.invoke(
      'root.post.committed-ack-denied',
      f.request('post', packet),
      true,
      f.composition,
      {
        messageId: packet.messageId,
        async run() {
          revoked = true;
          await f.f.destroy('staff');
        },
      },
    );
    expect(revoked).toBe(true);
    expect(response.status).toBe(401);
    const committed = await f.rows();
    expect(
      committed.filter(
        (row) => row.kind === 'message' && row.message.id === packet.messageId,
      ),
    ).toHaveLength(1);
    const sessionId = 'z'.repeat(43);
    const csrfToken = 'y'.repeat(43);
    await f.f.sessions.create(sessionId, {
      principalId: f.f.principals.staff,
      data: JSON.stringify({
        version: 1,
        issuer: IDENTITY_ISSUER,
        subject: f.f.principals.staff,
        csrfToken,
      }),
    });
    f.f.cookies.set('staff', SESSION_COOKIE + '=' + sessionId);
    f.f.csrf.set('staff', csrfToken);
    f.state.proofAvailable = false;
    const recovered = await f.invoke(
      'root.post.committed-exact-receipt',
      f.request('post', structuredClone(packet)),
    );
    expect(recovered.status).toBe(200);
    expect(await f.rows()).toEqual(committed);
    expect(
      engineeringHttpResult(await engineeringHttpObject(recovered)),
    ).toMatchObject({ ticketId: work.ticketId, workId: work.workId });
  });
});
