# Knowledge Base host composition

The KB host integration is merged in
[PR #59](https://github.com/pegma-dev/pegma.dev/pull/59). The checked-in profile
enables controlled staff authoring qualification with four explicit public client
registrations for testing against closed collections. Merging to `main` starts
the existing deployment workflow, which deploys the Worker before the Pages
site. Confirm that run and the metadata readback below before client tests.
Native-client acceptance and broader rollout remain pending. The host uses
exact published `@pegma/agent-access@0.1.1` and all four
`@pegma/knowledge-base-*` packages at `0.1.6`, over its existing Identity,
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
`@pegma/rate-limit@0.2.0` dependency. The current host selects all five Support
Desk packages at `0.2.7`, including the optional AI coordinator. The separate
synthetic stage remains default-disabled. The
[verified Support Desk `0.2.7` release](https://github.com/pegma-dev/support-desk/releases/tag/v0.2.7)
pins its optional AI dependency on KB application/contracts `0.1.6`.

The learning port forwards actual KB errors without the obsolete `0.1.2`
constructor alias or class-translation shim. The earlier `0.2.1` / nested `0.1.2`
assembly and its failed isolated production-layout diagnostic remain historical;
they neither establish nor replace current-graph qualification.

All four exact KB `0.1.6` packages are installed in the manifest and lockfile.
The release adds bounded native-client MCP request-metadata compatibility and
retains the shared report factory and governed authoring-context/report-query
APIs. Its producer verification covers
original registry bytes, signatures/source provenance and public-consumer
checks at signed source
[`b2946e149078e0ef460f970c2271c196ea9fc759`](https://github.com/pegma-dev/knowledge-base/commit/b2946e149078e0ef460f970c2271c196ea9fc759).
[Verified KB `0.1.6` release](https://github.com/pegma-dev/knowledge-base/releases/tag/v0.1.6).

The historical
[verified `0.1.4` release](https://github.com/pegma-dev/knowledge-base/releases/tag/v0.1.4)
at signed source
[`541e8c93fe1b15bee9345e59b36325f422f97c50`](https://github.com/pegma-dev/knowledge-base/commit/541e8c93fe1b15bee9345e59b36325f422f97c50)
passed full-set original-byte, signature/provenance and registry-consumer
verification. Recovery retained the original prepared artifact without
repacking; the [release run completed at attempt 5](https://github.com/pegma-dev/knowledge-base/actions/runs/42576167664/attempts/5).
That checkpoint records producer verification and installation, with activation
disabled. Host and actual-client acceptance remain separate.
Do not substitute a source
checkout, local tarball, dependency override, or forced SDK/schema deduplication
for the released producer graph. The catalog transport and protected KB
transport retain their respective released dependencies.

The [isolated assistant stage](SUPPORT_ASSISTANT_STAGE.md) uses a separate
Queue consumer and D1 binding with fictional SDK data and a scripted local
model. It adds no public ingress or sixth cron to the existing human/KB
handlers. Actual stage broker and CPU proof remain pending, together with the
existing production, customer and provider acceptance gates.

The current manifest and lockfile pin released KB `0.1.6`,
`@pegma/storage-cloudflare-d1@0.4.7` and genuine `@pegma/storage-core@0.4.0`.
The D1 adapter itself retains that exact Core `0.4.0` dependency; no source alias,
local archive, override or forced Core deduplication supplies the canonical
graph. The frozen registry installation is complete. The current adapter is
identified by the [D1 `0.4.7` release](https://github.com/pegma-dev/storage-core/releases/tag/v0.4.7).

The following D1 `0.4.6` receipt and PG-01 figures describe the earlier checkpoint.

The [qualified D1 `0.4.6` release](https://github.com/pegma-dev/storage-core/releases/tag/v0.4.6)
uses signed source
[`35daa5e679d353fffc9fbf5afe73fe73198d8abf`](https://github.com/pegma-dev/storage-core/commit/35daa5e679d353fffc9fbf5afe73fe73198d8abf)
and annotated tag object `52049598b9088f18cd8fae2a68f243b55cf80815`.
[Release attempt 3 completed successfully](https://github.com/pegma-dev/storage-core/actions/runs/42705318277/attempts/3),
with only D1 newly published and the other package versions reusing their genuine
original archives. Exact registry bytes, source/provenance and public-consumer
verification qualify the producer; they do not qualify this host.

Installed D1 and Core files match the original release archives byte for byte;
actual public ESM imports resolve the same Core module and error classes.
At the PG-01 checkpoint on Node `22.18.0`, the ordinary checked-in configurations passed type checks and
all 554 tests: 505 Node tests across 45 files, 47 real D1 tests across five files,
and two Bench Ticket Worker/D1/R2 tests. The static build emits 21 pages, and
Wrangler's explicit dry run packages the Worker without uploading it. These
checks use the published registry graph, without source aliases. Earlier
source-alias runs remain historical diagnostics.

PG-01's full review, CI and automatic deployment passed at that earlier checkpoint.

### Public 0.2.5 adoption checkpoint

Release evidence for this historical checkpoint is the
[verified Support Desk `0.2.5` release](https://github.com/pegma-dev/support-desk/releases/tag/v0.2.5).

On 2026-11-11, the normal public Support `0.2.5` / D1 `0.4.7` graph passed local
Node `22.18.0` checks, all 1,125 tests, the static build and the main-Worker
packaging dry run. The normal suites comprised 1,002 Node tests across 62 files,
121 Native D1 tests across 12 files and two Bench Ticket Worker/D1/R2 tests,
with zero skips.
[CI run 43034119881](https://github.com/pegma-dev/pegma.dev/actions/runs/43034119881)
for [commit `3a4e5c6a`](https://github.com/pegma-dev/pegma.dev/commit/3a4e5c6a3924acad5764db7173046380f360166f)
also passed the configured frozen install, check, full 1,125 tests and build.
These results describe that source checkpoint. Review and deployment acceptance
remain pending for the changed host.
Actual-client acceptances remain at zero and no pilot has run. The controlled
staff profile below permits gathering those results against closed test
collections. Broader rollout, customer AI and pilot qualification remain pending.

## Configuration and activation

[`worker/wrangler.jsonc`](../worker/wrangler.jsonc) sets
`PEGMA_KNOWLEDGE_ENABLED=true` and four explicit public client registrations
for controlled staff qualification. The prior profile was disabled with an empty
list. A push to `main` runs the [deployment workflow](../.github/workflows/deploy.yml)
and applies these variables after its checks pass.

Before starting client tests, confirm the deployment run succeeded for the
intended commit. Read `/.well-known/oauth-authorization-server` and
`/.well-known/oauth-protected-resource/api/knowledge/mcp` over HTTPS and confirm
both return `200` with the expected Pegma issuer, resource and three authoring scopes.
Check the authorization, device and token endpoint URLs against the configuration.
A `503` such as `agent_access_not_configured` requires investigation before
continuing. Record the deployed commit and these readbacks in each actual-client
result.

Use existing site login and Admin consent, closed staff-test collections and
fictional product documentation. Collections, navigation, roles and grants remain
unchanged. The learning-review flag stays false;
customer AI, automatic publication, engineering processing/export and other
provider capabilities remain unchanged and off. All five cron expressions and
their lanes are retained exactly.

The first tests use these operator-selected registrations. Each test verifies
them against the installed client.

| Public client ID | First intended flow | Registered callback |
| --- | --- | --- |
| `pg-kb-codex-accept-v1` | Codex CLI, authorization code with PKCE | `http://127.0.0.1/callback`; Agent Access `0.1.1` permits only the IP-loopback port substitution |
| `pg-kb-claude-accept-v1` | Claude Code, authorization code with PKCE | `http://localhost:48772/callback`; configure the client to use that exact port |
| `pg-kb-device-accept-v1` | Separate RFC 8628 host control | No redirect URI; device-code grant only |
| `pg-kb-grok-accept-v1` | Hosted Grok Bot, authorization code with PKCE | `https://www.cursor.com/agents/mcp/oauth/callback`; exact HTTPS callback |

Port `48772` was available on both IPv4 and IPv6 loopback during the local
2026-11-11 availability check, which closed both listeners immediately. Recheck
availability when starting the client. Record the actual callback, installed
version and provider mode during each test. Require the
registered hostname and path, with only the declared IP-loopback port
substitution. The RFC 8628 host control has its own result, separate from native
CLI proof. Codex CLI, Claude Code and hosted Grok Bot acceptance remain pending.
The Grok registration uses the HTTPS callback observed from the hosted client.
T3 Code registration and acceptance remain pending.

Each registration permits only `knowledge.article.draft.read`,
`knowledge.article.draft.write` and `knowledge.article.evidence.submit`.
Admin-only linking and the existing browser, collection-audience, human review
and exact-publication boundaries remain authoritative. Admin roles and
publication, review, collection/governance and private-provenance authority
remain outside the delegated scope.

For rollback, revoke known test grants through their existing owner controls
while available, then restore `PEGMA_KNOWLEDGE_ENABLED=false` and
`PEGMA_AGENT_CLIENTS_JSON=[]` through the same configuration/deployment path.
The false flag rejects requests before constructing Identity or opening D1.
Changing the flag leaves stored grant families unchanged. Scheduled storage
maintenance continues independently of this switch.

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

The main Worker pins [Wrangler `4.128.0`](https://github.com/cloudflare/workers-sdk/releases/tag/wrangler%404.128.0)
and sets root `observability.redact_query_string:true`. Cloudflare's
[Worker settings API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/edit/)
documents removal of request-URL query strings from logs and traces. The main
configuration enables logs and leaves traces disabled, so this is the platform's
documented scope rather than a trace-redaction acceptance result. The normal
check dry-runs the main config with direct Wrangler `4.128.0`, and the Node
config regression requires its normalized root redaction flag to be `true`.
The [Worker toolchain notes](../worker/README.md#toolchain-compatibility)
record the current generated runtime, retained older test-pool parser, optional
workers-types mismatch and upstream Miniflare pairing.

On 2026-11-11, after the redaction change in
[PR #63](https://github.com/pegma-dev/pegma.dev/pull/63) was deployed, three
fictional GET requests produced positive retained log rows whose observed
invocation URLs omitted their query strings and synthetic query values.
The deployed proof covers request-URL logging. Arbitrary application messages,
exception strings and Live Tail output remain unqualified, and traces remain
disabled. Keep application diagnostics content-free. Source parsing, tests and
dry runs provide local validation.

Test collections stay closed and global navigation and Account links remain
unchanged. Broader discoverability, rollout, CPU/load qualification and
supervised pilot results remain pending. Actual
existing-login/Admin consent, device/PKCE flows, scoped API/MCP operations,
revocation, and failure cases must be observed through the requested clients.
Source and full D1 tests do not establish any of the four actual client
acceptances, provider/staging controls, production readiness, or pilot results.

## Current roles and browser boundaries

The [host policy](../worker/src/support-access.ts) keeps authority explicit:

- `Support` retains its original six Support Desk permissions (queue read,
  staff reply, notes, assignment, management and Audit read) and adds explicit
  human takeover plus explicit learning read, evidence submission, review and
  withdrawal introduced by policy `pegma.dev-policy-5`. Current policy
  `pegma.dev-policy-7` retains them and adds human engineering read, evidence
  submission, review, withdrawal and repository-policy read, plus named human
  release-follow-up read, review and evidence submission. Learning processing
  is not granted. Existing assignments are not migrated or silently granted KB
  powers.
- `Knowledge` is a separately assigned role for collection reads, draft and
  evidence work, human report review, publication and withdrawal. Admin-only
  collection/governance mutation controls remain separate.
- `Admin` keeps role administration, full intended KB administration and the
  exclusive permission to link agents. An Admin explicitly assigns/revokes
  `Knowledge` through the existing audited role surface.

Authenticated accounts receive the named article-read permission; collection
audience policy and the released KB's current publication checks still decide
which guides they can read. Role names do not bypass those checks.
Portal article, search and collection results are withheld if the session or
principal changes, or any captured permission is lost during the read. Added
grants do not invalidate an otherwise authorized result.

`/account/agents/device` accepts a human-entered/confirmed code of at most 128
characters. `/account/agents/authorize` displays the exact request and requires
an explicit decision. Existing login resumes only allowlisted same-origin
agent paths; it never auto-approves. Consent pages/data are no-store and
no-referrer. Untrusted text is rendered as text, using external CSP-compatible
scripts; tokens are not placed in URLs or browser storage.

Consent POSTs reauthenticate after validating the complete request body and
immediately before approval. The fresh context must match the original session,
principal and credential headers. A final check also withholds stale responses
after the service returns; it does not roll back an approval already committed.

Host-owned JSON POST bodies for portal reads, staff commands, agent test
reports and consent approvals have a ten-second total read deadline, in
addition to the byte limit. Empty-body grant revocations share that deadline:
nonempty input is rejected, and zero-byte chunks periodically yield to let
the deadline and cancellation run. Trickle input does not restart the deadline.
An expired body read returns `408 request_timeout`, cancels the reader and
starts no KB/grant read or consent/report/revocation command. This bounds body
reading; authentication, storage work and SDK-owned protocol parsing keep their
own boundaries.

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

Browser and agent draft inputs cannot attach arbitrary `sourceReferences`;
PG-01 authoring provenance remains read-only through those routes. The optional
[Support learning composition](SUPPORT_COMPOSITION.md#optional-resolution-learning)
now supplies a real SDK source bridge for trusted host assembly. That bridge
checks current source authority, eligibility and the exact staff-reviewed
article/provenance target; it is separate from test-report receipt verification.
A report receipt alone never establishes private-source approval. Support review
uses a complete immutable intent for submit, receipt and explicit cancellation.
Its new-mutation guard checks fresh learning review/queue plus KB draftRead and
provenanceRead before and after the SDK proof, with an additional original-browser
fence in HTTP. Exact accepted-receipt recovery and cancellation retain current
review/queue authority without requiring obsolete KB rights; neither operation
publishes an article or supplies new source approval. The root
request composition supplies no private-source verifier. Ordinary authoring is
enabled by the configured profile; workflows requiring private source references
remain unavailable without that verifier. Source-enabled production wiring
requires that verifier.

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

### Limiter window cleanup and the shared cron

The [scheduler](../worker/src/index.ts) configures five cron entries.
`RATE_LIMIT_CRON` is the all-minute `*/1 * * * *` trigger, including UTC minutes
58 and 59. When answering processing is enabled, this physical invocation
belongs exclusively to one bounded answering preparation or paid stage.
Background cleanup uses its separate `0-58 * * * *` trigger and rotates through
20 exclusive lanes, including the global limiter and retrieval-ready tasks.
Each background task runs once per 20 eligible ticks, nominally 20-21 minutes.
Retained history and contention can consume answering opportunities. The SDK's
300-second turn deadline and its expiry/human-handoff rules remain authoritative.

With answering OFF, cleanup uses its 18-lane rotation, nominally 18-19 minutes.
The all-minute rate trigger performs background work only at minutes 0 through
57. Those 58 eligible minutes allocate two isolated rate invocations followed by
one ready-hint invocation:

- UTC minutes with remainder 0 or 1 when divided by three run one
  [global limiter cleanup](../worker/src/knowledge-maintenance.ts) page of at
  most 20 physical rows: 39 pages per hour. This runs independently of the
  Knowledge flag and optional agent registrations.
- Minutes with remainder 2 run one
  [ready-hint page](../worker/src/knowledge-retrieval-ready.ts) when Knowledge
  is enabled: 19 pages per hour. They do not also run limiter cleanup or
  physical KB recovery. An empty ready queue does not trigger another heavy
  task. This reduces the previous 29 ready opportunities to 19; ready hints
  remain a latency aid, with atomic SDK jobs and physical recovery preserved.

The OFF cleanup rotation covers the original 15 lanes, the separately gated
learning-review discovery lane and two engineering limiter lanes. The learning
lane emits queue hints for a later Queue invocation. The default root keeps
the review flag off. The OFF rate callback performs no Store work at minutes
58 and 59. Mail send, mail reconciliation and release-reconciliation cadences
retain their separate invocations. Before
merging, inventory every Worker's current cron triggers in the deployment
account: pushes to `main` deploy these schedules regardless of the Knowledge
flag. Deployment replaces this Worker's existing expressions with these
five. The [Workers Free allowance is five triggers per account](https://developers.cloudflare.com/workers/platform/limits/#account-plan-limits),
so this configuration leaves no capacity for another Worker's triggers.
Require the account total after replacement to fit its effective allowance;
if it does not, hold the merge and revise the scheduling design. Repeat this
check before later deployments that change schedules. Retrieval shares the
fifth expression and does not register a sixth.

The limiter bookmark advances only after success, retaining the prior
continuation on failure. Follow no-deletion pages and repeat complete cycles;
pages are not snapshots. Descriptors, malformed/legacy `0.2.0` rows and
unknown layouts remain retained. This does not silently migrate old limiter
storage; existing Identity/Support maintenance remains in place.

The OFF-mode scheduled limiter ceiling is 780 physical rows per hour if all
39 pages succeed and fill. The enabled 20-lane cleanup rotation has lower
background throughput, so that figure describes the OFF cadence. Live windows,
descriptors, retained rows and cursor-cycle
overhead consume slots, so this is not a deletion or expiry guarantee. The
synthetic capacity regression creates 50 browser IP subjects plus one subject
in each of six Agent Access policy shapes per five-minute cohort: 672 counters
per hour for four continuing hours, then two hours without new arrivals.
The OFF-mode regression retains seven persistent descriptors, live windows and
the minute-58/59 background gaps in the actual Store. It checks backlog and oldest-expiry age at the same
workload phase after warmup, cursor-cycle progress and eventual drainage.
This finite workload is not a production benchmark, universal arrival-rate
bound or passed-gate claim in this guide.

Descriptor reads, conditional deletes and checkpoint work add storage
operations beyond the scan-row limit. Validate the complete scheduled handler
against the Free 50-call D1 budget. The real-D1 fixture counts actual binding
executions, including batches and checkpoints, and has a calibration that
throws before backend execution 51. That does not prove the Free 10 ms CPU
budget, daily row quotas or live capacity. Activation also requires measured
runtime budgets, full cursor-cycle progress and sustained deletion throughput
under actual load.

### Retrieval projection repair

Publication and indexing are separate durable work. After an accepted
`publishArticle`, `retireArticle` or `revokeEvidence`, the
[request hook](../worker/src/knowledge-runtime.ts) attempts one nonthrowing,
body-free ready-hint overwrite for that article. It no longer awaits inline
`repairArticleIndex`. The record contains only a hash key, article identity,
format and trusted request time in `pegma-dev.knowledge-retrieval-ready.v1`;
it contains no report, evidence or article body. Duplicate acknowledgements
can overwrite the same hint. Enqueue or diagnostic failures do not undo the
committed command. The existing final browser-authority check still runs and
can withhold its acknowledgement if authority changed.

The ready worker scans one physical hint and calls the actual SDK
`repairArticleIndex` with `maxBatches:1`. This bounds attempted derived
transactions, including contention, rather than allowing an unbounded retry
loop. It deletes only the exact scanned Store key/version after that call
returns `status:'ready'`; `indexed:false` is a converged withdrawal. Pending,
blocked and failed work retain their hints. A newer enqueue changes the opaque
Store version and wins over an older worker's conditional deletion.

The ready cursor rotates past a failed item so other hints can progress, then
revisits retained work on later cycles. It uses the separate
`pegma-dev-maintenance` key `{ partition:'knowledge', id:'retrieval-ready' }`.
The physical recovery worker retains `{ partition:'knowledge', id:'retrieval' }`.
Both checkpoints use a bounded opaque cursor and safe-integer monotonic
generation, with one OCC attempt and a generation increment even for
`null` to `null`. Scan/checkpoint failures preserve saved progress; delayed
completions cannot overwrite a newer generation. Already committed projection
writes are not rolled back after acknowledgement uncertainty.

The existing Knowledge turn in the
[mode-dependent cleanup rotation](../worker/src/maintenance-schedule.ts) independently
calls `repairRetrievalPage` with `limit:1` and `maxBatches:1`. Complete physical
cycles and the SDK's existing atomic article-change jobs remain the recovery
path for a lost hint, collection/policy changes and unfinished work. The ready
queue is a latency aid, not the authority or sole delivery guarantee.
Physical recovery still includes no-match pages and repeated cycles; a large
corpus or persistent failures can delay convergence. No indexing latency or
live SLA is claimed.

Both projection paths use the existing AuthCore-resolved, server-owned
principal with only `knowledge.index.manage`, without an Admin role or new
human/agent permission. Scheduled composition opens a separate Store with
`createSchemaIfMissing:false` and explicit `readBatchSize:512`, then constructs
the actual application from that Store and clock. It does not initialize
Identity, mail, sessions, reports or agent registrations. Projection work
checks the current `PEGMA_KNOWLEDGE_ENABLED=true` flag before Store access and
after awaits; disabled ticks do no projection work. Limiter cleanup remains
independent of that flag and projection failures.

The three host factories accept an optional real `privateSources` verifier.
Source-enabled assembly must pass the same current authorization/withdrawal
bridge to `createKnowledgeRuntime`, `createKnowledgeRetrievalReady` and
`createKnowledgeRetrievalMaintenance`; request-only wiring cannot qualify
projection work. Omission blocks retained nonempty source references; there is
no allow-all fallback. The root request and scheduled compositions do not yet
supply that bridge. Retained nonempty private source references therefore remain
unavailable. Controlled ordinary product-guide authoring omits Support/private
source references. Source-enabled learning qualification remains pending. The real-Memory
[composition test](../worker/src/support-learning-composition.test.ts) exercises
accepted Support sources and current reopen/withdraw/missing-ticket refusals
through the actual factories, without bypassing KB evidence/publication gates.
Those tests do not qualify an activated source-enabled D1 path: source checks add
reads and require new whole-invocation query/parameter, CPU, quota and privacy
measurements. `readBatchSize:512` coalesces prepared reads; it does not cap SDK
work or prove the Free budget. HTTP handlers do not scan the corpus or expose
maintenance DTOs. Coarse diagnostics contain counts and fixed stages, not
article IDs, cursors, queries, private bodies or exception text.

Projection-dependent portal discovery/search stays empty or unavailable until
current repair qualifies it. Known-ID publication reads retain their existing
SDK authority checks. Retirement, evidence revocation and audience withdrawal
are filtered immediately, before a worker removes stale hints; an index entry
cannot grant access, restore approval or serve as customer confirmation of an
unqualified publication.

Earlier local candidate measurements of the awaited inline path reached 118
D1 calls for publication and 104 for evidence revocation, above the 50-call
limit despite successful logical responses. The real-D1
profiling fixture passed at the PG-01 checkpoint on the canonical published
graph. It exercises whole HTTP/MCP and scheduled
invocations, including genuine 32-proof/96-revocation history, pending work,
transport failure, newer enqueue races and lost-hint recovery, with a hard
50-call guard on the bounded Free-plan cases. This local result does not
establish deployed CPU limits, daily quotas or sustained production throughput.
Preserve all authority and history checks. The controlled staff profile permits
closed test-collection authoring. Live-platform CPU, quota and load qualification,
source-enabled workflows and broader rollout remain pending.

Disable Knowledge if its acceptance fails. Identity and role administration
remain independent. Support Desk's human-control adoption is documented separately in
[Support composition](SUPPORT_COMPOSITION.md); the public catalog retains its
own composition. No model/provider, automatic publication, GitHub export or
customer notification is enabled by these changes. Production settings, installed-client results,
staging/privacy controls and supervised pilots remain host-owned proof.
