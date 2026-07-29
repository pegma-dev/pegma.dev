/**
 * Fetch the published composition catalog for the public MCP surface.
 * Catalog is the system of record (static URL); MCP never invents facts.
 */

import type { CompositionCatalog } from '../../src/data/catalog-schema';

/** Default public catalog URL (site build emit). */
export const DEFAULT_CATALOG_URL = 'https://pegma.dev/catalog.json';

/** In-isolate cache TTL for catalog.json (five minutes). */
export const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000;

export interface CatalogFetchEnv {
  /** Override catalog URL for local/dev (optional). */
  readonly CATALOG_URL?: string;
}

interface CacheEntry {
  readonly catalog: CompositionCatalog;
  readonly fetchedAt: number;
  readonly etag: string | null;
}

let cache: CacheEntry | null = null;

/** Test helper — clear the module-level catalog cache. */
export function clearCatalogCache(): void {
  cache = null;
}

function isCompositionCatalog(value: unknown): value is CompositionCatalog {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.schemaVersion === 'string' &&
    typeof v.generatedAt === 'string' &&
    Array.isArray(v.components) &&
    Array.isArray(v.recipes)
  );
}

/**
 * Load the composition catalog, reusing a short in-isolate cache.
 * Uses conditional GET when an ETag was previously observed.
 */
export async function fetchCompositionCatalog(
  env: CatalogFetchEnv = {},
  options: {
    readonly now?: number;
    readonly fetchImpl?: typeof fetch;
  } = {},
): Promise<CompositionCatalog> {
  const now = options.now ?? Date.now();
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = env.CATALOG_URL?.trim() || DEFAULT_CATALOG_URL;

  if (cache && now - cache.fetchedAt < CATALOG_CACHE_TTL_MS) {
    return cache.catalog;
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'pegma-dev-api-mcp',
  };
  if (cache?.etag) {
    headers['If-None-Match'] = cache.etag;
  }

  try {
    const res = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 304 && cache) {
      cache = { ...cache, fetchedAt: now };
      return cache.catalog;
    }

    if (!res.ok) {
      if (cache) {
        // Public fact surface already accepts short staleness; keep serving.
        return cache.catalog;
      }
      throw new Error(`catalog_fetch_failed:${res.status}`);
    }

    const body: unknown = await res.json();
    if (!isCompositionCatalog(body)) {
      if (cache) return cache.catalog;
      throw new Error('catalog_fetch_invalid_shape');
    }

    const etag = res.headers.get('ETag');
    cache = {
      catalog: body,
      fetchedAt: now,
      etag,
    };
    return body;
  } catch (error) {
    if (cache) {
      return cache.catalog;
    }
    throw error;
  }
}
