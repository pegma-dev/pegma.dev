/**
 * Composition catalog schema for agent-facing package selection and wiring.
 *
 * Phase 0 defines types only. Phase 1 emits a concrete `catalog.json` from the
 * component registry, plan aggregation, and published version facts.
 *
 * Design rules (docs/AGENT_ASSEMBLY_PLAN.md):
 * - Catalog is the source of truth; HTML, llms.txt, skill, and MCP are clients.
 * - Progressive disclosure: list → detail → recipe → fixture citation.
 * - Recipes are synthetic and must cite CI-tested fixtures when code is shown.
 * - Unpublished packages are unusable for production assembly.
 * - Exact 0.x pins when a version is known; never invent versions.
 */

/** Semver-ish schema id for the catalog document itself (not package versions). */
export const CATALOG_SCHEMA_VERSION = '0.1.0' as const;

export type CatalogComponentStatus =
  | 'published'
  | 'in_development'
  | 'planned';

/**
 * Whether agents may select this package for a production host assembly.
 * Distinct from component `status`: a component can be "in development" with
 * no npm packages, or published with some packages still missing.
 */
export type PublishUsability = 'usable' | 'unpublished' | 'partial';

/** How a dependency relates to another catalog component. */
export type DependencyKind =
  | 'requires'
  | 'optional'
  | 'composes_with';

/** Where a recipe's wiring sketch is allowed to come from. */
export type RecipeFixtureKind =
  | 'package_readme'
  | 'conformance'
  | 'recipe_package'
  | 'scaffold'
  | 'pending';

export type RecipeFixtureStatus = 'green' | 'pending' | 'none';

/**
 * Stable capability tags used by `plan_composition` (Phase 4) and the skill.
 * Prefer structured flags over free text so recommendations stay deterministic.
 */
export type CapabilityTag =
  | 'accounts'
  | 'passkeys'
  | 'email_codes'
  | 'sessions'
  | 'authorization'
  | 'storage'
  | 'audit'
  | 'mail_transactional'
  | 'rate_limit_durable'
  | 'rate_limit_memory'
  | 'webhooks_inbound'
  | 'support_queue'
  | 'health'
  | 'logging'
  | 'events_in_process'
  | 'cloudflare'
  | 'azure'
  | 'static_host';

export interface CatalogPackage {
  /** npm package name, e.g. `@pegma/spine` */
  readonly name: string;
  /**
   * Exact published version when known (e.g. `0.1.1`).
   * `null` means not published or version not yet resolved at compile time.
   */
  readonly version: string | null;
  /** False when the package must not be selected for production assembly. */
  readonly published: boolean;
  /** npm package page when published */
  readonly npmUrl?: string;
}

export interface CatalogDependency {
  /** Target component id (same as `CatalogComponent.id`) */
  readonly componentId: string;
  readonly kind: DependencyKind;
  /** Short note for agents — not a substitute for the README */
  readonly note?: string;
}

export interface CatalogAdapter {
  /** Stable id within the component, e.g. `cloudflare-d1` */
  readonly id: string;
  /** Implementing package when it exists */
  readonly packageName?: string;
  /** Hosting surface this adapter targets */
  readonly host: 'cloudflare' | 'azure' | 'memory' | 'other';
  /** When an agent should pick this adapter */
  readonly when: string;
}

export interface CatalogLinks {
  readonly githubRepo: string;
  readonly plan?: string;
  readonly readme?: string;
  /** Primary npm package URL when one package is the entry point */
  readonly npm?: string;
}

/**
 * One stack component in the composition catalog.
 * Extends the human registry (`PegmaComponent`) with agent-oriented fields.
 */
export interface CatalogComponent {
  /** Stable id; matches GitHub repo short name under pegma-dev by convention */
  readonly id: string;
  readonly title: string;
  readonly repo: string;
  readonly packages: readonly CatalogPackage[];
  readonly status: CatalogComponentStatus;
  /**
   * Aggregate publish signal for production assembly.
   * - usable: at least one core package is published with a pin
   * - unpublished: nothing agents should depend on yet
   * - partial: some packages published, others not (list them in packages[])
   */
  readonly publishUsability: PublishUsability;
  readonly summary: string;
  readonly owns: readonly string[];
  readonly refuses: readonly string[];
  /** Composition dependencies on other catalog components */
  readonly dependencies: readonly CatalogDependency[];
  /** Hosting adapters and when each applies */
  readonly adapters: readonly CatalogAdapter[];
  /** What the host application must supply (cookies, secrets, DNS, UI, …) */
  readonly hostMustProvide: readonly string[];
  readonly capabilityTags: readonly CapabilityTag[];
  /** Recipe ids that use this component */
  readonly recipeIds: readonly string[];
  readonly links: CatalogLinks;
  /**
   * Plain-language position from the hand registry / plan snapshot.
   * Prefer compiled `stage` from PROJECT_PLAN when Phase 1 has it.
   */
  readonly now?: string;
  /** Stage paragraph from plan aggregation when available */
  readonly stage?: string;
}

export interface RecipeFixtureCitation {
  readonly kind: RecipeFixtureKind;
  /**
   * Public path or URL agents can open. Must not point at private hosts
   * or commercial product internals.
   */
  readonly citation: string;
  readonly status: RecipeFixtureStatus;
}

/**
 * A named composition intent. Product shape is synthetic on purpose;
 * wiring sketches only appear when `fixture.status === 'green'`.
 */
export interface CatalogRecipe {
  readonly id: string;
  /** One-paragraph synthetic product shape — never a real commercial product */
  readonly intent: string;
  /** Package names (and optional pins once fixtures exist) */
  readonly packages: readonly string[];
  /** Adapter ids selected for this recipe */
  readonly adapters: readonly string[];
  readonly hostResponsibilities: readonly string[];
  readonly nonGoals: readonly string[];
  /** Anti-patterns agents must not invent */
  readonly antiPatterns: readonly string[];
  readonly fixture: RecipeFixtureCitation;
  readonly capabilityTags: readonly CapabilityTag[];
  /**
   * Component ids that must be publish-usable before this recipe is offered
   * for production assembly.
   */
  readonly requiresPublished: readonly string[];
  /**
   * Priority for the Phase 0 backlog (1 = ship first).
   * Omitted or zero in the compiled catalog once fixtures exist.
   */
  readonly backlogPriority?: number;
}

/**
 * Top-level machine-readable composition catalog.
 * Published at a stable URL in Phase 1 (static `catalog.json`).
 */
export interface CompositionCatalog {
  readonly schemaVersion: typeof CATALOG_SCHEMA_VERSION | string;
  /** ISO-8601 generation timestamp */
  readonly generatedAt: string;
  /** Calendar date of the hand-maintained registry snapshot when used as input */
  readonly snapshotDate?: string;
  readonly components: readonly CatalogComponent[];
  readonly recipes: readonly CatalogRecipe[];
}

/** Type guard helpers for compile and MCP validation (Phase 1+). */
export function isPublishUsable(component: CatalogComponent): boolean {
  return component.publishUsability === 'usable' || component.publishUsability === 'partial';
}

export function publishedPackageNames(
  component: CatalogComponent,
): readonly string[] {
  return component.packages.filter((p) => p.published && p.version).map((p) => p.name);
}
