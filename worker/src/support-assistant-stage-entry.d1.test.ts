/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveAccess } from '@pegma/authorization-core';
import { identityLinkKeyFromVerifiedIdentityClaims } from '@pegma/authorization-identity';
import { createRoleStore } from '@pegma/authorization-storage';
import { createCloudflareD1Store } from '@pegma/storage-cloudflare-d1';
import { systemClock } from '@pegma/spine';
import {
  createSupportDeskApplication,
  supportPermissions,
  supportRecords,
} from '@pegma/support-desk-application';
import { createAgentPrincipalResolver } from './agent-authority';
import { AUTHORIZATION_APPLICATION_ID } from './support-access';
import stageEntry, {
  type SupportAssistantIsolatedStageEnvironment,
} from './support-assistant-stage-entry';
import { createSupportAssistantStageDatabase } from './support-assistant-stage-budget';
import {
  SUPPORT_ASSISTANT_STAGE_QUEUE,
  SUPPORT_ASSISTANT_WAKE_DELIVERIES,
  SUPPORT_ASSISTANT_WAKE_MARKER,
} from './support-assistant-stage-queue';
import { supportAssistantCheckpoints, SUPPORT_ASSISTANT_WORKER_ID } from './support-assistant';
import { seedSupportAssistantStage } from './support-assistant-stage-seed';
import {
  createStageIdentity,
  createSupportAssistantStageScenario,
  stageCustomerPolicy,
  stageIds,
  type SupportAssistantStageScenario,
} from './support-assistant-stage-scenario';

declare global {
  namespace Cloudflare {
    interface Env {
      IDENTITY_DB: D1Database;
    }
  }
}

// Same reviewed two-table/three-trigger schema as the existing Native fixture.
const schema = [
  'CREATE TABLE IF NOT EXISTS RECORDS (partition_key TEXT NOT NULL, row_key TEXT NOT NULL, record_json TEXT, version INTEGER NOT NULL, deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)), PRIMARY KEY (partition_key, row_key)) STRICT',
  'CREATE TABLE IF NOT EXISTS PEGMA_STORAGE_D1_TX_GUARD (reason TEXT NOT NULL) STRICT',
  ...(['exists', 'missing', 'changed'] as const).map(
    (reason) =>
      `CREATE TRIGGER IF NOT EXISTS PEGMA_STORAGE_D1_TX_ABORT_${reason.toUpperCase()} BEFORE INSERT ON PEGMA_STORAGE_D1_TX_GUARD WHEN NEW.reason = '${reason}' BEGIN SELECT RAISE(ABORT, 'PEGMA_STORAGE_D1_TX_${reason.toUpperCase()}'); END`,
  ),
];
beforeAll(async () => {
  for (const statement of schema) await env.IDENTITY_DB.prepare(statement).run();
  await env.IDENTITY_DB.prepare(
    'CREATE TABLE IF NOT EXISTS STAGE_BUDGET_PROBE (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)',
  ).run();
});
beforeEach(async () => {
  await env.IDENTITY_DB.prepare('DELETE FROM RECORDS').run();
  await env.IDENTITY_DB.prepare('DELETE FROM PEGMA_STORAGE_D1_TX_GUARD').run();
  await env.IDENTITY_DB.prepare('DELETE FROM STAGE_BUDGET_PROBE').run();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function diagnostics() {
  const observations: unknown[] = [];
  let throwDiagnostic = false;
  vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    const [label, fields] = args;
    if (label === 'pegma.synthetic-answer-stage') observations.push(structuredClone(fields));
    if (throwDiagnostic) throw new Error('Fictional coarse diagnostic failure.');
  });
  function last() {
    const value = observations.at(-1);
    if (value === null || typeof value !== 'object')
      throw new Error('Missing actual stage profile.');
    return value;
  }
  return {
    observations,
    last,
    throwOnWrite: () => {
      throwDiagnostic = true;
    },
  };
}

function number(value: object, field: string): number {
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  if (descriptor === undefined || typeof descriptor.value !== 'number')
    throw new Error('Missing numeric stage metric.');
  return descriptor.value;
}

function withinBudget(value: object) {
  expect(number(value, 'physicalQueries')).toBeGreaterThan(0);
  expect(number(value, 'physicalQueries')).toBeLessThanOrEqual(50);
  expect(number(value, 'maximumParameters')).toBeLessThanOrEqual(100);
  expect(number(value, 'blockedQueries')).toBe(0);
  expect(number(value, 'blockedParameters')).toBe(0);
}

