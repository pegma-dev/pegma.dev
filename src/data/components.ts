/**
 * The component registry every page renders from — a hand-maintained fallback
 * snapshot. Build-time aggregation adds the Stage paragraph from each
 * repository's docs/PROJECT_PLAN.md when available; pages prefer that `stage`
 * field over `now`, so these facts stay useful during a fetch failure.
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

export const SNAPSHOT_DATE = '2026-07-28';

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
    now: '0.1.1 on npm; deliberately close to frozen.',
  },
  {
    repo: 'storage-core',
    title: 'Storage Core',
    packages: [
      '@pegma/storage-core',
      '@pegma/storage-azure-tables',
      '@pegma/storage-cloudflare-d1',
    ],
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
    now: '0.4.0 on npm with Azure Tables and Cloudflare D1 adapters; both adapters pass the same conformance suite.',
  },
  {
    repo: 'storage-blobs',
    title: 'Storage Blobs',
    packages: [
      '@pegma/storage-blobs',
      '@pegma/storage-azure-blob',
      '@pegma/storage-cloudflare-r2',
      '@pegma/storage-s3',
    ],
    status: 'published',
    summary:
      'Opaque object bytes through a narrow port — the counterpart to storage-core records.',
    owns: [
      'Streaming put/get, head, delete, and etag-conditioned writes for one container/bucket',
      'Bounded prefix listing for retention and GC',
      'A conformance suite every adapter must pass against a real empty backend',
      'Thin adapters for Azure Blob, Cloudflare R2, and S3-compatible endpoints',
    ],
    refuses: [
      'Client-facing signed URLs as the default path — hosts authorize on the API',
      'Authorization, rate limits, malware scanning, or attachment lifecycle inside the store',
      'Cross-object transactions or server-side query by metadata',
    ],
    now: '0.1.0 on npm with Azure Blob, R2, and S3 adapters; first consumer planned is Support Desk attachments.',
    plan: 'docs/PROJECT_PLAN.md',
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
      '@pegma/authorization-identity',
    ],
    status: 'published',
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
    now: '0.1.2 on npm; the Identity claims adapter is composed by this Cloudflare reference application.',
    plan: 'docs/PROJECT_PLAN.md',
  },
  {
    repo: 'audit',
    title: 'Audit',
    packages: ['@pegma/audit'],
    status: 'published',
    summary:
      'Append-only audit records that commit atomically with the change they describe.',
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
    packages: [
      '@pegma/support-desk-contracts',
      '@pegma/support-desk-core',
      '@pegma/support-desk-application',
      '@pegma/support-desk-templates',
    ],
    status: 'in development',
    summary:
      'A composable support queue for web and email, authorized by permissions from day one.',
    owns: [
      'Tickets, channel-neutral messages, and requester trust levels',
      'Outbox-backed mail delivery — the state change and its delivery job commit in one transaction',
      'Inbound mailbox handling: threading, matching, abuse limits',
    ],
    refuses: [
      'Being a hosted SaaS — hosts run it, own its data, and choose its providers',
      'AI processing before the host documents what may leave its boundary',
    ],
    now: 'The customer Phase 1/2 application slice and provider-neutral Phase 6 mail source are implemented; abuse limits and deployment phases remain open, and all packages are unpublished.',
    plan: 'docs/PROJECT_PLAN.md',
  },
  {
    repo: 'webhooks',
    title: 'Webhooks',
    packages: ['@pegma/webhooks'],
    status: 'in development',
    summary:
      'Inbound webhook receipts: idempotent dedup, poison quarantine, retention.',
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
    now: 'Phase 2 consumer migration is merged; operational exit awaits production Stripe traffic. Phase 3 is gated on a second real provider; unpublished.',
    plan: 'docs/PROJECT_PLAN.md',
  },
  {
    repo: 'sessions',
    title: 'Sessions',
    packages: ['@pegma/sessions'],
    status: 'published',
    summary:
      'Server-side session records: hashed ids, dual expiry, revoke-everywhere.',
    owns: [
      'SHA-256-hashed identifiers, non-optionally — a leaked table hands out no sessions',
      'Absolute plus idle expiry through one liveness predicate',
      'Principal-wide revocation that wins races; hygiene sweeps that lose them',
    ],
    refuses: [
      'Authentication — no OIDC, cookies, or CSRF; the host logs people in, this store remembers',
      'Tokens at rest, ever',
    ],
    now: '0.1.0 on npm; RetireGolden is the first integrated consumer and this site is the second, live consumer; early 0.x API remains unstable.',
    plan: 'docs/PROJECT_PLAN.md',
  },
  {
    repo: 'mail',
    title: 'Mail',
    packages: ['@pegma/mail'],
    status: 'published',
    summary:
      'Transactional mail: provider ports and an outbox pattern that owns no store.',
    owns: [
      'A delivery-job projection committed in the CALLER’s transaction — the lost-send gap closed by construction',
      'A lease-claiming delivery worker: bounded retries, dead jobs kept as durable human-visible rows',
      'A narrow send port with mandatory idempotency keys; provider adapters on consumer pull',
    ],
    refuses: [
      'Owning an outbox store — single-partition transactions make an owned outbox incapable of the promised atomicity (the audit precedent)',
      'Inbound mail, bulk/marketing sending, rich templating',
      'Deliverability abstraction — SPF/DKIM/DMARC live in the host’s DNS',
    ],
    now: '0.1.0 on npm; extracted from Support Desk and now shared by Support Desk and Identity.',
    plan: 'docs/PROJECT_PLAN.md',
  },
  {
    repo: 'identity',
    title: 'Identity',
    packages: ['@pegma/identity'],
    status: 'published',
    summary:
      'First-party identity: passkeys-first, email-code fallback, no passwords.',
    owns: [
      'Account creation, passkey sign-in, and email one-time codes for enrollment, fallback, and recovery',
      'User records in the host’s own storage — no external provider',
      'Enumeration resistance as a test-pinned property, and an honestly stated email-recovery security floor',
    ],
    refuses: [
      'Passwords — not a phase, a refusal: no password table, no reset flow, no breach class',
      'Being an OIDC/OAuth2 server for third parties',
      'Social login — external providers exist for that, and issuer-namespaced links let a host run both',
    ],
    now: '0.1.0 on npm; composed here with Sessions, durable rate limits, Mail, and Cloudflare D1.',
    plan: 'docs/PROJECT_PLAN.md',
  },
  {
    repo: 'rate-limit',
    title: 'Rate Limit',
    packages: ['@pegma/rate-limit'],
    status: 'published',
    summary:
      'Two honest tiers: in-memory abuse dampening, durable limits for expensive operations.',
    owns: [
      'A per-instance sliding window that says it is per-instance',
      'A durable fixed-window counter that fails closed and refuses read-only under attack',
    ],
    refuses: [
      'Pretending a per-instance window is a global quota — choosing a tier is mandatory',
      'DDoS protection — volumetric defense belongs at the edge',
      'Middleware and usage metering',
    ],
    now: '0.1.0 on npm; durable fixed-window policies are composed by the production Identity worker.',
    plan: 'docs/PROJECT_PLAN.md',
  },
  {
    repo: 'logger-adapters',
    title: 'Logger Adapters',
    packages: [
      '@pegma/logger-tee',
      '@pegma/logger-applicationinsights',
      '@pegma/logger-cloudflare',
      '@pegma/logger-datadog',
    ],
    status: 'published',
    summary:
      'Thin Spine Logger implementations for Application Insights, Cloudflare Workers Logs, and multi-sink teeing.',
    owns: [
      'Factories that implement Spine’s one-method Logger for named sinks',
      'A tee that fans one Logger out to many sinks at the composition root',
    ],
    refuses: [
      'A logging-core or Pegma-owned observability vocabulary — the port stays in Spine',
      'Traces, metrics, APM, or SIEM — hosts use OpenTelemetry or vendor SDKs beside Pegma',
      'Growing Spine with sink SDKs',
    ],
    now: '0.1.1 on npm; trusted publishing configured. Host tee wiring next.',
    plan: 'docs/PROJECT_PLAN.md',
  },
  {
    repo: 'health',
    title: 'Health',
    packages: ['@pegma/health'],
    status: 'published',
    summary:
      'Composable health probes and HTTP responses for public liveness checks.',
    owns: [
      'Check contracts, aggregation, and HTTP status mapping',
      'Process, detail, and injected Store ping helpers',
      'Spine log events health.ok / health.degraded / health.failed',
    ],
    refuses: [
      'Owning a storage adapter or inventing domain collections',
      'Autodiscovery of checks — hosts register them at the composition root',
      'Metrics, APM, or alert fan-out',
    ],
    now: '0.1.1 on npm; trusted publishing configured.',
    plan: 'docs/PROJECT_PLAN.md',
  },
];
