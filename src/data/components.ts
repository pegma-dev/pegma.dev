/**
 * The component registry every page renders from — a hand-maintained
 * SNAPSHOT (2026-07-27). Phase 3 of the site plan replaces this file with
 * build-time aggregation from each repository's docs/PROJECT_PLAN.md, so
 * facts here are deliberately terse: anything richer belongs in the repos.
 */

export type ComponentStatus = 'published' | 'in development' | 'planned';

export interface PegmaComponent {
  /** Repo name under github.com/pegma-dev */
  readonly repo: string;
  readonly title: string;
  /** npm packages, when any exist */
  readonly packages: readonly string[];
  readonly status: ComponentStatus;
  /** One-line role in the stack */
  readonly summary: string;
  /** What it takes responsibility for */
  readonly owns: readonly string[];
  /** What it deliberately refuses — as load-bearing as what it owns */
  readonly refuses: readonly string[];
  /** Current position, in plain words */
  readonly now: string;
  /** Repo-relative path to the project plan, when one exists */
  readonly plan?: string;
}

export const SNAPSHOT_DATE = '2026-07-27';

export const components: readonly PegmaComponent[] = [
  {
    repo: 'spine',
    title: 'Spine',
    packages: ['@pegma/spine'],
    status: 'published',
    summary: 'The small, stable contracts every component shares.',
    owns: [
      'PrincipalId and IsoTimestamp — shared identity and time types',
      'Clock — time as an injected, test-fixable input',
      'Logger — a one-method structured logging port',
      'Typed event declarations and a best-effort in-process bus',
    ],
    refuses: [
      'Durable events — anything that must survive a crash goes to a storage-backed outbox, never the in-process bus',
      'Growth — the more spine changes, the more the ecosystem churns',
    ],
    now: '0.1.0 on npm; deliberately close to frozen.',
  },
  {
    repo: 'storage-core',
    title: 'Storage Core',
    packages: ['@pegma/storage-core', '@pegma/storage-azure-tables'],
    status: 'published',
    summary: 'Persistence without the component knowing what the database is.',
    owns: [
      'Declared collections with codecs — schema-agnostic on purpose',
      'update deciders re-run against fresh state on every conflict',
      'Version-conditional deletes for safe sweeps',
      'Single-collection, single-partition transactions',
      'A conformance suite adapters must pass — verified against a real Azurite table service, never a fake',
    ],
    refuses: [
      'Server-side queries and secondary indexes',
      'Cross-partition anything',
      'Compatibility layers for pre-existing data layouts — Pegma targets net-new projects',
    ],
    now: '0.3.0 on npm with the Azure Tables adapter; in production behind the reference application.',
  },
  {
    repo: 'authorization-core',
    title: 'Authorization Core',
    packages: [
      '@pegma/authorization-contracts',
      '@pegma/authorization-core',
      '@pegma/authorization-policy',
      '@pegma/authorization-auth0',
      '@pegma/authorization-stripe',
      '@pegma/authorization-storage',
      '@pegma/authorization-tokens',
    ],
    status: 'in development',
    summary:
      'Provider-neutral roles, entitlements, and permissions between identity, billing, and your API.',
    owns: [
      'Principals, roles, entitlements, permissions, and versioned policy',
      'Deterministic resolution: trusted facts in, effective permissions out',
      'Auth0 and Stripe adapters; storage over Storage Core',
      'Short-lived signed access grants (ES256, single-use)',
    ],
    refuses: [
      'Being an identity provider or processing payments',
      'Organization scope in v1',
      'Offline commercial licensing — a different artifact entirely',
      'Email as an authentication or authorization key',
    ],
    now: 'Phase 4 of 6 complete; first public 0.x packages are the next milestone.',
    plan: 'docs/PROJECT_PLAN.md',
  },
  {
    repo: 'audit',
    title: 'Audit',
    packages: ['@pegma/audit'],
    status: 'published',
    summary: 'Append-only audit records that commit atomically with the change they describe.',
    owns: [
      'One audit vocabulary — actor, subject, event, idempotency — for every component',
      'A TransactionAction the caller includes in its own transact call',
    ],
    refuses: [
      'Owning a store, a collection, or a partition — an audit record a component writes separately can lie; one inside the caller’s transaction cannot',
      'Tamper-evidence, SIEM ambitions, global ordering',
    ],
    now: '0.1.0 on npm; awaiting its first integrated consumer.',
    plan: 'docs/PROJECT_PLAN.md',
  },
  {
    repo: 'support-desk',
    title: 'Support Desk',
    packages: ['@pegma/support-desk-contracts', '@pegma/support-desk-core'],
    status: 'in development',
    summary: 'A composable support queue for web and email, authorized by permissions from day one.',
    owns: [
      'Tickets, channel-neutral messages, and requester trust levels',
      'Outbox-backed mail delivery — the state change and its delivery job commit in one transaction',
      'Inbound mailbox handling: threading, matching, abuse limits',
    ],
    refuses: [
      'Being a hosted SaaS — hosts run it, own its data, and choose its providers',
      'AI processing before the host documents what may leave its boundary',
    ],
    now: 'Domain core and plan in place; application services and deployment phases ahead.',
    plan: 'docs/PROJECT_PLAN.md',
  },
  {
    repo: 'webhooks',
    title: 'Webhooks',
    packages: ['@pegma/webhooks'],
    status: 'planned',
    summary: 'Inbound webhook receipts: idempotent dedup, poison quarantine, retention.',
    owns: [
      'One receipt per provider event id — the durable answer to “did we already process this?”',
      'Quarantine-then-acknowledge after bounded failures, ending retry storms',
      'Version-conditional retention sweeps',
    ],
    refuses: [
      'Exactly-once delivery — does not exist; will not be pretended',
      'Ordering guarantees — domain logic, deliberately excluded',
      'Storing payloads — receipts hold ids and counters, never customer data',
    ],
    now: 'Plan published; extraction from the production reference implementation is next.',
    plan: 'docs/PROJECT_PLAN.md',
  },
  {
    repo: 'sessions',
    title: 'Sessions',
    packages: ['@pegma/sessions'],
    status: 'planned',
    summary: 'Server-side session records: hashed ids, dual expiry, revoke-everywhere.',
    owns: [
      'SHA-256-hashed identifiers, non-optionally — a leaked table hands out no sessions',
      'Absolute plus idle expiry through one liveness predicate',
      'Principal-wide revocation that wins races; hygiene sweeps that lose them',
    ],
    refuses: [
      'Authentication — no OIDC, cookies, or CSRF; the host logs people in, this store remembers',
      'Tokens at rest, ever',
    ],
    now: 'Plan published; extraction from the production reference implementation is next.',
    plan: 'docs/PROJECT_PLAN.md',
  },
  {
    repo: 'rate-limit',
    title: 'Rate Limit',
    packages: ['@pegma/rate-limit'],
    status: 'planned',
    summary: 'Two honest tiers: in-memory abuse dampening, durable limits for expensive operations.',
    owns: [
      'A per-instance sliding window that says it is per-instance',
      'A durable fixed-window counter that fails closed and refuses read-only under attack',
    ],
    refuses: [
      'Pretending a per-instance window is a global quota — choosing a tier is mandatory',
      'DDoS protection — volumetric defense belongs at the edge',
      'Middleware and usage metering',
    ],
    now: 'Plan published; deliberately dormant until the support desk pulls it.',
    plan: 'docs/PROJECT_PLAN.md',
  },
];
