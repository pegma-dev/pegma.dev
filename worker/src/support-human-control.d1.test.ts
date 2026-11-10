import { AsyncLocalStorage } from 'node:async_hooks';
import { env } from 'cloudflare:workers';
import { createCloudflareD1Store } from '@pegma/storage-cloudflare-d1';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker from './index';
import {
  controlledHumanBody,
  humanControlFixture,
  humanLatch,
  humanPrivateSummary,
  humanSecret,
} from './support-human-control-fixtures';

interface Budget {
  readonly operation: string;
  calls: number;
  statements: number;
  batches: number;
  maximumParameters: number;
  blocked: number;
  status?: number;
}
const completed: Budget[][] = [];
const schema = [
  'CREATE TABLE IF NOT EXISTS RECORDS (partition_key TEXT NOT NULL, row_key TEXT NOT NULL, record_json TEXT, version INTEGER NOT NULL, deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)), PRIMARY KEY (partition_key, row_key)) STRICT',
  'CREATE TABLE IF NOT EXISTS PEGMA_STORAGE_D1_TX_GUARD (reason TEXT NOT NULL) STRICT',
  ...(['exists', 'missing', 'changed'] as const).map(
    (reason) =>
      `CREATE TRIGGER IF NOT EXISTS PEGMA_STORAGE_D1_TX_ABORT_${reason.toUpperCase()} BEFORE INSERT ON PEGMA_STORAGE_D1_TX_GUARD WHEN NEW.reason = '${reason}' BEGIN SELECT RAISE(ABORT, 'PEGMA_STORAGE_D1_TX_${reason.toUpperCase()}'); END`,
  ),
];
beforeAll(async () => {
  // The real Miniflare binding is disabled by vitest.d1.config.ts. Keep the
  // deployment's generated literal Env types intact instead of overriding them.
  expect(String(env.IDENTITY_EMAIL_ENABLED)).toBe('false');
  for (const statement of schema)
    await env.IDENTITY_DB.prepare(statement).run();
});
beforeEach(async () => {
  completed.length = 0;
  await env.IDENTITY_DB.prepare('DELETE FROM RECORDS').run();
  await env.IDENTITY_DB.prepare('DELETE FROM PEGMA_STORAGE_D1_TX_GUARD').run();
});
afterEach(({ task }) => {
  Object.assign(task.meta, {
    supportHumanD1Budget: structuredClone(completed.flat()),
  });
});

/** Count real binding executions, including every fresh worker-created Store.
 * D1 batch is one invocation call; every constituent statement retains its
 * actual bind count. No SQL/result/Store decision is replaced. */
