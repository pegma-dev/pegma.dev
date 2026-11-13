import { afterEach, describe, expect, it, vi } from 'vitest';
import * as d1 from '@pegma/storage-cloudflare-d1';
import * as supportDesk from './support-desk';
import * as engineeringComposition from './support-engineering-composition';
import { createWorker } from './index';
import { SUPPORT_ENGINEERING_QUEUE } from './support-engineering-queue';
import { CLEANUP_CRON, cleanupLaneAt } from './maintenance-schedule';
import * as identityMaintenance from './identity-maintenance';
import {
  driverHintRows,
  driverHintKey,
  createDeferredDriverChecksFixture,
} from './support-engineering-driver-fixtures';
import {
  engineeringHttpObject,
  engineeringHttpResult,
  engineeringHttpNumber,
} from './support-engineering-http-fixtures';
import type {
  EngineeringCandidate,
  EngineeringExportRequest,
  EngineeringRepositoryDescriptor,
  EngineeringExportChecksBinding,
} from '@pegma/support-desk-application';
import type {
  EngineeringProposalPort,
  EngineeringChecksPort,
} from '@pegma/support-desk-ai';
import {
  createSupportIndependentChecks,
  type IndependentCheckCapture,
} from './support-independent-checks';
import { createSupportEngineeringHttpFixture } from './support-engineering-http-fixtures';
import { createSupportRuntime } from './support-desk';
import { composeSupportEngineeringProcessing } from './support-engineering-processing';
import {
  SUPPORT_ENGINEERING_ENDPOINT,
  SUPPORT_ENGINEERING_WIRE_VERSION,
  supportEngineeringRoutePolicySha256,
  type ApprovedSupportEngineeringRoute,
} from './support-engineering-config';
import {
  createProductionSupportEngineering,
  createSupportEngineeringLocalProposals,
  type SupportEngineeringProductionOptions,
  type SupportEngineeringProposalSettings,
  type SupportEngineeringSharedChecks,
} from './support-engineering-production';

