/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { AsyncLocalStorage } from 'node:async_hooks';
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { createCloudflareD1Store } from '@pegma/storage-cloudflare-d1';
import { auditRecordId } from '@pegma/audit';
import { supportAudit, supportRecords } from '@pegma/support-desk-application';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isPlainObject } from './api-auth';
import { KNOWLEDGE_ROLE } from './support-access';
import { createStagedReviewFixture, responseObject, resultObject, type StagedReviewFixtureOptions } from './support-learning-staged-review-fixture';
import type { SupportLearningReviewQueueMessage } from './support-learning-review-queue';

interface Profile {
  readonly operation: string;
  calls: number;
  executed: number;
  batches: number;
  statements: number;
  maximumParameters: number;
  blocked: number;
}
const profiles: Profile[] = [];
// Only an explicitly registered negative transport/port diagnostic may expect
// attempted calls beyond50. Executed calls must still stop at50 exactly.
const expectedRefusals = new Set<string>();

beforeAll(async () => {
  await createCloudflareD1Store({ database: env.IDENTITY_DB }).collection(supportRecords)
    .get({ partition: 'staged-review-schema-probe', id: 'absent' });
});
beforeEach(async () => {
  profiles.length = 0;
  expectedRefusals.clear();
  await env.IDENTITY_DB.prepare('DELETE FROM RECORDS').run();
  await env.IDENTITY_DB.prepare('DELETE FROM PEGMA_STORAGE_D1_TX_GUARD').run();
});
afterEach(({ task }) => {
  Object.assign(task.meta, { supportLearningStagedReviewD1Budget: structuredClone(profiles) });
  for (const profile of profiles) {
    const detail = JSON.stringify(profile);
    expect(profile.calls, detail).toBeGreaterThan(0);
    expect(profile.executed, detail).toBeLessThanOrEqual(50);
    if (expectedRefusals.has(profile.operation)) {
      expect(profile.calls, detail).toBeGreaterThan(50);
      expect(profile.executed, detail).toBe(50);
      expect(profile.blocked, detail).toBeGreaterThanOrEqual(1);
      expect(profile.blocked, detail).toBe(profile.calls - profile.executed);
    } else {
      expect(profile.calls, detail).toBeLessThanOrEqual(50);
      expect(profile.executed, detail).toBe(profile.calls);
      expect(profile.blocked, detail).toBe(0);
    }
    expect(profile.maximumParameters, detail).toBeLessThanOrEqual(100);
  }
});

/** Genuine D1 execution boundary: each batch is charged once, every statement
 * retains its own parameter ceiling, and attempted query51 throws immediately. */
