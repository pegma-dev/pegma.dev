/**
 * Offline eval runner: score plan_composition against ASSEMBLY_EVAL_CASES.
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
  readonly checks: readonly { readonly name: string; readonly pass: boolean; readonly detail?: string }[];
  readonly packageNames: readonly string[];
}

export interface EvalReport {
  readonly schema: 'pegma.assembly_eval.v1';
  readonly mode: 'baseline' | 'catalog';
  readonly total: number;
  readonly passed: number;
  readonly passRate: number;
  readonly cases: readonly CaseScore[];
}

function scoreCase(
  catalog: CompositionCatalog | null,
  c: AssemblyEvalCase,
  mode: 'baseline' | 'catalog',
): CaseScore {
  if (mode === 'baseline' || !catalog) {
    // No catalog planner → cannot satisfy package selection assertions.
    const checks = [
      {
        name: 'catalog_available',
        pass: false,
        detail: 'baseline has no plan_composition',
      },
    ];
    return {
      id: c.id,
      pass: false,
      checks,
      packageNames: [],
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

  const checks: { name: string; pass: boolean; detail?: string }[] = [];

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

  // Empty checks (static site with only must-not): still require no failures.
  if (checks.length === 0) {
    checks.push({ name: 'no_assertions', pass: true });
  }

  return {
    id: c.id,
    pass: checks.every((x) => x.pass),
    checks,
    packageNames,
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
