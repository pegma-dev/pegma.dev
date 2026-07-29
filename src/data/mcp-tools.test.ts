import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CompositionCatalog } from './catalog-schema';
import {
  getComponent,
  getRecipe,
  listComponents,
  listRecipes,
  planComposition,
} from './mcp-tools';

const here = dirname(fileURLToPath(import.meta.url));
const exampleCatalog = JSON.parse(
  readFileSync(join(here, '../../docs/catalog/example-catalog.json'), 'utf8'),
) as CompositionCatalog;

describe('mcp catalog tools (progressive disclosure)', () => {
  it('list_components returns compact rows only', () => {
    const rows = listComponents(exampleCatalog);
    expect(rows.length).toBe(exampleCatalog.components.length);
    expect(rows[0]).toMatchObject({
      id: 'example-contracts',
      title: 'Example Contracts',
      publishUsability: 'usable',
    });
    expect(rows[0]).not.toHaveProperty('owns');
    expect(rows[0]).not.toHaveProperty('refuses');
    expect(rows[0]).not.toHaveProperty('dependencies');
  });

  it('get_component returns full entry or null', () => {
    const full = getComponent(exampleCatalog, 'example-store');
    expect(full?.owns).toContain('Declared collections and single-partition transactions');
    expect(full?.adapters.length).toBeGreaterThan(0);
    expect(getComponent(exampleCatalog, 'missing')).toBeNull();
  });

  it('list_recipes and get_recipe', () => {
    const rows = listRecipes(exampleCatalog);
    expect(rows.map((r) => r.id)).toEqual([
      'example-accounts',
      'example-outbox',
      'example-deferred',
    ]);
    expect(rows[0]).not.toHaveProperty('antiPatterns');
    const full = getRecipe(exampleCatalog, 'example-outbox');
    expect(full?.antiPatterns.length).toBeGreaterThan(0);
    expect(getRecipe(exampleCatalog, 'nope')).toBeNull();
  });
});

describe('plan_composition', () => {
  it('returns empty when no tags', () => {
    const plan = planComposition(exampleCatalog, { capabilityTags: [] });
    expect(plan.components).toEqual([]);
    expect(plan.recipes).toEqual([]);
    expect(plan.notes[0]).toMatch(/No capabilityTags/);
  });

  it('scores storage recipes and omits non-overlapping deferred recipes', () => {
    // Example catalog fixtures are pending — inspect with productionOnly=false.
    const plan = planComposition(exampleCatalog, {
      capabilityTags: ['storage', 'audit', 'mail_transactional'],
      host: 'cloudflare',
      productionOnly: false,
    });
    expect(plan.schema).toBe('pegma.plan_composition.v1');
    // Primary is best tag overlap (outbox over accounts for these tags).
    expect(plan.recipes[0]?.id).toBe('example-outbox');
    // Deferred webhook recipe has no overlapping tags → not a candidate.
    expect(plan.recipes.map((r) => r.id)).not.toContain('example-deferred');
    expect(plan.components.some((c) => c.id === 'example-store')).toBe(true);
    // Dependency closure pulls example-contracts for example-store.
    expect(plan.components.some((c) => c.id === 'example-contracts')).toBe(true);
    expect(plan.packages.map((p) => p.name)).toEqual(
      expect.arrayContaining(['@example/store', '@example/contracts']),
    );
  });

  it('does not merge alternative recipes into the package plan', () => {
    const plan = planComposition(exampleCatalog, {
      capabilityTags: ['storage', 'cloudflare'],
      productionOnly: false,
    });
    // Both accounts and outbox may match storage+cloudflare; packages come
    // only from the primary recipe closure.
    expect(plan.recipes.length).toBeGreaterThan(1);
    expect(plan.notes.some((n) => n.startsWith('primary recipe:'))).toBe(true);
    expect(plan.notes.some((n) => n.includes('alternatives'))).toBe(true);
  });

  it('filters adapter packages by host', () => {
    const plan = planComposition(exampleCatalog, {
      capabilityTags: ['storage', 'cloudflare'],
      host: 'cloudflare',
      productionOnly: false,
    });
    // example-store has memory + cloud-sql (cloudflare) adapters.
    const names = plan.packages.map((p) => p.name);
    expect(names).toContain('@example/store-cloud');
    // Memory adapter package is still allowed; there is no azure adapter package
    // in the sample. Assert cloud-sql owner is present via primary recipe.
    expect(names).toEqual(expect.arrayContaining(['@example/store']));
  });

  it('skips unpublished webhook recipe under productionOnly', () => {
    const plan = planComposition(exampleCatalog, {
      capabilityTags: ['webhooks_inbound'],
      productionOnly: true,
    });
    expect(plan.recipes.map((r) => r.id)).not.toContain('example-deferred');
    expect(plan.skipped.some((s) => s.id === 'example-deferred')).toBe(true);
    expect(plan.components.some((c) => c.id === 'example-inbox')).toBe(false);
    expect(plan.skipped.some((s) => s.id === 'example-inbox')).toBe(true);
  });

  it('skips pending fixtures when productionOnly', () => {
    const plan = planComposition(exampleCatalog, {
      capabilityTags: ['storage', 'audit', 'mail_transactional'],
      productionOnly: true,
    });
    expect(plan.recipes).toEqual([]);
    expect(
      plan.skipped.some(
        (s) =>
          s.id === 'example-outbox' && s.reason.includes('fixture.status'),
      ),
    ).toBe(true);
  });

  it('includes unpublished when productionOnly=false', () => {
    const plan = planComposition(exampleCatalog, {
      capabilityTags: ['webhooks_inbound'],
      productionOnly: false,
    });
    expect(plan.components.some((c) => c.id === 'example-inbox')).toBe(true);
    expect(plan.recipes.some((r) => r.id === 'example-deferred')).toBe(true);
  });

  it('static_host prefers not recommending heavy stacks', () => {
    const plan = planComposition(exampleCatalog, {
      capabilityTags: ['static_host'],
    });
    // Example catalog has no static_host-tagged components; result may be empty
    // but must not recommend webhooks/inbox as the primary story.
    expect(plan.components.every((c) => c.id !== 'example-inbox')).toBe(true);
    expect(plan.notes.some((n) => n.includes('static_host'))).toBe(true);
  });

  it('accounts tags surface account-shaped recipe when fixtures may be pending', () => {
    const plan = planComposition(exampleCatalog, {
      capabilityTags: ['accounts', 'passkeys', 'cloudflare'],
      host: 'cloudflare',
      productionOnly: false,
    });
    expect(plan.recipes[0]?.id).toBe('example-accounts');
    // Closure + recipe packages include store deps, not only tag-matched roots.
    expect(plan.packages.map((p) => p.name)).toEqual(
      expect.arrayContaining([
        '@example/contracts',
        '@example/store',
        '@example/store-cloud',
      ]),
    );
  });

  it('production plans accept green fixtures and close deps', () => {
    const greenCatalog: CompositionCatalog = {
      ...exampleCatalog,
      recipes: exampleCatalog.recipes.map((r) =>
        r.id === 'example-outbox'
          ? {
              ...r,
              fixture: { ...r.fixture, status: 'green' as const },
            }
          : r,
      ),
    };
    const plan = planComposition(greenCatalog, {
      capabilityTags: ['storage', 'audit', 'mail_transactional'],
      productionOnly: true,
    });
    expect(plan.recipes.map((r) => r.id)).toEqual(['example-outbox']);
    expect(plan.packages.map((p) => p.name)).toEqual(
      expect.arrayContaining(['@example/store', '@example/contracts']),
    );
  });
});