function bindingMeter(backing: D1Database) {
  const scope = new AsyncLocalStorage<Budget>();
  const requests: Budget[] = [];
  completed.push(requests);
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const parameters = new WeakMap<D1PreparedStatement, number>();
  let afterNextBatch: (() => Promise<void>) | undefined;
  function charge(statements: readonly D1PreparedStatement[]) {
    const current = scope.getStore();
    if (current === undefined) return;
    current.calls += 1;
    current.statements += statements.length;
    current.maximumParameters = Math.max(
      current.maximumParameters,
      ...statements.map((statement) => parameters.get(statement) ?? 0),
    );
    if (current.calls > 50 || current.maximumParameters > 100) {
      current.blocked += 1;
      throw new Error(
        'Synthetic Workers Free binding guard refused execution.',
      );
    }
  }
  function wrap(original: D1PreparedStatement, count = 0): D1PreparedStatement {
    const result: D1PreparedStatement = {
      bind(...values: unknown[]) {
        return wrap(original.bind(...values), values.length);
      },
      first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
        charge([result]);
        return column === undefined
          ? original.first<T>()
          : original.first<T>(column);
      },
      run<T = Record<string, unknown>>() {
        charge([result]);
        return original.run<T>();
      },
      all<T = Record<string, unknown>>() {
        charge([result]);
        return original.all<T>();
      },
      raw: original.raw,
    };
    result.raw = new Proxy(original.raw, {
      apply(target, _receiver, args) {
        charge([result]);
        return Reflect.apply(target, original, args);
      },
    });
    originals.set(result, original);
    parameters.set(result, count);
    return result;
  }
  const database: D1Database = {
    prepare(query) {
      return wrap(backing.prepare(query));
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      charge(statements);
      const current = scope.getStore();
      if (current !== undefined) current.batches += 1;
      const result = await backing.batch<T>(
        statements.map((statement) => originals.get(statement) ?? statement),
      );
      if (
        scope.getStore()?.operation.startsWith('worker.') &&
        result.every((item) => item.success)
      ) {
        const hook = afterNextBatch;
        afterNextBatch = undefined;
        await hook?.();
      }
      return result;
    },
    exec() {
      throw new Error('Unexpected runtime D1 exec; schema exists.');
    },
    dump() {
      throw new Error('Unexpected runtime D1 dump.');
    },
    withSession() {
      throw new Error('Production Support uses the direct D1 binding.');
    },
  };
  async function run<T>(operation: string, action: () => Promise<T>) {
    const budget: Budget = {
      operation,
      calls: 0,
      statements: 0,
      batches: 0,
      maximumParameters: 0,
      blocked: 0,
    };
    requests.push(budget);
    return scope.run(budget, action);
  }
  return {
    database,
    requests,
    async invoke(
      request: Request,
      extra: Partial<Parameters<typeof worker.fetch>[1]> = {},
    ) {
      return run('worker.' + new URL(request.url).pathname, async () => {
        const pending: Promise<unknown>[] = [];
        const configuration: Parameters<typeof worker.fetch>[1] = {
          ...env,
          IDENTITY_DB: database,
          IDENTITY_EMAIL_CODE_SECRET_BASE64: humanSecret,
          PEGMA_KNOWLEDGE_ENABLED: 'false',
          DATADOG_API_KEY: undefined,
          ...extra,
        };
        // Every call traverses the real worker.fetch and reconstructs its actual
        // Identity/Support/session/role services. Setup cannot supply warm ones.
        const response = await worker.fetch(request, configuration, {
          waitUntil(promise) {
            pending.push(promise);
          },
          passThroughOnException() {},
          props: {},
          exports: {},
        } as ExecutionContext);
        await Promise.all(pending);
        await response.clone().arrayBuffer();
        const budget = scope.getStore();
        if (budget !== undefined) budget.status = response.status;
        return response;
      });
    },
    peer<T>(operation: string, action: () => Promise<T>) {
      // Another invocation's actual role/session write, separately measured.
      return scope.exit(() => run('peer.' + operation, action));
    },
    pauseNextBatch() {
      const entered = humanLatch();
      const resume = humanLatch();
      afterNextBatch = async () => {
        entered.release();
        await resume.ready;
      };
      return {
        release: resume.release,
        async waitFor(pending: Promise<unknown>) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              entered.ready,
              pending.then(() => {
                throw new Error(
                  'Worker returned before the real batch barrier.',
                );
              }),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                  () =>
                    reject(new Error('No actual batch reached the barrier.')),
                  3000,
                );
              }),
            ]);
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
        },
      };
    },
    assert() {
      console.log(
        'support-human-d1-request-budgets',
        JSON.stringify(requests),
      );
      for (const budget of requests) {
        expect(budget.calls).toBeLessThanOrEqual(50);
        expect(budget.maximumParameters).toBeLessThanOrEqual(100);
        expect(budget.blocked).toBe(0);
      }
    },
  };
}

async function fixture() {
  const meter = bindingMeter(env.IDENTITY_DB);
  // Same production Support options: D1046's default readBatchSize1, existing
  // schema and canonical Core040. No alias, override, adapter or SDK fork.
  const store = createCloudflareD1Store({
    database: meter.database,
    createSchemaIfMissing: false,
  });
  const f = await humanControlFixture(store, (request) =>
    meter.invoke(request),
  );
  return { f, meter };
}

