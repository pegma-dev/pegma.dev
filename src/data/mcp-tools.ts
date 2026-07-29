/**
 * Progressive-disclosure catalog tools for the public MCP surface (Phase 4).
 *
 * Pure functions over a CompositionCatalog — no network, no private data.
 * Transports (MCP, future clients) call these; they do not invent package facts.
 */

import {
  isPublishUsable,
  parsePackageSpecifier,
  recipePackagesReady,
  type CapabilityTag,
  type CatalogComponent,
  type CatalogRecipe,
  type CompositionCatalog,
} from './catalog-schema';

/** List row: minimum fields for the next selection decision. */
export interface ComponentListItem {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly status: CatalogComponent['status'];
  readonly publishUsability: CatalogComponent['publishUsability'];
  readonly packages: readonly {
    readonly name: string;
    readonly version: string | null;
    readonly published: boolean;
  }[];
  readonly capabilityTags: readonly CapabilityTag[];
}

/** List row for recipes: intent + package set, not full wiring. */
export interface RecipeListItem {
  readonly id: string;
  readonly intent: string;
  readonly packages: readonly string[];
  readonly fixtureStatus: CatalogRecipe['fixture']['status'];
  readonly capabilityTags: readonly CapabilityTag[];
  readonly backlogPriority?: number;
}

export interface PlanCompositionInput {
  /** Structured capability tags from the catalog schema (not free text). */
  readonly capabilityTags: readonly CapabilityTag[];
  /** Prefer adapters for this host when set. */
  readonly host?: 'cloudflare' | 'azure' | 'memory' | 'other';
  /**
   * When true (default), omit unpublished components and recipes whose
   * required packages are not production-ready.
   */
  readonly productionOnly?: boolean;
}

export interface PlanCompositionResult {
  readonly schema: 'pegma.plan_composition.v1';
  readonly catalogGeneratedAt: string;
  readonly requested: {
    readonly capabilityTags: readonly CapabilityTag[];
    readonly host?: PlanCompositionInput['host'];
    readonly productionOnly: boolean;
  };
  readonly components: readonly ComponentListItem[];
  readonly recipes: readonly RecipeListItem[];
  readonly packages: readonly {
    readonly name: string;
    readonly version: string | null;
    readonly published: boolean;
    readonly componentId: string;
  }[];
  readonly notes: readonly string[];
  readonly skipped: readonly {
    readonly id: string;
    readonly kind: 'component' | 'recipe';
    readonly reason: string;
  }[];
}

function tagOverlap(
  a: readonly CapabilityTag[],
  b: readonly CapabilityTag[],
): number {
  if (a.length === 0 || b.length === 0) return 0;
  const set = new Set(b);
  let n = 0;
  for (const t of a) {
    if (set.has(t)) n += 1;
  }
  return n;
}

function toComponentListItem(c: CatalogComponent): ComponentListItem {
  return {
    id: c.id,
    title: c.title,
    summary: c.summary,
    status: c.status,
    publishUsability: c.publishUsability,
    packages: c.packages.map((p) => ({
      name: p.name,
      version: p.version,
      published: p.published,
    })),
    capabilityTags: c.capabilityTags,
  };
}

function toRecipeListItem(r: CatalogRecipe): RecipeListItem {
  return {
    id: r.id,
    intent: r.intent,
    packages: r.packages,
    fixtureStatus: r.fixture.status,
    capabilityTags: r.capabilityTags,
    ...(r.backlogPriority !== undefined
      ? { backlogPriority: r.backlogPriority }
      : {}),
  };
}

/** list_components — id, summary, status, packages (progressive disclosure). */
export function listComponents(
  catalog: CompositionCatalog,
): readonly ComponentListItem[] {
  return catalog.components.map(toComponentListItem);
}

/** get_component — full catalog entry or null when unknown. */
export function getComponent(
  catalog: CompositionCatalog,
  id: string,
): CatalogComponent | null {
  return catalog.components.find((c) => c.id === id) ?? null;
}

/** list_recipes — id, intent, package set. */
export function listRecipes(
  catalog: CompositionCatalog,
): readonly RecipeListItem[] {
  return catalog.recipes.map(toRecipeListItem);
}

/** get_recipe — full recipe metadata + fixture citation. */
export function getRecipe(
  catalog: CompositionCatalog,
  id: string,
): CatalogRecipe | null {
  return catalog.recipes.find((r) => r.id === id) ?? null;
}

/**
 * plan_composition — deterministic recommendation from structured tags + host.
 * Rule-based only; not an LLM. Scores recipes/components by capability overlap.
 */
