import type { PublicClient } from '@pegma/agent-access';
import { identityLinkKeyFromVerifiedIdentityClaims } from '@pegma/authorization-identity';
import { createRoleStore } from '@pegma/authorization-storage';
import { KnowledgeBaseNotFoundError } from '@pegma/knowledge-base-application';
import { articleKinds } from '@pegma/knowledge-base-contracts';
import type {
  ArticleDraft,
  EvidenceSubmission,
} from '@pegma/knowledge-base-core';
import {
  knowledgeAgentToolNames,
  knowledgeAgentScopes,
  type KnowledgeAgentOperation,
} from '@pegma/knowledge-base-mcp';
import { createSessionStore } from '@pegma/sessions';
import type { Logger } from '@pegma/spine';
import {
  createMemoryStore,
  type CollectionDefinition,
  type CollectionStore,
  type Store,
} from '@pegma/storage-core';
import { describe, expect, it } from 'vitest';
import { createAgentPrincipalResolver } from './agent-authority';
import {
  AGENT_API_URL,
  AGENT_RESOURCE,
  createAgentAccessRuntime,
} from './agent-access-runtime';
import { isPlainObject } from './api-auth';
import { IDENTITY_ISSUER, SESSION_COOKIE } from './identity-api';
import { createIdentityRuntime } from './identity-runtime';
import { createKnowledgeRuntime } from './knowledge-runtime';
import {
  ADMIN_ROLE,
  AGENT_KNOWLEDGE_PERMISSIONS,
  APPLICATION_SCOPE,
  AUTHORIZATION_APPLICATION_ID,
} from './support-access';

type Transport = 'http' | 'mcp';
type Revocation = 'grant' | 'role';
const ownerId = 'freshness-owner';
const inspectorId = 'freshness-inspector';
const collectionId = 'freshness-guides';
const client: PublicClient = {
  clientId: 'synthetic-freshness-client',
  name: 'Synthetic freshness client',
  redirectUris: ['https://client.example.test/callback'],
  allowedScopes: [...AGENT_KNOWLEDGE_PERMISSIONS],
  grantTypes: ['device_code'],
};
const draft: ArticleDraft = {
  kind: 'explanation',
  title: 'Current-authority guide',
  summary: 'A complete example guide.',
  content: {
    format: 'plain_text',
    text: 'Private guide content for the synthetic example.',
  },
  tags: [],
  applicability: {
    productId: 'example',
    productVersion: '1',
    buildId: 'staging-1',
  },
};

function barrier() {
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}

interface StoreHooks {
  afterKbRead: ((rowId?: string) => Promise<void>) | undefined;
  afterKbCommit: ((rowId?: string) => Promise<void>) | undefined;
  afterReportRead: ((rowId?: string) => Promise<void>) | undefined;
  afterReportCommit: ((rowId?: string) => Promise<void>) | undefined;
}

/** Pause actual adapter operations, without replacing authentication or persistence. */
function observedStore(backing: Store, hooks: StoreHooks): Store {
  return {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      const target = backing.collection(definition);
      const reportRecords =
        definition.name === 'pegma-dev.knowledge-evidence.v1';
      if (definition.name !== 'knowledge-base.records.v1' && !reportRecords)
        return target;
      return {
        ...target,
        async get(key) {
          const value = await target.get(key);
          await (reportRecords ? hooks.afterReportRead : hooks.afterKbRead)?.(
            key.id,
          );
          return value;
        },
        async getVersioned(key) {
          const value = await target.getVersioned(key);
          await (reportRecords ? hooks.afterReportRead : hooks.afterKbRead)?.(
            key.id,
          );
          return value;
        },
        async transact(partition, actions) {
          const result = await target.transact(partition, actions);
          if (result.committed)
            await (
              reportRecords ? hooks.afterReportCommit : hooks.afterKbCommit
            )?.();
          return result;
        },
      };
    },
  };
}

function wire(
  transport: Transport,
  operation: KnowledgeAgentOperation,
  input: unknown,
) {
  return transport === 'http'
    ? { apiVersion: '1', operation, input }
    : {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: knowledgeAgentToolNames[operation], arguments: input },
      };
}

