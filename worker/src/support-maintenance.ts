import {
  repairQueueProjectionPage,
  sweepInactiveQueueProjections,
} from '@pegma/support-desk-application';
import type { DurableRateLimiter } from '@pegma/rate-limit';
import type { Clock, Logger } from '@pegma/spine';
import type { Store } from '@pegma/storage-core';
import {
  readSupportCursors,
  saveSupportCursors,
  type SupportCursorName,
} from './support-cursors';
import { SUPPORT_TERMINAL_RETENTION_MS } from './support-desk';
import { selectMaintenanceLimiters } from './maintenance-limiters';

export interface SupportMaintenanceRuntime {
  readonly store: Store;
  readonly clock: Clock;
  readonly limiters: readonly DurableRateLimiter[];
  readonly terminalRetentionMilliseconds?: number;
}

const PAGE_LIMIT = 50;

export const SUPPORT_MAINTENANCE_TASKS = [
  'queue_repair',
  'queue_inactive_sweep',
  'rate_limits',
] as const;
export type SupportMaintenanceTask = (typeof SUPPORT_MAINTENANCE_TASKS)[number];
export interface SupportMaintenanceOptions {
  readonly tasks?: readonly SupportMaintenanceTask[];
  readonly limiterIndex?: number;
}

async function runTask(
  logger: Logger,
  name: string,
  task: () => Promise<void>,
): Promise<void> {
  try {
    await task();
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
  options: SupportMaintenanceOptions = {},
): Promise<void> {
  const terminalRetentionMilliseconds =
    runtime.terminalRetentionMilliseconds ?? SUPPORT_TERMINAL_RETENTION_MS;

  const selected = options.tasks ?? SUPPORT_MAINTENANCE_TASKS;
  const snapshot = selected.some((name) => name !== 'rate_limits')
    ? await readSupportCursors(runtime.store).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      )
    : { ok: true as const, value: null };
  const prior = snapshot.ok ? snapshot.value : null;
  const changes: Partial<Record<SupportCursorName, string | null>> = {};
  const previous = (name: SupportCursorName): string | undefined =>
    typeof prior?.[name] === 'string' && prior[name].length <= 8_192
      ? prior[name]
      : undefined;
  const save = (name: SupportCursorName, next: string | null): void => {
    if ((prior?.[name] ?? null) !== next) changes[name] = next;
  };
  const tasks: Record<SupportMaintenanceTask, () => Promise<void>> = {
    queue_repair: async () => {
      const cursor = previous('queueRepairCursor');
      const result = await repairQueueProjectionPage({
        store: runtime.store,
        clock: runtime.clock,
        terminalRetentionMilliseconds,
        limit: PAGE_LIMIT,
        ...(cursor === undefined ? {} : { cursor }),
      });
      save('queueRepairCursor', result.nextCursor);
    },
    queue_inactive_sweep: async () => {
      const cursor = previous('queueInactiveSweepCursor');
      const result = await sweepInactiveQueueProjections({
        store: runtime.store,
        clock: runtime.clock,
        terminalRetentionMilliseconds,
        limit: PAGE_LIMIT,
        ...(cursor === undefined ? {} : { cursor }),
      });
      save('queueInactiveSweepCursor', result.nextCursor);
    },
    rate_limits: async () => {
      const limiters = selectMaintenanceLimiters(
        runtime.limiters,
        options.limiterIndex,
      );
      await Promise.all(limiters.map((limiter) => limiter.sweep()));
    },
  };

  await Promise.all(
    selected.map((name) =>
      runTask(logger, name, async () => {
        if (name !== 'rate_limits' && !snapshot.ok) throw snapshot.error;
        await tasks[name]();
      }),
    ),
  );
  await runTask(logger, 'cursors', () =>
    saveSupportCursors(runtime.store, changes),
  );
}
