# pegma-dev-api Worker

Cloudflare Worker composition root for pegma.dev. It preserves the existing
Pegma logging composition and public health endpoint, and hosts the public
composition catalog MCP at `POST/GET https://pegma.dev/api/mcp` (Streamable
HTTP; catalog facts only — fetches `https://pegma.dev/catalog.json`).

```ts
createTeeLogger(createCloudflareLogger(), createDatadogLogger(submit));
```

## Cloudflare log store

Workers Logs is enabled in `wrangler.jsonc` via:

```jsonc
"observability": {
  "enabled": true,
  "logs": { "enabled": true, "persist": true }
}
```

Redeploy with `pnpm run worker:deploy`. Query logs in the dashboard under
Workers → `pegma-dev-api` → Observability, or `pnpm run worker:tail`.

## Datadog arm

Optional. Without `DATADOG_API_KEY`, only the Cloudflare sink runs.

```sh
pnpm exec wrangler secret put DATADOG_API_KEY -c worker/wrangler.jsonc
# optional site host (bare domain only; default is us5.datadoghq.com):
pnpm exec wrangler secret put DATADOG_SITE -c worker/wrangler.jsonc
# value: us5.datadoghq.com   (or datadoghq.eu — not a full URL)
```

CI deploys this Worker on push to main (before the Pages deploy) using the
separate least-privileged `CLOUDFLARE_WORKER_API_TOKEN` repository secret
(Worker script + `pegma.dev` route authority only; the Pages credential keeps
no Worker authority). Do not substitute a broad personal OAuth token into
GitHub. `pnpm run worker:deploy` from an authenticated operator session remains
the break-glass path.

## Identity composition

The account boundary is fixed to issuer `https://pegma.dev` and WebAuthn RP ID
`pegma.dev`. Cloudflare D1 is consumed only through
`@pegma/storage-cloudflare-d1`; `@pegma/sessions@0.1.0` stores SHA-256-hashed
opaque session identifiers. The browser receives a cryptographically random
`__Host-pegma_session` cookie with `Secure`, `HttpOnly`, `SameSite=Strict`, and
`Path=/`.

Every Identity response is `no-store`. Browser mutations require the exact
production origin and same-origin Fetch Metadata. Authenticated mutations also
require a per-session synchronizer token. Request bodies are bounded before
JSON parsing, and logs contain route/error classifications rather than contact
data, credentials, codes, or session identifiers.

`GET /api/secure` is the generic backend-authentication proof. It resolves the
opaque `__Host-pegma_session` cookie through `@pegma/sessions`, revalidates the
stored principal against Identity and the Authorization claims adapter, and
returns only the issuer and subject. Missing, expired, revoked, malformed, or
account-invalid sessions receive `401`; every response is `no-store`.

The production composition pins `@pegma/identity@0.1.0` and
`@pegma/authorization-identity@0.1.2`. Account creation and fallback sign-in
commit the email-code operation and its `@pegma/mail@0.1.0` job atomically in
Identity's D1 collection. Start routes never receive or return the generated
code; verify routes accept the user-supplied eight digits, and only the
scheduled renderer recovers the stored protected material for delivery.

Delivery uses a host-owned Resend adapter because its API accepts the Mail
job's mandatory idempotency key and supports authoritative status retrieval
for reconciliation. The adapter has a ten-second timeout and bounds provider
responses before parsing. Email-code capability and passkey removal fail
closed unless a key is present and `IDENTITY_EMAIL_ENABLED` is explicitly
`true`. Cloudflare Email Sending is not used: it requires Workers Paid and
does not document the idempotent submission/reconciliation contract required
here.

Set the stable email-code HMAC secret and optional Resend credential
interactively; never commit either value:

```sh
pnpm exec wrangler secret put IDENTITY_EMAIL_CODE_SECRET_BASE64 -c worker/wrangler.jsonc
pnpm exec wrangler secret put RESEND_API_KEY -c worker/wrangler.jsonc
```

The first value is canonical base64 for 32–128 cryptographically random bytes
and must remain stable while any email-code or Mail job is live. Verify the
`pegma.dev` sender domain and smoke-test delivery before changing
`IDENTITY_EMAIL_ENABLED` to `true`.

### Enabling Resend in production

