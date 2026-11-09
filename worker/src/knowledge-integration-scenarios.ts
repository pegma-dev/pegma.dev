import { identityLinkKeyFromVerifiedIdentityClaims } from '@pegma/authorization-identity';
import { createRoleStore } from '@pegma/authorization-storage';
import { resolveAccess } from '@pegma/authorization-core';
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
import {
  articleKinds,
  knowledgePermissions,
} from '@pegma/knowledge-base-contracts';
import {
  KnowledgeBaseAuthorizationError,
  retrievalRecords,
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
import type {
  CollectionDefinition,
  CollectionStore,
  ScanOptions,
  Store,
} from '@pegma/storage-core';
import { type IsoTimestamp, type Logger, type PrincipalId } from '@pegma/spine';
import { describe, expect, it, vi } from 'vitest';
import { createAgentAccessRuntime } from './agent-access-runtime';
import { IDENTITY_ISSUER, SESSION_COOKIE } from './identity-api';
import type { IdentityPort, IdentityUser } from './identity-contracts';
import {
  ADMIN_ROLE,
  APPLICATION_SCOPE,
  AUTHORIZATION_APPLICATION_ID,
  KNOWLEDGE_ROLE,
  SUPPORT_ROLE,
} from './support-access';
import { createSupportApi } from './support-api';
import { createSupportRuntime } from './support-desk';
import { createKnowledgeRuntime } from './knowledge-runtime';
import { createKnowledgeRetrievalMaintenance } from './knowledge-retrieval-maintenance';
import type {
  KnowledgeReportAcknowledgement,
  KnowledgeReportLedgerState,
  KnowledgeReportView,
} from './knowledge-evidence';

const owner = 'integration-agent-owner' as PrincipalId;
const otherOwner = 'integration-other-agent-owner' as PrincipalId;
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

async function integrationFixture(store: Store, loggerOverride?: Logger) {
  let now = Date.parse('2026-11-08T12:00:00.000Z');
  const clock = { now: () => new Date(now).toISOString() as IsoTimestamp };
  const logger: Logger = loggerOverride ?? { log: vi.fn() };
  const sessions = createSessionStore(store, { logger, clock });
  const roleStore = createRoleStore(store, AUTHORIZATION_APPLICATION_ID);
  const users = new Map<PrincipalId, IdentityUser>(
    [owner, otherOwner, reviewer, member].map((id) => [id, user(id)] as const),
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
    role:
      | typeof ADMIN_ROLE
      | typeof SUPPORT_ROLE
      | typeof KNOWLEDGE_ROLE = ADMIN_ROLE,
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
  await grant(otherOwner);
  await grant(reviewer, KNOWLEDGE_ROLE);
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
  async function staffValue<T>(
    operation: string,
    input: unknown,
    auth = reviewerAuth,
  ): Promise<T> {
    const response = await staff(operation, input, auth);
    expect(response.status, operation).toBe(200);
    return (await response.json()) as T;
  }
  function adminValue<T>(operation: string, input: unknown): Promise<T> {
    return staffValue<T>(operation, input, ownerAuth);
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
  function report(token: string, input: unknown) {
    return knowledgeRequest(
      new Request('https://pegma.dev/api/knowledge/reports', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(input),
      }),
    );
  }
  function reportLedger(token: string, articleId: string) {
    return knowledgeRequest(
      new Request(
        `https://pegma.dev/api/knowledge/reports?${new URLSearchParams({ articleId })}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      ),
    );
  }
  function reportStatus(
    token: string,
    articleId: string,
    ledgerEpoch: number,
    reportId: string,
  ) {
    return knowledgeRequest(
      new Request(
        `https://pegma.dev/api/knowledge/reports?${new URLSearchParams({ articleId, ledgerEpoch: String(ledgerEpoch), reportId })}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      ),
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
    const collection = await adminValue<
      CommandResult<CollectionAcknowledgement>
    >('createCollection', {
      commandId: 'create-integration-collection',
      correlationId: 'integration',
      expectedGeneration: 0,
      collectionId: 'integration-guides',
      name: 'Synthetic integration guides',
    });
    await adminValue('putValidationPolicy', {
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
    await adminValue('putGovernanceConfiguration', {
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
    const preview = await adminValue<CollectionPolicyPreviewDto>(
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
    await adminValue('updateCollectionPolicy', {
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
  const otherOwnerAuth = await session(otherOwner);
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
    otherOwnerAuth,
    reviewerAuth,
    memberAuth,
    agentRequest,
    knowledgeRequest,
    staff,
    staffValue,
    agent,
    mcp,
    report,
    reportLedger,
    reportStatus,
    configure,
    grant,
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

/** Faults only real derived writes; all authoritative storage remains real. */
function observeRetrieval(backing: Store) {
  const state = { failProjectionWrites: true };
  const scans: ScanOptions[] = [];
  const store: Store = {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      const target = backing.collection(definition);
      return {
        ...target,
        async scan(options) {
          if (definition.name === 'knowledge-base.records.v1')
            scans.push({ ...options });
          return target.scan(options);
        },
        async transact(partition, actions) {
          if (
            definition.name === retrievalRecords.name &&
            state.failProjectionWrites
          )
            throw new Error('Synthetic derived-store outage.');
          return target.transact(partition, actions);
        },
      };
    },
  };
  return { store, scans, state };
}

async function publishSearchGuide(
  f: Awaited<ReturnType<typeof integrationFixture>>,
  token: string,
) {
  const created = await createAgentDraft(f, token);
  const requirements = await f.staffValue<ValidationRequirementsDto>(
    'getValidationRequirements',
    {
      collectionId: 'integration-guides',
      kind: 'walkthrough',
    },
  );
  let generation = created.generation;
  for (const check of requirements.checks) {
    const report = await confirmedReport(
      f,
      token,
      created.id,
      check,
      'search-publication',
    );
    const response = await f.agent(token, 'submitEvidence', {
      commandId: `search-evidence:${check.id}`,
      correlationId: 'integration',
      expectedGeneration: report.article.generation,
      articleId: created.id,
      evidence: report.evidence,
      receipt: report.report.receipt,
    });
    expect(response.status).toBe(200);
    generation = (
      (await response.json()) as {
        result: CommandResult<ArticleAcknowledgement>;
      }
    ).result.value.generation;
  }
  const submitted = await f.staffValue<CommandResult<ArticleAcknowledgement>>(
    'submitForReview',
    {
      commandId: 'submit-search-guide',
      correlationId: 'integration',
      expectedGeneration: generation,
      articleId: created.id,
    },
  );
  const review = await f.staffValue<ReviewDto>('getReview', {
    articleId: created.id,
  });
  const published = await f.staffValue<CommandResult<ArticleAcknowledgement>>(
    'publishArticle',
    {
      commandId: 'publish-search-guide',
      correlationId: 'integration',
      expectedGeneration: submitted.value.generation,
      articleId: created.id,
      review: review.review,
    },
  );
  return { created, published };
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
  sequence = 'initial',
) {
  const read = await f.agent(token, 'getDraft', { articleId });
  const article = ((await read.json()) as { result: DraftArticleDto }).result;
  const evidence = evidenceFor(article, f.clock.now(), check);
  const ledgerResponse = await f.reportLedger(token, articleId);
  expect(ledgerResponse.status).toBe(200);
  const ledger = (await ledgerResponse.json()) as KnowledgeReportLedgerState;
  expect(ledger.status).toBe('active');
  const reportCommand = {
    commandId: `submit-synthetic-report:${check.id}:${sequence}`,
    articleId,
    ledgerEpoch: ledger.ledgerEpoch,
    evidence,
    report: {
      summary: `Synthetic ${check.testKind} check passed`,
      details:
        'The independent fixture report records the steps, output comparison and synthetic artifact. This is test data.',
    },
  };
  const submitted = await f.report(token, reportCommand);
  expect(submitted.status).toBe(200);
  const report = (await submitted.json()) as KnowledgeReportAcknowledgement;
  expect(report.ledgerEpoch).toBe(ledger.ledgerEpoch);
  const viewed = await f.staffValue<KnowledgeReportView>('reportRead', {
    articleId,
    ledgerEpoch: report.ledgerEpoch,
    reportId: report.reportId,
  });
  expect(viewed.submittedBy).toBe(owner);
  expect(viewed.evidence).toEqual(evidence);
  expect(viewed.articleId).toBe(articleId);
  const confirm = {
    commandId: `confirm-synthetic-report:${check.id}:${sequence}`,
    articleId,
    ledgerEpoch: report.ledgerEpoch,
    reportId: report.reportId,
    expectedReportGeneration: viewed.expectedReportGeneration,
    reviewBindingHash: viewed.reviewBindingHash,
  };
  return { article, evidence, report, reportCommand, viewed, confirm };
}

async function confirmedReport(
  f: Awaited<ReturnType<typeof integrationFixture>>,
  token: string,
  articleId: string,
  check: EvidenceCheck = workflowCheck,
  sequence = 'initial',
) {
  const prepared = await submitReport(f, token, articleId, check, sequence);
  const confirmation = await f.staff('confirmReport', prepared.confirm);
  expect(confirmation.status).toBe(200);
  const reviewed = await f.staffValue<KnowledgeReportView>('reportRead', {
    articleId,
    ledgerEpoch: prepared.report.ledgerEpoch,
    reportId: prepared.report.reportId,
  });
  expect(reviewed.status).toBe('confirmed');
  return prepared;
}

async function drainReportLedger(
  f: Awaited<ReturnType<typeof integrationFixture>>,
  state: KnowledgeReportLedgerState,
) {
  let current = state;
  let calls = 0;
  while (current.status === 'resetting' && calls < 4) {
    current = await f.staffValue<KnowledgeReportLedgerState>('drainReports', {
      articleId: current.articleId,
      ledgerEpoch: current.ledgerEpoch,
    });
    calls += 1;
  }
  expect(current.status).toBe('active');
  expect(calls).toBeGreaterThan(0);
  expect(calls).toBeLessThanOrEqual(4);
  return current;
}

export interface KnowledgeIntegrationScenarioOptions {
  readonly name: string;
  readonly createStore: () => Store | Promise<Store>;
}

/** The same real-package workflow assertions run against each host Store. */
export function registerKnowledgeIntegrationScenarios(
  options: KnowledgeIntegrationScenarioOptions,
): void {
  describe(options.name, () => {
    const fixture = async () => integrationFixture(await options.createStore());
    it('completes existing-session device consent with exactly three restricted scopes', async () => {
      const f = await fixture();
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
      const f = await fixture();
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
        const f = await fixture();
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
        const cookieOnly = await f.knowledgeRequest(
          new Request('https://pegma.dev/api/knowledge/v1', {
            method: 'POST',
            headers: {
              Cookie: f.ownerAuth.cookie,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              apiVersion: '1',
              operation: 'getDraft',
              input: { articleId: created.id },
            }),
          }),
        );
        expect(cookieOnly.status).toBe(401);
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
        const provenanceWrite = await f.agent(
          token.access_token,
          'updateDraft',
          {
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
          },
        );
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
      const f = await fixture();
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
      expect((await f.staff('confirmReport', prepared.confirm)).status).toBe(
        200,
      );
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
      expect(requirements.checks.map((check) => check.testKind).sort()).toEqual(
        ['content', 'workflow'],
      );
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
      const submitted = await f.staffValue<
        CommandResult<ArticleAcknowledgement>
      >('submitForReview', {
        commandId: 'human-submit-review',
        correlationId: 'integration',
        expectedGeneration: completeEvidenceGeneration,
        articleId: created.id,
      });
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
      const published = await f.staffValue<
        CommandResult<ArticleAcknowledgement>
      >('publishArticle', {
        commandId: 'human-publish-guide',
        correlationId: 'integration',
        expectedGeneration: submitted.value.generation,
        articleId: created.id,
        review: review.review,
      });
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

    it.each(['retire', 'evidence', 'policy', 'throwing-logger'] as const)(
      'repairs real published portal discovery/search after an outage and filters %s before cleanup',
      async (variant) => {
        const withdrawal = variant === 'throwing-logger' ? 'retire' : variant;
        const observed = observeRetrieval(await options.createStore());
        const logger: Logger | undefined =
          variant === 'throwing-logger'
            ? {
                log: vi.fn<Logger['log']>((_level, event) => {
                  if (event.startsWith('knowledge.retrieval_maintenance.'))
                    throw new Error(
                      'Synthetic injected repair logger failure.',
                    );
                }),
              }
            : undefined;
        const f = await integrationFixture(observed.store, logger);
        const { token } = await f.device();
        const { created, published } = await publishSearchGuide(
          f,
          token.access_token,
        );
        expect(published.value.state).toBe('published');
        // Failed bounded keyed repair must not lie about the durable publish.
        expect(f.logger.log).toHaveBeenCalledWith(
          'warn',
          'knowledge.retrieval_maintenance.failed',
          { stage: 'keyed' },
        );
        expect(observed.scans).toEqual([]);
        const portal = async (operation: string, input: unknown) => {
          const response = await f.knowledgeRequest(
            browserRequest('/api/knowledge/portal', f.memberAuth, {
              operation,
              input,
            }),
          );
          expect(response.status).toBe(200);
          return response.json();
        };
        const searchInput = {
          collectionId: 'integration-guides',
          query: 'synthetic export',
          applicability: draft().applicability,
        };
        expect(await portal('listPortalCollections', {})).toEqual({
          outcome: 'no_result',
          collections: [],
        });
        expect(await portal('searchPublishedArticles', searchInput)).toEqual({
          outcome: 'no_result',
          articles: [],
        });
        expect(
          await portal('getPublishedArticle', { articleId: created.id }),
        ).toMatchObject({ articleId: created.id });
        expect(observed.scans).toEqual([]);
        const indexAccess = resolveAccess(
          { principalId: 'synthetic-index-status-reader' },
          {
            version: 'synthetic-index-status-1',
            defaults: [knowledgePermissions.indexManage],
          },
        );
        expect(indexAccess.permissions).toEqual([
          knowledgePermissions.indexManage,
        ]);
        expect(indexAccess.roles).toEqual([]);
        expect(indexAccess.entitlements).toEqual([]);
        const maintenance = () =>
          createKnowledgeRetrievalMaintenance({
            store: observed.store,
            clock: f.clock,
            logger: f.logger,
            isEnabled: () => true,
          });
        async function converge(indexed: boolean) {
          for (let tick = 0; tick < 128; tick++) {
            const before = observed.scans.length;
            // A new composition each tick proves the cursor survives restart.
            await maintenance().runPage();
            expect(observed.scans.length - before).toBe(1);
            expect(observed.scans.at(-1)?.limit).toBe(10);
            const status = await f.knowledge.application.getArticleIndexStatus(
              indexAccess,
              { articleId: created.id },
            );
            if (status.status === 'ready' && status.indexed === indexed) return;
          }
          throw new Error(
            'Synthetic index did not converge within bounded host ticks.',
          );
        }
        observed.state.failProjectionWrites = false;
        await converge(true);
        expect(await portal('listPortalCollections', {})).toMatchObject({
          outcome: 'results',
          collections: [
            {
              collectionId: 'integration-guides',
              label: 'Synthetic integration guides',
            },
          ],
        });
        const found = await portal('searchPublishedArticles', searchInput);
        expect(found).toMatchObject({
          outcome: 'results',
          articles: [{ articleId: created.id, title: draft().title }],
        });
        for (const privateValue of [
          reviewer,
          runner,
          'attestation',
          'The independent fixture report',
        ])
          expect(JSON.stringify(found)).not.toContain(privateValue);
        const beforeWithdrawalScans = observed.scans.length;
        // Retain stale hints until the page worker, proving immediate authority.
        observed.state.failProjectionWrites = true;
        if (withdrawal === 'retire') {
          await f.staffValue('retireArticle', {
            commandId: 'retire-search-guide',
            correlationId: 'integration',
            expectedGeneration: published.value.generation,
            articleId: created.id,
          });
        } else if (withdrawal === 'evidence') {
          const current = await f.staffValue<DraftArticleDto>('getDraft', {
            articleId: created.id,
          });
          const evidence = (
            await f.staffValue<EvidenceDto>('getEvidence', {
              articleId: created.id,
            })
          ).evidence[0];
          if (evidence === undefined)
            throw new Error('Expected actual accepted publication evidence.');
          await f.staffValue('revokeEvidence', {
            commandId: 'revoke-search-proof',
            correlationId: 'integration',
            expectedGeneration: current.generation,
            articleId: created.id,
            articleRevision: evidence.articleRevision,
            evidenceId: evidence.id,
            evidenceVersion: evidence.version,
            evidenceHash: evidence.hash,
            reason: 'Synthetic proof withdrawal',
          });
        } else {
          const preview = await f.staffValue<CollectionPolicyPreviewDto>(
            'previewCollectionPolicy',
            {
              collectionId: 'integration-guides',
              uses: { portal: { enabled: false }, bot: { enabled: false } },
            },
            f.ownerAuth,
          );
          await f.staffValue(
            'updateCollectionPolicy',
            {
              commandId: 'withdraw-search-policy',
              correlationId: 'integration',
              expectedGeneration: preview.generation,
              collectionId: 'integration-guides',
              preview: preview.preview,
            },
            f.ownerAuth,
          );
        }
        expect(await portal('searchPublishedArticles', searchInput)).toEqual({
          outcome: 'no_result',
          articles: [],
        });
        const direct = await f.knowledgeRequest(
          browserRequest('/api/knowledge/portal', f.memberAuth, {
            operation: 'getPublishedArticle',
            input: { articleId: created.id },
          }),
        );
        expect(direct.status).toBe(404);
        expect(observed.scans.length).toBe(beforeWithdrawalScans);
        observed.state.failProjectionWrites = false;
        await converge(false);
        expect(await portal('searchPublishedArticles', searchInput)).toEqual({
          outcome: 'no_result',
          articles: [],
        });
      },
    );

    it.each([
      'revision',
      'build',
      'runner',
      'result',
      'submitting principal',
    ] as const)(
      'rejects a confirmed receipt whose %s binding changes',
      async (changed) => {
        const f = await fixture();
        const { token } = await f.device();
        const created = await createAgentDraft(f, token.access_token);
        const prepared = await confirmedReport(
          f,
          token.access_token,
          created.id,
        );
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
          evidence = {
            ...evidence,
            runnerId: 'untrusted-runner' as PrincipalId,
          };
        else if (changed === 'result')
          evidence = { ...evidence, result: 'failed' };
        else actorToken = (await f.device(f.otherOwnerAuth)).token.access_token;
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
      const f = await fixture();
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
        ledgerEpoch: prepared.report.ledgerEpoch,
        reportId: prepared.report.reportId,
      });
      expect(current.status).toBe('pending');
      expect(current.confirmation).toBeNull();
      expect(current.reviewBindingHash).not.toBe(
        prepared.viewed.reviewBindingHash,
      );
    });

    it('refuses a previously confirmed report after its current staff reviewer loses authority', async () => {
      const f = await fixture();
      const { token } = await f.device();
      const created = await createAgentDraft(f, token.access_token);
      const prepared = await confirmedReport(f, token.access_token, created.id);
      const assignment = await f.roleStore.getRoleAssignment(
        `${KNOWLEDGE_ROLE}-${reviewer}`,
      );
      await f.roleStore.revokeRoleAssignmentWithAudit({
        assignmentId: `${KNOWLEDGE_ROLE}-${reviewer}`,
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
      const f = await fixture();
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
      expect(
        (
          await f.agentRequest(
            browserRequest(path, f.reviewerAuth, undefined, 'GET'),
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
        revokedBy: { kind: 'principal', principalId: otherOwner },
        revokedAtEpochMs: Date.parse(f.clock.now()) + 1,
        auditEventId: 'demote-before-consent',
      });
      expect(
        (
          await f.agentRequest(
            browserRequest(
              '/api/agent-access/approval',
              f.ownerAuth,
              submitted,
            ),
          )
        ).status,
      ).toBe(403);
    });

    it.each(['demotion', 'grant revocation', 'inactive account'] as const)(
      'rejects the next HTTP and MCP request after %s',
      async (change) => {
        const f = await fixture();
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
            revokedBy: { kind: 'principal', principalId: otherOwner },
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
        expect(await refreshed.json()).toMatchObject({
          error: 'invalid_grant',
        });
      },
    );

    it('refuses a report when its real grant is revoked while the request body is pending', async () => {
      const f = await fixture();
      const { token } = await f.device();
      const created = await createAgentDraft(f, token.access_token);
      const article = await f.knowledge.application.getDraft(
        (
          await f.agents.service.authenticate({
            token: token.access_token,
            resource,
          })
        ).access,
        { articleId: created.id },
      );
      const before = await f.staffValue('reportList', {
        articleId: created.id,
      });
      const input = {
        commandId: 'revoked-during-report-body',
        articleId: created.id,
        ledgerEpoch: 1,
        evidence: evidenceFor(article, f.clock.now()),
        report: {
          summary: 'Synthetic test result',
          details: 'A fictional test report with no customer content.',
        },
      };
      let reached!: () => void;
      let release!: () => void;
      const reading = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const body = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            reached();
            await gate;
            controller.enqueue(new TextEncoder().encode(JSON.stringify(input)));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      const init: RequestInit & { duplex: 'half' } = {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          'Content-Type': 'application/json',
        },
        body,
        duplex: 'half',
      };
      const pending = f.knowledgeRequest(
        new Request('https://pegma.dev/api/knowledge/reports', init),
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          reading,
          pending.then(() => {
            throw new Error('Report ended before reading its body.');
          }),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('Report body barrier timed out.')),
              10_000,
            );
          }),
        ]);
        const delegated = await f.agents.service.authenticate({
          token: token.access_token,
          resource,
        });
        expect(
          (
            await f.agentRequest(
              browserRequest(
                '/api/agent-access/grants/' + delegated.grantId,
                f.ownerAuth,
                undefined,
                'DELETE',
              ),
            )
          ).status,
        ).toBe(204);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
        release();
      }
      expect((await pending).status).toBe(401);
      expect(
        await f.staffValue('reportList', { articleId: created.id }),
      ).toEqual(before);
    });

    it('rejects excessive consent scopes and a different protected-resource audience', async () => {
      const f = await fixture();
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

    it('requires an explicit Knowledge grant and honors its removal while preserving the existing Support assignment', async () => {
      const f = await fixture();
      const { token } = await f.device();
      const created = await createAgentDraft(f, token.access_token);
      const prepared = await submitReport(f, token.access_token, created.id);
      const supportId = `${SUPPORT_ROLE}-${member}`;
      const originalSupport = await f.roleStore.getRoleAssignment(supportId);
      expect(originalSupport?.assignment.role).toBe(SUPPORT_ROLE);
      const state = () =>
        f.knowledgeRequest(
          browserRequest(
            '/api/staff/knowledge/state',
            f.memberAuth,
            undefined,
            'GET',
          ),
        );
      expect((await state()).status).toBe(403);
      const privateOperations = [
        { operation: 'getDraft', input: { articleId: created.id } },
        {
          operation: 'reportRead',
          input: {
            articleId: created.id,
            ledgerEpoch: prepared.report.ledgerEpoch,
            reportId: prepared.report.reportId,
          },
        },
        { operation: 'reportLedger', input: { articleId: created.id } },
        { operation: 'getEvidence', input: { articleId: created.id } },
        { operation: 'getReview', input: { articleId: created.id } },
        { operation: 'confirmReport', input: prepared.confirm },
        { operation: 'rejectReport', input: prepared.confirm },
        { operation: 'reassessReport', input: prepared.confirm },
        {
          operation: 'resetReports',
          input: {
            commandId: 'support-cannot-reset-ledger',
            articleId: created.id,
            expectedLedgerEpoch: prepared.report.ledgerEpoch,
          },
        },
        {
          operation: 'drainReports',
          input: {
            articleId: created.id,
            ledgerEpoch: prepared.report.ledgerEpoch,
          },
        },
        {
          operation: 'submitEvidence',
          input: {
            commandId: 'support-cannot-submit-kb-evidence',
            correlationId: 'integration',
            expectedGeneration: prepared.article.generation,
            articleId: created.id,
            evidence: prepared.evidence,
            receipt: prepared.report.receipt,
          },
        },
        {
          operation: 'submitForReview',
          input: {
            commandId: 'support-cannot-review-kb',
            correlationId: 'integration',
            expectedGeneration: prepared.article.generation,
            articleId: created.id,
          },
        },
        { operation: 'publishArticle', input: { articleId: created.id } },
      ];
      for (const command of privateOperations) {
        expect(
          (await f.staff(command.operation, command.input, f.memberAuth))
            .status,
          command.operation,
        ).toBe(403);
      }
      expect(await f.roleStore.getRoleAssignment(supportId)).toEqual(
        originalSupport,
      );
      expect(
        (
          await f.roleStore.listActiveRoleAssignments(member, APPLICATION_SCOPE)
        ).map((assignment) => assignment.role),
      ).toEqual([SUPPORT_ROLE]);
      expect(
        await f.roleStore.getRoleAssignment(`${KNOWLEDGE_ROLE}-${member}`),
      ).toBeNull();

      const knowledgeId = await f.grant(member, KNOWLEDGE_ROLE);
      expect((await state()).status).toBe(200);
      const readable = await f.staff(
        'reportRead',
        {
          articleId: created.id,
          ledgerEpoch: prepared.report.ledgerEpoch,
          reportId: prepared.report.reportId,
        },
        f.memberAuth,
      );
      expect(readable.status).toBe(200);
      expect(await readable.json()).toMatchObject({
        reportId: prepared.report.reportId,
        submittedBy: owner,
        status: 'pending',
      });
      const knowledgeAssignment =
        await f.roleStore.getRoleAssignment(knowledgeId);
      const removed = await f.roleStore.revokeRoleAssignmentWithAudit({
        assignmentId: knowledgeId,
        expectedConcurrencyToken: knowledgeAssignment!.concurrencyToken,
        revokedBy: { kind: 'principal', principalId: owner },
        revokedAtEpochMs: Date.parse(f.clock.now()) + 1,
        auditEventId: 'explicitly-remove-knowledge-role',
      });
      expect(removed.status).toBe('revoked');
      expect((await state()).status).toBe(403);
      for (const command of privateOperations) {
        expect(
          (await f.staff(command.operation, command.input, f.memberAuth))
            .status,
          command.operation,
        ).toBe(403);
      }
      expect(
        (await f.roleStore.getRoleAssignment(knowledgeId))?.assignment.status,
      ).toBe('revoked');
      expect(
        (await f.roleStore.getRoleAssignment(supportId))?.assignment,
      ).toEqual(originalSupport!.assignment);
      expect(
        (
          await f.roleStore.listActiveRoleAssignments(member, APPLICATION_SCOPE)
        ).map((assignment) => assignment.role),
      ).toEqual([SUPPORT_ROLE]);
      const runtime = createSupportRuntime({
        store: f.store,
        sessions: f.sessions,
        identity: f.identity,
        logger: f.logger,
        clock: f.clock,
        identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
      });
      const support = createSupportApi({
        application: runtime.application,
        sessions: f.sessions,
        identity: f.identity,
        identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
        createLimiter: runtime.createLimiter,
        replyLimiter: runtime.replyLimiter,
        logger: f.logger,
        roleStore: runtime.roleStore,
      });
      expect(
        (
          await support(
            browserRequest('/api/support/tickets', f.ownerAuth, {
              subject: 'Synthetic desk request after role removal',
              body: 'Human support remains available without Knowledge access.',
              category: 'feedback',
            }),
          )
        ).status,
      ).toBe(201);
      expect(
        (
          await support(
            browserRequest(
              '/api/support/admin/queue',
              f.memberAuth,
              undefined,
              'GET',
            ),
          )
        ).status,
      ).toBe(200);
    });

    it('preserves existing customer and stored Support-role request flows alongside agent linking', async () => {
      const f = await fixture();
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
    it('recovers a full report ledger through explicit bounded reset and refuses the old epoch and receipt', async () => {
      const f = await fixture();
      const { token } = await f.device();
      const created = await createAgentDraft(f, token.access_token);
      const prepared = await confirmedReport(f, token.access_token, created.id);
      const discovered = await f.reportLedger(token.access_token, created.id);
      expect(discovered.status).toBe(200);
      const ledger = (await discovered.json()) as KnowledgeReportLedgerState;
      expect(Object.keys(ledger).sort()).toEqual([
        'articleId',
        'ledgerEpoch',
        'reportsRemaining',
        'rowsRemaining',
        'status',
      ]);
      expect(ledger.status).toBe('active');
      expect(ledger.reportsRemaining).toBe(15);
      for (let index = 0; index < ledger.reportsRemaining; index += 1) {
        const pending = await f.report(token.access_token, {
          ...prepared.reportCommand,
          commandId: `fill-report-capacity:${index}`,
          report: {
            summary: `Synthetic pending report ${index}`,
            details:
              'A separately submitted bounded fixture report awaits human review.',
          },
        });
        expect(pending.status).toBe(200);
      }
      const fullResponse = await f.reportLedger(token.access_token, created.id);
      const full = (await fullResponse.json()) as KnowledgeReportLedgerState;
      expect(full.reportsRemaining).toBe(0);
      const refused = await f.report(token.access_token, {
        ...prepared.reportCommand,
        commandId: 'seventeenth-report-refused',
      });
      expect(refused.status).toBe(409);
      const reset = await f.staffValue<KnowledgeReportLedgerState>(
        'resetReports',
        {
          commandId: 'reset-full-report-ledger',
          articleId: created.id,
          expectedLedgerEpoch: full.ledgerEpoch,
        },
      );
      expect(reset.ledgerEpoch).toBe(full.ledgerEpoch + 1);
      expect(reset.status).toBe('resetting');
      expect(
        (await f.report(token.access_token, prepared.reportCommand)).status,
      ).toBe(409);
      expect(
        (
          await f.reportStatus(
            token.access_token,
            created.id,
            prepared.report.ledgerEpoch,
            prepared.report.reportId,
          )
        ).status,
      ).toBe(409);
      expect((await f.staff('confirmReport', prepared.confirm)).status).toBe(
        409,
      );
      expect(
        (
          await f.report(token.access_token, {
            ...prepared.reportCommand,
            commandId: 'admission-during-reset-refused',
            ledgerEpoch: reset.ledgerEpoch,
          })
        ).status,
      ).toBe(409);
      const drained = await drainReportLedger(f, reset);
      expect(drained.reportsRemaining).toBe(16);
      expect(drained.rowsRemaining).toBeGreaterThan(0);
      expect(
        (await f.report(token.access_token, prepared.reportCommand)).status,
      ).toBe(409);
      const currentRead = await f.agent(token.access_token, 'getDraft', {
        articleId: created.id,
      });
      const current = (
        (await currentRead.json()) as { result: DraftArticleDto }
      ).result;
      const oldReceipt = await f.agent(token.access_token, 'submitEvidence', {
        commandId: 'old-epoch-cannot-authorize-new-evidence',
        correlationId: 'integration',
        expectedGeneration: current.generation,
        articleId: created.id,
        evidence: prepared.evidence,
        receipt: prepared.report.receipt,
      });
      expect(oldReceipt.status).toBe(412);
      const recovered = await confirmedReport(
        f,
        token.access_token,
        created.id,
        workflowCheck,
        'after-reset',
      );
      expect(recovered.report.ledgerEpoch).toBe(drained.ledgerEpoch);
      expect(recovered.report.receipt).not.toBe(prepared.report.receipt);
      const accepted = await f.agent(token.access_token, 'submitEvidence', {
        commandId: 'fresh-epoch-evidence-accepted',
        correlationId: 'integration',
        expectedGeneration: recovered.article.generation,
        articleId: created.id,
        evidence: recovered.evidence,
        receipt: recovered.report.receipt,
      });
      expect(accepted.status).toBe(200);
      const acceptedEvidence = await f.staffValue<EvidenceDto>('getEvidence', {
        articleId: created.id,
      });
      expect(acceptedEvidence.evidence).toHaveLength(1);
      expect(acceptedEvidence.evidence[0]!.attestation.id).toBe(
        recovered.report.receipt,
      );
    });

    it('retains already accepted SDK evidence and publication after report ledger reset and drain', async () => {
      const f = await fixture();
      const { token } = await f.pkce();
      const created = await createAgentDraft(f, token.access_token);
      const required = await f.agent(
        token.access_token,
        'getValidationRequirements',
        { collectionId: 'integration-guides', kind: 'walkthrough' },
      );
      expect(required.status).toBe(200);
      const requirements = (
        (await required.json()) as { result: ValidationRequirementsDto }
      ).result;
      const reports: Awaited<ReturnType<typeof confirmedReport>>[] = [];
      let generation = created.generation;
      for (const check of requirements.checks) {
        const prepared = await confirmedReport(
          f,
          token.access_token,
          created.id,
          check,
          'retained-publication',
        );
        reports.push(prepared);
        const accepted = await f.agent(token.access_token, 'submitEvidence', {
          commandId: `retained-publication-evidence:${check.id}`,
          correlationId: 'integration',
          expectedGeneration: prepared.article.generation,
          articleId: created.id,
          evidence: prepared.evidence,
          receipt: prepared.report.receipt,
        });
        expect(accepted.status).toBe(200);
        generation = (
          (await accepted.json()) as {
            result: CommandResult<ArticleAcknowledgement>;
          }
        ).result.value.generation;
      }
      const submitted = await f.staffValue<
        CommandResult<ArticleAcknowledgement>
      >('submitForReview', {
        commandId: 'submit-retained-publication',
        correlationId: 'integration',
        expectedGeneration: generation,
        articleId: created.id,
      });
      const review = await f.staffValue<ReviewDto>('getReview', {
        articleId: created.id,
      });
      const published = await f.staffValue<
        CommandResult<ArticleAcknowledgement>
      >('publishArticle', {
        commandId: 'publish-retained-guide',
        correlationId: 'integration',
        expectedGeneration: submitted.value.generation,
        articleId: created.id,
        review: review.review,
      });
      expect(published.value.state).toBe('published');
      const portal = () =>
        f.knowledgeRequest(
          browserRequest('/api/knowledge/portal', f.memberAuth, {
            operation: 'getPublishedArticle',
            input: { articleId: created.id },
          }),
        );
      const beforeRead = await portal();
      expect(beforeRead.status).toBe(200);
      const beforePublication = await beforeRead.json();
      const beforeEvidence = await f.staffValue<EvidenceDto>('getEvidence', {
        articleId: created.id,
      });
      expect(beforeEvidence.evidence).toHaveLength(requirements.checks.length);
      expect(
        beforeEvidence.evidence.map((item) => item.attestation.id).sort(),
      ).toEqual(reports.map((item) => item.report.receipt).sort());
      const ledger = await f.staffValue<KnowledgeReportLedgerState>(
        'reportLedger',
        { articleId: created.id },
      );
      const reset = await f.staffValue<KnowledgeReportLedgerState>(
        'resetReports',
        {
          commandId: 'reset-retained-publication-ledger',
          articleId: created.id,
          expectedLedgerEpoch: ledger.ledgerEpoch,
        },
      );
      await drainReportLedger(f, reset);
      expect(
        (await f.report(token.access_token, reports[0]!.reportCommand)).status,
      ).toBe(409);
      expect(
        (
          await f.reportStatus(
            token.access_token,
            created.id,
            reports[0]!.report.ledgerEpoch,
            reports[0]!.report.reportId,
          )
        ).status,
      ).toBe(409);
      const afterRead = await portal();
      expect(afterRead.status).toBe(200);
      expect(await afterRead.json()).toEqual(beforePublication);
      expect(
        await f.staffValue<EvidenceDto>('getEvidence', {
          articleId: created.id,
        }),
      ).toEqual(beforeEvidence);
      const stillPublished = await f.agent(token.access_token, 'getDraft', {
        articleId: created.id,
      });
      expect(await stillPublished.json()).toMatchObject({
        result: { state: 'published', hasPublication: true },
      });
    });

    it('isolates independently consented grants and honors stored Admin demotion on the next request', async () => {
      const f = await fixture();
      const first = await f.device();
      const second = await f.pkce();
      const created = await createAgentDraft(f, first.token.access_token);
      const delegated = await f.agents.service.authenticate({
        token: first.token.access_token,
        resource,
      });
      const revoked = await f.agentRequest(
        browserRequest(
          '/api/agent-access/grants/' + delegated.grantId,
          f.ownerAuth,
          undefined,
          'DELETE',
        ),
      );
      expect(revoked.status).toBe(204);
      expect(
        (
          await f.agent(first.token.access_token, 'getDraft', {
            articleId: created.id,
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await f.agent(second.token.access_token, 'getDraft', {
            articleId: created.id,
          })
        ).status,
      ).toBe(200);
      const current = await f.roleStore.getRoleAssignment(
        ADMIN_ROLE + '-' + owner,
      );
      await f.roleStore.revokeRoleAssignmentWithAudit({
        assignmentId: ADMIN_ROLE + '-' + owner,
        expectedConcurrencyToken: current!.concurrencyToken,
        revokedBy: { kind: 'principal', principalId: otherOwner },
        revokedAtEpochMs: Date.parse(f.clock.now()) + 1,
        auditEventId: 'demote-owner-with-independent-grants',
      });
      expect(
        (
          await f.agent(second.token.access_token, 'getDraft', {
            articleId: created.id,
          })
        ).status,
      ).toBe(401);
      expect(
        (await f.mcp(second.token.access_token, 'tools/list', {})).status,
      ).toBe(401);
      expect(
        (
          await f.roleStore.listActiveRoleAssignments(member, APPLICATION_SCOPE)
        ).map((assignment) => assignment.role),
      ).toEqual([SUPPORT_ROLE]);
    });
  });
}