function agentRequest(
  transport: Transport,
  token: string,
  body: string | ReadableStream<Uint8Array>,
) {
  const options = {
    method: 'POST',
    duplex: 'half',
    body,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...(transport === 'mcp'
        ? {
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': '2025-06-18',
          }
        : {}),
    },
  };
  return new Request(
    transport === 'http' ? AGENT_API_URL : AGENT_RESOURCE,
    options,
  );
}

function delayedBody(value: unknown) {
  const reading = barrier();
  const finish = barrier();
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        reading.release();
        await finish.ready;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, reading: reading.ready, finish: finish.release };
}

async function logicalResponse(
  response: Response | null,
  transport: Transport,
): Promise<Record<string, unknown>> {
  if (response === null)
    throw new Error('Expected a matching real agent route.');
  const value: unknown = await response.json();
  if (!isPlainObject(value))
    throw new Error('Expected an object agent response.');
  if (transport === 'http') return value;
  const result = value.result;
  if (!isPlainObject(result) || !Array.isArray(result.content))
    throw new Error('Expected an actual MCP tool result.');
  const content: unknown = result.content[0];
  if (!isPlainObject(content) || typeof content.text !== 'string')
    throw new Error('Expected an MCP JSON text result.');
  const logical: unknown = JSON.parse(content.text);
  if (!isPlainObject(logical)) throw new Error('Expected an object KB result.');
  return logical;
}

