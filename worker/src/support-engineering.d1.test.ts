import { env } from 'cloudflare:workers';
import { createCloudflareD1Store } from '@pegma/storage-cloudflare-d1';
import { SupportDeskAuthorizationError, supportRecords } from '@pegma/support-desk-application';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createSupportEngineeringFixture, engineeringCanary, engineeringProofReference, engineeringTicketId,
} from './support-engineering-fixtures';

beforeAll(async () => {
  // Test-only schema initialization through the actual public adapter. The
  // production Worker composition and migration flags are not invoked here.
  const store = createCloudflareD1Store({ database: env.IDENTITY_DB });
  await store.collection(supportRecords).get({ partition: 'engineering-schema-probe', id: 'probe' });
});

beforeEach(async () => {
  await env.IDENTITY_DB.prepare('DELETE FROM RECORDS').run();
  await env.IDENTITY_DB.prepare('DELETE FROM PEGMA_STORAGE_D1_TX_GUARD').run();
});

function fixture(options?: Parameters<typeof createSupportEngineeringFixture>[1]) {
  return createSupportEngineeringFixture(createCloudflareD1Store({
    database: env.IDENTITY_DB, createSchemaIfMissing: false, readBatchSize: 512,
  }), options);
}

describe('engineering assembly on the actual D1 binding', () => {
  it('checks and exactly approves one private proposal before a single acknowledged dispatch', async () => {
    const f = await fixture(); const accepted = await f.eligible(); const initial = await f.rows();
    await f.runtime.submitVerifiedFailure(f.actors.staff, structuredClone(accepted.packet));
    expect(await f.rows()).toEqual(initial);
    const work = await f.prepared(); expect(work.status).toBe('prepared'); expect(f.state.creates).toEqual([]);
    const packet = await f.approve(); const reviewed = await f.rows();
    await f.runtime.reviewProposal(f.actors.staff, structuredClone(packet));
    expect(await f.rows()).toEqual(reviewed);
    expect((await f.process()).outcome).toBe('dispatched');
    expect((await f.work()).status).toBe('accepted');
    expect((await f.source()).destinations).toMatchObject([{ outcome: 'accepted', reconciliation: 'confirmed' }]);
    await f.process(); expect(f.state.creates).toHaveLength(1); expect(f.state.modelCalls).toBe(1);
    for (const value of [f.state.modelInputs, f.state.searches, f.state.creates]) {
      expect(JSON.stringify(value)).not.toContain(engineeringCanary);
      expect(JSON.stringify(value)).not.toContain(engineeringProofReference);
    }
  });

  it('keeps uncertain failures private and outside ordinary worker and reviewer discovery', async () => {
    const f = await fixture(); await f.eligible('uncertain');
    await expect(f.runtime.readSource(f.actors.staff, engineeringTicketId)).rejects.toThrow(SupportDeskAuthorizationError);
    expect((await f.source()).state).toBe('restricted');
    expect((await f.rows()).filter((row) => row.kind === 'engineering_work')).toEqual([]);
    expect((await f.runtime.scanReview(f.actors.staff, { limit: 64 })).reviewSources).toEqual([]);
    expect((await f.runtime.scanReview(f.actors.security, { limit: 64 })).reviewSources).toContain(engineeringTicketId);
    const scanned = await f.runtime.scanCandidates({ limit: 64 });
    expect('candidates' in scanned && scanned.candidates).toEqual([]);
    expect(f.state.modelCalls).toBe(0); expect(f.state.creates).toEqual([]);
  });

  it('holds missing calibration before any paid call on an actual stored work item', async () => {
    const f = await fixture(); await f.eligible(); f.state.calibrationReady = false;
    expect((await f.process()).outcome).toBe('held');
    expect((await f.work()).status).toBe('held');
    expect(f.state.modelCalls).toBe(0); expect(f.state.reservations).toEqual([]);
  });

  it('withdraws private bodies and reconciles a lost accepted response with generation OFF', async () => {
    const f = await fixture(); await f.eligible(); await f.prepared(); await f.approve();
    f.state.createMode = 'accept_then_lose';
    expect(await f.process()).toEqual({ outcome: 'pending', stage: 'dispatch' });
    expect((await f.work()).status).toBe('unknown');
    f.state.enabled = false; f.state.configuration = 'disabled';
    await f.runtime.withdraw(f.actors.staff, { ticketId: engineeringTicketId,
      clientCommandId: 'NATIVE-WITHDRAW-EXACT', reason: 'privacy_withdrawal' });
    const work = await f.work(); const source = await f.source();
    expect(source.state).toBe('withdrawn'); expect(source.evidence).toBeUndefined();
    expect(work.proposal).toBeUndefined(); expect(work.evidence).toBeUndefined();
    expect(work.withdrawnRequest).toBeDefined(); expect(work.dispatch).toBeDefined();
    expect(JSON.stringify((await f.rows()).filter((row) => row.kind.startsWith('engineering_'))))
      .not.toContain(engineeringProofReference);
    expect((await f.runtime.reconcileSource(engineeringTicketId)).outcome).toBe('reconciled');
    expect((await f.work()).status).toBe('accepted');
    expect(f.state.creates).toHaveLength(1); expect(f.state.modelCalls).toBe(1);
  });

  it('refuses a private source read after actual audited staff-role revocation', async () => {
    const f = await fixture(); await f.eligible(); await f.revoke('staff'); const before = await f.rows();
    await expect(f.runtime.readSource(f.actors.staff, engineeringTicketId)).rejects.toThrow(SupportDeskAuthorizationError);
    expect(await f.rows()).toEqual(before);
  });
});
