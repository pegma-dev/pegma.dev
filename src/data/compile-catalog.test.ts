import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  clearNpmVersionCache,
  compileCompositionCatalog,
} from './compile-catalog';
import {
  CATALOG_SCHEMA_VERSION,
  parsePackageSpecifier,
  recipePackagesReady,
} from './catalog-schema';
import { components, SNAPSHOT_DATE } from './components';
import { RECIPE_BACKLOG } from './recipe-backlog';
import { getRecipe, planComposition } from './mcp-tools';

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
  it.each([
    {
      id: 'cf-passkey-accounts',
      source: '../../recipes/cf-passkey-accounts/composition.ts',
      imports: ['@pegma/sessions'],
      pins: ['@pegma/sessions', '@pegma/storage-cloudflare-d1'],
    },
    {
      id: 'support-queue-slice',
      source: '../../recipes/bench-ticket/composition.ts',
      imports: ['@pegma/sessions', '@pegma/support-desk-application'],
      pins: [
        '@pegma/sessions',
        '@pegma/support-desk-application',
        '@pegma/support-desk-core',
        '@pegma/support-desk-contracts',
      ],
    },
  ])(
    'ties the current $id fixture and its catalog pins to the installed root composition',
    async ({ id, source, imports, pins }) => {
      const { dependencies } = JSON.parse(
        readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
      );
      const fixtureUrl = new URL(source, import.meta.url);
      const fixture = readFileSync(fixtureUrl, 'utf8');
      expect(existsSync(new URL('./package.json', fixtureUrl))).toBe(false);
      for (const name of imports) {
        expect(fixture).toContain("from '" + name + "'");
        const installed = JSON.parse(
          readFileSync(new URL('../package.json', import.meta.resolve(name)), 'utf8'),
        );
        expect(installed).toMatchObject({ name, version: dependencies[name] });
      }
      const catalog = await compile({});
      const recipe = getRecipe(catalog, id);
      expect(recipe?.fixture.status).toBe('green');
      for (const name of pins) expect(recipe?.packages).toContain(name + '@' + dependencies[name]);
      if (id === 'cf-passkey-accounts') {
        // The recipe tests a Store injection with Memory, not the D1 adapter.
        // Its declared deployment adapter follows the actual host manifest.
        expect(fixture).toContain('Production Workers should inject');
        const adapter = JSON.parse(
          readFileSync(
            new URL('../package.json', import.meta.resolve('@pegma/storage-cloudflare-d1')),
            'utf8',
          ),
        );
        expect(adapter).toMatchObject({
          name: '@pegma/storage-cloudflare-d1',
          version: dependencies['@pegma/storage-cloudflare-d1'],
        });
        expect(readFileSync(new URL('../../README.md', import.meta.url), 'utf8')).toContain(
          '@pegma/storage-cloudflare-d1@' + dependencies['@pegma/storage-cloudflare-d1'],
        );
      }
    },
  );

  it.each(['matching', 'older-session', 'unmatched-session'] as const)(
    'preserves exact publication readiness through compiled MCP plans for %s metadata',
    async (mode) => {
      const { dependencies } = JSON.parse(
        readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
      );
      // A deterministic publication fixture, not an assertion of npm's live
      // latest versions. Independent recipe/component releases remain intact.
      const published = Object.fromEntries(
        RECIPE_BACKLOG.flatMap((recipe) =>
          recipe.packages
            .map(parsePackageSpecifier)
            .filter((pin) => pin.version)
            .map((pin) => [pin.name, pin.version]),
        ),
      );
      for (const name of [
        '@pegma/sessions',
        '@pegma/storage-cloudflare-d1',
        '@pegma/support-desk-application',
        '@pegma/support-desk-contracts',
        '@pegma/support-desk-core',
      ])
        published[name] = dependencies[name];
      if (mode !== 'matching')
        published['@pegma/sessions'] = mode === 'older-session' ? '0.2.0' : '9.9.9';
      const catalog = await compile(published);
      for (const id of ['cf-passkey-accounts', 'support-queue-slice']) {
        const recipe = getRecipe(catalog, id);
        if (!recipe) throw new Error('Expected the actual compiled recipe.');
        expect(recipePackagesReady(catalog, recipe)).toBe(mode === 'matching');
        const plan = planComposition(catalog, {
          capabilityTags: recipe.capabilityTags,
          host: 'cloudflare',
          productionOnly: true,
        });
        if (mode === 'matching') expect(plan.recipes.map((entry) => entry.id)).toContain(id);
        else {
          expect(plan.recipes.map((entry) => entry.id)).not.toContain(id);
          expect(plan.skipped).toContainEqual({
            id,
            kind: 'recipe',
            reason: 'recipe packages not published with pins',
          });
        }
      }
    },
  );

  it('lists sixteen registry components including published cache, flags, and billing', () => {
    expect(SNAPSHOT_DATE).toBe('2026-08-15');
    expect(components).toHaveLength(16);
    const byRepo = Object.fromEntries(components.map((c) => [c.repo, c]));
    expect(byRepo['cache-core']?.status).toBe('published');
    expect(byRepo['cache-core']?.packages).toEqual([
      '@pegma/cache-core',
      '@pegma/cache-conformance',
      '@pegma/cache-redis',
      '@pegma/cache-azure-redis',
      '@pegma/cache-elasticache',
      '@pegma/cache-upstash-redis',
    ]);
    expect(byRepo['flags-core']?.status).toBe('published');
    expect(byRepo['flags-core']?.packages).toEqual([
      '@pegma/flags-contracts',
      '@pegma/flags-core',
      '@pegma/flags-static',
      '@pegma/flags-azure-appconfig',
      '@pegma/flags-aws-appconfig',
      '@pegma/flags-cloudflare-flagship',
      '@pegma/flags-flagd',
      '@pegma/flags-launchdarkly',
    ]);
    expect(byRepo['billing-core']?.status).toBe('published');
    expect(byRepo['billing-core']?.packages).toEqual([
      '@pegma/billing-core',
      '@pegma/billing-stripe',
    ]);
    expect(byRepo['billing-core']?.now).toMatch(/0\.1\.1/);
    expect(byRepo['billing-core']?.now).not.toMatch(/unpublished|nothing extracted|planned/i);
    expect(byRepo['cache-core']?.now).not.toMatch(/unpublished/i);
    expect(byRepo['flags-core']?.now).not.toMatch(/unpublished/i);
  });

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
    const bench = catalog.recipes.find((r) => r.id === 'support-queue-slice')!;
    expect(bench.fixture).toMatchObject({
      kind: 'recipe_package',
      status: 'green',
    });
    expect(bench.fixture.citation).toContain('recipes/bench-ticket');
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
      'support-queue-slice',
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
      expect.arrayContaining([
        'memory',
        'azure-tables',
        'cloudflare-d1',
        'dynamodb',
      ]),
    );
    expect(storage.capabilityTags).toContain('storage');
  });

  it('keeps a fetched unpublished Stage paragraph instead of forcing the snapshot', async () => {
    clearNpmVersionCache();
    const cacheStage =
      'Phase 5 — Upstash Redis adapter, in-tree, unpublished. Packages are 0.1.1 and not published.';
    const flagsStage =
      'Phase 3 vendor adapters implemented in-tree; unpublished. Public API unstable (0.x).';
    const billingStage =
      'Phase 4 — Stripe adapter in-tree. Nothing is published. (0.1.1, unpublished.)';
    const catalog = await compileCompositionCatalog({
      generatedAt: FIXED_AT,
      stageByRepo: {
        ...NO_STAGES,
        'cache-core': cacheStage,
        'flags-core': flagsStage,
        'billing-core': billingStage,
      },
      npmLookup: fakeNpm({
        '@pegma/cache-core': '0.1.1',
        '@pegma/cache-conformance': '0.1.1',
        '@pegma/cache-redis': '0.1.1',
        '@pegma/cache-azure-redis': '0.1.1',
        '@pegma/cache-elasticache': '0.1.1',
        '@pegma/cache-upstash-redis': '0.1.1',
        '@pegma/flags-contracts': '0.1.1',
        '@pegma/flags-core': '0.1.1',
        '@pegma/flags-static': '0.1.1',
        '@pegma/flags-azure-appconfig': '0.1.1',
        '@pegma/flags-aws-appconfig': '0.1.1',
        '@pegma/flags-cloudflare-flagship': '0.1.1',
        '@pegma/flags-flagd': '0.1.1',
        '@pegma/flags-launchdarkly': '0.1.1',
        '@pegma/billing-core': '0.1.1',
        '@pegma/billing-stripe': '0.1.1',
      }),
    });

    expect(catalog.snapshotDate).toBe('2026-08-15');
    expect(catalog.components).toHaveLength(16);

    const cache = catalog.components.find((c) => c.id === 'cache-core')!;
    const flags = catalog.components.find((c) => c.id === 'flags-core')!;
    const billing = catalog.components.find((c) => c.id === 'billing-core')!;

    expect(cache.stage).toBe(cacheStage);
    expect(flags.stage).toBe(flagsStage);
    expect(billing.stage).toBe(billingStage);
    expect(cache.status).toBe('in_development');
    expect(flags.status).toBe('in_development');
    expect(billing.status).toBe('in_development');
    expect(billing.publishUsability).toBe('usable');
    expect(billing.packages.map((p) => p.name)).toEqual([
      '@pegma/billing-core',
      '@pegma/billing-stripe',
    ]);
    expect(billing.capabilityTags).toContain('billing');
    expect(cache.adapters.map((a) => a.id)).toEqual(
      expect.arrayContaining(['memory', 'redis', 'azure-redis', 'elasticache', 'upstash-redis']),
    );
    expect(cache.capabilityTags).toContain('cache');
    expect(flags.adapters.map((a) => a.id)).toEqual(
      expect.arrayContaining([
        'static',
        'azure-appconfig',
        'aws-appconfig',
        'cloudflare-flagship',
        'flagd',
        'launchdarkly',
      ]),
    );
    expect(flags.capabilityTags).toContain('flags');
  });
});