describe('full cold-worker human controls within the actual D1 invocation guard', () => {
  it.each([0, 80])(
    'executes all three routes and exact replays with %i real private notes in history',
    async (notes) => {
      const { f, meter } = await fixture();
      const ticket = await f.createTicket(true, notes);
      const person = { commandId: crypto.randomUUID() };
      try {
        expect(
          (await f.api(f.request('request-person', ticket, 'owner', person)))
            .status,
        ).toBe(200);
        const committed = await f.rows(ticket);
        expect(
          committed.filter((row) => row.kind === 'handoff_work'),
        ).toHaveLength(1);
        expect(
          (await f.api(f.request('request-person', ticket, 'owner', person)))
            .status,
        ).toBe(200);
        expect(await f.rows(ticket)).toEqual(committed);
        const takeover = await f.packet(ticket);
        expect(
          (await f.api(f.request('take-over', ticket, 'operator', takeover)))
            .status,
        ).toBe(200);
        const after = await f.rows(ticket);
        expect(
          (await f.api(f.request('take-over', ticket, 'operator', takeover)))
            .status,
        ).toBe(200);
        expect(await f.rows(ticket)).toEqual(after);
        const handoff = await f.api(f.request('handoff', ticket, 'operator'));
        expect(handoff.status).toBe(200);
        expect(await handoff.json()).toMatchObject({
          handoff: [{ ticketId: ticket }],
          csrfToken: f.csrf.get('operator'),
        });
        expect(
          meter.requests.filter((budget) =>
            budget.operation.startsWith('worker.'),
          ),
        ).toHaveLength(5);
        expect(meter.requests.every((budget) => budget.calls > 0)).toBe(true);
        if (notes === 80)
          expect(after.filter((row) => row.kind === 'message')).toHaveLength(
            81,
          );
      } finally {
        meter.assert();
      }
    },
  );

  it('reads real private escalation content only for Support while Admin/Knowledge stay isolated', async () => {
    const { f, meter } = await fixture();
    const ticket = await f.createTicket(true);
    await f.privateEscalation(ticket);
    try {
      const response = await f.api(f.request('handoff', ticket, 'operator'));
      expect(response.status).toBe(200);
      expect(JSON.stringify(await response.json())).toContain(
        humanPrivateSummary,
      );
      for (const actor of [
        'owner',
        'administrator',
        'knowledge',
        'both',
      ] as const) {
        const denied = await f.api(f.request('handoff', ticket, actor));
        expect(denied.status).toBe(403);
        expect(JSON.stringify(await denied.json())).not.toContain(
          humanPrivateSummary,
        );
      }
    } finally {
      meter.assert();
    }
  });

  it.each(['session', 'role', 'identity'] as const)(
    'observes real %s revocation during body input before SDK mutation',
    async (kind) => {
      const { f, meter } = await fixture();
      const ticket = await f.createTicket(true);
      const actor = kind === 'role' ? 'operator' : 'owner';
      const route = kind === 'role' ? 'take-over' : 'request-person';
      const packet =
        kind === 'role'
          ? await f.packet(ticket)
          : { commandId: crypto.randomUUID() };
      const body = await controlledHumanBody(
        f.request(route, ticket, actor, packet),
      );
      const before = await f.rows(ticket);
      const pending = f.api(body.request);
      try {
        await body.waitFor(pending);
        await meter.peer(kind, async () => {
          if (kind === 'role') await f.revokeSupport();
          else if (kind === 'session') await f.revokeSession(actor);
          else await f.removeIdentity(actor);
        });
      } finally {
        body.complete();
      }
      try {
        expect((await pending).status).toBe(kind === 'role' ? 403 : 401);
        expect(await f.rows(ticket)).toEqual(before);
        expect(
          meter.requests.some(
            (budget) =>
              budget.operation.startsWith('peer.') && budget.calls > 0,
          ),
        ).toBe(true);
      } finally {
        meter.assert();
      }
    },
  );

  it('converges two genuine simultaneous stale takeovers without a duplicate state transition', async () => {
    const { f, meter } = await fixture();
    const ticket = await f.createTicket();
    const first = await f.packet(ticket);
    const second = { ...first, commandId: crypto.randomUUID() };
    try {
      const responses = await Promise.all([
        f.api(f.request('take-over', ticket, 'operator', first)),
        f.api(f.request('take-over', ticket, 'operator', second)),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([
        200, 409,
      ]);
      const rows = await f.rows(ticket);
      expect(
        rows.filter(
          (row) =>
            row.kind === 'command' &&
            (row.commandId === first.commandId ||
              row.commandId === second.commandId),
        ),
      ).toHaveLength(1);
      expect(rows.find((row) => row.kind === 'ticket')).toMatchObject({
        ticket: { handling: { state: 'human-active', generation: 1 } },
      });
    } finally {
      meter.assert();
    }
  });

  it('withholds a late ACK after a real committed batch, then replays the exact packet under restored Support authority', async () => {
    const { f, meter } = await fixture();
    const ticket = await f.createTicket();
    const packet = await f.packet(ticket);
    const blocked = meter.pauseNextBatch();
    const pending = f.api(f.request('take-over', ticket, 'operator', packet));
    try {
      await blocked.waitFor(pending);
      // The hook names no SQL/key layout. Independently observe the actual
      // committed ticket AND receipt before revoking the real role.
      await meter.peer('commit-observation-and-revoke', async () => {
        const rows = await f.rows(ticket);
        expect(rows.find((row) => row.kind === 'ticket')).toMatchObject({
          ticket: { handling: { state: 'human-active', generation: 1 } },
        });
        expect(
          rows.some(
            (row) =>
              row.kind === 'command' && row.commandId === packet.commandId,
          ),
        ).toBe(true);
        await f.revokeSupport();
      });
    } finally {
      blocked.release();
    }
    try {
      expect((await pending).status).toBe(403);
      const committed = await f.rows(ticket);
      await meter.peer('restore-support', async () => {
        await f.restoreSupport();
      });
      expect(
        (await f.api(f.request('take-over', ticket, 'operator', packet)))
          .status,
      ).toBe(200);
      expect(await f.rows(ticket)).toEqual(committed);
    } finally {
      meter.assert();
    }
  });

  it('includes the actual durable quota debit and denial in complete cold worker invocations', async () => {
    const { f, meter } = await fixture();
    const ticket = await f.createTicket();
    // Preparation uses the real production limiter/store outside the measured
    // requests. The two actual worker requests execute its 30th debit and denial.
    for (let attempt = 0; attempt < 29; attempt += 1)
      expect(
        (await f.runtime.replyLimiter.allow(f.principals.operator)).allowed,
      ).toBe(true);
    try {
      expect(
        (
          await f.api(
            f.request('take-over', ticket, 'operator', await f.packet(ticket)),
          )
        ).status,
      ).toBe(200);
      const pendingTicket = await f.createTicket();
      const packet = await f.packet(pendingTicket);
      const before = await f.rows(pendingTicket);
      const denied = await f.api(
        f.request('take-over', pendingTicket, 'operator', packet),
      );
      expect(denied.status).toBe(429);
      expect(Number(denied.headers.get('Retry-After'))).toBeGreaterThan(0);
      expect(await f.rows(pendingTicket)).toEqual(before);
      expect(
        meter.requests.filter((budget) =>
          budget.operation.startsWith('worker.'),
        ),
      ).toHaveLength(2);
    } finally {
      meter.assert();
    }
  });

  it('does not reseed configured bootstrap after a real role revocation during body input', async () => {
    const { f, meter } = await fixture();
    const ticket = await f.createTicket();
    const body = await controlledHumanBody(
      f.request('take-over', ticket, 'owner', await f.packet(ticket)),
    );
    const before = await f.rows(ticket);
    const pending = meter.invoke(body.request, {
      PEGMA_SUPPORT_BOOTSTRAP_PRINCIPALS: f.principals.owner,
    });
    try {
      await body.waitFor(pending);
      await meter.peer('revoke-just-bootstrapped-support', async () => {
        const assignments = await f.runtime.roleStore.listActiveRoleAssignments(
          f.principals.owner,
          { kind: 'application' },
        );
        const assignment = assignments.find((row) => row.role === 'Support');
        if (assignment === undefined)
          throw new Error('No genuine bootstrap assignment.');
        const observed = await f.runtime.roleStore.getRoleAssignment(
          assignment.id,
        );
        if (observed === null)
          throw new Error('Actual bootstrap assignment disappeared.');
        await f.runtime.roleStore.revokeRoleAssignmentWithAudit({
          assignmentId: observed.assignment.id,
          expectedConcurrencyToken: observed.concurrencyToken,
          revokedBy: {
            kind: 'principal',
            principalId: f.principals.administrator,
          },
          revokedAtEpochMs: Date.now(),
          auditEventId: crypto.randomUUID(),
        });
      });
    } finally {
      body.complete();
    }
    try {
      expect((await pending).status).toBe(403);
      expect(await f.rows(ticket)).toEqual(before);
      expect(
        await f.runtime.roleStore.listActiveRoleAssignments(
          f.principals.owner,
          { kind: 'application' },
        ),
      ).toEqual([]);
    } finally {
      meter.assert();
    }
  });

  it('includes the actual configured one-time bootstrap in the invocation budget', async () => {
    const { f, meter } = await fixture();
    const ticket = await f.createTicket();
    try {
      const response = await meter.invoke(
        f.request('take-over', ticket, 'owner', await f.packet(ticket)),
        {
          PEGMA_SUPPORT_BOOTSTRAP_PRINCIPALS: f.principals.owner,
        },
      );
      expect(response.status).toBe(200);
      expect(
        await f.runtime.roleStore.listActiveRoleAssignments(
          f.principals.owner,
          { kind: 'application' },
        ),
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ role: 'Support' })]),
      );
    } finally {
      meter.assert();
    }
  });
});