export function planComposition(
  catalog: CompositionCatalog,
  input: PlanCompositionInput,
): PlanCompositionResult {
  const productionOnly = input.productionOnly !== false;
  const requestedTags = input.capabilityTags;
  const notes: string[] = [];
  const skipped: PlanCompositionResult['skipped'][number][] = [];

  if (requestedTags.length === 0) {
    notes.push(
      'No capabilityTags provided — return empty recommendations. Pass structured tags from the catalog schema.',
    );
    return {
      schema: 'pegma.plan_composition.v1',
      catalogGeneratedAt: catalog.generatedAt,
      requested: {
        capabilityTags: requestedTags,
        host: input.host,
        productionOnly,
      },
      components: [],
      recipes: [],
      packages: [],
      notes,
      skipped,
    };
  }

  // Static-only intent: prefer not recommending accounts/storage stack.
  const onlyStatic =
    requestedTags.length === 1 && requestedTags[0] === 'static_host';

  type ScoredComponent = {
    component: CatalogComponent;
    score: number;
  };
  const scoredComponents: ScoredComponent[] = [];

  for (const c of catalog.components) {
    let score = tagOverlap(c.capabilityTags, requestedTags);
    if (score === 0) continue;

    if (productionOnly && c.publishUsability === 'unpublished') {
      skipped.push({
        id: c.id,
        kind: 'component',
        reason: 'publishUsability=unpublished',
      });
      continue;
    }

    // Soft boost when the component has an adapter for the requested host.
    if (
      input.host &&
      c.adapters.some((a) => a.host === input.host)
    ) {
      score += 0.25;
    }

    if (onlyStatic) {
      // static_host intent: never recommend heavy stacks, even if a component
      // also carries the static_host tag alongside accounts/storage/etc.
      const heavy = c.capabilityTags.some((t) =>
        (
          [
            'accounts',
            'passkeys',
            'email_codes',
            'sessions',
            'storage',
            'mail_transactional',
            'webhooks_inbound',
            'support_queue',
          ] as CapabilityTag[]
        ).includes(t),
      );
      if (heavy) {
        skipped.push({
          id: c.id,
          kind: 'component',
          reason: 'static_host intent — skipped heavy capability component',
        });
        continue;
      }
    }

    scoredComponents.push({ component: c, score });
  }

  scoredComponents.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.component.id.localeCompare(b.component.id);
  });

  type ScoredRecipe = { recipe: CatalogRecipe; score: number };
  const scoredRecipes: ScoredRecipe[] = [];

  for (const r of catalog.recipes) {
    const score = tagOverlap(r.capabilityTags, requestedTags);
    if (score === 0) continue;

    if (productionOnly) {
      if (r.fixture.status !== 'green') {
        skipped.push({
          id: r.id,
          kind: 'recipe',
          reason: `fixture.status=${r.fixture.status} (production plans require green fixtures)`,
        });
        continue;
      }
      const missingReq = r.requiresPublished.filter((id) => {
        const comp = catalog.components.find((c) => c.id === id);
        return !comp || !isPublishUsable(comp);
      });
      if (missingReq.length > 0) {
        skipped.push({
          id: r.id,
          kind: 'recipe',
          reason: `requiresPublished not usable: ${missingReq.join(', ')}`,
        });
        continue;
      }
      if (!recipePackagesReady(catalog, r)) {
        skipped.push({
          id: r.id,
          kind: 'recipe',
          reason: 'recipe packages not published with pins',
        });
        continue;
      }
    }

    if (input.host) {
      const adapterHosts = r.adapters
        .map((ref) => {
          const comp = catalog.components.find((c) => c.id === ref.componentId);
          return comp?.adapters.find((a) => a.id === ref.adapterId)?.host;
        })
        .filter((h): h is NonNullable<typeof h> => Boolean(h));
      if (
        adapterHosts.length > 0 &&
        !adapterHosts.includes(input.host) &&
        !adapterHosts.includes('memory')
      ) {
        // Soft demote: still include but lower score for host mismatch.
        scoredRecipes.push({ recipe: r, score: score - 0.5 });
        continue;
      }
    }

    scoredRecipes.push({ recipe: r, score });
  }

  scoredRecipes.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Prefer green fixtures, then backlog priority (lower = first).
    const fixtureRank = (s: CatalogRecipe['fixture']['status']) =>
      s === 'green' ? 0 : s === 'pending' ? 1 : 2;
    const fr = fixtureRank(a.recipe.fixture.status) - fixtureRank(b.recipe.fixture.status);
    if (fr !== 0) return fr;
    const pa = a.recipe.backlogPriority ?? 999;
    const pb = b.recipe.backlogPriority ?? 999;
    if (pa !== pb) return pa - pb;
    return a.recipe.id.localeCompare(b.recipe.id);
  });

  const selectedRecipes = scoredRecipes.map((s) => s.recipe);

  // Close the plan over required component dependencies and recipe package
  // owners so agents get a buildable package set, not only tag-matched roots.
  const componentById = new Map(
    catalog.components.map((c) => [c.id, c] as const),
  );
  const closed = new Map<string, CatalogComponent>();
  for (const s of scoredComponents) {
    closed.set(s.component.id, s.component);
  }

  const queue: string[] = [...closed.keys()];
  while (queue.length > 0) {
    const id = queue.pop()!;
    const comp = componentById.get(id);
    if (!comp) continue;
    for (const dep of comp.dependencies) {
      if (dep.kind !== 'requires') continue;
      if (closed.has(dep.componentId)) continue;
      const depComp = componentById.get(dep.componentId);
      if (!depComp) {
        notes.push(
          `missing required dependency ${dep.componentId} referenced by ${id}`,
        );
        continue;
      }
      if (productionOnly && depComp.publishUsability === 'unpublished') {
        skipped.push({
          id: depComp.id,
          kind: 'component',
          reason: `required by ${id} but publishUsability=unpublished`,
        });
        continue;
      }
      closed.set(depComp.id, depComp);
      queue.push(depComp.id);
    }
  }

  // Recipe package owners and requiresPublished also enter the closure.
  for (const r of selectedRecipes) {
    for (const reqId of r.requiresPublished) {
      if (closed.has(reqId)) continue;
      const depComp = componentById.get(reqId);
      if (!depComp) continue;
      if (productionOnly && depComp.publishUsability === 'unpublished') continue;
      closed.set(depComp.id, depComp);
      queue.push(depComp.id);
    }
    for (const spec of r.packages) {
      const { name } = parsePackageSpecifier(spec);
      const owner = catalog.components.find((c) =>
        c.packages.some((p) => p.name === name),
      );
      if (!owner || closed.has(owner.id)) continue;
      if (productionOnly && owner.publishUsability === 'unpublished') continue;
      closed.set(owner.id, owner);
      queue.push(owner.id);
    }
  }

  // Drain any deps discovered from recipe expansion.
  while (queue.length > 0) {
    const id = queue.pop()!;
    const comp = componentById.get(id);
    if (!comp) continue;
    for (const dep of comp.dependencies) {
      if (dep.kind !== 'requires') continue;
      if (closed.has(dep.componentId)) continue;
      const depComp = componentById.get(dep.componentId);
      if (!depComp) continue;
      if (productionOnly && depComp.publishUsability === 'unpublished') {
        skipped.push({
          id: depComp.id,
          kind: 'component',
          reason: `required by ${id} but publishUsability=unpublished`,
        });
        continue;
      }
      closed.set(depComp.id, depComp);
      queue.push(depComp.id);
    }
  }

  const selectedComponents = [...closed.values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  );

  // Packages from closed components plus explicit recipe package pins.
  const packages: PlanCompositionResult['packages'][number][] = [];
  const seenPkg = new Set<string>();
  const pushPkg = (
    name: string,
    version: string | null,
    published: boolean,
    componentId: string,
  ) => {
    if (productionOnly && !published) return;
    const key = `${componentId}::${name}`;
    if (seenPkg.has(key)) return;
    seenPkg.add(key);
    packages.push({ name, version, published, componentId });
  };

  for (const c of selectedComponents) {
    for (const p of c.packages) {
      pushPkg(p.name, p.version, p.published, c.id);
    }
  }

  for (const r of selectedRecipes) {
    for (const spec of r.packages) {
      const { name, version: pinned } = parsePackageSpecifier(spec);
      const owner = catalog.components.find((c) =>
        c.packages.some((p) => p.name === name),
      );
      if (!owner) continue;
      const pkg = owner.packages.find((p) => p.name === name);
      if (!pkg) continue;
      pushPkg(
        pkg.name,
        pinned && pinned.length > 0 ? pinned : pkg.version,
        pkg.published,
        owner.id,
      );
    }
  }

  // Host-specific adapter hints.
  if (input.host) {
    for (const c of selectedComponents) {
      const match = c.adapters.filter((a) => a.host === input.host);
      if (match.length > 0) {
        notes.push(
          `${c.id}: prefer adapter(s) ${match.map((a) => a.id).join(', ')} for host=${input.host}`,
        );
      }
    }
  }

  // Surface refusals for selected components (hard constraints).
  for (const c of selectedComponents.slice(0, 12)) {
    if (c.refuses.length > 0) {
      notes.push(`${c.id} refuses: ${c.refuses.join('; ')}`);
    }
  }

  for (const r of selectedRecipes.slice(0, 5)) {
    if (r.antiPatterns.length > 0) {
      notes.push(`recipe ${r.id} anti-patterns: ${r.antiPatterns.join('; ')}`);
    }
    if (r.fixture.status !== 'green') {
      notes.push(
        `recipe ${r.id} fixture is ${r.fixture.status} — do not invent wiring; use component READMEs until green`,
      );
    }
  }

  if (onlyStatic) {
    notes.push(
      'static_host intent: prefer empty composition (no accounts/storage/mail) unless a Worker health probe is required.',
    );
  }

  if (productionOnly) {
    notes.push(
      'productionOnly=true: unpublished packages and incomplete recipes were skipped. Set productionOnly=false to inspect them.',
    );
  }

  notes.push(
    'Pin exact versions from the catalog. Wire at an explicit composition root. Re-fetch catalog.json when package facts may have changed.',
  );

  return {
    schema: 'pegma.plan_composition.v1',
    catalogGeneratedAt: catalog.generatedAt,
    requested: {
      capabilityTags: requestedTags,
      host: input.host,
      productionOnly,
    },
    components: selectedComponents.map(toComponentListItem),
    recipes: selectedRecipes.map(toRecipeListItem),
    packages,
    notes,
    skipped,
  };
}

/** Capability tags accepted by plan_composition (mirrors schema). */
export const CAPABILITY_TAGS = [
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
] as const satisfies readonly CapabilityTag[];