function delivery(
  options: {
    readonly id?: string;
    readonly attempts?: number;
    readonly sentAt?: string;
    readonly body?: unknown;
    readonly queue?: string;
  } = {},
) {
  const id = options.id ?? 'fictional-native-stage-message';
  const batch = createMessageBatch(options.queue ?? SUPPORT_ASSISTANT_STAGE_QUEUE, [
    {
      id,
      timestamp: new Date(options.sentAt ?? systemClock.now()),
      attempts: options.attempts ?? 1,
      body: options.body ?? SUPPORT_ASSISTANT_WAKE_MARKER,
    },
  ]);
  const message = batch.messages[0];
  if (message === undefined) throw new Error('Missing actual Workers pool message.');
  // These spies call through. Pool0.18.8 retains retry disposition, not options.
  const acknowledge = vi.spyOn(message, 'ack');
  const retry = vi.spyOn(message, 'retry');
  const context = createExecutionContext();
  async function decision() {
    const actual = await getQueueResult(batch, context);
    const acked = actual.explicitAcks.includes(id);
    const retried = actual.retryMessages.some(
      (value: { readonly msgId: string }) => value.msgId === id,
    );
    expect(acknowledge.mock.calls).toHaveLength(Number(acked));
    expect(retry.mock.calls).toHaveLength(Number(retried));
    expect(acked && retried).toBe(false);
    const delay = retry.mock.calls[0]?.[0]?.delaySeconds;
    if (retried) {
      expect(Number.isSafeInteger(delay)).toBe(true);
      if (delay === undefined) throw new Error('Missing actual bounded retry argument.');
      expect(delay).toBeGreaterThanOrEqual(1);
      expect(delay).toBeLessThanOrEqual(60);
    }
    return { acked, retried, delay };
  }
  return { id, batch, message, acknowledge, retry, decision };
}

function environment(scenario: SupportAssistantStageScenario) {
  let bindingReads = 0;
  return {
    options: {
      PEGMA_SUPPORT_ASSISTANT_STAGE_TARGET: 'isolated-stage',
      PEGMA_SUPPORT_ASSISTANT_STAGE_ENABLED: 'true',
      PEGMA_SUPPORT_ASSISTANT_STAGE_SCENARIO_JSON: JSON.stringify(scenario),
      get ASSISTANT_STAGE_DB() {
        ++bindingReads;
        return env.IDENTITY_DB;
      },
    } satisfies SupportAssistantIsolatedStageEnvironment,
    bindingReads: () => bindingReads,
  };
}

function store() {
  return createCloudflareD1Store({
    database: env.IDENTITY_DB,
    createSchemaIfMissing: false,
    readBatchSize: 512,
  });
}

async function job() {
  const rows = await store().collection(supportRecords).list(stageIds.ticket);
  const observed = rows.find((row) => row.kind === 'assistant_turn');
  if (observed === undefined || observed.kind !== 'assistant_turn')
    throw new Error('Missing actual seeded assistant job.');
  return observed;
}

async function answers() {
  const currentStore = store();
  const identity = createStageIdentity(currentStore, systemClock);
  const principal = await createAgentPrincipalResolver({
    identity,
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
    roleStore: createRoleStore(currentStore, AUTHORIZATION_APPLICATION_ID),
  })(stageIds.owner);
  if (principal === null) throw new Error('Seeded verified owner became unavailable.');
  const access = resolveAccess(
    { principalId: stageIds.owner, roles: principal.roles },
    stageCustomerPolicy,
  );
  const support = createSupportDeskApplication({
    store: currentStore,
    clock: systemClock,
  });
  const view = await support.readCustomerTicket(access, stageIds.ticket);
  return view.messages.filter((message) => message.authorKind === 'assistant');
}

