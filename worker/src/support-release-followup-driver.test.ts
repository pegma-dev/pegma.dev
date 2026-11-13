import { describe, expect, it } from 'vitest';
import { createSupportFollowupHostFixture } from './support-release-followup-host-fixtures';
import {
  createSupportReleaseFollowupDriver,
  supportReleaseFollowupCheckpoints,
  supportReleaseFollowupWakeDue,
} from './support-release-followup-driver';
import { createSupportReleaseFollowupRuntime } from './support-release-followup';
import type { Store } from '@pegma/storage-core';

async function fixture() {
  const f = await createSupportFollowupHostFixture();
  const mapping = await f.source.mappings!.verify(
    f.context,
    f.f.identity.ticketId,
    f.mappingPacket,
  );
  const observed = await f.runtime.observe(f.context, {
    ...f.f.identity,
    commandId: crypto.randomUUID(),
    inputReference: mapping.inputReference,
  });
  if (!observed.workId)
    throw new Error('Actual follow-up work was not observed');
  const key = { ticketId: f.f.identity.ticketId, workId: observed.workId };
  const state = { enabled: true };
  const driver = createSupportReleaseFollowupDriver({
    store: f.store,
    clock: f.f.clock,
    enabled: () => state.enabled,
    runtime: (current) =>
      createSupportReleaseFollowupRuntime({
        application: f.host.application,
        store: f.store,
        clock: f.f.clock,
        configuration: f.composition.configuration,
        enabled: current,
      }),
  });
  return { ...f, key, state, driver };
}
describe('bounded production release-follow-up cursor', () => {
  it('uses only existing fifteen-minute slots and refuses invalid schedule hints', () => {
    expect(
      supportReleaseFollowupWakeDue(Date.parse('2026-11-12T12:00:00.000Z')),
    ).toBe(true);
    expect(
      supportReleaseFollowupWakeDue(Date.parse('2026-11-12T12:15:00.000Z')),
    ).toBe(true);
    expect(
      supportReleaseFollowupWakeDue(Date.parse('2026-11-12T12:05:00.000Z')),
    ).toBe(false);
    expect(supportReleaseFollowupWakeDue(NaN)).toBe(false);
  });
  it('keeps OFF lazy and uses an independent purpose collection', async () => {
    const store: Store = {
      collection() {
        throw new Error('OFF must not initialize Store');
      },
    };
    const driver = createSupportReleaseFollowupDriver({
      store,
      clock: { now: () => new Date().toISOString() },
      enabled: () => false,
      runtime() {
        throw new Error('OFF must not initialize runtime');
      },
    });
    expect(await driver.runTick()).toEqual({
      outcome: 'disabled',
      checkpointSaved: false,
    });
    expect(supportReleaseFollowupCheckpoints.name).toBe(
      'pegma.support-release-followup-driver.v1',
    );
  });
  it('advances real confirmed deployed work to a draft and retest requests without sending or publishing', async () => {
    const f = await fixture();
    let complete = false;
    const outcomes: string[] = [];
    for (let tick = 0; tick < 20; tick++) {
      const before = f.f.state.modelCalls;
      const result = await f.driver.runTick();
      outcomes.push(result.outcome);
      expect(f.f.state.modelCalls - before).toBeLessThanOrEqual(1);
      if (result.outcome === 'scanned')
        expect(f.f.state.modelCalls).toBe(before);
      const work = await f.host.application.readEngineeringFollowupWork(
        f.staff,
        f.key,
      );
      if (work.status === 'bundle_prepared') {
        expect(work.preparedBundle!.bundle.retestRequests).toHaveLength(1);
        expect(work.delivered).toBeUndefined();
        complete = true;
        break;
      }
    }
    expect(complete, outcomes.join(',')).toBe(true);
    expect(f.f.state.modelCalls).toBe(1);
    const ticket = await f.host.application.readStaffTicket(
      f.staff,
      f.key.ticketId,
    );
    expect(
      ticket.messages.some((message) =>
        message.body.includes('deployed fix is ready'),
      ),
    ).toBe(false);
  });
  it('holds an unknown generation result without a second provider invocation', async () => {
    const f = await fixture();
    f.f.state.modelOutcome = 'unknown';
    for (let tick = 0; tick < 12; tick++) await f.driver.runTick();
    expect(f.f.state.modelCalls).toBe(1);
    const work = await f.host.application.readEngineeringFollowupWork(
      f.staff,
      f.key,
    );
    expect(work.preparedBundle).toBeUndefined();
    expect(work.delivered).toBeUndefined();
  });
});
