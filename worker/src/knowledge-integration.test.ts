import { identityLinkKeyFromVerifiedIdentityClaims } from '@pegma/authorization-identity';
import { createRoleStore } from '@pegma/authorization-storage';
import type {
  ApprovalView,
  PublicClient,
  TokenResult,
} from '@pegma/agent-access';
import {
  knowledgeAgentScopes,
  knowledgeAgentToolNames,
} from '@pegma/knowledge-base-mcp';
import type {
  ArticleDraft,
  EvidenceSubmission,
} from '@pegma/knowledge-base-core';
import { articleKinds } from '@pegma/knowledge-base-contracts';
import {
  KnowledgeBaseAuthorizationError,
  type ArticleAcknowledgement,
  type CommandResult,
  type DraftArticleDto,
  type CollectionAcknowledgement,
  type CollectionPolicyPreviewDto,
  type ReviewDto,
  type EvidenceDto,
  type ValidationRequirementsDto,
} from '@pegma/knowledge-base-application';
import { createSessionStore } from '@pegma/sessions';
import { createMemoryStore, type Store } from '@pegma/storage-core';
import { type IsoTimestamp, type Logger, type PrincipalId } from '@pegma/spine';
import { describe, expect, it, vi } from 'vitest';
import { createAgentAccessRuntime } from './agent-access-runtime';
import { IDENTITY_ISSUER, SESSION_COOKIE } from './identity-api';
import type { IdentityPort, IdentityUser } from './identity-contracts';
import {
  ADMIN_ROLE,
  APPLICATION_SCOPE,
  AUTHORIZATION_APPLICATION_ID,
  SUPPORT_ROLE,
} from './support-access';
import { createSupportApi } from './support-api';
import { createSupportRuntime } from './support-desk';
import { createKnowledgeRuntime } from './knowledge-runtime';
import type { KnowledgeReportView } from './knowledge-evidence';

const owner = 'integration-agent-owner' as PrincipalId;
const reviewer = 'integration-report-reviewer' as PrincipalId;
const member = 'integration-member' as PrincipalId;
const runner = 'integration-test-runner' as PrincipalId;
const resource = 'https://pegma.dev/api/knowledge/mcp';
const scopes = Object.values(knowledgeAgentScopes);
type EvidenceCheck = Pick<
  ValidationRequirementsDto['checks'][number],
  'id' | 'testKind'
>;
const workflowCheck: EvidenceCheck = {
  id: 'walkthrough-workflow',
  testKind: 'workflow',
};
const client: PublicClient = {
  clientId: 'synthetic-knowledge-client',
  name: 'Synthetic integration client',
  redirectUris: ['https://client.example.test/callback'],
  allowedScopes: scopes,
  grantTypes: ['device_code', 'authorization_code'],
};

interface BrowserSession {
  readonly cookie: string;
  readonly csrfToken: string;
}

function user(principalId: PrincipalId): IdentityUser {
  return {
    principalId,
    email: `${principalId}@example.test`,
    emailVerified: true,
    status: 'active',
    createdAt: '2026-11-08T12:00:00.000Z',
    updatedAt: '2026-11-08T12:00:00.000Z',
  };
}

