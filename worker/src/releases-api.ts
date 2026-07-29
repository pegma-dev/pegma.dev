import type { Store } from '@pegma/storage-core';
import type { Logger } from '@pegma/spine';
import {
  componentReleaseCollection,
  componentReleaseKey,
  type ComponentRelease,
} from './component-release';
import { allowedReleaseCatalog } from './release-catalog';
import { buildPegmaReleaseUrl } from './release-projection';
import {
  parseAllowedRepositoryIds,
  type GitHubReleaseWebhookEnv,
} from './github-release-webhook';

/** Public JSON schema id for GET /api/releases. */
export const RELEASES_SCHEMA = 'pegma.releases.v1';

/** Maximum public cache lifetime for the read surface (five minutes). */
export const RELEASES_MAX_AGE_SECONDS = 300;

const GITHUB_ORG_PREFIX = 'https://github.com/pegma-dev/';

export interface ReleasesReadConfig {
  readonly allowedRepositoryIds: ReadonlySet<string>;
}

/** One repository slot in the public releases response. */
export interface PublicReleaseEntry {
  readonly repositoryId: string;
  readonly repositoryName: string;
  readonly current: PublicCurrentRelease | null;
}

export interface PublicCurrentRelease {
  readonly releaseId: string;
  readonly tagName: string;
  readonly publishedAt: string;
  readonly releaseUrl: string;
  readonly observedAt: string;
}

export interface ReleasesResponseBody {
  readonly schema: typeof RELEASES_SCHEMA;
  readonly observedAt: string;
  readonly releases: readonly PublicReleaseEntry[];
}

export interface HandleGetReleasesOptions {
  readonly request: Request;
  readonly store: Store;
  readonly logger: Logger;
  readonly config: ReleasesReadConfig;
  readonly now?: string;
}

/**
 * Read allowlist for the public releases endpoint. Does not require the
 * webhook secret — only the repository allowlist used by ingestion.
 */
export function readReleasesConfig(
  env: GitHubReleaseWebhookEnv,
): ReleasesReadConfig | null {
  const allowedRepositoryIds = parseAllowedRepositoryIds(
    env.GITHUB_ALLOWED_REPOSITORY_IDS,
  );
  if (allowedRepositoryIds.size === 0) {
    return null;
  }
  return { allowedRepositoryIds };
}

/**
 * Project a stored record into public fields; reject unsafe URLs.
 * `displayRepositoryName` is the catalog name shown to clients; the release
 * URL must match that name (not a stale stored rename).
 */
export function toPublicCurrentRelease(
  release: ComponentRelease,
  displayRepositoryName: string = release.repositoryName,
): PublicCurrentRelease | null {
  const expectedUrl = buildPegmaReleaseUrl(
    displayRepositoryName,
    release.tagName,
  );
  if (
    expectedUrl === null ||
    release.releaseUrl !== expectedUrl ||
    !release.releaseUrl.startsWith(GITHUB_ORG_PREFIX)
  ) {
    return null;
  }
  return {
    releaseId: release.releaseId,
    tagName: release.tagName,
    publishedAt: release.publishedAt,
    releaseUrl: expectedUrl,
    observedAt: release.observedAt,
  };
}

/**
 * Build the public releases document for the allowlisted catalog in display
 * order. Missing D1 rows become `current: null` (empty-but-valid).
 */
export async function buildReleasesResponse(
  store: Store,
  config: ReleasesReadConfig,
  observedAt: string,
): Promise<ReleasesResponseBody> {
  const catalog = allowedReleaseCatalog(config.allowedRepositoryIds);
  const releases = store.collection(componentReleaseCollection());
  const entries: PublicReleaseEntry[] = [];

  for (const entry of catalog) {
    const stored = await releases.get(componentReleaseKey(entry.repositoryId));
    if (stored === null) {
      entries.push({
        repositoryId: entry.repositoryId,
        repositoryName: entry.repositoryName,
        current: null,
      });
      continue;
    }
    // Catalog name is the public display authority (stable IDs, not renames).
    entries.push({
      repositoryId: entry.repositoryId,
      repositoryName: entry.repositoryName,
      current: toPublicCurrentRelease(stored, entry.repositoryName),
    });
  }

  return {
    schema: RELEASES_SCHEMA,
    observedAt,
    releases: entries,
  };
}

async function weakEtagForBody(body: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(body),
  );
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `W/"${hex.slice(0, 32)}"`;
}

function etagMatches(header: string | null, etag: string): boolean {
  if (header === null || header.trim() === '') {
    return false;
  }
  const tokens = header.split(',').map((part) => part.trim());
  // RFC 9110: If-None-Match: * matches any current representation.
  if (tokens.includes('*')) {
    return true;
  }
  const strong = etag.replace(/^W\//, '');
  return tokens.some((token) => token === etag || token === strong);
}

/**
 * Serve GET /api/releases — public current-stable summaries only.
 */
export async function handleGetReleases(
  options: HandleGetReleasesOptions,
): Promise<Response> {
  const { request, store, logger, config } = options;

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return Response.json(
      { error: 'method_not_allowed' },
      {
        status: 405,
        headers: {
          Allow: 'GET, HEAD',
          'Cache-Control': 'no-store',
          'Content-Type': 'application/json; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
        },
      },
    );
  }

  const observedAt = options.now ?? new Date().toISOString();
  let body: ReleasesResponseBody;
  try {
    body = await buildReleasesResponse(store, config, observedAt);
  } catch (error) {
    logger.log('error', 'releases_api.read_failed', {
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

  const payload = JSON.stringify(body);
  const etag = await weakEtagForBody(payload);
  const headers = new Headers({
    'Cache-Control': `public, max-age=${RELEASES_MAX_AGE_SECONDS}`,
    'Content-Type': 'application/json; charset=utf-8',
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
  });

  if (etagMatches(request.headers.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers });
  }

  if (request.method === 'HEAD') {
    headers.set('Content-Length', String(new TextEncoder().encode(payload).byteLength));
    return new Response(null, { status: 200, headers });
  }

  return new Response(payload, { status: 200, headers });
}
