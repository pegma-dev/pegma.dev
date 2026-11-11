import { env } from 'cloudflare:workers';
import { createCloudflareD1Store } from '@pegma/storage-cloudflare-d1';
import { createSessionStore } from '@pegma/sessions';
import { createDurableLimiter } from '@pegma/rate-limit-paged';
import { systemClock, type Logger } from '@pegma/spine';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runIdentityMaintenance,
  type IdentityMaintenanceRuntime,
} from './identity-maintenance';
import { runSupportMaintenance } from './support-maintenance';
import {
  createIdentityRuntime,
  createProductionIdentityRuntime,
} from './identity-runtime';
import {
  createProductionSupportRuntime,
  createAdminMutationLimiter,
  createAdminLookupLimiter,
  createProductionSupportMaintenanceRuntime,
} from './support-desk';
import { identityLinkKeyFromVerifiedIdentityClaims } from '@pegma/authorization-identity';
import {
  cleanupLaneAt,
  CLEANUP_LANE_COUNT,
  CLEANUP_CRON,
  rateKnowledgeLaneAt,
  RATE_LIMIT_CRON,
} from './maintenance-schedule';
import worker from './index';

const logger: Logger = { log: vi.fn() };
let engineeringCleanupBudget: { limiterIndex: number; physicalCalls: number;
  expiredWindowsSwept: number; otherPurposeWindowsRetained: number } | undefined;
afterEach(({ task }) => {
  if (engineeringCleanupBudget !== undefined)
    Object.assign(task.meta, { engineeringLimiterCleanupD1Budget: engineeringCleanupBudget });
});
/** Semantically matches worker/migrations/0001_pegma_storage.sql. */
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS RECORDS (
  partition_key TEXT NOT NULL,
  row_key TEXT NOT NULL,
  record_json TEXT,
  version INTEGER NOT NULL,
  deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
  PRIMARY KEY (partition_key, row_key)
) STRICT`,
  `CREATE TABLE IF NOT EXISTS PEGMA_STORAGE_D1_TX_GUARD (
  reason TEXT NOT NULL
) STRICT`,
  `CREATE TRIGGER IF NOT EXISTS PEGMA_STORAGE_D1_TX_ABORT_EXISTS
BEFORE INSERT ON PEGMA_STORAGE_D1_TX_GUARD
WHEN NEW.reason = 'exists'
BEGIN
  SELECT RAISE(ABORT, 'PEGMA_STORAGE_D1_TX_EXISTS');
END`,
  `CREATE TRIGGER IF NOT EXISTS PEGMA_STORAGE_D1_TX_ABORT_MISSING
BEFORE INSERT ON PEGMA_STORAGE_D1_TX_GUARD
WHEN NEW.reason = 'missing'
BEGIN
  SELECT RAISE(ABORT, 'PEGMA_STORAGE_D1_TX_MISSING');
END`,
  `CREATE TRIGGER IF NOT EXISTS PEGMA_STORAGE_D1_TX_ABORT_CHANGED
BEFORE INSERT ON PEGMA_STORAGE_D1_TX_GUARD
WHEN NEW.reason = 'changed'
BEGIN
  SELECT RAISE(ABORT, 'PEGMA_STORAGE_D1_TX_CHANGED');