vi.mock('@pegma/storage-cloudflare-d1', async (original) => ({
  ...(await original<typeof import('@pegma/storage-cloudflare-d1')>()),
  createCloudflareD1Store: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

const now = '2026-11-10T12:00:00.000Z';
const clock = { now: () => now };
const allowed: EngineeringRepositoryDescriptor = {
  repositoryId: '101',
  owner: 'fictional-org',
  name: 'workspace-core',
  visibility: 'public',
  responsibilities: 'Workspace file creation.',
  product: 'workspace',
  component: 'export',
  version: '2.x',
  allowedLabels: ['bug'],
  allowedTemplates: ['bug-report'],
  publicationMode: 'approval_required',
  enabled: true,
};
const repository = {
  repositoryId: '101',
  owner: allowed.owner,
  name: allowed.name,
  visibility: 'public' as const,
  installationBinding: 'fictional-installation-binding',
  metadataVersion: 'fictional-metadata-v1',
};
const marker = 'pegma-engineering:' + 'a'.repeat(48);
const settings: SupportEngineeringProposalSettings = {
  labels: ['bug'],
  templateId: 'bug-report',
  evidenceReferences: ['approved-fictional-public-reproduction'],
};
function candidate(): EngineeringCandidate {
  return {
    title: 'Workspace export omits rows',
    summary: 'The fictional export has no rows.',
    expectedBehavior: 'Export retains rows.',
    actualBehavior: 'Export is empty.',
    reproductionSteps: ['Create one fictional row.', 'Export the workspace.'],
    applicability: {
      productId: 'workspace',
      version: '2.3.0',
      buildId: 'synthetic-build-230',
    },
    security: 'ordinary',
    routing: {
      outcome: 'selected',
      repositoryId: '101',
      alternativeRepositoryIds: [],
      rationale: 'The configured file component owns export.',
    },
  };
}
const context = () => ({
  purpose: 'support_bug_assessment' as const,
  deadline: '2026-11-10T12:00:25.000Z',
  signal: new AbortController().signal,
});
function input(): Parameters<EngineeringProposalPort['prepare']>[0] {
  return {
    candidate: candidate(),
    repository: { ...repository },
    descriptor: structuredClone(allowed),
    exportMarker: marker,
    duplicates: [],
  };
}
function local(choices: SupportEngineeringProposalSettings | null = settings) {
  return createSupportEngineeringLocalProposals(
    {
      readDuplicateQuery: () => 'workspace export',
      readSettings: () => choices,
    },
    clock,
  );
}
async function prepared(): Promise<EngineeringExportRequest> {
  const result = await local().prepare(input(), context());
  if (result.outcome !== 'prepared')
    throw new Error('Expected actual local prepared request');
  return result.request;
}

describe('server-local engineering proposals', () => {
  it('constructs only bounded candidate content, exact approved references and one opaque marker', async () => {
    const value = input();
    Reflect.set(
      value.candidate!,
      'summary',
      '<!-- hidden --> [link](https://example.test)',
    );
    const result = await local().prepare(value, context());
    expect(result.outcome).toBe('prepared');
    if (result.outcome !== 'prepared') return;
    expect(result.request).toMatchObject({
      operation: 'create_issue',
      repository,
      bundle: {
        title: value.candidate!.title,
        labels: ['bug'],
        templateId: 'bug-report',
        evidenceReferences: settings.evidenceReferences,
        exportMarker: marker,
      },
    });
    expect(result.request.bundle.body).not.toContain('<!-- hidden');
    expect(result.request.bundle.body).not.toContain('[link](https://');
    expect(
      result.request.bundle.body.match(/pegma-engineering:/gu),
    ).toHaveLength(1);
    expect(result.request.bundle.body).toContain(
      'approved\\-fictional\\-public\\-reproduction',
    );
    expect(result.request.bundle.body).not.toContain('installationBinding');
    expect(
      new TextEncoder().encode(JSON.stringify(result.request)).byteLength,
    ).toBeLessThanOrEqual(24_000);
  });
  it.each([
    'repo:other/private',
    'export OR password',
    ' private ',
    'x'.repeat(257),
  ])('refuses unsafe configured duplicate query %s', async (query) => {
    const proposals = createSupportEngineeringLocalProposals(
      { readDuplicateQuery: () => query, readSettings: () => settings },
      clock,
    );
    expect(await proposals.duplicateQuery(allowed, context())).toBeNull();
  });
  it('does not derive query terms from candidate or ticket content', async () => {
    expect(await local().duplicateQuery(allowed, context())).toBe(
      'workspace export',
    );
    expect(await local(null).prepare(input(), context())).toEqual({
      outcome: 'held',
    });
  });
  it.each([
    'labels',
    'template',
    'references',
    'marker',
    'descriptor',
    'disabled',
    'unknown-field',
    'body-cap',
  ] as const)(
    'holds invalid %s rather than silently truncating or weakening current policy',
    async (kind) => {
      const value = input();
      const chosen = structuredClone(settings);
      if (kind === 'labels') Reflect.set(chosen, 'labels', ['not-allowed']);
      if (kind === 'template') Reflect.set(chosen, 'templateId', 'not-allowed');
      if (kind === 'references')
        Reflect.set(
          chosen,
          'evidenceReferences',
          Array.from({ length: 17 }, (_, i) => 'ref-' + i),
        );
      if (kind === 'marker') Reflect.set(value.candidate!, 'summary', marker);
      if (kind === 'descriptor')
        Reflect.set(value.repository, 'visibility', 'private');
      if (kind === 'disabled') Reflect.set(value.descriptor, 'enabled', false);
      if (kind === 'unknown-field')
        Reflect.set(value.candidate!, 'privateTicket', 'PRIVATE_TICKET');
      if (kind === 'body-cap')
        Reflect.set(
          value.candidate!,
          'reproductionSteps',
          Array(16).fill('x'.repeat(1_000)),
        );
      expect(await local(chosen).prepare(value, context())).toEqual({
        outcome: 'held',
      });
    },
  );
  it.each(['restricted', 'uncertain'] as const)(
    'does not turn %s sensitivity into an ordinary export',
    async (security) => {
      const value = input();
      Reflect.set(value.candidate!, 'security', security);
      expect(await local().prepare(value, context())).toEqual({
        outcome: 'restricted',
      });
    },
  );
  it('links only an explicitly selected duplicate currently observed in the destination', async () => {
    const value = input();
    const duplicate = {
      repositoryId: '101',
      issueId: '991',
      issueNumber: 19,
      title: 'Current observed issue',
      body: 'A public fictional issue.',
    };
    Reflect.set(value, 'duplicates', [duplicate]);
    const proposed = await local({
      ...settings,
      duplicate: { issueId: '991', issueNumber: 19 },
    }).prepare(value, context());
    expect(proposed).toMatchObject({
      outcome: 'prepared',
      request: {
        operation: 'link_existing_issue',
        issueId: '991',
        issueNumber: 19,
      },
    });
    expect(
      await local({
        ...settings,
        duplicate: { issueId: '991', issueNumber: 20 },
      }).prepare(value, context()),
    ).toEqual({ outcome: 'held' });
    Reflect.set(value, 'duplicates', [{ ...duplicate, repositoryId: '202' }]);
    expect(
      await local({
        ...settings,
        duplicate: { issueId: '991', issueNumber: 19 },
      }).prepare(value, context()),
    ).toEqual({ outcome: 'held' });
  });
  it('rebuilds a retained compacted request without inventing evidence or retaining the old marker', async () => {
    const previousRequest = await prepared();
    const nextMarker = 'pegma-engineering:' + 'b'.repeat(48);
    const value = {
      previousRequest,
      descriptor: allowed,
      repository,
      exportMarker: nextMarker,
      duplicates: [],
    };
    const rebuilt = await local().prepare(value, context());
    expect(rebuilt).toMatchObject({
      outcome: 'prepared',
      request: {
        bundle: {
          exportMarker: nextMarker,
          evidenceReferences: settings.evidenceReferences,
        },
      },
    });
    if (rebuilt.outcome === 'prepared') {
      expect(rebuilt.request.bundle.body).not.toContain(marker);
      expect(rebuilt.request.bundle.body).toBe(
        previousRequest.bundle.body.replace(marker, nextMarker),
      );
    }
    expect(
      await local({
        ...settings,
        evidenceReferences: ['different-unbound-reference'],
      }).prepare(value, context()),
    ).toEqual({ outcome: 'held' });
  });
  it('refuses malformed retained marker boundaries and an unobserved retained existing-issue identity', async () => {
    const request = await prepared();
    const key = {
      descriptor: allowed,
      repository,
      exportMarker: 'pegma-engineering:' + 'b'.repeat(48),
      duplicates: [],
    };
    expect(
      await local().prepare(
        {
          ...key,
          previousRequest: {
            ...request,
            bundle: { ...request.bundle, body: request.bundle.body + 'suffix' },
          },
        },
        context(),
      ),
    ).toEqual({ outcome: 'held' });
    expect(
      await local().prepare(
        {
          ...key,
          previousRequest: {
            ...request,
            operation: 'link_existing_issue',
            issueId: '991',
            issueNumber: 19,
          },
        },
        context(),
      ),
    ).toEqual({ outcome: 'held' });
  });
  it('uses current purpose, cancellation and deadline without calling local policy after cancellation', async () => {
    const readSettings = vi.fn(() => settings);
    const proposals = createSupportEngineeringLocalProposals(
      { readSettings, readDuplicateQuery: () => 'workspace' },
      clock,
    );
    const controller = new AbortController();
    controller.abort();
    expect(
      await proposals.prepare(input(), {
        ...context(),
        signal: controller.signal,
      }),
    ).toEqual({ outcome: 'held' });
    expect(
      await proposals.prepare(input(), { ...context(), deadline: now }),
    ).toEqual({ outcome: 'held' });
    expect(readSettings).not.toHaveBeenCalled();
  });
  it('holds invalid clock and changing local deadline without completing a proposal', async () => {
    let currentTime = now;
    const invalid = createSupportEngineeringLocalProposals(
      { readDuplicateQuery: () => 'workspace', readSettings: () => settings },
      { now: () => 'invalid' },
    );
    expect(await invalid.duplicateQuery(allowed, context())).toBeNull();
    expect(await invalid.prepare(input(), context())).toEqual({
      outcome: 'held',
    });
    const expires = createSupportEngineeringLocalProposals(
      {
        readDuplicateQuery: () => 'workspace',
        readSettings: () => {
          currentTime = context().deadline;
          return settings;
        },
      },
      { now: () => currentTime },
    );
    expect(await expires.prepare(input(), context())).toEqual({
      outcome: 'held',
    });
  });
});

/** A read-scoped installation-token POST is permitted; every issue mutation
 * and any wider requested scope remains forbidden before human publication. */
function readOnlyGitHubRequest([url, init]: readonly [
  string,
  RequestInit,
]): boolean {
  if (init.method === 'GET') return true;
  if (
    url !== 'https://api.github.com/app/installations/201/access_tokens' ||
    init.method !== 'POST'
  )
    return false;
  try {
    const body = JSON.parse(String(init.body));
    return (
      Object.keys(body).length === 2 &&
      Array.isArray(body.repository_ids) &&
      body.repository_ids.length === 1 &&
      body.repository_ids[0] === 101 &&
      body.permissions &&
      Object.keys(body.permissions).length === 2 &&
      body.permissions.metadata === 'read' &&
      body.permissions.issues === 'read'
    );
  } catch {
    return false;
  }
}

/** Actual App/Identity/RoleStore/coordinator/ledger/config/model/GitHub adapters.
 * All independent proof and HTTP provider observations here are fictional local ports. */
async function fixture() {
  const f = await createSupportEngineeringHttpFixture();
  const clock = f.engineering.clock;
  const validUntil = new Date(
    Date.parse(clock.now()) + 3_600_000,
  ).toISOString();
  const state = {
    enabled: true,
    repositoryEnabled: true,
    writeEnabled: false,
    productReady: true,
    modelReady: true,
    authorityReady: true,
  };
  const productContext = {
    resolve: vi.fn(async (context: { acceptedAt: string }) =>
      state.productReady
        ? {
            productId: 'workspace',
            version: '2.3.0',
            buildId: 'synthetic-build-230',
            binding: 'synthetic-workspace-230-binding',
            contextVersion: 'synthetic-product-context-v1',
            receiptId: 'fictional-product-receipt',
            verifiedAt: context.acceptedAt,
            validUntil,
          }
        : null,
    ),
  };
  const authentication = {
    resolve: vi.fn(async () =>
      state.authorityReady
        ? {
            active: true as const,
            appId: '301',
            installationId: '201',
            binding: 'fictional-installation-authority',
            version: 'fictional-installation-v1',
            validUntil,
            appJwt: 'FICTIONAL_APP_JWT',
            installationToken: 'FICTIONAL_INSTALLATION_TOKEN',
          }
        : null,
    ),
  };
  const observedRepository = {
    id: 101,
    name: allowed.name,
    full_name: allowed.owner + '/' + allowed.name,
    owner: { id: 401, login: allowed.owner, type: 'Organization' },
    private: false,
    visibility: 'public',
    archived: false,
    disabled: false,
    has_issues: true,
    default_branch: 'main',
    updated_at: '2026-11-10T11:00:00Z',
  };
  const githubFetch = vi.fn(async (url: string, init: RequestInit) => {
    if (url === 'https://api.github.com/app/installations/201/access_tokens') {
      // Issue reads now use a token restricted to the exact numeric repository.
      // This credential POST is not issue publication or an issues:write grant.
      expect(readOnlyGitHubRequest([url, init])).toBe(true);
      return Response.json(
        {
          token: 'FICTIONAL_REPOSITORY_READ_TOKEN',
          expires_at: validUntil.replace('.000Z', 'Z'),
          repository_selection: 'selected',
          permissions: { metadata: 'read', issues: 'read' },
          repositories: [observedRepository],
        },
        { status: 201 },
      );
    }
    expect(init.method).toBe('GET');
    if (url.includes('/search/issues?'))
      return Response.json({
        total_count: 0,
        incomplete_results: false,
        items: [],
      });
    return Response.json(
      url.endsWith('/installation')
        ? {
            id: 201,
            app_id: 301,
            account: { id: 401, login: allowed.owner, type: 'Organization' },
            target_id: 401,
            target_type: 'Organization',
            suspended_at: null,
            repository_selection: 'selected',
            permissions: { metadata: 'read', issues: 'write' },
            updated_at: '2026-11-10T11:00:00Z',
          }
        : observedRepository,
    );
  });
  const config = f.engineering.configuration;
  const routeBase: Omit<ApprovedSupportEngineeringRoute, 'approval'> = {
    host: 'pegma.dev' as const,
    purpose: 'support_bug_assessment' as const,
    endpoint: SUPPORT_ENGINEERING_ENDPOINT,
    endpointTag: 'fictional/region-one',
    outputTokenParameter: 'max_tokens' as const,
    credentialRef: 'fictional-engineering-key',
    usageScopeRef: 'synthetic-engineering-budget',
    configuration: config,
  };
  const route: ApprovedSupportEngineeringRoute = {
    ...routeBase,
    approval: {
      configurationVersion: config.version,
      wireVersion: SUPPORT_ENGINEERING_WIRE_VERSION,
      evidenceRef: 'fictional-approval',
      effectivePolicyRef: 'fictional-policy',
      evaluationRef: 'fictional-evaluation',
      responseIdentityRef: 'fictional-provider',
      tokenizerRef: 'fictional-counter',
      requestPolicySha256: await supportEngineeringRoutePolicySha256(routeBase),
      nativeCostCurrency: 'USD',
      nativeCostUnit: 'openrouter_credits_usd',
      rounding: 'ceil_micro',
      zdr: true,
      safetyRetention: false,
      inputOutputLogging: false,
      inputOutputUse: false,
      broadcast: false,
      responseCache: false,
      unreviewedFeatures: false,
      implicitCache: 'absent',
      verifiedAt: clock.now(),
      validUntil,
    },
  };
  const readApiKey = vi.fn(() => 'FICTIONAL_MODEL_KEY');
  const modelFetch = vi.fn(async () =>
    Response.json({
      id: 'gen-fictional-engineering',
      object: 'chat.completion',
      provider: config.provider,
      model: config.model,
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: JSON.stringify(candidate()) },
        },
      ],
      usage: {
        prompt_tokens: 200,
        completion_tokens: 160,
        total_tokens: 360,
        cost: 0.00047344,
        currency: 'USD',
      },
    }),
  );
  const configuration: NonNullable<
    SupportEngineeringProductionOptions['configuration']
  > = {
    application: { enabled: true, maxModelAttempts: 1 },
    productContext,
    serviceAccess: f.engineering.ports.serviceAccess,
    reconciliationAccess: f.engineering.ports.reconciliationAccess,
    routing: f.engineering.ports.routing,
    checks: f.engineering.ports.checks,
    repository: {
      repositories: [
        {
          repositoryId: '101',
          owner: allowed.owner,
          name: allowed.name,
          visibility: 'public',
          appId: '301',
          installationId: '201',
        },
      ],
      enabled: () => state.repositoryEnabled,
      issueCreationEnabled: () => state.writeEnabled,
      authentication,
      fetch: githubFetch,
    },
    proposals: {
      readDuplicateQuery: () => 'workspace export',
      readSettings: () => settings,
    },
    model: {
      readRoute: () => (state.modelReady ? route : undefined),
      readApiKey,
      fetch: modelFetch,
      allowlist: [
        {
          model: config.model,
          provider: config.provider,
          endpointTag: route.endpointTag,
          outputTokenParameter: 'max_tokens',
        },
      ],
      counter: {
        qualification: {
          model: config.model,
          modelVersion: config.modelVersion,
          wireVersion: SUPPORT_ENGINEERING_WIRE_VERSION,
          framingTokens: config.framingTokens,
          evidenceRef: route.approval.tokenizerRef,
          verifiedAt: clock.now(),
          validUntil,
        },
        count: (value) => Math.max(1, Math.ceil(value.length / 4)),
      },
    },
    usagePolicy: {
      version: 'fictional-pool',
      scopeRef: route.usageScopeRef,
      configurationVersion: config.version,
      modelVersion: config.modelVersion,
      pricingRef: config.pricingRef,
      currency: 'USD',
      maxCostMicros: 100_000,
      maxReservationCostMicros: 1_000,
      maxReservations: 8,
      validFrom: clock.now(),
      validUntil,
      terminalRetentionMilliseconds: 60_000,
    },
  };
  const options: SupportEngineeringProductionOptions = {
    clock,
    enabled: () => state.enabled,
    configuration,
  };
  const production = createProductionSupportEngineering(options);
  const host = createSupportRuntime({
    store: f.host.store,
    clock,
    identity: f.host.identity,
    sessions: f.host.sessions,
    identityLinkFromClaims: f.options.identityLinkFromClaims,
    logger: f.options.logger,
    engineering: production.application,
  });
  if (!production.attachRuntime?.({ store: f.host.store, clock, application: () => host.application }))
    throw new Error('Expected actual Store receipt binding.');
  const policy = await host.application.putRepositoryPolicy(
    f.engineering.actors.admin,
    {
      commandId: 'PRODUCTION-POLICY',
      correlationId: 'fictional-production',
      expectedGeneration: 1,
      policy: { enabled: true, repositories: [allowed] },
    },
  );
  f.engineering.state.calibrationPolicyHash = policy.policyHash;
  const runtime = composeSupportEngineeringProcessing(
    host,
    production.processing,
  );
  async function eligible() {
    const ticket = await f.engineering.createTicket();
    await host.application.enrollEngineeringSource(f.engineering.actors.staff, {
      ...f.engineering.command('enroll'),
      ticketId: ticket.id,
      expectedRevision: ticket.revision,
    });
    return host.application.submitEngineeringEvidence(
      f.engineering.actors.staff,
      {
        ...f.engineering.command('failure'),
        ticketId: ticket.id,
        expectedRevision: ticket.revision,
        security: 'ordinary',
        evidence: {
          kind: 'staff_verified_failure',
          expectedBehavior: 'Export retains rows.',
          actualBehavior: 'Export is empty.',
          reproductionSteps: [
            'Create one fictional row.',
            'Export the workspace.',
          ],
          visibleMessageIds: ['engineering-question'],
          verificationReference: 'SYNTHETIC_PRIVATE_FAILURE_REFERENCE',
        },
      },
    );
  }
  return {
    f,
    state,
    options,
    configuration,
    production,
    host,
    runtime,
    eligible,
    productContext,
    authentication,
    modelFetch,
    readApiKey,
    githubFetch,
  };
}

