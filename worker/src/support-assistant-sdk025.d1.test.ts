/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { AsyncLocalStorage } from 'node:async_hooks';
import { env } from 'cloudflare:workers';
import { createCloudflareD1Store } from '@pegma/storage-cloudflare-d1';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type AssistantBackend, type AssistantDiagnosticStage } from './support-assistant-fixtures';
import { registerStagedSupportAssistantCases } from './support-assistant-staged-cases';

declare global {
  namespace Cloudflare {
    interface Env {
      IDENTITY_DB: D1Database;
    }
  }
}

const schema = [
  'CREATE TABLE IF NOT EXISTS RECORDS (partition_key TEXT NOT NULL, row_key TEXT NOT NULL, record_json TEXT, version INTEGER NOT NULL, deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)), PRIMARY KEY (partition_key, row_key)) STRICT',
  'CREATE TABLE IF NOT EXISTS PEGMA_STORAGE_D1_TX_GUARD (reason TEXT NOT NULL) STRICT',
  ...(['exists', 'missing', 'changed'] as const).map(
    (reason) =>
      `CREATE TRIGGER IF NOT EXISTS PEGMA_STORAGE_D1_TX_ABORT_${reason.toUpperCase()} BEFORE INSERT ON PEGMA_STORAGE_D1_TX_GUARD WHEN NEW.reason = '${reason}' BEGIN SELECT RAISE(ABORT, 'PEGMA_STORAGE_D1_TX_${reason.toUpperCase()}'); END`,
  ),
];
interface InvocationProfile {
  physicalQueries: number;
  statements: number;
  batches: number;
  maximumParameters: number;
  maximumBatchStatements: number;
  blockedQueries: number;
  trace?: {
    stage: AssistantDiagnosticStage | 'runTick';
    method: 'enter' | 'first' | 'run' | 'all' | 'raw' | 'batch';
    physicalQueries: number;
    blocked?: true;
  }[];
  traceTruncated?: true;
}
const profiles: InvocationProfile[] = [];
beforeAll(async () => {
  for (const statement of schema)
    await env.IDENTITY_DB.prepare(statement).run();
});
beforeEach(async () => {
  profiles.length = 0;
  await env.IDENTITY_DB.prepare('DELETE FROM RECORDS').run();
  await env.IDENTITY_DB.prepare('DELETE FROM PEGMA_STORAGE_D1_TX_GUARD').run();
});
afterEach(({ task }) => {
  // Root may retain these actual counts on success or failure, without adding
  // filesystem capabilities or customer/ticket identifiers to the Worker.
  Object.assign(task.meta, {
    supportAssistantQueryBudget: {
      schemaVersion: 1,
      profiles: structuredClone(profiles),
    },
  });
});

/** Delegates every real execution to the genuine D1 binding. A batch is one
 * invocation query; parameter limits apply independently to each statement.
 * https://developers.cloudflare.com/d1/platform/limits/ */
