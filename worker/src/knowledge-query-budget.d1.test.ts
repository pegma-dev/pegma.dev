import { AsyncLocalStorage } from 'node:async_hooks';
import { env } from 'cloudflare:workers';
import type {
  ApprovalView,
  PublicClient,
  TokenResult,
} from '@pegma/agent-access';
import { identityLinkKeyFromVerifiedIdentityClaims } from '@pegma/authorization-identity';
import { createRoleStore } from '@pegma/authorization-storage';
import { articleKinds } from '@pegma/knowledge-base-contracts';
import type {
  ArticleDraft,
  EvidenceSubmission,
} from '@pegma/knowledge-base-core';
import {
  createKnowledgeBaseApplication,
  knowledgeRecords,
  type KnowledgeRecord,
  type DraftArticleDto,
} from '@pegma/knowledge-base-application';
import {
  knowledgeAgentScopes,
  knowledgeAgentToolNames,
  type KnowledgeAgentOperation,
} from '@pegma/knowledge-base-mcp';
import { createSessionStore } from '@pegma/sessions';
import { createDurableLimiter } from '@pegma/rate-limit-paged';
import { createCloudflareD1Store } from '@pegma/storage-cloudflare-d1';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAgentPrincipalResolver } from './agent-authority';
import {
  AGENT_RESOURCE,
  createAgentAccessRuntime,
} from './agent-access-runtime';
import { isPlainObject } from './api-auth';
import { IDENTITY_ISSUER, SESSION_COOKIE } from './identity-api';
import { createIdentityRuntime } from './identity-runtime';
import { handleKnowledgeRequest } from './knowledge-host';
import worker from './index';
import { createKnowledgeRetrievalReady } from './knowledge-retrieval-ready';
import { runKnowledgeMaintenance } from './knowledge-maintenance';
import {
  defineCollection,
  type CollectionDefinition,
  type CollectionStore,
  type Store,
  type StoredRecord,
} from '@pegma/storage-core';
import {
  CLEANUP_CRON,
  RATE_LIMIT_CRON,
  cleanupLaneAt,
  rateKnowledgeLaneAt,
} from './maintenance-schedule';
import type { KnowledgeReportView } from './knowledge-evidence';
import {
  ADMIN_ROLE,
  APPLICATION_SCOPE,
  AUTHORIZATION_APPLICATION_ID,
  KNOWLEDGE_ROLE,
} from './support-access';

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

beforeAll(async () => {
  for (const statement of schema)
    await env.IDENTITY_DB.prepare(statement).run();
});
beforeEach(async () => {
  completedBudgets.length = 0;
  profileFacts = {};
  await env.IDENTITY_DB.prepare('DELETE FROM RECORDS').run();
  await env.IDENTITY_DB.prepare('DELETE FROM PEGMA_STORAGE_D1_TX_GUARD').run();
});

interface RequestBudget {
  readonly operation: string;
  calls: number;
  statements: number;
  batches: number;
  batchSizes: number[];
  status?: number;
  maximumCalls?: 50;
  blockedExecutions?: number;
}

const completedBudgets: RequestBudget[][] = [];
let profileFacts: Record<string, number | string | boolean> = {};
// Root's private reporter reads TestCase.meta().knowledgeQueryBudget on both
// success and failure. No filesystem capability is added to the Worker.
afterEach(({ task }) => {
  Object.assign(task.meta, {
    knowledgeQueryBudget: {
      schemaVersion: 1,
      requests: structuredClone(completedBudgets.flat()),
      facts: { ...profileFacts },
    },
  });
});

/** Count actual binding executions, not Store calls or prepared statements.
 * Cloudflare documents one batch as one invocation-budget query:
 * https://developers.cloudflare.com/d1/platform/limits/#batch-limits
 */
function measuredDatabase(backing: D1Database) {
  const scope = new AsyncLocalStorage<RequestBudget>();
  const requests: RequestBudget[] = [];
  let failScheduledBatch = false;
  let afterScheduledKnowledgeBatch: (() => Promise<void>) | undefined;
  let beforeScheduledCheckpointWrite:
    ((version: string) => Promise<void>) | undefined;
  const scheduledCheckpointWrites: { version: string; written: boolean }[] = [];
  completedBudgets.push(requests);
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const bindings = new WeakMap<D1PreparedStatement, readonly unknown[]>();
  function execution(statements = 1, batch = false) {
    const budget = scope.getStore();
    if (budget === undefined) return;
    budget.calls += 1;
    if (
      budget.maximumCalls !== undefined &&
      budget.calls > budget.maximumCalls
    ) {
      budget.blockedExecutions = (budget.blockedExecutions ?? 0) + 1;
      throw new Error(
        'Synthetic invocation D1 limit reached before execution51.',
      );
    }
    budget.statements += statements;
    if (batch) {
      budget.batches += 1;
      budget.batchSizes.push(statements);
    }
  }
  function wrap(
    original: D1PreparedStatement,
    boundValues: readonly unknown[] = [],
  ): D1PreparedStatement {
    const statement: D1PreparedStatement = {
      bind(...values: unknown[]) {
        return wrap(original.bind(...values), values);
      },
      async first<T = Record<string, unknown>>(
        column?: string,
      ): Promise<T | null> {
        execution();
        // Observe the actual conditional call's public bookmark key/version.
        // Do not inspect or replace its SQL, result, or OCC decision.
        const checkpoint =
          beforeScheduledCheckpointWrite !== undefined &&
          scope.getStore()?.operation.startsWith('scheduled.') === true &&
          boundValues.length === 4 &&
          boundValues.includes('pegma-dev-maintenance:knowledge') &&
          boundValues.includes('rate-limits');
        const version = checkpoint ? boundValues[3] : undefined;
        if (checkpoint && typeof version !== 'string')
          throw new Error('Expected the actual checkpoint concurrency token.');
        if (typeof version === 'string')
          await beforeScheduledCheckpointWrite?.(version);
        const result =
          column === undefined
            ? await original.first<T>()
            : await original.first<T>(column);
        if (typeof version === 'string')
          scheduledCheckpointWrites.push({ version, written: result !== null });
        return result;
      },
      run<T = Record<string, unknown>>() {
        execution();
        return original.run<T>();
      },
      all<T = Record<string, unknown>>() {
        execution();
        return original.all<T>();
      },
      raw: original.raw,
    };
    // Preserve the public raw overloads and the real statement receiver.
    statement.raw = new Proxy(original.raw, {
      apply(target, _receiver, args) {
        execution();
        return Reflect.apply(target, original, args);
      },
    });
    originals.set(statement, original);
    bindings.set(statement, boundValues);
    return statement;
  }
  const database: D1Database = {
    prepare(query) {
      return wrap(backing.prepare(query));
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      const native = statements.map((statement) => {
        const original = originals.get(statement);
        if (original === undefined)
          throw new Error('Unobserved D1 batch statement.');
        return original;
      });
      execution(native.length, true);
      const scheduled =
        scope.getStore()?.operation.startsWith('scheduled.') === true;
      if (scheduled && failScheduledBatch) {
        failScheduledBatch = false;
        throw new Error('Synthetic D1 transport failure.');
      }
      const result = await backing.batch<T>(native);
      // The public SDK record namespace identifies its real keyed read wave.
      // Do not pause checkpoint.get (also batched with readBatchSize512),
      // inspect private SQL, or assume a particular batch ordinal.
      const knowledgeWave = statements.some((statement) =>
        bindings
          .get(statement)
          ?.some(
            (value) =>
              typeof value === 'string' &&
              value.includes(knowledgeRecords.name),
          ),
      );
      const after =
        scheduled && knowledgeWave ? afterScheduledKnowledgeBatch : undefined;
      if (after !== undefined) {
        afterScheduledKnowledgeBatch = undefined;
        await after();
      }
      return result;
    },
    exec() {
      throw new Error('Unexpected D1 exec in a measured application request.');
    },
    dump() {
      throw new Error('Unexpected D1 dump in a measured application request.');
    },
    withSession() {
      throw new Error('The production Store must use the direct D1 binding.');
    },
  };
  return {
    database,
    requests,
    scheduledCheckpointWrites,
    beforeScheduledCheckpointWrite(hook: (version: string) => Promise<void>) {
      beforeScheduledCheckpointWrite = hook;
    },
    currentOperation() {
      return scope.getStore()?.operation;
    },
    outsideRequest<T>(run: () => Promise<T>): Promise<T> {
      return scope.exit(run);
    },
    failNextScheduledBatch() {
      failScheduledBatch = true;
    },
    afterNextScheduledKnowledgeBatch(hook: () => Promise<void>) {
      afterScheduledKnowledgeBatch = hook;
    },
    async request(
      operation: string,
      run: () => Promise<Response>,
      hardLimit = false,
    ) {
      const budget: RequestBudget = {
        operation,
        calls: 0,
        statements: 0,
        batches: 0,
        batchSizes: [],
        ...(hardLimit ? { maximumCalls: 50 as const } : {}),
      };
      requests.push(budget);
      return scope.run(budget, async () => {
        const response = await run();
        // Include any work deferred until the HTTP/MCP response is consumed.
        await response.clone().arrayBuffer();
        budget.status = response.status;
        return response;
      });
    },
    assertFreeBudget() {
      console.info('knowledge-d1-request-budgets', JSON.stringify(requests));
      expect(requests.length).toBeGreaterThan(0);
      for (const budget of requests) {
        expect.soft(budget.calls, JSON.stringify(budget)).toBeGreaterThan(0);
        expect
          .soft(budget.calls, JSON.stringify(budget))
          .toBeLessThanOrEqual(50);
      }
    },
  };
}