Production has both `IDENTITY_EMAIL_CODE_SECRET_BASE64` and `RESEND_API_KEY`.
Resend delivery was activated on 2026-07-28 after the `pegma.dev` domain was
verified. Live health reports `emailDelivery: true`, Identity advertises
`emailCode: true`, and an account-code job sent by the scheduled durable
outbox reached Resend's official delivered test sink.

Use this activation sequence for a new environment or credential rotation:

1. Create the Resend account and a sending API key.
2. Add `pegma.dev` as a Resend sending domain and install every DNS record
   Resend supplies. Wait for the domain to show as verified.
3. Put the key directly into the Worker:

   ```sh
   pnpm exec wrangler secret put RESEND_API_KEY -c worker/wrangler.jsonc
   ```

4. Send a provider smoke test from `Pegma <identity@pegma.dev>` to a real
   address controlled by the operator.
5. Change `IDENTITY_EMAIL_ENABLED` in `worker/wrangler.jsonc` to `true`, run
   the complete gate, and deploy.
6. Confirm `/api/health` reports `emailDelivery: true`, then exercise account
   creation. The scheduled worker drains the durable Mail job each minute.

Do not reverse steps 2 and 5. Identity deliberately fails closed so it never
commits a verification-code operation that has no usable delivery path.

### Additional provider adapters

The host-owned adapters live beside the composition root:

- `cloudflare-email-mail.ts` uses Cloudflare Email Service's native
  `SendEmail` binding. Cloudflare does not currently document submission
  idempotency, so construction requires the literal
  `acceptDoubleSendRisk: true`. Authoritative delivery must be supplied from
  Email Sending Queue events through the adapter's `deliveryStatus` port; the
  included event parser normalizes those untrusted payloads.
- `azure-acs-mail.ts` signs the Azure Communication Services Email REST API
  with an access key, derives a stable operation UUID from the Mail
  idempotency key, and uses ACS repeatability headers. The host must durably
  supply the original `firstSentAt` timestamp. The adapter refuses to resubmit
  after ACS's five-minute repeatability window. Recipient delivery comes from
  Event Grid through its `deliveryStatus` port; a successful send operation
  alone is not reported as delivery. The included Event Grid parser produces
  the receipt shape expected by a host-owned status store.

`createIdentityRuntime` accepts either adapter through `mailDelivery`, so
Identity and the durable outbox remain provider-neutral. Production continues
to select Resend until the chosen alternative has its domain, credentials,
event receipt store, and callback correlation configured.

The D1 schema is deployment-managed by
`migrations/0001_pegma_storage.sql`. The adapter runs with
`createSchemaIfMissing: false`, so request traffic never performs DDL.
Migration 0001 was applied to production before Worker activation. Production
CI verifies that exact frozen baseline byte-for-byte; any future migration
fails that gate until a separately least-privileged D1 deployment credential
and migration step are reviewed. The versioned route is limited to
`pegma.dev/api/*`; Cloudflare Pages continues to serve every static path.

Passkey removal stays disabled until an email-code recovery implementation is
live. This deliberately avoids a last-factor lockout in the passkey-only
configuration.

Separate Cron triggers run Mail send every minute and reconciliation every
minute except minute zero (at most a two-minute reconciliation gap). Each
invocation processes at most one operation, retaining its own scan cursor.
Idle runs do not import an unused HMAC key; secret validation remains eager. A separate
`0-58 * * * *` trigger runs one cleanup lane per invocation: challenge cleanup,
email-operation repair, Mail retention, expired Sessions, each of the four
Identity rate-limit policies, Support queue repair/inactive sweep, and each of
the four Support/Admin rate-limit policies. The 14 lanes rotate using the
scheduled UTC time, including across hour boundaries, so each runs every
14–15 minutes. This gives cleanup its own invocation CPU budget instead of
combining every task under the Workers Free 10 ms limit. Authentication and
rate-limit checks still enforce expiry on access; cleanup only reclaims or
repairs stored data. Paged Identity and Support cleanup also consumes at most
one record per invocation. Support cleanup composes only storage, its clock,
and limiters; it does not build Identity, roles, or HTTP handlers.

