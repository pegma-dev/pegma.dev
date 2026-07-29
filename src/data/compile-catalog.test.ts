import { describe, expect, it } from 'vitest';
import {
  clearNpmVersionCache,
  compileCompositionCatalog,
} from './compile-catalog';
import { CATALOG_SCHEMA_VERSION } from './catalog-schema';
import { components } from './components';
import { RECIPE_BACKLOG } from './recipe-backlog';

const FIXED_AT = '2026-07-29T00:00:00.000Z';
/** Empty stage map → no GitHub plan fetches in unit tests. */
const NO_STAGES: Record<string, string | null> = Object.fromEntries(
  components.map((c) => [c.repo, null]),
);

/** Deterministic npm map for tests — never hits the network. */
function fakeNpm(versions: Record<string, string | null>) {
  return async (name: string): Promise<string | null> => {
    if (!Object.prototype.hasOwnProperty.call(versions, name)) return null;
    const version = versions[name];
    return version === undefined ? null : version;
  };
}

function compile(npm: Record<string, string | null>) {
  return compileCompositionCatalog({
    generatedAt: FIXED_AT,
    stageByRepo: NO_STAGES,
    npmLookup: fakeNpm(npm),
  });
}

describe('compileCompositionCatalog', () => {
  it('emits schema 0.1.0 with one entry per registry component', async () => {
    clearNpmVersionCache();
    const catalog = await compile({
      '@pegma/spine': '0.1.1',
      '@pegma/storage-core': '0.4.0',
      '@pegma/storage-azure-tables': '0.4.0',
      '@pegma/storage-cloudflare-d1': '0.4.0',
      '@pegma/health': '0.1.1',
    });

    expect(catalog.schemaVersion).toBe(CATALOG_SCHEMA_VERSION);
    expect(catalog.generatedAt).toBe(FIXED_AT);
    expect(catalog.components).toHaveLength(components.length);
    expect(catalog.recipes).toHaveLength(RECIPE_BACKLOG.length);
  });

  it('flags unpublished packages when npm has no version', async () => {
    clearNpmVersionCache();
    const catalog = await compile({
      '@pegma/spine': '0.1.1',
      // webhooks and support-desk packages absent → unpublished
    });

    const webhooks = catalog.components.find((c) => c.id === 'webhooks')!;
    expect(webhooks.publishUsability).toBe('unpublished');
    expect(webhooks.packages.every((p) => p.published === false)).toBe(true);
    expect(webhooks.packages.every((p) => p.version === null)).toBe(true);

    const spine = catalog.components.find((c) => c.id === 'spine')!;
    expect(spine.publishUsability).toBe('usable');
    expect(spine.packages[0]).toMatchObject({
      name: '@pegma/spine',
      version: '0.1.1',
      published: true,
    });
  });

  it('marks partial when only some packages resolve on npm', async () => {
    clearNpmVersionCache();
    const catalog = await compile({
      '@pegma/storage-core': '0.4.0',
      // azure / d1 missing
    });
    const storage = catalog.components.find((c) => c.id === 'storage-core')!;
    expect(storage.publishUsability).toBe('partial');
    expect(storage.packages.filter((p) => p.published)).toHaveLength(1);
  });

  it('includes recipe intents with green fixtures only for CI-tested recipes', async () => {
    clearNpmVersionCache();
    const catalog = await compile({});
    const accounts = catalog.recipes.find((r) => r.id === 'cf-passkey-accounts')!;
    expect(accounts.backlogPriority).toBe(1);
    expect(accounts.fixture).toMatchObject({
      kind: 'recipe_package',
      status: 'green',
    });
    expect(accounts.fixture.citation).toContain('recipes/cf-passkey-accounts');
    expect(accounts.adapters[0]).toEqual({
      componentId: 'storage-core',
      adapterId: 'cloudflare-d1',
    });
    const outbox = catalog.recipes.find((r) => r.id === 'storage-audit-mail-outbox')!;
    // Durable pattern: host picks adapter; memory must not be the recipe default.
    expect(outbox.adapters).toEqual([]);
    expect(outbox.fixture).toMatchObject({
      kind: 'recipe_package',
      status: 'green',
    });
    expect(outbox.fixture.citation).toContain(
      'recipes/storage-audit-mail-outbox',
    );
    for (const recipe of catalog.recipes) {
      expect(recipe.intent).not.toMatch(/retiregolden/i);
    }
    const scaffold = catalog.recipes.find((r) => r.id === 'static-brochure-minimal')!;
    expect(scaffold.fixture).toMatchObject({
      kind: 'scaffold',
      status: 'green',
    });
    expect(scaffold.fixture.citation).toContain('recipes/scaffold-cf-minimal');
    // Unshipped backlog recipes remain non-green (no invented wiring).
    const greenIds = new Set([
      'cf-passkey-accounts',
      'storage-audit-mail-outbox',
      'static-brochure-minimal',
    ]);
    const pendingOrNone = catalog.recipes.filter((r) => !greenIds.has(r.id));
    for (const recipe of pendingOrNone) {
      expect(recipe.fixture.status).not.toBe('green');
    }
  });

  it('attaches enrichment deps and adapters for storage-core', async () => {
    clearNpmVersionCache();
    const catalog = await compile({
      '@pegma/storage-core': '0.4.0',
      '@pegma/storage-azure-tables': '0.4.0',
      '@pegma/storage-cloudflare-d1': '0.4.0',
    });
    const storage = catalog.components.find((c) => c.id === 'storage-core')!;
    expect(storage.dependencies.some((d) => d.componentId === 'spine')).toBe(true);
    expect(storage.adapters.map((a) => a.id)).toEqual(
      expect.arrayContaining(['memory', 'azure-tables', 'cloudflare-d1']),
    );
    expect(storage.capabilityTags).toContain('storage');
  });
});
