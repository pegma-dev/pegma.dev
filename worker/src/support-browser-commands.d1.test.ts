/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { AsyncLocalStorage } from 'node:async_hooks';
import { env } from 'cloudflare:workers';
import {
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { createCloudflareD1Store } from '@pegma/storage-cloudflare-d1';
import { supportRecords } from '@pegma/support-desk-application';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import worker from './index';
import { isPlainObject } from './api-auth';
import { IDENTITY_ISSUER } from './identity-api';
import {
  humanControlFixture,
  humanPrivateNote,
  humanSecret,
  type HumanActor,
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
const profiles: Budget[][] = [];

beforeAll(async () => {
  expect(String(env.IDENTITY_EMAIL_ENABLED)).toBe('false');
  // Use the actual published adapter to provision its test schema. This read
  // writes no Support row and is outside every measured HTTP invocation.
  const schema = createCloudflareD1Store({ database: env.IDENTITY_DB });
  await schema
    .collection(supportRecords)
    .get({ partition: 'synthetic-schema-probe', id: 'absent' });
});
beforeEach(async () => {
  profiles.length = 0;
  // The same isolated Miniflare cleanup as the existing D1 fixture; no runtime
  // SQL or new persistence schema is introduced by the browser protocol.
  await env.IDENTITY_DB.prepare('DELETE FROM RECORDS').run();
  await env.IDENTITY_DB.prepare('DELETE FROM PEGMA_STORAGE_D1_TX_GUARD').run();
});
afterEach(({ task }) => {
  Object.assign(task.meta, {
    supportBrowserCommandD1Budget: structuredClone(profiles.flat()),
  });
});

/** Delegate all persistence while counting actual D1 binding executions. */
function meter(backing: D1Database) {
  const scope = new AsyncLocalStorage<Budget>();
  const budgets: Budget[] = [];
  profiles.push(budgets);
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const parameters = new WeakMap<D1PreparedStatement, number>();
  let afterWorkerBatch: (() => Promise<void>) | undefined;
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
  function observed(
    original: D1PreparedStatement,
    count = 0,
  ): D1PreparedStatement {
    const statement: D1PreparedStatement = {
      bind(...values: unknown[]) {
        return observed(original.bind(...values), values.length);
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
      raw: original.raw,
    };
    statement.raw = new Proxy(original.raw, {
      apply(target, _receiver, args) {
        charge([statement]);
        return Reflect.apply(target, original, args);
      },
    });
    originals.set(statement, original);
    parameters.set(statement, count);
    return statement;
  }
  const database: D1Database = {
    prepare(query) {
      return observed(backing.prepare(query));
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      charge(statements);
      const current = scope.getStore();
      if (current !== undefined) current.batches += 1;
      const native = statements.map((statement) => {
        const original = originals.get(statement);
        if (original === undefined)
          throw new Error('Expected an actual observed D1 statement.');
        return original;
      });
      const result = await backing.batch<T>(native);
      if (
        current?.operation.startsWith('worker.') &&
        result.every((item) => item.success)
      )
        await afterWorkerBatch?.();
      return result;
    },
    exec() {
      throw new Error('Runtime schema work is not allowed in this profile.');
    },
    dump() {
      throw new Error('Runtime D1 dump is not allowed.');
    },
    withSession() {
      throw new Error('Production uses the actual direct D1 binding.');
    },
  };
  function run<T>(operation: string, action: () => Promise<T>) {
    const budget: Budget = {
      operation,
      calls: 0,
      statements: 0,
      batches: 0,
      maximumParameters: 0,
      blocked: 0,
    };
    budgets.push(budget);
    return scope.run(budget, action);
  }
  return {
    database,
    budgets,
    async invoke(request: Request) {
      return run(
        'worker.' + request.method + ' ' + new URL(request.url).pathname,
        async () => {
          // This is the actual production entry point. Each request constructs
          // fresh Identity, roles, Sessions and Support services over the binding.
          const context = createExecutionContext();
          const configuration: Parameters<typeof worker.fetch>[1] = {
            ...env,
            IDENTITY_DB: database,
            IDENTITY_EMAIL_CODE_SECRET_BASE64: humanSecret,
            DATADOG_API_KEY: undefined,
          };
          // Override the generated deployment literal for disabled-path coverage.
          Object.defineProperty(configuration, 'PEGMA_KNOWLEDGE_ENABLED', {
            value: 'false',
            writable: true,
            enumerable: true,
            configurable: true,
          });
          const response = await worker.fetch(
            request,
            configuration,
            context,
          );
          await waitOnExecutionContext(context);
          await response.clone().arrayBuffer();
          const budget = scope.getStore();
          if (budget !== undefined) budget.status = response.status;
          return response;
        },
      );
    },
    peer<T>(operation: string, action: () => Promise<T>) {
      return scope.exit(() => run('peer.' + operation, action));
    },
    afterBatch(hook: typeof afterWorkerBatch) {
      afterWorkerBatch = hook;
    },
    assert() {
      for (const budget of budgets) {
        expect(budget.calls).toBeGreaterThan(0);
        expect(budget.calls).toBeLessThanOrEqual(50);
        expect(budget.maximumParameters).toBeLessThanOrEqual(100);
        expect(budget.blocked).toBe(0);
      }
    },
  };
}

async function fixture() {
  const measured = meter(env.IDENTITY_DB);
  const store = createCloudflareD1Store({
    database: measured.database,
    createSchemaIfMissing: false,
  });
  const f = await humanControlFixture(store, (request) =>
    measured.invoke(request),
  );
  return { f, measured };
}
type Fixture = Awaited<ReturnType<typeof fixture>>['f'];
function command(f: Fixture, actor: HumanActor) {
  const expectedAccountId = f.principals[actor];
  return {
    version: 1,
    expectedAccountId,
    commandId: expectedAccountId + '~' + crypto.randomUUID(),
    messageId: expectedAccountId + '~' + crypto.randomUUID(),
    ticketId: crypto.randomUUID(),
  };
}
function request(
  f: Fixture,
  path: string,
  actor: HumanActor,
  body: unknown,
  method = 'POST',
) {
  return new Request(IDENTITY_ISSUER + path, {
    method,
    headers: {
      Cookie: f.cookies.get(actor)!,
      Origin: IDENTITY_ISSUER,
      'Sec-Fetch-Site': 'same-origin',
      'Content-Type': 'application/json',
      'X-Pegma-CSRF': f.csrf.get(actor)!,
      'x-pegma-support-command': '1',
    },
    body: JSON.stringify(body),
  });
}
async function value(response: Response) {
  const result: unknown = await response.json();
  if (!isPlainObject(result)) throw new Error('Expected actual JSON object.');
  return result;
}

async function changeEmail(f: Fixture) {
  let deliveredCode: string | undefined;
  const worker = f.identity.createMailWorker({
    workerId: 'synthetic-native-contact-change',
    provider: {
      async send() {
        return { providerMessageRef: 'synthetic-native-email-code' };
      },
    },
    reconciliation: {
      async reconcile() {
        return { status: 'unknown' };
      },
    },
    renderer: {
      async render(content) {
        if (content.purpose === 'email_change') deliveredCode = content.code;
        return { subject: 'Synthetic contact change', text: 'Fixture only.' };
      },
    },
  });
  const started = await f.identity.beginEmailChange(
    f.principals.owner,
    'changed-owner@example.test',
    'synthetic-native-email-change',
  );
  const sent = await worker.runSendPage({ limit: 100 });
  expect(sent.results).toHaveLength(1);
  expect(sent.results[0]).toMatchObject({ status: 'accepted' });
  if (deliveredCode === undefined)
    throw new Error('The real Identity mail renderer did not expose a code.');
  expect(
    await f.identity.finishEmailChange({
      principalId: f.principals.owner,
      codeHandle: started.codeHandle,
      code: deliveredCode,
      rateLimitKey: 'synthetic-native-email-change',
    }),
  ).toMatchObject({
    principalId: f.principals.owner,
    email: 'changed-owner@example.test',
    status: 'active',
    emailVerified: true,
  });
}

describe('whole cold-worker V1 browser commands under real D1 50/100 guards', () => {
  it('executes create, both replies, notes and every PATCH action plus exact receipt retries without duplicate effects', async () => {
    const { f, measured } = await fixture();
    const ids = command(f, 'owner');
    const create = {
      command: { ...ids, expectedRequesterEmail: 'owner@example.test' },
      subject: 'Fictional D1 browser retry',
      body: 'Synthetic initial message.',
      category: 'question',
    };
    try {
      const created = await f.api(
        request(f, '/api/support/tickets', 'owner', create),
      );
      expect(created.status).toBe(201);
      expect(await value(created)).toMatchObject({
        ticket: { id: ids.ticketId },
        messages: [{ id: ids.messageId }],
      });
      const saved = await f.rows(ids.ticketId);
      expect(
        (await f.api(request(f, '/api/support/tickets', 'owner', create)))
          .status,
      ).toBe(201);
      expect(await f.rows(ids.ticketId)).toEqual(saved);
      for (const operation of ['reply', 'staff-reply', 'note'] as const) {
        const actor = operation === 'reply' ? 'owner' : 'operator';
        const next = command(f, actor);
        const body = {
          command: {
            version: 1,
            expectedAccountId: next.expectedAccountId,
            commandId: next.commandId,
            messageId: next.messageId,
          },
          body:
            operation === 'note' ? humanPrivateNote : 'Synthetic public reply.',
        };
        const path =
          operation === 'reply'
            ? '/api/support/tickets/' + ids.ticketId + '/replies'
            : '/api/support/admin/tickets/' +
              ids.ticketId +
              (operation === 'note' ? '/notes' : '/messages');
        expect((await f.api(request(f, path, actor, body))).status).toBe(201);
        const rows = await f.rows(ids.ticketId);
        expect((await f.api(request(f, path, actor, body))).status).toBe(201);
        expect(await f.rows(ids.ticketId)).toEqual(rows);
        const conflict = await f.api(
          request(f, path, actor, { ...body, body: 'Changed semantic input.' }),
        );
        expect(conflict.status).toBe(409);
        expect(Object.keys(await value(conflict))).toEqual(['error']);
        expect(await f.rows(ids.ticketId)).toEqual(rows);
      }
      for (const action of [
        'assign',
        'unassign',
        'change_priority',
        'resolve',
        'close',
        'reopen',
      ] as const) {
        const next = command(f, 'operator');
        const body = {
          command: {
            version: 1,
            expectedAccountId: next.expectedAccountId,
            commandId: next.commandId,
          },
          action,
          ...(action === 'change_priority' ? { priority: 'high' } : {}),
        };
        const path = '/api/support/admin/tickets/' + ids.ticketId;
        expect(
          (await f.api(request(f, path, 'operator', body, 'PATCH'))).status,
        ).toBe(200);
        const rows = await f.rows(ids.ticketId);
        expect(
          (await f.api(request(f, path, 'operator', body, 'PATCH'))).status,
        ).toBe(200);
        expect(await f.rows(ids.ticketId)).toEqual(rows);
      }
      const customer = await f.api(
        new Request(IDENTITY_ISSUER + '/api/support/tickets/' + ids.ticketId, {
          headers: { Cookie: f.cookies.get('owner')! },
        }),
      );
      expect(customer.status).toBe(200);
      expect(JSON.stringify(await value(customer))).not.toContain(
        humanPrivateNote,
      );
      expect(
        measured.budgets.filter((budget) =>
          budget.operation.startsWith('worker.'),
        ),
      ).toHaveLength(24);
    } finally {
      measured.assert();
    }
  });

  it('withholds the real committed note ACK after audited Support revocation, then replays that exact receipt with no second write', async () => {
    const { f, measured } = await fixture();
    const ticketId = await f.createTicket();
    const ids = command(f, 'operator');
    const body = {
      command: {
        version: 1,
        expectedAccountId: ids.expectedAccountId,
        commandId: ids.commandId,
        messageId: ids.messageId,
      },
      body: humanPrivateNote,
    };
    const path = '/api/support/admin/tickets/' + ticketId + '/notes';
    let observedCommit = false;
    let withdrawal: Promise<unknown> | undefined;
    measured.afterBatch(async () => {
      if (withdrawal !== undefined) {
        await withdrawal;
        return;
      }
      // Observe the actual public SDK receipt, not a brittle batch ordinal or
      // a copied record encoder. Each competing observation has its own meter.
      const rows = await measured.peer('observe-actual-receipt', () =>
        f.rows(ticketId),
      );
      if (
        withdrawal === undefined &&
        rows.some(
          (row) => row.kind === 'command' && row.commandId === ids.commandId,
        )
      ) {
        observedCommit = true;
        withdrawal = measured.peer('revoke-current-Support', () =>
          f.revokeSupport(),
        );
      }
      if (withdrawal !== undefined) {
        await withdrawal;
        measured.afterBatch(undefined);
      }
    });
    try {
      const response = await f.api(request(f, path, 'operator', body));
      expect(observedCommit).toBe(true);
      expect(response.status).toBe(403);
      expect(Object.keys(await value(response))).toEqual(['error']);
      const committed = await f.rows(ticketId);
      expect(
        committed.filter(
          (row) => row.kind === 'message' && row.message.id === ids.messageId,
        ),
      ).toHaveLength(1);
      expect(
        committed.filter(
          (row) => row.kind === 'command' && row.commandId === ids.commandId,
        ),
      ).toHaveLength(1);
      await measured.peer('restore-current-Support', () => f.restoreSupport());
      const retry = await f.api(request(f, path, 'operator', body));
      expect(retry.status).toBe(201);
      expect(await f.rows(ticketId)).toEqual(committed);
    } finally {
      measured.afterBatch(undefined);
      measured.assert();
    }
  });

  it('profiles fresh create contact and high-history owned receipt recovery after real Identity email change without exceeding 50 calls or 100 parameters', async () => {
    const { f, measured } = await fixture();
    const ids = command(f, 'owner');
    const body = {
      command: { ...ids, expectedRequesterEmail: 'owner@example.test' },
      subject: 'Fictional high-history contact recovery',
      body: 'One actual initial customer message.',
      category: 'question',
    };
    try {
      const accepted = await f.api(
        request(f, '/api/support/tickets', 'owner', body),
      );
      expect(accepted.status).toBe(201);
      // Deliberately discard the committed ACK. All history is produced by the
      // real SDK below, outside the measured cold HTTP invocation scopes.
      const staff = await f.staffAccess();
      for (let i = 0; i < 64; i++) {
        await f.runtime.application.addNote(staff, {
          commandId: crypto.randomUUID(),
          correlationId: crypto.randomUUID(),
          ticketId: ids.ticketId,
          messageId: crypto.randomUUID(),
          body: humanPrivateNote + ':synthetic-history-' + i,
        });
      }
      await changeEmail(f);
      const rows = await f.rows(ids.ticketId);
      expect(rows.filter((row) => row.kind === 'message')).toHaveLength(65);
      const replay = await f.api(
        request(f, '/api/support/tickets', 'owner', body),
      );
      expect(replay.status).toBe(201);
      expect(await value(replay)).toMatchObject({
        ticket: { id: ids.ticketId },
        messages: [{ id: ids.messageId, body: body.body }],
      });
      expect(await f.rows(ids.ticketId)).toEqual(rows);
      const conflict = await f.api(
        request(f, '/api/support/tickets', 'owner', {
          ...body,
          command: {
            ...body.command,
            expectedRequesterEmail: 'wrong-old@example.test',
          },
        }),
      );
      expect(conflict.status).toBe(409);
      expect(Object.keys(await value(conflict))).toEqual(['error']);
      expect(await f.rows(ids.ticketId)).toEqual(rows);
      const original = await f.runtime.application.readStaffTicket(
        await f.staffAccess(),
        ids.ticketId,
      );
      expect(original.ticket.requester.email).toBe('owner@example.test');
      const next = command(f, 'owner');
      const current = await f.api(
        request(f, '/api/support/tickets', 'owner', {
          ...body,
          command: {
            ...next,
            expectedRequesterEmail: 'changed-owner@example.test',
          },
        }),
      );
      expect(current.status).toBe(201);
      const created = await f.runtime.application.readStaffTicket(
        await f.staffAccess(),
        next.ticketId,
      );
      expect(created.ticket.requester.email).toBe('changed-owner@example.test');
      expect(
        measured.budgets.filter((budget) =>
          budget.operation.startsWith('worker.'),
        ),
      ).toHaveLength(4);
    } finally {
      measured.assert();
    }
  });
});
