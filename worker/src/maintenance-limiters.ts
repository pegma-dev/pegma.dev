import type { DurableRateLimiter } from '@pegma/rate-limit';

/** Reject schedule/runtime drift instead of silently skipping a policy. */
export function selectMaintenanceLimiters(
  limiters: readonly DurableRateLimiter[],
  index: number | undefined,
): readonly DurableRateLimiter[] {
  if (index === undefined) return limiters;
  if (!Number.isInteger(index) || index < 0 || index >= limiters.length) {
    throw new RangeError('Maintenance limiter index is out of range.');
  }
  return [limiters[index]!];
}
