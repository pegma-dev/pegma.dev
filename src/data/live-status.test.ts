import { describe, expect, it } from 'vitest';
import { resolveCompiledStage, stageClaimsUnpublished } from './live-status';

describe('resolveCompiledStage', () => {
  it('drops a stale unpublished Stage when the snapshot is already published', () => {
    const stale =
      'Phase 4 — Stripe adapter in-tree. Nothing is published. (0.1.1, unpublished.)';
    expect(stageClaimsUnpublished(stale)).toBe(true);
    expect(resolveCompiledStage('published', stale)).toEqual({
      status: 'published',
      stage: null,
    });
    expect(
      resolveCompiledStage(
        'published',
        'Phase 5 — Upstash Redis adapter, in-tree, unpublished.',
      ),
    ).toEqual({ status: 'published', stage: null });
    expect(
      resolveCompiledStage(
        'published',
        'Phase 3 vendor adapters implemented in-tree; unpublished.',
      ),
    ).toEqual({ status: 'published', stage: null });
  });

  it('keeps a published Stage paragraph when it does not claim unpublished', () => {
    const stage = '0.1.1 on npm; trusted publishing configured.';
    expect(stageClaimsUnpublished(stage)).toBe(false);
    expect(resolveCompiledStage('published', stage)).toEqual({
      status: 'published',
      stage,
    });
  });

  it('still marks in-development when the snapshot is not published', () => {
    expect(resolveCompiledStage('in development', 'in-tree, unpublished')).toEqual({
      status: 'in development',
      stage: 'in-tree, unpublished',
    });
  });
});