function meter(database: D1Database) {
  const scope = new AsyncLocalStorage<Profile>();
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const parameters = new WeakMap<D1PreparedStatement, number>();
  function charge(statements: readonly D1PreparedStatement[], batch = false) {
    const current = scope.getStore(); if (current === undefined) return;
    current.calls += 1; current.statements += statements.length;
    if (batch) current.batches += 1;
    for (const statement of statements) current.maximumParameters = Math.max(current.maximumParameters, parameters.get(statement) ?? 0);
    if (current.calls > 50 || current.maximumParameters > 100) {
      current.blocked += 1; throw new Error('Workers Free staged learning review D1 budget exceeded');
    }
    current.executed += 1;
  }
  function observe(original: D1PreparedStatement, count = 0): D1PreparedStatement {
    const statement: D1PreparedStatement = {
      bind(...values: unknown[]) { return observe(original.bind(...values), values.length); },
      first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
        charge([statement]); return column === undefined ? original.first<T>() : original.first<T>(column);
      },
      all<T = Record<string, unknown>>() { charge([statement]); return original.all<T>(); },
      run<T = Record<string, unknown>>() { charge([statement]); return original.run<T>(); },
      raw: original.raw,
    };
    statement.raw = new Proxy(original.raw, { apply(target, _receiver, args) {
      charge([statement]); return Reflect.apply(target, original, args);
    } });
    originals.set(statement, original); parameters.set(statement, count); return statement;
  }
  const binding: D1Database = {
    prepare(query) { return observe(database.prepare(query)); },
    batch<T = unknown>(statements: D1PreparedStatement[]) {
      charge(statements, true);
      return database.batch<T>(statements.map((statement) => {
        const original = originals.get(statement);
        if (original === undefined) throw new Error('Expected an observed statement'); return original;
      }));
    },
    exec() { throw new Error('Runtime schema initialization is unavailable'); },
    dump() { throw new Error('Runtime dump is unavailable'); },
    withSession() { throw new Error('Expected the actual direct binding'); },
  };
  return { binding, run<Value>(operation: string, action: () => Promise<Value>): Promise<Value> {
    const profile: Profile = { operation, calls: 0, executed: 0, batches: 0, statements: 0, maximumParameters: 0, blocked: 0 };
    profiles.push(profile); return scope.run(profile, action);
  } };
}
async function fixture(options: StagedReviewFixtureOptions = {}) {
  const observed = meter(env.IDENTITY_DB);
  const store = createCloudflareD1Store({ database: observed.binding, createSchemaIfMissing: false, readBatchSize: 512 });
  const f = await createStagedReviewFixture(store, {
    context() {
      const value = createExecutionContext();
      return { value, finish: () => waitOnExecutionContext(value) };
    },
    environment(sender) {
      // Only broker delivery is scripted. The database remains the actual
      // observed Workers-pool binding; no fake DB or authentication is supplied.
      const broker: Queue<SupportLearningReviewQueueMessage> = {
        async metrics() { return { backlogCount: 0, backlogBytes: 0 }; },
        async send(message) {
          await sender.send(message);
          return { metadata: { metrics: { backlogCount: 1, backlogBytes: 0 } } };
        },
        async sendBatch() { throw new Error('The review producer must send one hint'); },
      };
      return { ...env, IDENTITY_DB: observed.binding,
        IDENTITY_EMAIL_CODE_SECRET_BASE64: btoa('q'.repeat(32)),
        PEGMA_SUPPORT_LEARNING_REVIEWS_ENABLED: 'true', SUPPORT_LEARNING_REVIEWS: broker };
    },
  }, options);
  return { f, run: observed.run };
}

/** Assertion-only session readback is outside the measured invocation. Every
 * protected HTTP fence itself uses the real advancing Identity/Sessions clock. */
async function afterSessionIdle<Value>(
  f: Awaited<ReturnType<typeof fixture>>['f'], run: ReturnType<typeof meter>['run'],
  operation: string, action: () => Promise<Value>,
): Promise<Value> {
  // Published Sessions has no coarser touch interval: now>lastSeenAt writes.
  // Two seconds crosses that boundary without expiring/renewing source proofs.
  f.learning.advance(2_000);
  const first = f.sessionObservations.length;
  const result = await run(operation, action).finally(() => {
    const reads = f.sessionObservations.slice(first);
    const profile = profiles.at(-1);
    if (profile?.operation !== operation) throw new Error('Expected the measured invocation profile');
    Object.assign(profile, { sessionReadObservations: reads.length, idleAdvanceMilliseconds: 2_000,
      strictlyAdvancingSessionReads: reads.filter((read) => read.previousLastSeenAt !== null &&
        Date.parse(read.at) > Date.parse(read.previousLastSeenAt)).length });
  });
  const reads = f.sessionObservations.slice(first);
  expect(reads.length, operation + ' must observe actual session fences').toBeGreaterThan(1);
  for (const [index, read] of reads.entries()) {
    expect(read.previousLastSeenAt, operation).not.toBeNull();
    if (read.previousLastSeenAt === null) throw new Error('Expected the actual live session');
    expect(Date.parse(read.at), operation).toBeGreaterThan(Date.parse(read.previousLastSeenAt));
    if (index > 0) expect(read.previousLastSeenAt, operation + ' persisted previous fence touch').toBe(reads[index - 1]?.at);
  }
  const last = reads.at(-1);
  if (last === undefined) throw new Error('Expected the final observed session fence');
  // Same-time public get cannot advance this anchor. It proves that the final
  // request fence's best-effort touch actually persisted through Native D1.
  expect((await f.readSessionAt(last.at))?.lastSeenAt, operation + ' persisted final touch').toBe(last.at);
  const profile = profiles.at(-1);
  if (profile?.operation !== operation) throw new Error('Expected the measured invocation profile');
  Object.assign(profile, { sessionTouches: reads.length, verifiedPersistedTouch: true, idleAdvanceMilliseconds: 2_000 });
  return result;
}

