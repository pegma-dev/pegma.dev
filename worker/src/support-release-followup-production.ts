import {
  createSupportReleaseFollowupChecks,
  createSupportReleaseFollowupModel,
  type SupportReleaseFollowupChecksOptions,
  type SupportReleaseFollowupModelOptions,
  type SupportModelUsagePolicy,
} from '@pegma/support-desk-ai/openrouter';
import type {
  LearningKnowledgeAccessPort,
  LearningServiceAccessPort,
} from '@pegma/support-desk-ai';
import type { Store } from '@pegma/storage-core';
import type { KnowledgeBaseApplication } from '@pegma/knowledge-base-application';
import type { SupportRuntime } from './support-desk';
import type { SupportReleaseFollowupConfiguration } from './support-release-followup-ports';

/** One immutable current operator selection; no App, Store or credentials are
 * constructed here until the real Root binds its final instances. */
export interface SupportReleaseFollowupPaidOptions {
  readonly current: () => boolean;
  readonly generator: SupportReleaseFollowupModelOptions;
  readonly serviceAccess: LearningServiceAccessPort;
  readonly knowledgeAccess: LearningKnowledgeAccessPort;
  readonly usagePolicy: SupportModelUsagePolicy;
  readonly checks: Omit<
    SupportReleaseFollowupChecksOptions,
    | 'store'
    | 'application'
    | 'releaseEvidence'
    | 'knowledge'
    | 'knowledgeAccess'
  >;
  readonly target:
    | { readonly kind: 'none' }
    | { readonly kind: 'article'; readonly articleId: string };
}

/** The optional shared adapters retain their own route/evaluation/privacy/key
 * validators and the existing global independent-check funding pool. */
export function bindSupportReleaseFollowupPaid(options: {
  readonly paid: SupportReleaseFollowupPaidOptions;
  readonly store: Store;
  readonly application: () => SupportRuntime['application'];
  readonly knowledge: () =>
    | Pick<KnowledgeBaseApplication, 'getDraft' | 'getValidationRequirements'>
    | undefined;
  readonly source: SupportReleaseFollowupConfiguration;
}): SupportReleaseFollowupConfiguration {
  const paid = options.paid;
  const actualKnowledge = () => {
    const application = options.knowledge();
    if (!application || !paid.current())
      throw new Error('Follow-up knowledge unavailable');
    return application;
  };
  const reads: NonNullable<SupportReleaseFollowupChecksOptions['knowledge']> = {
    getDraft(...args) {
      return actualKnowledge().getDraft(...args);
    },
    getValidationRequirements(...args) {
      return actualKnowledge().getValidationRequirements(...args);
    },
  };
  const checks = createSupportReleaseFollowupChecks(
    {
      store: options.store,
      application: options.application,
      clock: paid.checks.clock,
      authority: paid.checks.authority,
      enabled: () => paid.current() && paid.checks.enabled?.() === true,
      readRoute: () => paid.checks.readRoute?.(),
      allowlist: paid.checks.allowlist,
      counter: paid.checks.counter,
      readApiKey: (reference) => paid.checks.readApiKey?.(reference),
      fetch: (url, init) =>
        paid.checks.fetch === undefined
          ? globalThis.fetch(url, init)
          : paid.checks.fetch(url, init),
      usagePolicy: paid.checks.usagePolicy,
      readReceiptKey: () => paid.checks.readReceiptKey?.() ?? null,
      deferred: true,
      releaseEvidence: options.source.releaseEvidence,
      knowledge: reads,
      knowledgeAccess: paid.knowledgeAccess,
    },
    'pegma.dev',
  );
  const model = createSupportReleaseFollowupModel(paid.generator, 'pegma.dev');
  return Object.freeze({
    ...options.source,
    invocationMode: 'staged',
    deferredChecks: checks,
    checks: {
      resolvePolicy: checks.resolvePolicy,
      async check() {
        return { outcome: 'held' as const };
      },
      verify: checks.sdkVerifier.verify,
    },
    checksFor: checks.forWork,
    reassessmentChecksFor: checks.forReassessment,
    reassessmentUsageScopeRef: paid.checks.usagePolicy?.scopeRef,
    targets: {
      async resolve(
        _input: Parameters<
          SupportReleaseFollowupConfiguration['targets']['resolve']
        >[0],
        context: Parameters<
          SupportReleaseFollowupConfiguration['targets']['resolve']
        >[1],
      ) {
        return !paid.current() || context.signal.aborted
          ? { kind: 'unavailable' as const }
          : paid.target;
      },
    },
    knowledge: reads,
    knowledgeAccess: paid.knowledgeAccess,
    generation: {
      serviceAccess: paid.serviceAccess,
      configuration: model.configuration,
      evaluations: model.evaluations,
      model: model.model,
      tokenCounter: model.tokenCounter,
      usagePolicy: paid.usagePolicy,
    },
  });
}
