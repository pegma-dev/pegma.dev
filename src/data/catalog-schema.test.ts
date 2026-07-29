import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CATALOG_SCHEMA_VERSION,
  isPackagePublished,
  isPublishUsable,
  parsePackageSpecifier,
  publishedPackageNames,
  recipePackagesReady,
  type CapabilityTag,
  type CatalogAdapter,
  type CatalogComponent,
  type CatalogComponentStatus,
  type CatalogDependency,
  type CatalogPackage,
  type CatalogRecipe,
  type CatalogRecipeAdapterRef,
  type CompositionCatalog,
  type DependencyKind,
  type PublishUsability,
  type RecipeFixtureKind,
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
const FIXTURE_KINDS = new Set<RecipeFixtureKind>([
  'package_readme',
  'conformance',
  'recipe_package',
  'scaffold',
  'pending',
]);
const CAPABILITY_TAGS = new Set<CapabilityTag>([
  'accounts',
  'passkeys',
  'email_codes',
  'sessions',
  'authorization',
  'storage',
  'audit',
  'mail_transactional',
  'rate_limit_durable',
  'rate_limit_memory',
  'webhooks_inbound',
  'support_queue',
  'health',
  'logging',
  'events_in_process',
  'cloudflare',
  'azure',
  'static_host',
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

function assertCapabilityTags(
  value: unknown,
  label: string,
): asserts value is CapabilityTag[] {
  assertStringArray(value, label);
  for (const tag of value) {
    if (!CAPABILITY_TAGS.has(tag as CapabilityTag)) {
      throw new Error(`${label} has unknown capability tag: ${tag}`);
    }
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

function parseRecipeAdapterRef(raw: unknown, label: string): CatalogRecipeAdapterRef {
  if (!raw || typeof raw !== 'object') throw new Error(`${label} must be an object`);
  const a = raw as Record<string, unknown>;
  assertString(a.componentId, `${label}.componentId`);
  assertString(a.adapterId, `${label}.adapterId`);
  return { componentId: a.componentId, adapterId: a.adapterId };
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
  assertCapabilityTags(c.capabilityTags, `components[${index}].capabilityTags`);
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
    capabilityTags: c.capabilityTags,
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
  if (!Array.isArray(r.adapters)) {
    throw new Error(`recipes[${index}].adapters must be an array`);
  }
  assertStringArray(r.hostResponsibilities, `recipes[${index}].hostResponsibilities`);
  assertStringArray(r.nonGoals, `recipes[${index}].nonGoals`);
  assertStringArray(r.antiPatterns, `recipes[${index}].antiPatterns`);
  assertCapabilityTags(r.capabilityTags, `recipes[${index}].capabilityTags`);
  assertStringArray(r.requiresPublished, `recipes[${index}].requiresPublished`);
  if (!r.fixture || typeof r.fixture !== 'object') {
    throw new Error(`recipes[${index}].fixture must be object`);
  }
  const f = r.fixture as Record<string, unknown>;
  assertString(f.kind, `recipes[${index}].fixture.kind`);
  if (!FIXTURE_KINDS.has(f.kind as RecipeFixtureKind)) {
    throw new Error(`recipes[${index}].fixture.kind invalid`);
  }
  assertString(f.citation, `recipes[${index}].fixture.citation`);
  if (typeof f.status !== 'string' || !FIXTURE_STATUSES.has(f.status as RecipeFixtureStatus)) {
    throw new Error(`recipes[${index}].fixture.status invalid`);
  }
  if (f.status === 'green' && f.kind === 'pending') {
    throw new Error(
      `recipes[${index}].fixture: status 'green' cannot use kind 'pending'`,
    );
  }
  return {
    id: r.id,
    intent: r.intent,
    packages: r.packages,
    adapters: r.adapters.map((a, i) =>
      parseRecipeAdapterRef(a, `recipes[${index}].adapters[${i}]`),
    ),
    hostResponsibilities: r.hostResponsibilities,
    nonGoals: r.nonGoals,
    antiPatterns: r.antiPatterns,
    fixture: {
      kind: f.kind as RecipeFixtureKind,
      citation: f.citation,
      status: f.status as RecipeFixtureStatus,
    },
    capabilityTags: r.capabilityTags,
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

function emptyRecipe(
  overrides: Partial<CatalogRecipe> & Pick<CatalogRecipe, 'id' | 'intent' | 'packages'>,
): CatalogRecipe {
  return {
    adapters: [],
    hostResponsibilities: [],
    nonGoals: [],
    antiPatterns: [],
    fixture: { kind: 'pending', citation: 'n/a', status: 'pending' },
    capabilityTags: [],
    requiresPublished: [],
    ...overrides,
  };
}

describe('composition catalog schema', () => {
  it('pins schema version 0.1.0', () => {
    expect(CATALOG_SCHEMA_VERSION).toBe('0.1.0');
  });

  it('structurally validates the fictional example catalog', () => {
    const catalog = loadExample();
    expect(catalog.schemaVersion).toBe(CATALOG_SCHEMA_VERSION);
    expect(catalog.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(catalog.components.length).toBeGreaterThan(0);
    expect(catalog.recipes.length).toBeGreaterThan(0);
    // Example must not claim real Pegma component lifecycle facts.
    for (const c of catalog.components) {
      expect(c.id.startsWith('example-')).toBe(true);
      expect(c.repo.startsWith('example-')).toBe(true);
    }
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
    const inbox = catalog.components.find((c) => c.id === 'example-inbox');
    expect(inbox).toBeDefined();
    expect(inbox!.publishUsability).toBe('unpublished');
    expect(isPublishUsable(inbox!)).toBe(false);
    expect(publishedPackageNames(inbox!)).toEqual([]);
    expect(isPackagePublished(inbox!, '@example/inbox')).toBe(false);
  });

  it('exposes published package names only when versioned and published', () => {
    const store: CatalogComponent = loadExample().components.find(
      (c) => c.id === 'example-store',
    )!;
    expect(isPublishUsable(store)).toBe(true);
    expect(publishedPackageNames(store)).toEqual(
      expect.arrayContaining(['@example/store', '@example/store-cloud']),
    );
  });

  it('gates recipe readiness on package pins, not partial components alone', () => {
    const catalog = loadExample();
    const deferred = catalog.recipes.find((r) => r.id === 'example-deferred')!;
    expect(recipePackagesReady(catalog, deferred)).toBe(false);

    const partialCatalog: CompositionCatalog = {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      generatedAt: '2026-07-28T00:00:00.000Z',
      components: [
        {
          id: 'demo',
          title: 'Demo',
          repo: 'demo',
          packages: [
            { name: '@example/demo-core', version: '0.1.0', published: true },
            { name: '@example/demo-extra', version: null, published: false },
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
          links: { githubRepo: 'https://github.com/example/demo' },
        },
      ],
      recipes: [
        emptyRecipe({
          id: 'needs-extra',
          intent: 'A fictional partial-package case that asks for the unpublished sibling.',
          packages: ['@example/demo-core', '@example/demo-extra'],
          requiresPublished: ['demo'],
        }),
      ],
    };
    expect(isPublishUsable(partialCatalog.components[0]!)).toBe(false);
    expect(recipePackagesReady(partialCatalog, partialCatalog.recipes[0]!)).toBe(false);
    expect(
      recipePackagesReady(
        partialCatalog,
        emptyRecipe({
          id: 'core-only',
          intent: 'A fictional recipe that only needs the published core package.',
          packages: ['@example/demo-core'],
        }),
      ),
    ).toBe(true);
    expect(
      recipePackagesReady(
        partialCatalog,
        emptyRecipe({
          id: 'core-pin',
          intent: 'A fictional recipe with an exact pin matching the published version.',
          packages: ['@example/demo-core@0.1.0'],
        }),
      ),
    ).toBe(true);
    expect(
      recipePackagesReady(
        partialCatalog,
        emptyRecipe({
          id: 'bad-pin',
          intent: 'A fictional recipe whose pin does not match the published version.',
          packages: ['@example/demo-core@9.9.9'],
        }),
      ),
    ).toBe(false);
  });

  it('parses scoped package@version specifiers', () => {
    expect(parsePackageSpecifier('@example/contracts@0.0.1')).toEqual({
      name: '@example/contracts',
      version: '0.0.1',
    });
    expect(parsePackageSpecifier('@example/contracts')).toEqual({
      name: '@example/contracts',
      version: null,
    });
    expect(parsePackageSpecifier('left-pad@1.0.0')).toEqual({
      name: 'left-pad',
      version: '1.0.0',
    });
    expect(parsePackageSpecifier('@example/contracts@')).toEqual({
      name: '@example/contracts',
      version: '',
    });
    expect(
      recipePackagesReady(
        loadExample(),
        emptyRecipe({
          id: 'bad-pin',
          intent: 'A fictional recipe with a trailing-@ package specifier that must not pass.',
          packages: ['@example/contracts@'],
          requiresPublished: ['example-contracts'],
        }),
      ),
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

  it('rejects unknown fixture kinds and capability tags', () => {
    expect(() =>
      parseCompositionCatalog({
        schemaVersion: CATALOG_SCHEMA_VERSION,
        generatedAt: '2026-07-28T00:00:00.000Z',
        components: [],
        recipes: [
          {
            id: 'bad-kind',
            intent: 'A fictional recipe with a typo in fixture kind.',
            packages: [],
            adapters: [],
            hostResponsibilities: [],
            nonGoals: [],
            antiPatterns: [],
            fixture: {
              kind: 'not_a_real_kind',
              citation: 'n/a',
              status: 'green',
            },
            capabilityTags: [],
            requiresPublished: [],
          },
        ],
      }),
    ).toThrow(/fixture\.kind invalid/);

    expect(() =>
      parseCompositionCatalog({
        schemaVersion: CATALOG_SCHEMA_VERSION,
        generatedAt: '2026-07-28T00:00:00.000Z',
        components: [
          {
            id: 'example-x',
            title: 'X',
            repo: 'example-x',
            packages: [],
            status: 'published',
            publishUsability: 'usable',
            summary: 'x',
            owns: [],
            refuses: [],
            dependencies: [],
            adapters: [],
            hostMustProvide: [],
            capabilityTags: ['not_a_tag'],
            recipeIds: [],
            links: { githubRepo: 'https://github.com/example/x' },
          },
        ],
        recipes: [],
      }),
    ).toThrow(/unknown capability tag/);
  });

  it('rejects malformed dependency entries', () => {
    expect(() =>
      parseCompositionCatalog({
        schemaVersion: CATALOG_SCHEMA_VERSION,
        generatedAt: '2026-07-28T00:00:00.000Z',
        components: [
          {
            id: 'example-x',
            title: 'X',
            repo: 'example-x',
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
            links: { githubRepo: 'https://github.com/example/x' },
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
      expect(Array.isArray(recipe.requiresPublished)).toBe(true);
      for (const id of recipe.requiresPublished) {
        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThan(0);
      }
      for (const adapter of recipe.adapters) {
        expect(adapter.componentId.length).toBeGreaterThan(0);
        expect(adapter.adapterId.length).toBeGreaterThan(0);
      }
    }
  });

  it('orders priority recipes ahead of deferred unpublished ones', () => {
    const catalog = loadExample();
    const byId = Object.fromEntries(catalog.recipes.map((r) => [r.id, r]));
    expect(byId['example-accounts']?.backlogPriority).toBe(1);
    expect(byId['example-outbox']?.backlogPriority).toBe(2);
    expect(byId['example-deferred']?.backlogPriority).toBeGreaterThan(2);
    expect(byId['example-deferred']?.fixture.status).toBe('none');
  });
});
