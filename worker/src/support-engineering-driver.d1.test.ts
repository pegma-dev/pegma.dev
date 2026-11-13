/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { AsyncLocalStorage } from 'node:async_hooks';
import { env } from 'cloudflare:workers';
import { createCloudflareD1Store } from '@pegma/storage-cloudflare-d1';
import { supportRecords } from '@pegma/support-desk-application';
import { afterEach, beforeAll, beforeEach, expect } from 'vitest';
import { registerEngineeringDriverCases } from './support-engineering-driver-fixtures';

interface Profile {
  calls: number;
  executed: number;
  statements: number;
  batches: number;
  maximumParameters: number;
  blocked: number;
  phase?: string;
  sdkOutcome?: string;
  physicalRows?: number;
  remainingTargets?: number;
}
const profiles: Profile[] = [];
beforeAll(async () => {
  await createCloudflareD1Store({ database: env.IDENTITY_DB })
    .collection(supportRecords)
    .get({ partition: 'engineering-driver-schema', id: 'absent' });
});
beforeEach(async () => {
  profiles.length = 0;
  await env.IDENTITY_DB.prepare('DELETE FROM RECORDS').run();
  await env.IDENTITY_DB.prepare('DELETE FROM PEGMA_STORAGE_D1_TX_GUARD').run();
});
afterEach(({ task }) => {
  Object.assign(task.meta, { engineeringDriverD1: structuredClone(profiles) });
  console.info('engineering-driver-d1', JSON.stringify(profiles));
});

/** Only observes/limits genuine binding calls; no SQL/result/Store decision is
 * replaced. Every driver cursor/CAS, current authority, SDK phase and actual
 * durable-usage operation is inside the same physical-invocation scope.
 */
function metered(database: D1Database) {
  const scope = new AsyncLocalStorage<Profile>();
  const actuals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const sizes = new WeakMap<D1PreparedStatement, number>();
  function charge(statements: readonly D1PreparedStatement[]) {
    const profile = scope.getStore();
    if (!profile) return;
    profile.calls++;
    profile.statements += statements.length;
    profile.maximumParameters = Math.max(
      profile.maximumParameters,
      ...statements.map((statement) => sizes.get(statement) ?? 0),
    );
    if (profile.calls > 50 || profile.maximumParameters > 100) {
      profile.blocked++;
      throw new Error(
        'Actual driver invocation exceeded the 50/100 binding guard',
      );
    }
    profile.executed++;
  }
  function observed(
    actual: D1PreparedStatement,
    size = 0,
  ): D1PreparedStatement {
    const statement: D1PreparedStatement = {
      bind(...values: unknown[]) {
        return observed(actual.bind(...values), values.length);
      },
      first<Value = Record<string, unknown>>(
        column?: string,
      ): Promise<Value | null> {
        charge([statement]);
        return column === undefined
          ? actual.first<Value>()
          : actual.first<Value>(column);
      },
      all<Value = Record<string, unknown>>() {
        charge([statement]);
        return actual.all<Value>();
      },
      run<Value = Record<string, unknown>>() {
        charge([statement]);
        return actual.run<Value>();
      },
      raw: actual.raw,
    };
    statement.raw = new Proxy(actual.raw, {
      apply(fn, _receiver, args) {
        charge([statement]);
        return Reflect.apply(fn, actual, args);
      },
    });
    actuals.set(statement, actual);
    sizes.set(statement, size);
    return statement;
  }
  const binding: D1Database = {
    prepare(query) {
      return observed(database.prepare(query));
    },
    batch<Value = unknown>(statements: D1PreparedStatement[]) {
      charge(statements);
      const profile = scope.getStore();
      if (profile) profile.batches++;
      return database.batch<Value>(
        statements.map((statement) => {
          const actual = actuals.get(statement);
          if (!actual) throw new Error('Expected genuine metered statement');
          return actual;
        }),
      );
    },
    exec() {
      throw new Error('Schema work is not a runtime driver operation');
    },
    dump() {
      throw new Error('Database dump is not a runtime driver operation');
    },
    withSession() {
      throw new Error('This actual adapter uses the direct binding');
    },
  };
  return {
    database: binding,
    async invoke<Value>(action: () => Promise<Value>): Promise<Value> {
      const profile: Profile = {
        calls: 0,
        executed: 0,
        statements: 0,
        batches: 0,
        maximumParameters: 0,
        blocked: 0,
      };
      profiles.push(profile);
      return scope.run(profile, async () => {
        try {
          const result = await action();
          if (typeof result === 'object' && result !== null) {
            const phase: unknown = Reflect.get(result, 'outcome');
            if (typeof phase === 'string') profile.phase = phase;
            const physicalRows: unknown = Reflect.get(result, 'physicalRows');
            if (typeof physicalRows === 'number')
              profile.physicalRows = physicalRows;
            const remaining: unknown = Reflect.get(result, 'remainingTargets');
            if (typeof remaining === 'number')
              profile.remainingTargets = remaining;
            const inner: unknown = Reflect.get(result, 'result');
            if (typeof inner === 'object' && inner !== null) {
              const outcome: unknown = Reflect.get(inner, 'outcome');
              if (typeof outcome === 'string') profile.sdkOutcome = outcome;
            }
          }
          return result;
        } finally {
          const detail = JSON.stringify(profile);
          expect(profile.calls, detail).toBeLessThanOrEqual(50);
          expect(profile.executed, detail).toBe(profile.calls);
          expect(profile.maximumParameters, detail).toBeLessThanOrEqual(100);
          expect(profile.blocked, detail).toBe(0);
        }
      });
    },
  };
}

registerEngineeringDriverCases('actual Native D1', async () => {
  const meter = metered(env.IDENTITY_DB);
  return {
    store: createCloudflareD1Store({
      database: meter.database,
      createSchemaIfMissing: false,
      readBatchSize: 512,
    }),
    invoke: meter.invoke,
  };
});
