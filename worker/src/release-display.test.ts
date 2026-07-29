import { describe, expect, it } from 'vitest';
import {
  RELEASE_STALE_AFTER_MS,
  classifyReleaseState,
  formatReleaseLabel,
} from './release-display';

const NOW = Date.parse('2026-07-28T20:00:00.000Z');

const current = {
  tagName: 'v0.1.0',
  publishedAt: '2026-07-20T12:00:00.000Z',
  releaseUrl: 'https://github.com/pegma-dev/webhooks/releases/tag/v0.1.0',
  observedAt: '2026-07-28T18:00:00.000Z',
};

describe('classifyReleaseState', () => {
  it('maps unavailable, empty, populated, and stale', () => {
    expect(classifyReleaseState(null, NOW, true)).toBe('unavailable');
    expect(classifyReleaseState(null, NOW, false)).toBe('empty');
    expect(classifyReleaseState(current, NOW, false)).toBe('populated');
    expect(
      classifyReleaseState(
        {
          ...current,
          observedAt: new Date(NOW - RELEASE_STALE_AFTER_MS - 1).toISOString(),
        },
        NOW,
        false,
      ),
    ).toBe('stale');
  });
});

describe('formatReleaseLabel', () => {
  it('joins tag and UTC publication date', () => {
    expect(formatReleaseLabel(current)).toBe('v0.1.0 · 2026-07-20');
  });
});
