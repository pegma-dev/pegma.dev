import { fixedClock } from '@pegma/spine';
import { describe, expect, it } from 'vitest';
import { createGlassWingComposition, GLASS_WING } from './composition';

describe('scaffold-cf-minimal (Glass Wing)', () => {
  it('builds an empty-ish composition root without health', () => {
    const composition = createGlassWingComposition({
      clock: fixedClock('2026-07-29T00:00:00.000Z'),
    });
    expect(composition.withHealth).toBe(false);
    expect(composition.health).toBeUndefined();
    expect(composition.clock.now()).toBe('2026-07-29T00:00:00.000Z');
  });

  it('optionally exposes a host-owned liveness handler without @pegma/health', async () => {
    const composition = createGlassWingComposition({
      clock: fixedClock('2026-07-29T00:00:00.000Z'),
      withHealth: true,
    });
    expect(composition.withHealth).toBe(true);
    expect(composition.health).toBeTypeOf('function');
    const res = await composition.health!();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      service: GLASS_WING.service,
      status: 'ok',
      scaffold: true,
    });
  });

  it('does not invent accounts, storage, or mail wiring', () => {
    const composition = createGlassWingComposition({ withHealth: true });
    expect(composition).not.toHaveProperty('identity');
    expect(composition).not.toHaveProperty('sessions');
    expect(composition).not.toHaveProperty('store');
    expect(composition).not.toHaveProperty('mailWorker');
  });
});
