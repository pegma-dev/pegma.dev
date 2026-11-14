import type { Store } from '@pegma/storage-core';
import { systemClock, type Clock, type Logger } from '@pegma/spine';
import {
  ReleaseCatalogAuthenticationUnavailable,
  readCatalogAuthenticationJson,
  releaseRateHints,
  type ReleaseCatalogAuthentication,
  type ReleaseCatalogCredential,
} from './release-catalog-auth';
import { componentReleaseStateCollection } from './component-release';
import {
  allowedReleaseCatalog,
  type ReleaseCatalogEntry,
} from './release-catalog';
import {
  mergeReleaseRepositoryEtagUpdates,
  readReleaseOpsState,
  type ConditionalEtagUpdate,
} from './release-ops-state';
import {
  applyAuthoritativeCurrentRelease,
  clearCurrentRelease,
  buildPegmaReleaseUrl,
  touchCurrentReleaseObservedAt,
  type ReleaseEventFacts,
} from './release-projection';
import type { ComponentRelease } from './component-release';

/** One repository per minute during each six-hour reconciliation window. */
export const RELEASE_RECONCILIATION_CRON = '0-59 */6 * * *';

const GITHUB_API = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const USER_AGENT = 'pegma-dev-release-reconciliation';
// Scheduled invocations examine one repository; only explicit full passes can
// truncate details, with the omitted count retained in the same summary.
const MAX_FAILURE_DETAILS = 4;

/** Existing summary only: finite public metadata, never error/body/header text.
 * bodyBytes saturates at MAX_RESPONSE_BYTES + 1; source distinguishes a
 * declared oversized length from actual bytes consumed from the stream. */
interface ReleaseFailureDetail {
  readonly repositoryId: string;
  phase: 'authentication' | 'repository' | 'fetch' | 'status' | 'body' | 'facts' | 'url' | 'projection';
  failureClass:
    | 'operation_rejected'
    | 'fetch_rejected'
    | 'http_status'
    | 'too_large'
    | 'invalid_json'
    | 'invalid_release'
    | 'unsafe_release_url';
  rateLimitRemaining?: number | null;
  retryAfterSeconds?: number | null;
  httpStatus?: number;
  bodyBytes?: number;
  bodyBytesSource?: 'declared' | 'streamed';
}

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
  readonly followupTracking?: () => boolean;
  readonly store: Store;
  readonly logger: Logger;
  readonly config: ReleaseReconciliationConfig;
  readonly now?: string;
  readonly fetchImpl?: typeof fetch;
  readonly authentication?: ReleaseCatalogAuthentication;
  readonly clock?: Clock;
  /** Cron timestamp selects one catalog slot; omit for explicit full backfill. */
  readonly scheduledTime?: number;
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
  failure: ReleaseFailureDetail,
): Promise<
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: 'too_large' | 'invalid_json' }
> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared)) {
    if (Number(declared) > MAX_RESPONSE_BYTES) {
      failure.bodyBytes = MAX_RESPONSE_BYTES + 1;
      failure.bodyBytesSource = 'declared';
      return { ok: false, reason: 'too_large' };
    }
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return { ok: true, value: null };
  }
  failure.bodyBytes = 0;
  failure.bodyBytesSource = 'streamed';
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
    failure.bodyBytes = Math.min(total, MAX_RESPONSE_BYTES + 1);
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

interface ReconcileOneOptions {
  readonly store: Store;
  readonly entry: ReleaseCatalogEntry;
  readonly etag: string | undefined;
  readonly observedAt: string;
  readonly fetchImpl: typeof fetch;
  readonly failure: ReleaseFailureDetail;
  readonly authentication?: ReleaseCatalogAuthentication;
  readonly clock: Clock;
}

