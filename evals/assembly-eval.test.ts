import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { CompositionCatalog } from '../src/data/catalog-schema';
import { runAssemblyEval } from './assembly-eval';
import { ASSEMBLY_EVAL_CASES } from './assembly-cases';

/**
 * Prefer the live compiled shape when available; fall back to example catalog
 * enriched enough for identity/health tags via the real compile path is heavy
 * offline — tests use a minimal synthetic catalog that mirrors Pegma tags.
 */
function loadEvalCatalog(): CompositionCatalog {
  const here = dirname(fileURLToPath(import.meta.url));
  // Use the site's example only for schema shape; build a minimal Pegma-like set.
  const base = JSON.parse(
    readFileSync(
      join(here, '../docs/catalog/example-catalog.json'),
      'utf8',
    ),
  ) as CompositionCatalog;

  return {
    schemaVersion: '0.1.0',
    generatedAt: '2026-07-29T00:00:00.000Z',
    components: [
      {
        id: 'spine',
        title: 'Spine',
        repo: 'spine',
        packages: [
          { name: '@pegma/spine', version: '0.1.1', published: true },
        ],
        status: 'published',
        publishUsability: 'usable',
        summary: 'Shared contracts',
        owns: ['Logger', 'Clock'],
        refuses: ['Durable cross-process events on an in-process bus'],
        dependencies: [],
        adapters: [],
        hostMustProvide: ['Composition root'],
        capabilityTags: ['logging', 'events_in_process'],
        recipeIds: [],
        links: { githubRepo: 'https://github.com/pegma-dev/spine' },
      },
      {
        id: 'identity',
        title: 'Identity',
        repo: 'identity',
        packages: [
          { name: '@pegma/identity', version: '0.1.0', published: true },
        ],
        status: 'published',
        publishUsability: 'usable',
        summary: 'Passkeys-first identity',
        owns: ['Passkeys', 'Email codes'],
        refuses: ['Passwords — a refusal, not a phase'],
        dependencies: [
          { componentId: 'spine', kind: 'requires' },
        ],
        adapters: [],
        hostMustProvide: ['HTTP', 'WebAuthn'],
        capabilityTags: [
          'accounts',
          'passkeys',
          'email_codes',
          'sessions',
          'authorization',
          'mail_transactional',
        ],
        recipeIds: ['cf-passkey-accounts'],
        links: { githubRepo: 'https://github.com/pegma-dev/identity' },
      },
      {
        id: 'health',
        title: 'Health',
        repo: 'health',
        packages: [
          { name: '@pegma/health', version: '0.1.1', published: true },
        ],
        status: 'published',
        publishUsability: 'usable',
        summary: 'Liveness probes',
        owns: ['Health checks'],
        refuses: ['APM and traces'],
        dependencies: [{ componentId: 'spine', kind: 'requires' }],
        adapters: [],
        hostMustProvide: ['HTTP route'],
        capabilityTags: ['health'],
        recipeIds: [],
        links: { githubRepo: 'https://github.com/pegma-dev/health' },
      },
      {
        id: 'storage-core',
        title: 'Storage Core',
        repo: 'storage-core',
        packages: [
          { name: '@pegma/storage-core', version: '0.4.0', published: true },
          {
            name: '@pegma/storage-cloudflare-d1',
            version: '0.4.0',
            published: true,
          },
        ],
        status: 'published',
        publishUsability: 'usable',
        summary: 'Declared collections',
        owns: ['Transactions'],
        refuses: ['Cross-partition transactions'],
        dependencies: [{ componentId: 'spine', kind: 'requires' }],
        adapters: [
          {
            id: 'cloudflare-d1',
            packageName: '@pegma/storage-cloudflare-d1',
            host: 'cloudflare',
            when: 'Workers D1',
          },
        ],
        hostMustProvide: ['Adapter binding'],
        capabilityTags: ['storage', 'cloudflare'],
        recipeIds: [],
        links: { githubRepo: 'https://github.com/pegma-dev/storage-core' },
      },
      {
        id: 'sessions',
        title: 'Sessions',
        repo: 'sessions',
        packages: [
          { name: '@pegma/sessions', version: '0.1.0', published: true },
        ],
        status: 'published',
        publishUsability: 'usable',
        summary: 'Server sessions',
        owns: ['Session records'],
        refuses: ['Browser session storage as the server session'],
        dependencies: [
          { componentId: 'spine', kind: 'requires' },
          { componentId: 'storage-core', kind: 'requires' },
        ],
        adapters: [],
        hostMustProvide: ['Cookie boundary'],
        capabilityTags: ['sessions'],
        recipeIds: [],
        links: { githubRepo: 'https://github.com/pegma-dev/sessions' },
      },
      {
        id: 'mail',
        title: 'Mail',
        repo: 'mail',
        packages: [
          { name: '@pegma/mail', version: '0.1.0', published: true },
        ],
        status: 'published',
        publishUsability: 'usable',
        summary: 'Transactional mail outbox',
        owns: ['Outbox jobs'],
        refuses: ['Owning its own store'],
        dependencies: [
          { componentId: 'spine', kind: 'requires' },
          { componentId: 'storage-core', kind: 'requires' },
        ],
        adapters: [],
        hostMustProvide: ['Provider'],
        capabilityTags: ['mail_transactional'],
        recipeIds: [],
        links: { githubRepo: 'https://github.com/pegma-dev/mail' },
      },
    ],
    recipes: [
      {
        id: 'cf-passkey-accounts',
        intent: base.recipes[0]?.intent ?? 'accounts',
        packages: [
          '@pegma/identity@0.1.0',
          '@pegma/sessions@0.1.0',
          '@pegma/mail@0.1.0',
          '@pegma/spine@0.1.1',
        ],
        adapters: [],
        hostResponsibilities: ['HTTP'],
        nonGoals: ['Passwords'],
        antiPatterns: ['Password table'],
        fixture: {
          kind: 'recipe_package',
          citation: 'recipes/cf-passkey-accounts',
          status: 'green',
        },
        capabilityTags: [
          'accounts',
          'passkeys',
          'email_codes',
          'sessions',
          'authorization',
          'mail_transactional',
          'cloudflare',
        ],
        requiresPublished: ['identity', 'sessions', 'mail', 'spine'],
        backlogPriority: 1,
      },
      {
        id: 'scaffold-cf-minimal',
        intent: 'Glass Wing static scaffold',
        packages: ['@pegma/spine@0.1.1', '@pegma/health@0.1.1'],
        adapters: [],
        hostResponsibilities: ['Worker fetch'],
        nonGoals: ['Accounts'],
        antiPatterns: ['Pulling identity for later'],
        fixture: {
          kind: 'scaffold',
          citation: 'recipes/scaffold-cf-minimal',
          status: 'green',
        },
        capabilityTags: ['static_host', 'health', 'cloudflare'],
        requiresPublished: ['spine', 'health'],
        backlogPriority: 6,
      },
    ],
  };
}

