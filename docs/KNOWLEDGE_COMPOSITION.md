# Knowledge Base host composition

This is a **source candidate**, with public activation disabled. The host uses
exact published `@pegma/agent-access@0.1.1` and all four
`@pegma/knowledge-base-*` packages at `0.1.3`, over its existing Identity,
Sessions, stored roles and D1 Store. The public catalog at `/api/mcp` remains
separate from protected article authoring.

The bounded-maintenance dependency is now installed through the exact alias
`@pegma/rate-limit-paged: npm:@pegma/rate-limit@0.3.3` in
[`package.json`](../package.json) and [`pnpm-lock.yaml`](../pnpm-lock.yaml).
The [published `0.3.3` release](https://github.com/pegma-dev/rate-limit/releases/tag/v0.3.3)
at signed source
[`72358940203e1d398087f2fbe49d33ee95b6fb71`](https://github.com/pegma-dev/rate-limit/commit/72358940203e1d398087f2fbe49d33ee95b6fb71)
passed independent exact-byte, signature/provenance and registry-consumer
verification. Existing Identity and Support Desk keep their
`@pegma/rate-limit@0.2.0` dependency; Support Desk remains at `0.1.1`.

All four exact KB `0.1.3` packages, including the shared report factory, are now
installed in the manifest and lockfile. The
[verified `0.1.3` release](https://github.com/pegma-dev/knowledge-base/releases/tag/v0.1.3)
at signed source
[`8b4c25aa6a40f0c56be97f07e3b7b5ac6136a99b`](https://github.com/pegma-dev/knowledge-base/commit/8b4c25aa6a40f0c56be97f07e3b7b5ac6136a99b)
passed full-set original-byte, signature/provenance and registry-consumer
verification. Recovery retained the original prepared artifact without
repacking; the [release run completed at attempt 5](https://github.com/pegma-dev/knowledge-base/actions/runs/42533473529/attempts/5).
Host type/runtime/build/review gates remain pending and activation is disabled;
producer verification and installation are not host or actual-client acceptance.
Do not substitute a source
checkout, local tarball, dependency override, or forced SDK/schema deduplication
for the released producer graph. The catalog transport and protected KB
transport retain their respective released dependencies.

## Configuration and activation

`worker/wrangler.jsonc` starts with `PEGMA_KNOWLEDGE_ENABLED=false` and
`PEGMA_AGENT_CLIENTS_JSON=[]`. Disabled requests return before constructing
Identity or opening D1. Scheduled storage maintenance is a separate path and
must continue independently of this request switch.

Missing or empty client configuration disables the OAuth issuer and delegated
transports. Invalid optional agent configuration also leaves those paths
unavailable without disabling browser guides and human review, provided the
browser's own configuration is valid. No alternate client or authority is
invented as a fallback.

Client configuration is an explicit JSON array of the released `PublicClient`
shape: `clientId`, `name`, `redirectUris`, `allowedScopes`, and `grantTypes`.
The host bounds it to 16 clients and 16 KiB, rejects unknown fields/scopes,
and delegates redirect and OAuth validation to Agent Access. Never infer a
registration or callback from a synthetic test. Record the actual requested
client, installed version, provider mode, callback and observed flow. There is
no dynamic registration endpoint or client secret.

Wrangler owns plain variables; deployment replaces dashboard-added plain
variables. Change configuration through review and regenerate Worker types.
The two exact discovery routes belong to Worker ingress. Logical collections
use the existing generic Storage Core schema with
`createSchemaIfMissing:false`; no new SQL migration is added by this slice.

Keep test collections closed during controlled staff acceptance. The disabled
candidate is not advertised through new global navigation or Account links.
Expose those entry points only after activation requirements pass. Actual
existing-login/Admin consent, device/PKCE flows, scoped API/MCP operations,
revocation, and failure cases must be observed through the requested clients.
Source and full D1 tests do not establish any of the four actual client
acceptances, provider/staging controls, production readiness, or pilot results.

## Current roles and browser boundaries

The [host policy](../worker/src/support-access.ts) keeps authority explicit:

- `Support` retains exactly its original six Support Desk permissions: queue
  read, staff reply, notes, assignment, management and Audit read. Existing
  assignments are not migrated or silently granted KB powers.
- `Knowledge` is a separately assigned role for collection reads, draft and
  evidence work, human report review, publication and withdrawal. Admin-only
  collection/governance mutation controls remain separate.
- `Admin` keeps role administration, full intended KB administration and the
  exclusive permission to link agents. An Admin explicitly assigns/revokes
  `Knowledge` through the existing audited role surface.

Authenticated accounts receive the named article-read permission; collection
audience policy and the released KB's current publication checks still decide
which guides they can read. Role names do not bypass those checks.

`/account/agents/device` accepts a human-entered/confirmed code of at most 128
characters. `/account/agents/authorize` displays the exact request and requires
an explicit decision. Existing login resumes only allowlisted same-origin
agent paths; it never auto-approves. Consent pages/data are no-store and
no-referrer. Untrusted text is rendered as text, using external CSP-compatible
scripts; tokens are not placed in URLs or browser storage.

`/api/agent-access/*` composes the released protocol plus browser-only consent
and known-grant controls. Discovery is at
`/.well-known/oauth-authorization-server` and
`/.well-known/oauth-protected-resource/api/knowledge/mcp`.
The canonical audience is `https://pegma.dev/api/knowledge/mcp`;
`/api/knowledge/v1` shares that audience and the same dispatcher.

Every bearer use and refresh rechecks the active account and current role
permissions. Initial delegated scopes are only draft read, draft write and
evidence submission. They carry no Admin, Support or Knowledge role, linking,
publication, review, collection/governance control, or private provenance
authority. Future scopes require explicit configuration and fresh consent.

Browser commands use current session, same-origin and CSRF checks; a cookie
alone cannot authenticate protected authoring transports, which require header
bearer authentication. Grant controls are owner-only. After device approval,
the UI reads the actual `GrantView` and displays its returned grant ID/status
and revocation controls; a failed management lookup does not undo accepted
consent. Logout revokes the browser session, not every agent family.

`/staff/knowledge` exposes capability-gated collection reads, management,
draft/report review, exact publication, article retirement and exact evidence
revocation. `/knowledge` uses only the three signed-in portal operations and
their safe published DTOs, never private evidence/provenance/reviewer data.

## Human-reviewed test reports and KB acceptance

An agent with evidence-submission scope submits a bounded report through
`/api/knowledge/reports`, using the current ledger epoch. It can retrieve only
its own safe acknowledgement/status and opaque receipt. Staff inspect full
report text, artifact hashes, execution time/result, and the exact draft,
revision/hash, policy/check/applicability/build and validation requirements.

Confirmation is a human browser review, not accepted KB evidence or an
automatic test execution. A currently authorized Knowledge reviewer or Admin
may confirm the report, including an Admin who owns its submitting agent.
There is **no reviewer-different-from-submitter or two-person rule**. Agent
scope or a model's assertion alone cannot perform that human confirmation.

The decision binds the exact submitting principal, ledger epoch, report
generation and complete current review hash. The released requirements DTO
includes governance generation, policy, expected build and check freshness;
raw governance mutation authority is not required to review it. A changed
view requires fresh review. Confirmation never refreshes execution time.

The agent subsequently calls actual released `submitEvidence` with its
current receipt and exact submission. The host rechecks the confirmation,
receipt generation, submitting identity and current reviewer authority. The
KB independently checks trusted attester/runner, revision/hash/policy,
applicability/build, result and freshness. A human confirmation can still fail
those acceptance prerequisites. A currently trusted reviewer can explicitly
reassess an unchanged, still-fresh report; reassessment clears confirmation,
advances its generation, rotates the opaque receipt and returns it to pending.
The agent retrieves its current status/receipt before resubmission. Reassessment
does not relabel an old execution as a test of a different article revision.

Article publication still requires the complete current SDK review snapshot.
Report rejection/reset is not KB evidence revocation. Staff use actual
`revokeEvidence` with the exact accepted revision/id/version/hash and generation,
or `retireArticle` with its current generation, for those separate changes.

## Report retention and replay horizon

The host ledger permits at most 16 reports and 160 physical rows per article,
with bounded report/Audit/command data. Expired, failed or rejected reports are
not automatically removed merely because execution-age validity has elapsed.
The host has no automatic report TTL eviction; operators own retention and
approved export/deletion procedures.

Authorized staff can inspect ledger capacity and explicitly reset its current
epoch with an expected-epoch fence. Reset immediately marks the next epoch
`resetting`, permanently invalidating earlier report receipts and command
replays. Cleanup removes at most 48 old rows per drain call; at most four
calls cover the finite ledger. The UI bounds each cleanup pass to four calls
and offers explicit continuation after interruption. New report work resumes
only when the ledger is active. The head retains a bounded reset/history seal,
not an unlimited archive of drained reports, Audit events or receipts.

Within an active epoch, exact command replay returns its historical bounded
acknowledgement, not a new confirmation or proof that an old receipt generation
is current. Reassessment invalidates earlier receipt generations. Reset ends
that epoch's replay horizon; only the head's latest exact reset operation has
its bounded retry acknowledgement. Preserve required operational evidence
before choosing a reset rather than treating receipts as permanent history.

There is no report-backed private-source bridge in this integration. Browser
and agent draft inputs cannot attach arbitrary `sourceReferences`; PG01
provenance remains empty/read-only. A later Support-source integration must
compose the real authorization/withdrawal verifier separately.

Once the actual KB accepts evidence and publishes revision 1, a later draft
or elapsed report/check TTL alone does not withdraw that approved publication.
Ledger reset/draining also does not erase accepted KB evidence or publication.
The SDK retains its immutable approved revision and own current access/policy,
revocation and retirement gates. Do not convert report retention or a newer
draft into an invented publication-eligibility check.

## Admission and maintenance

KB browser admission defaults to 120 requests per five minutes per IP through
`PEGMA_KNOWLEDGE_BROWSER_LIMIT`. Protected resource admission defaults to 300
through `PEGMA_AGENT_RESOURCE_LIMIT`, shared across HTTP, MCP and report
operations for that IP. These are shared abuse budgets, not per-user quotas;
reviewers behind one egress can share capacity. Both settings accept integers
from 1 through 10,000. UI refusals surface HTTP 429 and `Retry-After`.

The new source imports the installed separate `@pegma/rate-limit-paged` alias
for verified Rate Limit `0.3.3`. Policy names include
`.v1.limit-<count>` instead of rewriting an immutable descriptor under the old
name. Old Identity/Support policies stay on their existing `0.2.0` import.
New names have independent counters; coordinate configuration changes rather
than assuming old/new budgets combine. The producer dependency is installed;
validating the resulting current head and host acceptance remain activation
prerequisites.

### Limiter window cleanup

The [Knowledge limiter cleanup lane](../worker/src/knowledge-maintenance.ts) scans one
global physical page of 10 rows each time its scheduled turn runs, regardless
of the Knowledge feature flag or agent registration. It shares the scheduler
with the existing Identity/Support lanes and uses the paged helper instead of
enumerating live configured policies. Its bookmark advances only after
success, retaining the prior continuation on failure. Follow no-deletion
pages and repeat complete cycles; pages are not snapshots. Descriptors,
malformed/legacy `0.2.0` rows and unknown layouts remain retained. The new lane
does not silently migrate old limiter storage. Existing Identity/Support
maintenance remains in place. This source candidate does not establish live
maintenance execution.

### Retrieval projection repair

[createKnowledgeRetrievalMaintenance](../worker/src/knowledge-retrieval-maintenance.ts)
uses an internal server-owned principal with only `knowledge.index.manage`,
without an Admin role or new staff/agent grants. On the existing Knowledge turn
of the [15-lane cleanup schedule](../worker/src/maintenance-schedule.ts),
`runPage()` invokes one real `repairRetrievalPage` with a physical scan limit of 10. This is a separate KB projection page, not the ten limiter-window rows.
Additional SDK keyed reads and projection writes have their own bounds. The
new page requires the current exact `PEGMA_KNOWLEDGE_ENABLED=true` gate;
limiter cleanup remains independent of that flag and of projection failures.
The existing cleanup cron remains `0-58 * * * *`.

The projection bookmark uses the separate `pegma-dev-maintenance` key
`{ partition: 'knowledge', id: 'retrieval' }`. Its cursor and monotonic
generation advance through OCC only when the prior cursor/generation still
match, including a generation increment for `null` to `null`. A failed page
does not advance its checkpoint, and stale overlapping completions cannot
replace newer progress. Checkpoint
acknowledgement uncertainty is resolved by rereading durable state; projection
writes already completed are not rolled back. Retry the retained continuation
and repeat complete cursor cycles, including
no-match pages and pending work. Logs contain coarse counts/status/stages,
not article IDs, cursors, queries, private bodies or exception text.

Successful `publishArticle`, `retireArticle` and `revokeEvidence` commands also
attempt one private bounded keyed `repairArticleIndex` through the
[API/runtime hook](../worker/src/knowledge-runtime.ts). HTTP requests do not
scan the corpus or expose maintenance operations/DTOs. A repair failure leaves
the committed mutation intact and does not replace its result. The existing
final browser-authority check still runs after the awaited hook and can
withhold an acknowledgement if authority changed.

The page worker constructs the actual application from the same Store and
clock without report-factory, login, provider or agent-client construction.
Publication eligibility still checks retained accepted evidence and current
policy. These hosts currently have no `privateSources` verifier: retained
nonempty private-source references remain blocked/unavailable. A future
source-enabled composition must supply its real eligibility/currentness ports
to both request and repair paths; there is no allow-all fallback.

Keyed repair is best effort and does not guarantee immediate portal discovery
or search readiness. Collection/policy changes, missed work and cleanup still
need repeated page cycles. There is no indexing latency/SLA claim. Customer
retrieval always rechecks actual publication, audience and proof/source
revocation; stale index hints cannot grant access or restore approval.

Disable the feature if acceptance fails. Identity, role administration, human
Support Desk and the public catalog retain their original composition. No
model/provider, automatic publication, GitHub export or customer notification
is enabled by this slice. Production settings, installed-client results,
staging/privacy controls and supervised pilots remain host-owned proof.
