import type { EngineeringOptions } from '@pegma/support-desk-application';
import type { Logger } from '@pegma/spine';
import { createAgentPrincipalResolver } from './agent-authority';
import type { SupportRuntime } from './support-desk';
import { createSupportEngineeringDriver } from './support-engineering-driver';
import { composeSupportEngineeringProcessing, type SupportEngineeringProcessingComposition } from './support-engineering-processing';
import type { EngineeringHttpRepository } from './support-engineering-handlers';
import type { SupportEngineeringRouterOptions } from './support-engineering-router';
import { createSupportEngineeringRuntime, supportEngineeringApplicationOptions,
  type SupportEngineeringReviewProofs } from './support-engineering';

/** Trusted human surface only. No model, processing or GitHub mutation ports. */
export interface SupportEngineeringHumanComposition {
  readonly enabled?: () => boolean;
  /** Separate current human review gate, with strict false as the default. */
  readonly reviewEnabled?: () => boolean;
  readonly configuration?: {
    readonly application: EngineeringOptions;
    readonly repositories: readonly EngineeringHttpRepository[];
    /** Explicit current read-only proof ports; absence holds NEW approvals. */
    readonly reviewProofs?: SupportEngineeringReviewProofs;
    readonly discardChecks?: (ticketId: string) => Promise<void>;
  };
}
export function supportEngineeringHumanEnabled(options: SupportEngineeringHumanComposition = {}): boolean {
  if (options.configuration === undefined) return false;
  try { return options.enabled?.() === true; } catch { return false; }
}
/** Called before the existing application factory; omission keeps intake OFF. */
export function supportEngineeringIntakeOptions(options: SupportEngineeringHumanComposition = {}) {
  return supportEngineeringHumanEnabled(options)
    ? supportEngineeringApplicationOptions(options.configuration!.application) : undefined;
}
/** Same real application/Store/Identity/Sessions/RoleStore/limiter as Support. */
export function composeSupportEngineeringHuman(runtime: SupportRuntime, logger: Logger,
  options: SupportEngineeringHumanComposition = {}): SupportEngineeringRouterOptions {
  if (!supportEngineeringHumanEnabled(options)) return {};
  const authority = { identity: runtime.identity, sessions: runtime.sessions,
    identityLinkFromClaims: runtime.identityLinkFromClaims, roleStore: runtime.roleStore, logger };
  const resolve = createAgentPrincipalResolver(authority);
  return { enabled: () => supportEngineeringHumanEnabled(options), configuration: {
    ...authority, readLimiter: runtime.engineeringReadLimiter,
    mutationLimiter: runtime.engineeringMutationLimiter, repositories: options.configuration!.repositories,
    reviewEnabled: () => { try { return options.reviewEnabled?.() === true; } catch { return false; } },
    runtime: () => createSupportEngineeringRuntime({ application: runtime.application,
      clock: runtime.clock, staffAccess: { resolve }, processingEnabled: () => false,
      ...(options.configuration!.reviewProofs === undefined ? {} : { reviewProofs: options.configuration!.reviewProofs }),
      ...(options.configuration!.discardChecks === undefined ? {} : { discardChecks: options.configuration!.discardChecks }),
    }),
  } };
}

/** One driver stage over the same application instance used by normal Support.
 * Admission is current after every driver/SDK await; it supplies no grants. */
export function composeSupportEngineeringDriver(
  runtime: SupportRuntime,
  options: SupportEngineeringProcessingComposition = {},
) {
  const supplied = options.configuration;
  const enabled = () => {
    try {
      return supplied !== undefined && options.configuration === supplied && options.enabled?.() === true;
    } catch { return false; }
  };
  return createSupportEngineeringDriver({
    store: runtime.store,
    clock: runtime.clock,
    isEnabled: enabled,
    runtime: (current) => composeSupportEngineeringProcessing(runtime, {
      ...options,
      enabled: () => current() && enabled(),
    }),
  });
}