describe('normal production engineering composition', () => {
  it('binds creation receipts to the actual Store independently of model readiness', async () => {
    const t = await fixture();
    t.state.modelReady = false;
    t.state.enabled = false;
    const collection = vi.spyOn(t.host.store, 'collection');
    const production = createProductionSupportEngineering(t.options);
    expect(collection).not.toHaveBeenCalled();
    expect(production.attachRuntime?.({
      store: t.host.store, clock, application: () => t.host.application,
    })).toBe(true);
    expect(collection.mock.calls.some(([definition]) =>
      definition.name.includes('support-engineering-creation'))).toBe(true);
    expect(production.attachRuntime?.({
      store: t.host.store, clock, application: () => t.host.application,
    })).toBe(false);
    expect(t.authentication.resolve).not.toHaveBeenCalled();
    expect(t.modelFetch).not.toHaveBeenCalled();
    expect(t.readApiKey).not.toHaveBeenCalled();
    expect(t.githubFetch).not.toHaveBeenCalled();
  });
  it('keeps omitted or flag-only composition OFF and constructs no authorities', () => {
    for (const options of [{}, { enabled: () => true }]) {
      const result = createProductionSupportEngineering(options);
      expect(result.application.enabled).toBe(false);
      expect(result.processing.configuration).toBeUndefined();
      expect(result.reviewProofs).toBeUndefined();
    }
  });
  it.each([
    'productContext',
    'serviceAccess',
    'reconciliationAccess',
    'routing',
    'checks',
    'repository',
    'proposals',
  ] as const)(
    'keeps incomplete trusted %s configuration OFF without credential or provider work',
    async (field) => {
      const t = await fixture();
      Reflect.set(t.configuration, field, undefined);
      const production = createProductionSupportEngineering(t.options);
      expect(production.application.enabled).toBe(false);
      expect(production.processing.configuration).toBeUndefined();
      expect(production.reviewProofs).toBeUndefined();
      expect(t.productContext.resolve).not.toHaveBeenCalled();
      expect(t.readApiKey).not.toHaveBeenCalled();
      expect(t.authentication.resolve).not.toHaveBeenCalled();
      expect(t.modelFetch).not.toHaveBeenCalled();
      expect(t.githubFetch).not.toHaveBeenCalled();
    },
  );
  it('uses the same real verifiers for App, processing and human review without inventing grants', async () => {
    const t = await fixture();
    expect(t.production.application.productContext).toBe(t.productContext);
    expect(t.production.application.routing).toBe(t.configuration.routing);
    expect(t.production.application.checks).toBe(t.configuration.checks);
    expect(t.production.reviewProofs?.serviceAccess).toBe(
      t.configuration.serviceAccess,
    );
    expect(
      t.production.processing.configuration?.ports.reconciliationAccess,
    ).toBe(t.configuration.reconciliationAccess);
    expect(t.modelFetch).not.toHaveBeenCalled();
    expect(t.authentication.resolve).not.toHaveBeenCalled();
    const source = await t.eligible();
    expect(source.state).toBe('eligible');
    expect(t.productContext.resolve).toHaveBeenCalledOnce();
  });
  it('runs actual App and coordinator preparation through current model/config/usage/GitHub ports, retaining staff approval', async () => {
    const t = await fixture();
    const source = await t.eligible();
    const command = {
      ticketId: source.ticketId,
      sourceGeneration: source.sourceGeneration,
      workerId: 'production-worker',
      leaseMilliseconds: 30_000,
    };
    expect(await t.runtime.processWork(command)).toMatchObject({
      outcome: 'candidate',
    });
    expect(await t.runtime.processWork(command)).toMatchObject({
      outcome: 'prepared',
    });
    const work = await t.host.application.readEngineeringWork(
      t.f.engineering.actors.security,
      { ticketId: source.ticketId, sourceGeneration: source.sourceGeneration },
    );
    expect(work.proposal?.request.bundle.evidenceReferences).toEqual(
      settings.evidenceReferences,
    );
    expect(work.proposal?.request.bundle.body).not.toContain(
      'SYNTHETIC_PRIVATE_ENGINEERING_NOTE',
    );
    expect(work.proposal?.request.bundle.body).not.toContain(
      'SYNTHETIC_PRIVATE_FAILURE_REFERENCE',
    );
    expect(work.approval).toBeUndefined();
    expect(work.dispatch).toBeUndefined();
    expect(t.modelFetch).toHaveBeenCalledOnce();
    expect(t.githubFetch.mock.calls.every(readOnlyGitHubRequest)).toBe(true);
  });
  it.each(['off', 'throwing', 'replaced-config'] as const)(
    'keeps %s processing off while retaining intake and independent recovery ports',
    async (mode) => {
      const t = await fixture();
      const source = await t.eligible();
      if (mode === 'off') t.state.enabled = false;
      if (mode === 'throwing')
        Reflect.set(t.options, 'enabled', () => {
          throw new Error('Fictional flag outage');
        });
      if (mode === 'replaced-config')
        Reflect.set(t.options, 'configuration', { ...t.configuration });
      expect(
        await t.runtime.processWork({
          ticketId: source.ticketId,
          sourceGeneration: source.sourceGeneration,
          workerId: 'worker',
          leaseMilliseconds: 30_000,
        }),
      ).toMatchObject({ outcome: 'held' });
      expect(t.modelFetch).not.toHaveBeenCalled();
      expect(t.readApiKey).not.toHaveBeenCalled();
      expect(t.production.application.enabled).toBe(true);
      expect(
        t.production.processing.configuration?.ports.reconciliationAccess,
      ).toBe(t.configuration.reconciliationAccess);
    },
  );
  it('keeps unavailable model qualification from paying while retaining separately enabled intake and recovery', async () => {
    const t = await fixture();
    t.state.modelReady = false;
    const source = await t.eligible();
    expect(source.state).toBe('eligible');
    expect(
      (
        await t.runtime.processWork({
          ticketId: source.ticketId,
          sourceGeneration: source.sourceGeneration,
          workerId: 'worker',
          leaseMilliseconds: 30_000,
        })
      ).outcome,
    ).not.toBe('candidate');
    expect(t.modelFetch).not.toHaveBeenCalled();
    expect(t.readApiKey).not.toHaveBeenCalled();
    expect(
      t.production.processing.configuration?.ports.reconciliationAccess,
    ).toBe(t.configuration.reconciliationAccess);
  });
  it('holds missing live product evidence without provider work', async () => {
    const t = await fixture();
    t.state.productReady = false;
    expect(await t.eligible()).toMatchObject({ state: 'held' });
    expect(t.modelFetch).not.toHaveBeenCalled();
  });
  it('requires real current processor authority before paying for an eligible source', async () => {
    const t = await fixture();
    const source = await t.eligible();
    await t.f.engineering.revoke('processor');
    expect(
      (
        await t.runtime.processWork({
          ticketId: source.ticketId,
          sourceGeneration: source.sourceGeneration,
          workerId: 'worker',
          leaseMilliseconds: 30_000,
        })
      ).outcome,
    ).not.toBe('candidate');
    expect(t.modelFetch).not.toHaveBeenCalled();
    expect(t.readApiKey).not.toHaveBeenCalled();
  });
  it('retains real human review and the separate issue-write gate after preparing exact bytes', async () => {
    const t = await fixture();
    const source = await t.eligible();
    const key = {
      ticketId: source.ticketId,
      sourceGeneration: source.sourceGeneration,
    };
    const command = { ...key, workerId: 'worker', leaseMilliseconds: 30_000 };
    expect((await t.runtime.processWork(command)).outcome).toBe('candidate');
    expect((await t.runtime.processWork(command)).outcome).toBe('prepared');
    const work = await t.host.application.readEngineeringWork(
      t.f.engineering.actors.security,
      key,
    );
    if (work.proposal === undefined)
      throw new Error('Expected a real checked proposal');
    await t.runtime.reviewCommand(t.f.engineering.actors.staff, {
      ...key,
      commandId: 'fictional-production-review',
      correlationId: 'fictional-production-review',
      expectedWorkGeneration: work.workGeneration,
      proposalHash: work.proposal.proposalHash,
      decision: 'approve',
    });
    expect(
      (
        await t.host.application.readEngineeringWork(
          t.f.engineering.actors.security,
          key,
        )
      ).approval?.decision,
    ).toBe('approve');
    await t.runtime.processWork(command);
    expect(t.githubFetch.mock.calls.every(readOnlyGitHubRequest)).toBe(true);
    expect(t.modelFetch).toHaveBeenCalledOnce();
  });
  it.each(['installation', 'independent-checks', 'routing'] as const)(
    'fails closed on unavailable %s during actual proposal work',
    async (kind) => {
      const t = await fixture();
      const source = await t.eligible();
      const command = {
        ticketId: source.ticketId,
        sourceGeneration: source.sourceGeneration,
        workerId: 'worker',
        leaseMilliseconds: 30_000,
      };
      expect(await t.runtime.processWork(command)).toMatchObject({
        outcome: 'candidate',
      });
      if (kind === 'installation') t.state.authorityReady = false;
      if (kind === 'independent-checks') t.f.engineering.state.checks = 'held';
      if (kind === 'routing') t.f.engineering.state.routing = 'human_required';
      expect(await t.runtime.processWork(command)).toMatchObject({
        outcome: 'held',
      });
      const work = await t.host.application.readEngineeringWork(
        t.f.engineering.actors.security,
        {
          ticketId: source.ticketId,
          sourceGeneration: source.sourceGeneration,
        },
      );
      expect(work.proposal).toBeUndefined();
      expect(work.dispatch).toBeUndefined();
      expect(t.modelFetch).toHaveBeenCalledOnce();
    },
  );
});

