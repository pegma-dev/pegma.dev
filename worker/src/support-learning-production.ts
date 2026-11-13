import type { Clock } from '@pegma/spine';
import type { Store } from '@pegma/storage-core';
import type {
  ResolutionLearningKey,
  ResolutionLearningOptions,
} from '@pegma/support-desk-application';
import type {
  LearningAttemptContext,
  LearningUsageIdentity,
} from '@pegma/support-desk-ai';
import type { SupportLearningProcessingPorts } from './support-learning-ports';
import { supportLearningApplicationOptions } from './support-learning';
import {
  createSupportLearningModelPorts,
  type SupportLearningModelOptions,
} from './support-learning-model';
import {
  createSupportModelUsageLedger,
  usageInteger,
  usageText,
  type SupportModelUsagePolicy,
} from './support-model-usage-ledger';
import type {
  createSupportIndependentChecks,
  IndependentCheckCapture,
} from './support-independent-checks';

type SharedChecks = Pick<
  ReturnType<typeof createSupportIndependentChecks>,
  | 'learningSdkVerifier'
  | 'learningFor'
  | 'resolvePolicy'
  | 'precomputePending'
  | 'discardTicket'
>;
type SourcePorts = Pick<
  SupportLearningProcessingPorts,
  'serviceAccess' | 'knowledgeAccess' | 'retirementAccess'
>;

/** Source-owned dependencies only. This factory creates no principal, grant,
 * target policy, checker pool, credential, timer or publication authority. */
export interface SupportLearningProductionOptions {
  readonly intakeEnabled?: boolean;
  readonly enabled?: () => boolean;
  readonly configuration?: SourcePorts & {
    readonly application?: Omit<
      ResolutionLearningOptions,
      'enabled' | 'productContext' | 'checks'
    >;
    readonly productContext: NonNullable<
      ResolutionLearningOptions['productContext']
    >;
    readonly targets: SupportLearningProcessingPorts['targets'];
    readonly model: Omit<SupportLearningModelOptions, 'clock' | 'enabled'>;
    readonly usagePolicy: SupportModelUsagePolicy;
    /** One Root-owned shared controller. Lazy only to close the exact-App/KB
     * construction cycle; never a mutable current-ticket or authority cache. */
    readonly readChecks: () => SharedChecks | undefined;
  };
}
export interface SupportLearningProductionComposition {
  readonly application: ResolutionLearningOptions;
  /** Read/retirement authority is independent of model readiness and funding. */
  readonly sourcePorts?: SourcePorts;
  processingEnabled(): boolean;
  /** Bind once to the same physical root Store and Clock. No application proxy. */
  attachRuntime(runtime: {
    readonly store: Store;
    readonly clock: Clock;
  }): boolean;
  /** The caller supplies an actual known work key, never a hash-derived scope. */
  createProcessingPorts(
    key: ResolutionLearningKey,
    capture?: IndependentCheckCapture,
  ): SupportLearningProcessingPorts | undefined;
  readonly precomputePending: SharedChecks['precomputePending'];
  discardChecks(ticketId: string): Promise<number>;
}