function measuredDatabase(backing: D1Database, diagnostic = false) {
  const current = new AsyncLocalStorage<{
    profile: InvocationProfile;
    stage: AssistantDiagnosticStage | 'runTick';
  }>();
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  function trace(
    method: NonNullable<InvocationProfile['trace']>[number]['method'],
    blocked = false,
  ) {
    const active = current.getStore();
    if (active === undefined || active.profile.trace === undefined) return;
    if (active.profile.trace.length >= 512) {
      active.profile.traceTruncated = true;
      return;
    }
    active.profile.trace.push({
      stage: active.stage,
      method,
      physicalQueries: active.profile.physicalQueries,
      ...(blocked ? { blocked: true as const } : {}),
    });
  }
  function execute(
    method: 'first' | 'run' | 'all' | 'raw' | 'batch',
    statements = 1,
    batch = false,
  ) {
    const active = current.getStore();
    if (active === undefined) return;
    const { profile } = active;
    if (profile.physicalQueries >= 50) {
      ++profile.blockedQueries;
      trace(method, true);
      throw new Error(
        'Fictional invocation rejected query51 before execution.',
      );
    }
    ++profile.physicalQueries;
    trace(method);
    profile.statements += statements;
    if (batch) {
      ++profile.batches;
      profile.maximumBatchStatements = Math.max(
        profile.maximumBatchStatements,
        statements,
      );
    }
  }
  function wrap(original: D1PreparedStatement): D1PreparedStatement {
    const statement: D1PreparedStatement = {
      bind(...values: unknown[]) {
        if (values.length > 100)
          throw new Error(
            'Fictional invocation rejected parameter101 before binding.',
          );
        const active = current.getStore();
        if (active !== undefined)
          active.profile.maximumParameters = Math.max(
            active.profile.maximumParameters,
            values.length,
          );
        return wrap(original.bind(...values));
      },
      async first<T = Record<string, unknown>>(
        column?: string,
      ): Promise<T | null> {
        execute('first');
        return column === undefined
          ? original.first<T>()
          : original.first<T>(column);
      },
      run<T = Record<string, unknown>>() {
        execute('run');
        return original.run<T>();
      },
      all<T = Record<string, unknown>>() {
        execute('all');
        return original.all<T>();
      },
      raw: original.raw,
    };
    statement.raw = new Proxy(original.raw, {
      apply(target, _receiver, args) {
        execute('raw');
        return Reflect.apply(target, original, args);
      },
    });
    originals.set(statement, original);
    return statement;
  }
  const database: D1Database = {
    prepare(query) {
      return wrap(backing.prepare(query));
    },
    batch<T = unknown>(statements: D1PreparedStatement[]) {
      const native = statements.map((statement) => {
        const original = originals.get(statement);
        if (original === undefined)
          throw new Error('Unobserved native D1 statement.');
        return original;
      });
      execute('batch', native.length, true);
      return backing.batch<T>(native);
    },
    exec() {
      throw new Error('Unexpected exec inside the measured application.');
    },
    dump() {
      throw new Error('Unexpected dump inside the measured application.');
    },
    withSession() {
      throw new Error('The real adapter must use the direct D1 binding.');
    },
  };
  function measure<T>(operation: () => Promise<T>) {
    const profile: InvocationProfile = {
      physicalQueries: 0,
      statements: 0,
      batches: 0,
      maximumParameters: 0,
      maximumBatchStatements: 0,
      blockedQueries: 0,
      ...(diagnostic ? { trace: [] } : {}),
    };
    profiles.push(profile);
    return {
      profile,
      result: current.run({ profile, stage: 'runTick' }, operation),
    };
  }
  function stage<T>(name: AssistantDiagnosticStage, operation: () => Promise<T>) {
    const active = current.getStore();
    if (active === undefined) return operation();
    return current.run({ profile: active.profile, stage: name }, () => {
      trace('enter');
      return operation();
    });
  }
  return { database, measure, stage };
}

function backend(diagnostic = false): AssistantBackend {
  const meter = measuredDatabase(env.IDENTITY_DB, diagnostic);
  const freshStore = () =>
    createCloudflareD1Store({
      database: meter.database,
      createSchemaIfMissing: false,
      readBatchSize: 512,
    });
  return {
    store: freshStore(),
    freshStore,
    ...(diagnostic ? { stage: meter.stage } : {}),
    async invoke<T>(operation: () => Promise<T>): Promise<T> {
      const { profile, result } = meter.measure(operation);
      try {
        return await result;
      } finally {
        if (diagnostic)
          console.info(
            'support-assistant-query-budget',
            JSON.stringify(profile),
          );
        expect(profile.blockedQueries).toBe(0);
        expect(profile.physicalQueries).toBeLessThanOrEqual(50);
        expect(profile.maximumParameters).toBeLessThanOrEqual(100);
      }
    },
  };
}

describe('SDK025 native meter contract', () => {
  it('characterizes the native guard: one batch is one query and a 51st call is rejected before execution', async () => {
    const meter = measuredDatabase(env.IDENTITY_DB);
    const operation = meter.measure(async () => {
      const results = await meter.database.batch([
        meter.database.prepare('SELECT ? AS value').bind(1),
        meter.database.prepare('SELECT ? AS value').bind(2),
      ]);
      expect(results).toHaveLength(2);
      for (let read = 0; read < 49; ++read)
        expect(
          await meter.database.prepare('SELECT 1 AS value').first('value'),
        ).toBe(1);
      await expect(
        meter.database.prepare('SELECT 1 AS value').first(),
      ).rejects.toThrow('query51');
      expect(() =>
        meter.database
          .prepare('SELECT ? AS value')
          .bind(...Array.from({ length: 101 }, () => 1)),
      ).toThrow('parameter101');
    });
    await operation.result;
    expect(operation.profile).toMatchObject({
      physicalQueries: 50,
      statements: 51,
      batches: 1,
      maximumBatchStatements: 2,
      maximumParameters: 1,
      blockedQueries: 1,
    });
  });
});

registerStagedSupportAssistantCases(
  'SDK025 real Native D1 through the selected published adapter',
  async () => backend(true),
);