async function reconcileOneRepositoryRequest(options: ReconcileOneOptions & {
  readonly signal: AbortSignal;
  readonly credential?: ReleaseCatalogCredential;
  readonly assertCurrent: () => void;
}): Promise<{
  readonly outcome:
    'upserted' | 'cleared' | 'not_modified' | 'unchanged' | 'failed';
  readonly etag: string | undefined;
}> {
  const { store, entry, observedAt, fetchImpl, failure } = options;
  const { credential, signal, assertCurrent } = options;
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
  if (credential) headers.Authorization = 'Bearer ' + credential.token;
  async function verifyPublicRepository() {
    if (!credential) return;
    failure.phase = 'repository';
    const metadataUrl = `${GITHUB_API}/repositories/${entry.repositoryId}`;
    assertCurrent();
    const metadata = await fetchImpl(metadataUrl, {
      method: 'GET', redirect: 'error', signal,
      headers: { Accept: headers.Accept!, 'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': headers['X-GitHub-Api-Version']!, Authorization: headers.Authorization! },
    });
    assertCurrent();
    if (metadata.status !== 200) throw new ReleaseCatalogAuthenticationUnavailable({
      httpStatus: metadata.status, ...releaseRateHints(metadata),
    });
    if (metadata.redirected || (metadata.url !== '' && metadata.url !== metadataUrl))
      throw new ReleaseCatalogAuthenticationUnavailable();
    const value = asRecord(await readCatalogAuthenticationJson(metadata, signal));
    assertCurrent();
    const owner = asRecord(value?.owner);
    if (value === null || asId(value.id) !== entry.repositoryId || value.private !== false ||
        value.visibility !== 'public' || owner?.type !== 'Organization' ||
        owner.login !== 'pegma-dev' || asId(owner.id) !== credential.organizationId)
      throw new ReleaseCatalogAuthenticationUnavailable();
  }

  let response: Response;
  try {
    assertCurrent();
    response = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal,
      ...(credential ? { redirect: 'error' as const } : {}),
    });
    assertCurrent();
  } catch (error) {
    if (error instanceof ReleaseCatalogAuthenticationUnavailable) throw error;
    failure.failureClass = 'fetch_rejected';
    return { outcome: 'failed', etag: options.etag };
  }
  if (credential && (response.redirected || (response.url !== '' && response.url !== url)))
    throw new ReleaseCatalogAuthenticationUnavailable();

  failure.phase = 'status';
  failure.httpStatus = response.status;
  if (response.status === 304) {
    await verifyPublicRepository();
    assertCurrent();
    failure.phase = 'projection';
    await touchCurrentReleaseObservedAt(store, entry.repositoryId, observedAt);
    return { outcome: 'not_modified', etag: options.etag };
  }

  const nextEtag = response.headers.get('etag') ?? undefined;

  if (response.status === 404) {
    await verifyPublicRepository();
    assertCurrent();
    failure.phase = 'projection';
    const cleared = await clearCurrentRelease(store, entry.repositoryId);
    return {
      outcome: cleared ? 'cleared' : 'unchanged',
      etag: undefined,
    };
  }

  if (response.status < 200 || response.status >= 300) {
    if (response.status === 403 || response.status === 429)
      Object.assign(failure, releaseRateHints(response));
    failure.failureClass = 'http_status';
    return { outcome: 'failed', etag: options.etag };
  }

  failure.phase = 'body';
  const parsed = await readBoundedJson(response, failure);
  assertCurrent();
  if (!parsed.ok) {
    failure.failureClass = parsed.reason;
    return { outcome: 'failed', etag: options.etag };
  }

  failure.phase = 'facts';
  const facts = githubLatestToFacts(entry, parsed.value);
  if (facts === null) {
    // 2xx with an unusable body is not proof that no stable release exists
    // (unlike 404). Fail closed so we do not clear good local state.
    failure.failureClass = 'invalid_release';
    return { outcome: 'failed', etag: options.etag };
  }
  // Catalog repositoryId is the authority; name is display-only.
  if (facts.repositoryId !== entry.repositoryId) {
    failure.failureClass = 'invalid_release';
    return { outcome: 'failed', etag: options.etag };
  }

  failure.phase = 'url';
  const releaseUrl = buildPegmaReleaseUrl(facts.repositoryName, facts.tagName);
  if (releaseUrl === null) {
    failure.failureClass = 'unsafe_release_url';
    return { outcome: 'failed', etag: options.etag };
  }
  await verifyPublicRepository();
  assertCurrent();

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
  failure.phase = 'projection';
  const wrote = await applyAuthoritativeCurrentRelease(store, release);
  return {
    outcome: wrote === 'written' ? 'upserted' : 'unchanged',
    etag: nextEtag,
  };
}

