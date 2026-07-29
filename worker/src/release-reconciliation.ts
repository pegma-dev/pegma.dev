import type { Store } from '@pegma/storage-core';
import type { Logger } from '@pegma/spine';
import {
  componentReleaseCollection,
  componentReleaseKey,
} from './component-release';
import {
  allowedReleaseCatalog,
  type ReleaseCatalogEntry,
} from './release-catalog';
import {
  markReleaseReconciliationSuccess,
  readReleaseOpsState,
  saveReleaseRepositoryEtags,
} from './release-ops-state';
import {
  applyAuthoritativeCurrentRelease,
  buildPegmaReleaseUrl,
  touchCurrentReleaseObservedAt,
  type ReleaseEventFacts,
} from './release-projection';
import type { ComponentRelease } from './component-release';

/** Cron expression for six-hour release reconciliation (not identity). */
export const RELEASE_RECONCILIATION_CRON = '0 */6 * * *';

const GITHUB_API = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const USER_AGENT = 'pegma-dev-release-reconciliation';

export interface ReleaseReconciliationConfig {
  readonly allowedRepositoryIds: ReadonlySet<string>;
}

export interface ReleaseReconciliationSummary {
  readonly examined: number;
  readonly upserted: number;
  readonly cleared: number;
  readonly notModified: number;
  readonly failed: number;
}

export interface RunReleaseReconciliationOptions {
  readonly store: Store;
  readonly logger: Logger;
  readonly config: ReleaseReconciliationConfig;
  readonly now?: string;
  readonly fetchImpl?: typeof fetch;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value) && value !== '0') {
    return value;
  }
  return null;
}

/**
 * Map a GitHub /releases/latest JSON body into projection facts.
 * Does not trust html_url from the payload.
 */
export function githubLatestToFacts(
  entry: ReleaseCatalogEntry,
  payload: unknown,
): ReleaseEventFacts | null {
  const root = asRecord(payload);
  if (root === null) {
    return null;
  }
  const releaseId = asId(root['id']);
  if (
    releaseId === null ||
    typeof root['tag_name'] !== 'string' ||
    typeof root['published_at'] !== 'string' ||
    typeof root['draft'] !== 'boolean' ||
    typeof root['prerelease'] !== 'boolean'
  ) {
    return null;
  }
  if (root['draft'] || root['prerelease']) {
    return null;
  }
  // Prefer nested repository.id when GitHub includes it; otherwise trust the
  // ID-addressed request URL and stamp the catalog id.
  const nestedRepository = asRecord(root['repository']);
  const nestedId =
    nestedRepository === null ? null : asId(nestedRepository['id']);
  if (nestedId !== null && nestedId !== entry.repositoryId) {
    return null;
  }
  return {
    action: 'published',
    repositoryId: entry.repositoryId,
    repositoryName: entry.repositoryName,
    releaseId,
    tagName: root['tag_name'],
    publishedAt: root['published_at'],
    draft: false,
    prerelease: false,
  };
}

async function readBoundedJson(
  response: Response,
): Promise<
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: 'too_large' | 'invalid_json' }
> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared)) {
    if (Number(declared) > MAX_RESPONSE_BYTES) {
      return { ok: false, reason: 'too_large' };
    }
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return { ok: true, value: null };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value === undefined) {
      continue;
    }
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // Size rejection is authoritative.
      }
      return { ok: false, reason: 'too_large' };
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(body)) };
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
}

async function clearCurrentRelease(
  store: Store,
  repositoryId: string,
): Promise<boolean> {
  const releases = store.collection(componentReleaseCollection());
  const key = componentReleaseKey(repositoryId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await releases.getVersioned(key);
    if (current === null) {
      return false;
    }
    if (await releases.deleteIfUnchanged(key, current.version)) {
      return true;
    }
  }
  throw new Error('Release clear conflicted repeatedly.');
}

