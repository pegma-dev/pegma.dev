import type { Logger } from '@pegma/spine';
import { createAgentPrincipalResolver } from './agent-authority';
import type { SupportRuntime } from './support-desk';
import { createSupportEngineeringRuntime } from './support-engineering';
import {
  createSupportEngineeringModelPorts,
  type SupportEngineeringModelOptions,
} from './support-engineering-model';
import type { SupportEngineeringPorts } from './support-engineering-ports';
import {
  createSupportEngineeringUsage,
  type SupportEngineeringUsagePolicy,
} from './support-engineering-usage';

type RequiredPorts = Pick<
  SupportEngineeringPorts,
  | 'serviceAccess'
  | 'reconciliationAccess'
  | 'routing'
  | 'checks'
  | 'github'
  | 'proposals'
>;
export interface SupportEngineeringProcessingComposition {
  readonly enabled?: () => boolean;
  readonly logger?: Pick<Logger, 'log'>;
  readonly configuration?: {
    readonly model: Omit<SupportEngineeringModelOptions, 'clock' | 'isEnabled'>;
    readonly usagePolicy: SupportEngineeringUsagePolicy;
    /** Same current verifiers must also configure the existing Support application. */
    readonly ports: RequiredPorts;
  };
}

function complete(ports: RequiredPorts): boolean {
  if (!ports) return false;
  return [
    ports.serviceAccess?.resolve,
    ports.reconciliationAccess?.resolve,
    ports.routing?.resolve,
    ports.routing?.check,
    ports.routing?.verify,
    ports.checks?.resolvePolicy,
    ports.checks?.check,
    ports.checks?.verify,
    ports.github?.getMetadata,
    ports.github?.searchDuplicates,
    ports.github?.createIssue,
    ports.github?.reconcile,
    ports.proposals?.duplicateQuery,
    ports.proposals?.prepare,
  ].every((value) => typeof value === 'function');
}

/** Explicit programmatic entrypoint, with no route, timer, grant or activation.
 * Reuses this host's actual application/Store/Identity/RoleStore. Generation and
 * funded usage are source-owned; real routing/check/connector authority remains
 * mandatory and is never synthesized from model output or test approvals.
 */
export function composeSupportEngineeringProcessing(
  runtime: SupportRuntime,
  options: SupportEngineeringProcessingComposition = {},
) {
  const resolve = createAgentPrincipalResolver(runtime);
  const base = {
    application: runtime.application,
    clock: runtime.clock,
    staffAccess: { resolve },
  };
  const supplied = options.configuration;
  if (!supplied) return createSupportEngineeringRuntime(base);
  const enabled = () => {
    try {
      return options.configuration === supplied && options.enabled?.() === true;
    } catch {
      return false;
    }
  };
  let recovery = createSupportEngineeringRuntime(base);
  let stage: 'ports' | 'model' | 'usage' | 'composition' = 'ports';
  const diagnose = (failedStage: typeof stage) => {
    try {
      if (options.logger)
        options.logger.log(
          'error',
          'support.engineering.composition_unavailable',
          { stage: failedStage },
        );
      else
        console.error(
          JSON.stringify({
            event: 'support.engineering.composition_unavailable',
            stage: failedStage,
          }),
        );
    } catch {
      // Diagnostics cannot disable retained read-only recovery.
    }
  };
  try {
    // Reconciliation does not depend on generation, model or funding readiness.
    recovery = createSupportEngineeringRuntime({
      ...base,
      ports: {
        reconciliationAccess: supplied.ports.reconciliationAccess,
        github: supplied.ports.github,
      },
    });
    if (!complete(supplied.ports)) {
      diagnose('ports');
      return recovery;
    }
    const policy = Object.freeze({ ...supplied.usagePolicy });
    stage = 'model';
    const model = createSupportEngineeringModelPorts({
      ...supplied.model,
      clock: runtime.clock,
      isEnabled: enabled,
    });
    stage = 'usage';
    const usage = createSupportEngineeringUsage({
      store: runtime.store,
      clock: runtime.clock,
      policy,
    });
    stage = 'composition';
    const configuration: SupportEngineeringPorts['configuration'] = {
      async resolve(expected, signal) {
        const observed = await model.configuration.resolve(expected, signal);
        if (observed.outcome !== 'ready') return observed;
        const route = model.currentRoute(observed.configuration.version);
        const config = observed.configuration;
        const now = Date.parse(runtime.clock.now());
        if (
          !enabled() ||
          !route ||
          route.usageScopeRef !== policy.scopeRef ||
          config.version !== policy.configurationVersion ||
          config.modelVersion !== policy.modelVersion ||
          config.pricingRef !== policy.pricingRef ||
          config.budgets.currency !== policy.currency ||
          config.budgets.maxCostMicros < 1 ||
          config.budgets.maxCostMicros > policy.maxReservationCostMicros ||
          !(
            Date.parse(policy.validFrom) <= now &&
            now < Date.parse(policy.validUntil)
          )
        )
          return { outcome: 'unavailable' };
        return observed;
      },
    };
    return createSupportEngineeringRuntime({
      ...base,
      processingEnabled: enabled,
      ports: {
        ...supplied.ports,
        configuration,
        model: model.model,
        tokenCounter: model.tokenCounter,
        usage,
      },
    });
  } catch {
    diagnose(stage);
    return recovery;
  }
}
