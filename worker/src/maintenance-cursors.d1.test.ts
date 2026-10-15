import { env } from 'cloudflare:workers';
import { createCloudflareD1Store } from '@pegma/storage-cloudflare-d1';
import { createSessionStore } from '@pegma/sessions';
import { systemClock, type Logger } from '@pegma/spine';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
} from './support-desk';
import { identityLinkKeyFromVerifiedIdentityClaims } from '@pegma/authorization-identity';
import { cleanupLaneAt } from './maintenance-schedule';

const logger: Logger = { log: vi.fn() };
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
  vi.clearAllMocks();
  await env.IDENTITY_DB.prepare('DELETE FROM RECORDS').run();
  await env.IDENTITY_DB.prepare('DELETE FROM PEGMA_STORAGE_D1_TX_GUARD').run();
});

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
    const lanes = Array.from({ length: 14 }, (_, index) =>
      cleanupLaneAt(Date.parse('2026-10-15T12:01:00Z') + index * 60_000),
    );
    for (const [kind, limiters] of [
      ['identity', identity.limiters],
      ['support', supportLimiters],
    ] as const) {
      const indices = lanes
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
