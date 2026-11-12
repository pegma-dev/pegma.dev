import { describe, expect, it, vi } from 'vitest';
import type {
  EngineeringCandidate,
  EngineeringExportRequest,
  EngineeringRepositoryDescriptor,
} from '@pegma/support-desk-application';
import type { EngineeringProposalPort } from '@pegma/support-desk-ai';
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
} from './support-engineering-production';

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
  const githubFetch = vi.fn(async (url: string, init: RequestInit) => {
    expect(init.method).toBe('GET'); // No implicit publication or token mint before approval.
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
        : {
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
          },
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
    expect(
      t.githubFetch.mock.calls.every(([, init]) => init.method === 'GET'),
    ).toBe(true);
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
    expect(
      t.githubFetch.mock.calls.every(([, init]) => init.method === 'GET'),
    ).toBe(true);
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
