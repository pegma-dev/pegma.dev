import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CATALOG_SCHEMA_VERSION,
  isPublishUsable,
  publishedPackageNames,
  type CatalogComponent,
  type CompositionCatalog,
} from './catalog-schema';

const here = dirname(fileURLToPath(import.meta.url));
const examplePath = join(here, '../../docs/catalog/example-catalog.json');

function loadExample(): CompositionCatalog {
  return JSON.parse(readFileSync(examplePath, 'utf8')) as CompositionCatalog;
}

describe('composition catalog schema', () => {
  it('pins schema version 0.1.0', () => {
    expect(CATALOG_SCHEMA_VERSION).toBe('0.1.0');
  });

  it('loads the example catalog with required top-level fields', () => {
    const catalog = loadExample();
    expect(catalog.schemaVersion).toBe(CATALOG_SCHEMA_VERSION);
    expect(catalog.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(catalog.components.length).toBeGreaterThan(0);
    expect(catalog.recipes.length).toBeGreaterThan(0);
  });

  it('marks unpublished packages unusable for production assembly', () => {
    const catalog = loadExample();
    const webhooks = catalog.components.find((c) => c.id === 'webhooks');
    expect(webhooks).toBeDefined();
    expect(webhooks!.publishUsability).toBe('unpublished');
    expect(isPublishUsable(webhooks!)).toBe(false);
    expect(publishedPackageNames(webhooks!)).toEqual([]);
  });

  it('exposes published package names only when versioned and published', () => {
    const storage: CatalogComponent = loadExample().components.find(
      (c) => c.id === 'storage-core',
    )!;
    expect(isPublishUsable(storage)).toBe(true);
    expect(publishedPackageNames(storage)).toEqual(
      expect.arrayContaining([
        '@pegma/storage-core',
        '@pegma/storage-azure-tables',
        '@pegma/storage-cloudflare-d1',
      ]),
    );
  });

  it('keeps recipe intents synthetic (no commercial host names)', () => {
    const catalog = loadExample();
    const banned = [/retiregolden/i, /pegma\.dev\/account/i];
    for (const recipe of catalog.recipes) {
      for (const pattern of banned) {
        expect(recipe.intent).not.toMatch(pattern);
      }
      expect(recipe.intent.length).toBeGreaterThan(40);
      // Empty requiresPublished is valid (e.g. static-brochure-minimal).
      expect(Array.isArray(recipe.requiresPublished)).toBe(true);
      for (const id of recipe.requiresPublished) {
        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThan(0);
      }
    }
  });

  it('orders priority recipes ahead of deferred unpublished ones', () => {
    const catalog = loadExample();
    const byId = Object.fromEntries(catalog.recipes.map((r) => [r.id, r]));
    expect(byId['cf-passkey-accounts']?.backlogPriority).toBe(1);
    expect(byId['storage-audit-mail-outbox']?.backlogPriority).toBe(2);
    expect(byId['inbound-webhook-receipts']?.backlogPriority).toBeGreaterThan(2);
    expect(byId['inbound-webhook-receipts']?.fixture.status).toBe('none');
  });
});
