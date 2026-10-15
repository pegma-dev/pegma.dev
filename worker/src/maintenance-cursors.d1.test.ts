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
import { createIdentityRuntime } from './identity-runtime';

const logger: Logger = { log: vi.fn() };
beforeAll(async () => {
  await env.IDENTITY_DB.prepare(
    `CREATE TABLE IF NOT EXISTS RECORDS (
    partition_key TEXT NOT NULL, row_key TEXT NOT NULL, record_json TEXT,
    version INTEGER NOT NULL, deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
    PRIMARY KEY (partition_key, row_key)
  ) STRICT`,
  ).run();
});
beforeEach(async () => {
  vi.clearAllMocks();
  await env.IDENTITY_DB.prepare('DELETE FROM RECORDS').run();
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
