import { env } from 'cloudflare:workers';
import { createWebhookLedger } from '@pegma/webhooks';
import { createCloudflareD1Store } from '@pegma/storage-cloudflare-d1';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@pegma/spine';

declare global {
  namespace Cloudflare {
    interface Env {
      IDENTITY_DB: D1Database;
    }
  }
}

const logger: Logger = { log: vi.fn() };

/** Same statements as worker/migrations/0001_pegma_storage.sql. */
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
  await env.IDENTITY_DB.prepare('DELETE FROM RECORDS').run();
  await env.IDENTITY_DB.prepare('DELETE FROM PEGMA_STORAGE_D1_TX_GUARD').run();
});

describe('vendored @pegma/webhooks over Cloudflare D1 composition', () => {
  it('uses createSchemaIfMissing: false like production Identity', async () => {
    const store = createCloudflareD1Store({
      database: env.IDENTITY_DB,
      createSchemaIfMissing: false,
    });
    const ledger = createWebhookLedger({
      store,
      source: 'github',
      logger,
    });

    const first = await ledger.begin(
      '22222222-2222-4222-8222-222222222222',
      'github.release.published',
    );
    expect(first).toEqual({ status: 'new', attempts: 0 });

    await ledger.markProcessed('22222222-2222-4222-8222-222222222222');

    const duplicate = await ledger.begin(
      '22222222-2222-4222-8222-222222222222',
      'github.release.published',
    );
    expect(duplicate).toEqual({ status: 'processed', attempts: 0 });
  });
});
