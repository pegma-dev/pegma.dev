import { env } from 'cloudflare:workers';
import { createCloudflareD1Store } from '@pegma/storage-cloudflare-d1';
import { supportRecords } from '@pegma/support-desk-application';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSupportLearningFixture, learningCanary, learningTicketId } from './support-learning-fixtures';

beforeAll(async () => {
  // Test-only public adapter initialization. Production schema/migration flags
  // and the actual Worker entrypoint are not changed or invoked by this suite.
  const store = createCloudflareD1Store({ database: env.IDENTITY_DB });
  await store.collection(supportRecords).get({ partition: 'learning-schema-probe', id: 'probe' });
});

beforeEach(async () => {
  await env.IDENTITY_DB.prepare('DELETE FROM RECORDS').run();
  await env.IDENTITY_DB.prepare('DELETE FROM PEGMA_STORAGE_D1_TX_GUARD').run();
});

function fixture(options?: Parameters<typeof createSupportLearningFixture>[1]) {
  return createSupportLearningFixture(createCloudflareD1Store({
    database: env.IDENTITY_DB, createSchemaIfMissing: false, readBatchSize: 512,
  }), options);
}

describe('learning assembly on the actual D1 binding', () => {
  it('delivers and exactly reviews a private draft, uses confirmed real KB reports, then rejects reopened source authority', async () => {
    const f = await fixture();
    const packet = await f.enrollAndVerify();
    const accepted = await f.rows();
    await f.runtime.submitVerifiedFix(f.actors.staff, structuredClone(packet));
    expect(await f.rows()).toEqual(accepted);
    const delivered = await f.delivered();
    const provenance = await f.knowledge.getProvenance(f.actors.staff, { articleId: delivered.articleId });
    expect(provenance.snapshot.references).toHaveLength(1);
    const review = await f.review(delivered.articleId);
    expect(review.target.articleId).toBe(delivered.articleId);
    const published = await f.evidenceAndPublish(delivered.articleId);
    expect(published.title).toBe('Export your workspace');
    expect(JSON.stringify(published)).not.toContain(learningTicketId);
    expect(JSON.stringify(published)).not.toContain(learningCanary);
    expect(JSON.stringify(f.state.modelInputs)).not.toContain(learningCanary);
    expect(f.state.modelCalls).toBe(1);
    await f.application.reopenTicket(f.actors.staff, { ...f.command('reopen-native'), ticketId: learningTicketId });
    const source = await f.runtime.readSource(f.actors.staff, learningTicketId);
    expect(source.sourceGeneration).toBeGreaterThan(delivered.source.sourceGeneration);
    expect(source.state).toBe('held');
    await expect(f.knowledge.getPublishedArticle(f.actors.customer, { articleId: delivered.articleId })).rejects.toThrow();
  });

  it('holds expired trusted product evidence with no generation work or paid call', async () => {
    const f = await fixture(); f.state.product = 'expired';
    await f.enrollAndVerify();
    expect((await f.runtime.readSource(f.actors.staff, learningTicketId)).state).toBe('held');
    expect((await f.rows()).filter((row) => row.kind === 'resolution_learning_work')).toEqual([]);
    expect(f.state.modelCalls).toBe(0);
  });

  it('observes actual stored staff revocation without returning the private source', async () => {
    const f = await fixture(); await f.enrollAndVerify();
    await f.revokeStaff();
    const before = await f.rows();
    await expect(f.runtime.readSource(f.actors.staff, learningTicketId)).rejects.toThrow();
    expect(await f.rows()).toEqual(before);
  });
});