const sharedBinding: EngineeringExportChecksBinding = {
  sourceBindingHash: 'a'.repeat(64),
  evidenceFingerprint: 'b'.repeat(64),
  candidateHash: 'c'.repeat(64),
  routingBindingHash: 'd'.repeat(64),
  requestHash: 'e'.repeat(64),
  policyGeneration: 1,
  policyHash: 'f'.repeat(64),
  repositoryMetadataHash: '1'.repeat(64),
};
function sharedController(base: EngineeringChecksPort) {
  const controller = {
    resolvePolicy: vi.fn(
      (...args: Parameters<SupportEngineeringSharedChecks['resolvePolicy']>) =>
        base.resolvePolicy(...args),
    ),
    engineeringSdkVerifier: {
      verify: vi.fn((...args: Parameters<EngineeringChecksPort['verify']>) =>
        base.verify(...args),
      ),
    },
    engineeringFor: vi.fn(
      (
        key: Parameters<SupportEngineeringSharedChecks['engineeringFor']>[0],
        capture: IndependentCheckCapture = {},
      ) => ({
        ...base,
        async check(...args: Parameters<EngineeringChecksPort['check']>) {
          capture.onDurablyDeferred?.({
            kind: 'engineering',
            operationId: 'a'.repeat(64),
            scope: { ...key },
            expiresAt: '2026-11-10T13:00:00.000Z',
          });
          return base.check(...args);
        },
      }),
    ),
    precomputePending: vi.fn(
      async (
        ..._args: Parameters<
          SupportEngineeringSharedChecks['precomputePending']
        >
      ) => ({ outcome: 'held' as const }),
    ),
    discardTicket: vi.fn(
      async (
        ..._args: Parameters<SupportEngineeringSharedChecks['discardTicket']>
      ) => 0,
    ),
  } satisfies SupportEngineeringSharedChecks;
  return controller;
}

