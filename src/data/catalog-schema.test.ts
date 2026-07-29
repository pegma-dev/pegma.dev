import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CATALOG_SCHEMA_VERSION,
  isPackagePublished,
  isPublishUsable,
  publishedPackageNames,
  recipePackagesReady,
  parsePackageSpecifier,
  type CatalogAdapter,
  type CatalogComponent,
  type CatalogComponentStatus,
  type CatalogDependency,
  type CatalogPackage,
  type CatalogRecipe,
  type CompositionCatalog,
  type DependencyKind,
  type PublishUsability,
  type RecipeFixtureStatus,
} from './catalog-schema';

const here = dirname(fileURLToPath(import.meta.url));
const examplePath = join(here, '../../docs/catalog/example-catalog.json');

const COMPONENT_STATUSES = new Set<CatalogComponentStatus>([
  'published',
  'in_development',
  'planned',
]);
const PUBLISH_USABILITY = new Set<PublishUsability>([
  'usable',
  'unpublished',
  'partial',
]);
const FIXTURE_STATUSES = new Set<RecipeFixtureStatus>([
  'green',
  'pending',
  'none',
]);
const ADAPTER_HOSTS = new Set(['cloudflare', 'azure', 'memory', 'other']);
const DEPENDENCY_KINDS = new Set<DependencyKind>([
  'requires',
  'optional',
  'composes_with',
]);

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} must be a string array`);
  }
}

function parsePackage(raw: unknown, label: string): CatalogPackage {
  if (!raw || typeof raw !== 'object') throw new Error(`${label} must be an object`);
  const p = raw as Record<string, unknown>;
  assertString(p.name, `${label}.name`);
  if (!(typeof p.version === 'string' || p.version === null)) {
    throw new Error(`${label}.version must be string or null`);
  }
  if (typeof p.published !== 'boolean') {
    throw new Error(`${label}.published must be boolean`);
  }
  return {
    name: p.name,
    version: p.version,
    published: p.published,
    ...(typeof p.npmUrl === 'string' ? { npmUrl: p.npmUrl } : {}),
  };
}

function parseAdapter(raw: unknown, label: string): CatalogAdapter {
  if (!raw || typeof raw !== 'object') throw new Error(`${label} must be an object`);
  const a = raw as Record<string, unknown>;
  assertString(a.id, `${label}.id`);
  assertString(a.host, `${label}.host`);
  if (!ADAPTER_HOSTS.has(a.host)) throw new Error(`${label}.host invalid`);
  assertString(a.when, `${label}.when`);
  return {
    id: a.id,
    host: a.host as CatalogAdapter['host'],
    when: a.when,
    ...(typeof a.packageName === 'string' ? { packageName: a.packageName } : {}),
  };
}

function parseDependency(raw: unknown, label: string): CatalogDependency {
  if (!raw || typeof raw !== 'object') throw new Error(`${label} must be an object`);
  const d = raw as Record<string, unknown>;
  assertString(d.componentId, `${label}.componentId`);
  assertString(d.kind, `${label}.kind`);
  if (!DEPENDENCY_KINDS.has(d.kind as DependencyKind)) {
    throw new Error(`${label}.kind invalid`);
  }
  return {
    componentId: d.componentId,
    kind: d.kind as DependencyKind,
    ...(typeof d.note === 'string' ? { note: d.note } : {}),
  };
}

function parseComponent(raw: unknown, index: number): CatalogComponent {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`components[${index}] must be an object`);
  }
  const c = raw as Record<string, unknown>;
  assertString(c.id, `components[${index}].id`);
  assertString(c.title, `components[${index}].title`);
  assertString(c.repo, `components[${index}].repo`);
  assertString(c.summary, `components[${index}].summary`);
  if (typeof c.status !== 'string' || !COMPONENT_STATUSES.has(c.status as CatalogComponentStatus)) {
    throw new Error(`components[${index}].status invalid`);
  }
  if (
    typeof c.publishUsability !== 'string' ||
    !PUBLISH_USABILITY.has(c.publishUsability as PublishUsability)
  ) {
    throw new Error(`components[${index}].publishUsability invalid`);
  }
  if (!Array.isArray(c.packages)) throw new Error(`components[${index}].packages must be array`);
  if (!Array.isArray(c.dependencies)) {
    throw new Error(`components[${index}].dependencies must be array`);
  }
  if (!Array.isArray(c.adapters)) throw new Error(`components[${index}].adapters must be array`);
  assertStringArray(c.owns, `components[${index}].owns`);
  assertStringArray(c.refuses, `components[${index}].refuses`);
  assertStringArray(c.hostMustProvide, `components[${index}].hostMustProvide`);
  assertStringArray(c.capabilityTags, `components[${index}].capabilityTags`);
  assertStringArray(c.recipeIds, `components[${index}].recipeIds`);
  if (!c.links || typeof c.links !== 'object') {
    throw new Error(`components[${index}].links must be object`);
  }
  const links = c.links as Record<string, unknown>;
  assertString(links.githubRepo, `components[${index}].links.githubRepo`);

  return {
    id: c.id,
    title: c.title,
    repo: c.repo,
    packages: c.packages.map((p, i) => parsePackage(p, `components[${index}].packages[${i}]`)),
    status: c.status as CatalogComponentStatus,
    publishUsability: c.publishUsability as PublishUsability,
    summary: c.summary,
    owns: c.owns,
    refuses: c.refuses,
    dependencies: c.dependencies.map((d, i) =>
      parseDependency(d, `components[${index}].dependencies[${i}]`),
    ),
    adapters: c.adapters.map((a, i) => parseAdapter(a, `components[${index}].adapters[${i}]`)),
    hostMustProvide: c.hostMustProvide,
    capabilityTags: c.capabilityTags as CatalogComponent['capabilityTags'],
    recipeIds: c.recipeIds,
    links: {
      githubRepo: links.githubRepo,
      ...(typeof links.plan === 'string' ? { plan: links.plan } : {}),
      ...(typeof links.readme === 'string' ? { readme: links.readme } : {}),
      ...(typeof links.npm === 'string' ? { npm: links.npm } : {}),
    },
    ...(typeof c.now === 'string' ? { now: c.now } : {}),
    ...(typeof c.stage === 'string' ? { stage: c.stage } : {}),
  };
}

function parseRecipe(raw: unknown, index: number): CatalogRecipe {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`recipes[${index}] must be an object`);
  }
  const r = raw as Record<string, unknown>;
  assertString(r.id, `recipes[${index}].id`);
  assertString(r.intent, `recipes[${index}].intent`);
  assertStringArray(r.packages, `recipes[${index}].packages`);
  assertStringArray(r.adapters, `recipes[${index}].adapters`);
  assertStringArray(r.hostResponsibilities, `recipes[${index}].hostResponsibilities`);
  assertStringArray(r.nonGoals, `recipes[${index}].nonGoals`);
  assertStringArray(r.antiPatterns, `recipes[${index}].antiPatterns`);
  assertStringArray(r.capabilityTags, `recipes[${index}].capabilityTags`);
  assertStringArray(r.requiresPublished, `recipes[${index}].requiresPublished`);
  if (!r.fixture || typeof r.fixture !== 'object') {
    throw new Error(`recipes[${index}].fixture must be object`);
  }
  const f = r.fixture as Record<string, unknown>;
  assertString(f.kind, `recipes[${index}].fixture.kind`);
  assertString(f.citation, `recipes[${index}].fixture.citation`);
  if (typeof f.status !== 'string' || !FIXTURE_STATUSES.has(f.status as RecipeFixtureStatus)) {
    throw new Error(`recipes[${index}].fixture.status invalid`);
  }
  // Green means CI-proven wiring — pending kind cannot claim green.
  if (f.status === 'green' && f.kind === 'pending') {
    throw new Error(
      `recipes[${index}].fixture: status 'green' cannot use kind 'pending'`,
    );
  }
  return {
    id: r.id,
    intent: r.intent,
    packages: r.packages,
    adapters: r.adapters,
    hostResponsibilities: r.hostResponsibilities,
    nonGoals: r.nonGoals,
    antiPatterns: r.antiPatterns,
    fixture: {
      kind: f.kind as CatalogRecipe['fixture']['kind'],
      citation: f.citation,
      status: f.status as RecipeFixtureStatus,
    },
    capabilityTags: r.capabilityTags as CatalogRecipe['capabilityTags'],
    requiresPublished: r.requiresPublished,
    ...(typeof r.backlogPriority === 'number' ? { backlogPriority: r.backlogPriority } : {}),
  };
}

/** Structural validation — unknown JSON must match CompositionCatalog shape. */
export function parseCompositionCatalog(raw: unknown): CompositionCatalog {
  if (!raw || typeof raw !== 'object') throw new Error('catalog must be an object');
  const doc = raw as Record<string, unknown>;
  if (doc.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    throw new Error(`schemaVersion must be ${CATALOG_SCHEMA_VERSION}`);
  }
  assertString(doc.generatedAt, 'generatedAt');
  if (!Array.isArray(doc.components)) throw new Error('components must be an array');
  if (!Array.isArray(doc.recipes)) throw new Error('recipes must be an array');
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    generatedAt: doc.generatedAt,
    ...(typeof doc.snapshotDate === 'string' ? { snapshotDate: doc.snapshotDate } : {}),
    components: doc.components.map(parseComponent),
    recipes: doc.recipes.map(parseRecipe),
  };
}

function loadExample(): CompositionCatalog {
  const raw: unknown = JSON.parse(readFileSync(examplePath, 'utf8'));
  return parseCompositionCatalog(raw);
}

describe('composition catalog schema', () => {
  it('pins schema version 0.1.0', () => {
    expect(CATALOG_SCHEMA_VERSION).toBe('0.1.0');
  });

  it('structurally validates the example catalog', () => {
    const catalog = loadExample();
    expect(catalog.schemaVersion).toBe(CATALOG_SCHEMA_VERSION);
    expect(catalog.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(catalog.components.length).toBeGreaterThan(0);
    expect(catalog.recipes.length).toBeGreaterThan(0);
  });

  it('rejects example JSON missing required fields', () => {
    expect(() => parseCompositionCatalog({ schemaVersion: '0.1.0' })).toThrow(/generatedAt/);
    expect(() =>
      parseCompositionCatalog({
        schemaVersion: '0.2.0',
        generatedAt: '2026-07-28T00:00:00.000Z',
        components: [],
        recipes: [],
      }),
    ).toThrow(/schemaVersion/);
  });

  it('marks unpublished packages unusable for production assembly', () => {
    const catalog = loadExample();
    const webhooks = catalog.components.find((c) => c.id === 'webhooks');
    expect(webhooks).toBeDefined();
    expect(webhooks!.publishUsability).toBe('unpublished');
    expect(isPublishUsable(webhooks!)).toBe(false);
    expect(publishedPackageNames(webhooks!)).toEqual([]);
    expect(isPackagePublished(webhooks!, '@pegma/webhooks')).toBe(false);
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

  it('gates recipe readiness on package pins, not partial components alone', () => {
    const catalog = loadExample();
    const inbound = catalog.recipes.find((r) => r.id === 'inbound-webhook-receipts')!;
    expect(recipePackagesReady(catalog, inbound)).toBe(false);

    // Partial component with only some packages published must not pass a
    // recipe that names an unpublished sibling package.
    const partialCatalog: CompositionCatalog = {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      generatedAt: '2026-07-28T00:00:00.000Z',
      components: [
        {
          id: 'demo',
          title: 'Demo',
          repo: 'demo',
          packages: [
            { name: '@pegma/demo-core', version: '0.1.0', published: true },
            { name: '@pegma/demo-extra', version: null, published: false },
          ],
          status: 'published',
          publishUsability: 'partial',
          summary: 'partial demo',
          owns: [],
          refuses: [],
          dependencies: [],
          adapters: [],
          hostMustProvide: [],
          capabilityTags: [],
          recipeIds: [],
          links: { githubRepo: 'https://github.com/pegma-dev/demo' },
        },
      ],
      recipes: [
        {
          id: 'needs-extra',
          intent: 'A fictional partial-package case that asks for the unpublished sibling.',
          packages: ['@pegma/demo-core', '@pegma/demo-extra'],
          adapters: [],
          hostResponsibilities: [],
          nonGoals: [],
          antiPatterns: [],
          fixture: { kind: 'pending', citation: 'n/a', status: 'pending' },
          capabilityTags: [],
          requiresPublished: ['demo'],
        },
      ],
    };
    expect(isPublishUsable(partialCatalog.components[0]!)).toBe(false);
    expect(recipePackagesReady(partialCatalog, partialCatalog.recipes[0]!)).toBe(false);
    expect(
      recipePackagesReady(partialCatalog, {
        ...partialCatalog.recipes[0]!,
        packages: ['@pegma/demo-core'],
      }),
    ).toBe(true);
    expect(
      recipePackagesReady(partialCatalog, {
        ...partialCatalog.recipes[0]!,
        packages: ['@pegma/demo-core@0.1.0'],
      }),
    ).toBe(true);
    expect(
      recipePackagesReady(partialCatalog, {
        ...partialCatalog.recipes[0]!,
        packages: ['@pegma/demo-core@9.9.9'],
      }),
    ).toBe(false);
  });

  it('parses scoped package@version specifiers', () => {
    expect(parsePackageSpecifier('@pegma/spine@0.1.1')).toEqual({
      name: '@pegma/spine',
      version: '0.1.1',
    });
    expect(parsePackageSpecifier('@pegma/spine')).toEqual({
      name: '@pegma/spine',
      version: null,
    });
    expect(parsePackageSpecifier('left-pad@1.0.0')).toEqual({
      name: 'left-pad',
      version: '1.0.0',
    });
    expect(parsePackageSpecifier('@pegma/spine@')).toEqual({
      name: '@pegma/spine',
      version: '',
    });
    expect(
      recipePackagesReady(loadExample(), {
        id: 'bad-pin',
        intent: 'A fictional recipe with a trailing-@ package specifier that must not pass.',
        packages: ['@pegma/spine@'],
        adapters: [],
        hostResponsibilities: [],
        nonGoals: [],
        antiPatterns: [],
        fixture: { kind: 'pending', citation: 'n/a', status: 'pending' },
        capabilityTags: [],
        requiresPublished: ['spine'],
      }),
    ).toBe(false);
  });

  it('rejects green fixtures that are still pending', () => {
    expect(() =>
      parseCompositionCatalog({
        schemaVersion: CATALOG_SCHEMA_VERSION,
        generatedAt: '2026-07-28T00:00:00.000Z',
        components: [],
        recipes: [
          {
            id: 'fake-green',
            intent: 'A fictional recipe that claims green without a real fixture source kind.',
            packages: [],
            adapters: [],
            hostResponsibilities: [],
            nonGoals: [],
            antiPatterns: [],
            fixture: {
              kind: 'pending',
              citation: 'docs/catalog/RECIPE_BACKLOG.md',
              status: 'green',
            },
            capabilityTags: [],
            requiresPublished: [],
          },
        ],
      }),
    ).toThrow(/green.*pending/i);
  });

  it('rejects malformed dependency entries', () => {
    expect(() =>
      parseCompositionCatalog({
        schemaVersion: CATALOG_SCHEMA_VERSION,
        generatedAt: '2026-07-28T00:00:00.000Z',
        components: [
          {
            id: 'x',
            title: 'X',
            repo: 'x',
            packages: [],
            status: 'published',
            publishUsability: 'usable',
            summary: 'x',
            owns: [],
            refuses: [],
            dependencies: ['spine'],
            adapters: [],
            hostMustProvide: [],
            capabilityTags: [],
            recipeIds: [],
            links: { githubRepo: 'https://github.com/pegma-dev/x' },
          },
        ],
        recipes: [],
      }),
    ).toThrow(/dependencies\[0\]/);
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