Each run reads its cursor record once, merges successful lane results into a
single conditional update, and skips unchanged cursors (including empty
pages). Identity and Support retain independent collections and bookmarks.
The D1 adapter retries conditional updates up to three times, re-reading the
current record before merging the changed fields, including when Mail and
cleanup invocations overlap. Cursor-save failures are logged as
`identity.maintenance_failed` or `support.maintenance_failed` with task
`cursors`; the next invocation replays the page from its prior bookmark.
These bookmarks optimize scans rather than commit domain work: Mail leases,
provider idempotency keys, receipts, and conditional cleanup writes remain
durable independently of the cursor save.
Routine per-lane success logs are omitted; invocation logs and error/terminal
Mail logs remain enabled. Replaying a cursor after a crash is safe because
claims and deletions are conditional. Dead-letter and terminal-unknown Mail remains
in D1 for operator inspection until explicitly acknowledged. Email delivery
must remain disabled until the host also has an authenticated, audited
operator acknowledgement workflow; this Worker intentionally exposes no
public acknowledgement endpoint.

## Support Desk composition

Authenticated product feedback uses exact `@pegma/support-desk-*@0.1.0` over
the same `IDENTITY_DB` D1 binding. Support Desk collections
(`support-desk.*.v1`) and host cursor collection
`pegma-dev-support-maintenance` are isolated from Identity mail cursors and
session rows. Customer permissions are granted to any authenticated account
via AccessContext defaults (not a paid entitlement). Categories:
`feedback`, `bug`, `feature_request`, `documentation`, `question`. Subject
marker: `[PEG-…]`. Tracking pages: `/feedback` and `/feedback/{ticketId}`.

Create and reply use durable rate limits `pegma.support.ticket.create` and
`pegma.support.ticket.reply`. Rotating cleanup runs queue repair and
inactive projection sweep with independent cursors. Notifications on
create/reply are omitted in this slice; Pegma templates are composed for a
later mail activation. Health lists Support Desk package detail without
message content; set `SUPPORT_HEALTH_PROBE=true` only when an explicit store
probe is wanted.

See `docs/SUPPORT_COMPOSITION.md`.

## Endpoints

- `GET /`, `GET /health`, or `GET /api/health` — JSON from `@pegma/health`
  (`createProcessCheck` + logging sink booleans). Emits `request.received`
  and, with the checks registered today, `health.ok` through the teed Spine
  logger (both checks are always `ok`; an absent Datadog key is detail only).
  Package mapping for when a check reports otherwise: HTTP `200` for status
  `ok`/`degraded`, `503` for status `fail` (log event `health.failed`).
- `GET /api/identity/capabilities` — issuer, RP ID, and live flow availability.
- `GET /api/identity/account` — verified account and passkey snapshot.
- `POST /api/identity/passkeys/authentication/options|verify` — passkey sign-in.
- `POST /api/identity/passkeys/registration/options|verify` — authenticated
  passkey enrollment.
- `DELETE /api/identity/passkeys` — authenticated passkey removal.
- `POST /api/identity/email-code/account/options|verify` — account creation.
- `POST /api/identity/email-code/sign-in/options|verify` — enumeration-safe
  fallback sign-in.
- `POST /api/identity/logout` — server-side revocation and cookie expiry.
- `GET /api/support/categories` — authenticated category allowlist.
- `GET /api/support/tickets` — list the caller's tickets.
- `POST /api/support/tickets` — create a ticket (CSRF + durable rate limit).
- `GET /api/support/tickets/:id` — read an owned ticket; missing and non-owned
  tickets share one content-free `404`.
- `POST /api/support/tickets/:id/replies` — customer reply (CSRF + rate limit).
- `GET /api/releases` — public current-stable release summaries for allowlisted
  Pegma repositories, in component-registry order. JSON schema
  `pegma.releases.v1`; short public cache (`max-age=300`) and `ETag`; no
  receipt, delivery, or payload fields. Empty `current` when no stable release
  is recorded. The Stack page loads this same-origin endpoint at runtime.
- `POST /api/webhooks/github/releases` — authenticated GitHub organization
  release webhook. Requires managed secret `GITHUB_WEBHOOK_SECRET` plus vars
  `GITHUB_ORGANIZATION_ID` and `GITHUB_ALLOWED_REPOSITORY_IDS`. Invalid traffic
  has no storage effect; stable releases project into the D1-backed
  `componentReleases` collection through `@pegma/webhooks`. Do not configure
  the GitHub organization webhook until Phase E activation.

### GitHub release ingestion (operators)

**Secret (never in git, Actions, Pages, health, or logs):**

```sh
pnpm exec wrangler secret put GITHUB_WEBHOOK_SECRET -c worker/wrangler.jsonc
```