// Read-only physical diagnostics, never a copied encoder or a fixture write.
const readyDiagnostics = defineCollection<StoredRecord>({
  name: 'pegma-dev.knowledge-retrieval-ready.v1',
  key: (value) => ({ partition: 'knowledge', id: String(value.id) }),
  codec: { encode: (value) => value, decode: (value) => value },
});

// The adversary rewrites only a real producer-created bookmark, unchanged.
// No synthetic head, generation, cursor, limiter codec or SQL write is created.
const rateCheckpointDiagnostics = defineCollection<StoredRecord>({
  name: 'pegma-dev-maintenance',
  key: (value) => ({
    partition: String(value.partition),
    id: String(value.id),
  }),
  codec: { encode: (value) => value, decode: (value) => value },
});

const owner = 'query-budget-owner';
const reviewer = 'query-budget-reviewer';
const collectionId = 'query-budget-guides';
const articleId = 'query-budget-article';
const scopes = Object.values(knowledgeAgentScopes);
const client: PublicClient = {
  clientId: 'synthetic-query-budget-client',
  name: 'Synthetic query budget client',
  redirectUris: ['https://client.example.test/callback'],
  allowedScopes: scopes,
  grantTypes: ['authorization_code'],
};
const draft: ArticleDraft = {
  kind: 'explanation',
  title: 'Synthetic measured guide',
  summary: 'A complete guide used only by local D1 tests.',
  content: {
    format: 'plain_text',
    text: 'Read the synthetic input and compare its output.',
  },
  tags: [],
  applicability: {
    productId: 'query-budget',
    productVersion: '1',
    buildId: 'query-budget-1',
  },
};
type Transport = 'http' | 'mcp';

function object(value: unknown): Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error('Expected a public JSON object.');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error('Expected a nonempty public string.');
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new Error('Expected an integer in the public result.');
  return value;
}

