import { describe, expect, it, beforeAll } from 'vitest';
import {
  clearNpmVersionCache,
  compileCompositionCatalog,
} from '../src/data/compile-catalog';
import { components } from '../src/data/components';
import type { CompositionCatalog } from '../src/data/catalog-schema';
import { runAssemblyEval } from './assembly-eval';
import { ASSEMBLY_EVAL_CASES } from './assembly-cases';

const FIXED_AT = '2026-07-29T12:00:00.000Z';
const NO_STAGES: Record<string, string | null> = Object.fromEntries(
  components.map((c) => [c.repo, null]),
);

/**
 * Deterministic npm pins matching known-good published versions used by
 * recipe backlog pins and the site worker. Never hits the network.
 */
const EVAL_NPM: Record<string, string | null> = {
  '@pegma/spine': '0.1.1',
  '@pegma/storage-core': '0.4.0',
  '@pegma/storage-azure-tables': '0.4.0',
  '@pegma/storage-cloudflare-d1': '0.4.0',
  '@pegma/storage-blobs': '0.1.0',
  '@pegma/storage-azure-blob': '0.1.0',
  '@pegma/storage-cloudflare-r2': '0.1.0',
  '@pegma/storage-s3': '0.1.0',
  '@pegma/authorization-contracts': '0.1.2',
  '@pegma/authorization-core': '0.1.2',
  '@pegma/authorization-policy': '0.1.2',
  '@pegma/authorization-auth0': '0.1.2',
  '@pegma/authorization-stripe': '0.1.2',
  '@pegma/authorization-storage': '0.1.2',
  '@pegma/authorization-tokens': '0.1.2',
  '@pegma/authorization-identity': '0.1.2',
  '@pegma/audit': '0.1.0',
  '@pegma/support-desk-contracts': '0.1.0',
  '@pegma/support-desk-core': '0.1.0',
  '@pegma/support-desk-application': '0.1.0',
  '@pegma/support-desk-templates': '0.1.0',
  '@pegma/webhooks': null, // unpublished for production assembly
  '@pegma/sessions': '0.1.0',
  '@pegma/mail': '0.1.0',
  '@pegma/billing-core': null,
  '@pegma/identity': '0.1.0',
  '@pegma/rate-limit': '0.1.0',
  '@pegma/logger-tee': '0.1.1',
  '@pegma/logger-applicationinsights': '0.1.1',
  '@pegma/logger-cloudflare': '0.1.1',
  '@pegma/logger-datadog': '0.1.1',
  '@pegma/health': '0.1.1',
};

async function compileEvalCatalog(): Promise<CompositionCatalog> {
  clearNpmVersionCache();
  return compileCompositionCatalog({
    generatedAt: FIXED_AT,
    stageByRepo: NO_STAGES,
    npmLookup: async (name) =>
      Object.prototype.hasOwnProperty.call(EVAL_NPM, name)
        ? EVAL_NPM[name]!
        : null,
  });
}

describe('assembly eval harness (Phase 5)', () => {
  let catalog: CompositionCatalog;

  beforeAll(async () => {
    catalog = await compileEvalCatalog();
  });

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

  it('compiles the real catalog artifact (not a hand-built twin)', () => {
    expect(catalog.schemaVersion).toBe('0.1.0');
    expect(catalog.components.length).toBe(components.length);
    const scaffold = catalog.recipes.find((r) => r.id === 'static-brochure-minimal');
    expect(scaffold?.fixture.status).toBe('green');
    expect(scaffold?.fixture.citation).toContain('scaffold-cf-minimal');
    expect(scaffold?.capabilityTags).toEqual(['static_host']);
    expect(scaffold?.capabilityTags).not.toContain('health');
    expect(scaffold?.capabilityTags).not.toContain('cloudflare');
  });

  it('baseline scores assertions against an empty plan (not forced all-fail)', () => {
    const report = runAssemblyEval(null, 'baseline');
    // Static brochure may pass (must-not-include only); include cases fail.
    const byId = Object.fromEntries(report.cases.map((c) => [c.id, c]));
    expect(byId['static-brochure']?.pass).toBe(true);
    expect(byId['passkey-accounts-workers']?.pass).toBe(false);
    expect(byId['health-endpoint-only']?.pass).toBe(false);
    expect(byId['no-passwords']?.pass).toBe(false);
    expect(report.passRate).toBeGreaterThan(0);
    expect(report.passRate).toBeLessThan(1);
  });

  it('catalog planner improves pass rate over baseline on compiled catalog', () => {
    const baseline = runAssemblyEval(null, 'baseline');
    const withCatalog = runAssemblyEval(catalog, 'catalog');
    expect(withCatalog.passRate).toBeGreaterThan(baseline.passRate);
    for (const c of withCatalog.cases) {
      expect(c.pass, `${c.id}: ${JSON.stringify(c.checks)}`).toBe(true);
    }
    expect(withCatalog.passRate).toBe(1);

    const staticCase = withCatalog.cases.find((c) => c.id === 'static-brochure')!;
    expect(staticCase.primaryRecipeId).toBe('static-brochure-minimal');

    const healthCase = withCatalog.cases.find((c) => c.id === 'health-endpoint-only')!;
    expect(healthCase.primaryRecipeId).not.toBe('static-brochure-minimal');
    expect(healthCase.packageNames.some((p) => p.includes('@pegma/health'))).toBe(
      true,
    );
  });
});
