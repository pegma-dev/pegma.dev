/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { AsyncLocalStorage } from 'node:async_hooks';
import { env } from 'cloudflare:workers';
import {
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { createCloudflareD1Store } from '@pegma/storage-cloudflare-d1';
import { defineCollection } from '@pegma/storage-core';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import worker from './index';
import {
  CLEANUP_CRON,
  CLEANUP_LANE_COUNT,
  cleanupLaneAt,
} from './maintenance-schedule';
import { readSupportCursor } from './support-cursors';
import { supportFollowupRetestReceipts } from './support-release-followup-retests';

interface Budget {
  operation: string;
  calls: number;
  executed: number;
  statements: number;
  batches: number;
  maximumParameters: number;
  blocked: number;
  trace: {
    call: number;
    statements: { query: string; parameters: number }[];
  }[];
}
const scope = new AsyncLocalStorage<Budget>();
const profiles: Budget[] = [];
const NOW = Date.parse('2026-11-12T00:00:00.000Z');
interface RawRow {
  readonly partition: string;
  readonly id: string;
  readonly payload: string;
}
const rawRows = defineCollection<RawRow>({
  name: 'pegma.support-learning-test-bindings.v1',
  key: (value) => ({ partition: value.partition, id: value.id }),
  codec: {
    encode: (value) => ({ ...value }),
    decode: (value) => ({
      partition: String(value.partition),
      id: String(value.id),
      payload: String(value.payload),
    }),
  },
});

const followupRows = defineCollection<RawRow>({
  name: supportFollowupRetestReceipts.name,
  key: (value) => ({ partition: value.partition, id: value.id }),
  codec: {
    encode: (value) => ({ kind: 'intent', ticketId: value.partition, id: value.id, payload: value.payload }),
    decode: (value) => ({ partition: String(value.ticketId), id: String(value.id), payload: String(value.payload) }),
  },
});
// Cleanup-only abandoned intents, never qualifying a report or Work.
function followupIntent(index: number): RawRow {
  const ticketId = 'cleanup-only-followup-ticket';
  const id = 'receipt:' + index.toString(16).padStart(64, '0');
  return { partition: ticketId, id, payload: JSON.stringify({
    kind: 'intent', ticketId, id, actorId: 'cleanup-only-actor',
    commandHash: index.toString(16).padStart(64, '0'), inputHash: 'a'.repeat(64),
    packet: { commandId: '12345678-1234-4123-8123-123456789012', expectedPrincipalId: 'cleanup-only-actor', workId: 'cleanup-only-work', expectedWorkGeneration: 1, expectedTicketRevision: 1, retestRequestId: 'cleanup-only-request', report: { articleId: 'cleanup-only-article', ledgerEpoch: 1, reportId: 'cleanup-only-report', expectedReportGeneration: 1, reviewBindingHash: 'b'.repeat(64), receipt: 'cleanup-only-kb-receipt' } },
    binding: { ticketId, workId: 'cleanup-only-work', workBindingHash: 'cleanup-only-binding', requestId: 'cleanup-only-request', requestHash: 'cleanup-only-hash', bundleHash: 'cleanup-only-bundle', productBinding: 'cleanup-only-product' },
    workFingerprint: 'cleanup-only-work-fingerprint', workGeneration: 1,
    reportContext: { product: { productId: 'cleanup-only-product', version: 'legacy', buildId: 'legacy' }, validationRequirementIds: [] },
    retainUntil: new Date(NOW - 1).toISOString(),
  }) };
}

// Legacy cleanup-only coordinates. No report is submitted or verified, and
// these rows never serve as Support evidence or a passing workflow fixture.
function reference(index: number, retainUntil: number) {
  const stamp = new Date(NOW - 60_000).toISOString();
  return {
    id: `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
    commandHash: index.toString(16).padStart(64, '0'),
    inputHash: '1'.repeat(64),
    actorId: 'cleanup-only-actor',
    prepared: {
      ticketId: 'cleanup-only-ticket',
      expectedRevision: 1,
      resolutionCycle: 1,
      solutionMessageId: 'cleanup-only-solution',
      clientCommandId: `cleanup-only-command-${index}`,
      report: {
        articleId: 'cleanup-only-article',
        ledgerEpoch: 1,
        reportId: 'cleanup-only-report',
        expectedReportGeneration: 1,
        reviewBindingHash: '2'.repeat(64),
        receipt: 'cleanup-only-legacy-coordinate',
      },
    },
    resolvedAt: stamp,
    sourceFingerprint: '3'.repeat(64),
    product: {
      productId: 'cleanup-only',
      version: 'legacy',
      buildId: 'legacy',
      binding: 'legacy',
      contextVersion: 'legacy',
    },
    reportFingerprint: '4'.repeat(64),
    reportSubmitterId: 'cleanup-only-submitter',
    reportReviewerId: 'cleanup-only-reviewer',
    reportConfirmedAt: stamp,
    executionId: 'cleanup-only-execution',
    runnerId: 'cleanup-only-runner',
    testId: 'cleanup-only-test',
    executedAt: stamp,
    verifiedAt: stamp,
    validUntil: stamp,
    retainUntil: new Date(retainUntil).toISOString(),
  };
}
function row(
  index: number,
  references: ReturnType<typeof reference>[],
): RawRow {
  const partition = index.toString(16).padStart(64, '0');
  return {
    partition,
    id: 'bindings',
    payload: JSON.stringify({
      partition,
      id: 'bindings',
      ticketId: 'cleanup-only-ticket',
      references,
    }),
  };
}

/** Real binding calls, unchanged SQL/results, batch charged once, hard 50/100. */
function meter(backing: D1Database) {
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const counts = new WeakMap<D1PreparedStatement, number>();
  const queries = new WeakMap<D1PreparedStatement, string>();
  function charge(statements: readonly D1PreparedStatement[]) {
    const budget = scope.getStore();
    if (budget === undefined) return;
    budget.calls += 1;
    budget.statements += statements.length;
    budget.maximumParameters = Math.max(
      budget.maximumParameters,
      ...statements.map((statement) => counts.get(statement) ?? 0),
    );
    budget.trace.push({
      call: budget.calls,
      statements: statements.map((statement) => ({
        query: (queries.get(statement) ?? '')
          .replace(/\s+/gu, ' ')
          .slice(0, 240),
        parameters: counts.get(statement) ?? 0,
      })),
    });
    if (budget.calls > 50 || budget.maximumParameters > 100) {
      budget.blocked += 1;
      throw new Error('Native receipt cleanup50/100 guard refused execution');
    }
    budget.executed += 1;
  }
  function observed(
    original: D1PreparedStatement,
    query: string,
    count = 0,
  ): D1PreparedStatement {
    const statement: D1PreparedStatement = {
      bind(...values: unknown[]) {
        return observed(original.bind(...values), query, values.length);
      },
      first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
        charge([statement]);
        return column === undefined
          ? original.first<T>()
          : original.first<T>(column);
      },
      all<T = Record<string, unknown>>() {
        charge([statement]);
        return original.all<T>();
      },
      run<T = Record<string, unknown>>() {
        charge([statement]);
        return original.run<T>();
      },
      raw: new Proxy(original.raw, {
        apply(target, _receiver, args) {
          charge([statement]);
          return Reflect.apply(target, original, args);
        },
      }),
    };
    originals.set(statement, original);
    counts.set(statement, count);
    queries.set(statement, query);
    return statement;
  }
  const database: D1Database = {
    prepare(query) {
      return observed(backing.prepare(query), query);
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      charge(statements);
      const budget = scope.getStore();
      if (budget !== undefined) budget.batches += 1;
      return backing.batch<T>(
        statements.map((statement) => {
          const actual = originals.get(statement);
          if (actual === undefined)
            throw new Error('Expected genuine measured statement');
          return actual;
        }),
      );
    },
    exec() {
      throw new Error('Runtime schema mutation excluded from cleanup');
    },
    dump() {
      throw new Error('Runtime dump excluded');
    },
    withSession() {
      throw new Error('The public adapter uses direct D1');
    },
  };
  return {
    database,
    run(operation: string, action: () => Promise<void>) {
      const budget: Budget = {
        operation,
        calls: 0,
        executed: 0,
        statements: 0,
        batches: 0,
        maximumParameters: 0,
        blocked: 0,
        trace: [],
      };
      profiles.push(budget);
      return scope.run(budget, action);
    },
  };
}

beforeAll(async () => {
  // Genuine adapter schema setup is outside the measured scheduled invocation.
  await createCloudflareD1Store({ database: env.IDENTITY_DB })
    .collection(rawRows)
    .get({ partition: 'schema', id: 'absent' });
});
beforeEach(async () => {
  profiles.length = 0;
  await env.IDENTITY_DB.prepare('DELETE FROM RECORDS').run();
  await env.IDENTITY_DB.prepare('DELETE FROM PEGMA_STORAGE_D1_TX_GUARD').run();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(({ task }) => {
  Object.assign(task.meta, {
    testReceiptCleanupNativeBudget: structuredClone(profiles),
  });
  console.info('test-receipt-cleanup-native-budgets', JSON.stringify(profiles));
  vi.useRealTimers();
});

function scheduledTime() {
  for (let minute = 0; minute < CLEANUP_LANE_COUNT; minute++) {
    const time = NOW + minute * 60_000;
    const lane = cleanupLaneAt(time);
    if (lane.kind === 'support' && lane.task === 'test_receipts') return time;
  }
  throw new Error('Expected actual registered receipt cleanup lane');
}

describe('registered test-receipt cleanup over genuine D1', () => {
  it.each([false, true])(
    'cleans and resumes with no Source/config/keys, including existing wake gates %s',
    async (wakeFlags) => {
      const setup = createCloudflareD1Store({
        database: env.IDENTITY_DB,
        createSchemaIfMissing: false,
      });
      const rows = setup.collection(rawRows);
      for (let index = 1; index <= 24; index++) {
        const references =
          index <= 8
            ? [reference(index, NOW - 1), reference(index + 100, NOW + 60_000)]
            : index <= 16
              ? [reference(index, NOW - 1)]
              : [reference(index, NOW + 60_000)];
        await rows.put(row(index, references));
      }
      for (let index = 1; index <= 16; index++) await setup.collection(followupRows).put(followupIntent(index));
      const measured = meter(env.IDENTITY_DB);
      const environment = {
        ...env,
        IDENTITY_DB: measured.database,
        PEGMA_KNOWLEDGE_ENABLED: 'false',
        PEGMA_AGENT_CLIENTS_JSON: 'not-json',
        PEGMA_SUPPORT_ASSISTANT_ENABLED: 'false',
        PEGMA_SUPPORT_LEARNING_INTAKE_ENABLED: 'false',
        PEGMA_SUPPORT_LEARNING_REVIEWS_ENABLED: 'false',
        PEGMA_SUPPORT_ENGINEERING_PROCESSING_ENABLED: String(wakeFlags),
        PEGMA_SUPPORT_LEARNING_WORKER_ENABLED: String(wakeFlags),
        // Generated production Env types pin ON values. This local fixture must
        // exercise the actual OFF/malformed-configuration boundary as well.
      } as unknown as Parameters<typeof worker.scheduled>[1];
      // The local environment supplies no Source, model, checker, App or secrets.
      for (let page = 0; page < 4; page++) {
        await measured.run(
          `registered-cleanup-${wakeFlags ? 'wake-gates-on' : 'flags-off'}-page-${page + 1}`,
          async () => {
            const context = createExecutionContext();
            await worker.scheduled(
              {
                cron: CLEANUP_CRON,
                scheduledTime: scheduledTime(),
                noRetry() {},
              },
              environment,
              context,
            );
            await waitOnExecutionContext(context);
          },
        );
        const budget = profiles.at(-1)!;
        expect(budget.calls).toBeGreaterThan(0);
        expect(budget.calls).toBeLessThanOrEqual(50);
        expect(budget.executed).toBe(budget.calls);
        expect(budget.maximumParameters).toBeLessThanOrEqual(100);
        expect(budget.blocked).toBe(0);
        if (page === 0 || page === 1 || page === 3)
          expect(await readSupportCursor(setup, 'testReceiptCursor')).toEqual(
            expect.any(String),
          );
        else
          expect(
            await readSupportCursor(setup, 'testReceiptCursor'),
          ).toBeUndefined();
      }
      const redacted = await setup.collection(supportFollowupRetestReceipts).list('cleanup-only-followup-ticket');
      expect(redacted).toHaveLength(16);
      expect(redacted.every((value) => value.kind === 'tombstone')).toBe(true);
      expect(JSON.stringify(redacted)).not.toContain('cleanup-only-actor');
      expect(JSON.stringify(redacted)).not.toContain('cleanup-only-kb-receipt');
      const survivors = await rows.scan({ limit: 32 });
      expect(survivors.records).toHaveLength(16);
      for (const entry of survivors.records) {
        const payload = JSON.parse(entry.value.payload);
        expect(payload.references).toHaveLength(1);
        expect(Date.parse(payload.references[0].retainUntil)).toBeGreaterThan(
          NOW,
        );
      }
    },
  );
});