describe('Root-owned shared engineering check controller', () => {
  it('takes precedence without reading private pool or bare checker configuration and creates no second attachment', async () => {
    const t = await fixture();
    const controller = sharedController(t.configuration.checks!);
    let privateReads = 0;
    let legacyReads = 0;
    const configuration = { ...t.configuration, readChecks: () => controller };
    Object.defineProperty(configuration, 'independentChecks', {
      get() {
        privateReads++;
        throw new Error('Private pool must not be selected');
      },
    });
    Object.defineProperty(configuration, 'checks', {
      get() {
        legacyReads++;
        throw new Error('Bare verifier must not be selected');
      },
    });
    const production = createProductionSupportEngineering({
      ...t.options,
      configuration,
    });
    expect(production.application.enabled).toBe(true);
    expect(production.processing.enabled?.()).toBe(true);
    expect(production.attachRuntime).toBeTypeOf('function');
    expect(privateReads).toBe(0);
    expect(legacyReads).toBe(0);
    expect(
      await production.application.checks?.verify(
        'fictional-no-receipt',
        sharedBinding,
      ),
    ).toBeNull();
    expect(
      controller.engineeringSdkVerifier.verify,
    ).toHaveBeenCalledExactlyOnceWith('fictional-no-receipt', sharedBinding);
    expect(production.reviewProofs?.checks).toBe(
      production.processing.configuration?.ports.checks,
    );
    expect(t.modelFetch).not.toHaveBeenCalled();
    expect(t.readApiKey).not.toHaveBeenCalled();
  });
  it.each(['absent', 'throwing', 'malformed'] as const)(
    'fails closed for an %s shared controller without bare/private fallback',
    async (fault) => {
      const t = await fixture();
      const legacy = vi.spyOn(t.configuration.checks!, 'verify');
      const configuration = {
        ...t.configuration,
        readChecks: () => {
          if (fault === 'throwing')
            throw new Error('Fictional shared initialization failure');
          return undefined;
        },
      };
      if (fault === 'malformed')
        Reflect.set(configuration, 'readChecks', () => ({
          resolvePolicy: async () => ({ outcome: 'ready' }),
        }));
      const production = createProductionSupportEngineering({
        ...t.options,
        configuration,
      });
      expect(production.processing.enabled?.()).toBe(false);
      expect(production.attachRuntime).toBeTypeOf('function');
      const configured = production.processing.configuration;
      if (
        !configured?.checksFor ||
        !configured.precomputeChecks ||
        !configured.discardChecks
      )
        throw new Error('Shared held ports must remain available');
      const signal = new AbortController().signal;
      expect(
        await production.application.checks!.verify(
          'fictional-no-receipt',
          sharedBinding,
        ),
      ).toBeNull();
      expect(
        await configured.ports.checks.resolvePolicy(undefined, signal),
      ).toEqual({ outcome: 'unavailable' });
      const scoped = configured.checksFor(
        { ticketId: 'fictional-known', sourceGeneration: 1 },
        () => {},
      );
      expect(
        await scoped.verify('fictional-no-receipt', sharedBinding),
      ).toBeNull();
      expect(
        await scoped.check(
          {
            candidate: candidate(),
            exactRequest: await prepared(),
            binding: sharedBinding,
            checkPolicyVersion: 'fictional-policy',
          },
          context(),
        ),
      ).toEqual({ outcome: 'held' });
      expect(
        await configured.precomputeChecks(
          {
            kind: 'checks',
            operationId: 'a'.repeat(64),
            ticketId: 'fictional-known',
            sourceGeneration: 1,
            expiresAt: '2026-11-10T13:00:00.000Z',
          },
          { deadline: '2026-11-10T12:00:04.000Z', signal, current: () => true },
        ),
      ).toEqual({ outcome: 'held' });
      await configured.discardChecks('fictional-known');
      await production.discardChecks?.('fictional-known');
      expect(legacy).not.toHaveBeenCalled();
      expect(t.modelFetch).not.toHaveBeenCalled();
      expect(t.readApiKey).not.toHaveBeenCalled();
    },
  );
  it('rebinds retained scoped ports and all proof/lifecycle calls to the current shared controller', async () => {
    const t = await fixture();
    const first = sharedController(t.configuration.checks!);
    const second = sharedController(t.configuration.checks!);
    const state = { current: first };
    const selection = { ...t.configuration, readChecks: () => state.current };
    const production = createProductionSupportEngineering({
      ...t.options,
      configuration: selection,
    });
    const configured = production.processing.configuration;
    if (
      !configured?.checksFor ||
      !configured.precomputeChecks ||
      !configured.discardChecks
    )
      throw new Error('Actual shared ports required');
    const original = {
      ticketId: 'fictional-first-ticket',
      sourceGeneration: 3,
    };
    const onDeferred = vi.fn();
    const scoped = configured.checksFor(original, onDeferred);
    original.ticketId = 'caller-reassigned-ticket';
    original.sourceGeneration = 99;
    await scoped.verify('first-no-receipt', sharedBinding);
    expect(first.engineeringFor).toHaveBeenCalledWith(
      { ticketId: 'fictional-first-ticket', sourceGeneration: 3 },
      expect.any(Object),
    );
    state.current = second;
    expect(
      await scoped.check(
        {
          candidate: candidate(),
          exactRequest: await prepared(),
          binding: sharedBinding,
          checkPolicyVersion: 'fictional-policy',
        },
        context(),
      ),
    ).toMatchObject({ outcome: 'checked' });
    expect(second.engineeringFor).toHaveBeenCalledWith(
      { ticketId: 'fictional-first-ticket', sourceGeneration: 3 },
      expect.any(Object),
    );
    expect(onDeferred).toHaveBeenCalledExactlyOnceWith({
      kind: 'checks',
      operationId: 'a'.repeat(64),
      ticketId: 'fictional-first-ticket',
      sourceGeneration: 3,
      expiresAt: '2026-11-10T13:00:00.000Z',
    });
    const other = configured.checksFor(
      { ticketId: 'fictional-second-ticket', sourceGeneration: 8 },
      () => {},
    );
    await other.verify('other-no-receipt', sharedBinding);
    expect(second.engineeringFor).toHaveBeenLastCalledWith(
      { ticketId: 'fictional-second-ticket', sourceGeneration: 8 },
      expect.any(Object),
    );
    await production.reviewProofs!.checks.verify(
      'current-no-receipt',
      sharedBinding,
    );
    expect(
      second.engineeringSdkVerifier.verify,
    ).toHaveBeenCalledExactlyOnceWith('current-no-receipt', sharedBinding);
    await configured.ports.checks.resolvePolicy(undefined, context().signal);
    expect(second.resolvePolicy).toHaveBeenCalledOnce();
    const run = { ...context(), current: () => true };
    await configured.precomputeChecks(
      {
        kind: 'checks',
        operationId: 'b'.repeat(64),
        ticketId: 'fictional-second-ticket',
        sourceGeneration: 8,
        expiresAt: '2026-11-10T13:00:00.000Z',
      },
      run,
    );
    expect(second.precomputePending).toHaveBeenCalledExactlyOnceWith(
      'b'.repeat(64),
      run,
      { ticketId: 'fictional-second-ticket', sourceGeneration: 8 },
      run.current,
    );
    await production.discardChecks!('fictional-first-ticket');
    await configured.discardChecks('fictional-second-ticket');
    expect(second.discardTicket.mock.calls).toEqual([
      ['engineering', 'fictional-first-ticket'],
      ['engineering', 'fictional-second-ticket'],
    ]);
    expect(first.precomputePending).not.toHaveBeenCalled();
    expect(first.discardTicket).not.toHaveBeenCalled();
    const beforeLoss = second.engineeringFor.mock.calls.length;
    Reflect.set(selection, 'readChecks', () => undefined);
    expect(production.processing.enabled?.()).toBe(false);
    expect(
      await scoped.verify('after-controller-loss', sharedBinding),
    ).toBeNull();
    expect(
      await scoped.check(
        {
          candidate: candidate(),
          exactRequest: await prepared(),
          binding: sharedBinding,
          checkPolicyVersion: 'fictional-policy',
        },
        context(),
      ),
    ).toEqual({ outcome: 'held' });
    expect(second.engineeringFor).toHaveBeenCalledTimes(beforeLoss);
  });
  it('holds synchronous and asynchronous controller method failures instead of falling back', async () => {
    const t = await fixture();
    const controller = sharedController(t.configuration.checks!);
    const production = createProductionSupportEngineering({
      ...t.options,
      configuration: { ...t.configuration, readChecks: () => controller },
    });
    controller.resolvePolicy.mockImplementationOnce(() => {
      throw new Error('Fictional sync controller failure');
    });
    expect(
      await production.processing.configuration!.ports.checks.resolvePolicy(
        undefined,
        context().signal,
      ),
    ).toEqual({ outcome: 'unavailable' });
    controller.engineeringSdkVerifier.verify.mockRejectedValueOnce(
      new Error('Fictional proof failure'),
    );
    expect(
      await production.application.checks!.verify(
        'fictional-no-receipt',
        sharedBinding,
      ),
    ).toBeNull();
    controller.precomputePending.mockRejectedValueOnce(
      new Error('Fictional controller failure'),
    );
    expect(
      await production.processing.configuration!.precomputeChecks!(
        {
          kind: 'checks',
          operationId: 'a'.repeat(64),
          ticketId: 'fictional-known',
          sourceGeneration: 1,
          expiresAt: '2026-11-10T13:00:00.000Z',
        },
        {
          deadline: '2026-11-10T12:00:04.000Z',
          signal: context().signal,
          current: () => true,
        },
      ),
    ).toEqual({ outcome: 'held' });
  });
});

