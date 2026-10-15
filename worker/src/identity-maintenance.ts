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

export const IDENTITY_MAINTENANCE_TASKS = [
  'challenges',
  'email_operations',
  'rate_limits',
  'sessions',
  'mail_send',
  'mail_reconcile',
  'mail_retention',
] as const;
export type IdentityMaintenanceTask =
  (typeof IDENTITY_MAINTENANCE_TASKS)[number];

export interface IdentityMaintenanceOptions {
  readonly tasks?: readonly IdentityMaintenanceTask[];
  readonly limiterIndex?: number;
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

async function saveCursors(
  store: Store,
  changes: Partial<Record<CursorName, string | null>>,
): Promise<void> {
  if (Object.keys(changes).length === 0) return;
  await store.collection(maintenance).update(KEY, (current) => {
    if (
      Object.entries(changes).every(
        ([name, next]) => (current?.[name as CursorName] ?? null) === next,
      )
    ) {
      return { action: 'keep' };
    }
    return {
      action: 'write',
      value: {
        ...(current ?? emptyRecord()),
        partition: KEY.partition,
        id: KEY.id,
        ...changes,
      },
    };
  });
}

async function runTask(
  logger: Logger,
  name: string,
  task: () => Promise<void>,
): Promise<void> {
  try {
    await task();
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
  options: IdentityMaintenanceOptions = {},
): Promise<void> {
  // Read once and merge only successful lanes in one conditional update. The
  // former five concurrent writers retried against the same cursor row.
  const selected = options.tasks ?? IDENTITY_MAINTENANCE_TASKS;
  const needsCursor = (name: IdentityMaintenanceTask) =>
    name !== 'sessions' && name !== 'rate_limits';
  const snapshot = selected.some(needsCursor)
    ? await runtime.store
        .collection(maintenance)
        .get(KEY)
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        )
    : { ok: true as const, value: null };
  const prior = snapshot.ok ? snapshot.value : null;
  const changes: Partial<Record<CursorName, string | null>> = {};
  const saveCursor = (name: CursorName, next: string | null): void => {
    if ((prior?.[name] ?? null) !== next) changes[name] = next;
  };
  const tasks: Record<IdentityMaintenanceTask, () => Promise<void>> = {
    challenges: async () => {
      const previous = cursor(prior?.challengeCursor ?? null);
      const result = await runtime.identity.sweepChallenges(100, previous);
      saveCursor('challengeCursor', result.hasMore ? result.cursor : null);
    },
    email_operations: async () => {
      const previous = cursor(prior?.emailOperationCursor ?? null);
      const result = await runtime.identity.sweepEmailOperations(100, previous);
      saveCursor('emailOperationCursor', result.hasMore ? result.cursor : null);
    },
    rate_limits: async () => {
      const limiters =
        options.limiterIndex === undefined
          ? runtime.limiters
          : runtime.limiters.slice(
              options.limiterIndex,
              options.limiterIndex + 1,
            );
      await Promise.all(limiters.map((limiter) => limiter.sweep()));
    },
    sessions: async () => {
      await runtime.sessions.purgeExpired();
    },
    mail_send: async () => {
      const mailWorker = runtime.mailWorker;
      if (mailWorker === null) return;
      const previous = cursor(prior?.mailSendCursor ?? null);
      const result = await mailWorker.runSendPage({
        limit: MAIL_PROVIDER_PAGE_LIMIT,
        ...(previous === undefined ? {} : { cursor: previous }),
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
      saveCursor('mailSendCursor', result.nextCursor);
    },
    mail_reconcile: async () => {
      const mailWorker = runtime.mailWorker;
      if (mailWorker === null) return;
      const previous = cursor(prior?.mailReconcileCursor ?? null);
      const result = await mailWorker.runReconciliationPage({
        limit: MAIL_PROVIDER_PAGE_LIMIT,
        ...(previous === undefined ? {} : { cursor: previous }),
      });
      const terminal = result.results.filter(
        (entry) =>
          entry.status === 'dead_letter' || entry.status === 'terminal_unknown',
      ).length;
      if (terminal > 0) {
        logger.log('error', 'identity.mail_terminal', {
          lane: 'reconcile',
          count: terminal,
        });
      }
      saveCursor('mailReconcileCursor', result.nextCursor);
    },
    mail_retention: async () => {
      if (runtime.mailWorker === null) return;
      const previous = cursor(prior?.mailSweepCursor ?? null);
      const result = await runtime.identity.sweepMail({
        limit: 100,
        ...(previous === undefined ? {} : { cursor: previous }),
        terminalBefore: new Date(
          Date.now() - 7 * 24 * 60 * 60_000,
        ).toISOString(),
      });
      saveCursor('mailSweepCursor', result.nextCursor);
    },
  };
  await Promise.all(
    selected.map((name) =>
      runTask(logger, name, async () => {
        if (needsCursor(name) && !snapshot.ok) throw snapshot.error;
        await tasks[name]();
      }),
    ),
  );
  await saveCursors(runtime.store, changes);
}
