/**
 * Hand enrichment for composition-catalog fields the registry does not yet
 * carry (deps, adapters, hostMustProvide, capability tags).
 *
 * Status and package versions are compiled (plan stage + npm). These edges are
 * curated agent-facing facts; keep them short and refuse-aligned.
 */

import type {
  CapabilityTag,
  CatalogAdapter,
  CatalogDependency,
} from './catalog-schema';

export interface ComponentEnrichment {
  readonly dependencies: readonly CatalogDependency[];
  readonly adapters: readonly CatalogAdapter[];
  readonly hostMustProvide: readonly string[];
  readonly capabilityTags: readonly CapabilityTag[];
}

/** Keyed by component id (= registry `repo`). */
export const COMPONENT_ENRICHMENT: Readonly<Record<string, ComponentEnrichment>> = {
  spine: {
    dependencies: [],
    adapters: [],
    hostMustProvide: [
      'Composition-root wiring for Clock, Logger, and any in-process bus subscribers',
    ],
    capabilityTags: ['logging', 'events_in_process'],
  },
  'storage-core': {
    dependencies: [
      { componentId: 'spine', kind: 'requires', note: 'Shared contracts and Logger' },
    ],
    adapters: [
      {
        id: 'memory',
        packageName: '@pegma/storage-core',
        host: 'memory',
        when: 'Tests and local sketches; not a production durability claim',
      },
      {
        id: 'azure-tables',
        packageName: '@pegma/storage-azure-tables',
        host: 'azure',
        when: 'Azure-hosted apps using the Tables adapter',
      },
      {
        id: 'cloudflare-d1',
        packageName: '@pegma/storage-cloudflare-d1',
        host: 'cloudflare',
        when: 'Cloudflare Workers/Pages with D1',
      },
      {
        id: 'dynamodb',
        packageName: '@pegma/storage-dynamodb',
        host: 'other',
        when:
          'AWS-hosted apps using DynamoDB. Requires pegma-dev/storage-core#7 to be merged; factory is createDynamoDbStore. Not yet on npm.',
      },
    ],
    hostMustProvide: [
      'Chosen adapter binding (D1 database, Azure connection, or memory for tests)',
      'Collection declarations and codecs',
    ],
    capabilityTags: ['storage', 'cloudflare', 'azure'],
  },
  'storage-blobs': {
    dependencies: [
      { componentId: 'spine', kind: 'requires', note: 'Shared contracts' },
    ],
    adapters: [
      {
        id: 'azure-blob',
        packageName: '@pegma/storage-azure-blob',
        host: 'azure',
        when: 'Azure Blob Storage for opaque object bytes',
      },
      {
        id: 'cloudflare-r2',
        packageName: '@pegma/storage-cloudflare-r2',
        host: 'cloudflare',
        when: 'Cloudflare R2 for opaque object bytes',
      },
      {
        id: 's3',
        packageName: '@pegma/storage-s3',
        host: 'other',
        when: 'S3-compatible endpoints outside Azure/Cloudflare first-party adapters',
      },
    ],
    hostMustProvide: [
      'Chosen blob adapter binding (R2 bucket, Azure container, or S3 credentials)',
      'Authorization and malware scanning at the host API — not inside the store',
    ],
    // Distinct from record `storage` so generic storage plans do not pull R2/Blob.
    capabilityTags: ['storage_blobs', 'cloudflare', 'azure'],
  },
  'cache-core': {
    dependencies: [
      { componentId: 'spine', kind: 'requires', note: 'Injected Clock and Logger' },
    ],
    adapters: [
      {
        id: 'memory',
        packageName: '@pegma/cache-core',
        host: 'memory',
        when: 'Tests and local sketches; not a durability claim',
      },
      {
        id: 'redis',
        packageName: '@pegma/cache-redis',
        host: 'other',
        when: 'Generic Redis (ioredis) behind the cache port',
      },
      {
        id: 'azure-redis',
        packageName: '@pegma/cache-azure-redis',
        host: 'azure',
        when: 'Azure Cache for Redis; thin composition of cache-redis',
      },
      {
        id: 'elasticache',
        packageName: '@pegma/cache-elasticache',
        host: 'other',
        when: 'Amazon ElastiCache; thin composition of cache-redis',
      },
      {
        id: 'upstash-redis',
        packageName: '@pegma/cache-upstash-redis',
        host: 'other',
        when: 'Upstash Redis REST client behind the same port',
      },
    ],
    hostMustProvide: [
      'Chosen adapter binding (Redis URL, Azure cache, ElastiCache, Upstash, or memory)',
      'Explicit fail-open vs fail-closed policy — fail-open computes, it does not accumulate',
    ],
    capabilityTags: ['cache', 'azure'],
  },
  'authorization-core': {
    dependencies: [
      { componentId: 'spine', kind: 'requires' },
      {
        componentId: 'storage-core',
        kind: 'optional',
        note: 'When using storage-backed authorization adapters',
      },
    ],
    adapters: [],
    hostMustProvide: [
      'Trusted identity/billing facts at the composition root',
      'Policy versioning and permission checks at the HTTP boundary',
    ],
    capabilityTags: ['authorization'],
  },
  audit: {
    dependencies: [
      { componentId: 'spine', kind: 'requires' },
      {
        componentId: 'storage-core',
        kind: 'requires',
        note: 'Audit rows commit inside the caller’s storage transaction',
      },
    ],
    adapters: [],
    hostMustProvide: [
      'Caller-owned storage transaction that includes the audit TransactionAction',
    ],
    capabilityTags: ['audit', 'storage'],
  },
  'support-desk': {
    dependencies: [
      { componentId: 'spine', kind: 'requires' },
      { componentId: 'storage-core', kind: 'requires' },
      { componentId: 'mail', kind: 'requires' },
      { componentId: 'authorization-core', kind: 'requires' },
    ],
    adapters: [],
    hostMustProvide: [
      'Host runtime and data ownership (not a hosted SaaS)',
      'Mail provider and permission model',
    ],
    capabilityTags: ['support_queue', 'mail_transactional'],
  },
  webhooks: {
    dependencies: [
      { componentId: 'spine', kind: 'requires' },
      { componentId: 'storage-core', kind: 'requires' },
    ],
    adapters: [],
    hostMustProvide: [
      'HTTP endpoint and provider signature verification',
      'Storage binding for the receipt ledger',
    ],
    capabilityTags: ['webhooks_inbound'],
  },
  sessions: {
    dependencies: [
      { componentId: 'spine', kind: 'requires' },
      { componentId: 'storage-core', kind: 'requires' },
    ],
    adapters: [],
    hostMustProvide: [
      'Authentication (login) at the host',
      'Cookie/session HTTP boundary and CSRF strategy',
    ],
    capabilityTags: ['sessions'],
  },
  mail: {
    dependencies: [
      { componentId: 'spine', kind: 'requires' },
      {
        componentId: 'storage-core',
        kind: 'requires',
        note: 'Outbox jobs live in the caller’s store',
      },
    ],
    adapters: [],
    hostMustProvide: [
      'Outbox collection in host storage',
      'Provider adapter and delivery worker schedule',
      'DNS for SPF/DKIM/DMARC',
    ],
    capabilityTags: ['mail_transactional'],
  },
  'billing-core': {
    dependencies: [
      { componentId: 'spine', kind: 'requires' },
      {
        componentId: 'storage-core',
        kind: 'requires',
        note: 'Ledger collections over an injected Store',
      },
      {
        componentId: 'webhooks',
        kind: 'composes_with',
        note: 'Receipt dedup; this ledger owns ordering, not delivery identity',
      },
      {
        componentId: 'authorization-core',
        kind: 'composes_with',
        note: 'What a subscription grants is Authorization Core; this is what it is',
      },
    ],
    adapters: [
      {
        id: 'stripe',
        packageName: '@pegma/billing-stripe',
        host: 'other',
        when: 'Stripe event and subscription snapshot translation; host verifies signatures',
      },
    ],
    hostMustProvide: [
      'Storage binding for the ledger',
      'Provider checkout/portal flows — this package is not a payment processor',
      'Webhook authenticity (signature verification stays with the host)',
    ],
    capabilityTags: ['billing'],
  },
  identity: {
    dependencies: [
      { componentId: 'spine', kind: 'requires' },
      { componentId: 'storage-core', kind: 'requires' },
      { componentId: 'sessions', kind: 'requires' },
      { componentId: 'mail', kind: 'composes_with', note: 'Email codes' },
      {
        componentId: 'rate-limit',
        kind: 'composes_with',
        note: 'Durable limits on expensive auth paths',
      },
      {
        componentId: 'authorization-core',
        kind: 'composes_with',
        note: 'Identity claims adapter',
      },
    ],
    adapters: [],
    hostMustProvide: [
      'HTTP routes and cookie boundary',
      'WebAuthn relying-party configuration',
      'Email provider and secrets',
      'Any account UI',
    ],
    capabilityTags: [
      'accounts',
      'passkeys',
      'email_codes',
      'sessions',
      'authorization',
      'mail_transactional',
    ],
  },
  'rate-limit': {
    dependencies: [
      { componentId: 'spine', kind: 'requires' },
      {
        componentId: 'storage-core',
        kind: 'optional',
        note: 'Required for the durable fixed-window tier',
      },
    ],
    adapters: [],
    hostMustProvide: [
      'Explicit tier choice (memory vs durable) per path',
      'Storage binding when using the durable tier',
    ],
    capabilityTags: ['rate_limit_durable', 'rate_limit_memory'],
  },
  'flags-core': {
    dependencies: [
      { componentId: 'spine', kind: 'requires', note: 'Injected Clock and Logger' },
    ],
    adapters: [
      {
        id: 'static',
        packageName: '@pegma/flags-static',
        host: 'memory',
        when: 'Tests and local development; in-memory map, not a control plane',
      },
      {
        id: 'azure-appconfig',
        packageName: '@pegma/flags-azure-appconfig',
        host: 'azure',
        when: 'Azure App Configuration; adapter translates, does not evaluate targeting rules',
      },
      {
        id: 'aws-appconfig',
        packageName: '@pegma/flags-aws-appconfig',
        host: 'other',
        when: 'AWS AppConfig; already-evaluated values only',
      },
      {
        id: 'cloudflare-flagship',
        packageName: '@pegma/flags-cloudflare-flagship',
        host: 'cloudflare',
        when: 'Cloudflare Flagship; already-evaluated *Details results',
      },
      {
        id: 'flagd',
        packageName: '@pegma/flags-flagd',
        host: 'other',
        when: 'flagd / OpenFeature detail translation',
      },
      {
        id: 'launchdarkly',
        packageName: '@pegma/flags-launchdarkly',
        host: 'other',
        when: 'LaunchDarkly adapter; no vendor SDK in application code',
      },
    ],
    hostMustProvide: [
      'A constructed client at the composition root — no ambient getClient()',
      'EvaluationContext (targeting key; optional principal, tenant, environment)',
      'Chosen provider adapter; the provider owns targeting rules',
    ],
    capabilityTags: ['flags', 'cloudflare', 'azure'],
  },
  'logger-adapters': {
    dependencies: [
      { componentId: 'spine', kind: 'requires', note: 'Implements Spine Logger' },
    ],
    adapters: [],
    hostMustProvide: [
      'Composition-root Logger wiring (e.g. tee + sink factories)',
      'Vendor credentials/config for chosen sinks',
    ],
    capabilityTags: ['logging'],
  },
  health: {
    dependencies: [
      { componentId: 'spine', kind: 'requires' },
      {
        componentId: 'storage-core',
        kind: 'optional',
        note: 'When registering a store ping check',
      },
    ],
    adapters: [],
    hostMustProvide: [
      'Explicit check registration at the composition root',
      'HTTP route that returns health responses',
    ],
    capabilityTags: ['health'],
  },
};

export function enrichmentFor(componentId: string): ComponentEnrichment {
  return (
    COMPONENT_ENRICHMENT[componentId] ?? {
      dependencies: [],
      adapters: [],
      hostMustProvide: [],
      capabilityTags: [],
    }
  );
}