describe('assembly eval harness (Phase 5)', () => {
  it('defines the plan prompt set', () => {
    expect(ASSEMBLY_EVAL_CASES.map((c) => c.id).sort()).toEqual(
      [
        'health-endpoint-only',
        'no-passwords',
        'passkey-accounts-workers',
        'static-brochure',
      ].sort(),
    );
  });

  it('baseline (no catalog) scores 0', () => {
    const report = runAssemblyEval(null, 'baseline');
    expect(report.passRate).toBe(0);
    expect(report.passed).toBe(0);
    expect(report.total).toBe(ASSEMBLY_EVAL_CASES.length);
  });

  it('catalog planner improves pass rate over baseline', () => {
    const catalog = loadEvalCatalog();
    const baseline = runAssemblyEval(null, 'baseline');
    const withCatalog = runAssemblyEval(catalog, 'catalog');
    expect(withCatalog.passRate).toBeGreaterThan(baseline.passRate);
    expect(withCatalog.passed).toBeGreaterThan(0);
    // All four cases should pass on the synthetic Pegma-shaped catalog.
    expect(withCatalog.passRate).toBe(1);
    for (const c of withCatalog.cases) {
      expect(c.pass, `${c.id}: ${JSON.stringify(c.checks)}`).toBe(true);
    }
  });
});