/** Verify public Audit mapping and actual Native D1 encoding after completion.
 * No codec or alternate writer is manufactured. These assertion-only reads
 * are outside the measured request and cannot affect its recorded budget. */
async function assertPersistedStageAuditEncoding(f: Awaited<ReturnType<typeof fixture>>['f']) {
  const records = f.learning.store.collection(supportRecords);
  const rows = await records.list('learning-ticket');
  const admission = rows.find((row) => row.kind === 'audit' &&
    row.event.action === 'support.learning.review_requested');
  if (admission?.kind !== 'audit') throw new Error('Expected the actual staged admission Audit row');
  const commandId = admission.event.details?.commandId;
  if (typeof commandId !== 'string') throw new Error('Expected the retained original SDK command identity');
  const eventId = String.fromCharCode(0) + 'support.learning.review.requested:' + commandId;
  const key = auditRecordId(eventId);
  expect(admission.event.id).toBe(eventId);
  expect(admission.id).toBe(key);
  expect(key.startsWith('audit|%00support.learning.review.requested:')).toBe(true);
  expect(key).not.toContain(String.fromCharCode(0));
  expect(await records.get({ partition: 'learning-ticket', id: key })).toEqual(admission);
  const literalPercentKey = auditRecordId('%00support.learning.review.requested:' + commandId);
  expect(literalPercentKey.startsWith('audit|%2500support.learning.review.requested:')).toBe(true);
  expect(literalPercentKey).not.toBe(key);
  const history = await supportAudit.history(records, 'learning-ticket');
  expect(history.some((event) => event.id === eventId)).toBe(true);
  const reviewed = rows.find((row) => row.kind === 'audit' &&
    row.event.action === 'support.learning.reviewed' && row.event.details?.commandId === commandId);
  if (reviewed?.kind !== 'audit') throw new Error('Expected the actual final review Audit row');
  expect(reviewed.id).toBe(auditRecordId(commandId));
  expect(reviewed.id).not.toBe(key);
  expect(await records.get({ partition: 'learning-ticket', id: reviewed.id })).toEqual(reviewed);

  const physical = await env.IDENTITY_DB.prepare(
    'SELECT row_key, record_json FROM RECORDS WHERE partition_key = ? AND row_key = ? AND deleted = 0',
  ).bind(supportRecords.name + ':learning-ticket', key).first<{ row_key: string; record_json: string }>();
  if (physical === null) throw new Error('Expected the actual physical D1 admission Audit row');
  expect(physical.row_key).toBe(key);
  expect(physical.row_key).not.toContain(String.fromCharCode(0));
  expect(physical.record_json).not.toContain(String.fromCharCode(0));
  const encoded: unknown = JSON.parse(physical.record_json);
  if (!isPlainObject(encoded) || typeof encoded.payload !== 'string')
    throw new Error('Expected the actual Support JSON codec payload');
  expect(encoded.id).toBe(key);
  expect(encoded.payload).not.toContain(String.fromCharCode(0));
  expect(encoded.payload).toContain('\\u0000support.learning.review.requested:');
  const decodedPayload: unknown = JSON.parse(encoded.payload);
  if (!isPlainObject(decodedPayload) || !isPlainObject(decodedPayload.event))
    throw new Error('Expected the actual decoded Audit event');
  expect(decodedPayload.event.id).toBe(eventId);
}

