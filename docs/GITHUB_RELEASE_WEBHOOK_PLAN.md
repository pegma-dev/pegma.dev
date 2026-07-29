# GitHub Release Webhook Plan

## Status

**Stage:** Phase E activated (2026-07-29). Worker secret installed,
`pegma-dev-api` version `52d03e76-b69a-42c8-9d63-bcb6316e33f3` deployed with
release routes and six-hour recon cron. Organization release webhook is live;
GitHub's authenticated `ping` returned **204**. Controlled release projections
and `GET /api/releases` / Stack shell are live. Optional follow-up: observe a
real stable publish and the first scheduled recon success marker.

**Phase A reconciliation (2026-07-28):** `@pegma/webhooks` is pinned to
`@pegma/storage-core@0.4.0` (commit `1e5ef0732c3595ea82cb80394cf55cd9a0442318`).
pegma.dev vendors that exact `npm pack` artifact under
`vendor/@pegma/webhooks/` with SHA-256 and integrity recorded in
`PROVENANCE.md`. Ledger smoke tests exercise `createMemoryStore()` and the
production D1 composition (`createSchemaIfMissing: false` over the generic
Pegma storage schema). No D1 schema migration is required for new Storage
Core collections. The host still nests `@pegma/storage-core@0.3.0` under
published `@pegma/health`, `@pegma/rate-limit`, and `@pegma/sessions` pins —
pre-existing on `main`, with no newer published releases that declare 0.4.0.
Phase A closes the Webhooks/host Store contract gap; republishing those three
packages is separate host debt, not a webhook-handler prerequisite. The
vendored package README carries only the MIT copyright line for
RetireGolden, LLC — no consumer-migration or commercial planning text.

**Phase B reconciliation (2026-07-28):** `POST /api/webhooks/github/releases`
authenticates raw-body HMAC-SHA256, allowlists organization `309286193` and
explicit repository IDs, records deliveries in `@pegma/webhooks` (`source:
"github"`), and projects current stable releases into the
`componentReleases` collection. Draft/prerelease events are acknowledged
without projection. No payload fields cross the release codec.

**Phase C reconciliation (2026-07-28):** `GET /api/releases` serves schema
`pegma.releases.v1` for allowlisted catalog slots (empty `current` when
unset), with `max-age=300`, ETag (content-stable), and `nosniff`. The Stack
page loads `/stack-releases.js` same-origin and renders loading, empty,
populated, stale, and unavailable states; repository links remain usable
without JS or when the API fails.

**Phase D reconciliation (2026-07-28):** Six-hour cron `0 */6 * * *` runs
GitHub reconciliation by numeric repository ID, separately from the
per-minute Identity maintenance job. Backfill is the same path; no Webhooks
receipt rows.
Authoritative apply converges missed delete/unpublish to GitHub's current
stable. Webhook projection invalidates the per-repository recon ETag (with
an epoch so recon cannot restore a stale tag after a concurrent invalidation).
Health detail `githubReleases` exposes configuration, last webhook and recon
times, staleness, and current count. Operator docs cover secret install, org
webhook, redelivery, recon, and rollback.

**Phase E activation (2026-07-29):**

- Gates: `npm run check`, `npm test` (108 + 1 D1), `npm run build` on
  `origin/main` before deploy.
- Secret: `GITHUB_WEBHOOK_SECRET` installed via Wrangler (not in git/Actions).
- Deploy: Worker version `52d03e76-b69a-42c8-9d63-bcb6316e33f3` on
  `pegma.dev/api/*` with crons `* * * * *` and `0 */6 * * *`.
- Smoke: operator signed `ping` → 204; unsigned POST → 401; health
  `githubReleases.ingestionConfigured=true`; `GET /api/releases` schema
  `pegma.releases.v1`.
- Controlled deliveries: signed `release` events for allowlisted repos with
  real GitHub stable tags projected to D1; duplicate delivery GUID → 204
  without change; `currentReleaseCount` 9 after seed.
- Stack page includes same-origin `/stack-releases.js` shell (Pages already
  serving Phase C markup).
- Organization webhook: subscribed to release events; **GitHub-originated
  authenticated `ping` returned 204** (2026-07-29).
- Optional ops: first scheduled recon success marker on next `0 */6 * * *`
  UTC; confirm Stack updates on the next real stable publish without a
  Pages deploy.

**Goal:** Keep the public release version and release date for Pegma
components current on pegma.dev without a content commit, Pages build, or site
deployment for each release.

