import { describe, expect, it, beforeEach } from 'vitest';
import {
  clearCatalogCache,
  fetchCompositionCatalog,
  CATALOG_CACHE_TTL_MS,
  DEFAULT_CATALOG_URL,
} from './mcp-catalog-fetch';
import type { CompositionCatalog } from '../../src/data/catalog-schema';

const sample: CompositionCatalog = {
  schemaVersion: '0.1.0',
  generatedAt: '2026-07-29T00:00:00.000Z',
  components: [],
  recipes: [],
};

describe('fetchCompositionCatalog', () => {
  beforeEach(() => {
    clearCatalogCache();
  });

  it('fetches and caches the catalog', async () => {
    let calls = 0;
    const fetchImpl = async (input: RequestInfo | URL) => {
      calls += 1;
      expect(String(input)).toBe(DEFAULT_CATALOG_URL);
      return new Response(JSON.stringify(sample), {
        status: 200,
        headers: { ETag: '"v1"', 'Content-Type': 'application/json' },
      });
    };

    const a = await fetchCompositionCatalog({}, { fetchImpl, now: 1_000 });
    const b = await fetchCompositionCatalog(
      {},
      { fetchImpl, now: 1_000 + CATALOG_CACHE_TTL_MS - 1 },
    );
    expect(a.generatedAt).toBe(sample.generatedAt);
    expect(b.generatedAt).toBe(sample.generatedAt);
    expect(calls).toBe(1);
  });

  it('revalidates after TTL with If-None-Match', async () => {
    let calls = 0;
    const fetchImpl = async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify(sample), {
          status: 200,
          headers: { ETag: '"v1"' },
        });
      }
      const headers = new Headers(init?.headers);
      expect(headers.get('If-None-Match')).toBe('"v1"');
      return new Response(null, { status: 304 });
    };

    await fetchCompositionCatalog({}, { fetchImpl, now: 0 });
    const again = await fetchCompositionCatalog(
      {},
      { fetchImpl, now: CATALOG_CACHE_TTL_MS + 1 },
    );
    expect(again.schemaVersion).toBe('0.1.0');
    expect(calls).toBe(2);
  });

  it('honors CATALOG_URL override', async () => {
    const fetchImpl = async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('https://example.test/catalog.json');
      return new Response(JSON.stringify(sample), { status: 200 });
    };
    await fetchCompositionCatalog(
      { CATALOG_URL: 'https://example.test/catalog.json' },
      { fetchImpl, now: 0 },
    );
  });

  it('rejects invalid shapes', async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ nope: true }), { status: 200 });
    await expect(
      fetchCompositionCatalog({}, { fetchImpl, now: 0 }),
    ).rejects.toThrow(/invalid_shape/);
  });
});