async function reconcileOneRepository(
  options: {
    readonly store: Store;
    readonly entry: ReleaseCatalogEntry;
    readonly etag: string | undefined;
    readonly observedAt: string;
    readonly fetchImpl: typeof fetch;
  },
): Promise<{
  readonly outcome: 'upserted' | 'cleared' | 'not_modified' | 'unchanged' | 'failed';
  readonly etag: string | undefined;
}> {
  const { store, entry, observedAt, fetchImpl } = options;
  // Fetch by stable numeric repository ID so a rename/recreate cannot attach
  // another repo's release under this catalog slot.
  const url = `${GITHUB_API}/repositories/${entry.repositoryId}/releases/latest`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (options.etag !== undefined) {
    headers['If-None-Match'] = options.etag;
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { outcome: 'failed', etag: options.etag };
  }

  if (response.status === 304) {
    await touchCurrentReleaseObservedAt(store, entry.repositoryId, observedAt);
    return { outcome: 'not_modified', etag: options.etag };
  }

  const nextEtag = response.headers.get('etag') ?? undefined;

  if (response.status === 404) {
    const cleared = await clearCurrentRelease(store, entry.repositoryId);
    return {
      outcome: cleared ? 'cleared' : 'unchanged',
      etag: undefined,
    };
  }

  if (response.status < 200 || response.status >= 300) {
    return { outcome: 'failed', etag: options.etag };
  }

  const parsed = await readBoundedJson(response);
  if (!parsed.ok) {
    return { outcome: 'failed', etag: options.etag };
  }

  const facts = githubLatestToFacts(entry, parsed.value);
  if (facts === null) {
    // 2xx with an unusable body is not proof that no stable release exists
    // (unlike 404). Fail closed so we do not clear good local state.
    return { outcome: 'failed', etag: options.etag };
  }
  // Catalog repositoryId is the authority; name is display-only.
  if (facts.repositoryId !== entry.repositoryId) {
    return { outcome: 'failed', etag: options.etag };
  }

  const releaseUrl = buildPegmaReleaseUrl(facts.repositoryName, facts.tagName);
  if (releaseUrl === null) {
    return { outcome: 'failed', etag: options.etag };
  }

  const release: ComponentRelease = {
    repositoryId: facts.repositoryId,
    repositoryName: facts.repositoryName,
    releaseId: facts.releaseId,
    tagName: facts.tagName,
    publishedAt: facts.publishedAt,
    releaseUrl,
    observedAt,
  };
  // Authoritative path: GitHub's current stable wins even when older than a
  // local row left behind by a missed delete/unpublish webhook.
  const wrote = await applyAuthoritativeCurrentRelease(store, release);
  return {
    outcome: wrote === 'written' ? 'upserted' : 'unchanged',
    etag: nextEtag,
  };
}

/**
 * Authoritative sync of current stable releases from GitHub's public API.
 * Also serves as initial backfill when the catalog is empty.
 * Does not fabricate Webhooks receipt rows.
 */
export async function runReleaseReconciliation(
  options: RunReleaseReconciliationOptions,
): Promise<ReleaseReconciliationSummary> {
  const { store, logger, config } = options;
  const observedAt = options.now ?? new Date().toISOString();
  const fetchImpl = options.fetchImpl ?? fetch;
  const catalog = allowedReleaseCatalog(config.allowedRepositoryIds);
  const prior = await readReleaseOpsState(store);
  const nextEtags: Record<string, string> = { ...prior.repositoryEtags };

  let examined = 0;
  let upserted = 0;
  let cleared = 0;
  let notModified = 0;
  let failed = 0;

  for (const entry of catalog) {
    examined += 1;
    let result: {
      readonly outcome:
        | 'upserted'
        | 'cleared'
        | 'not_modified'
        | 'unchanged'
        | 'failed';
      readonly etag: string | undefined;
    };
    try {
      result = await reconcileOneRepository({
        store,
        entry,
        etag: nextEtags[entry.repositoryId],
        observedAt,
        fetchImpl,
      });
    } catch {
      // Version conflicts and unexpected store errors stay per-repository so
      // one hot key cannot abort the catalog pass or skip etag persistence.
      result = { outcome: 'failed', etag: nextEtags[entry.repositoryId] };
    }

    if (result.etag === undefined) {
      delete nextEtags[entry.repositoryId];
    } else {
      nextEtags[entry.repositoryId] = result.etag;
    }

    switch (result.outcome) {
      case 'upserted':
        upserted += 1;
        break;
      case 'cleared':
        cleared += 1;
        break;
      case 'not_modified':
        notModified += 1;
        break;
      case 'failed':
        failed += 1;
        break;
      default:
        break;
    }
  }

  const summary: ReleaseReconciliationSummary = {
    examined,
    upserted,
    cleared,
    notModified,
    failed,
  };

  // Persist success only when every repository completed without failure so
  // health "stale" stays honest. Always advance etags for successful repos.
  if (summary.failed === 0) {
    await markReleaseReconciliationSuccess(store, observedAt, nextEtags);
    logger.log('info', 'release_reconciliation.completed', {
      examined: summary.examined,
      upserted: summary.upserted,
      cleared: summary.cleared,
      notModified: summary.notModified,
    });
  } else {
    await saveReleaseRepositoryEtags(store, nextEtags);
    logger.log('error', 'release_reconciliation.partial_failure', {
      examined: summary.examined,
      upserted: summary.upserted,
      cleared: summary.cleared,
      notModified: summary.notModified,
      failed: summary.failed,
    });
  }

  return summary;
}

/** Count current release summaries in D1 (for health detail). */
export async function countCurrentReleases(store: Store): Promise<number> {
  const releases = store.collection(componentReleaseCollection());
  const rows = await releases.list('current');
  return rows.length;
}

/** Backfill is the same path as reconciliation (no receipt rows). */
export async function backfillReleases(
  options: RunReleaseReconciliationOptions,
): Promise<ReleaseReconciliationSummary> {
  return runReleaseReconciliation(options);
}
