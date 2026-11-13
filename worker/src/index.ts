import { hasPermission, serializeAccessContext, type AccessContext } from '@pegma/authorization-core';
import { knowledgePermissions } from '@pegma/knowledge-base-contracts';
import { createAgentPrincipalResolver } from './agent-authority';
import { createSupportLearningTestReceipts, readSupportTestEvidenceGovernance, LearningTestReceiptError } from './support-learning-test-receipts';
import { ApiError } from './api-auth';
import { SUPPORT_ANSWERING_DISCLOSURE_VERSION, composeSupportAnswering, supportAnsweringTurns, supportAnsweringEnabled, supportAnsweringAdmissionEnabled, type SupportAnsweringComposition } from './support-assistant-composition';
import { createProductionSupportAnswering, type SupportAssistantProductionEnvironment } from './support-assistant-production';
import { runSupportAssistantTimer } from './support-assistant-timer';
import { usageText } from './support-model-usage-ledger';
import { createSupportAssistantStageDatabase as createSupportAssistantInvocationDatabase } from './support-assistant-stage-budget';
import { createSupportAnsweringIngress, SUPPORT_ANSWERING_NAMESPACE } from './support-assistant-ingress';
import { SUPPORT_ENGINEERING_QUEUE, seedSupportEngineeringWake, consumeSupportEngineeringWake, seedSupportLearningWake, consumeSupportLearningWake, isSupportLearningWake, seedSupportReleaseFollowupWake, consumeSupportReleaseFollowupWake, isSupportReleaseFollowupWake, type SupportEngineeringWake, type SupportLearningWake, type SupportReleaseFollowupWake } from './support-engineering-queue';
import { createSupportReleaseFollowupDriver, supportReleaseFollowupWakeDue } from './support-release-followup-driver';
import { createSupportReleaseFollowupRuntime } from './support-release-followup';
import { createSupportReleaseFollowupCheckCleanup } from '@pegma/support-desk-ai/openrouter';
import { createSupportLearningComposition, type SupportLearningCompositionOptions } from './support-learning-composition';
import { createSupportLearningBootstrap, type SupportLearningSourceEnvironment } from './support-learning-bootstrap';
import { createSupportPaidBootstrap, supportPaidBootstrapReusable, type SupportPaidEnvironment } from './support-paid-bootstrap';
import { createSupportLearningDriver, type SupportLearningDeferredCheckHint } from './support-learning-driver';
import { createProductionSupportEngineering, type SupportEngineeringProductionOptions } from './support-engineering-production';
import { composeSupportEngineeringDriver, composeSupportEngineeringHuman, supportEngineeringHumanEnabled, supportEngineeringIntakeOptions,
  type SupportEngineeringHumanComposition } from './support-engineering-composition';
import { composeSupportReleaseFollowup } from './support-release-followup-composition';
import { createSupportReleaseFollowupBootstrap, createSupportFollowupGovernanceAccess, supportReleaseFollowupSourceEnabled, type SupportReleaseFollowupEnvironment } from './support-release-followup-bootstrap';
import { supportReleaseFollowupApplicationOptions, supportReleaseFollowupEnabled, supportReleaseFollowupUsesDefault, supportReleaseFollowupPaidSelection, type SupportReleaseFollowupComposition } from './support-release-followup-ports';
import { isSupportReleaseFollowupRequest } from './support-release-followup-handlers';
import { isSupportEngineeringRequest } from './support-engineering-router';
import {
  createDetailCheck,
  createProcessCheck,
  runHealthChecks,
  toHealthResponse,
} from '@pegma/health';
import { identityLinkKeyFromVerifiedIdentityClaims } from '@pegma/authorization-identity';
import { runIdentityMaintenance } from './identity-maintenance';
import { createAppLogger, type LoggerEnv } from './logger';
import {
  createProductionIdentityRuntime,
  type IdentityRuntimeEnv,
} from './identity-runtime';
import {
  createProductionStore,
  handleGitHubReleaseWebhook,
  readGitHubReleaseWebhookConfig,
  type GitHubReleaseWebhookEnv,
} from './github-release-webhook';
import { loadReleaseHealthDetail } from './release-health';
import {
  RELEASE_RECONCILIATION_CRON,
  runReleaseReconciliation,
} from './release-reconciliation';
import { handleGetReleases, readReleasesConfig } from './releases-api';
import {
  parseAdminBootstrapPrincipals,
  parseBootstrapPrincipals,
} from './role-bootstrap';
import { createAdminApi } from './admin-api';
import { createRoleHolderIndex } from './role-holder-index';
import { createSupportApi } from './support-api';
import {
  createAdminLookupLimiter,
  createAdminMutationLimiter,
  createProductionSupportRuntime,
  createSupportRuntime,
  createProductionSupportMaintenanceRuntime,
  probeSupportStore,
  supportHealthProbeEnabled,
  type SupportRuntimeEnv,
} from './support-desk';
import { runSupportMaintenance } from './support-maintenance';
import { purgeSupportIndependentCheckRequests } from './support-independent-checks';
import { runKnowledgeMaintenance } from './knowledge-maintenance';
import { createKnowledgeRetrievalMaintenance } from './knowledge-retrieval-maintenance';
import { createKnowledgeRetrievalReady } from './knowledge-retrieval-ready';
import { createCloudflareD1Store } from '@pegma/storage-cloudflare-d1';
import { systemClock } from '@pegma/spine';
import {
  MAIL_CRON,
  MAIL_RECONCILE_CRON,
  CLEANUP_CRON,
  RATE_LIMIT_CRON,
  rateKnowledgeBackgroundEligibleAt,
  cleanupLaneAt,
  rateKnowledgeLaneAt,
} from './maintenance-schedule';
import { createPegmaMcpHandler } from './mcp-server';
import type { CatalogFetchEnv } from './mcp-catalog-fetch';
import { createKnowledgeHostRuntime, handleKnowledgeRequest, isKnowledgeRequest, type KnowledgeHostRuntime } from './knowledge-host';
import type { createSupportLearningReviewQueue, SupportLearningReviewQueueMessage } from './support-learning-review-queue';

type AppEnv = Omit<Env, 'PEGMA_SUPPORT_RELEASE_FOLLOWUP_ENABLED' | 'PEGMA_SUPPORT_RELEASE_FOLLOWUP_PROCESSING_ENABLED' | 'SUPPORT_PAID_CONFIGURATION_JSON' | 'PEGMA_SUPPORT_INDEPENDENT_CHECKS_ENABLED' | 'PEGMA_SUPPORT_ENGINEERING_REPOSITORY_ENABLED' | 'PEGMA_SUPPORT_ENGINEERING_ISSUE_WRITE_ENABLED' | 'SUPPORT_ENGINEERING_JOBS' | 'PEGMA_SUPPORT_ENGINEERING_PROCESSING_ENABLED' | 'PEGMA_SUPPORT_LEARNING_INTAKE_ENABLED' | 'PEGMA_SUPPORT_LEARNING_WORKER_ENABLED' | 'PEGMA_SUPPORT_LEARNING_REVIEWS_ENABLED' | 'PEGMA_SUPPORT_ASSISTANT_ENABLED' | 'PEGMA_SUPPORT_ASSISTANT_CUSTOMER_ADMISSION_ENABLED' | 'PEGMA_SUPPORT_ASSISTANT_CONFIGURATION_JSON'> &
  LoggerEnv &
  IdentityRuntimeEnv &
  GitHubReleaseWebhookEnv &
  SupportRuntimeEnv &
  CatalogFetchEnv & SupportAssistantProductionEnvironment & SupportLearningSourceEnvironment & SupportPaidEnvironment & SupportReleaseFollowupEnvironment & {
    readonly PEGMA_SUPPORT_LEARNING_REVIEWS_ENABLED?: string;
    readonly PEGMA_SUPPORT_ASSISTANT_ENABLED?: string;
    readonly PEGMA_SUPPORT_ENGINEERING_PROCESSING_ENABLED?: string;
    readonly PEGMA_SUPPORT_LEARNING_INTAKE_ENABLED?: string;
    readonly PEGMA_SUPPORT_LEARNING_WORKER_ENABLED?: string;
    readonly SUPPORT_LEARNING_REVIEWS?: Queue<SupportLearningReviewQueueMessage>;
    readonly SUPPORT_ENGINEERING_JOBS?: Queue<SupportEngineeringWake | SupportLearningWake | SupportReleaseFollowupWake>;
  };

