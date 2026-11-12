import type { SupportPaidEnvironment } from './support-paid-bootstrap';
import {
  independentCheckRoutePolicyHash,
  type IndependentCheckRoute,
} from './support-independent-checks-model';
import {
  supportLearningRoutePolicySha256,
  type ApprovedSupportLearningRoute,
} from './support-learning-model';
import { SUPPORT_ASSISTANT_CREDENTIAL_REF } from './support-assistant-production';

export const PAID_START = '2026-11-10T12:00:00.000Z';
export const PAID_END = '2026-11-10T13:00:00.000Z';
/** Fictional retained evidence only; no route/provider qualification is claimed. */
export async function paidBootstrapFixture() {
  const common = {
    version: 'fictional-check-config',
    promptVersion: 'fictional-prompt',
    modelVersion: 'fictional-mini-model',
    provider: 'Azure',
    model: 'openai/gpt-4.1-mini',
    pricingRef: 'fictional-price',
    trustedInstructions: 'Generalize supplied fictional facts.',
    framingTokens: 1024,
    budgets: {
      maxMessages: 20,
      maxInputBytes: 65536,
      maxInputTokens: 32000,
      maxContextTokens: 65536,
      maxOutputBytes: 4000,
      maxOutputTokens: 1000,
      maxDurationMilliseconds: 2000,
      maxCostMicros: 1000,
      currency: 'USD' as const,
      maxAttempts: 1 as const,
    },
  };
  const controls = (purpose: string, version: string) => ({
    status: 'verified' as const,
    purpose,
    configurationBinding: version,
    accountRef: 'fictional-account',
    projectRef: 'fictional-project',
    endpointRef: 'fictional-endpoint',
    modelRef: 'fictional-model',
    featuresRef: 'fictional-features',
    exceptionsRef: 'fictional-exceptions',
    intermediaryRefs: ['fictional-proxy'],
    verifiedAt: PAID_START,
    validUntil: PAID_END,
  });
  const configuration: IndependentCheckRoute['configuration'] = {
    ...common,
    purpose: 'support_independent_check',
    parserVersion: 'fictional-parser',
    policyVersion: 'fictional-policy',
    policyBinding: 'fictional-policy-binding',
    rubricVersion: 'fictional-rubric',
    dataControls: {
      ...controls('support_independent_check', common.version),
      purpose: 'support_independent_check',
    },
  };
  const approval = {
    configurationVersion: common.version,
    wireVersion: 'openrouter-support-independent-check-v1' as const,
    requestPolicySha256: '',
    evidenceRef: 'fictional-approval',
    effectivePolicyRef: 'fictional-policy',
    evaluationRef: 'fictional-evaluation',
    responseIdentityRef: 'fictional-response',
    tokenizerRef: 'fictional-tokenizer',
    nativeCostCurrency: 'USD' as const,
    nativeCostUnit: 'openrouter_credits_usd' as const,
    rounding: 'ceil_micro' as const,
    zdr: true as const,
    safetyRetention: false as const,
    inputOutputLogging: false as const,
    inputOutputUse: false as const,
    broadcast: false as const,
    responseCache: false as const,
    unreviewedFeatures: false as const,
    implicitCache: 'absent' as const,
    verifiedAt: PAID_START,
    validUntil: PAID_END,
  };
  const base: Omit<IndependentCheckRoute, 'approval'> = {
    host: 'pegma.dev',
    purpose: 'support_independent_check',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    endpointTag: 'azure/swedencentral',
    outputTokenParameter: 'max_tokens',
    credentialRef: SUPPORT_ASSISTANT_CREDENTIAL_REF,
    usageScopeRef: 'fictional-check-pool',
    configuration,
  };
  const checkRoute: IndependentCheckRoute = {
    ...base,
    approval: { ...approval, requestPolicySha256: await independentCheckRoutePolicyHash(base) },
  };
  const learningConfig: ApprovedSupportLearningRoute['configuration'] = {
    ...common,
    purpose: 'support_learning',
    version: 'fictional-learning-config',
    budgets: { ...common.budgets, maxCandidateBytes: 16000 },
    dataControls: {
      ...controls('support_learning', 'fictional-learning-config'),
      purpose: 'support_learning',
    },
  };
  const learningBase: Omit<ApprovedSupportLearningRoute, 'approval'> = {
    ...base,
    purpose: 'support_learning',
    usageScopeRef: 'fictional-learning-pool',
    configuration: learningConfig,
  };
  const learningRoute: ApprovedSupportLearningRoute = {
    ...learningBase,
    approval: {
      ...approval,
      wireVersion: 'openrouter-support-learning-v1',
      configurationVersion: learningConfig.version,
      requestPolicySha256: await supportLearningRoutePolicySha256(learningBase),
    },
  };
  const qualification = (wireVersion: string) => ({
    model: common.model,
    modelVersion: common.modelVersion,
    wireVersion,
    framingTokens: common.framingTokens,
    evidenceRef: approval.tokenizerRef,
    verifiedAt: PAID_START,
    validUntil: PAID_END,
  });
  const pool = (scopeRef: string, configurationVersion: string) => ({
    version: scopeRef + '-v1',
    scopeRef,
    configurationVersion,
    modelVersion: common.modelVersion,
    pricingRef: common.pricingRef,
    currency: 'USD' as const,
    maxCostMicros: 2000,
    maxReservationCostMicros: 1000,
    maxReservations: 2,
    validFrom: PAID_START,
    validUntil: PAID_END,
    terminalRetentionMilliseconds: 60000,
  });
  const source = {
    version: 1,
    revision: 'fictional-source-v1',
    namespace: 'fictional-source',
    intakeEnabled: true,
    product: { productId: 'synthetic-workspace', version: '1.0.0', buildId: 'synthetic-build-1' },
    collectionIds: ['learning-guides'],
  };
  const profile = {
    version: 1,
    revision: 'fictional-paid-v1',
    sourceRevision: source.revision,
    checks: {
      route: checkRoute,
      qualification: qualification('openrouter-support-independent-check-v1'),
      usagePolicy: pool(checkRoute.usageScopeRef, configuration.version),
      receiptKey: {
        id: 'fictional-receipt-key-v1',
        reference: 'support-independent-check-receipt',
        validUntil: PAID_END,
      },
    },
    learning: {
      route: learningRoute,
      qualification: qualification('openrouter-support-learning-v1'),
      usagePolicy: pool(learningRoute.usageScopeRef, learningConfig.version),
      target: {
        version: 'fictional-target-v1',
        collectionId: 'learning-guides',
        kind: 'explanation',
        searchQuery: 'workspace export',
        explicitDraftIds: [],
        title: 'Export a workspace',
        tags: ['export'],
      },
    },
  };
  const env: SupportPaidEnvironment = {
    SUPPORT_PAID_CONFIGURATION_JSON: JSON.stringify(profile),
    SUPPORT_LEARNING_SOURCE_CONFIGURATION_JSON: JSON.stringify(source),
    PEGMA_KNOWLEDGE_ENABLED: 'true',
    PEGMA_SUPPORT_LEARNING_INTAKE_ENABLED: 'true',
    PEGMA_SUPPORT_LEARNING_WORKER_ENABLED: 'true',
    PEGMA_SUPPORT_INDEPENDENT_CHECKS_ENABLED: 'true',
    SUPPORT_INDEPENDENT_CHECK_RECEIPT_KEY_BASE64: btoa('k'.repeat(32)),
    SUPPORT_ASSISTANT_OPENROUTER_API_KEY: 'FICTIONAL_PROCESSING_KEY',
  };
  return { profile, source, env, clock: { now: () => PAID_START } };
}

