import {
  defineCollection,
  type Store,
  type StoredValue,
} from '@pegma/storage-core';
import type { Identity, MailWorker } from '@pegma/identity';
import type { DurableRateLimiter } from '@pegma/rate-limit';
import type { SessionStore } from '@pegma/sessions';
import type { Logger } from '@pegma/spine';

export interface IdentityMaintenanceRuntime {
  readonly store: Store;
  readonly identity: Pick<
    Identity,
    'sweepChallenges' | 'sweepEmailOperations' | 'sweepMail'
  >;
  readonly mailWorker: MailWorker | null;
  readonly limiters: readonly DurableRateLimiter[];
  readonly sessions: SessionStore;
}

interface MaintenanceRecord {
  readonly partition: StoredValue;
  readonly id: StoredValue;
  readonly challengeCursor: StoredValue;
  readonly emailOperationCursor: StoredValue;
  readonly mailSendCursor: StoredValue;
  readonly mailReconcileCursor: StoredValue;
  readonly mailSweepCursor: StoredValue;
}

type CursorName =
  | 'challengeCursor'
  | 'emailOperationCursor'
  | 'mailSendCursor'
  | 'mailReconcileCursor'
  | 'mailSweepCursor';

const KEY = { partition: 'identity', id: 'maintenance' } as const;
// Each provider call has a 10-second timeout and workers process a page
// sequentially. Five keeps a worst-case I/O lane inside the one-minute cadence
// and far below Cloudflare's scheduled-handler wall limit.
const MAIL_PROVIDER_PAGE_LIMIT = 5;
const maintenance = defineCollection<MaintenanceRecord>({
  name: 'pegma-dev-maintenance',
  key: (value) => ({
    partition: String(value.partition),
    id: String(value.id),
  }),
  codec: {
    encode: (value) => ({ ...value }),
    decode: (record) => ({
      partition: record.partition ?? null,
      id: record.id ?? null,
      challengeCursor: record.challengeCursor ?? null,
      emailOperationCursor: record.emailOperationCursor ?? null,
      mailSendCursor: record.mailSendCursor ?? null,
      mailReconcileCursor: record.mailReconcileCursor ?? null,
      mailSweepCursor: record.mailSweepCursor ?? null,
    }),
  },
});

function cursor(value: StoredValue): string | undefined {
  return typeof value === 'string' && value.length <= 8_192 ? value : undefined;
}

function emptyRecord(): MaintenanceRecord {
  return {
    partition: KEY.partition,
    id: KEY.id,
    challengeCursor: null,
    emailOperationCursor: null,
    mailSendCursor: null,
    mailReconcileCursor: null,
    mailSweepCursor: null,
  };
}

async function readCursor(
  store: Store,
  name: CursorName,
): Promise<string | undefined> {
  const record = await store.collection(maintenance).get(KEY);
  return record === null ? undefined : cursor(record[name]);
}

async function saveCursor(
  store: Store,
  name: CursorName,
  next: string | null,
): Promise<void> {
  await store.collection(maintenance).update(KEY, (current) => ({
    action: 'write',
    value: {
      ...(current ?? emptyRecord()),
      partition: KEY.partition,
      id: KEY.id,
      [name]: next,
    },
  }));
}

async function runTask(
  logger: Logger,
  name: string,
  task: () => Promise<void>,
): Promise<void> {
  try {
    await task();
    logger.log('info', 'identity.maintenance_completed', { task: name });
  } catch (error) {
    logger.log('error', 'identity.maintenance_failed', {
      task: name,
      error: error instanceof Error ? error.name : 'unknown',
    });
  }
}

export async function runIdentityMaintenance(
  runtime: IdentityMaintenanceRuntime,
  logger: Logger,
): Promise<void> {
  const tasks: Promise<void>[] = [
    runTask(logger, 'challenges', async () => {
      const prior = await readCursor(runtime.store, 'challengeCursor');
      const result = await runtime.identity.sweepChallenges(100, prior);
      await saveCursor(
        runtime.store,
        'challengeCursor',
        result.hasMore ? result.cursor : null,
      );
    }),
    runTask(logger, 'email_operations', async () => {
      const prior = await readCursor(runtime.store, 'emailOperationCursor');
      const result = await runtime.identity.sweepEmailOperations(100, prior);
      await saveCursor(
        runtime.store,
        'emailOperationCursor',
        result.hasMore ? result.cursor : null,
      );
    }),
    runTask(logger, 'rate_limits', async () => {
      await Promise.all(runtime.limiters.map((limiter) => limiter.sweep()));
    }),
    runTask(logger, 'sessions', async () => {
      await runtime.sessions.purgeExpired();
    }),
  ];

  const mailWorker = runtime.mailWorker;
  if (mailWorker !== null) {
    tasks.push(
      runTask(logger, 'mail_send', async () => {
        const prior = await readCursor(runtime.store, 'mailSendCursor');
        const result = await mailWorker.runSendPage({
          limit: MAIL_PROVIDER_PAGE_LIMIT,
          ...(prior === undefined ? {} : { cursor: prior }),
        });
        const terminal = result.results.filter(
          (entry) => entry.status === 'dead_letter',
        ).length;
        if (terminal > 0) {
          logger.log('error', 'identity.mail_terminal', {
            lane: 'send',
            count: terminal,
          });
        }
        await saveCursor(runtime.store, 'mailSendCursor', result.nextCursor);
      }),
      runTask(logger, 'mail_reconcile', async () => {
        const prior = await readCursor(runtime.store, 'mailReconcileCursor');
        const result = await mailWorker.runReconciliationPage({
          limit: MAIL_PROVIDER_PAGE_LIMIT,
          ...(prior === undefined ? {} : { cursor: prior }),
        });
        const terminal = result.results.filter(
          (entry) =>
            entry.status === 'dead_letter' ||
            entry.status === 'terminal_unknown',
        ).length;
        if (terminal > 0) {
          logger.log('error', 'identity.mail_terminal', {
            lane: 'reconcile',
            count: terminal,
          });
        }
        await saveCursor(
          runtime.store,
          'mailReconcileCursor',
          result.nextCursor,
        );
      }),
      runTask(logger, 'mail_retention', async () => {
        const prior = await readCursor(runtime.store, 'mailSweepCursor');
        const result = await runtime.identity.sweepMail({
          limit: 100,
          ...(prior === undefined ? {} : { cursor: prior }),
          terminalBefore: new Date(
            Date.now() - 7 * 24 * 60 * 60_000,
          ).toISOString(),
        });
        await saveCursor(runtime.store, 'mailSweepCursor', result.nextCursor);
      }),
    );
  }

  await Promise.all(tasks);
}
