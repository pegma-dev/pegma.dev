export interface SupportAssistantStageBudget {
  physicalQueries: number;
  statements: number;
  batches: number;
  maximumBatchStatements: number;
  maximumParameters: number;
  blockedQueries: number;
  blockedParameters: number;
}

/** One instance per queue handler invocation. Every execution reaches native D1. */
export function createSupportAssistantStageDatabase(backing: D1Database) {
  const profile: SupportAssistantStageBudget = {
    physicalQueries: 0,
    statements: 0,
    batches: 0,
    maximumBatchStatements: 0,
    maximumParameters: 0,
    blockedQueries: 0,
    blockedParameters: 0,
  };
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  function execute(statements = 1, batch = false) {
    if (profile.physicalQueries >= 50) {
      ++profile.blockedQueries;
      throw new Error('Synthetic stage rejected D1 query 51 before execution.');
    }
    ++profile.physicalQueries;
    profile.statements += statements;
    if (batch) {
      ++profile.batches;
      profile.maximumBatchStatements = Math.max(profile.maximumBatchStatements, statements);
    }
  }
  function wrap(original: D1PreparedStatement): D1PreparedStatement {
    const statement: D1PreparedStatement = {
      bind(...values: unknown[]) {
        profile.maximumParameters = Math.max(profile.maximumParameters, values.length);
        if (values.length > 100) {
          ++profile.blockedParameters;
          throw new Error('Synthetic stage rejected parameter 101 before binding.');
        }
        return wrap(original.bind(...values));
      },
      first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
        execute();
        return column === undefined ? original.first<T>() : original.first<T>(column);
      },
      run<T = Record<string, unknown>>() {
        execute();
        return original.run<T>();
      },
      all<T = Record<string, unknown>>() {
        execute();
        return original.all<T>();
      },
      raw: new Proxy(original.raw, {
        apply(target, _receiver, args) {
          execute();
          return Reflect.apply(target, original, args);
        },
      }),
    };
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
          throw new Error('Synthetic stage rejected an unmetered D1 statement.');
        return original;
      });
      execute(native.length, true);
      return backing.batch<T>(native);
    },
    exec() {
      throw new Error('Synthetic stage runtime cannot execute DDL.');
    },
    dump() {
      throw new Error('Synthetic stage runtime cannot export its database.');
    },
    withSession() {
      throw new Error('Synthetic stage requires the direct D1 binding.');
    },
  };
  return { database, snapshot: () => ({ ...profile }) };
}