export async function engineeringPaidFixture(
  data: Awaited<ReturnType<typeof paidBootstrapFixture>>,
  policyHash: string,
) {
  const { supportEngineeringRoutePolicySha256 } = await import('./support-engineering-config');
  const source = data.profile.learning.route.configuration;
  const configuration = {
    ...source,
    purpose: 'support_bug_assessment' as const,
    version: 'fictional-engineering-config',
    parserVersion: 'fictional-engineering-parser',
    budgets: { ...source.budgets, maxRepositories: 2, maxRepositoryBytes: 16000 },
    dataControls: {
      ...source.dataControls,
      purpose: 'support_bug_assessment' as const,
      configurationBinding: 'fictional-engineering-config',
    },
  };
  const base = {
    ...data.profile.learning.route,
    purpose: 'support_bug_assessment' as const,
    usageScopeRef: 'fictional-engineering-pool',
    configuration,
  };
  const { approval: _old, ...unsigned } = base;
  const route = {
    ...unsigned,
    approval: {
      ...data.profile.learning.route.approval,
      configurationVersion: configuration.version,
      wireVersion: 'openrouter-support-engineering-v1' as const,
      requestPolicySha256: await supportEngineeringRoutePolicySha256(unsigned),
    },
  };
  const descriptor = {
    repositoryId: '101',
    owner: 'synthetic-org',
    name: 'workspace-core',
    visibility: 'public' as const,
    responsibilities: 'Workspace export creation.',
    product: data.source.product.productId,
    component: 'export',
    version: data.source.product.version,
    allowedLabels: ['bug'],
    allowedTemplates: ['bug-report'],
    publicationMode: 'approval_required' as const,
    enabled: true,
  };
  const engineering = {
    route,
    qualification: {
      ...data.profile.learning.qualification,
      wireVersion: 'openrouter-support-engineering-v1',
    },
    usagePolicy: {
      ...data.profile.learning.usagePolicy,
      version: 'fictional-engineering-pool-v1',
      scopeRef: route.usageScopeRef,
      configurationVersion: configuration.version,
    },
    intakeEnabled: true,
    reviewEnabled: true,
    routing: {
      calibration: {
        version: 'fictional-calibration-v1',
        artifactRef: 'fictional-retained-calibration',
        rubricVersion: 'fictional-rubric',
        evaluationRef: 'fictional-routing-evaluation',
        modelVersion: configuration.modelVersion,
        promptVersion: configuration.promptVersion,
        parserVersion: configuration.parserVersion,
        policyHash,
        verifiedAt: PAID_START,
        validUntil: PAID_END,
      },
      decisions: [],
    },
    repositories: [
      {
        key: 'workspace-core',
        repository: {
          repositoryId: '101',
          owner: descriptor.owner,
          name: descriptor.name,
          visibility: 'public',
          appId: '301',
          installationId: '201',
        },
        descriptor,
        duplicateQuery: 'workspace export',
        settings: {
          labels: ['bug'],
          templateId: 'bug-report',
          evidenceReferences: ['fictional-approved-public-reproduction'],
        },
        authentication: {
          binding: 'fictional-current-installation',
          version: 'fictional-installation-v1',
          validUntil: PAID_END,
          appJwtRef: 'SUPPORT_ENGINEERING_APP_JWT',
          installationTokenRef: 'SUPPORT_ENGINEERING_INSTALLATION_TOKEN',
        },
      },
    ],
  };
  const { learning: _learning, ...profile } = data.profile;
  return { profile: { ...profile, engineering }, descriptor };
}
