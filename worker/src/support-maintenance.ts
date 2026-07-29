import {
  repairQueueProjectionPage,
  sweepInactiveQueueProjections,
} from '@pegma/support-desk-application';
import type { DurableRateLimiter } from '@pegma/rate-limit';
import type { Clock, Logger } from '@pegma/spine';
import type { Store } from '@pegma/storage-core';
import { readSupportCursor, saveSupportCursor } from './support-cursors';
import { SUPPORT_TERMINAL_RETENTION_MS } from './support-desk';

export interface SupportMaintenanceRuntime {
  readonly store: Store;
  readonly clock: Clock;
  readonly limiters: readonly DurableRateLimiter[];
  readonly terminalRetentionMilliseconds?: number;
}

const PAGE_LIMIT = 50;

async function runTask(
  logger: Logger,
  name: string,
  task: () => Promise<void>,
): Promise<void> {
  try {
    await task();
    logger.log('info', 'support.maintenance_completed', { task: name });
  } catch (error) {
    logger.log('error', 'support.maintenance_failed', {
      task: name,
      error: error instanceof Error ? error.name : 'unknown',
    });
  }
}

/**
 * Host-owned Support Desk maintenance: queue repair, inactive sweep, and
 * durable rate-limit window cleanup. Cursors are independent of Identity.
 */
export async function runSupportMaintenance(
  runtime: SupportMaintenanceRuntime,
  logger: Logger,
): Promise<void> {
  const terminalRetentionMilliseconds =
    runtime.terminalRetentionMilliseconds ?? SUPPORT_TERMINAL_RETENTION_MS;

  const tasks: Promise<void>[] = [
    runTask(logger, 'queue_repair', async () => {
      const prior = await readSupportCursor(runtime.store, 'queueRepairCursor');
      const result = await repairQueueProjectionPage({
        store: runtime.store,
        clock: runtime.clock,
        terminalRetentionMilliseconds,
        limit: PAGE_LIMIT,
        ...(prior === undefined ? {} : { cursor: prior }),
      });
      await saveSupportCursor(
        runtime.store,
        'queueRepairCursor',
        result.nextCursor,
      );
    }),
    runTask(logger, 'queue_inactive_sweep', async () => {
      const prior = await readSupportCursor(
        runtime.store,
        'queueInactiveSweepCursor',
      );
      const result = await sweepInactiveQueueProjections({
        store: runtime.store,
        clock: runtime.clock,
        terminalRetentionMilliseconds,
        limit: PAGE_LIMIT,
        ...(prior === undefined ? {} : { cursor: prior }),
      });
      await saveSupportCursor(
        runtime.store,
        'queueInactiveSweepCursor',
        result.nextCursor,
      );
    }),
    runTask(logger, 'rate_limits', async () => {
      await Promise.all(runtime.limiters.map((limiter) => limiter.sweep()));
    }),
  ];

  await Promise.all(tasks);
}
