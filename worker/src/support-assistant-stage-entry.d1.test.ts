/// <reference types="@cloudflare/vitest-pool-workers/types" />

import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { resolveAccess } from '@pegma/authorization-core';
import { identityLinkKeyFromVerifiedIdentityClaims } from '@pegma/authorization-identity';
import { createRoleStore } from '@pegma/authorization-storage';
import { createCloudflareD1Store } from '@pegma/storage-cloudflare-d1';
import { systemClock } from '@pegma/spine';
import {
  defineCollection,
  type CollectionDefinition,
  type CollectionStore,
  type EntityKey,
  type Store,
  type StoredRecord,
} from '@pegma/storage-core';
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
  SUPPORT_ASSISTANT_WAKE_AGE_MILLISECONDS,
  SUPPORT_ASSISTANT_WAKE_MARKER,
} from './support-assistant-stage-queue';
import {
  supportAssistantCheckpoints,
  SUPPORT_ASSISTANT_WORKER_ID,
  SUPPORT_ASSISTANT_SCAN_LIMIT,
} from './support-assistant';
import { seedSupportAssistantStage } from './support-assistant-stage-seed';
import {
  createStageIdentity,
  createStageKnowledge,
  createSupportAssistantStageScenario,
  stageCustomerPolicy,
  stageIds,
  stageScenarioCurrent,
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
  for (const statement of schema)
    await env.IDENTITY_DB.prepare(statement).run();
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
    if (label === 'pegma.synthetic-answer-stage')
      observations.push(structuredClone(fields));
    if (throwDiagnostic)
      throw new Error('Fictional coarse diagnostic failure.');
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
  const batch = createMessageBatch(
    options.queue ?? SUPPORT_ASSISTANT_STAGE_QUEUE,
    [
      {
        id,
        timestamp: new Date(options.sentAt ?? systemClock.now()),
        attempts: options.attempts ?? 1,
        body: options.body ?? SUPPORT_ASSISTANT_WAKE_MARKER,
      },
    ],
  );
  const message = batch.messages[0];
  if (message === undefined)
    throw new Error('Missing actual Workers pool message.');
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
      if (delay === undefined)
        throw new Error('Missing actual bounded retry argument.');
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

interface StoredUsageLedger {
  readonly policyHash: string;
  readonly accountingHold: boolean;
  readonly spentMicros: string;
  readonly reservations: readonly {
    readonly reservationHash: string;
    readonly attemptHash: string;
    readonly identityHash: string;
    readonly bindingHash: string;
    readonly state: string;
    readonly reservedMicros: number;
    readonly deadline: string;
    readonly createdAt: string;
    readonly terminalAt: string | null;
    readonly usage: {
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly costMicros: number;
      readonly currency: string;
    } | null;
  }[];
}

// Read-only observation of the real host ledger, outside the measured entry.
// This definition never inserts, replaces or manufactures accounting rows.
const usageRecords = defineCollection<StoredRecord>({
  name: 'pegma.support-assistant-usage.v1',
  key: (value) => ({
    partition: String(value.partition),
    id: String(value.id),
  }),
  codec: {
    encode: (value) => ({ ...value }),
    decode: (value) => ({ ...value }),
  },
});

async function usageLedger(): Promise<StoredUsageLedger | null> {
  const record = await store().collection(usageRecords).get({
    partition: 'support_answer',
    id: 'budget',
  });
  return record === null ? null : JSON.parse(String(record.payload));
}

async function assertPaidLedger() {
  const completed = await job();
  const paid = completed.preparedAttempts.filter((value) =>
    value.binding.usageReservationId.startsWith('usage:'),
  );
  expect(paid).toHaveLength(1);
  const attempt = paid[0];
  if (attempt === undefined)
    throw new Error('Missing genuine paid SDK attempt.');
  expect(completed.processing).toMatchObject({
    inputTokens: 100,
    outputTokens: 30,
    costMicros: 10,
    currency: 'USD',
  });
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify(['reservation', attempt.binding.usageReservationId]),
    ),
  );
  const reservationHash = Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
  const ledger = await usageLedger();
  expect(ledger).not.toBeNull();
  expect(ledger?.policyHash).toMatch(/^[0-9a-f]{64}$/u);
  expect(ledger).toMatchObject({ accountingHold: false, spentMicros: '10' });
  expect(ledger?.reservations).toHaveLength(1);
  expect(ledger?.reservations[0]).toMatchObject({
    reservationHash,
    reservedMicros: 10_000,
    deadline: attempt.binding.deadline,
    state: 'known',
    usage: {
      inputTokens: 100,
      outputTokens: 30,
      costMicros: 10,
      currency: 'USD',
    },
  });
  const reservation = ledger?.reservations[0];
  if (reservation === undefined || reservation.terminalAt === null)
    throw new Error('Missing actual terminal usage settlement.');
  for (const hash of [
    reservation.attemptHash,
    reservation.identityHash,
    reservation.bindingHash,
  ])
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
  expect(Date.parse(reservation.terminalAt)).toBeGreaterThanOrEqual(
    Date.parse(reservation.createdAt),
  );
  return ledger;
}