async function fixture() {
  const backing = createMemoryStore();
  const hooks: StoreHooks = {
    afterKbRead: undefined,
    afterKbCommit: undefined,
    afterReportRead: undefined,
    afterReportCommit: undefined,
  };
  const store = observedStore(backing, hooks);
  const logger: Logger = { log() {} };
  let instant = Date.now();
  const clock = { now: () => new Date(instant).toISOString() };
  const identity = createIdentityRuntime(
    {
      store,
      emailCodeSecretBase64: btoa('s'.repeat(32)),
      emailFrom: 'Pegma <identity@example.test>',
      emailEnabled: false,
    },
    logger,
  ).identity;
  // Public trusted provisioning creates real verified Identity records; there
  // is no fake claimsFor/getUser or authentication implementation in this suite.
  for (const id of [ownerId, inspectorId]) {
    await identity.provisionVerifiedUser({
      principalId: id,
      email: id + '@example.test',
    });
  }
  const roleStore = createRoleStore(store, AUTHORIZATION_APPLICATION_ID);
  for (const id of [ownerId, inspectorId]) {
    await roleStore.grantRoleAssignmentWithAudit({
      assignment: {
        id: 'admin-' + id,
        principalId: id,
        role: ADMIN_ROLE,
        scope: APPLICATION_SCOPE,
        grantedBy: { kind: 'system', systemId: 'synthetic-freshness-setup' },
        grantedAtEpochMs: instant,
        status: 'active',
      },
      auditEventId: 'grant-' + id,
    });
  }
  const sessions = createSessionStore(store, { logger, clock });
  const sessionId = 's'.repeat(43);
  const csrfToken = 'c'.repeat(43);
  await sessions.create(sessionId, {
    principalId: ownerId,
    data: JSON.stringify({
      version: 1,
      csrfToken,
      issuer: IDENTITY_ISSUER,
      subject: ownerId,
    }),
  });
  const options = {
    store,
    clock,
    logger,
    identity,
    sessions,
    roleStore,
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
  };
  const candidateAgents = createAgentAccessRuntime({
    ...options,
    clients: [client],
  });
  if (candidateAgents === null)
    throw new Error('Expected the explicit synthetic client.');
  const agents = candidateAgents;
  const knowledge = createKnowledgeRuntime({ ...options, agentAccess: agents });
  const resolve = createAgentPrincipalResolver(options);
  async function access(id = inspectorId) {
    const current = await resolve(id);
    if (current === null)
      throw new Error('Expected a current actual Identity principal.');
    return current;
  }
  function browser(path: string, method = 'GET', body?: unknown) {
    return new Request(IDENTITY_ISSUER + path, {
      method,
      headers: {
        Cookie: SESSION_COOKIE + '=' + sessionId,
        Origin: IDENTITY_ISSUER,
        'Sec-Fetch-Site': 'same-origin',
        'X-Pegma-CSRF': csrfToken,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function device(
    scopes: readonly string[] = AGENT_KNOWLEDGE_PERMISSIONS,
  ) {
    const pending = await agents.service.beginDeviceAuthorization({
      clientId: client.clientId,
      resource: AGENT_RESOURCE,
      scopes: [...scopes],
    });
    const viewed = await agents.api(
      browser(
        '/api/agent-access/approval?user_code=' +
          encodeURIComponent(pending.user_code),
      ),
    );
    if (viewed === null)
      throw new Error('Expected the real browser approval API.');
    expect(viewed.status).toBe(200);
    const approval: unknown = await viewed.json();
    if (!isPlainObject(approval) || typeof approval.requestId !== 'string')
      throw new Error('Expected a credential-free real approval view.');
    const approved = await agents.api(
      browser('/api/agent-access/approval', 'POST', {
        requestId: approval.requestId,
        userCode: pending.user_code,
        decision: 'approve',
        approvedScopes: [...scopes],
      }),
    );
    expect(approved?.status).toBe(200);
    instant += pending.interval * 1_000 + 1;
    const tokens = await agents.service.pollDeviceToken({
      clientId: client.clientId,
      resource: AGENT_RESOURCE,
      deviceCode: pending.device_code,
    });
    const delegated = await agents.service.authenticate({
      token: tokens.access_token,
      resource: AGENT_RESOURCE,
    });
    expect(delegated.access.roles).toEqual([]);
    expect(delegated.access.entitlements).toEqual([]);
    expect(delegated.access.permissions.slice().sort()).toEqual(
      [...scopes].sort(),
    );
    return {
      token: tokens.access_token,
      grantId: delegated.grantId,
      access: delegated.access,
    };
  }
  const admin = await access();
  const collection = await knowledge.application.createCollection(admin, {
    commandId: 'collection',
    correlationId: 'freshness',
    expectedGeneration: 0,
    collectionId,
    name: 'Freshness guides',
  });
  await knowledge.application.putValidationPolicy(admin, {
    commandId: 'policy',
    correlationId: 'freshness',
    expectedGeneration: 0,
    policy: {
      id: 'freshness-policy',
      version: 1,
      requirements: [
        ...articleKinds.map((kind) => ({
          id: kind + '-content',
          kind,
          testKind: 'content',
          maxAgeMilliseconds: 3_600_000,
          trustedRunnerIds: [ownerId],
        })),
        {
          id: 'walkthrough-workflow',
          kind: 'walkthrough',
          testKind: 'workflow',
          maxAgeMilliseconds: 3_600_000,
          trustedRunnerIds: [ownerId],
        },
      ],
    },
  });
  await knowledge.application.putGovernanceConfiguration(admin, {
    commandId: 'governance',
    correlationId: 'freshness',
    expectedGeneration: collection.value.generation,
    collectionId,
    configuration: {
      validationPolicy: { id: 'freshness-policy', version: 1 },
      expectedStagingBuildId: 'staging-1',
      trustedAttesterIds: [ownerId],
    },
  });
  const credential = await device();
  function createInput(articleId: string) {
    return {
      commandId: 'create-' + articleId,
      correlationId: 'freshness',
      expectedGeneration: 0,
      articleId,
      collectionId,
      draft,
    };
  }
  async function reportInput(articleId: string) {
    await knowledge.application.createDraft(
      await access(),
      createInput(articleId),
    );
    const target = await knowledge.application.getDraft(await access(), {
      articleId,
    });
    const ledger = await knowledge.evidence.ledger(credential.access, {
      articleId,
    });
    const evidence: EvidenceSubmission = {
      id: 'run-' + articleId,
      articleId,
      articleRevision: target.revision.number,
      contentHash: target.revision.contentHash,
      validationPolicy: target.revision.validationPolicy,
      checkId: 'explanation-content',
      testKind: 'content',
      applicability: target.revision.applicability,
      stagingBuildId: 'staging-1',
      steps: ['Read the complete synthetic guide.'],
      result: 'passed',
      executedAt: clock.now(),
      runnerId: ownerId,
      artifacts: [{ id: 'synthetic-report', hash: 'a'.repeat(64) }],
    };
    return {
      commandId: 'report-' + articleId,
      correlationId: 'freshness',
      expectedGeneration: target.generation,
      articleId,
      ledgerEpoch: ledger.ledgerEpoch,
      evidence,
      report: {
        summary: 'Synthetic check passed.',
        details: 'Private synthetic execution details.',
      },
    };
  }
  async function queueReport(articleId: string) {
    const input = await reportInput(articleId);
    const acknowledgement = await knowledge.evidence.report(credential.access, {
      commandId: input.commandId,
      articleId,
      ledgerEpoch: input.ledgerEpoch,
      evidence: input.evidence,
      report: input.report,
    });
    return { input, acknowledgement };
  }
  async function revoke(kind: Revocation, grantId = credential.grantId) {
    if (kind === 'grant') {
      const response = await agents.api(
        browser('/api/agent-access/grants/' + grantId, 'DELETE'),
      );
      expect(response?.status).toBe(204);
    } else {
      const assignment = await roleStore.getRoleAssignment('admin-' + ownerId);
      if (assignment === null)
        throw new Error('Expected the real Admin assignment.');
      expect(
        (
          await roleStore.revokeRoleAssignmentWithAudit({
            assignmentId: 'admin-' + ownerId,
            expectedConcurrencyToken: assignment.concurrencyToken,
            revokedBy: { kind: 'principal', principalId: inspectorId },
            revokedAtEpochMs: instant,
            auditEventId: 'revoke-owner',
          })
        ).status,
      ).toBe('revoked');
    }
  }
  function block(
    hook: keyof StoreHooks,
    rowIdContains?: string,
    failAfterRead = false,
  ) {
    const entered = barrier();
    const finish = barrier();
    hooks[hook] = async (rowId) => {
      if (rowIdContains !== undefined && !rowId?.includes(rowIdContains))
        return;
      hooks[hook] = undefined;
      entered.release();
      await finish.ready;
      if (failAfterRead)
        throw new Error('Synthetic private final-read failure canary.');
    };
    return { entered: entered.ready, finish: finish.release };
  }
  return {
    knowledge,
    agents,
    access,
    credential,
    device,
    createInput,
    reportInput,
    queueReport,
    revoke,
    block,
    identity,
    roleStore,
    resolve,
  };
}

it('resolves stored roles before the actual active verified Identity claims without a duplicate user read', async () => {
  const f = await fixture();
  const observations: string[] = [];
  const resolve = createAgentPrincipalResolver({
    identity: {
      ...f.identity,
      async claimsFor(id) {
        observations.push('claims');
        return f.identity.claimsFor(id);
      },
      async getUser(id) {
        observations.push('user');
        return f.identity.getUser(id);
      },
    },
    roleStore: {
      async listActiveRoleAssignments(id, scope) {
        const result = await f.roleStore.listActiveRoleAssignments(id, scope);
        observations.push('roles');
        return result;
      },
    },
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
  });
  expect(await resolve(ownerId)).toEqual(await f.resolve(ownerId));
  expect(observations).toEqual(['roles', 'claims']);
});

it('refuses a real stored Admin assignment whose principal has no actual Identity account', async () => {
  const f = await fixture();
  const principalId = 'orphaned-role-principal';
  const granted = await f.roleStore.grantRoleAssignmentWithAudit({
    assignment: {
      id: 'orphaned-role-assignment',
      principalId,
      role: ADMIN_ROLE,
      scope: APPLICATION_SCOPE,
      grantedBy: { kind: 'system', systemId: 'synthetic-orphan-test' },
      grantedAtEpochMs: Date.now(),
      status: 'active',
    },
    auditEventId: 'orphaned-role-audit',
  });
  expect(granted.status).toBe('granted');
  expect(await f.resolve(principalId)).toBeNull();
});

describe.each(['http', 'mcp'] as const)(
  'current agent authority over actual %s transport',
  (transport) => {
    it('accepts an actual current scoped credential through the released SDK', async () => {
      const f = await fixture();
      const request = agentRequest(
        transport,
        f.credential.token,
        JSON.stringify(
          wire(transport, 'createDraft', f.createInput('allowed')),
        ),
      );
      const result = await logicalResponse(
        await f.knowledge.handle(request),
        transport,
      );
      expect(result).toMatchObject({
        apiVersion: '1',
        operation: 'createDraft',
        result: { replayed: false },
      });
    });

    it.each(['grant', 'role'] as const)(
      'rejects %s revocation while the actual SDK awaits request bytes before a write',
      async (kind) => {
        const f = await fixture();
        const body = delayedBody(
          wire(transport, 'createDraft', f.createInput('body-race')),
        );
        const pending = f.knowledge.handle(
          agentRequest(transport, f.credential.token, body.stream),
        );
        await body.reading;
        try {
          await f.revoke(kind);
        } finally {
          body.finish();
        }
        expect(await logicalResponse(await pending, transport)).toMatchObject({
          error: { code: 'forbidden' },
        });
        await expect(
          f.knowledge.application.getDraft(await f.access(), {
            articleId: 'body-race',
          }),
        ).rejects.toBeInstanceOf(KnowledgeBaseNotFoundError);
      },
    );

    it.each([
      { scope: knowledgeAgentScopes.draftWrite, allowed: true },
      { scope: knowledgeAgentScopes.evidenceSubmit, allowed: true },
      { scope: knowledgeAgentScopes.draftRead, allowed: false },
    ])(
      'retains the requirements permission alternative for $scope',
      async ({ scope, allowed }) => {
        const f = await fixture();
        const credential = await f.device([scope]);
        const result = await logicalResponse(
          await f.knowledge.handle(
            agentRequest(
              transport,
              credential.token,
              JSON.stringify(
                wire(transport, 'getValidationRequirements', {
                  collectionId,
                  kind: draft.kind,
                }),
              ),
            ),
          ),
          transport,
        );
        if (allowed)
          expect(result).toMatchObject({
            operation: 'getValidationRequirements',
            result: { collectionId },
          });
        else expect(result).toMatchObject({ error: { code: 'forbidden' } });
      },
    );

    it('requires both report grants while allowing report reads without draft-write authority', async () => {
      const f = await fixture();
      const input = await f.reportInput('report-read-permissions');
      for (const scopes of [
        [knowledgeAgentScopes.draftRead],
        [knowledgeAgentScopes.evidenceSubmit],
        [knowledgeAgentScopes.draftRead, knowledgeAgentScopes.evidenceSubmit],
      ]) {
        const credential = await f.device(scopes);
        const result = await logicalResponse(
          await f.knowledge.handle(
            agentRequest(
              transport,
              credential.token,
              JSON.stringify(
                wire(transport, 'getValidationRequirements', {
                  articleId: input.articleId,
                  collectionId,
                  kind: draft.kind,
                }),
              ),
            ),
          ),
          transport,
        );
        if (scopes.length === 2)
          expect(result).toMatchObject({
            result: { reportLedger: { status: 'active' } },
          });
        else expect(result).toMatchObject({ error: { code: 'forbidden' } });
      }
    });

    it('keeps independent request read groups separate when one live grant is revoked', async () => {
      const f = await fixture();
      await f.knowledge.application.createDraft(
        await f.access(),
        f.createInput('isolated-read'),
      );
      const other = await f.device();
      const blocked = f.block('afterKbRead');
      const input = JSON.stringify(
        wire(transport, 'getDraft', { articleId: 'isolated-read' }),
      );
      const pending = f.knowledge.handle(
        agentRequest(transport, f.credential.token, input),
      );
      await Promise.race([
        blocked.entered,
        pending.then(() => {
          throw new Error('Expected the actual read barrier.');
        }),
      ]);
      try {
        const independent = await logicalResponse(
          await f.knowledge.handle(agentRequest(transport, other.token, input)),
          transport,
        );
        expect(independent).toMatchObject({
          result: { articleId: 'isolated-read' },
        });
        await f.revoke('grant');
      } finally {
        blocked.finish();
      }
      const denied = await logicalResponse(await pending, transport);
      expect(denied).toMatchObject({ error: { code: 'forbidden' } });
      expect(JSON.stringify(denied)).not.toContain(draft.content.text);
      expect(
        await logicalResponse(
          await f.knowledge.handle(agentRequest(transport, other.token, input)),
          transport,
        ),
      ).toMatchObject({ result: { articleId: 'isolated-read' } });
    });

    it('refuses another valid same-owner grant substituted during an actual private read', async () => {
      const f = await fixture();
      await f.knowledge.application.createDraft(
        await f.access(),
        f.createInput('read-header-swap'),
      );
      const other = await f.device();
      const blocked = f.block('afterKbRead');
      const request = agentRequest(
        transport,
        f.credential.token,
        JSON.stringify(
          wire(transport, 'getDraft', { articleId: 'read-header-swap' }),
        ),
      );
      const pending = f.knowledge.handle(request);
      await Promise.race([
        blocked.entered,
        pending.then(() => {
          throw new Error('Expected the actual read barrier.');
        }),
      ]);
      try {
        request.headers.set('Authorization', 'Bearer ' + other.token);
      } finally {
        blocked.finish();
      }
      const result = await logicalResponse(await pending, transport);
      expect(result).toMatchObject({ error: { code: 'forbidden' } });
      expect(JSON.stringify(result)).not.toContain(draft.content.text);
    });

    it.each(['grant', 'role'] as const)(
      'withholds private draft content after %s revocation during a real KB read',
      async (kind) => {
        const f = await fixture();
        await f.knowledge.application.createDraft(
          await f.access(),
          f.createInput('read-race'),
        );
        const blocked = f.block('afterKbRead');
        const pending = f.knowledge.handle(
          agentRequest(
            transport,
            f.credential.token,
            JSON.stringify(
              wire(transport, 'getDraft', { articleId: 'read-race' }),
            ),
          ),
        );
        await blocked.entered;
        try {
          await f.revoke(kind);
        } finally {
          blocked.finish();
        }
        const result = await logicalResponse(await pending, transport);
        expect(result).toMatchObject({ error: { code: 'forbidden' } });
        expect(JSON.stringify(result)).not.toContain(draft.content.text);
      },
    );

    it('queues a report through the actual configured protocol without accepting KB evidence', async () => {
      const f = await fixture();
      const input = await f.reportInput('report-allowed');
      const result = await logicalResponse(
        await f.knowledge.handle(
          agentRequest(
            transport,
            f.credential.token,
            JSON.stringify(wire(transport, 'submitEvidence', input)),
          ),
        ),
        transport,
      );
      expect(result).toMatchObject({
        operation: 'submitEvidence',
        result: { kind: 'pending-human-review' },
      });
      expect(JSON.stringify(result)).not.toContain(input.report.details);
      const retained = await f.knowledge.evidence.list(await f.access(), {
        articleId: input.articleId,
      });
      expect(retained.reports).toHaveLength(1);
      const queued = retained.reports[0];
      if (queued === undefined)
        throw new Error('Expected the actual queued report.');
      expect(queued).toMatchObject({ status: 'pending', submittedBy: ownerId });
      const status = await logicalResponse(
        await f.knowledge.handle(
          agentRequest(
            transport,
            f.credential.token,
            JSON.stringify(
              wire(transport, 'getValidationRequirements', {
                collectionId,
                kind: draft.kind,
                articleId: input.articleId,
                reportLookup: {
                  ledgerEpoch: queued.ledgerEpoch,
                  reportId: queued.reportId,
                },
              }),
            ),
          ),
        ),
        transport,
      );
      expect(status).toMatchObject({
        result: {
          reportLedger: { ledgerEpoch: queued.ledgerEpoch, status: 'active' },
          reportStatus: { reportId: queued.reportId, status: 'pending' },
        },
      });
      expect(JSON.stringify(status)).not.toContain(input.report.details);
      expect(JSON.stringify(status)).not.toContain(ownerId);
      expect(
        (
          await f.knowledge.application.getEvidence(await f.access(), {
            articleId: input.articleId,
          })
        ).evidence,
      ).toHaveLength(0);
    });

    it('preserves native shared report not-found and epoch-conflict errors at the real protocol boundary', async () => {
      const f = await fixture();
      const input = await f.reportInput('report-errors');
      const missing = await logicalResponse(
        await f.knowledge.handle(
          agentRequest(
            transport,
            f.credential.token,
            JSON.stringify(
              wire(transport, 'getValidationRequirements', {
                collectionId,
                kind: draft.kind,
                articleId: input.articleId,
                reportLookup: {
                  ledgerEpoch: input.ledgerEpoch,
                  reportId: '00000000-0000-4000-8000-000000000000',
                },
              }),
            ),
          ),
        ),
        transport,
      );
      expect(missing).toMatchObject({
        error: { code: 'not_found', status: 404 },
      });
      const stale = await logicalResponse(
        await f.knowledge.handle(
          agentRequest(
            transport,
            f.credential.token,
            JSON.stringify(
              wire(transport, 'submitEvidence', {
                ...input,
                ledgerEpoch: input.ledgerEpoch + 1,
              }),
            ),
          ),
        ),
        transport,
      );
      expect(stale).toMatchObject({ error: { code: 'conflict', status: 409 } });
      expect(
        (
          await f.knowledge.evidence.list(await f.access(), {
            articleId: input.articleId,
          })
        ).reports,
      ).toHaveLength(0);
    });

    it.each(['grant', 'role'] as const)(
      'refuses a report after %s revocation while its actual request body is pending',
      async (kind) => {
        const f = await fixture();
        const input = await f.reportInput('report-body-race');
        const body = delayedBody(wire(transport, 'submitEvidence', input));
        const pending = f.knowledge.handle(
          agentRequest(transport, f.credential.token, body.stream),
        );
        await body.reading;
        try {
          await f.revoke(kind);
        } finally {
          body.finish();
        }
        expect(await logicalResponse(await pending, transport)).toMatchObject({
          error: { code: 'forbidden' },
        });
        expect(
          (
            await f.knowledge.evidence.list(await f.access(), {
              articleId: input.articleId,
            })
          ).reports,
        ).toHaveLength(0);
      },
    );

    it.each(['grant', 'role'] as const)(
      'withholds the report acknowledgement after %s revocation at a real committed report write',
      async (kind) => {
        const f = await fixture();
        const input = await f.reportInput('report-commit-race');
        const blocked = f.block('afterReportCommit');
        const pending = f.knowledge.handle(
          agentRequest(
            transport,
            f.credential.token,
            JSON.stringify(wire(transport, 'submitEvidence', input)),
          ),
        );
        await blocked.entered;
        try {
          await f.revoke(kind);
        } finally {
          blocked.finish();
        }
        const result = await logicalResponse(await pending, transport);
        expect(result).toMatchObject({ error: { code: 'forbidden' } });
        expect(JSON.stringify(result)).not.toContain('pending-human-review');
        const retained = await f.knowledge.evidence.list(await f.access(), {
          articleId: input.articleId,
        });
        expect(retained.reports).toHaveLength(1);
        expect(retained.reports[0]).toMatchObject({
          status: 'pending',
          submittedBy: ownerId,
        });
        expect(
          (
            await f.knowledge.application.getEvidence(await f.access(), {
              articleId: input.articleId,
            })
          ).evidence,
        ).toHaveLength(0);
      },
    );

    it.each([
      { kind: 'grant', failRead: false },
      { kind: 'role', failRead: false },
      { kind: 'grant', failRead: true },
      { kind: 'role', failRead: true },
    ] as const)(
      'withholds a committed report ACK on late $kind revocation during its final read (read failure=$failRead)',
      async ({ kind, failRead }) => {
        const f = await fixture();
        const input = await f.reportInput('deferred-report-final-read');
        const committed = f.block('afterReportCommit');
        const pending = f.knowledge.handle(
          agentRequest(
            transport,
            f.credential.token,
            JSON.stringify(wire(transport, 'submitEvidence', input)),
          ),
        );
        await committed.entered;
        const finalRead = f.block('afterKbRead', undefined, failRead);
        committed.finish();
        await finalRead.entered;
        try {
          await f.revoke(kind);
        } finally {
          finalRead.finish();
        }
        const result = await logicalResponse(await pending, transport);
        expect(result).toMatchObject({ error: { code: 'forbidden' } });
        expect(JSON.stringify(result)).not.toContain('pending-human-review');
        expect(JSON.stringify(result)).not.toContain('failure canary');
        expect(JSON.stringify(result)).not.toContain(input.report.details);
        const retained = await f.knowledge.evidence.list(await f.access(), {
          articleId: input.articleId,
        });
        expect(retained.reports).toHaveLength(1);
        expect(retained.reports[0]).toMatchObject({
          status: 'pending',
          submittedBy: ownerId,
        });
        expect(
          (
            await f.knowledge.application.getEvidence(await f.access(), {
              articleId: input.articleId,
            })
          ).evidence,
        ).toEqual([]);
      },
    );

    it.each(['grant', 'role'] as const)(
      'withholds the private ledger after %s revocation during its real namespace read',
      async (kind) => {
        const f = await fixture();
        const input = await f.reportInput('ledger-read-race');
        const blocked = f.block('afterReportRead');
        const pending = f.knowledge.handle(
          agentRequest(
            transport,
            f.credential.token,
            JSON.stringify(
              wire(transport, 'getValidationRequirements', {
                collectionId,
                kind: draft.kind,
                articleId: input.articleId,
              }),
            ),
          ),
        );
        await blocked.entered;
        try {
          await f.revoke(kind);
        } finally {
          blocked.finish();
        }
        const result = await logicalResponse(await pending, transport);
        expect(result).toMatchObject({ error: { code: 'forbidden' } });
        expect(result.result).toBeUndefined();
        expect(JSON.stringify(result)).not.toContain('reportLedger');
      },
    );

    it.each(['grant', 'role'] as const)(
      'withholds report status after %s revocation during the actual report-row read',
      async (kind) => {
        const f = await fixture();
        const { input, acknowledgement } =
          await f.queueReport('status-read-race');
        const blocked = f.block('afterReportRead', acknowledgement.reportId);
        const pending = f.knowledge.handle(
          agentRequest(
            transport,
            f.credential.token,
            JSON.stringify(
              wire(transport, 'getValidationRequirements', {
                collectionId,
                kind: draft.kind,
                articleId: input.articleId,
                reportLookup: {
                  ledgerEpoch: acknowledgement.ledgerEpoch,
                  reportId: acknowledgement.reportId,
                },
              }),
            ),
          ),
        );
        await blocked.entered;
        try {
          await f.revoke(kind);
        } finally {
          blocked.finish();
        }
        const result = await logicalResponse(await pending, transport);
        expect(result).toMatchObject({ error: { code: 'forbidden' } });
        expect(result.result).toBeUndefined();
        expect(JSON.stringify(result)).not.toContain(acknowledgement.receipt);
        expect(JSON.stringify(result)).not.toContain(input.report.details);
      },
    );
  },
);

it('binds the original request to its actual grant even when another valid token has the same owner/client/resource', async () => {
  const f = await fixture();
  const other = await f.device();
  expect(other.grantId).not.toBe(f.credential.grantId);
  const body = delayedBody(
    wire('http', 'createDraft', f.createInput('grant-swap')),
  );
  const request = agentRequest('http', f.credential.token, body.stream);
  const pending = f.knowledge.handle(request);
  await body.reading;
  request.headers.set('Authorization', 'Bearer ' + other.token);
  body.finish();
  expect(await logicalResponse(await pending, 'http')).toMatchObject({
    error: { code: 'forbidden' },
  });
  await expect(
    f.knowledge.application.getDraft(await f.access(), {
      articleId: 'grant-swap',
    }),
  ).rejects.toBeInstanceOf(KnowledgeBaseNotFoundError);
});

it('binds the exact original authorization header even when its replacement authenticates the same actual grant', async () => {
  const f = await fixture();
  const input = await f.reportInput('report-header-race');
  const body = delayedBody(wire('http', 'submitEvidence', input));
  const request = agentRequest('http', f.credential.token, body.stream);
  const pending = f.knowledge.handle(request);
  await body.reading;
  request.headers.set('Authorization', 'bearer ' + f.credential.token);
  try {
    const replacement = await f.agents.protectedResource.authenticate(request);
    if (replacement instanceof Response)
      throw new Error('Expected the same actual grant.');
    expect(replacement.grantId).toBe(f.credential.grantId);
  } finally {
    body.finish();
  }
  expect(await logicalResponse(await pending, 'http')).toMatchObject({
    error: { code: 'forbidden' },
  });
  expect(
    (
      await f.knowledge.evidence.list(await f.access(), {
        articleId: input.articleId,
      })
    ).reports,
  ).toHaveLength(0);
});

it('withholds a completed write acknowledgement after revocation without claiming that the accepted write rolled back', async () => {
  const f = await fixture();
  const blocked = f.block('afterKbCommit');
  const pending = f.knowledge.handle(
    agentRequest(
      'http',
      f.credential.token,
      JSON.stringify(
        wire('http', 'createDraft', f.createInput('accepted-before-revoke')),
      ),
    ),
  );
  await blocked.entered;
  try {
    await f.revoke('grant');
  } finally {
    blocked.finish();
  }
  expect(await logicalResponse(await pending, 'http')).toMatchObject({
    error: { code: 'forbidden' },
  });
  expect(
    await f.knowledge.application.getDraft(await f.access(), {
      articleId: 'accepted-before-revoke',
    }),
  ).toMatchObject({
    articleId: 'accepted-before-revoke',
    revision: { number: 1 },
  });
});