/** The platform binding selects the genuine existing Memory Store. Host,
 * Identity/RoleStore, App and production adapters all remain real. */
async function normalEntry(deferredChecks: boolean | 'shared' = false) {
  const t = await fixture();
  const deferred = deferredChecks
    ? await createDeferredDriverChecksFixture(
        t.f.engineering,
        t.host.store,
        false,
      )
    : undefined;
  vi.mocked(d1.createCloudflareD1Store).mockReturnValue(t.host.store);
  const instances = vi.spyOn(supportDesk, 'createSupportRuntime');
  const jobs = vi.spyOn(
    engineeringComposition,
    'composeSupportEngineeringDriver',
  );
  const unavailable = (): never => {
    throw new Error('Memory root fixture cannot execute D1');
  };
  const environment = {
    IDENTITY_DB: {
      prepare: unavailable,
      batch: unavailable,
      exec: unavailable,
      dump: unavailable,
      withSession: unavailable,
    },
    IDENTITY_EMAIL_CODE_SECRET_BASE64: btoa('e'.repeat(32)),
    IDENTITY_EMAIL_FROM: 'Pegma <synthetic@pegma.dev>',
    IDENTITY_EMAIL_ENABLED: 'false',
    PEGMA_SUPPORT_ENGINEERING_PROCESSING_ENABLED: 'true',
  } as unknown as Parameters<ReturnType<typeof createWorker>['fetch']>[1];
  const shared =
    deferredChecks === 'shared' && deferred
      ? createSupportIndependentChecks({
          ...deferred.configuration,
          store: t.host.store,
          clock: t.host.clock,
          application: () => {
            const result = instances.mock.results.at(-1);
            if (result?.type !== 'return' || !result.value)
              throw new Error('Exact normal root App not constructed');
            return result.value.application;
          },
          repositories: t.production.application.repositoryMetadata,
          deferred: true,
        })
      : undefined;
  const options = {
    engineeringProduction:
      deferred === undefined
        ? t.options
        : {
            ...t.options,
            configuration: {
              ...t.configuration,
              ...(deferredChecks === 'shared'
                ? { readChecks: () => shared }
                : { independentChecks: deferred.configuration }),
            },
          },
    engineering: {
      enabled: () => true,
      reviewEnabled: () => true,
      configuration: {
        application: { enabled: true },
        repositories: [{ key: 'workspace-core', descriptor: allowed }],
      },
    },
  };
  const worker = createWorker(options);
  const pending: Promise<unknown>[] = [];
  const context = {
    waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    passThroughOnException: unavailable,
    props: {},
    exports: {},
    tracing: {},
    abort: unavailable,
  } as unknown as ExecutionContext;
  async function call(request: Request) {
    const response = await worker.fetch(request, environment, context);
    await Promise.all(pending.splice(0));
    return response;
  }
  async function eligible() {
    const ticket = await t.f.legacyTicket();
    expect(
      (
        await call(
          t.f.request('enroll', {
            commandId: 'NORMAL-PRODUCTION-ENROLL',
            expectedRevision: ticket.revision,
          }),
        )
      ).status,
    ).toBe(200);
    const response = await call(
      t.f.request('evidence', {
        commandId: 'NORMAL-PRODUCTION-EVIDENCE',
        expectedRevision: ticket.revision,
        expectedBehavior: 'Export retains rows.',
        actualBehavior: 'Export is empty.',
        reproductionSteps: [
          'Create one fictional row.',
          'Export the workspace.',
        ],
        visibleMessageIds: ['engineering-question'],
        verificationReference: 'SYNTHETIC_PRIVATE_FAILURE_REFERENCE',
        security: 'ordinary',
      }),
    );
    expect(response.status).toBe(200);
    const source = engineeringHttpResult(await engineeringHttpObject(response));
    expect(source.state).toBe('eligible');
    const runtime = instances.mock.results.at(-1)?.value as ReturnType<
      typeof createSupportRuntime
    >;
    const job = jobs.mock.results.at(-1)?.value as ReturnType<
      typeof engineeringComposition.composeSupportEngineeringDriver
    >;
    expect(jobs.mock.calls.at(-1)?.[0]).toBe(runtime);
    return {
      key: {
        ticketId: ticket.id,
        sourceGeneration: engineeringHttpNumber(source.sourceGeneration),
      },
      runtime,
      job,
    };
  }
  return {
    ...t,
    deferred,
    shared,
    environment,
    options,
    worker,
    context,
    call,
    eligible,
    jobs,
    instances,
  };
}

async function nextDriverPhase(
  job: ReturnType<
    typeof engineeringComposition.composeSupportEngineeringDriver
  >,
) {
  for (let physical = 0; physical < 160; physical++) {
    const result = await job.runTick();
    if (result.outcome === 'work') return result;
  }
  throw new Error(
    'Bounded normal entry fixture did not reach existing SDK work',
  );
}

describe('normal root production engineering integration', () => {
  it('installs trusted App proofs before human evidence and uses that exact application for later driver stages', async () => {
    const t = await normalEntry();
    const { key, runtime, job } = await t.eligible();
    expect(t.productContext.resolve).toHaveBeenCalledOnce();
    expect((await nextDriverPhase(job)).result.outcome).toBe('candidate');
    expect((await nextDriverPhase(job)).result.outcome).toBe('prepared');
    const work = await runtime.application.readEngineeringWork(
      t.f.engineering.actors.security,
      key,
    );
    expect(work.proposal?.request.bundle.evidenceReferences).toEqual(
      settings.evidenceReferences,
    );
    expect(work.approval).toBeUndefined();
    expect(work.dispatch).toBeUndefined();
    expect(t.modelFetch).toHaveBeenCalledOnce();
    expect(t.githubFetch.mock.calls.every(readOnlyGitHubRequest)).toBe(true);
  });
  it.each(['deployment', 'source'] as const)(
    'keeps %s processing OFF without any driver or provider opportunity',
    async (kind) => {
      const t = await normalEntry();
      const { job } = await t.eligible();
      if (kind === 'deployment')
        Reflect.set(
          t.environment,
          'PEGMA_SUPPORT_ENGINEERING_PROCESSING_ENABLED',
          'false',
        );
      else t.state.enabled = false;
      expect(await job.runTick()).toEqual({
        outcome: 'disabled',
        checkpointSaved: false,
      });
      expect(t.modelFetch).not.toHaveBeenCalled();
      expect(t.readApiKey).not.toHaveBeenCalled();
    },
  );
  it('binds current driver admission through the real awaited service-authority boundary', async () => {
    const t = await normalEntry();
    const { job } = await t.eligible();
    for (let physical = 0; physical < 160; physical++) {
      const result = await job.runTick();
      if (result.outcome === 'scanned' && result.selected) break;
      if (physical === 159) throw new Error('Expected bounded discovery');
    }
    let begin = () => {};
    let release = () => {};
    const entered = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = t.configuration.serviceAccess.resolve.bind(
      t.configuration.serviceAccess,
    );
    vi.spyOn(t.configuration.serviceAccess, 'resolve').mockImplementation(
      async (signal) => {
        const current = await original(signal);
        begin();
        await proceed;
        return current;
      },
    );
    const running = job.runTick();
    await entered;
    Reflect.set(
      t.environment,
      'PEGMA_SUPPORT_ENGINEERING_PROCESSING_ENABLED',
      'false',
    );
    release();
    expect((await running).outcome).toBe('unavailable');
    expect(t.modelFetch).not.toHaveBeenCalled();
    expect(t.readApiKey).not.toHaveBeenCalled();
  });
});

