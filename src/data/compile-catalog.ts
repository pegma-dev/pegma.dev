/**
 * Build-time composition catalog compiler.
 *
 * Inputs: component registry, plan stage aggregation, npm latest versions,
 * hand enrichment, recipe backlog.
 *
 * Version authority (Phase 0 decision): npm at compile time for package pins.
 * Never parse versions from registry `now` prose. Fail soft: missing npm →
 * version null + published false.
 */

import { components, SNAPSHOT_DATE, type ComponentStatus } from './components';
import { enrichmentFor } from './catalog-enrichment';
import { RECIPE_BACKLOG } from './recipe-backlog';
import { compileComponentStatus } from './live-status';
import {
  CATALOG_SCHEMA_VERSION,
  type CatalogComponent,
  type CatalogComponentStatus,
  type CatalogPackage,
  type CompositionCatalog,
  type PublishUsability,
} from './catalog-schema';

export interface NpmVersionLookup {
  (packageName: string): Promise<string | null>;
}

const npmCache = new Map<string, Promise<string | null>>();

/** Default: fetch latest from the public npm registry (build-time only). */
export async function fetchNpmLatestVersion(
  packageName: string,
): Promise<string | null> {
  let hit = npmCache.get(packageName);
  if (!hit) {
    hit = (async () => {
      try {
        const url = `https://registry.npmjs.org/${packageName}/latest`;
        const res = await fetch(url, {
          cache: 'no-store',
          headers: {
            Accept: 'application/json',
            'User-Agent': 'pegma-dev-catalog-build',
          },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return null;
        const body: unknown = await res.json();
        if (
          body &&
          typeof body === 'object' &&
          typeof (body as { version?: unknown }).version === 'string'
        ) {
          return (body as { version: string }).version;
        }
        return null;
      } catch {
        return null;
      }
    })();
    npmCache.set(packageName, hit);
  }
  return hit;
}

/** Test helper — clear npm cache between tests. */
export function clearNpmVersionCache(): void {
  npmCache.clear();
}

function mapStatus(status: ComponentStatus): CatalogComponentStatus {
  switch (status) {
    case 'published':
      return 'published';
    case 'in development':
      return 'in_development';
    case 'planned':
      return 'planned';
  }
}

function publishUsability(packages: readonly CatalogPackage[]): PublishUsability {
  if (packages.length === 0) return 'unpublished';
  const publishedCount = packages.filter((p) => p.published && p.version).length;
  if (publishedCount === 0) return 'unpublished';
  if (publishedCount === packages.length) return 'usable';
  return 'partial';
}

async function resolvePackages(
  names: readonly string[],
  lookup: NpmVersionLookup,
): Promise<CatalogPackage[]> {
  // Parallel lookups: independent packages must not serialize 10s timeouts.
  return Promise.all(
    names.map(async (name) => {
      const version = await lookup(name);
      const published = version !== null;
      return {
        name,
        version,
        published,
        ...(published
          ? { npmUrl: `https://www.npmjs.com/package/${name}` }
          : {}),
      };
    }),
  );
}

export interface CompileCatalogOptions {
  readonly npmLookup?: NpmVersionLookup;
  readonly generatedAt?: string;
  /**
   * When set, used instead of live plan fetches (unit tests).
   * Values are stage paragraphs or null when the plan is unavailable.
   */
  readonly stageByRepo?: Readonly<Record<string, string | null>>;
}

/**
 * Compile the full composition catalog for static publish.
 */
export async function compileCompositionCatalog(
  options: CompileCatalogOptions = {},
): Promise<CompositionCatalog> {
  const npmLookup = options.npmLookup ?? fetchNpmLatestVersion;
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  const compiled =
    options.stageByRepo !== undefined
      ? components.map((component) => ({
          ...component,
          stage: options.stageByRepo![component.repo] ?? null,
          // Keep registry status when stages are injected (tests).
          status: component.status,
        }))
      : await Promise.all(components.map(compileComponentStatus));
  const catalogComponents: CatalogComponent[] = [];

  // Resolve every component’s packages concurrently (npm lookups are independent).
  const resolved = await Promise.all(
    compiled.map(async (component) => {
      const packages = await resolvePackages(component.packages, npmLookup);
      return { component, packages };
    }),
  );

  for (const { component, packages } of resolved) {
    const id = component.repo;
    const enrichment = enrichmentFor(id);
    const usability = publishUsability(packages);
    const recipeIds = RECIPE_BACKLOG.filter(
      (r) =>
        r.requiresPublished.includes(id) ||
        r.packages.some((spec) =>
          packages.some((p) => spec === p.name || spec.startsWith(`${p.name}@`)),
        ),
    ).map((r) => r.id);

    const firstPublished = packages.find((p) => p.published)?.name;

    catalogComponents.push({
      id,
      title: component.title,
      repo: component.repo,
      packages,
      status: mapStatus(component.status),
      publishUsability: usability,
      summary: component.summary,
      owns: component.owns,
      refuses: component.refuses,
      dependencies: enrichment.dependencies,
      adapters: enrichment.adapters,
      hostMustProvide: enrichment.hostMustProvide,
      capabilityTags: enrichment.capabilityTags,
      recipeIds,
      links: {
        githubRepo: `https://github.com/pegma-dev/${component.repo}`,
        ...(component.plan
          ? {
              plan: `https://github.com/pegma-dev/${component.repo}/blob/main/${component.plan}`,
            }
          : {}),
        readme: `https://github.com/pegma-dev/${component.repo}#readme`,
        ...(firstPublished
          ? { npm: `https://www.npmjs.com/package/${firstPublished}` }
          : {}),
      },
      now: component.now,
      ...(component.stage ? { stage: component.stage } : {}),
    });
  }

  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    generatedAt,
    snapshotDate: SNAPSHOT_DATE,
    components: catalogComponents,
    recipes: RECIPE_BACKLOG,
  };
}