async function fixture(isolateSetupAdmission = false) {
  const meter = measuredDatabase(env.IDENTITY_DB);
  const store = createCloudflareD1Store({
    database: meter.database,
    createSchemaIfMissing: false,
  });
  const logger = { log() {} };
  const clock = { now: () => new Date().toISOString() };
  const secret = btoa('q'.repeat(32));
  const identity = createIdentityRuntime(
    {
      store,
      emailCodeSecretBase64: secret,
      emailFrom: 'Pegma <synthetic@example.test>',
      emailEnabled: false,
    },
    logger,
  ).identity;
  const sessions = createSessionStore(store, { logger, clock });
  const roleStore = createRoleStore(store, AUTHORIZATION_APPLICATION_ID);
  const cookies = new Map<string, string>();
  for (const [index, principalId] of [owner, reviewer].entries()) {
    await identity.provisionVerifiedUser({
      principalId,
      email: principalId + '@example.test',
    });
    const granted = await roleStore.grantRoleAssignmentWithAudit({
      assignment: {
        id: 'role-' + principalId,
        principalId,
        role: principalId === owner ? ADMIN_ROLE : KNOWLEDGE_ROLE,
        scope: APPLICATION_SCOPE,
        grantedBy: { kind: 'system', systemId: 'synthetic-query-budget-setup' },
        grantedAtEpochMs: Date.now(),
        status: 'active',
      },
      auditEventId: 'grant-' + principalId,
    });
    expect(granted.status).toBe('granted');
    const sessionId = String(index) + 'q'.repeat(42);
    await sessions.create(sessionId, {
      principalId,
      data: JSON.stringify({
        version: 1,
        csrfToken: 'c'.repeat(43),
        issuer: IDENTITY_ISSUER,
        subject: principalId,
      }),
    });
    cookies.set(principalId, SESSION_COOKIE + '=' + sessionId);
  }
  const configuration = {
    IDENTITY_DB: meter.database,
    IDENTITY_EMAIL_CODE_SECRET_BASE64: secret,
    IDENTITY_EMAIL_FROM: 'Pegma <synthetic@example.test>',
    IDENTITY_EMAIL_ENABLED: 'false',
    PEGMA_KNOWLEDGE_ENABLED: 'true',
    PEGMA_AGENT_CLIENTS_JSON: JSON.stringify([client]),
  };
  // The production entry composes fresh Identity/AA/KB/limiters on every call.
  let setupRequests = 0;
  const send = (request: Request, operation?: string) => {
    if (isolateSetupAdmission && operation === undefined) {
      // Synthetic independent peers, <=64 setup calls per peer: unchanged
      // production120/300 per-IP admission budgets still apply to every call.
      const peer = Math.floor(setupRequests++ / 64) + 1;
      request.headers.set('CF-Connecting-IP', '2001:db8::' + peer.toString(16));
      profileFacts.setupRequests = setupRequests;
    }
    const run = () => handleKnowledgeRequest(request, configuration, logger);
    return operation === undefined ? run() : meter.request(operation, run);
  };
  function browser(path: string, body?: unknown, principalId = reviewer) {
    const cookie = cookies.get(principalId);
    if (cookie === undefined)
      throw new Error('Expected the real browser session.');
    return new Request(IDENTITY_ISSUER + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Cookie: cookie,
        Origin: IDENTITY_ISSUER,
        'Sec-Fetch-Site': 'same-origin',
        'X-Pegma-CSRF': 'c'.repeat(43),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function staff(
    operation: string,
    input: unknown,
    measured = true,
    principalId = reviewer,
  ) {
    const response = await send(
      browser(
        '/api/staff/knowledge/command',
        { operation, input },
        principalId,
      ),
      measured ? 'staff.' + operation : undefined,
    );
    expect(response.status, operation).toBe(200);
    return object(await response.json());
  }
  const resolvePrincipal = createAgentPrincipalResolver({
    identity,
    roleStore,
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
  });
  const access = await resolvePrincipal(owner);
  if (access === null)
    throw new Error('Expected actual current setup authority.');
  const app = createKnowledgeBaseApplication({ store, clock });
  const collection = await app.createCollection(access, {
    commandId: 'setup-collection',
    correlationId: 'query-budget',
    expectedGeneration: 0,
    collectionId,
    name: 'Synthetic query budget guides',
  });
  await app.putValidationPolicy(access, {
    commandId: 'setup-policy',
    correlationId: 'query-budget',
    expectedGeneration: 0,
    policy: {
      id: 'query-budget-policy',
      version: 1,
      requirements: [
        ...articleKinds.map((kind) => ({
          id: kind + '-content',
          kind,
          testKind: 'content',
          maxAgeMilliseconds: 3_600_000,
          trustedRunnerIds: ['query-budget-runner'],
        })),
        {
          id: 'walkthrough-workflow',
          kind: 'walkthrough',
          testKind: 'workflow',
          maxAgeMilliseconds: 3_600_000,
          trustedRunnerIds: ['query-budget-runner'],
        },
      ],
    },
  });
  await app.putGovernanceConfiguration(access, {
    commandId: 'setup-governance',
    correlationId: 'query-budget',
    expectedGeneration: collection.value.generation,
    collectionId,
    configuration: {
      validationPolicy: { id: 'query-budget-policy', version: 1 },
      expectedStagingBuildId: 'query-budget-1',
      trustedAttesterIds: [reviewer],
    },
  });
  const verifier = 'v'.repeat(64);
  const challenge = btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(verifier),
        ),
      ),
    ),
  )
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
  const redirectUri = client.redirectUris[0];
  if (redirectUri === undefined)
    throw new Error('Expected the explicit synthetic callback.');
  const authorization = new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: redirectUri,
    resource: AGENT_RESOURCE,
    scope: scopes.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'synthetic-budget-state',
  });
  const begun = await send(
    browser('/api/agent-access/authorize?' + authorization, undefined, owner),
  );
  expect(begun.status).toBe(303);
  const requestId = new URL(
    text(begun.headers.get('Location')),
  ).searchParams.get('request_id');
  const viewed = await send(
    browser(
      '/api/agent-access/approval?request_id=' +
        encodeURIComponent(text(requestId)),
      undefined,
      owner,
    ),
  );
  expect(viewed.status).toBe(200);
  const approval: ApprovalView = await viewed.json();
  expect(approval.requestedScopes.map((scope) => scope.name)).toEqual(scopes);
  const approved = await send(
    browser(
      '/api/agent-access/approval',
      {
        requestId: approval.requestId,
        decision: 'approve',
        approvedScopes: scopes,
      },
      owner,
    ),
  );
  expect(approved.status).toBe(200);
  const consent = object(await approved.json());
  const redirect = new URL(text(consent.redirectUri));
  expect(redirect.origin + redirect.pathname).toBe(redirectUri);
  const exchanged = await send(
    new Request(IDENTITY_ISSUER + '/api/agent-access/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.clientId,
        redirect_uri: redirectUri,
        resource: AGENT_RESOURCE,
        code: text(redirect.searchParams.get('code')),
        code_verifier: verifier,
      }),
    }),
  );
  expect(exchanged.status).toBe(200);
  const token: TokenResult = await exchanged.json();
  expect(token.scope.split(' ')).toEqual(scopes);
  const inspection = createAgentAccessRuntime({
    store,
    clock,
    logger,
    identity,
    sessions,
    roleStore,
    clients: [client],
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
  });
  if (inspection === null)
    throw new Error('Expected the actual configured issuer.');
  const delegated = await inspection.service.authenticate({
    token: token.access_token,
    resource: AGENT_RESOURCE,
  });
  expect(delegated.access.permissions.slice().sort()).toEqual(
    scopes.slice().sort(),
  );
  expect(delegated.access.roles).toEqual([]);
  expect(delegated.access.entitlements).toEqual([]);
  function agentRequest(path: string, body?: unknown) {
    return new Request(IDENTITY_ISSUER + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: 'Bearer ' + token.access_token,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-06-18',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function agent(
    transport: Transport,
    operation: KnowledgeAgentOperation,
    input: unknown,
    label: string | false = operation,
    sourceIp?: string,
  ) {
    const wire =
      transport === 'http'
        ? { apiVersion: '1', operation, input }
        : {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: knowledgeAgentToolNames[operation],
              arguments: input,
            },
          };
    const request = agentRequest(
      transport === 'http' ? '/api/knowledge/v1' : '/api/knowledge/mcp',
      wire,
    );
    if (sourceIp !== undefined)
      request.headers.set('CF-Connecting-IP', sourceIp);
    const response = await send(
      request,
      label === false ? undefined : transport + '.' + label,
    );
    expect(response.status, operation).toBe(200);
    let logical = object(await response.json());
    if (transport === 'mcp') {
      const rpc = object(logical.result);
      expect(rpc.isError).toBe(false);
      if (!Array.isArray(rpc.content))
        throw new Error('Expected real MCP tool content.');
      const first = object(rpc.content[0]);
      logical = object(JSON.parse(text(first.text)));
    }
    expect(logical.operation).toBe(operation);
    return object(logical.result);
  }
  let scheduledTick = Math.floor(Date.now() / 60_000) * 60_000;
  let physicalTick = scheduledTick;
  async function scheduled(kind: 'ready' | 'physical' = 'ready') {
    let time = kind === 'ready' ? scheduledTick : physicalTick;
    if (kind === 'physical') {
      while (
        new Date(time).getUTCMinutes() === 59 ||
        cleanupLaneAt(time).kind !== 'knowledge'
      )
        time += 60_000;
      physicalTick = time + 60_000;
    } else {
      const eligible = Array.from(
        { length: 120 },
        (_, offset) => time + offset * 60_000,
      ).find(
        (candidate) =>
          new Date(candidate).getUTCMinutes() <= 57 &&
          rateKnowledgeLaneAt(candidate) === 'retrieval_ready',
      );
      if (eligible === undefined)
        throw new Error('No actual ready-lane tick in the bounded schedule.');
      time = eligible;
      scheduledTick = time + 60_000;
    }
    return meter.request(
      'scheduled.' + kind,
      async () => {
        const pending: Promise<unknown>[] = [];
        worker.scheduled(
          {
            cron: kind === 'ready' ? RATE_LIMIT_CRON : CLEANUP_CRON,
            scheduledTime: time,
            noRetry() {},
          },
          configuration as Parameters<typeof worker.scheduled>[1],
          {
            waitUntil(promise) {
              pending.push(promise);
            },
            passThroughOnException() {},
            props: {},
            exports: {},
          } as ExecutionContext,
        );
        expect(pending).toHaveLength(1);
        await Promise.all(pending);
        return Response.json({ completed: true });
      },
      true,
    );
  }
  return {
    meter,
    scheduled,
    logger,
    app,
    access,
    send,
    staff,
    agent,
    agentRequest,
    browser,
    clock,
    store,
  };
}