/** Trusted source composition only; no product/check/source ports are invented here. */
export interface SupportLearningReviewWorkerComposition {
  readonly enabled: () => boolean;
  create(environment: AppEnv, logger: ReturnType<typeof createAppLogger>,
    engineering?: SupportEngineeringHumanComposition, answering?: SupportAnsweringComposition,
    engineeringProduction?: SupportEngineeringProductionOptions): {
    /** The actual configured Support API, including its fresh staff-detail hints. */
    readonly api: (request: Request) => Promise<Response>;
    readonly queue: ReturnType<typeof createSupportLearningReviewQueue>;
  };
}

function learningReviewsEnabled(environment: { readonly PEGMA_SUPPORT_LEARNING_REVIEWS_ENABLED?: string;
  readonly SUPPORT_LEARNING_REVIEWS?: unknown }, composition?: SupportLearningReviewWorkerComposition): boolean {
  try { return environment.PEGMA_SUPPORT_LEARNING_REVIEWS_ENABLED === 'true' &&
    environment.SUPPORT_LEARNING_REVIEWS !== undefined && composition?.enabled() === true; }
  catch { return false; }
}

function knowledgeRetrievalEnabled(environment: {
  readonly PEGMA_KNOWLEDGE_ENABLED?: string;
}): boolean {
  return environment.PEGMA_KNOWLEDGE_ENABLED === 'true';
}

export type SupportLearningRootComposition = SupportLearningCompositionOptions & {
  readonly testEvidence?: {
    readonly retentionMilliseconds: number;
    readonly governanceAccess: {
      resolve(collectionId: string, signal: AbortSignal): Promise<{
        readonly access: AccessContext;
        readonly authorityVersion: string;
      } | null>;
    };
  };
};

function learningConfigured(options?: SupportLearningRootComposition): boolean {
  try { return options !== undefined && (options.source !== undefined || options.production?.configuration !== undefined); }
  catch { return true; }
}

function learningWorkerEnabled(env: AppEnv, options?: SupportLearningRootComposition): boolean {
  return env.PEGMA_SUPPORT_LEARNING_WORKER_ENABLED === 'true' && learningConfigured(options);
}

// Projection-only ticks avoid Identity, sessions, mail and AgentAccess when
// no explicit private-source graph is selected.
function createKnowledgeProjectionStore(environment: {
  readonly IDENTITY_DB: D1Database;
}) {
  return createCloudflareD1Store({
    database: environment.IDENTITY_DB,
    createSchemaIfMissing: false,
    readBatchSize: 512,
  });
}

/** Per physical answering invocation; preserve lazy binding reads and current
 * flag observations instead of copying credentials or freezing flag values. */
function answeringInvocationEnvironment(environment: AppEnv): AppEnv {
  const guarded = createSupportAssistantInvocationDatabase(environment.IDENTITY_DB);
  return new Proxy(environment, {
    get(target, key) {
      return key === 'IDENTITY_DB' ? guarded.database : Reflect.get(target, key, target);
    },
  });
}

/** Fixed categories only: optional composition failures must remain visible
 * without logging credentials, configuration, provider payloads or exceptions. */
function logSupportCompositionFailure(
  logger: ReturnType<typeof createAppLogger>,
  stage: 'answering_validation' | 'support_runtime' | 'answering_runtime' | 'engineering_checks' | 'learning_runtime' | 'learning_test_receipts',
  surfaces?: { readonly engineering: boolean; readonly answering: boolean },
): void {
  try {
    logger.log('error', 'support.composition_unavailable', { stage, ...surfaces });
  } catch {
    // A diagnostic sink cannot prevent the healthy surface fallback.
  }
}

/** Reject incomplete source-injected bundles before optional ports are used.
 * The component validators still own route/policy/usage semantics. A previously
 * installed surface retains only exact accepted receipt recovery when OFF. */
function checkedAnswering(options: SupportAnsweringComposition,
  logger: ReturnType<typeof createAppLogger>): SupportAnsweringComposition {
  try {
    const recovery = options.recoveryOnly === true || Object.hasOwn(options, 'configuration')
      ? { recoveryOnly: true as const } : {};
    if (options.enabled?.() !== true) return recovery;
    const value = options.configuration;
    if (value === undefined) return recovery;
    const attempts = value.turns?.maxAttempts;
    if (typeof attempts !== 'number' || !Number.isSafeInteger(attempts) || attempts < 2 || attempts > 4 ||
      value.disclosureVersion !== SUPPORT_ANSWERING_DISCLOSURE_VERSION ||
      typeof value.readApiKey !== 'function' || typeof value.selectAudience !== 'function' ||
      value.customerPolicy === null || typeof value.customerPolicy !== 'object' ||
      Array.isArray(value.customerPolicy) || typeof value.customerPolicy.version !== 'string' ||
      value.usagePolicy === null || typeof value.usagePolicy !== 'object' || Array.isArray(value.usagePolicy) ||
      typeof value.route?.readRoute !== 'function' || typeof value.route.counter?.count !== 'function' ||
      !Array.isArray(value.route.allowlist) || value.route.allowlist.length < 1 || value.route.allowlist.length > 8) {
      logSupportCompositionFailure(logger, 'answering_validation');
      return recovery;
    }
    // Use the accounting component's exact version contract before constructing
    // optional runtimes; its complete policy validator still owns all semantics.
    usageText(value.usagePolicy.version);
    return options;
  } catch {
    logSupportCompositionFailure(logger, 'answering_validation');
    return { recoveryOnly: true };
  }
}