async function currentAccess(principalId: string) {
  const currentStore = store();
  const principal = await createAgentPrincipalResolver({
    identity: createStageIdentity(currentStore, systemClock),
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
    roleStore: createRoleStore(currentStore, AUTHORIZATION_APPLICATION_ID),
  })(principalId);
  if (principal === null) throw new Error('Missing real fixture principal.');
  return resolveAccess(
    { principalId, roles: principal.roles },
    stageCustomerPolicy,
  );
}

async function withdrawCustomer(
  kind: 'role' | 'principal' | 'source',
  scenario: SupportAssistantStageScenario,
) {
  const backing = store();
  if (kind === 'role') {
    const roles = createRoleStore(backing, AUTHORIZATION_APPLICATION_ID);
    const observed = await roles.getRoleAssignment(
      'fixture-role-' + stageIds.owner,
    );
    if (observed === null) throw new Error('Missing actual seeded assignment.');
    expect(
      await roles.revokeRoleAssignmentWithAudit({
        assignmentId: observed.assignment.id,
        expectedConcurrencyToken: observed.concurrencyToken,
        revokedBy: { kind: 'principal', principalId: stageIds.administrator },
        revokedAtEpochMs: Date.parse(systemClock.now()),
        auditEventId: 'fictional-stage-role-withdrawal',
      }),
    ).toMatchObject({ status: 'revoked' });
  } else if (kind === 'principal') {
    // Identity 0.1.2 has no disable/delete command. Observe its actual public
    // getUser lookup, then remove only that genuine row via the public Store.
    // No guessed key, codec, replacement user or invented inactive status.
    const removal: { perform?: () => Promise<boolean> } = {};
    const observed: Store = {
      collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
        const target = backing.collection(definition);
        if (definition.name !== 'pegma_identity_users') return target;
        return new Proxy(target, {
          get(collection, property) {
            if (property === 'get')
              return async (key: EntityKey) => {
                const value = await collection.get(key);
                if (value !== null) {
                  const captured = { partition: key.partition, id: key.id };
                  removal.perform = () => collection.delete(captured);
                }
                return value;
              };
            const value = Reflect.get(collection, property, collection);
            return typeof value === 'function' ? value.bind(collection) : value;
          },
        });
      },
    };
    const identity = createStageIdentity(observed, systemClock);
    expect(await identity.getUser(stageIds.owner)).toMatchObject({
      principalId: stageIds.owner,
      status: 'active',
      emailVerified: true,
    });
    const remove = removal.perform;
    if (remove === undefined)
      throw new Error('No SDK user lookup was observed.');
    expect(await remove()).toBe(true);
    expect(await identity.getUser(stageIds.owner)).toBeNull();
    await expect(identity.claimsFor(stageIds.owner)).rejects.toMatchObject({
      code: 'not_found',
    });
  } else {
    const knowledge = createStageKnowledge(backing, systemClock, () =>
      stageScenarioCurrent(scenario, systemClock),
    );
    const access = await currentAccess(stageIds.administrator);
    const draft = await knowledge.getDraft(access, {
      articleId: stageIds.article,
    });
    expect(
      await knowledge.retireArticle(access, {
        articleId: stageIds.article,
        commandId: 'fictional-stage-retire-' + scenario.scenarioId,
        correlationId: 'fictional-stage-source-withdrawal',
        expectedGeneration: draft.generation,
      }),
    ).toMatchObject({ value: { state: 'retired' }, replayed: false });
  }
}