**Recommended implementation:** GitHub sends organization-level `release`
webhooks to the existing `pegma-dev-api` Worker. The Worker authenticates the
delivery, records it through `@pegma/webhooks`, projects the small public
release summary into the existing D1-backed `Store`, and exposes that summary
through a same-origin read endpoint. The Pages-hosted site loads the endpoint
at runtime.

This is deliberately not a GitHub Actions pipeline that asks Pages to rebuild.
Such a pipeline would remove the content commit but still deploy the site and
would not exercise `@pegma/webhooks`.

## Why this belongs here

The integration is a real production use case rather than a demonstration:
pegma.dev is the ecosystem's public status surface, GitHub releases are the
authoritative release facts, and those facts should not wait for a second
content lifecycle.

It also adds useful evidence for two Pegma components:

- Webhooks runs against a second provider, host, cloud, and storage adapter:
  GitHub on Cloudflare/D1 rather than Stripe on Azure Tables.
- Storage Core's D1 adapter carries another independently useful collection
  and concurrency path in production.

It does **not** by itself prove every Webhooks Phase 3 claim:

- Stripe and GitHub remain in different hosts, so this does not exercise two
  provider partitions inside one physical host.
- GitHub does not automatically retry failed webhook deliveries. Manual or
  API-driven redelivery can test deduplication and failure counting, but it is
  weaker evidence for automatic retry storms and quarantine ergonomics.

The Webhooks project plan must therefore describe this as a second real
provider and portability result. It must not call the existing same-host
multi-source acceptance criterion complete unless that criterion is
deliberately revised.

## Current baseline and prerequisites

pegma.dev already has the pieces this design should reuse:

- `pegma-dev-api` is routed at `pegma.dev/api/*`.
- The Worker constructs a Storage Core `Store` through
  `@pegma/storage-cloudflare-d1`.
- D1 schema creation is deployment-managed and disabled on request paths.
- Cloudflare Workers Logs and the optional Datadog logger are composed through
  the Spine `Logger` port.
- A scheduled handler and durable maintenance cursors already exist.
- The static site's CSP permits same-origin scripts, so it can read a
  same-origin JSON endpoint without admitting third-party script execution.

Before implementation:

1. Align Webhooks with the exact Storage Core version used by pegma.dev.
   Webhooks currently pins `@pegma/storage-core@0.3.0`; pegma.dev and its D1
   adapter use `0.4.0`. Do not install parallel Storage Core contracts and
   assume structural compatibility.
2. Run the Webhooks memory and real-Azurite suites after the pin change, then
   exercise the exact packed artifact against the D1 adapter in pegma.dev.
3. Because `@pegma/webhooks` is unpublished, consume a byte-reproducible
   `npm pack` artifact from an identified Webhooks commit. Record its commit,
   SHA-256, npm integrity, and reproduction command beside the vendored
   artifact. Remove this bridge after the first package release.
4. Confirm that adding new Storage Core collections needs no D1 schema change.
   The current adapter uses the generic Pegma storage schema; if that
   assumption is false, stop and use the repository's fail-closed migration
   process before changing production.
5. Decide whether the first UI is a release section on the Stack page or a
   dedicated Releases page. Recommendation: show compact current-version
   facts on Stack and link each value to its GitHub release.

## Architecture

```text
GitHub organization release event
              |
              v
POST /api/webhooks/github/releases
  - bounded raw body
  - HMAC-SHA256 verification
  - event, organization, and repository allowlists
              |
              v
@pegma/webhooks ledger (source: "github")
              |
              v
Idempotent current-release projection in the existing D1 Store
              |
              v
GET /api/releases
              |
              v
Pages-hosted Stack/Releases UI
```

The request path never calls the GitHub REST API and never triggers a Pages
deployment.

## Webhook boundary

Add one Worker route:

`POST /api/webhooks/github/releases`

Processing order is load-bearing:

1. Require `POST` and `application/json`.
2. Reject a declared or streamed body larger than 1 MiB before JSON parsing.
   GitHub's global payload ceiling is much larger, but a release event should
   never need it.
3. Read the raw bytes once.
4. Verify `X-Hub-Signature-256` over those exact bytes using a high-entropy
   Cloudflare-managed secret and Web Crypto HMAC-SHA256.
5. Require `X-GitHub-Event: release` and a valid
   `X-GitHub-Delivery` GUID.