async function reconcileOneRepository(options: ReconcileOneOptions) {
  if (!options.authentication) return reconcileOneRepositoryRequest({
    ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), assertCurrent: () => {},
  });
  const controller = new AbortController();
  const started = new Date(options.clock.now()).getTime();
  const deadline = started + REQUEST_TIMEOUT_MS;
  let credential: ReleaseCatalogCredential | null = null;
  let timedOut = false;
  const unavailable = () => ({ outcome: 'failed' as const, etag: options.etag });
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => reject(new ReleaseCatalogAuthenticationUnavailable()), { once: true });
  });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
  const assertCurrent = () => {
    const now = new Date(options.clock.now()).getTime();
    if (!credential || controller.signal.aborted || !Number.isFinite(started) || !Number.isFinite(deadline) || !Number.isFinite(now) || now < started ||
        now >= deadline || now >= credential.expiresAt || !credential.current())
      throw new ReleaseCatalogAuthenticationUnavailable();
  };
  async function run() {
    options.failure.phase = 'authentication';
    credential = await options.authentication!.resolve({
      purpose: 'public_release_catalog_read', repositoryId: options.entry.repositoryId, deadline,
    }, controller.signal);
    if (!credential || credential.repositoryId !== options.entry.repositoryId ||
        !/^[\x21-\x7E]{1,2048}$/u.test(credential.token) || !Number.isFinite(credential.expiresAt))
      throw new ReleaseCatalogAuthenticationUnavailable();
    assertCurrent();
    options.failure.phase = 'fetch';
    return reconcileOneRepositoryRequest({ ...options, credential, signal: controller.signal, assertCurrent });
  }
  try {
    return await Promise.race([run(), aborted]);
  } catch (error) {
    // No raw issuer/provider error, credential or response body is logged.
    options.failure.failureClass = 'operation_rejected';
    if (timedOut) options.failure.phase = 'authentication';
    if (error instanceof ReleaseCatalogAuthenticationUnavailable && error.response)
      Object.assign(options.failure, error.response);
    return unavailable();
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
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
  const fullCatalog = allowedReleaseCatalog(config.allowedRepositoryIds);
  if (options.scheduledTime !== undefined && fullCatalog.length > 60)
    throw new RangeError('Release catalog exceeds scheduled slots.');
  if (
    options.scheduledTime !== undefined &&
    (!Number.isFinite(new Date(options.scheduledTime).getTime()) ||
      options.scheduledTime < 0)
  )
    throw new RangeError('Invalid release schedule timestamp.');
  const slot =
    options.scheduledTime === undefined
      ? undefined
      : new Date(options.scheduledTime).getUTCMinutes();
  const catalog =
    slot === undefined ? fullCatalog : fullCatalog.slice(slot, slot + 1);
  if (slot !== undefined && catalog.length === 0)
    return { examined: 0, upserted: 0, cleared: 0, notModified: 0, failed: 0 };
  // Epoch-conditioned ETag updates so a concurrent webhook invalidation wins.
  const etagUpdates: ConditionalEtagUpdate[] = [];
  const succeeded: string[] = [];
  const failureDetails: ReleaseFailureDetail[] = [];

  let examined = 0;
  let upserted = 0;
  let cleared = 0;
  let notModified = 0;
  let failed = 0;

  for (const entry of catalog) {
    examined += 1;
    // Re-read live ETags/epochs each repo so mid-run invalidations apply.
    const live = await readReleaseOpsState(store);
    const expectedEpoch = live.repositoryEtagEpochs[entry.repositoryId] ?? 0;
    const failure: ReleaseFailureDetail = {
      repositoryId: entry.repositoryId,
      phase: 'fetch',
      failureClass: 'operation_rejected',
    };
    let result: {
      readonly outcome:
        'upserted' | 'cleared' | 'not_modified' | 'unchanged' | 'failed';
      readonly etag: string | undefined;
    };
    try {
      result = await reconcileOneRepository({
        store,
        entry,
        etag: live.repositoryEtags[entry.repositoryId],
        observedAt,
        fetchImpl,
        failure,
        authentication: options.authentication,
        clock: options.clock ?? systemClock,
      });
    } catch {
      // Version conflicts and unexpected store errors stay per-repository so
      // one hot key cannot abort the catalog pass or skip etag persistence.
      result = { outcome: 'failed', etag: undefined };
    }

    if (result.outcome === 'failed') {
      failed += 1;
      if (failureDetails.length < MAX_FAILURE_DETAILS) failureDetails.push(failure);
    } else {
      succeeded.push(entry.repositoryId);
    }
    if (result.outcome === 'cleared') {
      cleared += 1;
      etagUpdates.push({
        repositoryId: entry.repositoryId,
        etag: null,
        expectedEpoch,
      });
    } else if (result.outcome === 'not_modified') {
      notModified += 1;
    } else if (result.outcome !== 'failed') {
      if (result.outcome === 'upserted') {
        upserted += 1;
      }
      etagUpdates.push({
        repositoryId: entry.repositoryId,
        etag: result.etag ?? null,
        expectedEpoch,
      });
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
  // health "stale" stays honest. Merge ETag updates for successful repos.
  const scheduled =
    options.scheduledTime === undefined
      ? undefined
      : {
          repositoryIds: fullCatalog.map((entry) => entry.repositoryId),
          succeeded,
          scheduledTime: options.scheduledTime,
        };
  if (summary.failed === 0) {
    await mergeReleaseRepositoryEtagUpdates(
      store,
      etagUpdates,
      scheduled === undefined ? observedAt : null,
      scheduled,
    );
    logger.log('info', 'release_reconciliation.completed', {
      examined: summary.examined,
      upserted: summary.upserted,
      cleared: summary.cleared,
      notModified: summary.notModified,
    });
  } else {
    await mergeReleaseRepositoryEtagUpdates(
      store,
      etagUpdates,
      null,
      scheduled,
    );
    logger.log('error', 'release_reconciliation.partial_failure', {
      examined: summary.examined,
      upserted: summary.upserted,
      cleared: summary.cleared,
      notModified: summary.notModified,
      failed: summary.failed,
      failureDetails,
      failureDetailsOmitted: summary.failed - failureDetails.length,
    });
  }

  return summary;
}

/** Count current release summaries in D1 (for health detail). */
export async function countCurrentReleases(store: Store): Promise<number> {
  const releases = store.collection(componentReleaseStateCollection());
  const rows = await releases.list('current');
  return rows.filter((row) => row.kind === 'release').length;
}

/** Backfill is the same path as reconciliation (no receipt rows). */
export async function backfillReleases(
  options: RunReleaseReconciliationOptions,
): Promise<ReleaseReconciliationSummary> {
  return runReleaseReconciliation(options);
}
