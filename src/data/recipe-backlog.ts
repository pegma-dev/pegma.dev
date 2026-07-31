/**
 * Prioritized synthetic recipe intents for the compiled catalog.
 * Source narrative: docs/catalog/RECIPE_BACKLOG.md
 *
 * Wiring code may only be quoted when fixture.status is `green` and the
 * citation points at a CI-tested path under recipes/.
 */

import type { CatalogRecipe } from './catalog-schema';

/** Recipes included in catalog.json. */
export const RECIPE_BACKLOG: readonly CatalogRecipe[] = [
  {
    id: 'cf-passkey-accounts',
    intent:
      'A small Cloudflare Worker host for a fictional community library (Northshelf Branch) offers first-party accounts: passkey sign-in, email one-time codes for enrollment and recovery, server-side sessions, and durable rate limits on expensive auth paths. No passwords.',
    packages: [
      '@pegma/identity@0.1.2',
      '@pegma/sessions@0.2.0',
      '@pegma/mail@0.1.1',
      '@pegma/rate-limit@0.2.0',
      '@pegma/authorization-identity@0.4.0',
      '@pegma/storage-core@0.4.0',
      '@pegma/storage-cloudflare-d1@0.4.1',
      '@pegma/spine@0.1.1',
    ],
    adapters: [{ componentId: 'storage-core', adapterId: 'cloudflare-d1' }],
    hostResponsibilities: [
      'HTTP routes and cookie/session boundary',
      'WebAuthn relying-party configuration',
      'Email provider adapter and DNS',
      'Secrets and any account UI',
    ],
    nonGoals: [
      'Social login',
      'OIDC server for third parties',
      'Passwords',
      'Multi-tenant organizations',
    ],
    antiPatterns: [
      'Password table or reset flow',
      'Durable events on Spine in-process bus',
      'Mail package owning its own outbox store',
    ],
    fixture: {
      kind: 'recipe_package',
      citation:
        'https://github.com/pegma-dev/pegma.dev/tree/main/recipes/cf-passkey-accounts',
      status: 'green',
    },
    capabilityTags: [
      'accounts',
      'passkeys',
      'email_codes',
      'sessions',
      'authorization',
      'mail_transactional',
      'rate_limit_durable',
      'storage',
      'cloudflare',
    ],
    requiresPublished: [
      'identity',
      'sessions',
      'mail',
      'rate-limit',
      'authorization-core',
      'storage-core',
      'spine',
    ],
    backlogPriority: 1,
  },
  {
    id: 'storage-audit-mail-outbox',
    intent:
      'A fictional equipment checkout service (Yard Loan) records inventory mutations in Storage Core and, in the same single-partition transaction, appends an audit row and enqueues a transactional mail delivery job.',
    packages: [
      '@pegma/storage-core@0.4.0',
      '@pegma/audit@0.2.0',
      '@pegma/mail@0.1.1',
      '@pegma/spine@0.1.1',
    ],
    // Host chooses a durable storage-core adapter (cloudflare-d1 or azure-tables).
    // Do not pin memory here — the recipe needs durable inventory/audit/outbox rows.
    adapters: [],
    hostResponsibilities: [
      'Collection declarations',
      'Transaction boundary',
      'Durable storage-core adapter for production (not memory)',
      'Outbox collection in host storage',
      'Mail provider and delivery worker schedule',
    ],
    nonGoals: [
      'Mail-owned outbox store',
      'Audit-owned store',
      'Cross-partition transactions',
    ],
    antiPatterns: [
      'Send email after commit without an outbox job in the same transaction',
      'Audit write outside the caller transact',
    ],
    fixture: {
      kind: 'recipe_package',
      citation:
        'https://github.com/pegma-dev/pegma.dev/tree/main/recipes/storage-audit-mail-outbox',
      status: 'green',
    },
    capabilityTags: ['storage', 'audit', 'mail_transactional'],
    requiresPublished: ['storage-core', 'audit', 'mail', 'spine'],
    backlogPriority: 2,
  },
  {
    id: 'durable-auth-rate-limits',
    intent:
      'A fictional API for appointment holds (Chair Queue) applies durable fixed-window rate limits to expensive verification endpoints and an honest in-memory tier only for cheap abuse dampening.',
    packages: ['@pegma/rate-limit', '@pegma/storage-core', '@pegma/spine'],
    adapters: [],
    hostResponsibilities: [
      'Explicit tier choice per path',
      'Storage binding for durable counters',
    ],
    nonGoals: ['Volumetric DDoS protection at the app tier'],
    antiPatterns: [
      'Using only in-memory limits for email-code or passkey verify',
      'Calling the memory tier a cluster quota',
    ],
    fixture: {
      kind: 'pending',
      citation: 'docs/catalog/RECIPE_BACKLOG.md#p3--durable-auth-rate-limits',
      status: 'pending',
    },
    capabilityTags: ['rate_limit_durable', 'rate_limit_memory', 'storage'],
    requiresPublished: ['rate-limit', 'storage-core', 'spine'],
    backlogPriority: 3,
  },
  {
    id: 'health-public-liveness',
    intent:
      'A fictional brochure site Worker exposes a public liveness endpoint composed from @pegma/health probes with checks registered at an explicit composition root.',
    packages: ['@pegma/health', '@pegma/spine'],
    adapters: [],
    hostResponsibilities: [
      'HTTP health route',
      'Explicit check registration at the composition root',
    ],
    nonGoals: ['APM, metrics, or alert fan-out'],
    antiPatterns: [
      'Autodiscovery of checks',
      'Health package inventing domain collections',
    ],
    fixture: {
      kind: 'pending',
      citation: 'docs/catalog/RECIPE_BACKLOG.md#p4--health-public-liveness',
      status: 'pending',
    },
    capabilityTags: ['health'],
    requiresPublished: ['health', 'spine'],
    backlogPriority: 4,
  },
  {
    id: 'logger-tee-composition',
    intent:
      'A fictional batch importer (Ledger Drop) wires Spine Logger once at the composition root through @pegma/logger-tee into Cloudflare Workers Logs.',
    packages: [
      '@pegma/spine',
      '@pegma/logger-tee',
      '@pegma/logger-cloudflare',
    ],
    adapters: [],
    hostResponsibilities: ['Composition-root Logger wiring', 'Sink configuration'],
    nonGoals: ['Pegma-owned traces, metrics, or APM'],
    antiPatterns: [
      'Putting sink SDKs into Spine',
      'Replacing Logger with a custom observability core',
    ],
    fixture: {
      kind: 'pending',
      citation: 'docs/catalog/RECIPE_BACKLOG.md#p5--logger-tee-composition',
      status: 'pending',
    },
    capabilityTags: ['logging'],
    requiresPublished: ['spine', 'logger-adapters'],
    backlogPriority: 5,
  },
  {
    id: 'static-brochure-minimal',
    intent:
      'A fictional static museum site (Glass Wing) needs no accounts, no durable storage, and no mail — teaching agents to select nothing extra. Optional Worker health probe is host-owned (withHealth), not a required composition capability.',
    packages: ['@pegma/spine@0.1.1'],
    adapters: [],
    hostResponsibilities: [
      'Static hosting and optional Worker fetch route',
      'Explicit composition root (empty-ish until features are added)',
      'Optional @pegma/health probe when a public liveness route is desired',
    ],
    nonGoals: ['Accounts, sessions, databases'],
    antiPatterns: [
      'Pulling identity/sessions for later',
      'Inventing a database for a static site',
    ],
    fixture: {
      kind: 'scaffold',
      citation:
        'https://github.com/pegma-dev/pegma.dev/tree/main/recipes/scaffold-cf-minimal',
      status: 'green',
    },
    // Only static_host (not bare cloudflare) so host-tag-only plans do not
    // select the Glass Wing scaffold. Do not attach `health` here.
    capabilityTags: ['static_host'],
    requiresPublished: ['spine'],
    backlogPriority: 6,
  },
  {
    id: 'inbound-webhook-receipts',
    intent:
      'A fictional donation platform (Copper Plate) records inbound provider webhook receipts with idempotent dedup and poison quarantine. The package is published; a CI-tested synthetic fixture remains pending.',
    packages: ['@pegma/webhooks', '@pegma/storage-core', '@pegma/spine'],
    adapters: [],
    hostResponsibilities: [
      'HTTP endpoint',
      'Provider signature verification',
      'Storage for the receipt ledger',
    ],
    nonGoals: ['Exactly-once delivery', 'Payload archival in the receipt ledger'],
    antiPatterns: [
      'Claiming exactly-once processing',
      'Storing full webhook bodies in receipts',
    ],
    fixture: {
      kind: 'pending',
      citation:
        'docs/catalog/RECIPE_BACKLOG.md#d1--inbound-webhook-receipts',
      status: 'none',
    },
    capabilityTags: ['webhooks_inbound'],
    requiresPublished: ['webhooks', 'storage-core', 'spine'],
    backlogPriority: 90,
  },
  {
    id: 'support-queue-slice',
    intent:
      'A fictional maker-space helpdesk (Bench Ticket) runs a composable support queue for web and email. Deferred until Support Desk packages are published.',
    packages: [
      '@pegma/support-desk-contracts',
      '@pegma/support-desk-core',
      '@pegma/support-desk-application',
      '@pegma/mail',
      '@pegma/storage-core',
      '@pegma/spine',
    ],
    adapters: [],
    hostResponsibilities: [
      'Host runtime and data ownership',
      'Permission model and mail provider',
    ],
    nonGoals: ['Hosted SaaS Support Desk', 'AI on ticket bodies without documented egress'],
    antiPatterns: [
      'Treating Support Desk as multi-tenant SaaS',
      'AI processing before the host documents what may leave its boundary',
    ],
    fixture: {
      kind: 'pending',
      citation:
        'docs/catalog/RECIPE_BACKLOG.md#d2--support-queue-slice-when-support-desk-packages-are-published',
      status: 'none',
    },
    capabilityTags: ['support_queue', 'mail_transactional'],
    requiresPublished: ['support-desk', 'mail', 'storage-core', 'spine'],
    backlogPriority: 91,
  },
];