6. Parse JSON only after authenticity, headers, and size checks pass.
7. Require the expected GitHub organization ID and an explicit allowlist of
   repository IDs from the parsed payload. Stable numeric IDs are the
   authority; names are display data and may change.
8. Pass the delivery GUID to the Webhooks ledger as the event ID and a static
   event type such as `github.release.published`.

`ping` deliveries may receive an authenticated `204` without entering the
release ledger. All other event families receive a non-success response or an
explicit ignored response according to the final endpoint contract; do not
silently broaden the endpoint into an organization-event collector.

Signature verification remains host code. It does not move into
`@pegma/webhooks`.

## Release projection

The Webhooks receipt and public release summary are different records:

- The receipt proves whether one GitHub delivery completed and contains no
  provider payload.
- The release projection supplies the public facts pegma.dev renders.

Declare a release collection through Storage Core. One current stable release
per repository is sufficient for the first slice.

Suggested public record:

```ts
interface ComponentRelease {
  readonly repositoryId: string;
  readonly repositoryName: string;
  readonly releaseId: string;
  readonly tagName: string;
  readonly publishedAt: string;
  readonly releaseUrl: string;
  readonly observedAt: string;
}
```

Rules:

- Key the record by stable repository ID.
- Treat `tagName` as the displayed version. Do not silently parse or normalize
  it as SemVer.
- Store only the fields above. Do not persist the webhook payload, release
  body, actor, assets, commit message, or other provider data.
- Accept only public, non-draft, non-prerelease releases for the initial UI.
- Handle the relevant `published`, `released`, and `edited` actions as
  idempotent upserts of the **current** stable release only when the
  incoming release is newer than the stored record (compare `publishedAt`,
  then `releaseId` as a tie-breaker). An `edited` delivery for an older
  release must not displace a newer current record; if it matches the
  stored `releaseId`, update the stored fields in place.
- Handle `unpublished` and `deleted` by removing or invalidating the matching
  current record **only when** the event's `releaseId` matches the stored
  current release, then let reconciliation select the preceding stable
  release.
- Ignore draft and prerelease actions after recording an authenticated
  delivery outcome.
- Construct or validate GitHub links against `https://github.com/pegma-dev/`;
  do not render an arbitrary URL from the payload.

The release projection write and receipt transition are not cross-collection
atomic. The projection must therefore be idempotent on its own. A crash after
the projection succeeds but before `markProcessed` must make a redelivery
harmless.

## Webhooks ledger behavior

Construct one ledger over the Worker's existing Store:

```ts
createWebhookLedger({
  store,
  source: "github",
  logger,
});
```

Expected handler flow:

1. `begin(deliveryId, eventType)`.
2. If the receipt is already `processed` or `quarantined`, acknowledge without
   applying the projection again.
3. Apply the idempotent release projection.
4. `markProcessed(deliveryId)`.
5. On a processing failure, call `markFailed(deliveryId)`.
6. Return a failure while the receipt remains retryable; acknowledge only
   after the package reports quarantine.

GitHub does not automatically redeliver failures, so the fifth and sixth steps
mainly govern manual or API-driven redelivery. Quarantine logs remain useful,
but scheduled reconciliation is the real missed-delivery recovery mechanism
for this provider.

Do not change the package's honest concurrency posture. Two overlapping
deliveries may both project the same release, and the projection must tolerate
that.

## Read API and site behavior

Add:

`GET /api/releases`

The response contains only allowlisted repositories and their current stable
release summaries, in the component registry's display order. Requirements:

- return JSON with an explicit schema/version;
- include a server observation timestamp;
- use an ETag or a short public cache lifetime, initially no more than five
  minutes;
- set `X-Content-Type-Options: nosniff`;
- never expose receipt rows, delivery IDs, quarantine internals, secrets, or
  operator diagnostics;
- return an empty-but-valid result when no release exists for an allowed
  repository.

The static page uses a same-origin external module to fetch this endpoint and
replace a clearly labelled loading state. If the API is unavailable or
JavaScript is disabled, each component still shows its repository link and
the page remains usable. No third-party scripts or analytics are introduced.

The initial content deployment adds the shell once. Later release events
change D1 data only; they do not change or redeploy site content.

## Initial backfill and reconciliation

Webhooks only observe events created after the organization webhook is
enabled. Seed existing releases before exposing the UI.

