/**
 * Offline assembly eval cases for Phase 5.
 *
 * Prompts are scored by mapping them to structured capabilityTags and
 * running plan_composition over the **compiled** catalog (same path as
 * catalog.json). This measures package selection and refusal compliance
 * without hosting an LLM in Pegma.
 *
 * Baseline models an agent that never consults the catalog: empty package
 * set and no catalog refuse notes. Assertions are scored honestly against
 * that empty plan (must-include fails; pure must-not-include may pass).
 */

import type { CapabilityTag } from '../src/data/catalog-schema';

export interface AssemblyEvalCase {
  readonly id: string;
  /** Short product prompt (synthetic). */
  readonly prompt: string;
  /** Structured tags an agent should pass to plan_composition. */
  readonly capabilityTags: readonly CapabilityTag[];
  readonly host?: 'cloudflare' | 'azure' | 'memory' | 'other';
  /** Package name substrings that must appear in the plan. */
  readonly mustIncludePackageNames?: readonly string[];
  /** Package name substrings that must not appear. */
  readonly mustNotIncludePackageNames?: readonly string[];
  /** Substrings that must appear in combined refuses notes / component refuses. */
  readonly mustSurfaceRefusalSubstrings?: readonly string[];
  /** Substrings that must not appear in recommended package names. */
  readonly mustNotRecommendSubstrings?: readonly string[];
  /** Primary recipe id that must be selected (catalog mode). */
  readonly mustPrimaryRecipeId?: string;
  /** Primary recipe id that must not be selected (catalog mode). */
  readonly mustNotPrimaryRecipeId?: string;
}

/**
 * Plan Phase 5 prompt set: static brochure, passkeys on Workers, health only,
 * and password refusal compliance.
 */
export const ASSEMBLY_EVAL_CASES: readonly AssemblyEvalCase[] = [
  {
    id: 'static-brochure',
    prompt:
      'Static brochure museum site (Glass Wing). No accounts, no durable storage, no mail.',
    capabilityTags: ['static_host'],
    mustPrimaryRecipeId: 'static-brochure-minimal',
    mustNotIncludePackageNames: [
      '@pegma/identity',
      '@pegma/sessions',
      '@pegma/mail',
      '@pegma/storage-core',
    ],
  },
  {
    id: 'passkey-accounts-workers',
    prompt:
      'Passkey accounts on Cloudflare Workers with email-code fallback. No passwords.',
    capabilityTags: ['accounts', 'passkeys', 'email_codes', 'cloudflare'],
    host: 'cloudflare',
    mustIncludePackageNames: ['@pegma/identity'],
    mustNotRecommendSubstrings: ['password'],
    mustSurfaceRefusalSubstrings: ['password'],
  },
  {
    id: 'health-endpoint-only',
    prompt: 'Public liveness health endpoint only on a small Worker.',
    capabilityTags: ['health'],
    mustIncludePackageNames: ['@pegma/health'],
    mustNotIncludePackageNames: ['@pegma/identity', '@pegma/mail'],
    // Do not send agents to the static museum scaffold for a health-only plan.
    mustNotPrimaryRecipeId: 'static-brochure-minimal',
  },
  {
    id: 'no-passwords',
    prompt:
      'First-party accounts for a club site. Passkeys preferred. Do not use passwords.',
    capabilityTags: ['accounts', 'passkeys'],
    mustIncludePackageNames: ['@pegma/identity'],
    mustNotRecommendSubstrings: ['password'],
    mustSurfaceRefusalSubstrings: ['password'],
  },
];