function createSupportHandler(
  env: AppEnv,
  logger: ReturnType<typeof createAppLogger>,
  engineering: SupportEngineeringHumanComposition = {},
  answering: SupportAnsweringComposition = {},
  releaseFollowup: SupportReleaseFollowupComposition | undefined = undefined,
  engineeringProduction: SupportEngineeringProductionOptions = {},
  learning?: SupportLearningRootComposition,
) {
  let learningGraph: ReturnType<typeof createSupportLearningComposition> | undefined;
  if (learningConfigured(learning)) {
    try { learningGraph = createSupportLearningComposition(learning); }
    catch { logSupportCompositionFailure(logger, 'learning_runtime'); }
  }
  if (learning !== undefined && engineeringProduction.configuration !== undefined) {
    // Explicit sharing wins even when its controller is unavailable. Never
    // construct a private checker pool as a fallback for this selection.
    engineeringProduction = { ...engineeringProduction, configuration: {
      ...engineeringProduction.configuration, readChecks: () => learningGraph?.readEngineeringChecks(),
    } };
  }
  const production = createProductionSupportEngineering(engineeringProduction);
  learningGraph?.bindEngineeringRepositories(production.application.repositoryMetadata);
  const workerConfigured = production.processing.configuration !== undefined;
  let selectedEngineering = engineering;
  let selectedAnswering = checkedAnswering(answering, logger);
  if (learningGraph !== undefined && selectedAnswering.configuration !== undefined)
    selectedAnswering = { ...selectedAnswering, configuration: {
      ...selectedAnswering.configuration, privateSources: learningGraph.sources,
    } };
  let configured = workerConfigured || supportEngineeringHumanEnabled(selectedEngineering);
  const answerConfigured = selectedAnswering.configuration !== undefined || selectedAnswering.recoveryOnly === true;
  let followupConfigured = supportReleaseFollowupEnabled(releaseFollowup);
  const followupSelection = releaseFollowup;
  const defaultFollowup =
    supportReleaseFollowupUsesDefault(releaseFollowup) &&
    supportReleaseFollowupSourceEnabled(env);
  const shared = configured || answerConfigured || followupConfigured || defaultFollowup || learningGraph !== undefined;
  const identityRuntime = createProductionIdentityRuntime(env, logger, shared ? 512 : undefined);
  let supportRuntime: ReturnType<typeof createSupportRuntime>;
  if (defaultFollowup) {
    releaseFollowup = createSupportReleaseFollowupBootstrap({
      environment: env,
      paid: supportReleaseFollowupPaidSelection(followupSelection),
      store: identityRuntime.store,
      clock: engineeringProduction.clock ?? systemClock,
      application: () => supportRuntime.application,
      resolvePrincipal: (id) => createAgentPrincipalResolver(supportRuntime)(id),
      knowledge: () => knowledgeHost?.knowledge().application,
      reports: () => knowledgeHost?.knowledge().evidence,
      async readGovernance(collectionId, signal, policyHint) {
        const selectedResolver = () =>
          followupSelection !== undefined &&
          Object.hasOwn(followupSelection, 'governanceAccess')
            ? followupSelection.governanceAccess
            : learning?.testEvidence?.governanceAccess;
        const resolver = selectedResolver();
        const sourceConfiguration = env.SUPPORT_LEARNING_SOURCE_CONFIGURATION_JSON;
        if (
          !resolver ||
          signal.aborted ||
          !supportReleaseFollowupSourceEnabled(env) ||
          !knowledgeRetrievalEnabled(env)
        )
          return null;
        const before = await resolver.resolve(collectionId, signal);
        if (
          !before ||
          !hasPermission(before.access, knowledgePermissions.validationManage)
        )
          return null;
        const authority = JSON.stringify([
          before.authorityVersion,
          serializeAccessContext(before.access),
        ]);
        const application = knowledgeHost?.knowledge().application;
        if (!application) return null;
        const current = (active: AbortSignal) =>
          !active.aborted &&
          supportReleaseFollowupSourceEnabled(env) &&
          knowledgeRetrievalEnabled(env) &&
          env.SUPPORT_LEARNING_SOURCE_CONFIGURATION_JSON === sourceConfiguration &&
          selectedResolver() === resolver &&
          knowledgeHost?.knowledge().application === application;
        const confirmAuthority = async (
          active: AbortSignal,
        ): Promise<false | (() => true)> => {
          if (!current(active)) return false;
          const after = await resolver.resolve(collectionId, active);
          if (
            !after ||
            !current(active) ||
            !hasPermission(after.access, knowledgePermissions.validationManage) ||
            authority !== JSON.stringify([
              after.authorityVersion,
              serializeAccessContext(after.access),
            ])
          )
            return false;
          // This synchronous tail checks captured host configuration only. The
          // awaited resolver above owns current external privileged authority.
          return (): true => {
            if (!current(active)) throw new TypeError('Test evidence authority changed');
            return true;
          };
        };
        const result = await readSupportTestEvidenceGovernance(
          application, before.access, collectionId, policyHint,
        ).catch((error: unknown) => {
          if (error instanceof LearningTestReceiptError && error.code === 'changed')
            throw new ApiError(409, 'followup_retest_changed');
          throw error;
        });
        return (await confirmAuthority(signal)) === false
          ? null
          : { ...result, confirmAuthority };
      },
    });
    followupConfigured = supportReleaseFollowupEnabled(releaseFollowup);
  }
  let knowledgeHost: KnowledgeHostRuntime | null | undefined;
  let testReceiptPreparation:
    ReturnType<typeof createSupportLearningTestReceipts> | undefined;
  let testReceiptAttached = false;
  const testReceiptEnabled = () =>
    testReceiptAttached &&
    env.PEGMA_SUPPORT_LEARNING_INTAKE_ENABLED === "true" &&
    knowledgeRetrievalEnabled(env);
  if (
    env.PEGMA_SUPPORT_LEARNING_INTAKE_ENABLED === "true" &&
    knowledgeRetrievalEnabled(env) &&
    learningGraph?.application.enabled === true
  ) {
    try {
      const selected = learning?.testEvidence;
      const productContext = learningGraph.application.productContext;
      if (
        selected !== undefined &&
        typeof selected.governanceAccess?.resolve === "function" &&
        productContext !== undefined
      ) {
        const sameAuthority = (value: {
          access: AccessContext;
          authorityVersion: string;
        }) =>
          JSON.stringify([
            value.authorityVersion,
            serializeAccessContext(value.access),
          ]);
        testReceiptPreparation = createSupportLearningTestReceipts({
          store: identityRuntime.store,
          clock: engineeringProduction.clock ?? systemClock,
          support: () =>
            testReceiptAttached ? supportRuntime?.application : undefined,
          knowledge: () =>
            testReceiptEnabled()
              ? knowledgeHost?.knowledge().application
              : undefined,
          reports: () =>
            testReceiptEnabled()
              ? knowledgeHost?.knowledge().evidence
              : undefined,
          productContext,
          retentionMilliseconds: selected.retentionMilliseconds,
          async resolvePrincipal(principalId, signal) {
            if (signal.aborted || !testReceiptEnabled()) return null;
            const access =
              await createAgentPrincipalResolver(supportRuntime)(principalId);
            return signal.aborted || !testReceiptEnabled() ? null : access;
          },
          async readGovernance(collectionId, signal) {
            if (signal.aborted || !testReceiptEnabled()) return null;
            const before = await selected.governanceAccess.resolve(
              collectionId,
              signal,
            );
            if (
              before === null ||
              !hasPermission(
                before.access,
                knowledgePermissions.validationManage,
              ) ||
              typeof before.authorityVersion !== "string" ||
              before.authorityVersion.length < 1 ||
              before.authorityVersion.length > 200 ||
              /[\u0000-\u001f\u007f]/u.test(before.authorityVersion) ||
              signal.aborted ||
              !testReceiptEnabled()
            )
              return null;
            const authority = sameAuthority(before);
            const application = knowledgeHost?.knowledge().application;
            if (application === undefined) return null;
            const value = await application.getGovernanceConfiguration(
              before.access,
              { collectionId },
            );
            const validationPolicy = await application.getValidationPolicy(
              before.access,
              { policyId: value.configuration.validationPolicy.id },
            );
            const after = await selected.governanceAccess.resolve(
              collectionId,
              signal,
            );
            if (
              after === null ||
              signal.aborted ||
              !testReceiptEnabled() ||
              authority !== sameAuthority(after)
            )
              return null;
            return { ...value, validationPolicy };
          },
        });
      }
    } catch {
      logSupportCompositionFailure(logger, "learning_test_receipts");
    }
  }
  let learningIntakeAvailable = learningGraph !== undefined;
  if (production.attachRuntime?.({ store: identityRuntime.store,
    clock: engineeringProduction.clock ?? systemClock, application: () => supportRuntime.application }) === false)
    logSupportCompositionFailure(logger, 'engineering_checks');
  function construct(withEngineering: boolean, withAnswering: boolean) {
    try {
      const intake = !withEngineering ? undefined : workerConfigured
        ? production.application : supportEngineeringIntakeOptions(selectedEngineering);
      const dependencies = {
        sessions: identityRuntime.sessions,
        identity: identityRuntime.identity,
        identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
        logger,
        ...(workerConfigured || learningGraph !== undefined ? { clock: engineeringProduction.clock ?? systemClock } : {}),
        ...(intake === undefined ? {} : { engineering: intake }),
        ...(!learningIntakeAvailable ? {} : { resolutionLearning: testReceiptPreparation === undefined
          ? learningGraph!.application
          : { ...learningGraph!.application, testReceipts: { verify: testReceiptPreparation.verify } } }),
        ...(followupConfigured ? { engineeringFollowup: supportReleaseFollowupApplicationOptions(releaseFollowup) } : {}),
        ...(!withAnswering || selectedAnswering.configuration === undefined
          ? {} : { assistantTurns: supportAnsweringTurns(selectedAnswering) }),
      };
      const selected = shared
        ? createSupportRuntime({ ...dependencies, store: identityRuntime.store })
        : createProductionSupportRuntime(env, dependencies);
      testReceiptAttached = learningIntakeAvailable && testReceiptPreparation !== undefined;
      return selected;
    } catch (error) {
      if (learningIntakeAvailable) {
        // Retry once with the ordinary App defaults. Keep the source graph for
        // binding to the final real App; a base failure still escapes this retry.
        learningIntakeAvailable = false;
        logSupportCompositionFailure(logger, 'learning_runtime');
        return construct(withEngineering, withAnswering);
      }
      if (withEngineering || withAnswering)
        logSupportCompositionFailure(logger, 'support_runtime', { engineering: withEngineering, answering: withAnswering });
      throw error;
    }
  }
  let withAnswering = selectedAnswering.configuration !== undefined;
  try { supportRuntime = construct(configured, withAnswering); }
  catch (error) {
    if (!configured && !withAnswering && !followupConfigured) throw error;
    // Malformed optional follow-up configuration cannot break ordinary Support.
    followupConfigured = false;
    if (configured && withAnswering) {
      try { supportRuntime = construct(false, true); configured = false; }
      catch {
        withAnswering = false;
        try { supportRuntime = construct(true, false); }
        catch { configured = false; supportRuntime = construct(false, false); }
      }
    } else {
      configured = false;
      withAnswering = false;
      supportRuntime = construct(false, false);
    }
  }
  if (!configured) selectedEngineering = {};
  else if (workerConfigured && selectedEngineering.configuration !== undefined) {
    // HTTP and worker proof checks observe the same trusted verifier ports.
    selectedEngineering = { ...selectedEngineering, configuration: {
      ...selectedEngineering.configuration,
      application: production.application,
      reviewProofs: production.reviewProofs,
      ...(production.discardChecks === undefined ? {} : { discardChecks: production.discardChecks }),
    } };
  }
  if (configured && selectedEngineering.configuration !== undefined) {
    const original = selectedEngineering.configuration;
    selectedEngineering = {
      ...selectedEngineering,
      configuration: {
        ...original,
        async discardChecks(ticketId) {
          await Promise.all([
            original.discardChecks?.(ticketId),
            createSupportReleaseFollowupCheckCleanup({
              store: supportRuntime.store,
              clock: supportRuntime.clock,
            }).discardTicket(ticketId),
          ]);
        },
      },
    };
  }
  if (!withAnswering) selectedAnswering = answerConfigured ? { recoveryOnly: true } : {};
  let answeringRuntime;
  if (answerConfigured) {
    try {
      answeringRuntime = composeSupportAnswering(supportRuntime, logger, selectedAnswering,
        () => env.PEGMA_SUPPORT_ASSISTANT_ENABLED === 'true');
    } catch {
      logSupportCompositionFailure(logger, 'answering_runtime');
      selectedAnswering = { recoveryOnly: true };
      supportRuntime = construct(configured, false);
      answeringRuntime = composeSupportAnswering(supportRuntime, logger, selectedAnswering,
        () => env.PEGMA_SUPPORT_ASSISTANT_ENABLED === 'true');
    }
  }
  if (learningConfigured(learning)) {
    try {
      if (learningGraph?.bindSupport(supportRuntime) !== true)
        throw new TypeError('Learning application binding unavailable');
      const graph = learningGraph;
      knowledgeHost = createKnowledgeHostRuntime(env, logger, {
        support: supportRuntime, createKnowledge: (input) => graph.createKnowledge(input),
      });
      knowledgeHost.knowledge();
    } catch {
      knowledgeHost = null;
      logSupportCompositionFailure(logger, 'learning_runtime');
    }
  }
  if (followupConfigured && knowledgeHost === undefined && knowledgeRetrievalEnabled(env))
    knowledgeHost = createKnowledgeHostRuntime(env, logger, { support: supportRuntime });
  const learningRuntime = learningGraph?.browserRuntime();
  const api = createSupportApi({
    application: supportRuntime.application,
    sessions: supportRuntime.sessions,
    identity: supportRuntime.identity,
    identityLinkFromClaims: supportRuntime.identityLinkFromClaims,
    createLimiter: supportRuntime.createLimiter,
    replyLimiter: supportRuntime.replyLimiter,
    logger,
    onCustomerMessageAccepted: answeringRuntime?.hintAccepted,
    releaseFollowupEnabled: () => followupConfigured && supportReleaseFollowupEnabled(releaseFollowup),
    ...(learningRuntime === undefined ? {} : {
      learningRuntime: {
        ...learningRuntime,
        ...(!testReceiptAttached || testReceiptPreparation === undefined ? {} : {
          successfulTestScope() {
            const scope = testReceiptPreparation!.forSubmission();
            return {
              application: supportRuntime.createResolutionEvidenceApplication(scope.verifier),
              confirm: scope.confirm,
            };
          },
        }),
      },
    }),
    ...(!testReceiptAttached || testReceiptPreparation === undefined ? {} : {
      learningTestReceiptPreparation: testReceiptPreparation,
      learningTestReceiptEnabled: testReceiptEnabled,
    }),
    ...(learning === undefined ? {} : { learningEnabled: () =>
      learningIntakeAvailable && env.PEGMA_SUPPORT_LEARNING_INTAKE_ENABLED === 'true' && learningGraph?.ready() === true }),
    ...(configured ? { engineering: composeSupportEngineeringHuman(supportRuntime, logger, selectedEngineering) } : {}),
    ...(followupConfigured ? { releaseFollowup: composeSupportReleaseFollowup(supportRuntime, logger, releaseFollowup) } : {}),
    // The stored Support ROLE is the only staff gate (fail closed).
    roleStore: supportRuntime.roleStore,
    bootstrapPrincipals: parseBootstrapPrincipals(env),
  });
  // One admin tool per site: the role-administration API over
  // @pegma/authorization-admin, gated on the stored Admin role.
  const adminApi = createAdminApi({
    sessions: supportRuntime.sessions,
    identity: supportRuntime.identity,
    identityLinkFromClaims: supportRuntime.identityLinkFromClaims,
    logger,
    roleStore: supportRuntime.roleStore,
    holderIndex: createRoleHolderIndex(supportRuntime.store),
    mutationLimiter: createAdminMutationLimiter(supportRuntime.store),
    lookupLimiter: createAdminLookupLimiter(supportRuntime.store),
    bootstrapPrincipals: parseAdminBootstrapPrincipals(env),
  });
  return { supportRuntime, api, adminApi,
    answering: answeringRuntime,
    learning: learningGraph,
    knowledgeHost,
    learningDriver: learningGraph === undefined ? undefined : createSupportLearningDriver({
      store: supportRuntime.store, clock: supportRuntime.clock,
      isEnabled: () => learningWorkerEnabled(env, learning) && learningGraph?.ready() === true,
      runtime: (current) => {
        const graph = learningGraph!;
        const runtime = graph.runtime();
        if (runtime === undefined) return undefined;
        return {
          scanCandidates: (bounds) => runtime.scanMaintenanceCandidates(bounds),
          async processWork(command, run) {
            let hint: SupportLearningDeferredCheckHint | undefined;
            const result = await runtime.processWork(command, run, {
              onDurablyDeferred(value) {
                if (value.kind !== 'learning' || value.scope.ticketId !== command.ticketId ||
                  value.scope.sourceGeneration !== command.sourceGeneration) return;
                hint = { kind: 'checks', operationId: value.operationId,
                  ticketId: value.scope.ticketId, sourceGeneration: value.scope.sourceGeneration,
                  expiresAt: value.expiresAt };
              },
            });
            return hint !== undefined && (result.outcome === 'held' || result.outcome === 'pending')
              ? { outcome: 'checks_pending', hint } : result;
          },
          reconcileSource: runtime.reconcileSource,
          async precomputeChecks(hint, run) {
            const result = await graph.precomputePending(hint.operationId, {
              signal: run?.signal ?? new AbortController().signal,
              deadline: new Date(Math.min(Date.parse(supportRuntime.clock.now()) + 25_000,
                Date.parse(hint.expiresAt))).toISOString(),
            }, { ticketId: hint.ticketId, sourceGeneration: hint.sourceGeneration },
            () => current() && learningWorkerEnabled(env, learning));
            return { outcome: result.outcome };
          },
        };
      },
    }),
    followupDriver: !followupConfigured || releaseFollowup?.configuration?.generation === undefined ? undefined
      : createSupportReleaseFollowupDriver({
        store: supportRuntime.store,
        clock: supportRuntime.clock,
        invocationMode: releaseFollowup?.configuration?.invocationMode,
        enabled: () => env.PEGMA_SUPPORT_RELEASE_FOLLOWUP_PROCESSING_ENABLED === 'true' && supportReleaseFollowupEnabled(releaseFollowup),
        runtime: (current) => createSupportReleaseFollowupRuntime({
          application: supportRuntime.application,
          store: supportRuntime.store,
          clock: supportRuntime.clock,
          configuration: releaseFollowup!.configuration!,
          enabled: () => current() && supportReleaseFollowupEnabled(releaseFollowup),
        }),
      }),
    engineeringDriver: configured && workerConfigured
      ? composeSupportEngineeringDriver(supportRuntime, { ...production.processing, logger }) : undefined,
  };
}

