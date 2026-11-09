import type { IdentityMaintenanceTask } from './identity-maintenance';
import type { KnowledgeMaintenanceTask } from './knowledge-maintenance';
import type { SupportMaintenanceTask } from './support-maintenance';

export const MAIL_CRON = '* * * * *';
// Skip minute zero so every trigger has a distinct schedule.
export const MAIL_RECONCILE_CRON = '1-59 * * * *';
// Cleanup skips minute 59 and rotates through 15 small lanes.
export const CLEANUP_CRON = '0-58 * * * *';
// Even minutes isolate rate cleanup; odd minutes advance one ready KB hint.
export const RATE_LIMIT_CRON = '0-57 * * * *';

export type CleanupLane =
  | {
      readonly kind: 'identity';
      readonly task: IdentityMaintenanceTask;
      readonly limiterIndex?: number;
    }
  | {
      readonly kind: 'support';
      readonly task: SupportMaintenanceTask;
      readonly limiterIndex?: number;
    }
  | {
      readonly kind: 'knowledge';
      readonly task: KnowledgeMaintenanceTask;
    };

const CLEANUP_LANES: readonly CleanupLane[] = [
  { kind: 'identity', task: 'challenges' },
  { kind: 'identity', task: 'email_operations' },
  { kind: 'identity', task: 'mail_retention' },
  { kind: 'identity', task: 'sessions' },
  ...[0, 1, 2, 3].map((limiterIndex) => ({
    kind: 'identity' as const,
    task: 'rate_limits' as const,
    limiterIndex,
  })),
  { kind: 'support', task: 'queue_repair' },
  { kind: 'support', task: 'queue_inactive_sweep' },
  ...[0, 1, 2, 3].map((limiterIndex) => ({
    kind: 'support' as const,
    task: 'rate_limits' as const,
    limiterIndex,
  })),
  { kind: 'knowledge', task: 'rate_limits' },
];

/** Deterministic across cold starts, delayed delivery, and UTC hour boundaries. */
export function cleanupLaneAt(scheduledTime: number): CleanupLane {
  const minute = Math.floor(scheduledTime / 60_000);
  // Count only eligible minutes so skipping minute 59 never skips a lane.
  const tick = minute - Math.floor((minute + 1) / 60);
  const length = CLEANUP_LANES.length;
  return CLEANUP_LANES[((tick % length) + length) % length]!;
}

/** The two jobs never share an invocation or its D1 query allowance. */
export function rateKnowledgeLaneAt(
  scheduledTime: number,
): 'rate_limits' | 'retrieval_ready' {
  return Math.floor(scheduledTime / 60_000) % 2 === 0
    ? 'rate_limits'
    : 'retrieval_ready';
}