describe('isolated stage entry and actual SDK seeder on Native D1', () => {
  it('prepares without spend, retries the same message, answers once after reconstruction and bounds duplicate scan continuations even when diagnostics throw', async ({
    task,
  }) => {
    const logs = diagnostics();
    // Retain actual profiles even if a later semantic assertion fails.
    Object.assign(task.meta, { supportAssistantStageEntryProfiles: logs.observations });
    const scenario = createSupportAssistantStageScenario(systemClock);
    await seedSupportAssistantStage(env.IDENTITY_DB, scenario);
    await expect(seedSupportAssistantStage(env.IDENTITY_DB, scenario)).rejects.toThrow(
      'empty isolated',
    );
    const sentAt = systemClock.now();
    const first = delivery({ sentAt });
    const firstEnv = environment(scenario);
    await stageEntry.queue(first.batch, firstEnv.options);
    const firstDecision = await first.decision();
    expect(firstDecision).toMatchObject({ acked: false, retried: true });
    const prepared = await job();
    expect(prepared).toMatchObject({
      status: 'retry',
      attempt: 1,
      preparedAttempts: [{ accounting: 'not_called' }],
    });
    expect(prepared.nextAttemptAt).toBeDefined();
    expect(await answers()).toEqual([]);
    expect(logs.last()).toMatchObject({
      outcome: 'prepared',
      disposition: 'retry',
      retrySeconds: firstDecision.delay,
      modelCalls: 0,
      reservationCalls: 0,
    });
    withinBudget(logs.last());
    if (prepared.nextAttemptAt === undefined || firstDecision.delay === undefined)
      throw new Error('Missing actual prepared due time.');
    const retryAt = Math.max(
      Date.parse(prepared.nextAttemptAt),
      Date.now() + firstDecision.delay * 1000,
    );
    expect(retryAt).toBeGreaterThanOrEqual(Date.parse(prepared.nextAttemptAt));
    // Public Vitest4 setSystemTime without fake timers mocks Date only.
    vi.setSystemTime(new Date(retryAt));
    logs.throwOnWrite();
    const second = delivery({ id: first.id, sentAt, attempts: 2 });
    const secondEnv = environment(scenario);
    await expect(stageEntry.queue(second.batch, secondEnv.options)).resolves.toBeUndefined();
    expect(await second.decision()).toMatchObject({ acked: true, retried: false });
    expect(await answers()).toHaveLength(1);
    expect((await job()).status).toBe('completed');
    expect(logs.last()).toMatchObject({
      outcome: 'scanned',
      disposition: 'ack',
      modelCalls: 1,
      reservationCalls: 1,
      reconciliationCalls: 1,
    });
    withinBudget(logs.last());
    expect(firstEnv.bindingReads()).toBe(1);
    expect(secondEnv.bindingReads()).toBe(1);
    // A completed job does not make a one-row physical scan empty. The SDK
    // can encounter terminal work, messages or receipts and advance its cursor.
    // Observe that exact public SDK page before each distinct queue invocation.
    const scanObservations: unknown[] = [];
    Object.assign(task.meta, { supportAssistantStageDuplicateScans: scanObservations });
    let acknowledged = false;
    for (let attempts = 3; attempts <= SUPPORT_ASSISTANT_WAKE_DELIVERIES; ++attempts) {
      const before = await store()
        .collection(supportAssistantCheckpoints)
        .get({ partition: 'support-answering', id: 'scan' });
      if (before === null) throw new Error('Missing actual post-answer checkpoint.');
      const previewApplication = createSupportDeskApplication({
        store: store(),
        clock: systemClock,
        assistantHandlingEnabled: true,
        assistantTurns: { maxAttempts: 2 },
      });
      const scanAccess = resolveAccess(
        { principalId: SUPPORT_ASSISTANT_WORKER_ID },
        {
          version: 'fictional-stage-scan-observer',
          defaults: [supportPermissions.assistantRead],
        },
      );
      const page = await previewApplication.scanAssistantTurnCandidates(scanAccess, {
        limit: 1,
        ...(before.cursor === null ? {} : { cursor: before.cursor }),
      });
      expect(page.candidates).toEqual([]);
      expect(page.pages).toBe(1);
      expect(page.physicalRows).toBeGreaterThanOrEqual(0);
      expect(page.physicalRows).toBeLessThanOrEqual(1);
      const duplicate = delivery({ id: first.id, sentAt, attempts });
      const duplicateEnv = environment(scenario);
      await stageEntry.queue(duplicate.batch, duplicateEnv.options);
      const actual = await duplicate.decision();
      const after = await store()
        .collection(supportAssistantCheckpoints)
        .get({ partition: 'support-answering', id: 'scan' });
      expect(after).toMatchObject({ generation: before.generation + 1, cursor: page.nextCursor });
      // Existing Queue policy retries an acknowledged one-row filtered page,
      // then stops at its existing delivery cap even if physical rows remain.
      const retry = page.physicalRows === 1 && attempts < SUPPORT_ASSISTANT_WAKE_DELIVERIES;
      scanObservations.push({
        attempts,
        physicalRows: page.physicalRows,
        candidates: page.candidates.length,
        checkpointGeneration: after?.generation,
        acknowledged: actual.acked,
        retried: actual.retried,
        expectedRetry: retry,
        requestedDelay: actual.delay ?? null,
      });
      expect(actual).toMatchObject({ acked: !retry, retried: retry });
      expect(logs.last()).toMatchObject({
        outcome: 'scanned',
        disposition: retry ? 'retry' : 'ack',
        retrySeconds: retry ? 5 : null,
        modelCalls: 0,
        reservationCalls: 0,
        reconciliationCalls: 0,
      });
      withinBudget(logs.last());
      expect(duplicateEnv.bindingReads()).toBe(1);
      expect(await answers()).toHaveLength(1);
      expect((await job()).status).toBe('completed');
      if (!retry) {
        acknowledged = true;
        break;
      }
      expect(actual.delay).toBe(5);
      vi.setSystemTime(new Date(Date.now() + 5000));
    }
    expect(acknowledged).toBe(true);
    Object.assign(task.meta, {
      supportAssistantStageEntryProfiles: structuredClone(logs.observations),
    });
  });

  it('recovers actual durable no-call preparation after an interrupted retry disposition using the same message', async ({
    task,
  }) => {
    const logs = diagnostics();
    // Retain actual profiles even if a later semantic assertion fails.
    Object.assign(task.meta, { supportAssistantStageEntryProfiles: logs.observations });
    const scenario = createSupportAssistantStageScenario(systemClock);
    await seedSupportAssistantStage(env.IDENTITY_DB, scenario);
    const sentAt = systemClock.now();
    const first = delivery({ sentAt });
    first.retry.mockImplementationOnce(() => {
      throw new Error('Fictional broker interruption after SDK preparation.');
    });
    await expect(stageEntry.queue(first.batch, environment(scenario).options)).rejects.toThrow(
      'broker interruption',
    );
    expect(first.acknowledge).not.toHaveBeenCalled();
    const prepared = await job();
    expect(prepared).toMatchObject({
      status: 'retry',
      preparedAttempts: [{ accounting: 'not_called' }],
    });
    expect(logs.last()).toMatchObject({
      outcome: 'prepared',
      disposition: 'none',
      threw: true,
      modelCalls: 0,
      reservationCalls: 0,
    });
    withinBudget(logs.last());
    if (prepared.nextAttemptAt === undefined)
      throw new Error('Missing genuine durable retry time.');
    vi.setSystemTime(new Date(Date.parse(prepared.nextAttemptAt)));
    const retry = delivery({ id: first.id, sentAt, attempts: 2 });
    await stageEntry.queue(retry.batch, environment(scenario).options);
    expect(await retry.decision()).toMatchObject({ acked: true, retried: false });
    expect(await answers()).toHaveLength(1);
    expect(logs.last()).toMatchObject({ modelCalls: 1, reservationCalls: 1, disposition: 'ack' });
    withinBudget(logs.last());
    Object.assign(task.meta, {
      supportAssistantStageEntryProfiles: structuredClone(logs.observations),
    });
  });

  it.each([
    'disabled',
    'missing-gate',
    'wrong-target',
    'missing-scenario',
    'malformed-json',
    'wrong-schema',
    'expired',
    'wrong-marker',
  ] as const)('rejects %s before accessing the D1 binding', async (kind) => {
    const logs = diagnostics();
    const scenario = createSupportAssistantStageScenario(systemClock);
    const expired = createSupportAssistantStageScenario({
      now: () => new Date(Date.now() - 7_200_000).toISOString(),
    });
    let bindingReads = 0;
    const options: SupportAssistantIsolatedStageEnvironment = {
      ...(kind === 'missing-gate'
        ? {}
        : {
            PEGMA_SUPPORT_ASSISTANT_STAGE_TARGET:
              kind === 'wrong-target' ? 'production' : 'isolated-stage',
            PEGMA_SUPPORT_ASSISTANT_STAGE_ENABLED: kind === 'disabled' ? 'false' : 'true',
          }),
      ...(kind === 'missing-scenario'
        ? {}
        : {
            PEGMA_SUPPORT_ASSISTANT_STAGE_SCENARIO_JSON:
              kind === 'malformed-json'
                ? '{'
                : JSON.stringify(
                    kind === 'expired'
                      ? expired
                      : kind === 'wrong-schema'
                        ? { ...scenario, version: 2 }
                        : scenario,
                  ),
          }),
      get ASSISTANT_STAGE_DB(): D1Database {
        ++bindingReads;
        throw new Error('Unexpected stage binding access.');
      },
    };
    const current = delivery({
      body: kind === 'wrong-marker' ? 'wrong-marker' : SUPPORT_ASSISTANT_WAKE_MARKER,
    });
    await stageEntry.queue(current.batch, options);
    expect(await current.decision()).toMatchObject({ acked: true, retried: false });
    expect(bindingReads).toBe(0);
    expect(logs.last()).toMatchObject({
      physicalQueries: 0,
      modelCalls: 0,
      reservationCalls: 0,
      disposition: 'ack',
    });
  });

  it('rejects an unrelated queue before accessing the D1 binding or acknowledging it', async () => {
    diagnostics();
    const current = delivery({ queue: 'fictional-unrelated-stage-queue' });
    let bindingReads = 0;
    await expect(
      stageEntry.queue(current.batch, {
        PEGMA_SUPPORT_ASSISTANT_STAGE_TARGET: 'isolated-stage',
        PEGMA_SUPPORT_ASSISTANT_STAGE_ENABLED: 'true',
        get ASSISTANT_STAGE_DB(): D1Database {
          ++bindingReads;
          throw new Error('Unexpected binding access.');
        },
      }),
    ).rejects.toThrow('Unexpected isolated stage queue');
    expect(bindingReads).toBe(0);
    expect(current.acknowledge).not.toHaveBeenCalled();
    expect(current.retry).not.toHaveBeenCalled();
  });

  it('delegates first/all/raw/run and counts native batches once, then blocks query51 before its write', async () => {
    await env.IDENTITY_DB.prepare('INSERT INTO STAGE_BUDGET_PROBE (id, value) VALUES (1, 0)').run();
    const measured = createSupportAssistantStageDatabase(env.IDENTITY_DB);
    const database = measured.database;
    expect(await database.prepare('SELECT 42 AS value').first<number>('value')).toBe(42);
    expect((await database.prepare('SELECT 42 AS value').all()).results).toEqual([{ value: 42 }]);
    expect(await database.prepare('SELECT 42 AS value').raw()).toEqual([[42]]);
    const increment = () =>
      database.prepare('UPDATE STAGE_BUDGET_PROBE SET value = value + 1 WHERE id = 1');
    await increment().run();
    await database.batch([increment(), increment()]);
    expect(measured.snapshot()).toMatchObject({
      physicalQueries: 5,
      statements: 6,
      batches: 1,
      maximumBatchStatements: 2,
    });
    for (let call = 5; call < 50; ++call) await increment().run();
    expect(() => increment().run()).toThrow('query 51');
    expect(measured.snapshot()).toMatchObject({
      physicalQueries: 50,
      statements: 51,
      blockedQueries: 1,
    });
    // This verification is outside the instrumented invocation and uses real D1.
    expect(
      await env.IDENTITY_DB.prepare(
        'SELECT value FROM STAGE_BUDGET_PROBE WHERE id = 1',
      ).first<number>('value'),
    ).toBe(48);
  });

  it('accepts100 actual bound parameters and rejects101 before binding or execution', async () => {
    const measured = createSupportAssistantStageDatabase(env.IDENTITY_DB);
    const query = (count: number) =>
      'SELECT ' + Array.from({ length: count }, (_, index) => '? AS p' + index).join(', ');
    const hundred = await measured.database
      .prepare(query(100))
      .bind(...Array.from({ length: 100 }, (_, index) => index))
      .first<Record<string, number>>();
    expect(hundred).not.toBeNull();
    expect(Object.keys(hundred ?? {})).toHaveLength(100);
    expect(hundred?.p99).toBe(99);
    expect(() =>
      measured.database
        .prepare(query(101))
        .bind(...Array.from({ length: 101 }, (_, index) => index)),
    ).toThrow('parameter 101');
    expect(measured.snapshot()).toMatchObject({
      physicalQueries: 1,
      maximumParameters: 101,
      blockedParameters: 1,
    });
  });
});