Use a high-entropy random value. GitHub organization webhooks expose one active
secret at a time — rotate by updating the Worker secret and the organization
webhook secret in the same maintenance window.

**Vars (already in `wrangler.jsonc`):** `GITHUB_ORGANIZATION_ID` (numeric) and
`GITHUB_ALLOWED_REPOSITORY_IDS` (comma-separated numeric IDs). Names are display
data only; IDs are the allowlist authority.

**Schedules:** `* * * * *` runs Identity Mail send.
`1-59 * * * *` independently runs Mail reconciliation, skipping minute zero.
`0-58 * * * *` runs one rotating Identity or Support cleanup lane.
`0-59 */6 * * *` reconciles one GitHub repository per invocation, using the
scheduled UTC minute as the slot in the allowlisted catalog. The current
13-repository catalog completes in minutes 0�12 of each six-hour window;
remaining slots return without database or GitHub I/O. The 60-slot capacity is
checked in code. Fetches use stable numeric repository IDs, conditional ETags,
and bounded timeouts/bodies. Full-catalog backfill remains available explicitly.

Each successful scheduled shard records its scheduled timestamp durably in the
existing operations collection. Global reconciliation health advances only
when every currently allowlisted catalog repository has succeeded in that
six-hour cycle. Failed or missing shards keep the prior full-catalog success;
concurrent shards merge progress and preserve webhook ETag invalidation.
Existing records decode missing per-repository progress as empty. No D1 schema
migration is required, and reconciliation never fabricates webhook receipts.

After deploying maintenance changes, check CPU distributions and resource-limit
outcomes for all four triggers, including populated mail pages and release
200/304 responses. Local D1 tests prove bounded page progress and delivery
idempotency, not Cloudflare's production CPU accounting. These changes target
the Workers Free 10 ms allowance; they cannot guarantee an absolute CPU ceiling.

One-record pages trade throughput for headroom: mail scans at most 60 send and 59 reconciliation operation
records per hour, including retained terminal records. A full scan
must remain comfortably shorter than the email-code lifetime; inspect scan
backlogs as usage grows. Cleanup pages advance once per lane every 14�15
minutes. The published Sessions and rate-limit packages still expose
whole-partition sweeps, so their work grows with partition size. Sustained
backlogs need indexed discovery and paginated component APIs, or a larger CPU
allowance. Reducing frequency alone does not raise the per-invocation limit.

**Organization webhook (Phase E):** create one org webhook subscribed only to
`release` events, payload URL `https://pegma.dev/api/webhooks/github/releases`,
content type `application/json`, secret matching the Worker secret. Verify
authenticated `ping` (204) before relying on publish/redeliver.

**Redelivery:** GitHub does not auto-retry failed deliveries. Use the GitHub
webhook delivery UI/API to redeliver; the ledger acknowledges duplicates
without re-applying a processed projection. Missed or deleted events converge
via six-hour reconciliation without operator D1 edits.

**Replay:** GitHub's HMAC covers the body only, so `x-github-delivery` — the
ledger's dedup key — is unauthenticated. Each signed body is therefore bound to
the first delivery id that carried it; the same bytes presented under a
different delivery id are refused with `409 duplicate_body` and have no storage
effect. The binding survives a failed attempt, because GitHub keeps one
delivery id per event across redeliveries: the retry re-binds and runs, while
expiring the claim would be permission to replay that body later.

**Rollback:** disable the organization webhook first. Keep `GET /api/releases`
serving last-known public records while investigating unless integrity is in
doubt — then disable release rendering (Stack still shows repository links).
Roll back the Worker version with the normal operator process; do not touch
Identity collections to remove this feature.

**Health detail `githubReleases`:** `ingestionConfigured`, `readConfigured`,
`lastSuccessfulWebhookAt`, `lastSuccessfulReconciliationAt`,
`reconciliationStale` (true when last success is older than seven hours or
missing), and `currentReleaseCount`. No secrets, delivery IDs, or payloads.

Example body:

```json
{
  "ok": true,
  "status": "ok",
  "service": "pegma-dev-api",
  "checkedAt": "2026-07-27T21:00:00.000Z",
  "checks": {
    "process": { "status": "ok" },
    "logging": {
      "status": "ok",
      "detail": { "cloudflare": true, "datadog": true }
    }
  }
}
```
