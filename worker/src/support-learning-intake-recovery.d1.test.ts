/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { AsyncLocalStorage } from 'node:async_hooks';
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { createCloudflareD1Store } from '@pegma/storage-cloudflare-d1';
import { createSupportDeskApplication, supportRecords } from '@pegma/support-desk-application';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createStagedReviewFixture, responseObject, resultObject } from './support-learning-staged-review-fixture';
import { learningTicketId } from './support-learning-fixtures';
import type { SupportLearningReviewQueueMessage } from './support-learning-review-queue';

interface Budget {
  readonly operation: string;
  calls: number;
  executed: number;
  statements: number;
  batches: number;
  maximumParameters: number;
  blocked: number;
  status?: number;
}
const profiles: Budget[][] = [];

beforeAll(async () => {
  expect(String(env.IDENTITY_EMAIL_ENABLED)).toBe('false');
  // Test schema only, through the genuine adapter, outside measured requests.
  const store = createCloudflareD1Store({ database: env.IDENTITY_DB });
  await store.collection(supportRecords).get({ partition: 'learning-intake-recovery-schema', id: 'absent' });
});
beforeEach(async () => {
  profiles.length = 0;
  // Per-file isolated D1 pool reset, matching existing Native suites.
  await env.IDENTITY_DB.prepare('DELETE FROM RECORDS').run();
  await env.IDENTITY_DB.prepare('DELETE FROM PEGMA_STORAGE_D1_TX_GUARD').run();
});
afterEach(({ task }) => {
  Object.assign(task.meta, { supportLearningIntakeRecoveryD1Budget: structuredClone(profiles.flat()) });
  console.info('support-learning-intake-recovery-d1-budgets', JSON.stringify(profiles.flat()));
});

/** Observe actual binding calls, never SQL, results, codecs or Store decisions.
 * A D1 batch counts one call; each statement keeps its real bound-parameter
 * count. A refused 51st attempt is recorded but never delegated to D1. */
