import type { Store } from '@pegma/storage-core';
import {
  isReconciliationStale,
  readReleaseOpsState,
} from './release-ops-state';
import { countCurrentReleases } from './release-reconciliation';
import {
  readGitHubReleaseWebhookConfig,
  type GitHubReleaseWebhookEnv,
} from './github-release-webhook';
import { readReleasesConfig } from './releases-api';

/** Public-safe health detail for the release ingestion surface. */
export interface ReleaseHealthDetail {
  readonly ingestionConfigured: boolean;
  readonly readConfigured: boolean;
  readonly lastSuccessfulWebhookAt: string | null;
  readonly lastSuccessfulReconciliationAt: string | null;
  readonly reconciliationStale: boolean;
  readonly currentReleaseCount: number;
}

export async function loadReleaseHealthDetail(
  store: Store,
  env: GitHubReleaseWebhookEnv,
  nowMs: number = Date.now(),
): Promise<ReleaseHealthDetail> {
  const ops = await readReleaseOpsState(store);
  return {
    ingestionConfigured: Boolean(readGitHubReleaseWebhookConfig(env)),
    readConfigured: Boolean(readReleasesConfig(env)),
    lastSuccessfulWebhookAt: ops.lastSuccessfulWebhookAt,
    lastSuccessfulReconciliationAt: ops.lastSuccessfulReconciliationAt,
    reconciliationStale: isReconciliationStale(
      ops.lastSuccessfulReconciliationAt,
      nowMs,
    ),
    currentReleaseCount: await countCurrentReleases(store),
  };
}