/** Request-local optional human composition used by the registered Worker route. */
export function createSupportRequestHandler(env: AppEnv, logger: ReturnType<typeof createAppLogger>,
  engineering: SupportEngineeringHumanComposition = {}, answering: SupportAnsweringComposition = {},
  releaseFollowup: SupportReleaseFollowupComposition | undefined = undefined,
  engineeringProduction: SupportEngineeringProductionOptions = {},
  learning?: SupportLearningRootComposition) {
  return async (request: Request): Promise<Response> => {
    const selectedAnswering = checkedAnswering(answering, logger);
    if (isSupportReleaseFollowupRequest(new URL(request.url).pathname) && !supportReleaseFollowupEnabled(releaseFollowup) &&
      !(supportReleaseFollowupUsesDefault(releaseFollowup) && supportReleaseFollowupSourceEnabled(env)))
      return Response.json({ error: 'not_found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    if (isSupportEngineeringRequest(new URL(request.url).pathname) && !supportEngineeringHumanEnabled(engineering))
      return Response.json({ error: 'not_found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    if (new URL(request.url).pathname.startsWith(SUPPORT_ANSWERING_NAMESPACE)) {
      const url = new URL(request.url); const path = url.pathname;
      if ((selectedAnswering.configuration === undefined && selectedAnswering.recoveryOnly !== true) || url.search !== '' || !['/api/support/assistant/capability', '/api/support/assistant/tickets'].includes(path))
        return Response.json({ error: 'not_found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
      const method = path.endsWith('/capability') ? 'GET' : 'POST';
      if (request.method !== method)
        return Response.json({ error: 'method_not_allowed' }, { status: 405, headers: { 'Cache-Control': 'no-store', Allow: method } });
      if (path.endsWith('/capability') && (env.PEGMA_SUPPORT_ASSISTANT_ENABLED !== 'true' || !supportAnsweringAdmissionEnabled(selectedAnswering)))
        return Response.json({ enabled: false }, { headers: { 'Cache-Control': 'no-store' } });
      // One counter spans the entire dedicated request, including every fresh
      // Identity/Role/Support/KB read and any late unknown-outcome continuation.
      const composed = createSupportHandler(answeringInvocationEnvironment(env), logger, engineering, selectedAnswering, {}, engineeringProduction, learning);
      return createSupportAnsweringIngress(composed.supportRuntime, logger, composed.answering!)(request);
    }
    // Receipt-only installation must not change ordinary human Store composition.
    return createSupportHandler(env, logger, engineering,
      selectedAnswering.configuration === undefined ? {} : selectedAnswering, releaseFollowup, engineeringProduction, learning).api(request);
  };
}

/**
 * Thin Workers slice that proves pegma.dev's Pegma Logger wiring:
 * Cloudflare Workers Logs (via @pegma/logger-cloudflare + observability)
 * teed with Datadog when DATADOG_API_KEY is set.
 */
export function createWorker(options: {
  readonly learningReviews?: SupportLearningReviewWorkerComposition;
  readonly engineering?: SupportEngineeringHumanComposition;
  /** Trusted executable ports only; missing configuration keeps processing OFF. */
  readonly engineeringProduction?: SupportEngineeringProductionOptions;
  readonly answering?: SupportAnsweringComposition;
  readonly releaseFollowup?: SupportReleaseFollowupComposition;
  readonly learning?: SupportLearningRootComposition;
} = {}) {
type PaidBundle = Awaited<ReturnType<typeof createSupportPaidBootstrap>>;
const paidSelections = new WeakMap<
  AppEnv,
  {
    raw: string | undefined;
    source: string | undefined;
    signature: string;
    promise: Promise<void>;
    bundle: PaidBundle;
    settled: boolean;
  }
>();
async function prepareDefault(env: AppEnv) {
  if ('learning' in options || 'engineering' in options || 'engineeringProduction' in options)
    return;
  const raw = env.SUPPORT_PAID_CONFIGURATION_JSON;
  const source = env.SUPPORT_LEARNING_SOURCE_CONFIGURATION_JSON;
  const signature = JSON.stringify([
    raw,
    source,
    env.PEGMA_KNOWLEDGE_ENABLED,
    env.PEGMA_SUPPORT_INDEPENDENT_CHECKS_ENABLED,
    env.PEGMA_SUPPORT_LEARNING_WORKER_ENABLED,
    env.PEGMA_SUPPORT_ENGINEERING_PROCESSING_ENABLED,
    env.PEGMA_SUPPORT_ENGINEERING_REPOSITORY_ENABLED,
    env.PEGMA_SUPPORT_ENGINEERING_ISSUE_WRITE_ENABLED,
    env.PEGMA_SUPPORT_RELEASE_FOLLOWUP_ENABLED,
    env.PEGMA_SUPPORT_RELEASE_FOLLOWUP_PROCESSING_ENABLED,
  ]);
  const previous = paidSelections.get(env);
  if (previous?.signature === signature && (!previous.settled || supportPaidBootstrapReusable(previous.bundle)))
    return previous.promise;
  const entry = {
    raw,
    source,
    signature,
    bundle: undefined as PaidBundle,
    promise: Promise.resolve(),
    settled: false,
  };
  entry.promise = createSupportPaidBootstrap(env, {
    isSelected: () =>
      !('learning' in options) &&
      !('engineering' in options) &&
      !('engineeringProduction' in options) &&
      paidSelections.get(env) === entry,
  })
    .then((bundle) => {
      entry.bundle = bundle;
    })
    .catch(() => {
      entry.bundle = undefined;
    })
    .finally(() => { entry.settled = true; });
  paidSelections.set(env, entry);
  return entry.promise;
}
function paidFor(env: AppEnv) {
  const value = paidSelections.get(env);
  return value !== undefined &&
    value.raw === env.SUPPORT_PAID_CONFIGURATION_JSON &&
    value.source === env.SUPPORT_LEARNING_SOURCE_CONFIGURATION_JSON
    ? value.bundle
    : undefined;
}
const followupFor = (env: AppEnv): SupportReleaseFollowupComposition | undefined => {
  if ('releaseFollowup' in options) return options.releaseFollowup ?? {};
  if (!supportReleaseFollowupSourceEnabled(env)) return undefined;
  return {
    production: paidFor(env)?.releaseFollowup?.production,
    governanceAccess: createSupportFollowupGovernanceAccess(env),
  };
};
const followupWorkerEnabledFor = (env: AppEnv) => {
  if (env.PEGMA_SUPPORT_RELEASE_FOLLOWUP_PROCESSING_ENABLED !== 'true')
    return false;
  const selected = followupFor(env);
  return (
    supportReleaseFollowupEnabled(selected) ||
    (supportReleaseFollowupUsesDefault(selected) &&
      supportReleaseFollowupSourceEnabled(env))
  );
};
const followupTrackingFor = (env: AppEnv) =>
  supportReleaseFollowupSourceEnabled(env) &&
  (!('releaseFollowup' in options) ||
    (options.releaseFollowup !== undefined &&
      supportReleaseFollowupUsesDefault(options.releaseFollowup)));
const humanEngineeringFor = (env: AppEnv) =>
  'engineering' in options ? options.engineering : paidFor(env)?.engineering;
const answeringFor = (env: AppEnv) => options.answering === undefined
  ? createProductionSupportAnswering(env)
  : Promise.resolve(options.answering);
// Capture one source configuration per physical invocation, while observing
// its original enablement/configuration and the separate deployment flag live.
const engineeringFor = (env: AppEnv): SupportEngineeringProductionOptions => {
  try {
  const supplied = 'engineeringProduction' in options ? options.engineeringProduction : paidFor(env)?.engineeringProduction;
  if (supplied === undefined) return {};
  const configuration = supplied.configuration;
  return { ...supplied, enabled: () => {
    try {
      return env.PEGMA_SUPPORT_ENGINEERING_PROCESSING_ENABLED === 'true' &&
        (('engineeringProduction' in options ? options.engineeringProduction : paidFor(env)?.engineeringProduction) === supplied) && supplied.configuration === configuration &&
        supplied.enabled?.() === true;
    } catch { return false; }
  } };
  } catch { return {}; }
};
const learningFor = (env: AppEnv): SupportLearningRootComposition | undefined => {
  let failedSelection: SupportLearningRootComposition | undefined;
  try {
    const explicit = 'learning' in options;
    const bootstrap = explicit ? undefined : createSupportLearningBootstrap(env, {
      isSelected: () => !('learning' in options),
    });
    const supplied = explicit ? options.learning : paidFor(env)?.learning ?? bootstrap?.learning;
    failedSelection = supplied;
    if (supplied === undefined) return undefined;
    const currentSelection = () => {
      try { return explicit ? 'learning' in options && options.learning === supplied
        : !('learning' in options) && (paidFor(env)?.learning === supplied ? paidFor(env)?.current() === true : bootstrap?.current() === true); }
      catch { return false; }
    };
    const intake = supplied.intake;
    let selected: SupportLearningRootComposition =
      intake === undefined
        ? supplied
        : {
            ...supplied,
            intake: {
              ...intake,
              enabled:
                env.PEGMA_SUPPORT_LEARNING_INTAKE_ENABLED === "true" &&
                intake.enabled === true,
            },
          };
    const evidence = supplied.testEvidence;
    if (evidence !== undefined) {
      const governance = evidence.governanceAccess;
      const current = () =>
        currentSelection() &&
        supplied.testEvidence === evidence &&
        evidence.governanceAccess === governance &&
        env.PEGMA_SUPPORT_LEARNING_INTAKE_ENABLED === "true" &&
        knowledgeRetrievalEnabled(env);
      selected = {
        ...selected,
        testEvidence: {
          ...evidence,
          governanceAccess: {
            async resolve(collectionId, signal) {
              if (signal.aborted || !current()) return null;
              const value = await governance.resolve(collectionId, signal);
              return signal.aborted || !current() ? null : value;
            },
          },
        },
      };
    }
    const production = supplied.production;
    if (production === undefined) return selected;
    const configuration = production.configuration;
    return { ...selected, production: { ...production,
      intakeEnabled: env.PEGMA_SUPPORT_LEARNING_INTAKE_ENABLED === 'true' && production.intakeEnabled === true,
      enabled: () => {
        try { return currentSelection() && supplied?.production === production &&
          production.configuration === configuration && env.PEGMA_SUPPORT_LEARNING_WORKER_ENABLED === 'true' &&
          production.enabled?.() === true; } catch { return false; }
      },
    } };
  } catch { return failedSelection; }
};
const retrievalFor = (env: AppEnv, logger: ReturnType<typeof createAppLogger>) => {
  const learning = learningFor(env);
  if (!learningConfigured(learning)) return { store: createKnowledgeProjectionStore(env), clock: systemClock };
  const selected = createSupportHandler(env, logger, humanEngineeringFor(env), {}, followupFor(env),
    engineeringFor(env), learning).learning?.retrievalOptions();
  if (selected === undefined) throw new TypeError('Learning retrieval binding unavailable');
  return selected;
};
return {
  async fetch(
    request: Request,
    env: AppEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (env.SUPPORT_PAID_CONFIGURATION_JSON && !('learning' in options) && !('engineering' in options) && !('engineeringProduction' in options))
      await prepareDefault(env);
    const logger = createAppLogger(env, (p) => ctx.waitUntil(p));
    const url = new URL(request.url);
    const path = url.pathname;

    logger.log('info', 'request.received', {
      method: request.method,
      path,
      host: url.host,
    });

    // Public composition catalog MCP (stateless; catalog facts only).
    if (path === '/api/mcp') {
      try {
        return await createPegmaMcpHandler(env)(request, env, ctx);
      } catch (error) {
        logger.log('error', 'mcp.unavailable', {
          error: error instanceof Error ? error.name : 'unknown',
          message: error instanceof Error ? error.message : String(error),
        });
        return Response.json(
          { error: 'mcp_unavailable' },
          {
            status: 503,
            headers: {
              'Cache-Control': 'no-store',
              'Content-Type': 'application/json; charset=utf-8',
              'X-Content-Type-Options': 'nosniff',
            },
          },
        );
      }
    }

    if (isKnowledgeRequest(path)) {
      if (!knowledgeRetrievalEnabled(env)) return handleKnowledgeRequest(request, env, logger);
      const learning = learningFor(env);
      if (!learningConfigured(learning)) return handleKnowledgeRequest(request, env, logger);
      try {
        const composed = createSupportHandler(env, logger, humanEngineeringFor(env), {}, followupFor(env),
          engineeringFor(env), learning);
        return handleKnowledgeRequest(request, env, logger, composed.knowledgeHost ?? null);
      } catch {
        return handleKnowledgeRequest(request, env, logger, null);
      }
    }

    if (
      request.method === 'GET' &&
      (path === '/' || path === '/health' || path === '/api/health')
    ) {
      let releaseDetail: Awaited<ReturnType<typeof loadReleaseHealthDetail>> = {
        ingestionConfigured: Boolean(readGitHubReleaseWebhookConfig(env)),
        readConfigured: Boolean(readReleasesConfig(env)),
        lastSuccessfulWebhookAt: null,
        lastSuccessfulReconciliationAt: null,
        reconciliationStale: true,
        currentReleaseCount: 0,
      };
      try {
        releaseDetail = await loadReleaseHealthDetail(
          createProductionStore(env),
          env,
        );
      } catch (error) {
        logger.log('error', 'releases_health.unavailable', {
          error: error instanceof Error ? error.name : 'unknown',
        });
      }

      let supportDetail: {
        storage: 'cloudflare-d1';
        packages: string;
        probe: 'disabled' | 'ok' | 'fail';
      } = {
        storage: 'cloudflare-d1',
        packages: '@pegma/support-desk-application@0.2.10',
        probe: 'disabled',
      };
      if (supportHealthProbeEnabled(env)) {
        try {
          const identityRuntime = createProductionIdentityRuntime(env, logger);
          const supportRuntime = createProductionSupportRuntime(env, {
            sessions: identityRuntime.sessions,
            identity: identityRuntime.identity,
            identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
            logger,
          });
          const probe = await probeSupportStore(supportRuntime.store);
          supportDetail = {
            ...supportDetail,
            probe: probe.ok ? 'ok' : 'fail',
          };
        } catch {
          supportDetail = { ...supportDetail, probe: 'fail' };
        }
      }

      const result = await runHealthChecks({
        service: 'pegma-dev-api',
        logger,
        checks: [
          createProcessCheck(),
          createDetailCheck('logging', {
            cloudflare: true,
            datadog: Boolean(env.DATADOG_API_KEY),
          }),
          createDetailCheck('identity', {
            storage: 'cloudflare-d1',
            sessions: '@pegma/sessions@0.3.0',
            runtime: '@pegma/identity@0.1.2',
            authorizationAdapter: '@pegma/authorization-identity@0.4.0',
            emailDelivery:
              String(env.IDENTITY_EMAIL_ENABLED) === 'true' &&
              Boolean(env.RESEND_API_KEY),
          }),
          createDetailCheck('supportDesk', supportDetail),
          createDetailCheck('githubReleases', {
            ingestionConfigured: releaseDetail.ingestionConfigured,
            readConfigured: releaseDetail.readConfigured,
            lastSuccessfulWebhookAt: releaseDetail.lastSuccessfulWebhookAt,
            lastSuccessfulReconciliationAt:
              releaseDetail.lastSuccessfulReconciliationAt,
            reconciliationStale: releaseDetail.reconciliationStale,
            currentReleaseCount: releaseDetail.currentReleaseCount,
          }),
        ],
      });
      const { status, body } = toHealthResponse(result);
      return Response.json(body, { status });
    }

    if (path === '/api/releases') {
      const releasesConfig = readReleasesConfig(env);
      if (releasesConfig === null) {
        logger.log('error', 'releases_api.not_configured', {});
        return Response.json(
          { error: 'releases_not_configured' },
          {
            status: 503,
            headers: {
              'Cache-Control': 'no-store',
              'Content-Type': 'application/json; charset=utf-8',
              'X-Content-Type-Options': 'nosniff',
            },
          },
        );
      }
      try {
        return await handleGetReleases({
          request,
          store: createProductionStore(env),
          logger,
          config: releasesConfig,
        });
      } catch (error) {
        logger.log('error', 'releases_api.unavailable', {
          error: error instanceof Error ? error.name : 'unknown',
        });
        return Response.json(
          { error: 'releases_unavailable' },
          {
            status: 503,
            headers: {
              'Cache-Control': 'no-store',
              'Content-Type': 'application/json; charset=utf-8',
              'X-Content-Type-Options': 'nosniff',
            },
          },
        );
      }
    }

    if (path === '/api/webhooks/github/releases') {
      const config = readGitHubReleaseWebhookConfig(env);
      if (config === null) {
        logger.log('error', 'github_release_webhook.not_configured', {});
        return Response.json(
          { error: 'webhook_not_configured' },
          {
            status: 503,
            headers: {
              'Cache-Control': 'no-store',
              'Content-Type': 'application/json; charset=utf-8',
              'X-Content-Type-Options': 'nosniff',
            },
          },
        );
      }
      try {
        return await handleGitHubReleaseWebhook({
          request,
          store: createProductionStore(env),
          logger,
          config,
          followupTracking: () => followupTrackingFor(env),
        });
      } catch (error) {
        logger.log('error', 'github_release_webhook.unavailable', {
          error: error instanceof Error ? error.name : 'unknown',
        });
        return Response.json(
          { error: 'webhook_unavailable' },
          {
            status: 503,
            headers: {
              'Cache-Control': 'no-store',
              'Content-Type': 'application/json; charset=utf-8',
              'X-Content-Type-Options': 'nosniff',
            },
          },
        );
      }
    }

    if (path === '/api/secure' || path.startsWith('/api/identity/')) {
      try {
        return createProductionIdentityRuntime(env, logger).api(request);
      } catch (error) {
        logger.log('error', 'identity.runtime_unavailable', {
          error: error instanceof Error ? error.name : 'unknown',
        });
        return Response.json(
          { error: 'identity_unavailable' },
          {
            status: 503,
            headers: {
              'Cache-Control': 'no-store',
              'Content-Type': 'application/json; charset=utf-8',
              'X-Content-Type-Options': 'nosniff',
            },
          },
        );
      }
    }

    if (path.startsWith('/api/admin/')) {
      try {
        return await createSupportHandler(env, logger).adminApi(request);
      } catch (error) {
        logger.log('error', 'admin.runtime_unavailable', {
          error: error instanceof Error ? error.name : 'unknown',
        });
        return Response.json(
          { error: 'admin_unavailable' },
          {
            status: 503,
            headers: {
              'Cache-Control': 'no-store',
              'Content-Type': 'application/json; charset=utf-8',
              'X-Content-Type-Options': 'nosniff',
            },
          },
        );
      }
    }

    if (path.startsWith('/api/support/')) {
      try {
        const answering = await answeringFor(env);
        if (path.startsWith(SUPPORT_ANSWERING_NAMESPACE))
          return await createSupportRequestHandler(env, logger, humanEngineeringFor(env), answering, {}, engineeringFor(env), learningFor(env))(request);
        if (isSupportReleaseFollowupRequest(path))
          return await createSupportRequestHandler(env, logger, humanEngineeringFor(env), answering, followupFor(env), engineeringFor(env), learningFor(env))(request);
        if (isSupportEngineeringRequest(path))
          return await createSupportRequestHandler(env, logger, humanEngineeringFor(env), answering, {}, engineeringFor(env), learningFor(env))(request);
        const reviews = options.learningReviews;
        if (reviews !== undefined && learningReviewsEnabled(env, reviews))
          return await reviews.create(env, logger, humanEngineeringFor(env), answering, engineeringFor(env)).api(request);
        return await createSupportRequestHandler(env, logger, humanEngineeringFor(env), answering, {}, engineeringFor(env), learningFor(env))(request);
      } catch (error) {
        logger.log('error', 'support.runtime_unavailable', {
          error: error instanceof Error ? error.name : 'unknown',
        });
        return Response.json(
          { error: 'support_unavailable' },
          {
            status: 503,
            headers: {
              'Cache-Control': 'no-store',
              'Content-Type': 'application/json; charset=utf-8',
              'X-Content-Type-Options': 'nosniff',
            },
          },
        );
      }
    }

    logger.log('warn', 'request.not_found', { method: request.method, path });
    return new Response('Not Found', { status: 404 });
  },
  async scheduled(
    controller: ScheduledController,
    env: AppEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    if (env.SUPPORT_PAID_CONFIGURATION_JSON && !('learning' in options) && !('engineering' in options) && !('engineeringProduction' in options))
      await prepareDefault(env);
    const logger = createAppLogger(env, (promise) => ctx.waitUntil(promise));
    // Each cron has its own invocation CPU budget. Never combine all cleanup
    // with the time-sensitive mail path on Workers Free.
    if (controller.cron === RATE_LIMIT_CRON) {
      if (env.PEGMA_SUPPORT_ASSISTANT_ENABLED === 'true') {
        await runSupportAssistantTimer({
          isEnabled: () => env.PEGMA_SUPPORT_ASSISTANT_ENABLED === 'true',
          load: async () => checkedAnswering(await answeringFor(env), logger),
          create: (answering) => createSupportHandler(answeringInvocationEnvironment(env), logger,
            humanEngineeringFor(env), answering, {}, engineeringFor(env), learningFor(env)).answering,
          logger,
        });
        return;
      }
      // Preserve default/OFF throughput and zero Store work on the two newly
      // eligible minutes. No optional qualification or credential is read.
      if (!rateKnowledgeBackgroundEligibleAt(controller.scheduledTime)) return;
      ctx.waitUntil(
        (async () => {
          try {
            if (
              rateKnowledgeLaneAt(controller.scheduledTime) === 'rate_limits'
            ) {
              await runKnowledgeMaintenance(
                { store: createProductionStore(env), clock: systemClock },
                logger,
                { tasks: ['rate_limits'] },
              );
            } else if (knowledgeRetrievalEnabled(env)) {
              await createKnowledgeRetrievalReady({
                ...retrievalFor(env, logger),
                logger,
                isEnabled: () => knowledgeRetrievalEnabled(env),
              }).runPage();
            }
          } catch (error) {
            logger.log('error', 'knowledge.maintenance_unavailable', {
              error: error instanceof Error ? error.name : 'unknown',
            });
          }
        })(),
      );
      return;
    }

    if (controller.cron === RELEASE_RECONCILIATION_CRON) {
      ctx.waitUntil(
        (async () => {
          try {
            const releasesConfig = readReleasesConfig(env);
            if (releasesConfig === null) {
              logger.log('error', 'release_reconciliation.not_configured', {});
              return;
            }
            await runReleaseReconciliation({
              store: createProductionStore(env),
              logger,
              config: releasesConfig,
              scheduledTime: controller.scheduledTime,
              followupTracking: () => followupTrackingFor(env),
            });
          } catch (error) {
            logger.log('error', 'release_reconciliation.unavailable', {
              error: error instanceof Error ? error.name : 'unknown',
            });
          }
        })(),
      );
      return;
    }

    if (controller.cron === CLEANUP_CRON && env.PEGMA_SUPPORT_ENGINEERING_PROCESSING_ENABLED === 'true') {
      const source = engineeringFor(env);
      const production = createProductionSupportEngineering(source);
      ctx.waitUntil(seedSupportEngineeringWake({
        clock: source.clock ?? systemClock, logger,
        enabled: () => production.processing.configuration !== undefined && production.processing.enabled?.() === true,
        producer: () => env.SUPPORT_ENGINEERING_JOBS,
      }));
    }

    if (controller.cron === CLEANUP_CRON && env.PEGMA_SUPPORT_LEARNING_WORKER_ENABLED === 'true') {
      const selectedLearning = learningFor(env);
      ctx.waitUntil(seedSupportLearningWake({
        clock: systemClock, logger,
        enabled: () => learningWorkerEnabled(env, selectedLearning),
        producer: () => env.SUPPORT_ENGINEERING_JOBS,
      }));
    }

    if (
      controller.cron === CLEANUP_CRON &&
      supportReleaseFollowupWakeDue(controller.scheduledTime) &&
      env.PEGMA_SUPPORT_RELEASE_FOLLOWUP_PROCESSING_ENABLED === 'true'
    ) {
      ctx.waitUntil(
        seedSupportReleaseFollowupWake({
          clock: systemClock,
          logger,
          enabled: () => followupWorkerEnabledFor(env),
          producer: () => env.SUPPORT_ENGINEERING_JOBS,
        }),
      );
    }

    const cleanup =
      controller.cron === CLEANUP_CRON
        ? cleanupLaneAt(controller.scheduledTime, env.PEGMA_SUPPORT_ASSISTANT_ENABLED === 'true')
        : null;
    if (
      controller.cron !== MAIL_CRON &&
      controller.cron !== MAIL_RECONCILE_CRON &&
      cleanup === null
    ) {
      logger.log('warn', 'maintenance.unknown_cron', { cron: controller.cron });
      return;
    }

    if (cleanup === null || cleanup.kind === 'identity')
      ctx.waitUntil(
        (async () => {
          try {
            await runIdentityMaintenance(
              createProductionIdentityRuntime(env, logger),
              logger,
              cleanup === null
                ? {
                    tasks: [
                      controller.cron === MAIL_CRON
                        ? 'mail_send'
                        : 'mail_reconcile',
                    ],
                  }
                : {
                    tasks: [cleanup.task],
                    ...(cleanup.limiterIndex === undefined
                      ? {}
                      : { limiterIndex: cleanup.limiterIndex }),
                  },
            );
          } catch (error) {
            logger.log('error', 'identity.maintenance_unavailable', {
              error: error instanceof Error ? error.name : 'unknown',
            });
          }
        })(),
      );

    // Retrieval keeps its existing knowledge lane and activation gate,
    // independently of the isolated global limiter cron.
    if (cleanup?.kind === 'knowledge' && knowledgeRetrievalEnabled(env))
      ctx.waitUntil(
        (async () => {
          try {
            if (!knowledgeRetrievalEnabled(env)) return;
            await createKnowledgeRetrievalMaintenance({
              ...retrievalFor(env, logger),
              logger,
              isEnabled: () => knowledgeRetrievalEnabled(env),
            }).runPage();
          } catch {
            logger.log('error', 'knowledge.retrieval_maintenance.failed', {
              stage: 'composition',
            });
          }
        })(),
      );

    // These two bounded background jobs move into the exhaustive cleanup
    // rotation only while the all-minute invocation belongs to answering.
    if (cleanup?.kind === 'knowledge_rate_limits' || cleanup?.kind === 'knowledge_ready') {
      ctx.waitUntil((async () => {
        try {
          if (cleanup.kind === 'knowledge_rate_limits') {
            await runKnowledgeMaintenance({ store: createProductionStore(env), clock: systemClock },
              logger, { tasks: ['rate_limits'] });
          } else if (knowledgeRetrievalEnabled(env)) {
            await createKnowledgeRetrievalReady({ ...retrievalFor(env, logger),
              logger, isEnabled: () => knowledgeRetrievalEnabled(env) }).runPage();
          }
        } catch (error) {
          logger.log('error', 'knowledge.maintenance_unavailable', {
            error: error instanceof Error ? error.name : 'unknown',
          });
        }
      })());
      return;
    }

    if (cleanup?.kind === 'learning_reviews') {
      const reviews = options.learningReviews;
      if (reviews !== undefined && learningReviewsEnabled(env, reviews))
        ctx.waitUntil((async () => {
          try { await reviews.create(env, logger).queue.runPage(); }
          catch { /* Durable SDK rows remain available on the next physical scan. */ }
        })());
      return;
    }

    if (cleanup?.kind === 'support')
      ctx.waitUntil(
        (async () => {
          try {
            const runtime = cleanup.task === 'test_receipts'
              ? { store: createProductionStore(env), clock: systemClock, limiters: [] }
              : createProductionSupportMaintenanceRuntime(env);
            await runSupportMaintenance(
              {
                ...runtime,
                independentChecksPurge: async () => {
                  await Promise.all([
                    purgeSupportIndependentCheckRequests(runtime),
                    createSupportReleaseFollowupCheckCleanup({
                      store: runtime.store,
                      clock: runtime.clock,
                    }).purgeExpired(),
                  ]);
                },
              },
              logger,
              {
                tasks: [cleanup.task],
                ...(cleanup.limiterIndex === undefined
                  ? {}
                  : { limiterIndex: cleanup.limiterIndex }),
              },
            );
          } catch (error) {
            logger.log('error', 'support.maintenance_unavailable', {
              error: error instanceof Error ? error.name : 'unknown',
            });
          }
        })(),
      );
  },
  async queue(batch: MessageBatch<unknown>, env: AppEnv, ctx: ExecutionContext): Promise<void> {
    if (env.SUPPORT_PAID_CONFIGURATION_JSON && !('learning' in options) && !('engineering' in options) && !('engineeringProduction' in options))
      await prepareDefault(env);
    if (batch.queue === SUPPORT_ENGINEERING_QUEUE) {
      const logger = createAppLogger(env, (promise) => ctx.waitUntil(promise));
      if (
        batch.messages.length === 1 &&
        isSupportReleaseFollowupWake(batch.messages[0]!.body)
      ) {
        await consumeSupportReleaseFollowupWake(batch, {
          clock: systemClock,
          logger,
          enabled: () => followupWorkerEnabledFor(env),
          create: () =>
            createSupportHandler(
              env,
              logger,
              humanEngineeringFor(env),
              {},
              followupFor(env),
              engineeringFor(env),
              learningFor(env),
            ).followupDriver,
        });
        return;
      }
      if (batch.messages.length === 1 && isSupportLearningWake(batch.messages[0]!.body)) {
        const selectedLearning = learningFor(env);
        await consumeSupportLearningWake(batch, {
          clock: systemClock, logger,
          enabled: () => learningWorkerEnabled(env, selectedLearning),
          create: () => createSupportHandler(env, logger, humanEngineeringFor(env), {}, followupFor(env),
            engineeringFor(env), selectedLearning).learningDriver,
        });
        return;
      }
      const source = engineeringFor(env);
      const production = createProductionSupportEngineering(source);
      await consumeSupportEngineeringWake(batch, {
        clock: source.clock ?? systemClock, logger,
        enabled: () => production.processing.configuration !== undefined && production.processing.enabled?.() === true,
        create: () => createSupportHandler(env, logger, humanEngineeringFor(env), {}, {}, source, learningFor(env)).engineeringDriver,
      });
      return;
    }
    // The consumer configuration is max_batch_size:1. Refuse accidental other
    // queues and leave durable SDK requests available for rediscovery.
    const reviews = options.learningReviews;
    if (batch.queue !== 'pegma-dev-support-learning-reviews' || reviews === undefined ||
      !learningReviewsEnabled(env, reviews)) {
      for (const message of batch.messages) message.retry({ delaySeconds: 30 });
      return;
    }
    const logger = createAppLogger(env, (promise) => ctx.waitUntil(promise));
    try { await reviews.create(env, logger).queue.consume(batch); }
    catch {
      for (const message of batch.messages) message.retry({ delaySeconds: 30 });
    }
  },
} satisfies ExportedHandler<AppEnv>;
}

// Production supplies only validated operator data and source-owned ports.
export default createWorker();
