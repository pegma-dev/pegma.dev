import { createMemoryStore } from '@pegma/storage-core';
import { createDurableLimiter, defineRateLimitPolicy } from '@pegma/rate-limit';
import { describe, expect, it } from 'vitest';
import { selectMaintenanceLimiters } from './maintenance-limiters';

const store = createMemoryStore();
const limiters = [0, 1].map((index) =>
  createDurableLimiter(
    defineRateLimitPolicy({
      name: `maintenance-test-${index}`,
      limit: 1,
      windowMs: 60_000,
    }),
    store,
  ),
);

describe('maintenance limiter selection', () => {
  it('selects one policy or the full set explicitly', () => {
    expect(selectMaintenanceLimiters(limiters, undefined)).toBe(limiters);
    expect(selectMaintenanceLimiters(limiters, 1)).toEqual([limiters[1]]);
  });
  it.each([-1, 0.5, 2, NaN, Infinity])('rejects invalid index %s', (index) => {
    expect(() => selectMaintenanceLimiters(limiters, index)).toThrow(
      RangeError,
    );
  });
});
