/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCloudflareD1Store } from '@pegma/storage-cloudflare-d1';
import { systemClock } from '@pegma/spine';
import { supportRecords } from '@pegma/support-desk-application';
import stageEntry, {
  type SupportAssistantIsolatedStageEnvironment,
} from './support-assistant-stage-entry';
import {
  SUPPORT_ASSISTANT_STAGE_QUEUE,
  SUPPORT_ASSISTANT_WAKE_DELIVERIES,
  SUPPORT_ASSISTANT_WAKE_MARKER,
} from './support-assistant-stage-queue';
import { supportAssistantCheckpoints } from './support-assistant';
import { seedSupportAssistantStage } from './support-assistant-stage-seed';
import {
  createSupportAssistantStageScenario,
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

// Existing native suite's actual two-table/three-trigger schema.
const schema = [
  'CREATE TABLE IF NOT EXISTS RECORDS (partition_key TEXT NOT NULL, row_key TEXT NOT NULL, record_json TEXT, version INTEGER NOT NULL, deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)), PRIMARY KEY (partition_key, row_key)) STRICT',
  'CREATE TABLE IF NOT EXISTS PEGMA_STORAGE_D1_TX_GUARD (reason TEXT NOT NULL) STRICT',
  ...(['exists', 'missing', 'changed'] as const).map(
    (reason) =>
      'CREATE TRIGGER IF NOT EXISTS PEGMA_STORAGE_D1_TX_ABORT_' +
      reason.toUpperCase() +
      " BEFORE INSERT ON PEGMA_STORAGE_D1_TX_GUARD WHEN NEW.reason = '" +
      reason +
      "' BEGIN SELECT RAISE(ABORT, 'PEGMA_STORAGE_D1_TX_" +
      reason.toUpperCase() +
      "'); END",
  ),
];
beforeAll(async () => {
  for (const statement of schema) await env.IDENTITY_DB.prepare(statement).run();
});
beforeEach(async () => {
  await env.IDENTITY_DB.prepare('DELETE FROM RECORDS').run();
  await env.IDENTITY_DB.prepare('DELETE FROM PEGMA_STORAGE_D1_TX_GUARD').run();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function waitForGate(ready: Promise<void>, operation: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      operation.then(() => {
        throw new Error('Native operation missed its barrier.');
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Native read barrier expired.')), 10_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
function store() {
  return createCloudflareD1Store({
    database: env.IDENTITY_DB,
    createSchemaIfMissing: false,
    readBatchSize: 512,
  });
}
const checkpointKey = { partition: 'support-answering', id: 'scan' };
const checkpoint = () =>
  store().collection(supportAssistantCheckpoints).getVersioned(checkpointKey);
const rows = () => store().collection(supportRecords).list(stageIds.ticket);
async function currentJob() {
  const job = (await rows()).find((row) => row.kind === 'assistant_turn');
  if (job?.kind !== 'assistant_turn') throw new Error('Missing actual SDK turn.');
  return job;
}
async function answerCount() {
  return (await rows()).filter(
    (row) => row.kind === 'message' && row.message.authorKind === 'assistant',
  ).length;
}

type CheckpointWrite = { readonly generation: number; readonly notBefore?: string };
function checkpointWrite(values: readonly unknown[]): CheckpointWrite | undefined {
  for (const value of values) {
    if (typeof value !== 'string' || !value.startsWith('{')) continue;
    const data: unknown = JSON.parse(value);
    if (
      data === null ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      !('partition' in data) ||
      data.partition !== checkpointKey.partition ||
      !('id' in data) ||
      data.id !== checkpointKey.id ||
      !('generation' in data) ||
      typeof data.generation !== 'number'
    )
      continue;
    return {
      generation: data.generation,
      ...('notBefore' in data && typeof data.notBefore === 'string'
        ? { notBefore: data.notBefore }
        : {}),
    };
  }
  return undefined;
}

/** Every execution delegates to D1. Hooks delay or lose actual returns only. */
function observedDatabase(hooks: {
  readonly afterBatch?: () => Promise<void>;
  readonly afterCheckpointWrite?: (value: CheckpointWrite) => Promise<void>;
}): D1Database {
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  function wrap(
    original: D1PreparedStatement,
    values: readonly unknown[] = [],
  ): D1PreparedStatement {
    const observed = new Proxy(original, {
      get(target, property) {
        if (property === 'bind')
          return (...parameters: unknown[]) => wrap(target.bind(...parameters), parameters);
        if (property === 'first')
          return async <T>(column?: string): Promise<T | null> => {
            const result =
              column === undefined ? await target.first<T>() : await target.first<T>(column);
            const written = checkpointWrite(values);
            if (written !== undefined && result !== null)
              await hooks.afterCheckpointWrite?.(written);
            return result;
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    originals.set(observed, original);
    return observed;
  }
  return new Proxy(env.IDENTITY_DB, {
    get(target, property) {
      if (property === 'prepare') return (sql: string) => wrap(target.prepare(sql));
      if (property === 'batch')
        return async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
          const result = await target.batch<T>(
            statements.map((statement) => originals.get(statement) ?? statement),
          );
          await hooks.afterBatch?.();
          return result;
        };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
async function setup() {
  const scenario = createSupportAssistantStageScenario(systemClock);
  await seedSupportAssistantStage(env.IDENTITY_DB, scenario);
  const profiles: Record<string, unknown>[] = [];
  vi.spyOn(console, 'info').mockImplementation((label: unknown, value: unknown) => {
    if (
      label !== 'pegma.synthetic-answer-stage' ||
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value)
    )
      return;
    profiles.push(Object.fromEntries(Object.entries(value)));
  });
  return { scenario, profiles };
}
async function deliver(
  scenario: SupportAssistantStageScenario,
  sentAt: string,
  attempts: number,
  database = env.IDENTITY_DB,
) {
  const id = 'fictional-recovery-wake';
  const batch = createMessageBatch(SUPPORT_ASSISTANT_STAGE_QUEUE, [
    {
      id,
      timestamp: new Date(sentAt),
      attempts,
      body: SUPPORT_ASSISTANT_WAKE_MARKER,
    },
  ]);
  const message = batch.messages[0];
  if (message === undefined) throw new Error('Missing actual pool message.');
  const retry = vi.spyOn(message, 'retry');
  const context = createExecutionContext();
  const options: SupportAssistantIsolatedStageEnvironment = {
    PEGMA_SUPPORT_ASSISTANT_STAGE_TARGET: 'isolated-stage',
    PEGMA_SUPPORT_ASSISTANT_STAGE_ENABLED: 'true',
    PEGMA_SUPPORT_ASSISTANT_STAGE_SCENARIO_JSON: JSON.stringify(scenario),
    ASSISTANT_STAGE_DB: database,
  };
  await stageEntry.queue(batch, options);
  const result = await getQueueResult(batch, context);
  return {
    acked: result.explicitAcks.includes(id),
    retried: result.retryMessages.some((entry: { readonly msgId: string }) => entry.msgId === id),
    delay: retry.mock.calls[0]?.[0]?.delaySeconds,
  };
}
function nextDelivery(delay: number | undefined) {
  if (delay === undefined) throw new Error('Missing actual retry delay.');
  vi.setSystemTime(new Date(Date.now() + delay * 1000));
}
function expectBudgets(profiles: readonly Record<string, unknown>[]) {
  expect(profiles.length).toBeGreaterThan(0);
  for (const profile of profiles) {
    expect(profile.physicalQueries).toBeLessThanOrEqual(50);
    expect(profile.maximumParameters).toBeLessThanOrEqual(100);
    expect(profile.blockedQueries).toBe(0);
    expect(profile.blockedParameters).toBe(0);
  }
  expect(profiles.filter((entry) => entry.modelCalls === 1)).toHaveLength(1);
}

describe('native queue recovery through the actual stage entry', () => {
  it('retries an unavailable checkpoint read, then prepares and answers once', async ({ task }) => {
    const f = await setup();
    Object.assign(task.meta, { supportAssistantStageRecoveryProfiles: f.profiles });
    const sentAt = systemClock.now();
    const before = await checkpoint();
    let failRead = true;
    const failed = observedDatabase({
      async afterBatch() {
        if (failRead) {
          failRead = false;
          throw new Error('Fictional lost native checkpoint read.');
        }
      },
    });
    const first = await deliver(f.scenario, sentAt, 1, failed);
    expect(first).toMatchObject({ acked: false, retried: true, delay: 5 });
    expect(await checkpoint()).toEqual(before);
    expect((await currentJob()).attempt).toBe(0);
    expect(await answerCount()).toBe(0);
    nextDelivery(first.delay);
    const prepared = await deliver(f.scenario, sentAt, 2);
    expect(prepared).toMatchObject({ acked: false, retried: true });
    expect((await currentJob()).attempt).toBe(1);
    nextDelivery(prepared.delay);
    expect(await deliver(f.scenario, sentAt, 3)).toMatchObject({ acked: true, retried: false });
    expect(await answerCount()).toBe(1);
    expect((await currentJob()).status).toBe('completed');
    expectBudgets(f.profiles);
    Object.assign(task.meta, { supportAssistantStageRecoveryProfiles: f.profiles });
  });

  it('defers an immediate duplicate at the retained cursor until the real prepared due time', async ({
    task,
  }) => {
    const f = await setup();
    Object.assign(task.meta, { supportAssistantStageRecoveryProfiles: f.profiles });
    vi.setSystemTime(new Date());
    const sentAt = systemClock.now();
    expect((await deliver(f.scenario, sentAt, 1)).retried).toBe(true);
    const prepared = await currentJob();
    expect(prepared.nextAttemptAt).toBeDefined();
    const head = await checkpoint();
    expect(head?.value.notBefore).toBe(prepared.nextAttemptAt);
    const early = await deliver(f.scenario, sentAt, 2);
    expect(early).toMatchObject({ acked: false, retried: true });
    expect(await checkpoint()).toEqual(head);
    expect(await currentJob()).toEqual(prepared);
    expect(f.profiles.at(-1)).toMatchObject({
      outcome: 'deferred',
      modelCalls: 0,
      reservationCalls: 0,
    });
    nextDelivery(early.delay);
    expect(await deliver(f.scenario, sentAt, 3)).toMatchObject({ acked: true, retried: false });
    expect(await answerCount()).toBe(1);
    expectBudgets(f.profiles);
    Object.assign(task.meta, { supportAssistantStageRecoveryProfiles: f.profiles });
  });

  it('protects the cursor while the first native hold ACK is delayed before SDK processing', async ({
    task,
  }) => {
    const f = await setup();
    Object.assign(task.meta, { supportAssistantStageRecoveryProfiles: f.profiles });
    vi.setSystemTime(new Date());
    const sentAt = systemClock.now();
    const reached = gate();
    const resume = gate();
    let held = false;
    const delayed = observedDatabase({
      async afterCheckpointWrite(value) {
        if (value.notBefore !== undefined && !held) {
          held = true;
          reached.release();
          await resume.promise;
        }
      },
    });
    const first = deliver(f.scenario, sentAt, 1, delayed);
    let duplicate: Awaited<ReturnType<typeof deliver>> | undefined;
    try {
      await waitForGate(reached.promise, first);
      const before = await checkpoint();
      duplicate = await deliver(f.scenario, sentAt, 2);
      expect(duplicate).toMatchObject({ acked: false, retried: true });
      expect(await checkpoint()).toEqual(before);
      expect((await currentJob()).attempt).toBe(0);
    } finally {
      resume.release();
    }
    expect((await first).retried).toBe(true);
    if (duplicate === undefined) throw new Error('Missing duplicate disposition.');
    nextDelivery(duplicate.delay);
    expect(await deliver(f.scenario, sentAt, 3)).toMatchObject({ acked: true, retried: false });
    expect(await answerCount()).toBe(1);
    expectBudgets(f.profiles);
    Object.assign(task.meta, { supportAssistantStageRecoveryProfiles: f.profiles });
  });

  it('redelivers after a committed cursor write loses its ACK without another paid attempt', async ({
    task,
  }) => {
    const f = await setup();
    Object.assign(task.meta, { supportAssistantStageRecoveryProfiles: f.profiles });
    const sentAt = systemClock.now();
    const first = await deliver(f.scenario, sentAt, 1);
    nextDelivery(first.delay);
    let lost = false;
    const unavailable = observedDatabase({
      async afterCheckpointWrite(value) {
        if (value.notBefore === undefined && !lost) {
          lost = true;
          throw new Error('Fictional lost committed checkpoint ACK.');
        }
      },
    });
    const second = await deliver(f.scenario, sentAt, 2, unavailable);
    expect(lost).toBe(true);
    expect(second).toMatchObject({ acked: false, retried: true, delay: 5 });
    expect(await answerCount()).toBe(1);
    const completed = await currentJob();
    expect(completed.status).toBe('completed');
    let ended = false;
    let delay = second.delay;
    for (let attempt = 3; attempt <= SUPPORT_ASSISTANT_WAKE_DELIVERIES; ++attempt) {
      nextDelivery(delay);
      const result = await deliver(f.scenario, sentAt, attempt);
      expect(await currentJob()).toEqual(completed);
      expect(await answerCount()).toBe(1);
      if (result.acked) {
        ended = true;
        break;
      }
      expect(result.retried).toBe(true);
      delay = result.delay;
    }
    expect(ended).toBe(true);
    expectBudgets(f.profiles);
    Object.assign(task.meta, { supportAssistantStageRecoveryProfiles: f.profiles });
  });
});