function queueDelivery(attempts: number, sent: string, fail = false) {
  const message = {
    id: 'fictional-engineering-envelope',
    timestamp: new Date(sent),
    attempts,
    body: { version: 1, kind: 'support-engineering-wake' },
    ack: vi.fn(() => {
      if (fail) throw new Error('FICTIONAL_PLATFORM_ACK_UNKNOWN');
    }),
    retry: vi.fn((_options?: QueueRetryOptions) => {
      if (fail) throw new Error('FICTIONAL_PLATFORM_RETRY_UNKNOWN');
    }),
  };
  const batch: MessageBatch = {
    queue: SUPPORT_ENGINEERING_QUEUE,
    messages: [message],
    metadata: {} as MessageBatchMetadata,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  };
  return { message, batch };
}
async function queuePhase(
  t: Awaited<ReturnType<typeof normalEntry>>,
  match: () => Promise<boolean>,
  inspect?: () => Promise<unknown>,
) {
  const start = Date.parse(t.f.engineering.clock.now());
  const physical: number[] = [];
  const observations: unknown[] = [];
  let cursor: string | null = null;
  for (let seed = 0; seed < 5; seed++) {
    const at = start + seed * 60_000;
    t.f.engineering.advance(at - Date.parse(t.f.engineering.clock.now()));
    const sent = t.f.engineering.clock.now();
    for (let attempts = 1; attempts <= 8; attempts++) {
      const delivery = queueDelivery(attempts, sent);
      await t.worker.queue(delivery.batch, t.environment, t.context);
      physical.push(attempts);
      const row = await t.host.store
        .collection(driverHintRows)
        .get(driverHintKey);
      if (row !== null && typeof row.payload === 'string') {
        const checkpoint = JSON.parse(row.payload) as {
          generation: number;
          cursor: string | null;
          targets: unknown[];
        };
        observations.push({
          seed,
          attempts,
          generation: checkpoint.generation,
          cursorPresent: checkpoint.cursor !== null,
          cursorChanged: checkpoint.cursor !== cursor,
          selected: checkpoint.targets.length > 0,
          modelCalls: t.modelFetch.mock.calls.length,
        });
        cursor = checkpoint.cursor;
      }
      if (await match()) return physical;
      t.f.engineering.advance(1_000);
      if (!delivery.message.retry.mock.calls.length) break;
    }
  }
  throw new Error(
    'The bounded actual queue fixture did not reach its expected SDK phase: ' +
      JSON.stringify({ observations, work: await inspect?.() }),
  );
}

