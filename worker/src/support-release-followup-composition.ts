import type { Logger } from '@pegma/spine';
import type { SupportRuntime } from './support-desk';
import { createSupportReleaseFollowupRuntime } from './support-release-followup';
import {
  supportReleaseFollowupEnabled,
  type SupportReleaseFollowupComposition,
} from './support-release-followup-ports';
import type { SupportReleaseFollowupHandlerOptions } from './support-release-followup-handlers';

export function composeSupportReleaseFollowup(
  runtime: SupportRuntime,
  logger: Logger,
  composition: SupportReleaseFollowupComposition = {},
): SupportReleaseFollowupHandlerOptions | undefined {
  if (!supportReleaseFollowupEnabled(composition)) return undefined;
  const enabled = () => supportReleaseFollowupEnabled(composition);
  return {
    identity: runtime.identity,
    sessions: runtime.sessions,
    roleStore: runtime.roleStore,
    identityLinkFromClaims: runtime.identityLinkFromClaims,
    logger,
    enabled,
    readLimiter: runtime.engineeringReadLimiter,
    mutationLimiter: runtime.engineeringMutationLimiter,
    ...(composition.mappings === undefined ? {} : { mappings: composition.mappings }),
    ...(composition.retests === undefined ? {} : { retests: composition.retests }),
    runtime: () =>
      createSupportReleaseFollowupRuntime({
        application: runtime.application,
        store: runtime.store,
        clock: runtime.clock,
        configuration: composition.configuration!,
        enabled,
      }),
  };
}
