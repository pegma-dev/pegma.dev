# Synthetic recipe backlog

Prioritized composition intents for the agent catalog. Every intent is
**synthetic**: a purpose-built product shape for teaching assembly. None
describe a commercial host’s routes, tenancy, or operations.

**Fixture rule:** catalog and `/examples` may only quote wiring that exists in
a public, CI-tested source (`fixture.status === 'green'`). Until then, recipes
appear as intent metadata only.

**Publish rule:** recipes whose `requiresPublished` set is not fully usable
must not be offered for production assembly (they may stay in the backlog as
deferred).

## Priority order (ship fixtures in this order)

### P1 — `cf-passkey-accounts` (first end-to-end accounts recipe)

| | |
| --- | --- |
| **Intent** | A small Cloudflare Worker host for a fictional community library (“Northshelf Branch”) offers first-party accounts: passkey sign-in, email one-time codes for enrollment and recovery, server-side sessions, and durable rate limits on expensive auth paths. No passwords. |
| **Packages (published)** | `@pegma/identity`, `@pegma/sessions`, `@pegma/mail`, `@pegma/rate-limit`, `@pegma/authorization-identity`, `@pegma/storage-core`, `@pegma/storage-cloudflare-d1`, `@pegma/spine` |
| **Adapters** | `storage-core/cloudflare-d1`; mail provider chosen by host (e.g. Resend port on consumer pull) |
| **Host must provide** | HTTP routes, cookie/session boundary, WebAuthn origin config, email provider + DNS, secrets, any UI |
| **Non-goals** | Social login, OIDC server for third parties, passwords, multi-tenant orgs |
| **Anti-patterns** | Password table “just for admin”; durable events on Spine’s in-process bus; mail package owning its own outbox store; inventing sessions without `@pegma/sessions` |
| **requiresPublished** | identity, sessions, mail, rate-limit, authorization-core, storage-core, spine |
| **Fixture** | pending — Phase 2 synthetic fixture (not pegma.dev production account routes) |
| **Phase plan exit** | One of two required Phase 2 recipes (“accounts on Cloudflare-shaped host”) |

### P2 — `storage-audit-mail-outbox` (storage + audit/mail pattern)

| | |
| --- | --- |
| **Intent** | A fictional equipment checkout service (“Yard Loan”) records inventory mutations in Storage Core and, in the **same** single-partition transaction, appends an audit row and enqueues a transactional mail delivery job. After commit, a worker drains the outbox. |
| **Packages (published)** | `@pegma/storage-core`, `@pegma/audit`, `@pegma/mail`, `@pegma/spine` |
| **Adapters** | memory or cloudflare-d1 / azure-tables for demos; pattern is adapter-agnostic |
| **Host must provide** | Collection declarations, transaction boundary, outbox collection in host storage, mail provider adapter, delivery scheduler |
| **Non-goals** | Mail package owning storage; audit owning a store; cross-partition transactions |
| **Anti-patterns** | Separate “send email” after commit without an outbox job; audit write outside the caller’s `transact`; fake global ordering |
| **requiresPublished** | storage-core, audit, mail, spine |
| **Fixture** | pending — Phase 2; may cite package README/conformance excerpts until a dedicated fixture app exists |
| **Phase plan exit** | Second required Phase 2 recipe (“storage + audit/mail outbox pattern”) |

### P3 — `durable-auth-rate-limits`

| | |
| --- | --- |
| **Intent** | A fictional API for appointment holds (“Chair Queue”) applies durable fixed-window rate limits to expensive verification endpoints and an honest in-memory tier only for cheap abuse dampening — never pretending the memory tier is a global quota. |
| **Packages** | `@pegma/rate-limit`, `@pegma/storage-core` (durable tier), `@pegma/spine` |
| **Anti-patterns** | Using only in-memory limits for email-code or passkey verify; calling memory tier a “cluster quota”; expecting rate-limit to stop volumetric DDoS |
| **requiresPublished** | rate-limit, storage-core, spine |
| **Fixture** | pending |

### P4 — `health-public-liveness`

| | |
| --- | --- |
| **Intent** | A fictional brochure site’s Worker exposes a public liveness endpoint composed from `@pegma/health` probes (process + optional store ping), with checks registered at an explicit composition root. |
| **Packages** | `@pegma/health`, `@pegma/spine`; optional `@pegma/storage-core` for store ping |
| **Anti-patterns** | Autodiscovery of checks; health package inventing domain collections; treating health as APM |
| **requiresPublished** | health, spine |
| **Fixture** | pending (package README may supply early green citations) |

### P5 — `logger-tee-composition`

| | |
| --- | --- |
| **Intent** | A fictional batch importer (“Ledger Drop”) wires Spine’s Logger once at the composition root through `@pegma/logger-tee` into Cloudflare Workers Logs (and optionally a second sink), without growing Spine or inventing a Pegma observability vocabulary. |
| **Packages** | `@pegma/spine`, `@pegma/logger-tee`, `@pegma/logger-cloudflare` (optional other logger adapters) |
| **Anti-patterns** | Putting sink SDKs into Spine; replacing Logger with a custom core; claiming traces/metrics are Pegma’s job |
| **requiresPublished** | spine, logger-adapters |
| **Fixture** | pending |

### P6 — `static-brochure-minimal`

| | |
| --- | --- |
| **Intent** | A fictional static museum site (“Glass Wing”) needs no accounts, no durable storage, and no mail — only honest stack awareness (and optional health if a Worker exists). Teaches agents to **select nothing extra**. |
| **Packages** | none required; optional `@pegma/health` if a Worker liveness route exists |
| **Anti-patterns** | Pulling identity/sessions “for later”; inventing a database for a static site |
| **requiresPublished** | (none) |
| **Fixture** | pending — may be skill/eval only with empty composition root |

## Deferred (unpublished packages)

Do not offer for production assembly until packages are on npm.

### D1 — `inbound-webhook-receipts` (when `@pegma/webhooks` is published)

| | |
| --- | --- |
| **Intent** | A fictional donation platform (“Copper Plate”) records inbound provider webhook receipts with idempotent dedup, poison quarantine, and retention — receipts hold ids and counters, never payloads. |
| **Blocks** | webhooks unpublished |
| **Anti-patterns** | Exactly-once claims; storing full payloads in the receipt ledger; ordering guarantees |

### D2 — `support-queue-slice` (when Support Desk packages are published)

| | |
| --- | --- |
| **Intent** | A fictional maker-space helpdesk (“Bench Ticket”) runs a composable support queue for web and email with permission-checked agents and outbox-backed mail. |
| **Blocks** | support-desk packages unpublished |
| **Anti-patterns** | Treating Support Desk as hosted SaaS; AI on ticket bodies before the host documents egress |

## Explicitly out of backlog (non-goals)

- Recipes that copy pegma.dev or retiregolden.org route maps, schemas, or ops topology
- Password-based auth “compatibility” recipes (Identity refuses passwords)
- Spine durable-event recipes (Spine refuses durable events on the in-process bus)
- Multi-package monorepo scaffolds that dictate a UI framework

## Mapping to plan Phase 2 exit

| Plan requirement | Backlog id |
| --- | --- |
| End-to-end accounts on Cloudflare-shaped host | P1 `cf-passkey-accounts` |
| Storage + audit/mail outbox pattern | P2 `storage-audit-mail-outbox` |

Ship P1 and P2 fixtures before declaring Phase 2 done. P3–P6 improve coverage;
D1–D2 wait on publication.
