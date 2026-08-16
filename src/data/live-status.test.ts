import { describe, expect, it } from 'vitest';
import { stageClaimsUnpublished, statusFromStage } from './live-status';

describe('stageClaimsUnpublished', () => {
  it('treats unpublished, not published, and Nothing is published as unpublished', () => {
    expect(stageClaimsUnpublished('in-tree, unpublished.')).toBe(true);
    expect(stageClaimsUnpublished('0.1.1 and not published')).toBe(true);
    expect(stageClaimsUnpublished('Nothing is published. (0.1.1, unpublished.)')).toBe(
      true,
    );
    expect(stageClaimsUnpublished('Phase 4 — Stripe adapter in-tree. Nothing is published.')).toBe(
      true,
    );
  });

  it('does not treat a real publish line as unpublished', () => {
    expect(stageClaimsUnpublished('0.1.1 on npm; trusted publishing configured.')).toBe(
      false,
    );
    expect(stageClaimsUnpublished('The 0.1.0 package set is published on npm.')).toBe(
      false,
    );
  });
});

describe('statusFromStage', () => {
  it('does not treat Nothing is published as a positive publish signal', () => {
    expect(statusFromStage('Nothing is published.', 'published')).toBe(
      'in development',
    );
    expect(
      statusFromStage(
        'Phase 4 — Stripe adapter in-tree. Nothing is published. (0.1.1, unpublished.)',
        'published',
      ),
    ).toBe('in development');
  });

  it('keeps a successfully fetched unpublished Stage as in-development when the snapshot is published', () => {
    expect(
      statusFromStage('Phase 5 — Upstash Redis adapter, in-tree, unpublished.', 'published'),
    ).toBe('in development');
    expect(
      statusFromStage('Phase 3 vendor adapters implemented in-tree; unpublished.', 'published'),
    ).toBe('in development');
  });

  it('maps honest publish phrasing to published', () => {
    expect(statusFromStage('0.1.1 on npm; trusted publishing configured.', 'planned')).toBe(
      'published',
    );
    expect(
      statusFromStage('The 0.1.0 package set is published on npm from a signed tag.', 'in development'),
    ).toBe('published');
  });

  it('falls back when there is no Stage paragraph', () => {
    expect(statusFromStage(null, 'published')).toBe('published');
    expect(statusFromStage(null, 'planned')).toBe('planned');
  });
});
