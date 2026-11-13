import { resolveAccess, type AccessContext } from '@pegma/authorization-core';
import { knowledgePermissions } from '@pegma/knowledge-base-contracts';
import type { Clock } from '@pegma/spine';
import type { Store } from '@pegma/storage-core';
import type { KnowledgeBaseApplication } from '@pegma/knowledge-base-application';
import type { SupportRuntime } from './support-desk';
import { parseAllowedRepositoryIds } from './github-release-webhook';
import { createSupportFollowupMappings } from './support-release-followup-mapping';
import type { SupportReleaseFollowupComposition } from './support-release-followup-ports';
import {
  createSupportFollowupRetests,
  type SupportFollowupRetestOptions,
} from './support-release-followup-retests';
import {
  bindSupportReleaseFollowupPaid,
  type SupportReleaseFollowupPaidOptions,
} from './support-release-followup-production';
import {
  readSupportLearningSourceConfiguration,
  SUPPORT_LEARNING_GOVERNANCE_READER,
  type SupportLearningSourceEnvironment,
} from './support-learning-bootstrap';
import { knowledgeDigest } from './knowledge-evidence';

export interface SupportReleaseFollowupEnvironment extends SupportLearningSourceEnvironment {
  readonly PEGMA_SUPPORT_RELEASE_FOLLOWUP_ENABLED?: string;
  readonly PEGMA_SUPPORT_RELEASE_FOLLOWUP_PROCESSING_ENABLED?: string;
  readonly GITHUB_ALLOWED_REPOSITORY_IDS?: string;
}

/** Reuses the existing intrinsic read ceiling and explicit Source collection
 * scope. Retest association requires valid Source testEvidence configuration
 * and the article collection in collectionIds, independently of intake/model
 * flags. Missing scoped governance is reported as retest unavailable (503). */
export function createSupportFollowupGovernanceAccess(
  env: SupportReleaseFollowupEnvironment,
) {
  const raw = env.SUPPORT_LEARNING_SOURCE_CONFIGURATION_JSON;
  const configuration = readSupportLearningSourceConfiguration(raw);
  if (configuration?.testEvidence === undefined) return undefined;
  return Object.freeze({
    async resolve(collectionId: string, signal: AbortSignal) {
      const current = () =>
        !signal.aborted &&
        supportReleaseFollowupSourceEnabled(env) &&
        env.PEGMA_KNOWLEDGE_ENABLED === 'true' &&
        env.SUPPORT_LEARNING_SOURCE_CONFIGURATION_JSON === raw &&
        configuration.collectionIds.includes(collectionId);
      if (!current()) return null;
      const authorityVersion =
        'pg-followup-governance/' +
        (await knowledgeDigest([configuration, collectionId]));
      if (!current()) return null;
      return {
        access: resolveAccess(
          { principalId: SUPPORT_LEARNING_GOVERNANCE_READER },
          {
            version: 'pg-learning-governance-reader-v1',
            defaults: [knowledgePermissions.validationManage],
          },
        ),
        authorityVersion,
      };
    },
  });
}

export function supportReleaseFollowupSourceEnabled(
  env: SupportReleaseFollowupEnvironment,
) {
  return env.PEGMA_SUPPORT_RELEASE_FOLLOWUP_ENABLED === 'true';
}

/** Staff verification uses the real App and release projection. Missing paid
 * or retest capabilities remain unavailable, independently of Source intake. */
export function createSupportReleaseFollowupBootstrap(options: {
  readonly environment: SupportReleaseFollowupEnvironment;
  readonly store: Store;
  readonly clock: Clock;
  readonly application: () => SupportRuntime['application'];
  readonly resolvePrincipal: (id: string) => Promise<AccessContext | null>;
  readonly knowledge: () => KnowledgeBaseApplication | undefined;
  readonly reports: SupportFollowupRetestOptions['reports'];
  readonly readGovernance: SupportFollowupRetestOptions['readGovernance'];
  readonly stagedRetestPreparation?: boolean;
  readonly paid?: SupportReleaseFollowupPaidOptions;
}): SupportReleaseFollowupComposition | undefined {
  if (!supportReleaseFollowupSourceEnabled(options.environment))
    return undefined;
  const enabled = () =>
    supportReleaseFollowupSourceEnabled(options.environment);
  const mappings = createSupportFollowupMappings({
    store: options.store,
    clock: options.clock,
    application: options.application,
    resolvePrincipal: options.resolvePrincipal,
    enabled,
    allowedRepositoryIds: () =>
      parseAllowedRepositoryIds(
        options.environment.GITHUB_ALLOWED_REPOSITORY_IDS,
      ),
  });
  const retests = createSupportFollowupRetests({
    stagedPreparation: options.stagedRetestPreparation !== false,
    store: options.store,
    clock: options.clock,
    enabled,
    application: options.application,
    knowledge: options.knowledge,
    reports: options.reports,
    resolvePrincipal: options.resolvePrincipal,
    readGovernance: options.readGovernance,
  });
  const source = {
    enabled,
    mappings,
    retests,
    configuration: {
      releaseEvidence: mappings.releaseEvidence,
      checks: {
        async resolvePolicy() {
          return { outcome: 'unavailable' as const };
        },
        async check() {
          return { outcome: 'held' as const };
        },
        async verify() {
          return null;
        },
      },
      targets: {
        async resolve() {
          return { kind: 'none' as const };
        },
      },
      retestReceipts: retests.verifier,
    },
  };
  if (options.paid !== undefined) {
    try {
      return Object.freeze({
        ...source,
        configuration: bindSupportReleaseFollowupPaid({
          paid: options.paid,
          store: options.store,
          application: options.application,
          knowledge: options.knowledge,
          source: source.configuration,
        }),
      });
    } catch {
      /* Optional paid failure preserves real staff Source actions. */
    }
  }
  return Object.freeze(source);
}