describe('real production KB request budgets over actual D1', () => {
  it('counts real execution methods once, a multi-statement batch once, and no prepare or bind calls', async () => {
    const meter = measuredDatabase(env.IDENTITY_DB);
    const statement = meter.database.prepare('SELECT ? AS value').bind(1);
    await meter.request('counter-calibration', async () => {
      expect(meter.requests[0]?.calls).toBe(0);
      await statement.first();
      await statement.all();
      await statement.run();
      await statement.raw();
      const first = meter.database.prepare('SELECT 2 AS value');
      const second = meter.database.prepare('SELECT 3 AS value');
      await meter.database.batch([first, second]);
      return Response.json({ complete: true });
    });
    expect(meter.requests).toEqual([
      {
        operation: 'counter-calibration',
        calls: 5,
        statements: 6,
        batches: 1,
        batchSizes: [2],
        status: 200,
      },
    ]);
  });

  it('throws before the51st real D1 execution, even if application code catches the quota error', async () => {
    const meter = measuredDatabase(env.IDENTITY_DB);
    await meter.request(
      'hard-limit-calibration',
      async () => {
        for (let index = 0; index < 50; index++)
          await meter.database.prepare('SELECT 1 AS value').first();
        let rejected = false;
        try {
          await meter.database.prepare('SELECT 51 AS value').first();
        } catch {
          rejected = true;
        }
        expect(rejected).toBe(true);
        return Response.json({ complete: true });
      },
      true,
    );
    expect(meter.requests[0]).toMatchObject({
      calls: 51,
      statements: 50,
      maximumCalls: 50,
      blockedExecutions: 1,
    });
  });

  it('keeps overlapping invocation counts separate across awaited real D1 calls', async () => {
    const meter = measuredDatabase(env.IDENTITY_DB);
    let entered = () => {};
    let resume = () => {};
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const first = meter.request('pending-request', async () => {
      await meter.database.prepare('SELECT 1').first();
      entered();
      await paused;
      await meter.database.prepare('SELECT 2').first();
      return Response.json({ complete: true });
    });
    await ready;
    try {
      await meter.request('overlapping-request', async () => {
        await meter.database.prepare('SELECT 3').all();
        return Response.json({ complete: true });
      });
    } finally {
      resume();
    }
    await first;
    expect(
      meter.requests.map(({ operation, calls }) => ({ operation, calls })),
    ).toEqual([
      { operation: 'pending-request', calls: 2 },
      { operation: 'overlapping-request', calls: 1 },
    ]);
  });

  it('sweeps twenty real expired rows within 48 calls after two independent bookmark CAS conflicts', async () => {
    const meter = measuredDatabase(env.IDENTITY_DB);
    const store = createCloudflareD1Store({
      database: meter.database,
      createSchemaIfMissing: false,
    });
    const clock = { now: () => new Date().toISOString() };
    // Setup is outside every measured invocation. The real producer creates
    // the bookmark before genuine peers can change only its opaque version.
    await runKnowledgeMaintenance({ store, clock }, { log() {} });
    const checkpoints = store.collection(rateCheckpointDiagnostics);
    const key = { partition: 'knowledge', id: 'rate-limits' };
    const initial = await checkpoints.getVersioned(key);
    if (initial === null)
      throw new Error('Missing producer-created checkpoint.');
    expect(initial.value.cursor).toBeNull();
    const limiter = createDurableLimiter(
      { name: 'pegma.test.actual-d1-occ', limit: 1, windowMs: 60_000 },
      store,
    );
    const expiredAt = new Date(Date.now() - 180_000).toISOString();
    for (let index = 0; index < 20; index++)
      expect(await limiter.allow('192.0.2.' + (index + 1), expiredAt)).toEqual({
        allowed: true,
      });
    const liveRows = () =>
      env.IDENTITY_DB.prepare(
        'SELECT COUNT(*) AS count FROM RECORDS WHERE deleted = 0',
      ).first<number>('count');
    // Exactly twenty real counters, their real descriptor, and the bookmark.
    const beforeRows = await liveRows();
    expect(beforeRows).toBe(22);
    const operation = 'scheduled.rate-limits.two-real-conflicts';
    let attempts = 0;
    let peerWrites = 0;
    const peerReadVersions: string[] = [];
    meter.beforeScheduledCheckpointWrite(async (version) => {
      attempts += 1;
      expect(meter.currentOperation()).toBe(operation);
      if (attempts > 2) return;
      const peerNumber = attempts;
      // These are other invocations, not free work inside the scheduled one.
      // Each uses the same real metered D1 binding under its own ALS budget.
      await meter.outsideRequest(async () => {
        expect(meter.currentOperation()).toBeUndefined();
        await meter.request(
          'external.bookmark-peer-' + peerNumber,
          async () => {
            expect(meter.currentOperation()).toBe(
              'external.bookmark-peer-' + peerNumber,
            );
            const current = await checkpoints.getVersioned(key);
            if (current === null)
              throw new Error('Missing actual peer target.');
            expect(current.value).toEqual(initial.value);
            expect(current.version).toBe(version);
            peerReadVersions.push(current.version);
            const written = await checkpoints.putIfUnchanged(
              current.value,
              current.version,
            );
            expect(written).toBe(true);
            peerWrites += 1;
            return Response.json({ written });
          },
          true,
        );
      });
      expect(meter.currentOperation()).toBe(operation);
    });
    const startMinute = Math.floor(Date.now() / 60_000) * 60_000;
    const scheduledTime = Array.from(
      { length: 120 },
      (_, offset) => startMinute + offset * 60_000,
    ).find(
      (time) =>
        new Date(time).getUTCMinutes() <= 57 &&
        rateKnowledgeLaneAt(time) === 'rate_limits',
    );
    if (scheduledTime === undefined)
      throw new Error('No real rate-lane tick in the bounded schedule.');
    try {
      await meter.request(
        operation,
        async () => {
          const pending: Promise<unknown>[] = [];
          const configuration: Parameters<typeof worker.scheduled>[1] = {
            ...env,
            IDENTITY_DB: meter.database,
            DATADOG_API_KEY: undefined,
            PEGMA_KNOWLEDGE_ENABLED: 'false',
            get IDENTITY_EMAIL_CODE_SECRET_BASE64(): string {
              throw new Error('Rate cleanup must not initialize Identity.');
            },
          };
          Object.defineProperty(configuration, 'PEGMA_AGENT_CLIENTS_JSON', {
            value: 'not-json',
          });
          worker.scheduled(
            { cron: RATE_LIMIT_CRON, scheduledTime, noRetry() {} },
            configuration,
            {
              waitUntil(promise) {
                pending.push(promise);
              },
              passThroughOnException() {},
              props: {},
              exports: {},
            } as ExecutionContext,
          );
          expect(pending).toHaveLength(1);
          await Promise.all(pending);
          return Response.json({ complete: true });
        },
        true,
      );
      expect(meter.currentOperation()).toBeUndefined();
      expect(attempts).toBe(3);
      expect(peerWrites).toBe(2);
      expect(
        meter.scheduledCheckpointWrites.map((entry) => entry.written),
      ).toEqual([false, false, true]);
      const attemptedVersions = meter.scheduledCheckpointWrites.map(
        (entry) => entry.version,
      );
      expect(new Set(attemptedVersions).size).toBe(3);
      expect(peerReadVersions).toEqual(attemptedVersions.slice(0, 2));
      const final = await checkpoints.getVersioned(key);
      expect(final?.value.generation).toBe(
        integer(initial.value.generation) + 1,
      );
      expect(final?.version).not.toBe(attemptedVersions[2]);
      const afterRows = await liveRows();
      expect(afterRows).toBe(2);
      const scheduled = meter.requests.find(
        (entry) => entry.operation === operation,
      );
      if (scheduled === undefined) throw new Error('Missing scheduled budget.');
      expect(scheduled.calls).toBeLessThanOrEqual(48);
      expect(scheduled.blockedExecutions ?? 0).toBe(0);
      const peers = meter.requests.filter((entry) =>
        entry.operation.startsWith('external.bookmark-peer-'),
      );
      expect(peers.map((entry) => entry.calls)).toEqual([2, 2]);
      profileFacts.rateRowsActuallyDeleted =
        integer(beforeRows) - integer(afterRows);
      profileFacts.rateBookmarkActualAttempts = attempts;
      profileFacts.rateBookmarkActualConflicts =
        meter.scheduledCheckpointWrites.filter(
          (entry) => !entry.written,
        ).length;
      profileFacts.rateScheduledActualD1Calls = scheduled.calls;
      profileFacts.rateIndependentPeerD1Calls = peers.reduce(
        (sum, entry) => sum + entry.calls,
        0,
      );
      profileFacts.ratePeersOutsideScheduledAls = true;
    } finally {
      meter.assertFreeBudget();
    }
  });

  it('rotates real pending hints after a D1 transport failure and preserves a newer enqueue during a scheduled completion', async () => {
    const f = await fixture();
    const ready = () =>
      createKnowledgeRetrievalReady({
        store: f.store,
        clock: f.clock,
        logger: f.logger,
        isEnabled: () => true,
      });
    const ids = ['pending-a', 'pending-b', 'pending-c'];
    for (const id of ids) {
      await f.app.createDraft(f.access, {
        commandId: 'create-' + id,
        correlationId: 'test',
        expectedGeneration: 0,
        collectionId,
        articleId: id,
        draft,
      });
      await ready().enqueue(id);
    }
    try {
      f.meter.failNextScheduledBatch();
      await f.scheduled();
      let complete = false;
      for (let tick = 0; tick < 48; tick++) {
        await f.scheduled();
        const statuses = await Promise.all(
          ids.map((id) =>
            f.app.getArticleIndexStatus(f.access, { articleId: id }),
          ),
        );
        if (statuses.every((status) => status.status === 'ready')) {
          complete = true;
          break;
        }
      }
      expect(complete).toBe(true);
      const hints = () =>
        f.store.collection(readyDiagnostics).scan({ limit: 100 });
      for (let tick = 0; tick < 16 && (await hints()).records.length; tick++)
        await f.scheduled();
      expect((await hints()).records).toEqual([]);
      await f.scheduled(); // Establish a persisted null cursor before reenqueuing.
      // A stable ready article needs no projection mutation; race the exact
      // queue version after the SDK's actual records wave, not the earlier
      // checkpoint or queue read. The worker has already captured its version.
      await ready().enqueue(ids[0]!);
      let entered = () => {};
      let resume = () => {};
      const paused = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const resumed = new Promise<void>((resolve) => {
        resume = resolve;
      });
      f.meter.afterNextScheduledKnowledgeBatch(async () => {
        profileFacts.readyRaceAfterKnowledgeWave = true;
        entered();
        await resumed;
      });
      const worker = f.scheduled();
      await paused;
      expect(profileFacts.readyRaceAfterKnowledgeWave).toBe(true);
      const before = (await hints()).records[0];
      try {
        await ready().enqueue(ids[0]!);
      } finally {
        resume();
      }
      const newer = (await hints()).records[0];
      expect(newer?.version).not.toBe(before?.version);
      await worker;
      expect((await hints()).records).toEqual([newer]);
      // The newer signal survives the old conditional deletion. Two cursor
      // cycles must really revisit it, rather than silently dropping its ACK.
      await f.scheduled();
      await f.scheduled();
      expect((await hints()).records).toEqual([]);
      expect(
        f.meter.requests.filter(
          (request) => request.operation === 'scheduled.ready',
        ).length,
      ).toBeGreaterThan(3);
    } finally {
      f.meter.assertFreeBudget();
    }
  });

  it('recovers a genuinely lost ready enqueue through the real physical scheduled lane', async () => {
    const f = await fixture();
    const id = 'lost-ready-hint';
    await f.app.createDraft(f.access, {
      commandId: 'create-lost-hint',
      correlationId: 'test',
      expectedGeneration: 0,
      collectionId,
      articleId: id,
      draft,
    });
    let failed = false;
    const faulty: Store = {
      collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
        const collection = f.store.collection(definition);
        return {
          ...collection,
          async put(value) {
            if (
              definition.name === 'pegma-dev.knowledge-retrieval-ready.v1' &&
              !failed
            ) {
              failed = true;
              throw new Error('Synthetic failed queue write.');
            }
            return collection.put(value);
          },
        };
      },
    };
    await createKnowledgeRetrievalReady({
      store: faulty,
      clock: f.clock,
      logger: f.logger,
      isEnabled: () => true,
    }).enqueue(id);
    expect(failed).toBe(true);
    try {
      let complete = false;
      for (let tick = 0; tick < 256; tick++) {
        await f.scheduled('physical');
        const status = await f.app.getArticleIndexStatus(f.access, {
          articleId: id,
        });
        if (status.status === 'ready') {
          complete = true;
          break;
        }
      }
      expect(complete).toBe(true);
    } finally {
      f.meter.assertFreeBudget();
    }
  });

  it.each(['http', 'mcp'] as const)(
    'keeps the complete %s report workflow within the Free per-request budget',
    async (transport) => {
      const f = await fixture();
      try {
        await f.agent(
          transport,
          'getValidationRequirements',
          { collectionId, kind: draft.kind },
          'requirements.initial',
        );
        await f.agent(transport, 'createDraft', {
          commandId: 'agent-create',
          correlationId: 'query-budget',
          expectedGeneration: 0,
          articleId,
          collectionId,
          draft,
        });
        const article: DraftArticleDto = await f.app.getDraft(f.access, {
          articleId,
        });
        const requirements = await f.agent(
          transport,
          'getValidationRequirements',
          {
            collectionId,
            kind: draft.kind,
            articleId,
          },
          'requirements.article',
        );
        const ledger = object(requirements.reportLedger);
        const ledgerEpoch = integer(ledger.ledgerEpoch);
        expect(ledger.status).toBe('active');
        const evidence: EvidenceSubmission = {
          id: 'query-budget-evidence',
          articleId,
          articleRevision: article.revision.number,
          contentHash: article.revision.contentHash,
          validationPolicy: article.revision.validationPolicy,
          checkId: 'explanation-content',
          testKind: 'content',
          applicability: article.revision.applicability,
          stagingBuildId: 'query-budget-1',
          steps: ['Read the synthetic guide', 'Compare the synthetic output'],
          result: 'passed',
          executedAt: f.clock.now(),
          runnerId: 'query-budget-runner',
          artifacts: [{ id: 'query-budget-output', hash: 'a'.repeat(64) }],
        };
        const report = {
          summary: 'Synthetic check passed',
          details: 'Private synthetic report detail canary.',
        };
        const queued = await f.agent(
          transport,
          'submitEvidence',
          {
            commandId: 'protocol-report',
            correlationId: 'query-budget',
            expectedGeneration: article.generation,
            articleId,
            ledgerEpoch,
            evidence,
            report,
          },
          'report.queue',
        );
        expect(queued.kind).toBe('pending-human-review');
        const reportId = text(queued.reportId);
        expect(
          (await f.app.getEvidence(f.access, { articleId })).evidence,
        ).toEqual([]);
        const lookup = {
          collectionId,
          kind: draft.kind,
          articleId,
          reportLookup: { ledgerEpoch, reportId },
        };
        const pending = await f.agent(
          transport,
          'getValidationRequirements',
          lookup,
          'report.poll.pending',
        );
        expect(object(pending.reportStatus).status).toBe('pending');
        expect(JSON.stringify(pending)).not.toContain(report.details);
        const manual = await f.send(
          f.agentRequest('/api/knowledge/reports', {
            commandId: 'manual-report',
            articleId,
            ledgerEpoch,
            evidence,
            report,
          }),
          'manual.report.submit',
        );
        expect(manual.status).toBe(200);
        const manualLedger = await f.send(
          f.agentRequest('/api/knowledge/reports?articleId=' + articleId),
          'manual.report.ledger',
        );
        expect(manualLedger.status).toBe(200);
        expect(object(await manualLedger.json()).ledgerEpoch).toBe(ledgerEpoch);
        const manualStatus = await f.send(
          f.agentRequest(
            '/api/knowledge/reports?' +
              new URLSearchParams({
                articleId,
                ledgerEpoch: String(ledgerEpoch),
                reportId,
              }),
          ),
          'manual.report.status',
        );
        expect(manualStatus.status).toBe(200);
        expect(object(await manualStatus.json()).status).toBe('pending');
        const viewed = await f.staff('reportRead', {
          articleId,
          ledgerEpoch,
          reportId,
        });
        // The private staff view provides the exact current binding; agents never do.
        const review: Pick<
          KnowledgeReportView,
          'expectedReportGeneration' | 'reviewBindingHash'
        > = {
          expectedReportGeneration: integer(viewed.expectedReportGeneration),
          reviewBindingHash: text(viewed.reviewBindingHash),
        };
        await f.staff('confirmReport', {
          commandId: 'human-confirm',
          articleId,
          ledgerEpoch,
          reportId,
          ...review,
        });
        const confirmed = await f.agent(
          transport,
          'getValidationRequirements',
          lookup,
          'report.poll.confirmed',
        );
        expect(object(confirmed.reportStatus).status).toBe('confirmed');
        expect(JSON.stringify(confirmed)).not.toContain(report.details);
        await f.agent(
          transport,
          'submitEvidence',
          {
            commandId: 'accept-confirmed',
            correlationId: 'query-budget',
            expectedGeneration: article.generation,
            articleId,
            evidence,
            receipt: text(queued.receipt),
          },
          'evidence.accept',
        );
        expect(
          (await f.app.getEvidence(f.access, { articleId })).evidence,
        ).toHaveLength(1);
      } finally {
        // Deliberately RED on a producer/host that exceeds50; no version-conditioned waiver.
        // Evaluate after the flow so baseline evidence includes every completed request.
        f.meter.assertFreeBudget();
      }
    },
  );

  it('profiles both protocols and the full staff/portal lifecycle over one genuine32-proof high-history D1 article', async () => {
    const f = await fixture(true);
    let sequence = 0;
    const command = () => 'history-' + ++sequence;
    const reportBody = {
      summary: 'Synthetic measured history check',
      details: 'PRIVATE_HIGH_HISTORY_REPORT_CANARY',
    };
    async function portal(operation: string, input: unknown, expected = 200) {
      const response = await f.send(
        f.browser('/api/knowledge/portal', { operation, input }),
        'portal.' + operation,
      );
      expect(response.status, operation).toBe(expected);
      const result = object(await response.json());
      expect(JSON.stringify(result)).not.toContain(reportBody.details);
      return result;
    }
    async function ledger() {
      const response = await f.send(
        f.agentRequest('/api/knowledge/reports?articleId=' + articleId),
      );
      expect(response.status).toBe(200);
      return object(await response.json());
    }
    async function resetLedger(measured: boolean) {
      const current = await ledger();
      let next = await f.staff(
        'resetReports',
        {
          commandId: command(),
          articleId,
          expectedLedgerEpoch: integer(current.ledgerEpoch),
        },
        measured,
      );
      for (let page = 0; page < 4 && next.status === 'resetting'; page += 1) {
        next = await f.staff(
          'drainReports',
          { articleId, ledgerEpoch: integer(next.ledgerEpoch) },
          measured,
        );
      }
      expect(next.status).toBe('active');
      return next;
    }
    async function prepare(
      id: string,
      transport: Transport,
      measured: boolean,
    ) {
      let head = await ledger();
      if (
        integer(head.reportsRemaining) === 0 ||
        integer(head.rowsRemaining) < 8
      )
        head = await resetLedger(false);
      const article = await f.app.getDraft(f.access, { articleId });
      const evidence: EvidenceSubmission = {
        id,
        articleId,
        articleRevision: article.revision.number,
        contentHash: article.revision.contentHash,
        validationPolicy: article.revision.validationPolicy,
        checkId: 'explanation-content',
        testKind: 'content',
        applicability: article.revision.applicability,
        stagingBuildId: 'query-budget-1',
        steps: [
          'Read the synthetic guide',
          'Compare the current synthetic output',
        ],
        result: 'passed',
        executedAt: f.clock.now(),
        runnerId: 'query-budget-runner',
        artifacts: [{ id: 'history-output-' + sequence, hash: 'b'.repeat(64) }],
      };
      const ledgerEpoch = integer(head.ledgerEpoch);
      const input = {
        commandId: command(),
        articleId,
        ledgerEpoch,
        evidence,
        report: reportBody,
      };
      let ack: Record<string, unknown>;
      if (measured) {
        ack = await f.agent(
          transport,
          'submitEvidence',
          {
            ...input,
            correlationId: 'query-budget',
            expectedGeneration: article.generation,
          },
          'history.report.queue',
        );
        expect(ack.kind).toBe('pending-human-review');
      } else {
        const response = await f.send(
          f.agentRequest('/api/knowledge/reports', input),
        );
        expect(response.status).toBe(200);
        ack = object(await response.json());
      }
      return {
        article,
        evidence,
        ack,
        key: { articleId, ledgerEpoch, reportId: text(ack.reportId) },
      };
    }
    async function confirm(
      packet: Awaited<ReturnType<typeof prepare>>,
      measured: boolean,
    ) {
      const view = await f.staff('reportRead', packet.key, measured);
      expect(view.status).toBe('pending');
      expect(view.submittedBy).toBe(owner);
      await f.staff(
        'confirmReport',
        {
          ...packet.key,
          commandId: command(),
          expectedReportGeneration: integer(view.expectedReportGeneration),
          reviewBindingHash: text(view.reviewBindingHash),
        },
        measured,
      );
    }
    async function accept(
      packet: Awaited<ReturnType<typeof prepare>>,
      transport: Transport,
      measured: boolean,
    ) {
      const input = {
        commandId: command(),
        correlationId: 'query-budget',
        expectedGeneration: packet.article.generation,
        articleId,
        evidence: packet.evidence,
        receipt: text(packet.ack.receipt),
      };
      const result = await f.agent(
        transport,
        'submitEvidence',
        input,
        measured ? 'history.evidence.accept' : false,
      );
      expect(result.replayed).toBe(false);
      const stored = await f.app.getEvidence(f.access, { articleId });
      const proof = stored.evidence.find(
        (value) => value.id === packet.evidence.id,
      );
      if (proof === undefined)
        throw new Error(
          'Actual SDK acceptance did not retain the submitted proof.',
        );
      expect(proof.attestation.id).toBe(packet.ack.receipt);
      return { input, proof, result };
    }
    async function seed(id: string) {
      const packet = await prepare(id, 'http', false);
      await confirm(packet, false);
      return accept(packet, 'http', false);
    }
    async function revoke(id: string, measured: boolean) {
      const stored = await f.app.getEvidence(f.access, { articleId });
      const proof = stored.evidence.find((value) => value.id === id);
      if (proof === undefined)
        throw new Error('Expected a genuinely accepted current proof.');
      await f.staff(
        'revokeEvidence',
        {
          commandId: command(),
          correlationId: 'query-budget',
          expectedGeneration: stored.generation,
          articleId,
          articleRevision: proof.articleRevision,
          evidenceId: proof.id,
          evidenceVersion: proof.version,
          evidenceHash: proof.hash,
          reason: 'Synthetic high-history withdrawal',
        },
        measured,
      );
    }
    async function articleRows(): Promise<KnowledgeRecord[]> {
      const records = f.store.collection(knowledgeRecords);
      const rows: KnowledgeRecord[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page += 1) {
        const scanned = await records.scan({
          limit: 1000,
          ...(cursor === undefined ? {} : { cursor }),
        });
        rows.push(
          ...scanned.records
            .map((row) => row.value)
            .filter(
              (row) =>
                row.resourceKind === 'article' && row.resourceId === articleId,
            ),
        );
        if (scanned.nextCursor === null) return rows;
        cursor = scanned.nextCursor;
      }
      throw new Error(
        'Actual high-history diagnostics exceeded their bounded scan.',
      );
    }
    try {
      const collection = await f.staff('getCollection', { collectionId });
      expect(object(collection.collection).id).toBe(collectionId);
      const governance = await f.staff(
        'getGovernanceConfiguration',
        { collectionId },
        true,
        owner,
      );
      await f.staff(
        'putGovernanceConfiguration',
        {
          commandId: command(),
          correlationId: 'query-budget',
          expectedGeneration: integer(governance.generation),
          collectionId,
          configuration: governance.configuration,
        },
        true,
        owner,
      );
      const preview = await f.staff(
        'previewCollectionPolicy',
        {
          collectionId,
          uses: {
            portal: {
              enabled: true,
              audience: {
                kind: 'permission',
                permission: 'knowledge.article.read',
              },
            },
            bot: { enabled: false },
          },
        },
        true,
        owner,
      );
      await f.staff(
        'updateCollectionPolicy',
        {
          commandId: command(),
          correlationId: 'query-budget',
          expectedGeneration: integer(preview.generation),
          collectionId,
          preview: preview.preview,
        },
        true,
        owner,
      );
      await f.agent(
        'http',
        'createDraft',
        {
          commandId: command(),
          correlationId: 'query-budget',
          expectedGeneration: 0,
          articleId,
          collectionId,
          draft,
        },
        'history.create',
      );
      const initial = await prepare('history-proof-0', 'http', true);
      await confirm(initial, true);
      await accept(initial, 'http', true);
      const current = await f.app.getDraft(f.access, { articleId });
      await f.staff('submitForReview', {
        commandId: command(),
        correlationId: 'query-budget',
        expectedGeneration: current.generation,
        articleId,
      });
      const review = await f.staff('getReview', { articleId });
      await f.staff('publishArticle', {
        commandId: command(),
        correlationId: 'query-budget',
        expectedGeneration: integer(review.generation),
        articleId,
        review: review.review,
      });
      const visible = await portal('getPublishedArticle', { articleId });
      expect(visible.articleId).toBe(articleId);
      expect(
        await portal('searchPublishedArticles', {
          collectionId,
          query: 'synthetic',
          applicability: draft.applicability,
        }),
      ).toEqual({ outcome: 'no_result', articles: [] });
      let discovered = false;
      for (let tick = 0; tick < 64; tick++) {
        await f.scheduled();
        const status = await f.app.getArticleIndexStatus(f.access, {
          articleId,
        });
        if (status.status === 'ready' && status.indexed) {
          discovered = true;
          break;
        }
      }
      expect(discovered).toBe(true);
      const collections = await portal('listPortalCollections', {});
      expect(collections).toMatchObject({
        outcome: 'results',
        collections: [{ collectionId }],
      });
      const search = await portal('searchPublishedArticles', {
        collectionId,
        query: 'synthetic',
        applicability: draft.applicability,
      });
      expect(search).toMatchObject({
        outcome: 'results',
        articles: [{ articleId }],
      });
      await revoke('history-proof-0', true);
      await portal('getPublishedArticle', { articleId }, 404);
      expect(
        await portal('searchPublishedArticles', {
          collectionId,
          query: 'synthetic',
          applicability: draft.applicability,
        }),
      ).toEqual({ outcome: 'no_result', articles: [] });
      // Authoritative refusal above precedes any worker. Now converge the
      // retained hint, and exercise a separate physical recovery invocation.
      let withdrawn = false;
      for (let tick = 0; tick < 64; tick++) {
        await f.scheduled();
        const status = await f.app.getArticleIndexStatus(f.access, {
          articleId,
        });
        if (status.status === 'ready' && !status.indexed) {
          withdrawn = true;
          break;
        }
      }
      expect(withdrawn).toBe(true);
      await f.scheduled('physical');
      await resetLedger(true);
      // Build current32 only AFTER the ordinary one-result guide was published.
      // These same-check draft proofs do not qualify for a new publication.
      await seed('history-proof-0');
      for (let index = 1; index < 32; index += 1)
        await seed('history-proof-' + index);
      for (let revocations = 1; revocations < 64; revocations += 1) {
        await revoke('history-proof-0', false);
        await seed('history-proof-0');
        profileFacts.seedRevocations = revocations + 1;
      }
      const rows = await articleRows();
      const encodedBytes = rows.reduce(
        (sum, row) =>
          sum +
          new TextEncoder().encode(
            JSON.stringify(knowledgeRecords.codec.encode(row)),
          ).byteLength,
        0,
      );
      // Read actual public records only; keep the unchanged default1024-row,
      // 256-version and16MiB budgets, plus conservative remaining-write margin.
      const try96 =
        rows.length + 32 * 8 + 96 <= 1024 &&
        rows.filter((row) => row.kind === 'evidence').length + 32 + 4 <= 256 &&
        encodedBytes + 2 * 1024 * 1024 < 16 * 1024 * 1024;
      profileFacts.try96 = try96;
      if (try96)
        for (let revocations = 64; revocations < 96; revocations += 1) {
          await revoke('history-proof-0', false);
          await seed('history-proof-0');
          profileFacts.seedRevocations = revocations + 1;
        }
      const history = await f.app.getEvidence(f.access, { articleId });
      expect(history.evidence).toHaveLength(32);
      expect(history.revokedEvidence.length).toBeGreaterThanOrEqual(64);
      expect(history.revokedEvidence).toHaveLength(try96 ? 96 : 64);
      for (const proof of history.evidence)
        expect(
          history.revokedEvidence.some((marker) => marker.hash === proof.hash),
        ).toBe(false);
      profileFacts.currentEvidence = history.evidence.length;
      profileFacts.revocations = history.revokedEvidence.length;
      const finalRows = await articleRows();
      profileFacts.articleRows = finalRows.length;
      profileFacts.actualEncodedBytesBeforeMeasure = finalRows.reduce(
        (sum, row) =>
          sum +
          new TextEncoder().encode(
            JSON.stringify(knowledgeRecords.codec.encode(row)),
          ).byteLength,
        0,
      );
      profileFacts.windowRolloverMeasured = false;
      expect(
        (await f.app.getDraft(f.access, { articleId })).hasPublication,
      ).toBe(true);
      for (const transport of ['http', 'mcp'] as const) {
        const read = await f.agent(
          transport,
          'getDraft',
          { articleId },
          'history.getDraft',
          '2001:db8::c01d',
        );
        expect(read.hasPublication).toBe(true);
        await f.agent(
          transport,
          'getValidationRequirements',
          { collectionId, kind: draft.kind },
          'history.requirements',
        );
        await f.agent(
          transport,
          'getValidationRequirements',
          { collectionId, kind: draft.kind, articleId },
          'history.ledger',
        );
        const packet = await prepare('history-proof-0', transport, true);
        const lookup = {
          collectionId,
          kind: draft.kind,
          articleId,
          reportLookup: {
            ledgerEpoch: packet.key.ledgerEpoch,
            reportId: packet.key.reportId,
          },
        };
        const pending = await f.agent(
          transport,
          'getValidationRequirements',
          lookup,
          'history.pending',
        );
        expect(object(pending.reportStatus).status).toBe('pending');
        expect(JSON.stringify(pending)).not.toContain(reportBody.details);
        await confirm(packet, true);
        const confirmed = await f.agent(
          transport,
          'getValidationRequirements',
          lookup,
          'history.confirmed',
        );
        expect(object(confirmed.reportStatus).status).toBe('confirmed');
        const accepted = await accept(packet, transport, true);
        const replay = await f.agent(
          transport,
          'submitEvidence',
          accepted.input,
          'history.evidence.replay',
        );
        expect(replay).toEqual({ ...accepted.result, replayed: true });
        expect(
          (await f.app.getEvidence(f.access, { articleId })).evidence,
        ).toHaveLength(32);
      }
      const fullEvidence = await f.staff('getEvidence', { articleId });
      expect(fullEvidence.evidence).toHaveLength(32);
      expect(fullEvidence.revokedEvidence).toHaveLength(
        history.revokedEvidence.length,
      );
      // Complete qualification must really fetch retained facts in a coalesced
      // public-Store wave, not merely contain Promise.all in source.
      expect(
        f.meter.requests.some((budget) =>
          budget.batchSizes.some(
            (size) => size >= 1 + 32 + history.revokedEvidence.length,
          ),
        ),
      ).toBe(true);
      const ending = await f.app.getDraft(f.access, { articleId });
      await f.staff('retireArticle', {
        commandId: command(),
        correlationId: 'query-budget',
        expectedGeneration: ending.generation,
        articleId,
      });
      await portal('getPublishedArticle', { articleId }, 404);
      profileFacts.priorPublicationRetained = (
        await f.app.getDraft(f.access, { articleId })
      ).hasPublication;
    } finally {
      f.meter.assertFreeBudget();
    }
  }, 180_000);
});
