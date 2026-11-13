import { createMemoryStore, defineCollection, type Store, type StoredRecord } from '@pegma/storage-core';
import { describe, expect, it, vi } from 'vitest';
import { cleanupSupportFollowupRetests, cleanupSupportFollowupRetestPage, supportFollowupRetestReceipts } from './support-release-followup-retests';
import { runSupportMaintenance } from './support-maintenance';

const now = Date.parse('2026-11-13T12:00:00.000Z');
const clock = { now: () => new Date(now).toISOString() };
const raw = defineCollection<StoredRecord>({
  name: supportFollowupRetestReceipts.name,
  key: (value) => ({ partition: String(value.ticketId), id: String(value.id) }),
  codec: { encode: (value) => ({ ...value }), decode: (value) => ({ ...value }) },
});
// Cleanup-only legacy intents. They never qualify a report or SDK retest.
function legacy(index: number, retainUntil?: number) {
  const ticketId = 'cleanup-only-ticket';
  const id = 'receipt:' + index.toString(16).padStart(64, '0');
  const value = {
    kind: 'intent', ticketId, id, actorId: 'cleanup-only-actor',
    commandHash: index.toString(16).padStart(64, '0'), inputHash: 'a'.repeat(64),
    packet: { commandId: '12345678-1234-4123-8123-123456789012', expectedPrincipalId: 'cleanup-only-actor', workId: 'cleanup-only-work', expectedWorkGeneration: 1, expectedTicketRevision: 1, retestRequestId: 'cleanup-only-request', report: { articleId: 'cleanup-only-article', ledgerEpoch: 1, reportId: 'cleanup-only-report', expectedReportGeneration: 1, reviewBindingHash: 'b'.repeat(64), receipt: 'cleanup-only-kb-receipt' } },
    binding: { ticketId, workId: 'cleanup-only-work', workBindingHash: 'cleanup-only-binding', requestId: 'cleanup-only-request', requestHash: 'cleanup-only-hash', bundleHash: 'cleanup-only-bundle', productBinding: 'cleanup-only-product' },
    workFingerprint: 'cleanup-only-work-fingerprint', workGeneration: 1,
    reportContext: { product: { productId: 'cleanup-only-product', version: 'legacy', buildId: 'legacy' }, validationRequirementIds: [] },
    ...(retainUntil === undefined ? {} : { retainUntil: new Date(retainUntil).toISOString() }),
  };
  return { kind: value.kind, ticketId, id, payload: JSON.stringify(value) };
}

describe('nonpaid follow-up retest retention and independent bookmark', () => {
  it.each([0, 9, 1.5, NaN])('refuses an unbounded cleanup limit %s before Store access', async (limit) => {
    const store = createMemoryStore();
    const collection = vi.spyOn(store, 'collection');
    await expect(cleanupSupportFollowupRetests({ store, clock }, { limit })).rejects.toThrow('Invalid retest cleanup limit');
    expect(collection).not.toHaveBeenCalled();
  });

  it('redacts legacy undated intents, retains live data and never deletes minimal command fences', async () => {
    const store = createMemoryStore();
    const rows = store.collection(raw);
    await rows.put(legacy(1));
    await rows.put(legacy(2, now));
    const live = legacy(3, now + 60000);
    await rows.put(live);
    expect(await cleanupSupportFollowupRetests({ store, clock }, { limit: 8 })).toMatchObject({ scanned: 3, changed: 2 });
    expect(await rows.get({ partition: String(live.ticketId), id: String(live.id) })).toEqual(live);
    const redacted = await store.collection(supportFollowupRetestReceipts).get({ partition: 'cleanup-only-ticket', id: String(legacy(1).id) });
    expect(redacted?.kind).toBe('tombstone');
    expect(Object.keys(redacted!).sort()).toEqual(['commandHash', 'id', 'inputHash', 'kind', 'ticketId']);
    expect(await cleanupSupportFollowupRetests({ store, clock }, { limit: 8 })).toMatchObject({ changed: 0 });
  });

  it('preserves a concurrently refreshed row when redaction loses its version', async () => {
    const store = createMemoryStore();
    await store.collection(raw).put(legacy(1));
    let changed = false;
    const racing: Store = { collection(definition) {
      const records = store.collection(definition);
      return definition.name === raw.name ? { ...records, async putIfUnchanged(value, version) {
        if (!changed) { changed = true; await store.collection(raw).put(legacy(1, now + 60000)); }
        return records.putIfUnchanged(value, version);
      } } : records;
    } };
    expect(await cleanupSupportFollowupRetests({ store: racing, clock }, { limit: 8 })).toMatchObject({ changed: 0 });
    expect((await store.collection(supportFollowupRetestReceipts).list('cleanup-only-ticket'))[0]?.kind).toBe('intent');
  });

  it('uses independent four-row pages to reach expired rows behind live records through the existing receipt lane', async () => {
    const store = createMemoryStore();
    for (let index = 1; index <= 13; index++) await store.collection(raw).put(legacy(index, index <= 8 ? now + 60000 : now));
    const pages: number[] = [];
    const measured: Store = { collection(definition) {
      const records = store.collection(definition);
      return definition.name === raw.name ? { ...records, async scan(input) { pages.push(input.limit); return records.scan(input); } } : records;
    } };
    const logger = { log: vi.fn() };
    for (let tick = 0; tick < 4; tick++) await runSupportMaintenance({ store: measured, clock, limiters: [] }, logger, { tasks: ['test_receipts'] });
    expect(pages).toEqual([4, 4, 4, 4]);
    expect(logger.log).not.toHaveBeenCalled();
    const rows = await store.collection(supportFollowupRetestReceipts).list('cleanup-only-ticket');
    expect(rows.filter((value) => value.kind === 'tombstone')).toHaveLength(5);
    expect(rows.filter((value) => value.kind === 'intent')).toHaveLength(8);
    expect(await cleanupSupportFollowupRetestPage({ store, clock })).toMatchObject({ scanned: 4, changed: 0 });
  });
});
