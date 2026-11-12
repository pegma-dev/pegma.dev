import type { IdentityMaintenanceTask } from './identity-maintenance';
import type { KnowledgeMaintenanceTask } from './knowledge-maintenance';
import type { SupportMaintenanceTask } from './support-maintenance';

export const MAIL_CRON = '* * * * *';
// Skip minute zero so every trigger has a distinct schedule.
export const MAIL_RECONCILE_CRON = '1-59 * * * *';
// Cleanup skips minute 59 and rotates through 18 lanes when answering is OFF,
// or 20 lanes when answering is enabled.
export const CLEANUP_CRON = '0-58 * * * *';
// Two ticks clean rate windows, then one advances a ready KB hint.
// A distinct all-minute trigger: answering owns this physical invocation when ON.
// With answering OFF, the dispatcher retains the former minutes0..57 work.
export const RATE_LIMIT_CRON = '*/1 * * * *';

/** OFF-mode background work retains the former 0..57 minute window. */
export function rateKnowledgeBackgroundEligibleAt(
  scheduledTime: number,
): boolean {
  return new Date(scheduledTime).getUTCMinutes() < 58;
}

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
    }
  | { readonly kind: 'learning_reviews' }
  | { readonly kind: 'knowledge_rate_limits' }
  | { readonly kind: 'knowledge_ready' };

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
  ...[0, 1, 2, 3, 4, 5].map((limiterIndex) => ({
    kind: 'support' as const,
    task: 'rate_limits' as const,
    limiterIndex,
  })),
  { kind: 'knowledge', task: 'rate_limits' },
  { kind: 'learning_reviews' },
];

const ANSWERING_CLEANUP_LANES: readonly CleanupLane[] = [
  ...CLEANUP_LANES,
  { kind: 'knowledge_rate_limits' },
  { kind: 'knowledge_ready' },
];

/** Legacy/default rotation; enabling answering adds two bounded background lanes. */
export const CLEANUP_LANE_COUNT = CLEANUP_LANES.length;

/** Deterministic across cold starts, delayed delivery, and UTC hour boundaries. */
export function cleanupLaneAt(scheduledTime: number, answeringEnabled = false): CleanupLane {
  const minute = Math.floor(scheduledTime / 60_000);
  // Count only eligible minutes so skipping minute 59 never skips a lane.
  const tick = minute - Math.floor((minute + 1) / 60);
  const lanes = answeringEnabled ? ANSWERING_CLEANUP_LANES : CLEANUP_LANES;
  const length = lanes.length;
  return lanes[((tick % length) + length) % length]!;
}

/** The two jobs never share an invocation or its D1 query allowance. */
export function rateKnowledgeLaneAt(
  scheduledTime: number,
): 'rate_limits' | 'retrieval_ready' {
  return Math.floor(scheduledTime / 60_000) % 3 === 2
    ? 'retrieval_ready'
    : 'rate_limits';
}