function browserRequest(
  path: string,
  auth: BrowserSession,
  body?: unknown,
  method = 'POST',
): Request {
  return new Request(`${IDENTITY_ISSUER}${path}`, {
    method,
    headers: {
      Cookie: auth.cookie,
      Origin: IDENTITY_ISSUER,
      'Sec-Fetch-Site': 'same-origin',
      'X-Pegma-CSRF': auth.csrfToken,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function formRequest(path: string, values: Record<string, string>): Request {
  return new Request(`${IDENTITY_ISSUER}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values),
  });
}

async function integrationFixture(store: Store = createMemoryStore()) {
  let now = Date.parse('2026-11-08T12:00:00.000Z');
  const clock = { now: () => new Date(now).toISOString() as IsoTimestamp };
  const logger: Logger = { log: vi.fn() };
  const sessions = createSessionStore(store, { logger, clock });
  const roleStore = createRoleStore(store, AUTHORIZATION_APPLICATION_ID);
  const users = new Map<PrincipalId, IdentityUser>(
    [owner, reviewer, member].map((id) => [id, user(id)] as const),
  );
  // Identity is the existing external authentication boundary. Sessions,
  // audited role assignments, OAuth grants and KB state use real packages.
  const identity: IdentityPort = {
    claimsFor: vi.fn(async (id: PrincipalId) => {
      const current = users.get(id);
      if (current === undefined)
        throw Object.assign(new Error('missing'), { code: 'not_found' });
      if (!current.emailVerified)
        throw Object.assign(new Error('unverified'), { code: 'invalid_state' });
      return {
        issuer: IDENTITY_ISSUER,
        subject: id,
        emailVerified: true as const,
      };
    }),
    getUser: vi.fn(async (id: PrincipalId) => users.get(id) ?? null),
    findUserByEmail: vi.fn(async () => null),
    beginPasskeyRegistration: vi.fn(),
    finishPasskeyRegistration: vi.fn(),
    beginPasskeyAuthentication: vi.fn(),
    finishPasskeyAuthentication: vi.fn(),
    listPasskeys: vi.fn(async () => []),
    removePasskey: vi.fn(async () => true),
  };
  async function grant(
    id: PrincipalId,
    role: typeof ADMIN_ROLE | typeof SUPPORT_ROLE = ADMIN_ROLE,
  ) {
    const assignmentId = `${role}-${id}`;
    const result = await roleStore.grantRoleAssignmentWithAudit({
      assignment: {
        id: assignmentId,
        principalId: id,
        role,
        scope: APPLICATION_SCOPE,
        grantedBy: { kind: 'system', systemId: 'synthetic-test-setup' },
        grantedAtEpochMs: now,
        status: 'active',
      },
      auditEventId: `grant-${assignmentId}`,
    });
    expect(result.status).toBe('granted');
    return assignmentId;
  }
  await grant(owner);
  await grant(reviewer);
  await grant(member, SUPPORT_ROLE);
  const configuredAgents = createAgentAccessRuntime({
    store,
    sessions,
    identity,
    roleStore,
    logger,
    clock,
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
    clients: [client],
  });
  if (configuredAgents === null)
    throw new Error(
      'Synthetic registered client must enable the integration runtime.',
    );
  const agents = configuredAgents;
  const knowledge = createKnowledgeRuntime({
    store,
    clock,
    sessions,
    identity,
    roleStore,
    logger,
    agentAccess: agents,
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
  });
  async function knowledgeRequest(request: Request): Promise<Response> {
    const response = await knowledge.handle(request);
    if (response === null)
      throw new Error(
        `No knowledge route for ${new URL(request.url).pathname}`,
      );
    return response;
  }
  function staff(operation: string, input: unknown, auth = reviewerAuth) {
    return knowledgeRequest(
      browserRequest('/api/staff/knowledge/command', auth, {
        operation,
        input,
      }),
    );
  }
  async function staffValue<T>(operation: string, input: unknown): Promise<T> {
    const response = await staff(operation, input);
    expect(response.status, operation).toBe(200);
    return (await response.json()) as T;
  }
  function agent(token: string, operation: string, input: unknown) {
    return knowledgeRequest(
      new Request('https://pegma.dev/api/knowledge/v1', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ apiVersion: '1', operation, input }),
      }),
    );
  }
  function mcp(token: string, method: string, params: unknown) {
    return knowledgeRequest(
      new Request(resource, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2025-06-18',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }),
    );
  }
  async function configure() {
    const stateResponse = await knowledgeRequest(
      browserRequest(
        '/api/staff/knowledge/state',
        reviewerAuth,
        undefined,
        'GET',
      ),
    );
    expect(stateResponse.status).toBe(200);
    const state = (await stateResponse.json()) as { attesterId: PrincipalId };
    const collection = await staffValue<
      CommandResult<CollectionAcknowledgement>
    >('createCollection', {
      commandId: 'create-integration-collection',
      correlationId: 'integration',
      expectedGeneration: 0,
      collectionId: 'integration-guides',
      name: 'Synthetic integration guides',
    });
    await staffValue('putValidationPolicy', {
      commandId: 'create-integration-validation',
      correlationId: 'integration',
      expectedGeneration: 0,
      policy: {
        id: 'integration-validation',
        version: 1,
        requirements: [
          ...articleKinds.map((kind) => ({
            id: `${kind}-content`,
            kind,
            testKind: 'content',
            maxAgeMilliseconds: 3_600_000,
            trustedRunnerIds: [runner],
          })),
          {
            id: workflowCheck.id,
            kind: 'walkthrough',
            testKind: workflowCheck.testKind,
            maxAgeMilliseconds: 3_600_000,
            trustedRunnerIds: [runner],
          },
        ],
      },
    });
    await staffValue('putGovernanceConfiguration', {
      commandId: 'configure-integration-governance',
      correlationId: 'integration',
      expectedGeneration: collection.value.generation,
      collectionId: 'integration-guides',
      configuration: {
        validationPolicy: { id: 'integration-validation', version: 1 },
        expectedStagingBuildId: 'integration-build-1',
        trustedAttesterIds: [state.attesterId],
      },
    });
    const preview = await staffValue<CollectionPolicyPreviewDto>(
      'previewCollectionPolicy',
      {
        collectionId: 'integration-guides',
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
    );
    await staffValue('updateCollectionPolicy', {
      commandId: 'enable-protected-integration-guides',
      correlationId: 'integration',
      expectedGeneration: preview.generation,
      collectionId: 'integration-guides',
      preview: preview.preview,
    });
  }
  async function session(id: PrincipalId): Promise<BrowserSession> {
    const sessionId = `${crypto.randomUUID().replaceAll('-', '')}${'s'.repeat(11)}`;
    const csrfToken = 'c'.repeat(43);
    await sessions.create(sessionId, {
      principalId: id,
      data: JSON.stringify({
        version: 1,
        csrfToken,
        issuer: IDENTITY_ISSUER,
        subject: id,
      }),
    });
    return { cookie: `${SESSION_COOKIE}=${sessionId}`, csrfToken };
  }
  async function agentRequest(request: Request): Promise<Response> {
    const protocol = await agents.protocol.handle(request);
    if (protocol !== null) return protocol;
    const response = await agents.api(request);
    if (response === null)
      throw new Error(`No agent route for ${new URL(request.url).pathname}`);
    return response;
  }
  async function device(auth = ownerAuth) {
    const begun = await agentRequest(
      formRequest('/api/agent-access/device-authorizations', {
        client_id: client.clientId,
        resource,
        scope: scopes.join(' '),
      }),
    );
    expect(begun.status).toBe(200);
    const request = (await begun.json()) as {
      user_code: string;
      device_code: string;
      interval: number;
    };
    const viewed = await agentRequest(
      browserRequest(
        `/api/agent-access/approval?user_code=${encodeURIComponent(request.user_code)}`,
        auth,
        undefined,
        'GET',
      ),
    );
    expect(viewed.status).toBe(200);
    const approval = (await viewed.json()) as ApprovalView;
    expect(approval.requestedScopes.map((scope) => scope.name)).toEqual(scopes);
    const approved = await agentRequest(
      browserRequest('/api/agent-access/approval', auth, {
        requestId: approval.requestId,
        userCode: request.user_code,
        decision: 'approve',
        approvedScopes: scopes,
      }),
    );
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual({
      flow: 'device_code',
      approved: true,
    });
    now += request.interval * 1000;
    const issued = await agentRequest(
      formRequest('/api/agent-access/token', {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: client.clientId,
        resource,
        device_code: request.device_code,
      }),
    );
    expect(issued.status).toBe(200);
    const token = (await issued.json()) as TokenResult;
    expect(token.scope.split(' ')).toEqual(scopes);
    return { token, approval };
  }
  async function pkce() {
    const verifier = 'p'.repeat(64);
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(verifier),
    );
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '');
    const values = new URLSearchParams({
      response_type: 'code',
      client_id: client.clientId,
      redirect_uri: client.redirectUris[0]!,
      resource,
      scope: scopes.join(' '),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'synthetic-client-state',
    });
    const begun = await agentRequest(
      browserRequest(
        `/api/agent-access/authorize?${values}`,
        ownerAuth,
        undefined,
        'GET',
      ),
    );
    expect(begun.status).toBe(303);
    const approvalUrl = new URL(begun.headers.get('Location')!);
    const requestId = approvalUrl.searchParams.get('request_id');
    expect(requestId).not.toBeNull();
    const viewed = await agentRequest(
      browserRequest(
        `/api/agent-access/approval?request_id=${encodeURIComponent(requestId!)}`,
        ownerAuth,
        undefined,
        'GET',
      ),
    );
    const approval = (await viewed.json()) as ApprovalView;
    expect(approval.requestedScopes.map((scope) => scope.name)).toEqual(scopes);
    const approved = await agentRequest(
      browserRequest('/api/agent-access/approval', ownerAuth, {
        requestId: approval.requestId,
        decision: 'approve',
        approvedScopes: scopes,
      }),
    );
    expect(approved.status).toBe(200);
    const consent = (await approved.json()) as {
      flow: 'authorization_code';
      redirectUri: string;
    };
    const redirect = new URL(consent.redirectUri);
    expect(redirect.origin + redirect.pathname).toBe(client.redirectUris[0]);
    expect(redirect.searchParams.get('state')).toBe('synthetic-client-state');
    expect(redirect.searchParams.get('iss')).toBe(IDENTITY_ISSUER);
    const exchange = (codeVerifier: string) =>
      agentRequest(
        formRequest('/api/agent-access/token', {
          grant_type: 'authorization_code',
          client_id: client.clientId,
          resource,
          code: redirect.searchParams.get('code')!,
          redirect_uri: client.redirectUris[0]!,
          code_verifier: codeVerifier,
        }),
      );
    const rejected = await exchange('incorrect-verifier'.repeat(4));
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: 'invalid_grant' });
    const issued = await exchange(verifier);
    expect(issued.status).toBe(200);
    const token = (await issued.json()) as TokenResult;
    expect(token.scope.split(' ')).toEqual(scopes);
    expect((await exchange(verifier)).status).toBe(400);
    return { token, approval };
  }
  const ownerAuth = await session(owner);
  const reviewerAuth = await session(reviewer);
  const memberAuth = await session(member);
  return {
    store,
    clock,
    logger,
    sessions,
    roleStore,
    users,
    identity,
    agents,
    knowledge,
    ownerAuth,
    reviewerAuth,
    memberAuth,
    agentRequest,
    knowledgeRequest,
    staff,
    staffValue,
    agent,
    mcp,
    configure,
    device,
    pkce,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

function draft(overrides: Partial<ArticleDraft> = {}): ArticleDraft {
  return {
    kind: 'walkthrough',
    title: 'Run the synthetic export',
    summary: 'A synthetic staging walkthrough.',
    content: {
      format: 'markdown',
      text: '1. Open the staging fixture.\n2. Export the synthetic guide.\n3. Verify its contents.',
    },
    tags: ['integration'],
    applicability: {
      productId: 'pegma-integration',
      productVersion: '1.0.0',
      buildId: 'integration-build-1',
    },
    ...overrides,
  };
}

async function createAgentDraft(
  f: Awaited<ReturnType<typeof integrationFixture>>,
  token: string,
) {
  await f.configure();
  const created = await f.agent(token, 'createDraft', {
    commandId: 'agent-create-draft',
    correlationId: 'integration',
    expectedGeneration: 0,
    articleId: 'integration-article',
    collectionId: 'integration-guides',
    draft: draft(),
  });
  expect(created.status).toBe(200);
  const response = (await created.json()) as {
    result: CommandResult<ArticleAcknowledgement>;
  };
  expect(response.result.value.articleRevision).toBe(1);
  return response.result.value;
}

function evidenceFor(
  article: DraftArticleDto,
  executedAt: IsoTimestamp,
  check: EvidenceCheck = workflowCheck,
): EvidenceSubmission {
  return {
    id: `integration-evidence:${check.id}`,
    articleId: article.articleId,
    articleRevision: article.revision.number,
    contentHash: article.revision.contentHash,
    validationPolicy: article.revision.validationPolicy,
    checkId: check.id,
    testKind: check.testKind,
    applicability: article.revision.applicability,
    stagingBuildId: 'integration-build-1',
    steps:
      check.testKind === 'content'
        ? [
            'Read the full synthetic guide',
            'Check the stated prerequisites and steps',
            'Confirm the guide contains no private report data',
          ]
        : [
            'Open the staging fixture',
            'Export the guide',
            'Compare the synthetic output',
          ],
    result: 'passed',
    executedAt,
    runnerId: runner,
    artifacts: [{ id: 'synthetic-output-report', hash: 'a'.repeat(64) }],
  };
}

async function submitReport(
  f: Awaited<ReturnType<typeof integrationFixture>>,
  token: string,
  articleId: string,
  check: EvidenceCheck = workflowCheck,
) {
  const read = await f.agent(token, 'getDraft', { articleId });
  const article = ((await read.json()) as { result: DraftArticleDto }).result;
  const evidence = evidenceFor(article, f.clock.now(), check);
  const submitted = await f.knowledgeRequest(
    new Request('https://pegma.dev/api/knowledge/reports', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        commandId: `submit-synthetic-report:${check.id}`,
        articleId,
        evidence,
        report: {
          summary: `Synthetic ${check.testKind} check passed`,
          details:
            'The independent fixture report records the steps, output comparison and synthetic artifact. This is test data.',
        },
      }),
    }),
  );
  expect(submitted.status).toBe(200);
  const report = (await submitted.json()) as {
    reportId: string;
    receipt: string;
    reportGeneration: number;
  };
  const viewed = await f.staffValue<KnowledgeReportView>('reportRead', {
    articleId,
    reportId: report.reportId,
  });
  expect(viewed.submittedBy).toBe(owner);
  expect(viewed.evidence).toEqual(evidence);
  expect(viewed.articleId).toBe(articleId);
  const confirm = {
    commandId: `confirm-synthetic-report:${check.id}`,
    articleId,
    reportId: report.reportId,
    expectedReportGeneration: viewed.expectedReportGeneration,
    reviewBindingHash: viewed.reviewBindingHash,
  };
  return { article, evidence, report, viewed, confirm };
}

async function confirmedReport(
  f: Awaited<ReturnType<typeof integrationFixture>>,
  token: string,
  articleId: string,
  check: EvidenceCheck = workflowCheck,
) {
  const prepared = await submitReport(f, token, articleId, check);
  const confirmation = await f.staff('confirmReport', prepared.confirm);
  expect(confirmation.status).toBe(200);
  const reviewed = await f.staffValue<KnowledgeReportView>('reportRead', {
    articleId,
    reportId: prepared.report.reportId,
  });
  expect(reviewed.status).toBe('confirmed');
  return prepared;
}

describe('released Agent Access and KB host integration over Memory Store', () => {
  it('completes existing-session device consent with exactly three restricted scopes', async () => {
    const f = await integrationFixture();
    const { token, approval } = await f.device();
    const delegated = await f.agents.service.authenticate({
      token: token.access_token,
      resource,
    });
    expect(delegated.access.principalId).toBe(owner);
    expect(delegated.access.roles).toEqual([]);
    expect(delegated.access.entitlements).toEqual([]);
    expect(delegated.access.permissions).toEqual(scopes);
    expect(approval.flow).toBe('device_code');
    const grant = await f.agentRequest(
      browserRequest(
        `/api/agent-access/grants/${delegated.grantId}`,
        f.ownerAuth,
        undefined,
        'GET',
      ),
    );
    expect(grant.status).toBe(200);
    expect(await grant.json()).toMatchObject({
      ownerId: owner,
      status: 'active',
      resource,
    });
  });

  it('completes actual PKCE consent, binds the verifier, and consumes the authorization code once', async () => {
    const f = await integrationFixture();
    const { token } = await f.pkce();
    const delegated = await f.agents.service.authenticate({
      token: token.access_token,
      resource,
    });
    expect(delegated.scopes).toEqual(scopes);
    expect(delegated.access.permissions).toEqual(scopes);
  });

  it.each(['device', 'pkce'] as const)(
    'uses a real %s grant to create and read HTTP drafts and update the same draft through MCP',
    async (flow) => {
      const f = await integrationFixture();
      const { token } = await f[flow]();
      const created = await createAgentDraft(f, token.access_token);
      const initialized = await f.mcp(token.access_token, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'synthetic-integration', version: '1' },
      });
      expect(initialized.status).toBe(200);
      expect(await initialized.json()).toMatchObject({
        result: { capabilities: { tools: {} } },
      });
      const tools = await f.mcp(token.access_token, 'tools/list', {});
      expect(tools.status).toBe(200);
      const listed = (await tools.json()) as {
        result: { tools: { name: string }[] };
      };
      expect(listed.result.tools.map((tool) => tool.name)).toEqual(
        Object.values(knowledgeAgentToolNames),
      );
      const read = await f.mcp(token.access_token, 'tools/call', {
        name: knowledgeAgentToolNames.getDraft,
        arguments: { articleId: created.id },
      });
      const readRpc = (await read.json()) as {
        result: { isError: boolean; content: { text: string }[] };
      };
      expect(readRpc.result.isError).toBe(false);
      expect(JSON.parse(readRpc.result.content[0]!.text)).toMatchObject({
        result: { articleId: created.id, revision: { number: 1 } },
      });
      const updated = await f.mcp(token.access_token, 'tools/call', {
        name: knowledgeAgentToolNames.updateDraft,
        arguments: {
          commandId: 'agent-mcp-update',
          correlationId: 'integration',
          expectedGeneration: created.generation,
          articleId: created.id,
          collectionId: 'integration-guides',
          draft: draft({ title: 'Updated synthetic export walkthrough' }),
        },
      });
      expect(updated.status).toBe(200);
      const updateRpc = (await updated.json()) as {
        result: { isError: boolean; content: { text: string }[] };
      };
      expect(updateRpc.result.isError).toBe(false);
      expect(JSON.parse(updateRpc.result.content[0]!.text)).toMatchObject({
        result: { value: { articleRevision: 2 } },
      });
      const current = await f.agent(token.access_token, 'getDraft', {
        articleId: created.id,
      });
      expect(current.status).toBe(200);
      const currentArticle = (await current.json()) as {
        result: DraftArticleDto;
      };
      expect(currentArticle.result.revision.title).toBe(
        'Updated synthetic export walkthrough',
      );
      expect(currentArticle.result.revision.createdBy).toBe(owner);
      expect(currentArticle.result.hasPublication).toBe(false);
      for (const operation of [
        'publishArticle',
        'submitForReview',
        'getReview',
        'getProvenance',
        'setProvenance',
        'createCollection',
      ]) {
        const refused = await f.agent(token.access_token, operation, {
          articleId: created.id,
        });
        expect(refused.status).toBe(400);
        expect(await refused.json()).toMatchObject({
          error: { code: 'invalid_request' },
        });
      }
      const delegated = await f.agents.service.authenticate({
        token: token.access_token,
        resource,
      });
      await expect(
        f.knowledge.application.getProvenance(delegated.access, {
          articleId: created.id,
        }),
      ).rejects.toBeInstanceOf(KnowledgeBaseAuthorizationError);
      await expect(
        f.knowledge.application.getReview(delegated.access, {
          articleId: created.id,
        }),
      ).rejects.toBeInstanceOf(KnowledgeBaseAuthorizationError);
      await expect(
        f.knowledge.application.submitForReview(delegated.access, {
          articleId: created.id,
          commandId: 'agent-review-denied',
          correlationId: 'integration',
          expectedGeneration: currentArticle.result.generation,
        }),
      ).rejects.toBeInstanceOf(KnowledgeBaseAuthorizationError);
      const provenanceWrite = await f.agent(token.access_token, 'updateDraft', {
        commandId: 'agent-provenance-denied',
        correlationId: 'integration',
        expectedGeneration: currentArticle.result.generation,
        articleId: created.id,
        collectionId: 'integration-guides',
        draft: draft(),
        sourceReferences: [
          {
            id: 'agent-supplied-source',
            system: 'untrusted',
            resourceId: 'untrusted-source',
            version: '1',
          },
        ],
      });
      expect(provenanceWrite.status).toBe(400);
      const afterRefusal = await f.agent(token.access_token, 'getDraft', {
        articleId: created.id,
      });
      expect(
        ((await afterRefusal.json()) as { result: DraftArticleDto }).result
          .generation,
      ).toBe(currentArticle.result.generation);
    },
  );

  it('requires independent staff report confirmation before scoped evidence submission and human publication', async () => {
    const f = await integrationFixture();
    const { token } = await f.device();
    const created = await createAgentDraft(f, token.access_token);
    const prepared = await submitReport(f, token.access_token, created.id);
    const unconfirmed = await f.agent(token.access_token, 'submitEvidence', {
      commandId: 'unconfirmed-evidence-refused',
      correlationId: 'integration',
      expectedGeneration: prepared.article.generation,
      articleId: created.id,
      evidence: prepared.evidence,
      receipt: prepared.report.receipt,
    });
    expect(unconfirmed.status).toBe(412);
    expect(await unconfirmed.json()).toMatchObject({
      error: { code: 'prerequisite' },
    });
    const selfConfirmation = await f.knowledgeRequest(
      new Request('https://pegma.dev/api/staff/knowledge/command', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          operation: 'confirmReport',
          input: prepared.confirm,
        }),
      }),
    );
    expect(selfConfirmation.status).toBe(403);
    const mixedCredential = browserRequest(
      '/api/staff/knowledge/command',
      f.ownerAuth,
      { operation: 'confirmReport', input: prepared.confirm },
    );
    mixedCredential.headers.set(
      'Authorization',
      `Bearer ${token.access_token}`,
    );
    expect((await f.knowledgeRequest(mixedCredential)).status).toBe(403);
    const missingCsrf = browserRequest(
      '/api/staff/knowledge/command',
      f.reviewerAuth,
      { operation: 'confirmReport', input: prepared.confirm },
    );
    missingCsrf.headers.delete('X-Pegma-CSRF');
    expect((await f.knowledgeRequest(missingCsrf)).status).toBe(403);
    expect((await f.staff('confirmReport', prepared.confirm)).status).toBe(200);
    const fresh = await f.agent(token.access_token, 'getDraft', {
      articleId: created.id,
    });
    const current = ((await fresh.json()) as { result: DraftArticleDto })
      .result;
    const evidenceCommand = {
      commandId: 'confirmed-evidence-accepted',
      correlationId: 'integration',
      expectedGeneration: current.generation,
      articleId: created.id,
      evidence: prepared.evidence,
      receipt: prepared.report.receipt,
    };
    const accepted = await f.agent(
      token.access_token,
      'submitEvidence',
      evidenceCommand,
    );
    expect(accepted.status).toBe(200);
    const acknowledgement = (
      (await accepted.json()) as {
        result: CommandResult<ArticleAcknowledgement>;
      }
    ).result;
    const replay = await f.agent(
      token.access_token,
      'submitEvidence',
      evidenceCommand,
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      result: { replayed: true, value: acknowledgement.value },
    });
    const retained = await f.staffValue<EvidenceDto>('getEvidence', {
      articleId: created.id,
    });
    expect(retained.evidence).toHaveLength(1);
    expect(retained.evidence[0]!.attestation.verifiedBy).toBe(reviewer);
    const prematureReview = await f.staff('submitForReview', {
      commandId: 'human-review-missing-content-check',
      correlationId: 'integration',
      expectedGeneration: acknowledgement.value.generation,
      articleId: created.id,
    });
    expect(prematureReview.status).toBe(409);
    const required = await f.agent(
      token.access_token,
      'getValidationRequirements',
      { collectionId: 'integration-guides', kind: 'walkthrough' },
    );
    expect(required.status).toBe(200);
    const requirements = (
      (await required.json()) as { result: ValidationRequirementsDto }
    ).result;
    expect(requirements.checks.map((check) => check.testKind).sort()).toEqual([
      'content',
      'workflow',
    ]);
    let completeEvidenceGeneration = acknowledgement.value.generation;
    for (const check of requirements.checks) {
      if (check.id === prepared.evidence.checkId) continue;
      const checkedReport = await confirmedReport(
        f,
        token.access_token,
        created.id,
        check,
      );
      const submittedEvidence = await f.agent(
        token.access_token,
        'submitEvidence',
        {
          commandId: `confirmed-evidence:${check.id}`,
          correlationId: 'integration',
          expectedGeneration: checkedReport.article.generation,
          articleId: created.id,
          evidence: checkedReport.evidence,
          receipt: checkedReport.report.receipt,
        },
      );
      expect(submittedEvidence.status).toBe(200);
      completeEvidenceGeneration = (
        (await submittedEvidence.json()) as {
          result: CommandResult<ArticleAcknowledgement>;
        }
      ).result.value.generation;
    }
    const completeEvidence = await f.staffValue<EvidenceDto>('getEvidence', {
      articleId: created.id,
    });
    expect(
      completeEvidence.evidence.map((item) => item.checkId).sort(),
    ).toEqual(requirements.checks.map((check) => check.id).sort());
    expect(
      completeEvidence.evidence.every(
        (item) => item.attestation.verifiedBy === reviewer,
      ),
    ).toBe(true);
    const submitted = await f.staffValue<CommandResult<ArticleAcknowledgement>>(
      'submitForReview',
      {
        commandId: 'human-submit-review',
        correlationId: 'integration',
        expectedGeneration: completeEvidenceGeneration,
        articleId: created.id,
      },
    );
    const review = await f.staffValue<ReviewDto>('getReview', {
      articleId: created.id,
    });
    const delegated = await f.agents.service.authenticate({
      token: token.access_token,
      resource,
    });
    await expect(
      f.knowledge.application.publishArticle(delegated.access, {
        commandId: 'agent-publish-denied',
        correlationId: 'integration',
        expectedGeneration: submitted.value.generation,
        articleId: created.id,
        review: review.review,
      }),
    ).rejects.toBeInstanceOf(KnowledgeBaseAuthorizationError);
    await expect(
      f.knowledge.application.createCollection(delegated.access, {
        commandId: 'agent-collection-denied',
        correlationId: 'integration',
        expectedGeneration: 0,
        collectionId: 'agent-cannot-manage',
        name: 'Denied collection',
      }),
    ).rejects.toBeInstanceOf(KnowledgeBaseAuthorizationError);
    const published = await f.staffValue<CommandResult<ArticleAcknowledgement>>(
      'publishArticle',
      {
        commandId: 'human-publish-guide',
        correlationId: 'integration',
        expectedGeneration: submitted.value.generation,
        articleId: created.id,
        review: review.review,
      },
    );
    expect(published.value.state).toBe('published');
    const portal = await f.knowledgeRequest(
      browserRequest('/api/knowledge/portal', f.memberAuth, {
        operation: 'getPublishedArticle',
        input: { articleId: created.id },
      }),
    );
    expect(portal.status).toBe(200);
    const portalBody = await portal.json();
    expect(portalBody).toMatchObject({
      articleId: created.id,
      title: draft().title,
    });
    const serialized = JSON.stringify(portalBody);
    for (const privateValue of [
      prepared.report.receipt,
      reviewer,
      runner,
      'The independent fixture report',
      'attestation',
      'evidence',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it.each([
    'revision',
    'build',
    'runner',
    'result',
    'submitting principal',
  ] as const)(
    'rejects a confirmed receipt whose %s binding changes',
    async (changed) => {
      const f = await integrationFixture();
      const { token } = await f.device();
      const created = await createAgentDraft(f, token.access_token);
      const prepared = await confirmedReport(f, token.access_token, created.id);
      let evidence = prepared.evidence;
      let actorToken = token.access_token;
      if (changed === 'revision') {
        const beforeUpdate = await f.agent(token.access_token, 'getDraft', {
          articleId: created.id,
        });
        const before = (
          (await beforeUpdate.json()) as { result: DraftArticleDto }
        ).result;
        const update = await f.agent(token.access_token, 'updateDraft', {
          commandId: 'revise-after-report-confirmation',
          correlationId: 'integration',
          expectedGeneration: before.generation,
          articleId: created.id,
          collectionId: 'integration-guides',
          draft: draft({
            summary: 'A genuinely revised guide needs fresh report review.',
          }),
        });
        expect(update.status).toBe(200);
        const reread = await f.agent(token.access_token, 'getDraft', {
          articleId: created.id,
        });
        evidence = evidenceFor(
          ((await reread.json()) as { result: DraftArticleDto }).result,
          f.clock.now(),
        );
      } else if (changed === 'build')
        evidence = { ...evidence, stagingBuildId: 'different-staging-build' };
      else if (changed === 'runner')
        evidence = { ...evidence, runnerId: 'untrusted-runner' as PrincipalId };
      else if (changed === 'result')
        evidence = { ...evidence, result: 'failed' };
      else actorToken = (await f.device(f.reviewerAuth)).token.access_token;
      const current = await f.agent(actorToken, 'getDraft', {
        articleId: created.id,
      });
      const dto = ((await current.json()) as { result: DraftArticleDto })
        .result;
      const refused = await f.agent(actorToken, 'submitEvidence', {
        commandId: 'changed-evidence-binding-denied',
        correlationId: 'integration',
        expectedGeneration: dto.generation,
        articleId: created.id,
        evidence,
        receipt: prepared.report.receipt,
      });
      expect(refused.status).toBe(412);
      expect(await refused.json()).toMatchObject({
        error: { code: 'prerequisite' },
      });
      const retained = await f.staffValue<EvidenceDto>('getEvidence', {
        articleId: created.id,
      });
      expect(retained.evidence).toHaveLength(0);
    },
  );

  it('refuses a staff confirmation from an obsolete report view after the agent edits the actual draft', async () => {
    const f = await integrationFixture();
    const { token } = await f.device();
    const created = await createAgentDraft(f, token.access_token);
    const prepared = await submitReport(f, token.access_token, created.id);
    const updated = await f.agent(token.access_token, 'updateDraft', {
      commandId: 'edit-before-staff-confirms',
      correlationId: 'integration',
      expectedGeneration: prepared.article.generation,
      articleId: created.id,
      collectionId: 'integration-guides',
      draft: draft({ title: 'Changed after staff opened the report' }),
    });
    expect(updated.status).toBe(200);
    const stale = await f.staff('confirmReport', prepared.confirm);
    expect(stale.status).toBe(409);
    const current = await f.staffValue<KnowledgeReportView>('reportRead', {
      articleId: created.id,
      reportId: prepared.report.reportId,
    });
    expect(current.status).toBe('pending');
    expect(current.confirmation).toBeNull();
    expect(current.reviewBindingHash).not.toBe(
      prepared.viewed.reviewBindingHash,
    );
  });

  it('refuses a previously confirmed report after its current staff reviewer loses authority', async () => {
    const f = await integrationFixture();
    const { token } = await f.device();
    const created = await createAgentDraft(f, token.access_token);
    const prepared = await confirmedReport(f, token.access_token, created.id);
    const assignment = await f.roleStore.getRoleAssignment(
      `${ADMIN_ROLE}-${reviewer}`,
    );
    await f.roleStore.revokeRoleAssignmentWithAudit({
      assignmentId: `${ADMIN_ROLE}-${reviewer}`,
      expectedConcurrencyToken: assignment!.concurrencyToken,
      revokedBy: { kind: 'principal', principalId: owner },
      revokedAtEpochMs: Date.parse(f.clock.now()) + 1,
      auditEventId: 'demote-report-reviewer',
    });
    const refused = await f.agent(token.access_token, 'submitEvidence', {
      commandId: 'demoted-reviewer-proof-denied',
      correlationId: 'integration',
      expectedGeneration: prepared.article.generation,
      articleId: created.id,
      evidence: prepared.evidence,
      receipt: prepared.report.receipt,
    });
    expect(refused.status).toBe(412);
    expect(await refused.json()).toMatchObject({
      error: { code: 'prerequisite' },
    });
  });

  it('requires the currently stored Admin role and browser CSRF for actual pending consent', async () => {
    const f = await integrationFixture();
    const response = await f.agentRequest(
      formRequest('/api/agent-access/device-authorizations', {
        client_id: client.clientId,
        resource,
        scope: scopes.join(' '),
      }),
    );
    const pending = (await response.json()) as {
      user_code: string;
      device_code: string;
    };
    const path = `/api/agent-access/approval?user_code=${encodeURIComponent(pending.user_code)}`;
    expect(
      (
        await f.agentRequest(
          browserRequest(path, f.memberAuth, undefined, 'GET'),
        )
      ).status,
    ).toBe(403);
    const view = await f.agentRequest(
      browserRequest(path, f.ownerAuth, undefined, 'GET'),
    );
    const approval = (await view.json()) as ApprovalView;
    const submitted = {
      requestId: approval.requestId,
      userCode: pending.user_code,
      decision: 'approve',
    };
    const missingCsrf = browserRequest(
      '/api/agent-access/approval',
      f.ownerAuth,
      submitted,
    );
    missingCsrf.headers.delete('X-Pegma-CSRF');
    expect((await f.agentRequest(missingCsrf)).status).toBe(403);
    const current = await f.roleStore.getRoleAssignment(
      `${ADMIN_ROLE}-${owner}`,
    );
    await f.roleStore.revokeRoleAssignmentWithAudit({
      assignmentId: `${ADMIN_ROLE}-${owner}`,
      expectedConcurrencyToken: current!.concurrencyToken,
      revokedBy: { kind: 'principal', principalId: reviewer },
      revokedAtEpochMs: Date.parse(f.clock.now()) + 1,
      auditEventId: 'demote-before-consent',
    });
    expect(
      (
        await f.agentRequest(
          browserRequest('/api/agent-access/approval', f.ownerAuth, submitted),
        )
      ).status,
    ).toBe(403);
  });

  it.each(['demotion', 'grant revocation', 'inactive account'] as const)(
    'rejects the next HTTP and MCP request after %s',
    async (change) => {
      const f = await integrationFixture();
      const { token } = await f.device();
      const created = await createAgentDraft(f, token.access_token);
      const delegated = await f.agents.service.authenticate({
        token: token.access_token,
        resource,
      });
      if (change === 'demotion') {
        const current = await f.roleStore.getRoleAssignment(
          `${ADMIN_ROLE}-${owner}`,
        );
        await f.roleStore.revokeRoleAssignmentWithAudit({
          assignmentId: `${ADMIN_ROLE}-${owner}`,
          expectedConcurrencyToken: current!.concurrencyToken,
          revokedBy: { kind: 'principal', principalId: reviewer },
          revokedAtEpochMs: Date.parse(f.clock.now()) + 1,
          auditEventId: 'demote-active-agent-owner',
        });
      } else if (change === 'grant revocation') {
        const revoked = await f.agentRequest(
          browserRequest(
            `/api/agent-access/grants/${delegated.grantId}`,
            f.ownerAuth,
            undefined,
            'DELETE',
          ),
        );
        expect(revoked.status).toBe(204);
      } else {
        f.users.set(owner, { ...user(owner), status: 'pending' });
      }
      expect(
        (
          await f.agent(token.access_token, 'getDraft', {
            articleId: created.id,
          })
        ).status,
      ).toBe(401);
      expect((await f.mcp(token.access_token, 'tools/list', {})).status).toBe(
        401,
      );
      const refreshed = await f.agentRequest(
        formRequest('/api/agent-access/token', {
          grant_type: 'refresh_token',
          client_id: client.clientId,
          resource,
          refresh_token: token.refresh_token,
        }),
      );
      expect(refreshed.status).toBe(400);
      expect(await refreshed.json()).toMatchObject({ error: 'invalid_grant' });
    },
  );

  it('rejects excessive consent scopes and a different protected-resource audience', async () => {
    const f = await integrationFixture();
    for (const extraScope of [
      'knowledge.article.publish',
      'knowledge.article.provenance.write',
      'knowledge.collection.manage',
    ]) {
      const rejected = await f.agentRequest(
        formRequest('/api/agent-access/device-authorizations', {
          client_id: client.clientId,
          resource,
          scope: [...scopes, extraScope].join(' '),
        }),
      );
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toMatchObject({ error: 'invalid_scope' });
    }
    const wrongAudience = await f.agentRequest(
      formRequest('/api/agent-access/device-authorizations', {
        client_id: client.clientId,
        resource: 'https://pegma.dev/api/knowledge/v1',
        scope: scopes.join(' '),
      }),
    );
    expect(wrongAudience.status).toBe(400);
    const { token } = await f.device();
    await expect(
      f.agents.service.authenticate({
        token: token.access_token,
        resource: 'https://foreign.example.test/mcp',
      }),
    ).rejects.toThrow();
  });

  it('preserves existing customer and stored Support-role request flows alongside agent linking', async () => {
    const f = await integrationFixture();
    const runtime = createSupportRuntime({
      store: f.store,
      sessions: f.sessions,
      identity: f.identity,
      logger: f.logger,
      clock: f.clock,
      identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
    });
    const api = createSupportApi({
      application: runtime.application,
      sessions: f.sessions,
      identity: f.identity,
      identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
      createLimiter: runtime.createLimiter,
      replyLimiter: runtime.replyLimiter,
      logger: f.logger,
      roleStore: runtime.roleStore,
    });
    const created = await api(
      browserRequest('/api/support/tickets', f.ownerAuth, {
        subject: 'Synthetic integration feedback',
        body: 'Existing human support remains available.',
        category: 'feedback',
      }),
    );
    expect(created.status).toBe(201);
    const ticket = (await created.json()) as { ticket: { id: string } };
    const customerRead = await api(
      browserRequest(
        `/api/support/tickets/${ticket.ticket.id}`,
        f.ownerAuth,
        undefined,
        'GET',
      ),
    );
    expect(customerRead.status).toBe(200);
    const staffQueue = await api(
      browserRequest(
        '/api/support/admin/queue',
        f.memberAuth,
        undefined,
        'GET',
      ),
    );
    expect(staffQueue.status).toBe(200);
    const { token } = await f.device();
    expect(
      (
        await f.agents.service.authenticate({
          token: token.access_token,
          resource,
        })
      ).access.permissions,
    ).toEqual(scopes);
    expect(
      (
        await f.roleStore.listActiveRoleAssignments(member, APPLICATION_SCOPE)
      ).map((assignment) => assignment.role),
    ).toEqual([SUPPORT_ROLE]);
  });
});