export function createProductionSupportLearning(
  options: SupportLearningProductionOptions = {},
): SupportLearningProductionComposition {
  const off = (): SupportLearningProductionComposition =>
    Object.freeze({
      application: supportLearningApplicationOptions(),
      processingEnabled: () => false,
      attachRuntime: () => false,
      createProcessingPorts: () => undefined,
      precomputePending: async () => ({ outcome: 'held' as const }),
      discardChecks: async () => 0,
    });
  const candidate = options.configuration;
  if (candidate === undefined) return off();
  const supplied = candidate;
  try {
    if (
      ![
        supplied.productContext?.resolve,
        supplied.serviceAccess?.resolve,
        supplied.knowledgeAccess?.resolve,
        supplied.retirementAccess?.resolve,
        supplied.targets?.resolveScope,
        supplied.targets?.select,
        supplied.readChecks,
        supplied.model?.readRoute,
        supplied.model?.counter?.count,
        supplied.model?.readApiKey,
      ].every((value) => typeof value === 'function') ||
      !supplied.usagePolicy ||
      !Array.isArray(supplied.model.allowlist) ||
      supplied.model.allowlist.length === 0
    )
      return off();
    const sourcePorts: SourcePorts = Object.freeze({
      serviceAccess: supplied.serviceAccess,
      knowledgeAccess: supplied.knowledgeAccess,
      retirementAccess: supplied.retirementAccess,
    });
    const policy = structuredClone(supplied.usagePolicy);
    let attached = false;
    let clock: Clock | undefined;
    let model: ReturnType<typeof createSupportLearningModelPorts> | undefined;
    let usage: SupportLearningProcessingPorts['usage'] | undefined;
    function checks(): SharedChecks | undefined {
      try {
        const current = supplied.readChecks();
        return current &&
          [
            current.learningSdkVerifier?.verify,
            current.learningFor,
            current.resolvePolicy,
            current.precomputePending,
            current.discardTicket,
          ].every((value) => typeof value === 'function')
          ? current
          : undefined;
      } catch {
        return undefined;
      }
    }
    function processingEnabled(): boolean {
      try {
        return (
          options.configuration === supplied &&
          options.enabled?.() === true &&
          model !== undefined &&
          usage !== undefined &&
          checks() !== undefined
        );
      } catch {
        return false;
      }
    }
    const composition: SupportLearningProductionComposition = {
      application: supportLearningApplicationOptions({
        ...supplied.application,
        enabled: options.intakeEnabled === true,
        productContext: supplied.productContext,
        checks: {
          verify: (...args) =>
            checks()?.learningSdkVerifier.verify(...args) ??
            Promise.resolve(null),
        },
      }),
      sourcePorts,
      processingEnabled,
      attachRuntime(runtime) {
        if (attached) return false;
        attached = true;
        try {
          clock = runtime.clock;
          model = createSupportLearningModelPorts({
            ...supplied.model,
            clock: runtime.clock,
            enabled: processingEnabled,
          });
          usage = createSupportModelUsageLedger<
            LearningAttemptContext,
            LearningUsageIdentity
          >(
            { store: runtime.store, clock: runtime.clock, policy },
            {
              purpose: 'support_learning',
              collection: 'pegma.support-learning-usage.v1',
              key: { partition: 'support_learning', id: 'budget' },
              identity(input) {
                if (input.purpose !== 'support_learning')
                  throw new TypeError('Wrong learning usage purpose');
                return input;
              },
              binding(context) {
                const b = context.budgets;
                return JSON.stringify([
                  context.purpose,
                  usageText(context.invocationId),
                  usageInteger(context.attempt, 1),
                  usageText(context.inputManifestHash),
                  usageText(context.configurationVersion),
                  usageText(context.promptVersion),
                  usageText(context.modelVersion),
                  usageText(context.checkPolicyVersion),
                  usageText(context.authorityVersion),
                  usageText(context.usageScopeRef),
                  context.deadline,
                  context.fence,
                  context.sourceFence,
                  usageInteger(b.maxCostMicros, 1),
                  b.currency,
                  usageInteger(b.maxMessages, 1),
                  usageInteger(b.maxInputBytes, 1),
                  usageInteger(b.maxInputTokens, 1),
                  usageInteger(b.maxContextTokens, 1),
                  usageInteger(b.maxOutputBytes, 1),
                  usageInteger(b.maxOutputTokens, 1),
                  usageInteger(b.maxCandidateBytes, 1),
                  usageInteger(b.maxDurationMilliseconds, 1),
                  usageInteger(b.maxAttempts, 1),
                ]);
              },
            },
          );
          return true;
        } catch {
          model = undefined;
          usage = undefined;
          return false;
        }
      },
      createProcessingPorts(key, capture = {}) {
        try {
          if (
            !model ||
            !usage ||
            !key ||
            typeof key.ticketId !== 'string' ||
            key.ticketId.length < 1 ||
            key.ticketId.length > 200 ||
            /[\u0000-\u001f\u007f]/u.test(key.ticketId) ||
            !Number.isSafeInteger(key.sourceGeneration) ||
            key.sourceGeneration < 1
          )
            return undefined;
          const controller = checks();
          if (!controller) return undefined;
          const scoped = controller.learningFor(
            Object.freeze({
              ticketId: key.ticketId,
              sourceGeneration: key.sourceGeneration,
            }),
            capture,
          );
          const selectedModel = model;
          const configuration: SupportLearningProcessingPorts['configuration'] =
            {
              async resolve(expected, signal) {
                const result = await selectedModel.configuration.resolve(
                  expected,
                  signal,
                );
                if (result.outcome !== 'ready') return result;
                const route = selectedModel.currentRoute(
                  result.configuration.version,
                );
                const c = result.configuration;
                const now = Date.parse(clock?.now() ?? '');
                if (
                  !processingEnabled() ||
                  !route ||
                  route.usageScopeRef !== policy.scopeRef ||
                  c.version !== policy.configurationVersion ||
                  c.modelVersion !== policy.modelVersion ||
                  c.pricingRef !== policy.pricingRef ||
                  c.budgets.currency !== policy.currency ||
                  c.budgets.maxCostMicros > policy.maxReservationCostMicros ||
                  !(
                    Date.parse(policy.validFrom) <= now &&
                    now < Date.parse(policy.validUntil)
                  )
                )
                  return { outcome: 'unavailable' };
                return result;
              },
            };
          return Object.freeze({
            ...sourcePorts,
            targets: supplied.targets,
            checks: scoped,
            configuration,
            model: selectedModel.model,
            tokenCounter: selectedModel.tokenCounter,
            usage,
          });
        } catch {
          return undefined;
        }
      },
      precomputePending: (...args) =>
        checks()?.precomputePending(...args) ??
        Promise.resolve({ outcome: 'held' as const }),
      discardChecks: (ticketId) =>
        checks()?.discardTicket('learning', ticketId) ?? Promise.resolve(0),
    };
    return Object.freeze(composition);
  } catch {
    return off();
  }
}
