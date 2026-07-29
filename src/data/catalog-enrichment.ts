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
    ],
    hostMustProvide: [
      'Chosen adapter binding (D1 database, Azure connection, or memory for tests)',
      'Collection declarations and codecs',
    ],
    capabilityTags: ['storage', 'cloudflare', 'azure'],
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