describe('registered engineering Queue and cleanup entries', () => {
  it('uses one injected shared checker through the normal registered root without a private attachment or pool', async () => {
    const t = await normalEntry('shared');
    const { key, runtime } = await t.eligible();
    expect(t.shared).toBeDefined();
    await queuePhase(
      t,
      async () =>
        (
          await runtime.application.readEngineeringWork(
            t.f.engineering.actors.security,
            key,
          )
        ).proposal !== undefined,
    );
    expect(t.modelFetch).toHaveBeenCalledOnce();
    expect(t.deferred?.state.calls).toBe(1);
    expect((await t.deferred?.rows())?.entries).toHaveLength(1);
    expect((await t.deferred?.rows())?.entries[0]).toMatchObject({
      state: 'checked',
      request: null,
    });
    const work = await runtime.application.readEngineeringWork(
      t.f.engineering.actors.security,
      key,
    );
    expect(work.proposal).toBeDefined();
    expect(work.approval).toBeUndefined();
    expect(work.dispatch).toBeUndefined();
    expect(t.githubFetch.mock.calls.every(readOnlyGitHubRequest)).toBe(true);
  });
  it('runs the genuine deferred checker in a separate registered Queue phase before preparing a human-review proposal', async () => {
    const t = await normalEntry(true);
    const { key, runtime } = await t.eligible();
    const phases = await queuePhase(
      t,
      async () =>
        (
          await runtime.application.readEngineeringWork(
            t.f.engineering.actors.security,
            key,
          )
        ).proposal !== undefined,
      () =>
        runtime.application.readEngineeringWork(
          t.f.engineering.actors.security,
          key,
        ),
    );
    expect(phases.length).toBeGreaterThanOrEqual(5);
    expect(t.modelFetch).toHaveBeenCalledOnce();
    expect(t.deferred?.state.calls).toBe(1);
    const work = await runtime.application.readEngineeringWork(
      t.f.engineering.actors.security,
      key,
    );
    expect(work.proposal).toBeDefined();
    expect(work.approval).toBeUndefined();
    expect(work.dispatch).toBeUndefined();
    expect(t.githubFetch.mock.calls.every(readOnlyGitHubRequest)).toBe(true);
    expect((await t.deferred?.rows())?.entries[0]).toMatchObject({
      state: 'checked',
      request: null,
    });
    const raw = await t.host.store
      .collection(driverHintRows)
      .get(driverHintKey);
    expect(String(raw?.payload)).not.toContain('exactRequest');
    expect(String(raw?.payload)).not.toContain('FICTIONAL_CHECK_PROVIDER_KEY');
    expect(String(raw?.payload)).not.toContain(
      'SYNTHETIC_PRIVATE_FAILURE_REFERENCE',
    );
  });
  it('recovers the registered checker phase after platform retry and ACK failures without another paid call', async () => {
    const t = await normalEntry(true);
    const { key, runtime } = await t.eligible();
    await queuePhase(t, async () => {
      const row = await t.host.store
        .collection(driverHintRows)
        .get(driverHintKey);
      const targets =
        row === null
          ? []
          : (JSON.parse(String(row.payload)) as { targets: { kind: string }[] })
              .targets;
      return targets.some((target) => target.kind === 'checks');
    });
    expect(t.deferred?.state.calls).toBe(0);
    const lost = queueDelivery(1, t.f.engineering.clock.now(), true);
    await t.worker.queue(lost.batch, t.environment, t.context);
    expect(lost.message.retry).toHaveBeenCalledOnce();
    expect(lost.message.ack).toHaveBeenCalledOnce();
    expect(t.deferred?.state.calls).toBe(1);
    expect(
      (
        await runtime.application.readEngineeringWork(
          t.f.engineering.actors.security,
          key,
        )
      ).proposal,
    ).toBeUndefined();
    const duplicate = queueDelivery(2, t.f.engineering.clock.now());
    await t.worker.queue(duplicate.batch, t.environment, t.context);
    expect(
      (
        await runtime.application.readEngineeringWork(
          t.f.engineering.actors.security,
          key,
        )
      ).proposal,
    ).toBeDefined();
    expect(t.deferred?.state.calls).toBe(1);
    expect(t.modelFetch).toHaveBeenCalledOnce();
    expect(t.githubFetch.mock.calls.every(readOnlyGitHubRequest)).toBe(true);
  });
  it('advances historical physical pages across minute seeds without an empty retry chain', async () => {
    const t = await normalEntry();
    for (let index = 0; index < 20; index++)
      await t.host.application.createCustomerTicket(
        t.f.engineering.actors.customer,
        {
          commandId: 'fictional-history-create-' + index,
          correlationId: 'fictional-history',
          ticketId: 'a-fictional-history-' + index,
          messageId: 'fictional-history-message-' + index,
          subject: 'Historical ordinary question',
          body: 'No verified engineering failure exists.',
        },
      );
    const seen = new Set<string>();
    for (let seed = 0; seed < 3; seed++) {
      const delivery = queueDelivery(1, t.f.engineering.clock.now());
      await t.worker.queue(delivery.batch, t.environment, t.context);
      expect(delivery.message.ack).toHaveBeenCalledOnce();
      expect(delivery.message.retry).not.toHaveBeenCalled();
      const row = await t.host.store
        .collection(driverHintRows)
        .get(driverHintKey);
      if (row === null || typeof row.payload !== 'string')
        throw new Error('Expected actual durable cursor');
      const checkpoint = JSON.parse(row.payload) as {
        generation: number;
        cursor: string;
        targets: unknown[];
      };
      expect(checkpoint.generation).toBe(seed + 1);
      expect(checkpoint.targets).toEqual([]);
      expect(typeof checkpoint.cursor).toBe('string');
      expect(seen.has(checkpoint.cursor)).toBe(false);
      seen.add(checkpoint.cursor);
      t.f.engineering.advance(60_000);
    }
    expect(t.modelFetch).not.toHaveBeenCalled();
    expect(t.readApiKey).not.toHaveBeenCalled();
  });
  it('keeps a known paid candidate after platform retry/ACK callbacks fail without another generation', async () => {
    const t = await normalEntry();
    const { key, runtime, job } = await t.eligible();
    for (let physical = 0; physical < 160; physical++) {
      const result = await job.runTick();
      if (result.outcome === 'scanned' && result.selected) break;
      if (physical === 159)
        throw new Error('Expected bounded actual discovery');
    }
    const failed = queueDelivery(1, t.f.engineering.clock.now(), true);
    await t.worker.queue(failed.batch, t.environment, t.context);
    expect(t.modelFetch).toHaveBeenCalledOnce();
    expect(
      (
        await runtime.application.readEngineeringWork(
          t.f.engineering.actors.security,
          key,
        )
      ).candidate,
    ).toBeDefined();
    for (let attempts = 2; attempts <= 8; attempts++) {
      const duplicate = queueDelivery(attempts, t.f.engineering.clock.now());
      await t.worker.queue(duplicate.batch, t.environment, t.context);
    }
    expect(t.modelFetch).toHaveBeenCalledOnce();
    expect(t.githubFetch.mock.calls.every(readOnlyGitHubRequest)).toBe(true);
  });
  it.each(['deployment', 'configuration', 'authority'] as const)(
    'denies late %s change through the registered queue before paid generation',
    async (change) => {
      const t = await normalEntry();
      const { job } = await t.eligible();
      for (let physical = 0; physical < 160; physical++) {
        const result = await job.runTick();
        if (result.outcome === 'scanned' && result.selected) break;
        if (physical === 159) throw new Error('Expected bounded discovery');
      }
      let begin = () => {};
      let release = () => {};
      const entered = new Promise<void>((resolve) => {
        begin = resolve;
      });
      const proceed = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = t.configuration.serviceAccess.resolve.bind(
        t.configuration.serviceAccess,
      );
      vi.spyOn(t.configuration.serviceAccess, 'resolve').mockImplementation(
        async (signal) => {
          const current = await original(signal);
          begin();
          await proceed;
          return current;
        },
      );
      const delivery = queueDelivery(1, t.f.engineering.clock.now());
      const running = t.worker.queue(delivery.batch, t.environment, t.context);
      await entered;
      if (change === 'deployment')
        Reflect.set(
          t.environment,
          'PEGMA_SUPPORT_ENGINEERING_PROCESSING_ENABLED',
          'false',
        );
      if (change === 'configuration')
        Reflect.set(t.options.engineeringProduction, 'configuration', {
          ...t.configuration,
        });
      if (change === 'authority') await t.f.engineering.revoke('processor');
      release();
      await running;
      expect(t.modelFetch).not.toHaveBeenCalled();
      expect(t.readApiKey).not.toHaveBeenCalled();
      expect(delivery.message.ack).toHaveBeenCalledOnce();
      expect(delivery.message.retry).not.toHaveBeenCalled();
    },
  );
  it.each(['absent', 'off'] as const)(
    'keeps an %s production installation before all queue and D1 work',
    async (mode) => {
      const unavailable = vi.fn(() => {
        throw new Error('OFF binding read');
      });
      const worker = createWorker(
        mode === 'absent'
          ? {}
          : { engineeringProduction: { enabled: () => true } },
      );
      const env = {
        PEGMA_SUPPORT_ENGINEERING_PROCESSING_ENABLED:
          mode === 'absent' ? 'true' : 'false',
        get IDENTITY_DB() {
          return unavailable();
        },
        get SUPPORT_ENGINEERING_JOBS() {
          return unavailable();
        },
      } as unknown as Parameters<typeof worker.fetch>[1];
      const delivery = queueDelivery(1, new Date().toISOString());
      await worker.queue(delivery.batch, env, {
        waitUntil() {},
      } as unknown as ExecutionContext);
      expect(delivery.message.ack).toHaveBeenCalledOnce();
      expect(unavailable).not.toHaveBeenCalled();
    },
  );
  it('sends one body-free cleanup wake while retaining the actual preexisting cleanup job', async () => {
    const t = await normalEntry();
    const maintenance = vi.spyOn(identityMaintenance, 'runIdentityMaintenance');
    const send = vi.fn(async () => ({
      metadata: { metrics: { backlogCount: 1, backlogBytes: 55 } },
    }));
    Reflect.set(t.environment, 'SUPPORT_ENGINEERING_JOBS', { send });
    let at =
      Math.floor(Date.parse(t.f.engineering.clock.now()) / 60_000) * 60_000;
    for (let minutes = 0; minutes < 60; minutes++, at += 60_000) {
      const lane = cleanupLaneAt(at);
      if (
        new Date(at).getUTCMinutes() !== 59 &&
        lane.kind === 'identity' &&
        lane.task === 'challenges'
      )
        break;
    }
    await t.worker.scheduled(
      { cron: CLEANUP_CRON, scheduledTime: at, noRetry() {} },
      t.environment,
      t.context,
    );
    await t.call(new Request('https://pegma.dev/api/health'));
    expect(send).toHaveBeenCalledExactlyOnceWith(
      { version: 1, kind: 'support-engineering-wake' },
      { contentType: 'json' },
    );
    expect(maintenance).toHaveBeenCalledOnce();
    expect(maintenance.mock.calls[0]?.[2]).toEqual({ tasks: ['challenges'] });
    expect(t.jobs).not.toHaveBeenCalled();
    expect(t.modelFetch).not.toHaveBeenCalled();
    expect(t.readApiKey).not.toHaveBeenCalled();
  });
  it('advances real normal-root SDK work in separate deliveries and stops at the human approval boundary', async () => {
    const t = await normalEntry();
    const { key, runtime } = await t.eligible();
    const forbiddenSend = vi.fn(() => {
      throw new Error('Consumer must not send after an SDK stage');
    });
    Reflect.set(t.environment, 'SUPPORT_ENGINEERING_JOBS', {
      send: forbiddenSend,
    });
    const acceptedAt = Date.parse(t.f.engineering.clock.now());
    const physical = await queuePhase(
      t,
      async () =>
        (
          await runtime.application.readEngineeringWork(
            t.f.engineering.actors.security,
            key,
          )
        ).proposal !== undefined,
      async () => {
        const work = await runtime.application.readEngineeringWork(
          t.f.engineering.actors.security,
          key,
        );
        return {
          stage: work.stage,
          status: work.status,
          deadline: work.deadline,
          candidatePresent: work.candidateHash !== undefined,
          proposalPresent: work.proposal !== undefined,
          modelAttempts: work.modelAttempts.length,
        };
      },
    );
    const work = await runtime.application.readEngineeringWork(
      t.f.engineering.actors.security,
      key,
    );
    expect(work.candidateHash).toBeDefined();
    expect(work.proposal).toBeDefined();
    expect(work.approval).toBeUndefined();
    expect(work.dispatch).toBeUndefined();
    expect(Date.parse(t.f.engineering.clock.now()) - acceptedAt).toBeLessThan(
      300_000,
    );
    expect(physical.every((attempts) => attempts >= 1 && attempts <= 8)).toBe(
      true,
    );
    expect(t.modelFetch).toHaveBeenCalledOnce();
    expect(forbiddenSend).not.toHaveBeenCalled();
    expect(t.githubFetch.mock.calls.every(readOnlyGitHubRequest)).toBe(true);
  });
});
