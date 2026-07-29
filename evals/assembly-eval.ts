/**
 * Offline eval runner: score plan_composition against ASSEMBLY_EVAL_CASES.
 *
 * - catalog mode: planComposition over a CompositionCatalog
 * - baseline mode: empty package set + no refuse notes (agent never fetched
 *   the catalog). Same assertions as catalog mode — not a forced all-fail.
 */

import type { CompositionCatalog } from '../src/data/catalog-schema';
import { planComposition } from '../src/data/mcp-tools';
import {
  ASSEMBLY_EVAL_CASES,
  type AssemblyEvalCase,
} from './assembly-cases';

export interface CaseScore {
  readonly id: string;
  readonly pass: boolean;
  readonly checks: readonly {
    readonly name: string;
    readonly pass: boolean;
    readonly detail?: string;
  }[];
  readonly packageNames: readonly string[];
  readonly primaryRecipeId: string | null;
}

export interface EvalReport {
  readonly schema: 'pegma.assembly_eval.v1';
  readonly mode: 'baseline' | 'catalog';
  readonly total: number;
  readonly passed: number;
  readonly passRate: number;
  readonly cases: readonly CaseScore[];
}

function primaryRecipeIdFromNotes(notes: readonly string[]): string | null {
  for (const n of notes) {
    const m = /^primary recipe:\s*([^\s;]+)/.exec(n);
    if (m) return m[1] ?? null;
  }
  return null;
}

function scoreAssertions(
  c: AssemblyEvalCase,
  packageNames: readonly string[],
  refuseBlob: string,
  primaryRecipeId: string | null,
  mode: 'baseline' | 'catalog',
): CaseScore['checks'][number][] {
  const checks: CaseScore['checks'][number][] = [];

  for (const name of c.mustIncludePackageNames ?? []) {
    const pass = packageNames.some((p) => p.includes(name) || p === name);
    checks.push({
      name: `must_include:${name}`,
      pass,
      detail: pass ? undefined : `packages=${packageNames.join(',')}`,
    });
  }

  for (const name of c.mustNotIncludePackageNames ?? []) {
    const pass = !packageNames.some((p) => p.includes(name) || p === name);
    checks.push({
      name: `must_not_include:${name}`,
      pass,
      detail: pass ? undefined : `found in ${packageNames.join(',')}`,
    });
  }

  for (const sub of c.mustNotRecommendSubstrings ?? []) {
    const lower = sub.toLowerCase();
    const pass = !packageNames.some((p) => p.toLowerCase().includes(lower));
    checks.push({
      name: `must_not_recommend_substring:${sub}`,
      pass,
    });
  }

  for (const sub of c.mustSurfaceRefusalSubstrings ?? []) {
    const pass = refuseBlob.toLowerCase().includes(sub.toLowerCase());
    checks.push({
      name: `must_surface_refusal:${sub}`,
      pass,
      detail: pass ? undefined : 'refusal not found in notes/component refuses',
    });
  }

  // Recipe identity checks only apply when a catalog plan exists.
  if (mode === 'catalog' && c.mustPrimaryRecipeId) {
    const pass = primaryRecipeId === c.mustPrimaryRecipeId;
    checks.push({
      name: `must_primary_recipe:${c.mustPrimaryRecipeId}`,
      pass,
      detail: pass ? undefined : `primary=${primaryRecipeId ?? 'none'}`,
    });
  }

  if (mode === 'catalog' && c.mustNotPrimaryRecipeId) {
    const pass = primaryRecipeId !== c.mustNotPrimaryRecipeId;
    checks.push({
      name: `must_not_primary_recipe:${c.mustNotPrimaryRecipeId}`,
      pass,
      detail: pass ? undefined : `primary=${primaryRecipeId}`,
    });
  }

  if (checks.length === 0) {
    checks.push({ name: 'no_assertions', pass: true });
  }

  return checks;
}

function scoreCase(
  catalog: CompositionCatalog | null,
  c: AssemblyEvalCase,
  mode: 'baseline' | 'catalog',
): CaseScore {
  if (mode === 'baseline' || !catalog) {
    // Agent never fetched catalog facts: empty install set, no refuse notes.
    const packageNames: string[] = [];
    const refuseBlob = '';
    const primaryRecipeId = null;
    const checks = scoreAssertions(
      c,
      packageNames,
      refuseBlob,
      primaryRecipeId,
      'baseline',
    );
    return {
      id: c.id,
      pass: checks.every((x) => x.pass),
      checks,
      packageNames,
      primaryRecipeId,
    };
  }

  const plan = planComposition(catalog, {
    capabilityTags: c.capabilityTags,
    host: c.host,
    productionOnly: true,
  });
  const packageNames = plan.packages.map((p) => p.name);
  const refuseBlob = [
    ...plan.notes,
    ...plan.components.flatMap((comp) => {
      const full = catalog.components.find((x) => x.id === comp.id);
      return full?.refuses ?? [];
    }),
  ].join(' | ');
  const primaryRecipeId =
    plan.recipes[0]?.id ?? primaryRecipeIdFromNotes(plan.notes);

  const checks = scoreAssertions(
    c,
    packageNames,
    refuseBlob,
    primaryRecipeId,
    'catalog',
  );

  return {
    id: c.id,
    pass: checks.every((x) => x.pass),
    checks,
    packageNames,
    primaryRecipeId,
  };
}

export function runAssemblyEval(
  catalog: CompositionCatalog | null,
  mode: 'baseline' | 'catalog',
  cases: readonly AssemblyEvalCase[] = ASSEMBLY_EVAL_CASES,
): EvalReport {
  const scored = cases.map((c) => scoreCase(catalog, c, mode));
  const passed = scored.filter((s) => s.pass).length;
  return {
    schema: 'pegma.assembly_eval.v1',
    mode,
    total: scored.length,
    passed,
    passRate: scored.length === 0 ? 0 : passed / scored.length,
    cases: scored,
  };
}