async function persistedAnswers() {
  const rows = await store().collection(supportRecords).list(stageIds.ticket);
  return rows.filter(
    (row) => row.kind === 'message' && row.message.authorKind === 'assistant',
  );
}

async function answers() {
  const currentStore = store();
  const identity = createStageIdentity(currentStore, systemClock);
  const principal = await createAgentPrincipalResolver({
    identity,
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
    roleStore: createRoleStore(currentStore, AUTHORIZATION_APPLICATION_ID),
  })(stageIds.owner);
  if (principal === null)
    throw new Error('Seeded verified owner became unavailable.');
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
    Object.assign(task.meta, {
      supportAssistantStageEntryProfiles: logs.observations,
    });
    const scenario = createSupportAssistantStageScenario(systemClock);
    await seedSupportAssistantStage(env.IDENTITY_DB, scenario);
    await expect(
      seedSupportAssistantStage(env.IDENTITY_DB, scenario),
    ).rejects.toThrow('empty isolated');
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
    expect(await usageLedger()).toBeNull();
    expect(await answers()).toEqual([]);
    expect(logs.last()).toMatchObject({
      outcome: 'prepared',
      disposition: 'retry',
      retrySeconds: firstDecision.delay,
      modelCalls: 0,
      reservationCalls: 0,
    });
    withinBudget(logs.last());
    if (
      prepared.nextAttemptAt === undefined ||
      firstDecision.delay === undefined
    )
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
    await expect(
      stageEntry.queue(second.batch, secondEnv.options),
    ).resolves.toBeUndefined();
    expect(await second.decision()).toMatchObject({
      acked: true,
      retried: false,
    });
    expect(await answers()).toHaveLength(1);
    expect((await job()).status).toBe('completed');
    const settledLedger = await assertPaidLedger();
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
    // Preview the same configured public SDK page as the real runtime. A
    // one-row preview has a different opaque cursor from the bounded 32-row page.
    // Terminal work, messages and receipts still count as physical rows.
    const scanObservations: unknown[] = [];
    Object.assign(task.meta, {
      supportAssistantStageDuplicateScans: scanObservations,
    });
    let acknowledged = false;
    for (
      let attempts = 3;
      attempts <= SUPPORT_ASSISTANT_WAKE_DELIVERIES;
      ++attempts
    ) {
      const before = await store()
        .collection(supportAssistantCheckpoints)
        .get({ partition: 'support-answering', id: 'scan' });
      if (before === null)
        throw new Error('Missing actual post-answer checkpoint.');
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
      const page = await previewApplication.scanAssistantTurnCandidates(
        scanAccess,
        {
          limit: SUPPORT_ASSISTANT_SCAN_LIMIT,
          ...(before.cursor === null ? {} : { cursor: before.cursor }),
        },
      );
      expect(page.candidates).toEqual([]);
      expect(page.pages).toBe(1);
      expect(page.physicalRows).toBeGreaterThanOrEqual(0);
      expect(page.physicalRows).toBeLessThanOrEqual(
        SUPPORT_ASSISTANT_SCAN_LIMIT,
      );
      const duplicate = delivery({ id: first.id, sentAt, attempts });
      const duplicateEnv = environment(scenario);
      await stageEntry.queue(duplicate.batch, duplicateEnv.options);
      const actual = await duplicate.decision();
      const after = await store()
        .collection(supportAssistantCheckpoints)
        .get({ partition: 'support-answering', id: 'scan' });
      expect(after).toMatchObject({
        generation: before.generation + 1,
        cursor: page.nextCursor,
      });
      // Keep the existing Queue policy: only its one-row filtered case retries,
      // and the same delivery cap still bounds all continuation attempts.
      const retry =
        page.physicalRows > 0 && attempts < SUPPORT_ASSISTANT_WAKE_DELIVERIES;
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
      expect(await usageLedger()).toEqual(settledLedger);
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
    Object.assign(task.meta, {
      supportAssistantStageEntryProfiles: logs.observations,
    });
    const scenario = createSupportAssistantStageScenario(systemClock);
    await seedSupportAssistantStage(env.IDENTITY_DB, scenario);
    const sentAt = systemClock.now();
    const first = delivery({ sentAt });
    first.retry.mockImplementationOnce(() => {
      throw new Error('Fictional broker interruption after SDK preparation.');
    });
    await expect(
      stageEntry.queue(first.batch, environment(scenario).options),
    ).rejects.toThrow('broker interruption');
    expect(first.acknowledge).not.toHaveBeenCalled();
    const prepared = await job();
    expect(prepared).toMatchObject({
      status: 'retry',
      preparedAttempts: [{ accounting: 'not_called' }],
    });
    expect(await usageLedger()).toBeNull();
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
    expect(await retry.decision()).toMatchObject({
      acked: true,
      retried: false,
    });
    expect(await answers()).toHaveLength(1);
    expect(logs.last()).toMatchObject({
      modelCalls: 1,
      reservationCalls: 1,
      disposition: 'ack',
    });
    await assertPaidLedger();
    withinBudget(logs.last());
    Object.assign(task.meta, {
      supportAssistantStageEntryProfiles: structuredClone(logs.observations),
    });
  });

  it.for(['role', 'principal', 'source'] as const)(
    'honors real %s withdrawal after durable preparation in a reconstructed delivery',
    async (kind, { task }) => {
      const logs = diagnostics();
      Object.assign(task.meta, {
        supportAssistantStageEntryProfiles: logs.observations,
      });
      const scenario = createSupportAssistantStageScenario(systemClock);
      await seedSupportAssistantStage(env.IDENTITY_DB, scenario);
      const sentAt = systemClock.now();
      const first = delivery({ sentAt });
      await stageEntry.queue(first.batch, environment(scenario).options);
      const decision = await first.decision();
      expect(decision).toMatchObject({ acked: false, retried: true });
      const prepared = await job();
      expect(prepared).toMatchObject({
        status: 'retry',
        preparedAttempts: [{ accounting: 'not_called' }],
      });
      expect(await usageLedger()).toBeNull();
      withinBudget(logs.last());
      await withdrawCustomer(kind, scenario);
      if (prepared.nextAttemptAt === undefined || decision.delay === undefined)
        throw new Error('Missing genuine prepared retry.');
      vi.setSystemTime(
        new Date(
          Math.max(
            Date.parse(prepared.nextAttemptAt),
            Date.now() + decision.delay * 1000,
          ),
        ),
      );
      const retry = delivery({ id: first.id, sentAt, attempts: 2 });
      const reconstructed = environment(scenario);
      await stageEntry.queue(retry.batch, reconstructed.options);
      expect(logs.last()).toMatchObject({
        modelCalls: 0,
        reservationCalls: 0,
        reconciliationCalls: 0,
      });
      expect(reconstructed.bindingReads()).toBe(1);
      withinBudget(logs.last());
      expect(await persistedAnswers()).toEqual([]);
      expect(await usageLedger()).toBeNull();
      expect((await job()).status).not.toBe('completed');
      const outcome = await retry.decision();
      expect(Number(outcome.acked) + Number(outcome.retried)).toBe(1);
    },
  );

  it('rechecks scenario expiry after an actual awaited D1 read before any model or usage call', async ({
    task,
  }) => {
    const logs = diagnostics();
    Object.assign(task.meta, {
      supportAssistantStageEntryProfiles: logs.observations,
    });
    const scenario = createSupportAssistantStageScenario(systemClock);
    await seedSupportAssistantStage(env.IDENTITY_DB, scenario);
    let completedReads = 0;
    const database = new Proxy(env.IDENTITY_DB, {
      get(backing, property) {
        if (property === 'batch')
          return async <T>(statements: D1PreparedStatement[]) => {
            const result = await backing.batch<T>(statements);
            if (++completedReads === 1)
              vi.setSystemTime(new Date(scenario.validUntil));
            return result;
          };
        const value = Reflect.get(backing, property, backing);
        return typeof value === 'function' ? value.bind(backing) : value;
      },
    });
    const current = delivery();
    const options = environment(scenario);
    await stageEntry.queue(current.batch, {
      ...options.options,
      ASSISTANT_STAGE_DB: database,
    });
    expect(completedReads).toBeGreaterThan(0);
    expect(logs.last()).toMatchObject({
      modelCalls: 0,
      reservationCalls: 0,
      reconciliationCalls: 0,
    });
    withinBudget(logs.last());
    expect(await persistedAnswers()).toEqual([]);
    expect(await usageLedger()).toBeNull();
    expect((await job()).preparedAttempts).toEqual([]);
    const result = await current.decision();
    expect(Number(result.acked) + Number(result.retried)).toBe(1);
  });

  it.each([
    { name: 'attempt zero', attempts: 0 },
    { name: 'attempt nine', attempts: 9 },
    { name: 'negative attempt', attempts: -1 },
    { name: 'fractional attempt', attempts: 1.5 },
    { name: 'NaN attempt', attempts: Number.NaN },
    { name: 'infinite attempt', attempts: Number.POSITIVE_INFINITY },
    { name: 'unsafe integer attempt', attempts: Number.MAX_SAFE_INTEGER + 1 },
    { name: 'future timestamp', age: -1 },
    { name: 'invalid timestamp', age: Number.NaN },
    {
      name: 'exact fifteen-minute expiry',
      age: SUPPORT_ASSISTANT_WAKE_AGE_MILLISECONDS,
    },
    {
      name: 'past fifteen-minute expiry',
      age: SUPPORT_ASSISTANT_WAKE_AGE_MILLISECONDS + 1,
    },
  ])('rejects $name before the D1 getter', async (input) => {
    const logs = diagnostics();
    const now = Date.now();
    vi.setSystemTime(new Date(now));
    const scenario = createSupportAssistantStageScenario(systemClock);
    let bindingReads = 0;
    const options: SupportAssistantIsolatedStageEnvironment = {
      PEGMA_SUPPORT_ASSISTANT_STAGE_TARGET: 'isolated-stage',
      PEGMA_SUPPORT_ASSISTANT_STAGE_ENABLED: 'true',
      PEGMA_SUPPORT_ASSISTANT_STAGE_SCENARIO_JSON: JSON.stringify(scenario),
      get ASSISTANT_STAGE_DB() {
        ++bindingReads;
        return env.IDENTITY_DB;
      },
    };
    const current = delivery({ attempts: input.attempts });
    // Pool messages retain native ack/retry state; only their documented
    // timestamp input is varied, including an actual Invalid Date.
    const batch =
      input.age !== undefined
        ? createMessageBatch(SUPPORT_ASSISTANT_STAGE_QUEUE, [
            {
              id: current.id,
              timestamp: new Date(now - input.age),
              attempts: 1,
              body: SUPPORT_ASSISTANT_WAKE_MARKER,
            },
          ])
        : current.batch;
    await stageEntry.queue(batch, options);
    const result = await getQueueResult(batch, createExecutionContext());
    expect(result.explicitAcks).toEqual([current.id]);
    expect(result.retryMessages).toEqual([]);
    expect(bindingReads).toBe(0);
    expect(logs.last()).toMatchObject({
      physicalQueries: 0,
      modelCalls: 0,
      reservationCalls: 0,
    });
  });

  it('admits a still-current wakeup but refuses a prepared retry crossing its message expiry', async ({
    task,
  }) => {
    const logs = diagnostics();
    Object.assign(task.meta, {
      supportAssistantStageEntryProfiles: logs.observations,
    });
    const scenario = createSupportAssistantStageScenario(systemClock);
    await seedSupportAssistantStage(env.IDENTITY_DB, scenario);
    const now = Date.now();
    vi.setSystemTime(new Date(now));
    const sentAt = new Date(
      now - SUPPORT_ASSISTANT_WAKE_AGE_MILLISECONDS + 1000,
    ).toISOString();
    const current = delivery({ sentAt });
    const options = environment(scenario);
    await stageEntry.queue(current.batch, options.options);
    expect(await current.decision()).toMatchObject({
      acked: true,
      retried: false,
    });
    const prepared = await job();
    expect(prepared).toMatchObject({
      status: 'retry',
      preparedAttempts: [{ accounting: 'not_called' }],
    });
    if (prepared.nextAttemptAt === undefined)
      throw new Error('Missing actual prepared due time.');
    expect(Date.parse(prepared.nextAttemptAt)).toBeGreaterThanOrEqual(
      Date.parse(sentAt) + SUPPORT_ASSISTANT_WAKE_AGE_MILLISECONDS,
    );
    expect(logs.last()).toMatchObject({
      outcome: 'prepared',
      modelCalls: 0,
      reservationCalls: 0,
    });
    withinBudget(logs.last());
    expect(options.bindingReads()).toBe(1);
    expect(await usageLedger()).toBeNull();
    expect(await persistedAnswers()).toEqual([]);
  });

  it.each([0, 2])(
    'bounds a physical batch of %i messages before the D1 getter',
    async (count) => {
      const logs = diagnostics();
      const scenario = createSupportAssistantStageScenario(systemClock);
      let bindingReads = 0;
      const options: SupportAssistantIsolatedStageEnvironment = {
        PEGMA_SUPPORT_ASSISTANT_STAGE_TARGET: 'isolated-stage',
        PEGMA_SUPPORT_ASSISTANT_STAGE_ENABLED: 'true',
        PEGMA_SUPPORT_ASSISTANT_STAGE_SCENARIO_JSON: JSON.stringify(scenario),
        get ASSISTANT_STAGE_DB() {
          ++bindingReads;
          return env.IDENTITY_DB;
        },
      };
      const batch = createMessageBatch(
        SUPPORT_ASSISTANT_STAGE_QUEUE,
        Array.from({ length: count }, (_, index) => ({
          id: 'fictional-batch-' + index,
          timestamp: new Date(),
          attempts: 1,
          body: SUPPORT_ASSISTANT_WAKE_MARKER,
        })),
      );
      if (count === 0) await stageEntry.queue(batch, options);
      else
        await expect(stageEntry.queue(batch, options)).rejects.toThrow(
          'Unexpected isolated stage queue',
        );
      const actual = await getQueueResult(batch, createExecutionContext());
      expect(actual.explicitAcks).toEqual([]);
      expect(actual.retryMessages).toEqual([]);
      expect(bindingReads).toBe(0);
      expect(logs.last()).toMatchObject({
        physicalQueries: 0,
        modelCalls: 0,
        reservationCalls: 0,
      });
    },
  );

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
            PEGMA_SUPPORT_ASSISTANT_STAGE_ENABLED:
              kind === 'disabled' ? 'false' : 'true',
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
      body:
        kind === 'wrong-marker'
          ? 'wrong-marker'
          : SUPPORT_ASSISTANT_WAKE_MARKER,
    });
    await stageEntry.queue(current.batch, options);
    expect(await current.decision()).toMatchObject({
      acked: true,
      retried: false,
    });
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

  it('delegates first/all/raw/run and counts native batches once, then blocks query 51 before its write', async () => {
    await env.IDENTITY_DB.prepare(
      'INSERT INTO STAGE_BUDGET_PROBE (id, value) VALUES (1, 0)',
    ).run();
    const measured = createSupportAssistantStageDatabase(env.IDENTITY_DB);
    const database = measured.database;
    expect(
      await database.prepare('SELECT 42 AS value').first<number>('value'),
    ).toBe(42);
    expect(
      (await database.prepare('SELECT 42 AS value').all()).results,
    ).toEqual([{ value: 42 }]);
    expect(await database.prepare('SELECT 42 AS value').raw()).toEqual([[42]]);
    const increment = () =>
      database.prepare(
        'UPDATE STAGE_BUDGET_PROBE SET value = value + 1 WHERE id = 1',
      );
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

  it('accepts 100 actual bound parameters and rejects 101 before binding or execution', async () => {
    const measured = createSupportAssistantStageDatabase(env.IDENTITY_DB);
    const query = (count: number) =>
      'SELECT ' +
      Array.from({ length: count }, (_, index) => '? AS p' + index).join(', ');
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