describe('whole staged review Worker invocations on real Native D1', () => {
  it('counts proposal, durable admission, separate P1/P2, duplicate and historical recovery under hard50', async () => {
    const { f, run } = await fixture(); const delivered = await f.checked();
    const packet = await run('http.proposal', () => f.prepare(delivered.source.sourceGeneration));
    const admitted = await run('http.admit', () => f.invoke('/review-queue', packet.body));
    expect(admitted.status).toBe(202);
    expect(resultObject(await responseObject(admitted)).outcome).toBe('pending');
    const models = f.learning.state.modelCalls; const message = f.messages[0]!;
    expect(await run('queue.proof', () => f.deliver(message))).toEqual({ acknowledgements: 0, delays: [30] });
    expect(resultObject(await responseObject(await run('http.pending', () => f.invoke('/review-queue-status', packet.body)))))
      .toMatchObject({ outcome: 'pending', phase: 'commit' });
    expect(await run('queue.commit', () => f.deliver(message))).toEqual({ acknowledgements: 1, delays: [] });
    const budgetBeforeAuditReadback = structuredClone(profiles);
    await assertPersistedStageAuditEncoding(f);
    expect(profiles).toEqual(budgetBeforeAuditReadback);
    expect(await run('queue.duplicate', () => f.deliver(message))).toEqual({ acknowledgements: 1, delays: [] });
    await f.revoke(KNOWLEDGE_ROLE); f.learning.advance(3_600_001);
    const receipt = await run('http.receipt-after-kb-revoke-and-expiry', () => f.invoke('/review-queue-status', packet.body));
    expect(receipt.status).toBe(200); expect(resultObject(await responseObject(receipt)).outcome).toBe('accepted');
    const replay = await run('http.admission-replay-after-kb-revoke-and-expiry', () => f.invoke('/review-queue', packet.body));
    expect(replay.status).toBe(200); expect(resultObject(await responseObject(replay)).outcome).toBe('accepted');
    expect(f.learning.state.modelCalls).toBe(models);
  });

  it('measures fresh cancellation separately and never permits its delayed P2 to accept', async () => {
    const { f, run } = await fixture(); const delivered = await f.checked();
    const packet = await f.prepare(delivered.source.sourceGeneration);
    expect((await run('http.admit', () => f.invoke('/review-queue', packet.body))).status).toBe(202);
    const message = f.messages[0]!; await run('queue.proof', () => f.deliver(message));
    await f.revoke(KNOWLEDGE_ROLE);
    const response = await run('http.cancel', () => f.invoke('/review-queue-cancel', packet.body));
    expect(response.status).toBe(200); expect(resultObject(await responseObject(response)).outcome).toBe('cancelled');
    expect(await run('queue.cancelled-duplicate', () => f.deliver(message))).toEqual({ acknowledgements: 1, delays: [] });
    expect((await f.learning.application.readResolutionLearningSource(f.learning.actors.staff, 'learning-ticket')).reviewBindingCount).toBe(0);
  });

  it('rediscovers a lost post-admission send with separate bounded scheduled pages', async () => {
    const { f, run } = await fixture(); const delivered = await f.checked();
    const packet = await f.prepare(delivered.source.sourceGeneration); f.state.sendFailure = true;
    expect((await run('http.admit-lost-send', () => f.invoke('/review-queue', packet.body))).status).toBe(202);
    expect(f.messages).toHaveLength(0); f.state.sendFailure = false;
    for (let page = 0; page < 256 && f.messages.length === 0; page++) await run('scheduled.scan.' + page, () => f.scan());
    expect(f.messages).toHaveLength(1);
    expect(resultObject(await responseObject(await run('http.pending-after-scan', () => f.invoke('/review-queue-status', packet.body)))))
      .toMatchObject({ outcome: 'pending', phase: 'proof' });
  });

  it.each([false, true])('preserves both current contributors and distinct published history=%s under each physical cap', async (published) => {
    const { f, run } = await fixture(); const delivered = await f.multipleContributors(published);
    expect(delivered.provenance.snapshot.references.map((value) => value.resourceId).sort())
      .toEqual(['learning-ticket', delivered.secondaryTicketId].sort());
    if (published) expect(delivered.provenance.publishedSnapshot?.references.map((value) => value.resourceId))
      .toEqual([delivered.secondaryTicketId]);
    else expect(delivered.provenance.publishedSnapshot).toBeUndefined();
    const packet = await run('http.two-contributors.proposal', () => f.prepare(delivered.source.sourceGeneration));
    expect((await run('http.two-contributors.admit', () => f.invoke('/review-queue', packet.body))).status).toBe(202);
    const message = f.messages[0]!;
    expect(await run('queue.two-contributors.proof', () => f.deliver(message))).toEqual({ acknowledgements: 0, delays: [30] });
    expect(await run('queue.two-contributors.commit', () => f.deliver(message))).toEqual({ acknowledgements: 1, delays: [] });
    expect(resultObject(await responseObject(await run('http.two-contributors.receipt', () => f.invoke('/review-queue-status', packet.body)))).outcome)
      .toBe('accepted');
  });

  it('meters actual Identity/Sessions clock touches before prepare, admission, status and cancellation', async () => {
    const { f, run } = await fixture({ clockedAuthentication: true });
    expect(Date.parse(f.identityCreatedAt)).toBeGreaterThan(Date.parse(f.authenticationClockStartedAt));
    const delivered = await f.checked();
    const packet = await afterSessionIdle(f, run, 'http.idle.proposal', () => f.prepare(delivered.source.sourceGeneration));
    expect((await afterSessionIdle(f, run, 'http.idle.admit', () => f.invoke('/review-queue', packet.body))).status).toBe(202);
    const message = f.messages[0]!;
    expect(await run('queue.idle.proof', () => f.deliver(message))).toEqual({ acknowledgements: 0, delays: [30] });
    const pending = await afterSessionIdle(f, run, 'http.idle.pending', () => f.invoke('/review-queue-status', packet.body));
    expect(pending.status).toBe(200); expect(resultObject(await responseObject(pending)).outcome).toBe('pending');
    const cancelled = await afterSessionIdle(f, run, 'http.idle.cancel', () => f.invoke('/review-queue-cancel', packet.body));
    expect(cancelled.status).toBe(200); expect(resultObject(await responseObject(cancelled)).outcome).toBe('cancelled');
    expect(await run('queue.idle.cancelled', () => f.deliver(message))).toEqual({ acknowledgements: 1, delays: [] });
  });

  it('meters session touches with two current contributors and distinct complete published provenance', async () => {
    const { f, run } = await fixture({ clockedAuthentication: true });
    const delivered = await f.multipleContributors(true);
    expect(delivered.provenance.snapshot.references.map((entry) => entry.resourceId).sort())
      .toEqual(['learning-ticket', delivered.secondaryTicketId].sort());
    expect(delivered.provenance.publishedSnapshot?.references.map((entry) => entry.resourceId)).toEqual([delivered.secondaryTicketId]);
    const packet = await afterSessionIdle(f, run, 'http.idle.multi.proposal', () => f.prepare(delivered.source.sourceGeneration));
    expect((await afterSessionIdle(f, run, 'http.idle.multi.admit', () => f.invoke('/review-queue', packet.body))).status).toBe(202);
    const message = f.messages[0]!;
    expect(await run('queue.idle.multi.proof', () => f.deliver(message))).toEqual({ acknowledgements: 0, delays: [30] });
    const pending = await afterSessionIdle(f, run, 'http.idle.multi.pending', () => f.invoke('/review-queue-status', packet.body));
    expect(pending.status).toBe(200); expect(resultObject(await responseObject(pending)).outcome).toBe('pending');
    expect(await run('queue.idle.multi.commit', () => f.deliver(message))).toEqual({ acknowledgements: 1, delays: [] });
    const accepted = await afterSessionIdle(f, run, 'http.idle.multi.receipt', () => f.invoke('/review-queue-status', packet.body));
    expect(accepted.status).toBe(200); expect(resultObject(await responseObject(accepted)).outcome).toBe('accepted');
  });

  it('refuses an out-of-qualified-profile custom source wrapper at hard50 without review or KB effects', async () => {
    const observed = new Set<string>(); let delayedReads = 0;
    const { f, run } = await fixture({
      async beforeSourceRead(ticketId) {
        observed.add(ticketId);
        if (ticketId === 'staged-secondary-ticket') {
          delayedReads += 1;
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }
      },
    });
    const delivered = await f.multipleContributors(true); observed.clear(); delayedReads = 0;
    const models = f.learning.state.modelCalls;
    expect(delivered.provenance.snapshot.references.map((entry) => entry.resourceId).sort())
      .toEqual(['learning-ticket', delivered.secondaryTicketId].sort());
    expect(delivered.provenance.publishedSnapshot?.references.map((entry) => entry.resourceId)).toEqual([delivered.secondaryTicketId]);
    const rowsBefore = await f.learning.rows();
    const draftBefore = await f.learning.knowledge.getDraft(f.learning.actors.admin, { articleId: delivered.articleId });
    const provenanceBefore = await f.learning.knowledge.getProvenance(f.learning.actors.admin, { articleId: delivered.articleId });
    const publishedBefore = await f.learning.knowledge.getPublishedArticle(f.learning.actors.customer, { articleId: delivered.articleId });
    observed.clear(); delayedReads = 0;
    const operation = 'http.unqualified-custom-source.proposal';
    expectedRefusals.add(operation);
    let invocationSourceReads: { readonly delayed: number; readonly distinct: number } | undefined;
    try {
      // This additional asynchronous wrapper is absent from the known real
      // SDK graph under test. It is a fail-closed diagnostic, not a successful
      // arbitrary-port budget claim. Do not admit or deliver a review afterward.
      const response = await run(operation, () => f.invoke('/proposal?sourceGeneration=' + delivered.source.sourceGeneration));
      invocationSourceReads = { delayed: delayedReads, distinct: observed.size };
      expect(response.status).toBe(503);
      expect(await responseObject(response)).toEqual({ error: 'support_learning_unavailable' });
      expect(profiles).toHaveLength(1);
      const refused = profiles[0];
      if (refused === undefined) throw new Error('Expected the actual refused invocation');
      expect(refused.operation).toBe(operation);
      expect(refused.executed).toBe(50);
      expect(refused.calls).toBeGreaterThan(50);
      expect(refused.blocked).toBeGreaterThanOrEqual(1);
      expect(refused.blocked).toBe(refused.calls - refused.executed);
      expect([...observed].sort()).toEqual(['learning-ticket', delivered.secondaryTicketId].sort());
      expect(delayedReads).toBeGreaterThan(0);
      expect(f.messages).toHaveLength(0);
      // Complete public Support rows cover review bindings, receipts, Audit
      // and durable attempts, rather than guessing private record encoders.
      expect(await f.learning.rows()).toEqual(rowsBefore);
      expect(await f.learning.knowledge.getDraft(f.learning.actors.admin, { articleId: delivered.articleId })).toEqual(draftBefore);
      expect(await f.learning.knowledge.getProvenance(f.learning.actors.admin, { articleId: delivered.articleId })).toEqual(provenanceBefore);
      expect(await f.learning.knowledge.getPublishedArticle(f.learning.actors.customer, { articleId: delivered.articleId })).toEqual(publishedBefore);
      expect(f.learning.state.modelCalls).toBe(models);
      const profile = profiles[0];
      if (profile === undefined) throw new Error('Expected the actual refused invocation');
      Object.assign(profile, { noDomainEffectsVerified: true });
    } finally {
      // Preserve causal diagnostics even when the strict binding guard refuses
      // a phase; a red profile is never turned into successful completion.
      for (const profile of profiles) Object.assign(profile, {
        profileClassification: 'out_of_qualified_profile_custom_source_wrapper',
        sourceReadDelayMilliseconds: 5, delayedSourceReads: invocationSourceReads?.delayed ?? delayedReads,
        distinctObservedSources: invocationSourceReads?.distinct ?? observed.size,
      });
    }
  });
});