Use GitHub's public Releases API to fetch the latest public stable release for
each allowlisted repository and pass it through the same release-projection
function used by webhook ingestion. Reconciliation does not fabricate
Webhooks receipt rows because it is not a webhook delivery.

Add a separate scheduled cadence, recommended every six hours. Dispatch by the
Cron expression so the existing one-minute Identity maintenance remains
independent. Reconciliation should:

1. fetch only allowlisted public repositories;
2. use conditional requests where available;
3. bound response sizes and request timeouts;
4. upsert the authoritative latest stable release;
5. remove a local record when the repository has no public stable release;
6. persist a cursor or last-success marker;
7. log counts and classifications without response bodies.

Public unauthenticated GitHub API access is sufficient at the current
repository count. If its limit becomes operationally inadequate, use a
least-privileged GitHub App installation token; do not introduce a broad
personal token.

## Operational visibility

Extend health detail without exposing sensitive state:

- release ingestion configured;
- last successful release webhook time;
- last successful reconciliation time;
- reconciliation stale/not stale;
- number of current release summaries.

Use the existing Spine logger composition for:

- signature rejection classification;
- disallowed event/repository classification;
- processed, duplicate, and quarantined delivery counts;
- reconciliation success/failure and record counts.

Do not log raw bodies, signatures, release bodies, actors, or secrets.

An operator can inspect quarantined receipt rows in D1. Do not add a public
replay or acknowledgement endpoint.

## Security review requirements

This work adds an unauthenticated Internet-facing Worker route (webhook
ingestion and a public release read endpoint) and therefore requires the
repository's security diff workflow before deployment.
Review at least:

- raw-body HMAC verification and constant-time comparison;
- missing, malformed, rotated, and incorrect secrets;
- body-length and content-type enforcement;
- organization and stable repository-ID allowlists;
- replay and duplicate delivery behavior;
- out-of-order release actions;
- arbitrary URL injection into rendered links;
- JSON and HTML output encoding;
- log and persistence data boundaries;
- failure behavior before and after quarantine;
- interaction with existing Identity routes and shared D1 resources;
- cross-origin behavior of the public read endpoint and webhook POST route.

The GitHub webhook secret is installed directly as a managed Worker secret.
It never enters GitHub Actions, the repository, Pages output, health detail,
or logs. Document a coordinated rotation procedure because GitHub
organization webhooks expose one active secret at a time.

## Implementation phases

### Phase A - dependency alignment and exact artifact

Repositories: Webhooks, pegma.dev.

- Align Webhooks to `@pegma/storage-core@0.4.0`.
- Run its format, type, memory, and real-Azurite gates.
- Pack the exact verified Webhooks commit.
- Vendor and pin the artifact in pegma.dev with provenance and integrity.
- Prove the package runs over `createMemoryStore()` and the D1 adapter.

Exit: one exact package shape passes both Webhooks' existing backends and
pegma.dev's current Storage Core/D1 composition.

### Phase B - release catalog and webhook handler

Repository: pegma.dev.

- Add the release collection and codec.
- Add the pure action-to-projection logic.
- Add GitHub header/body parsing and HMAC verification.
- Compose the GitHub ledger over the existing production Store.
- Route `POST /api/webhooks/github/releases`.
- Add unit and integration tests.

Exit: signed fixtures update the release catalog exactly once, duplicates are
harmless, invalid traffic has no storage effect, and no payload field crosses
the codec.

### Phase C - read surface and UI

Repository: pegma.dev.

- Add `GET /api/releases`.
- Add the accessible static shell and same-origin runtime fetch.
- Add loading, empty, stale, and unavailable states.
- Add endpoint and page tests.

Exit: release facts appear from D1 without a Pages content change and the page
remains useful when the API is unavailable.

### Phase D - recovery and operations

Repository: pegma.dev.

- Add initial backfill.
- Add six-hour reconciliation beside, not inside, minute Identity maintenance.
- Extend health and structured logs.
- Document secret installation, organization webhook configuration,
  redelivery, reconciliation, and rollback.

Exit: a missed or deleted GitHub delivery converges to GitHub's current stable
release state without operator database edits.

### Phase E - production activation

External configuration: Cloudflare and GitHub organization.

1. Run the complete site and Worker gate.
2. Complete the security diff review.
3. Install the Worker secret.
4. Deploy the Worker before configuring GitHub.
5. Backfill and verify `GET /api/releases`.
6. Create one organization webhook subscribed only to release events.
7. Verify the authenticated `ping`.
8. Publish or redeliver a controlled release event.
9. Confirm the page changes without a commit, Pages build, or Pages deploy.
10. Confirm duplicate redelivery is acknowledged without changing the
    projection.