function meter(backing: D1Database) {
  const scope = new AsyncLocalStorage<Budget>();
  const budgets: Budget[] = []; profiles.push(budgets);
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const parameters = new WeakMap<D1PreparedStatement, number>();
  function charge(statements: readonly D1PreparedStatement[]) {
    const budget = scope.getStore(); if (budget === undefined) return;
    budget.calls += 1; budget.statements += statements.length;
    budget.maximumParameters = Math.max(budget.maximumParameters,
      ...statements.map((statement) => parameters.get(statement) ?? 0));
    if (budget.calls > 50 || budget.maximumParameters > 100) {
      budget.blocked += 1;
      throw new Error('Synthetic Workers Free intake recovery guard refused execution.');
    }
    budget.executed += 1;
  }
  function observed(original: D1PreparedStatement, count = 0): D1PreparedStatement {
    const statement: D1PreparedStatement = {
      bind(...values: unknown[]) { return observed(original.bind(...values), values.length); },
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
  const database: D1Database = {
    prepare(query) { return observed(backing.prepare(query)); },
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      charge(statements); const budget = scope.getStore(); if (budget !== undefined) budget.batches += 1;
      const native = statements.map((statement) => {
        const actual = originals.get(statement);
        if (actual === undefined) throw new Error('Expected an observed genuine D1 statement.');
        return actual;
      });
      return backing.batch<T>(native);
    },
    exec() { throw new Error('Runtime schema work is excluded from engineering request profiles.'); },
    dump() { throw new Error('Runtime D1 dump is excluded from engineering request profiles.'); },
    withSession() { throw new Error('The public adapter uses the direct D1 binding.'); },
  };
  return {
    database,
    budgets,
    run(operation: string, action: () => Promise<Response>) {
      const budget: Budget = { operation, calls: 0, executed: 0, statements: 0,
        batches: 0, maximumParameters: 0, blocked: 0 };
      budgets.push(budget);
      return scope.run(budget, async () => {
        const response = await action();
        await response.clone().arrayBuffer();
        budget.status = response.status;
        return response;
      });
    },
    assertBounds() {
      for (const budget of budgets) {
        const detail = JSON.stringify(budget);
        expect(budget.calls, detail).toBeLessThanOrEqual(50);
        expect(budget.executed, detail).toBe(budget.calls);
        expect(budget.maximumParameters, detail).toBeLessThanOrEqual(100);
        expect(budget.blocked, detail).toBe(0);
      }
    },
  };
}

async function fixture() {
  const observed = meter(env.IDENTITY_DB);
  const store = createCloudflareD1Store({ database: observed.database, createSchemaIfMissing: false, readBatchSize: 512 });
  const f = await createStagedReviewFixture(store, {
    context() { const value = createExecutionContext(); return { value, finish: () => waitOnExecutionContext(value) }; },
    environment(sender) {
      const broker: Queue<SupportLearningReviewQueueMessage> = {
        async metrics() { return { backlogCount: 0, backlogBytes: 0 }; },
        async send(message) { await sender.send(message); return { metadata: { metrics: { backlogCount: 1, backlogBytes: 0 } } }; },
        async sendBatch() { throw new Error('Expected an individual opaque SDK hint'); },
      };
      return { ...env, IDENTITY_DB: observed.database, IDENTITY_EMAIL_CODE_SECRET_BASE64: btoa('q'.repeat(32)),
        PEGMA_SUPPORT_LEARNING_REVIEWS_ENABLED: 'true', SUPPORT_LEARNING_REVIEWS: broker };
    },
  }, { clockedAuthentication: true });
  return { ...f, observed };
}

describe('registered intake retry and reconciliation on clocked real Native D1', () => {
  it('recovers the genuine discarded enrollment ACK before a changed revision under the full request meter', async () => {
    const f = await fixture(); const ticket = await f.learning.terminal();
    const commandId = 'EXACT-UPPERCASE-ACK-RECOVERY'; const packet = JSON.stringify({ commandId, expectedRevision: ticket.revision });
    // The actual server commits, and this fixture deliberately discards that
    // response. No accepted source or receipt value is constructed by the test.
    expect((await f.invoke('/enroll', packet)).status).toBe(200);
    const legacy = createSupportDeskApplication({ store: f.learning.store, clock: f.learning.clock });
    await legacy.addNote(f.learning.actors.staff, { ...f.learning.command('native-after-discarded-ack'), ticketId: learningTicketId,
      messageId: 'native-after-ack-note', body: 'A real fictional edit after the earlier enrollment.' });
    const before = await f.learning.rows(); f.learning.state.product = 'missing';
    const recovered = await f.observed.run('enroll.recovery.accepted', () => f.invoke('/enroll-recovery', packet));
    expect(recovered.status).toBe(200); const result = resultObject(await responseObject(recovered));
    expect(result).toMatchObject({ outcome: 'accepted', operation: 'enroll', commandId, ticketId: learningTicketId });
    expect(result.result).toMatchObject({ ticketId: learningTicketId, state: 'unverified', sourceGeneration: 0 });
    expect(await f.learning.rows()).toEqual(before); expect(f.learning.state.modelCalls).toBe(0); f.observed.assertBounds();
  });

  it.each(['missing', 'internal', 'unresolved', 'cycle'] as const)('fences a same-revision %s evidence prerequisite within the full clocked-session request budget', async (kind) => {
    const f = await fixture(); let ticket = await f.learning.terminal();
    expect((await f.invoke('/enroll', JSON.stringify({ commandId: 'SETUP-CONTENT-NATIVE', expectedRevision: ticket.revision }))).status).toBe(200);
    if (kind === 'unresolved') {
      await f.learning.application.reopenTicket(f.learning.actors.staff, { ...f.learning.command('native-content-reopen'), ticketId: learningTicketId });
      ticket = (await f.learning.application.readStaffTicket(f.learning.actors.staff, learningTicketId)).ticket;
    }
    const view = await f.learning.application.readStaffTicket(f.learning.actors.staff, learningTicketId);
    expect(view.ticket.revision).toBe(ticket.revision);
    expect(view.messages.some((message) => message.id === 'learning-solution' && message.visibility === 'customer')).toBe(true);
    expect(view.messages.some((message) => message.id === 'learning-note' && message.visibility === 'internal')).toBe(true);
    const solutionRow = (await f.learning.rows()).find((row) => row.kind === 'message' && row.message.id === 'learning-solution');
    if (solutionRow?.kind !== 'message') throw new Error('Expected the genuine SDK solution row');
    expect(solutionRow.ordinal).toBeLessThanOrEqual(ticket.revision);
    const commandId = 'EXACT-UPPERCASE-CONTENT-' + kind.toUpperCase();
    const packet = JSON.stringify({ commandId, expectedRevision: ticket.revision, resolutionCycle: kind === 'cycle' ? 2 : 1,
      solutionMessageId: kind === 'missing' ? 'missing-visible-solution' : kind === 'internal' ? 'learning-note' : 'learning-solution',
      verificationReference: 'SYNTHETIC_STAFF_VERIFICATION' });
    const before = await f.learning.rows();
    expect((await f.invoke('/evidence', packet)).status).toBe(409);
    const recovered = await f.observed.run('evidence.recovery.content.' + kind, () => f.invoke('/evidence-recovery', packet));
    expect(recovered.status).toBe(200);
    expect(resultObject(await responseObject(recovered))).toEqual({ outcome: 'superseded', ticketId: learningTicketId,
      commandId, operation: 'evidence', expectedRevision: ticket.revision, observedRevision: ticket.revision,
      fence: kind === 'unresolved' ? 'resolution_unavailable' : kind === 'cycle' ? 'resolution_cycle_changed' : 'solution_unavailable' });
    expect(await f.learning.rows()).toEqual(before); expect(f.learning.state.modelCalls).toBe(0); f.observed.assertBounds();
  });

  it.each(['enroll', 'evidence'] as const)('fences the exact stale %s revision within50calls/100parameters', async (operation) => {
    const f = await fixture(); const ticket = await f.learning.terminal();
    if (operation === 'evidence') {
      const accepted = await f.invoke('/enroll', JSON.stringify({ commandId: 'SETUP-ENROLL-EXACT', expectedRevision: ticket.revision }));
      expect(accepted.status).toBe(200);
    }
    const commandId = 'EXACT-UPPERCASE-' + operation.toUpperCase();
    const packet = JSON.stringify({ commandId, expectedRevision: ticket.revision,
      ...(operation === 'evidence' ? { resolutionCycle: 1, solutionMessageId: 'learning-solution', verificationReference: 'SYNTHETIC_STAFF_VERIFICATION' } : {}) });
    const legacy = createSupportDeskApplication({ store: f.learning.store, clock: f.learning.clock });
    await legacy.addNote(f.learning.actors.staff, { ...f.learning.command('native-intake-revision'), ticketId: learningTicketId,
      messageId: 'native-intake-competing-note', body: 'An independent fictional staff note advances the real revision.' });
    const original = await f.invoke('/' + operation, packet); expect(original.status).toBe(409);
    const before = await f.learning.rows();
    const recovered = await f.observed.run(operation + '.recovery.stale', () => f.invoke('/' + operation + '-recovery', packet));
    expect(recovered.status).toBe(200);
    expect(resultObject(await responseObject(recovered))).toMatchObject({ outcome: 'superseded', operation,
      ticketId: learningTicketId, commandId, expectedRevision: ticket.revision, observedRevision: ticket.revision + 1 });
    expect(await f.learning.rows()).toEqual(before); expect(f.learning.state.modelCalls).toBe(0);
    const observations = f.sessionObservations.filter((value) => value.previousLastSeenAt !== null);
    expect(observations.length).toBeGreaterThan(2);
    expect(observations.every((value) => value.previousLastSeenAt !== null && Date.parse(value.at) > Date.parse(value.previousLastSeenAt))).toBe(true);
    f.observed.assertBounds();
  });
});