END`,
] as const;

beforeAll(async () => {
  for (const statement of SCHEMA_STATEMENTS) {
    await env.IDENTITY_DB.prepare(statement).run();
  }
});
beforeEach(async () => {
  engineeringCleanupBudget = undefined;
  vi.clearAllMocks();
  await env.IDENTITY_DB.prepare('DELETE FROM RECORDS').run();
  await env.IDENTITY_DB.prepare('DELETE FROM PEGMA_STORAGE_D1_TX_GUARD').run();
});

/** Count binding executions while all SQL still runs against the real D1. */
function limitedD1(database: D1Database) {
  let calls = 0;
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const charge = () => {
    calls += 1;
    if (calls > 50)
      throw new Error('Synthetic Workers Free D1 call limit exceeded.');
  };
  const statement = (original: D1PreparedStatement): D1PreparedStatement => {
    const counted = new Proxy(original, {
      get(target, property) {
        if (property === 'bind')
          return (...values: unknown[]) => statement(target.bind(...values));
        const method = Reflect.get(target, property, target);
        if (['first', 'run', 'all', 'raw'].includes(String(property))) {
          return (...args: unknown[]) => {
            charge();
            return Reflect.apply(method, target, args);
          };
        }
        return typeof method === 'function' ? method.bind(target) : method;
      },
    });
    originals.set(counted, original);
    return counted;
  };
  const binding = <T extends D1Database | D1DatabaseSession>(original: T): T =>
    new Proxy(original, {
      get(target, property) {
        if (property === 'prepare')
          return (query: string) => statement(target.prepare(query));
        if (property === 'batch')
          return (statements: D1PreparedStatement[]) => {
            // D1 documents one invocation query for the entire batch call.
            charge();
            return target.batch(
              statements.map((item) => originals.get(item) ?? item),
            );
          };
        if (property === 'withSession' && 'withSession' in target) {
          return (constraint?: D1SessionBookmark | D1SessionConstraint) =>
            binding(target.withSession(constraint));
        }
        const method = Reflect.get(target, property, target);
        if (property === 'exec' || property === 'dump') {
          if (typeof method !== 'function')
            throw new TypeError('Expected a callable D1 execution method.');
          return (...args: unknown[]) => {
            charge();
            return Reflect.apply(method, target, args);
          };
        }
        return typeof method === 'function' ? method.bind(target) : method;
      },
    });
  return { database: binding(database), calls: () => calls };
}

function fixture() {
  const store = createCloudflareD1Store({
    database: env.IDENTITY_DB,
    createSchemaIfMissing: false,
  });
  const runtime: IdentityMaintenanceRuntime = {
    store,
    identity: {
      sweepChallenges: vi.fn(async () => ({
        inspected: 0,
        pulled: 0,
        deleted: 0,
        rejected: 0,
        hasMore: true,
        cursor: 'challenge-next',
      })),
      sweepEmailOperations: vi.fn(async () => ({
        inspected: 0,
        repaired: 0,
        failed: 0,
        rejected: 0,
        deleted: 0,
        hasMore: true,
        cursor: 'operation-next',
      })),
      sweepMail: vi.fn(async () => ({
        examined: 0,
        deleted: 0,
        nextCursor: 'retention-next',
        more: true,
      })),
    },
    mailWorker: {
      send: vi.fn(),
      reconcile: vi.fn(),
      runSendPage: vi.fn(async () => ({
        examined: 0,
        results: [],
        nextCursor: 'send-next',
      })),
      runReconciliationPage: vi.fn(async () => ({
        examined: 0,
        results: [],
        nextCursor: 'reconcile-next',
      })),
    },
    sessions: createSessionStore(store, { logger }),
    limiters: [],
  };
  return { store, runtime };
}

describe('maintenance cursor writes over D1', () => {
  it.each([4, 5])('runs only engineering limiter %s through the real scheduled root within the physical D1 budget', async (limiterIndex) => {
    const setup = createProductionSupportMaintenanceRuntime(env);
    const expired = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    for (const index of [4, 5]) {
      for (let subject = 0; subject < 24; subject += 1)
        expect((await setup.limiters[index]!.allow('engineering-cleanup-staff-' + subject, expired)).allowed).toBe(true);
    }
    const count = () => env.IDENTITY_DB.prepare('SELECT COUNT(*) AS count FROM RECORDS WHERE deleted = 0').first<number>('count');
    expect(await count()).toBe(48);
    const metered = limitedD1(env.IDENTITY_DB);
    const pending: Promise<unknown>[] = [];
    const secretRead = vi.fn(() => { throw new Error('Support rate cleanup must not initialize Identity.'); });
    const environment: Parameters<typeof worker.scheduled>[1] = {
      ...env, IDENTITY_DB: metered.database, DATADOG_API_KEY: undefined,
      PEGMA_SUPPORT_LEARNING_REVIEWS_ENABLED: 'false',
      get IDENTITY_EMAIL_CODE_SECRET_BASE64(): string { return secretRead(); },
    };
    // Match the generated deployment literal while explicitly testing an
    // isolated disabled cleanup invocation, as the parent root fixtures do.
    Object.defineProperty(environment, 'PEGMA_KNOWLEDGE_ENABLED', {
      value: 'false', writable: true, enumerable: true, configurable: true,
    });
    const start = Math.floor(Date.now() / 60_000) * 60_000;
    const scheduledTime = Array.from({ length: 120 }, (_, offset) => start + offset * 60_000).find((time) => {
      const lane = cleanupLaneAt(time);
      return new Date(time).getUTCMinutes() <= 58 && lane.kind === 'support' &&
        lane.task === 'rate_limits' && lane.limiterIndex === limiterIndex;
    });
    if (scheduledTime === undefined) throw new Error('Expected the bounded exclusive engineering cleanup lane');
    worker.scheduled({ cron: CLEANUP_CRON, scheduledTime, noRetry() {} }, environment,
      { waitUntil: (promise: Promise<unknown>) => { pending.push(promise); },
        passThroughOnException() {}, props: {}, exports: {} } as ExecutionContext);
    await Promise.all(pending);
    expect(pending).toHaveLength(1); expect(secretRead).not.toHaveBeenCalled();
    expect(metered.calls()).toBeGreaterThan(0); expect(metered.calls()).toBeLessThanOrEqual(50);
    // One complete purpose was swept; the other 24 genuine expired windows
    // remain for their own physical invocation rather than sharing its budget.
    expect(await count()).toBe(24);
    engineeringCleanupBudget = { limiterIndex, physicalCalls: metered.calls(),
      expiredWindowsSwept: 24, otherPurposeWindowsRetained: 24 };
  });

  it('runs two actual isolated scheduled pages within 50 D1 calls each and persists their continuation', async () => {
    const { store } = fixture();
    const start = new Date(Date.now() - 180_000).toISOString();
    const limiter = createDurableLimiter(
      { name: 'pegma.test.d1.knowledge.capacity', limit: 1, windowMs: 60_000 },
      store,
    );
    for (let index = 0; index < 25; index++) {
      expect(await limiter.allow(`192.0.2.${index + 1}`, start)).toEqual({
        allowed: true,
      });
    }
    const invoke = async () => {
      const metered = limitedD1(env.IDENTITY_DB);
      const pending: Promise<unknown>[] = [];
      const secretRead = vi.fn(() => {
        throw new Error('Rate maintenance must not read Identity secrets.');
      });
      const scheduledEnvironment: Parameters<typeof worker.scheduled>[1] = {
        ...env,
        IDENTITY_DB: metered.database,
        DATADOG_API_KEY: undefined,
        get IDENTITY_EMAIL_CODE_SECRET_BASE64(): string {
          return secretRead();
        },
      };
      // Override the generated deployment literal for disabled-path coverage.
      Object.defineProperty(scheduledEnvironment, 'PEGMA_KNOWLEDGE_ENABLED', {
        value: 'false',
        writable: true,
        enumerable: true,
        configurable: true,
      });
      // Wrangler's generated type records the deployed default literal, while
      // this test intentionally supplies malformed runtime configuration.
      Object.defineProperty(scheduledEnvironment, 'PEGMA_AGENT_CLIENTS_JSON', {
        value: 'not-json',
      });
      const startMinute = Math.floor(Date.now() / 60_000) * 60_000;
      const scheduledTime = Array.from(
        { length: 120 },
        (_, offset) => startMinute + offset * 60_000,
      ).find(
        (candidate) =>
          new Date(candidate).getUTCMinutes() <= 57 &&
          rateKnowledgeLaneAt(candidate) === 'rate_limits',
      );
      if (scheduledTime === undefined)
        throw new Error('No actual rate-lane tick in the bounded schedule.');
      worker.scheduled(
        {
          cron: RATE_LIMIT_CRON,
          scheduledTime,
          noRetry() {},
        },
        scheduledEnvironment,
        {
          waitUntil: (promise: Promise<unknown>) => {
            pending.push(promise);
          },
          passThroughOnException() {},
          props: {},
          exports: {},
        } as ExecutionContext,
      );
      await Promise.all(pending);
      expect(pending).toHaveLength(1);
      expect(secretRead).not.toHaveBeenCalled();
      expect(metered.calls()).toBeGreaterThan(0);
      expect(metered.calls()).toBeLessThanOrEqual(50);
      return metered.calls();
    };
    const read = async () => {
      const row = await env.IDENTITY_DB.prepare(
        "SELECT record_json FROM RECORDS WHERE partition_key = 'pegma-dev-maintenance:knowledge' AND row_key = 'rate-limits' AND deleted = 0",
      ).first<{ record_json: string }>();
      return row === null ? null : JSON.parse(row.record_json);
    };
    const firstCalls = await invoke();
    expect(await read()).toEqual({
      partition: 'knowledge',
      id: 'rate-limits',
      cursor: expect.any(String),
      generation: 1,
    });
    // Twenty deleted counters, five remaining counters, descriptor and bookmark.
    expect(
      await env.IDENTITY_DB.prepare(
        'SELECT COUNT(*) AS count FROM RECORDS WHERE deleted = 0',
      ).first('count'),
    ).toBe(7);
    const secondCalls = await invoke();
    expect(await read()).toEqual({
      partition: 'knowledge',
      id: 'rate-limits',
      cursor: null,
      generation: 2,
    });
    expect(firstCalls).toBeGreaterThan(secondCalls);
    expect([firstCalls, secondCalls]).toEqual([44, 14]);
    // No other maintenance records were created by either scheduled invocation.
    expect(
      await env.IDENTITY_DB.prepare(
        'SELECT COUNT(*) AS count FROM RECORDS WHERE deleted = 0',
      ).first('count'),
    ).toBe(2);
    const batching = limitedD1(env.IDENTITY_DB);
    const results = await batching.database.batch([
      batching.database.prepare('SELECT 1 AS value'),
      batching.database.prepare('SELECT 2 AS value'),
    ]);
    expect(results.map((result) => result.results[0])).toEqual([
      { value: 1 },
      { value: 2 },
    ]);
    expect(batching.calls()).toBe(1);
  });

  it('drains real mail jobs one per tick and resumes safely after wrapping', async () => {
    const { store } = fixture();
    const send = vi.fn(async () => ({
      providerMessageRef: crypto.randomUUID(),
    }));
    const runtime = createIdentityRuntime(
      {
        store,
        emailCodeSecretBase64: btoa(
          String.fromCharCode(...new Uint8Array(32).fill(7)),
        ),
        emailFrom: 'Pegma <identity@pegma.dev>',
        emailEnabled: true,
        mailDelivery: {
          provider: { send },
          reconciliation: { reconcile: async () => ({ status: 'unknown' }) },
          classifyFailure: () => 'unavailable',
        },
      },
      logger,
    );
    for (let index = 0; index < 3; index++) {
      const response = await runtime.api(
        new Request(
          'https://pegma.dev/api/identity/email-code/account/options',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Origin: 'https://pegma.dev',
              'Sec-Fetch-Site': 'same-origin',
              'CF-Connecting-IP': '192.0.2.1',
            },
            body: JSON.stringify({
              email: `maintenance-${index}@example.test`,
            }),
          },
        ),
      );
      expect(response.status).toBe(200);
    }
    for (let tick = 0; tick < 6; tick++) {
      const before = send.mock.calls.length;
      await runIdentityMaintenance(runtime, logger, { tasks: ['mail_send'] });
      expect(send.mock.calls.length - before).toBeLessThanOrEqual(1);
    }
    expect(send).toHaveBeenCalledTimes(3);
    expect(logger.log).not.toHaveBeenCalledWith(
      'error',
      expect.anything(),
      expect.anything(),
    );
  });

  it('covers every limiter in the real production compositions', () => {
    const identity = createProductionIdentityRuntime(
      {
        ...env,
        IDENTITY_EMAIL_CODE_SECRET_BASE64: btoa(
          String.fromCharCode(...new Uint8Array(32).fill(7)),
        ),
      },
      logger,
    );
    const support = createProductionSupportRuntime(env, {
      identity: identity.identity,
      sessions: identity.sessions,
      identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
      logger,
    });
    const supportLimiters = [
      ...support.limiters,
      createAdminMutationLimiter(support.store),
      createAdminLookupLimiter(support.store),
    ];
    expect(
      createProductionSupportMaintenanceRuntime(env).limiters,
    ).toHaveLength(supportLimiters.length);
    const lanes = Array.from({ length: CLEANUP_LANE_COUNT }, (_, index) =>
      cleanupLaneAt(Date.parse('2026-10-15T12:01:00Z') + index * 60_000),
    );
    for (const [kind, limiters] of [
      ['identity', identity.limiters],
      ['support', supportLimiters],
    ] as const) {
      const indices = lanes
        .filter((lane) => lane.kind === 'identity' || lane.kind === 'support')
        .filter((lane) => lane.kind === kind && lane.task === 'rate_limits')
        .map((lane) => lane.limiterIndex)
        .sort();
      expect(indices).toEqual(limiters.map((_, index) => index));
    }
  });

  it('retries an overlapping mail/cleanup CAS conflict and preserves both sets of cursors', async () => {
    const { store, runtime } = fixture();
    await runIdentityMaintenance(runtime, logger);
    vi.mocked(runtime.identity.sweepChallenges).mockResolvedValue({
      inspected: 0,
      pulled: 0,
      deleted: 0,
      rejected: 0,
      hasMore: true,
      cursor: 'challenge-after-overlap',
    });
    vi.mocked(runtime.mailWorker!.runSendPage).mockResolvedValue({
      examined: 0,
      results: [],
      nextCursor: 'send-after-overlap',
    });
    let decisions = 0;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const collection = store.collection;
    vi.spyOn(store, 'collection').mockImplementation((definition) => {
      const target = collection(definition);
      return {
        ...target,
        update: (key, decide, options) =>
          target.update(
            key,
            async (current) => {
              decisions++;
              if (decisions === 2) release();
              if (decisions <= 2) await ready;
              return decide(current);
            },
            options,
          ),
      };
    });
    await Promise.all([
      runIdentityMaintenance(runtime, logger, {
        tasks: ['mail_send', 'mail_reconcile'],
      }),
      runIdentityMaintenance(runtime, logger, { tasks: ['challenges'] }),
    ]);
    expect(decisions).toBe(3);
    const row = await env.IDENTITY_DB.prepare(
      "SELECT record_json, version FROM RECORDS WHERE partition_key = 'pegma-dev-maintenance:identity'",
    ).first<{ record_json: string; version: number }>();
    expect(row?.version).toBe(3);
    expect(JSON.parse(row!.record_json)).toMatchObject({
      mailSendCursor: 'send-after-overlap',
      challengeCursor: 'challenge-after-overlap',
      mailReconcileCursor: 'reconcile-next',
    });
    expect(logger.log).not.toHaveBeenCalledWith(
      'error',
      expect.anything(),
      expect.anything(),
    );
  });

  it('keeps the real published mail workers idle without writes or provider calls', async () => {
    const { store } = fixture();
    const send = vi.fn(async () => {
      throw new Error('unexpected send');
    });
    const reconcile = vi.fn(async () => {
      throw new Error('unexpected reconciliation');
    });
    const runtime = createIdentityRuntime(
      {
        store,
        emailCodeSecretBase64: btoa(
          String.fromCharCode(...new Uint8Array(32).fill(7)),
        ),
        emailFrom: 'Pegma <identity@pegma.dev>',
        emailEnabled: true,
        mailDelivery: {
          provider: { send },
          reconciliation: { reconcile },
          classifyFailure: () => 'unavailable',
        },
      },
      logger,
    );
    for (let tick = 0; tick < 2; tick++) {
      await runIdentityMaintenance(runtime, logger, {
        tasks: ['mail_send', 'mail_reconcile'],
      });
    }
    expect(
      await env.IDENTITY_DB.prepare(
        'SELECT COUNT(*) AS count FROM RECORDS',
      ).first('count'),
    ).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('merges five simultaneous lane results in one write and skips unchanged bookmarks', async () => {
    const { runtime } = fixture();
    await runIdentityMaintenance(runtime, logger);
    const read = () =>
      env.IDENTITY_DB.prepare(
        "SELECT record_json, version FROM RECORDS WHERE partition_key = 'pegma-dev-maintenance:identity'",
      ).first<{ record_json: string; version: number }>();
    const first = await read();
    expect(first?.version).toBe(1);
    expect(JSON.parse(first!.record_json)).toMatchObject({
      challengeCursor: 'challenge-next',
      emailOperationCursor: 'operation-next',
      mailSendCursor: 'send-next',
      mailReconcileCursor: 'reconcile-next',
      mailSweepCursor: 'retention-next',
    });
    await runIdentityMaintenance(runtime, logger);
    expect(await read()).toEqual(first);
    expect(logger.log).not.toHaveBeenCalledWith(
      'error',
      expect.anything(),
      expect.anything(),
    );
  });

  it('preserves failed and unselected lanes while advancing successful mail cursors', async () => {
    const { runtime } = fixture();
    await runIdentityMaintenance(runtime, logger);
    vi.mocked(runtime.mailWorker!.runSendPage).mockResolvedValue({
      examined: 0,
      results: [],
      nextCursor: null,
    });
    vi.mocked(runtime.mailWorker!.runReconciliationPage).mockRejectedValue(
      new Error('provider unavailable'),
    );
    await runIdentityMaintenance(runtime, logger, {
      tasks: ['mail_send', 'mail_reconcile'],
    });
    const row = await env.IDENTITY_DB.prepare(
      "SELECT record_json, version FROM RECORDS WHERE partition_key = 'pegma-dev-maintenance:identity'",
    ).first<{ record_json: string; version: number }>();
    expect(row?.version).toBe(2);
    expect(JSON.parse(row!.record_json)).toMatchObject({
      mailSendCursor: null,
      mailReconcileCursor: 'reconcile-next',
      challengeCursor: 'challenge-next',
      emailOperationCursor: 'operation-next',
      mailSweepCursor: 'retention-next',
    });
  });

  it('does not create or rewrite support bookmarks for empty queue pages', async () => {
    const { store } = fixture();
    const run = () =>
      runSupportMaintenance(
        { store, clock: systemClock, limiters: [] },
        logger,
      );
    await run();
    expect(
      await env.IDENTITY_DB.prepare(
        'SELECT COUNT(*) AS count FROM RECORDS',
      ).first('count'),
    ).toBe(0);
    const record = JSON.stringify({
      partition: 'support-desk',
      id: 'maintenance',
      queueRepairCursor: null,
      queueInactiveSweepCursor: null,
    });
    await env.IDENTITY_DB.prepare('INSERT INTO RECORDS VALUES (?, ?, ?, 7, 0)')
      .bind('pegma-dev-support-maintenance:support-desk', 'maintenance', record)
      .run();
    await run();
    expect(
      await env.IDENTITY_DB.prepare('SELECT version FROM RECORDS').first(
        'version',
      ),
    ).toBe(7);
    expect(logger.log).not.toHaveBeenCalledWith(
      'error',
      expect.anything(),
      expect.anything(),
    );
  });
});