11. Observe logs, D1 rows, health, and scheduled reconciliation.

Exit: a real stable Pegma release updates pegma.dev within the webhook and
cache latency budget, and reconciliation repairs a deliberately missed
delivery.

## Test matrix

The mechanized evidence must cover:

- GitHub's published HMAC fixture;
- absent, malformed, and invalid signatures;
- wrong method, content type, event family, organization, and repository;
- missing/malformed delivery GUID;
- declared and streamed oversized bodies;
- stable release publish and edit;
- draft and prerelease exclusion;
- unpublish/delete followed by reconciliation;
- duplicate and overlapping delivery;
- out-of-order actions;
- catalog success followed by receipt-finalization failure;
- retryable failure and quarantine transition;
- no raw payload or surplus provider fields in D1;
- memory Store and local D1 Store execution;
- read API schema, ordering, caching, and safe URLs;
- UI loading, empty, populated, stale, and unavailable states;
- scheduled reconciliation cursor/freshness behavior;
- no regression to Identity routes or minute maintenance;
- production smoke and manual redelivery.

Repository gates remain:

```text
npm run check
npm test
npm run build
```

Webhooks additionally keeps:

```text
npm run format:check
npm run check
npm test
```

## Acceptance criteria

The slice is complete when:

1. A real GitHub stable release changes the displayed version and publication
   date without a pegma.dev commit or deployment.
2. The organization webhook is authenticated from raw bytes and restricted to
   explicit repository IDs.
3. `@pegma/webhooks` records delivery identity and outcomes over the production
   D1-backed Store.
4. Duplicate, overlapping, and manually redelivered deliveries cannot corrupt
   the release projection.
5. No webhook payload is persisted or logged.
6. The public endpoint and page expose only the intended release facts.
7. Initial backfill covers existing releases.
8. Scheduled reconciliation repairs missed, edited, unpublished, and deleted
   releases.
9. Quarantine and reconciliation failures are visible to operators without a
   public administrative endpoint.
10. The complete site/Worker and Webhooks gates pass, including real Azurite
    and local D1 evidence.
11. The Webhooks plan records exactly what the second provider proved and
    leaves same-host multi-source evidence open unless deliberately revised.

## Rollback

- Disable the GitHub organization webhook first.
- Keep the read endpoint returning the last known public records while the
  issue is investigated, unless record integrity is in doubt.
- If integrity is in doubt, disable release rendering and fall back to
  repository links.
- Reconciliation can rebuild the projection from GitHub; receipt rows and
  release summaries contain no payload data.
- Roll back the Worker version through the existing operator process.
- Do not roll back or rebuild Identity data to remove this feature; the
  collections are logically independent even though they share the D1
  database.

## Clean-up and documentation

After activation:

- update this document with the deployed Worker version, webhook activation
  date, exact package commit, and verification evidence;
- update `docs/PROJECT_PLAN.md` to record the release-data consumer;
- update the Webhooks project plan with the second-provider verdict and the
  remaining same-host evidence;
- update `worker/README.md` with routes, secrets, reconciliation, health, and
  operator recovery;
- remove any controlled test release or tag used only for activation;
- remove the vendored artifact and provenance note after
  `@pegma/webhooks` is published and the registry artifact is verified;
- do not publish Webhooks, cut a release, or create a tag as an incidental
  implementation step.

## Decisions to confirm before implementation

1. **Phase 3 accounting:** Treat this as partial Webhooks Phase 3 evidence
   unless the owner deliberately changes the same-host requirement.
2. **Display:** Show current stable versions on the Stack page first; add a
   separate release-history page only if real demand appears.
3. **Release class:** Stable GitHub releases only; omit drafts and prereleases.
4. **Freshness:** Webhook-driven updates with a five-minute maximum public
   cache and six-hour authoritative reconciliation.
5. **History:** Store only the current stable release per repository in the
   first slice.

## Reference documentation

- [GitHub webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads#release)
- [GitHub webhook signature validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [GitHub failed-delivery recovery](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Webhooks project plan](https://github.com/pegma-dev/webhooks/blob/main/docs/PROJECT_PLAN.md)
- [Storage Core repository](https://github.com/pegma-dev/storage-core)
