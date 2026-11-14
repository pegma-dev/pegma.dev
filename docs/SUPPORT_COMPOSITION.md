# Support Desk composition (pegma.dev)

Public host composition notes for authenticated product feedback on
[pegma.dev](https://pegma.dev). This is the ecosystem's Cloudflare reference
environment for Support Desk customer create / list / read / reply and a small
staff operator surface over the same application services, including human
requests, takeover and private handoff context. Ordinary human HTTP handlers keep
assistant handling disabled; the optional production composition uses a separate
explicitly admitted browser route and defaults to OFF.

The separate synthetic stage source defines its own Worker, Queue and D1
binding with a scripted local model. It starts disabled and has no production
HTTP or cron registration. Actual broker and CPU qualification remain pending;
provider and customer activation retain their acceptance gates. See the
[isolated assistant stage guide](SUPPORT_ASSISTANT_STAGE.md).

## Packages

Public selection as of 2026-11-13: Support Desk `0.2.11`, Knowledge Base `0.1.8`
and Sessions `0.3.0`. [`package.json`](../package.json) and
[`pnpm-lock.yaml`](../pnpm-lock.yaml) are the source of truth for current direct
selections and the installed graph.

- `@pegma/support-desk-application@0.2.11`
- `@pegma/support-desk-contracts@0.2.11`
- `@pegma/support-desk-core@0.2.11`
- `@pegma/support-desk-templates@0.2.11`
- `@pegma/support-desk-ai@0.2.11` (optional coordinator)
- `@pegma/authorization-admin@0.4.0` (role administration service)
- `@pegma/authorization-core@0.4.0` (AccessContext resolution)
- `@pegma/authorization-policy@0.4.0` (PolicyDocumentV1 schema validation)
- `@pegma/authorization-storage@0.4.0` (D1-backed role store)

All five Support Desk packages have completed producer publication and
registry qualification. The optional AI package selects exact KB application
and contracts `0.1.8`; the host selects all four KB packages at that version.
Producer qualification and installation do not complete host or provider
acceptance. [Public Support Desk release](https://github.com/pegma-dev/support-desk/releases/tag/v0.2.11),
[public KB release](https://github.com/pegma-dev/knowledge-base/releases/tag/v0.1.8).
The [checker wire upgrade](SUPPORT_CHECKER_UPGRADE.md) describes fresh route and
tokenizer qualification, complete-message admission and the separate Free CPU
acceptance gate.
The earlier [Support `0.2.7`](https://github.com/pegma-dev/support-desk/releases/tag/v0.2.7)
and [KB `0.1.6`](https://github.com/pegma-dev/knowledge-base/releases/tag/v0.1.6)
producer checkpoints remain historical; they do not qualify the current host.

Peers already present on the host: `@pegma/storage-core@0.4.0`,
`@pegma/storage-cloudflare-d1@0.4.7`, `@pegma/sessions@0.3.0`,
`@pegma/rate-limit@0.2.0`, `@pegma/identity@0.1.2` and `@pegma/spine`
(declared range and resolution are recorded in the manifest and lockfile).
These are direct host selections; the lockfile retains each released package's
own dependencies, including Support Desk's Spine `0.1.2`. No override or forced
deduplication replaces that graph.

The earlier [qualified Support 0.2.2 release](https://github.com/pegma-dev/support-desk/releases/tag/v0.2.2)
uses signed source
[`99cf4e67da1d2357d99fd80389a96318a6e2cc93`](https://github.com/pegma-dev/support-desk/commit/99cf4e67da1d2357d99fd80389a96318a6e2cc93).
[Strict release verification](https://github.com/pegma-dev/support-desk/actions/runs/42907283767/job/130161276758)
qualifies those historical producer packages. The earlier public `0.2.5` graph
passed the [normal local and CI validation checkpoint](KNOWLEDGE_COMPOSITION.md#public-025-adoption-checkpoint).
That checkpoint does not qualify the current public graph above. Current host
validation, review and deployment acceptance remain pending. The earlier
[Sessions `0.2.1` checkpoint](https://github.com/pegma-dev/sessions/releases/tag/v0.2.1)
included the verified producer fix for the earlier `0.2.0` default-clock
concurrency defect under a consistent advancing clock.

## Storage namespace

Support Desk uses the existing `IDENTITY_DB` D1 binding. Isolation is by
collection name, not by sharing Identity mail cursors or session rows:

| Concern                            | Collection / host key                   |
| ---------------------------------- | --------------------------------------- |
| Tickets, messages, audit, commands | `support-desk.records.v1`               |
| Customer ticket index              | `support-desk.customer-ticket-index.v1` |
| Ticket numbers                     | `support-desk.ticket-numbers.v1`        |
| Queue projection                   | `support-desk.queue-index.v1`           |
| Host maintenance cursors           | `pegma-dev-support-maintenance`         |
| Role holder index (by-role guard)  | `role-holder-index.v1`                  |

Identity keeps its own collections and `pegma-dev-maintenance` cursors. The
two never share a cursor key.

## Authorization

### Customer

Any authenticated pegma.dev account receives customer permissions through the
unified host policy's `defaults` (no paid entitlement):

- `support.ticket.create`
- `support.ticket.read.own`
- `support.ticket.reply.own`
- `support.ticket.request_person.own`
- `support.ticket.confirm_success.own`

The current [stored-role policy](../worker/src/support-access.ts) is
`pegma.dev-policy-8` — one `PolicyDocumentV1` for the whole host,
schema-validated in tests (see `docs/ROLE_ADOPTION_PLAN.md`). Version 8 adds
authenticated owner success confirmation; version 7 introduced the three human
release-follow-up rights. These are authority revisions; the schema remains v1.

### Staff (stored `Support` role)

Staff access is granted by a stored, audited `Support` role assignment in the
D1-backed role store (`@pegma/authorization-storage`, application id
`pegma.dev`, application scope). The gate re-reads active assignments on every
request, so a revocation is effective on the caller's next request. Non-staff
callers of staff routes receive **403** `forbidden` (not 404).
Unauthenticated callers receive **401**.

The `Support` role maps to:

- `support.queue.read`
- `support.ticket.reply.any`
- `support.ticket.note`
- `support.ticket.assign`
- `support.ticket.manage`
- `support.audit.read`
- `support.ticket.take_over`
- `support.learning.read`
- `support.learning.evidence.submit`
- `support.learning.review`
- `support.learning.withdraw`
- `support.engineering.read`
- `support.engineering.evidence.submit`
- `support.engineering.review`
- `support.engineering.withdraw`
- `support.engineering.policy.read`
- `support.engineering.followup.read`
- `support.engineering.followup.review`
- `support.engineering.followup.evidence.submit`

`Admin` and `Knowledge` alone do not grant Support queue authority. Taking over
changes handling authority; the existing assignment action remains separate.

**Bootstrap (one-time seeding).** `PEGMA_SUPPORT_BOOTSTRAP_PRINCIPALS`
(comma-separated Identity principal ids) seeds a real audited `Support`
assignment (actor `system:bootstrap`, deterministic assignment id
`bootstrap-support-<principalId>`) on a listed principal's next authenticated
support request. Each principal is seeded at most once, ever: ANY `Support`
assignment record — active or revoked, whatever its provenance — counts as
already seeded, read first-class via `listRoleAssignments`
(authorization-storage 0.3.0; this check previously needed the host
`support-bootstrap.markers.v1` marker collection, deleted with the upgrade).
A deliberate revocation therefore stays revoked while the env var lingers.
Delete the var once the first operator holds the role.

**Fail-closed posture.** The role store is the only gate: a host wired
without one answers staff routes with **503** `support_not_configured`, and a
role-store failure is **503** `service_unavailable` — never a quiet allow or
a misleading 403. The former `SUPPORT_STAFF_EMAILS` /
`SUPPORT_STAFF_PRINCIPALS` allowlist was deleted whole in Phase 4 of
`docs/ROLE_ADOPTION_PLAN.md`.

`principalId` is always the Identity principal / account id from the
server-side session (`__Host-pegma_session`). Browser-supplied identity fields
are ignored.

## Categories and markers

Allowlist: `feedback`, `bug`, `feature_request`, `documentation`, `question`.

Display marker: `[PEG-{number}]`. Public tracking URL:

`https://pegma.dev/feedback/ticket/?id={ticketId}`

## HTTP boundary

Worker routes (same-origin session + CSRF `X-Pegma-CSRF` for mutations):

### Customer

| Method | Path                                      | Notes                                     |
| ------ | ----------------------------------------- | ----------------------------------------- |
| `GET`  | `/api/support/categories`                 | Auth required                             |
| `GET`  | `/api/support/tickets`                    | List own tickets                          |
| `POST` | `/api/support/tickets`                    | Create (rate-limited)                     |
| `GET`  | `/api/support/tickets/:id`                | Read own; missing/non-owned → same 404    |
| `POST` | `/api/support/tickets/:id/replies`        | Reply (rate-limited)                      |
| `POST` | `/api/support/tickets/:id/request-person` | Owned human request; body `{ commandId }` |
| `POST` | `/api/support/tickets/:id/confirm-success` | Owned success confirmation; body `{ commandId, lastSeenVisibleMessageId }` |

### Staff (`/api/support/admin/…`)

| Method  | Path                                       | Notes                                                                                                         |
| ------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `GET`   | `/api/support/admin/queue`                 | `listStaffQueue`; query: `status`, `priority`, `sort` (`updated_newest` / `updated_oldest`), `unassignedOnly` |
| `GET`   | `/api/support/admin/tickets/:id`           | `readStaffTicket` (includes requester email when present, internal notes)                                     |
| `POST`  | `/api/support/admin/tickets/:id/messages`  | Public staff reply → `replyAsStaff` body `{ body }` (rate-limited)                                            |
| `POST`  | `/api/support/admin/tickets/:id/notes`     | Internal note → `addNote` body `{ body }` (rate-limited)                                                      |
| `PATCH` | `/api/support/admin/tickets/:id`           | Lifecycle / assign / priority                                                                                 |
| `POST`  | `/api/support/admin/tickets/:id/take-over` | Body `{ commandId, expectedRevision, expectedHandlingGeneration }`                                            |
| `GET`   | `/api/support/admin/tickets/:id/handoff`   | Private handoff work for current Support only                                                                 |

`PATCH` body (strict keys):

```json
{
  "action": "assign" | "unassign" | "change_priority" | "resolve" | "close" | "reopen",
  "priority": "low" | "normal" | "high" | "urgent"
}
```

- `assign` assigns the caller's principal; `unassign` clears assignee.
- `change_priority` requires a valid `priority`.
- resolve / close / reopen map to the corresponding application methods.
- Command, correlation, and message IDs for these legacy actions are server-minted.

### Human controls

The human-control routes require the original same-origin browser
session; bearer `Authorization` is rejected. Mutations use the current
`csrfToken` from the account/ticket response in `X-Pegma-CSRF`. The server
rechecks current Identity, stored Support authority where required, original
session metadata and absolute expiry after awaited work before releasing a
result. Local-agent credentials cannot take over or read private handoff work.
Ticket pages use the lightweight `/api/identity/session` subject/CSRF probe,
which does not list passkeys. Each browser HTTP request, including response
body consumption, has a fifteen-second total deadline. Reload invalidates old
callbacks while retaining an unresolved human-command packet. A confirmed
command followed by a failed refresh is reported separately from an unknown
acknowledgement.

Human-control POST packets are closed objects with a client UUID `commandId`.
Takeover includes both SDK concurrency fences. Bodies use the existing
64 KiB JSON limit with a ten-second total deadline. An unknown
acknowledgement is retried with the exact packet; a conflict requires a fresh
view and a new intent. A final authority rejection can withhold an
acknowledgement after a real commit; it does not undo the command.

Customer responses expose only the SDK's safe handling-state string and
public messages. Staff detail uses effective `{ state, generation }`, including
generation zero for legacy tickets, without writing a migration on reads.
Private handoff context is fetched separately for Support, rendered as text and
cleared on stale, denied or changed-ticket views. Unsent compose text is kept.
Takeover does not reopen resolved/closed tickets; the explicit lifecycle action
does. A customer's human request follows the released SDK's reopening behavior.

Request-person and takeover share the reply limiter, including exact retries.
Idempotency prevents duplicate effects, not quota debits; honor `Retry-After`
before retrying the same packet. Human-only operation remains available with
Knowledge and AI disabled. Source and synthetic SDK/DOM/D1 checks do not close
actual-login, client, privacy, live-platform or supervised-pilot acceptance.

**Compose modes are distinct endpoints.** Public replies use `/messages`;
internal notes use `/notes`. The staff UI requires an explicit mode selection
with no default and styles the two modes differently. Mail / outbound
notification is still deferred (Task 10) — staff reply omits `notification`
like customer create/reply.

### Role administration (`/api/admin/…`)

Gated on the stored `Admin` role (`@pegma/authorization-admin`); the host
checks permissions before calling the service, which never re-checks its own
callers.

| Method   | Path                                | Notes                                                                     |
| -------- | ----------------------------------- | ------------------------------------------------------------------------- |
| `GET`    | `/api/admin/state`                  | `bootstrapArmed` + CSRF token                                             |
| `POST`   | `/api/admin/lookup`                 | One search box: body `{ query }`, resolves an email **or** a principal id |
| `GET`    | `/api/admin/principals/:id`         | Principal + active roles with `managedBy`                                 |
| `GET`    | `/api/admin/principals/:id/history` | Audited lifecycle timeline                                                |
| `POST`   | `/api/admin/principals/:id/roles`   | Assign `Support`, `Knowledge` or `Admin`                                  |
| `DELETE` | `/api/admin/assignments/:id`        | Revoke; last-administrator guard                                          |

**One search box, decided server-side.** `classifyLookup` treats a `@`
anywhere in the query as an email and everything else as a principal id:
Identity's one normalization function requires exactly one `@` in every
address, and principal ids never contain one. Email lookups call the
published `Identity.findUserByEmail`; the host passes the trimmed value
through **without normalizing it**, because exactly one normalization
function exists and it lives in Identity (test-pinned).

**Why the lookup is a POST.** The query can be a real person's email
address, so it stays out of URLs, referrers, and access logs; the same
choice puts CSRF and same-origin in front of the one endpoint that can
confirm an address exists. Identity's public enumeration resistance is
untouched — this path is reachable only by an authenticated `Admin` holder,
and it is rate-limited so a stolen admin session cannot harvest the
directory.

Durable rate-limit policies (separate from Identity):

- `pegma.support.ticket.create`
- `pegma.support.ticket.reply` (customer replies, staff message/note posts,
  request-person and takeover, including retries)
- `pegma.admin.role.mutate` (assign / revoke, 30/h per operator)
- `pegma.admin.principal.lookup` (directory lookups, 120/h per operator)
- `pegma.support.engineering.read` (engineering reads, 120/h per operator)
- `pegma.support.engineering.mutate` (engineering mutations, 30/h per operator)

All six are swept by the same rotating cleanup schedule, one policy per
invocation.

## Site pages

| URL                           | Audience                                 |
| ----------------------------- | ---------------------------------------- |
| `/feedback`                   | Customer create + list                   |
| `/feedback/ticket/?id=…`      | Customer read + reply                    |
| `/staff/support`              | Staff queue (Support role holders)       |
| `/staff/support/ticket/?id=…` | Staff ticket detail, compose, lifecycle  |
| `/staff/roles`                | Role administration (Admin role holders) |

## Optional resolution learning

The current source uses the [public package graph above](#packages), including
the optional AI coordinator's exact direct KB dependencies. The public
forwarding port preserves KB error instances;
no KB `0.1.2` alias, translation shim, second Store, override or private SDK
import supplies this assembly. The earlier Support `0.2.1` / nested KB `0.1.2`
compatibility assembly and its failed isolated production-layout diagnostic are
historical, not current graph or host-acceptance evidence.

The staged learning review admission and Queue worker retained in this branch
use the published Support Desk APIs in that graph. The earlier
`0.2.5` host validation checkpoint remains historical. Current host validation,
review and deployment acceptance remain pending. Runtime availability and
feature activation retain their existing trusted composition and readiness
controls.

[Learning intake and processing](../worker/src/support-learning.ts) are separate,
default-disabled SDK boundaries. A real source verifier, current service/staff
authority, product context, independently verified checks, target mapping,
configuration/data controls, local counter, usage accounting and model port are
required where the corresponding SDK operation needs them. Missing, expired
or throwing readiness holds work; no model, route, source approval or check
receipt is synthesized. Enrollment alone produces an unverified generation-zero
source. Staff-verified resolution evidence establishes eligibility; generation
and staff approval of the exact checked KB target remain separate. Neither
approval nor delivery publishes a guide: ordinary KB evidence, review and
publication gates still apply.

Policy `pegma.dev-policy-5` introduced four explicit learning permissions to
`Support`. The [current host policy](../worker/src/support-access.ts) retains
those grants alongside human engineering and release-follow-up permissions;
authenticated owner success confirmation is a separate customer default.
Learning processing and KB staff access remain
separate. Private proposal reads and new review commits also require separately
current KB `draftRead` and
`provenanceRead`, normally through `Knowledge` or `Admin`. Browser submissions
and trusted direct SDK reviews enforce fresh KB and learning review/queue
permissions before and after the actual SDK proof. HTTP requires the complete
intent and adds its original-browser fence.
Accepted receipt recovery and explicit cancellation retain current review/queue
and browser authority without requiring obsolete KB proof. Customer ticket
responses, agent scopes and the public KB DTOs gain no source, private evidence or learning-work fields.

The [optional HTTP adapter](../worker/src/support-learning-handlers.ts) uses the
existing cookie/session, Origin, CSRF and durable admission ports. It preserves
the original credential and permission ceiling around awaited work, rechecks
current stored roles, bounds staff operations and withholds stale replies,
including after a committed mutation. Client command bytes are retained;
ambiguous acknowledgements require the exact original actor/operation/ticket
packet. The proposal route now returns a complete immutable SDK review intent;
submit, receipt lookup and cancellation use the same full packet and identity.
A lost cancellation ACK keeps retries on cancellation, rather than resending
approval. Arbitrary GET success or a null receipt cannot settle an unknown
mutation. Private source and proposal content is rendered as text and cleared on
denial or owner change; retained recovery controls remain available only under
their current server capability and real review/queue authority. See
[the exact HTTP and recovery contract](SUPPORT_LEARNING.md).

The default [root Support composition](../worker/src/index.ts) supplies no
trusted learning bundle. The optional server composition requires that bundle,
its explicit readiness callback, the review queue binding and
`PEGMA_SUPPORT_LEARNING_REVIEWS_ENABLED` set exactly to `"true"`; the checked-in
flag remains `"false"`. Without that composition, learning routes remain 404 and
no review phase runs. The exclusive learning cleanup lane discovers durable SDK
work and emits opaque queue hints; a separate Queue delivery advances at most
one SDK phase. Hints and delivery retries grant no review authority. Actual
product/check/target/configuration/usage ports and trusted admission remain
activation work; no model, provider or client is activated by this source.

Source eligibility must also reach every KB application that reads or repairs a
learned publication: pass the same live bridge as `privateSources` to
`createKnowledgeRuntime`, `createKnowledgeRetrievalReady` and
`createKnowledgeRetrievalMaintenance`. Their default omission refuses nonempty
private-source provenance. Reopening, withdrawal or a missing source invalidates
read eligibility immediately; indexing cannot restore it. The real-Memory
[composition regression](../worker/src/support-learning-composition.test.ts)
uses SDK-created sources, actual staff decisions, report-backed evidence and
publication through these host factories. It is not deployed-provider, privacy,
Native D1 query-budget, Free CPU, daily-quota or pilot qualification. Knowledge
request/maintenance batching and activation limits remain documented in
[Knowledge composition](KNOWLEDGE_COMPOSITION.md).

## Staged assistant retrieval is separate

AI `0.2.2` introduced explicit `stagedRetrieval:true`, retained by the current
public graph above; omission remains monolithic. The preparation attempt retrieves authorized sources and records a
bounded no-call request without reserving paid usage. Only its durably
acknowledged finish returns `prepared`. The host must return and schedule a
genuinely later physical invocation at or after `nextAttemptAt`, never loop or
use `waitUntil` to perform generation in the same invocation. Paid generation
uses attempt two, so application and assistant budget limits must both permit
at least two attempts. Unknown preparation/finish remains `pending` and does not
authorize a provider call. `AssistantProcessResult` includes `prepared` even for
an opted-out runtime, so exhaustive consumers must handle it. Fresh source,
customer, full configuration and usage-scope checks remain required across
phases. Configuration timestamps and opaque `usageScopeRef` must remain exact;
reattestation or scope reissuance invalidates preparation rather than being
normalized away. This learning composition does not register an answering worker, and producer publication proves no host Free/CPU,
provider or activation result.

## Maintenance and health

The separate cleanup cron (`0-58 * * * *`) runs one rotating task per
invocation. With answering OFF, its 18 lanes cover Support queue repair,
inactive projection sweep, each Support/Admin/engineering rate policy,
Identity and Knowledge maintenance, and separately gated learning-review
work. Each runs once per 18 eligible ticks (nominally 18-19 minutes because
minute 59 is omitted). Unchanged bookmarks do not cause writes.

The distinct all-minute trigger (`*/1 * * * *`) belongs exclusively to
answering while processing is enabled. One physical invocation performs at
most one preparation or paid stage, under the same 25-second bound including
qualification; it never runs another maintenance job on that D1 allowance.
This gives two simultaneous admitted turns four minute-spaced stages within
the SDK's 300-second window, including across UTC midnight. The real Worker
[composition tests](../worker/src/support-assistant-root-composition.test.ts)
exercise this chronology with genuine Memory services and fictional provider
responses. The [Native tests](../worker/src/support-assistant-production.d1.test.ts)
separately meter every physical invocation at 50 D1 calls and 100 parameters.
These local proofs do not establish deployed CPU or provider acceptance.

While answering is enabled, its former global rate-window cleanup and
retrieval-readiness jobs each become one of 20 exhaustive cleanup lanes.
Their background throughput changes from roughly 90 seconds/3 minutes to
20-21 minutes; all other cleanup work remains in the rotation. Request-time
expiry and source/role proofs remain authoritative. With answering OFF, the
all-minute trigger retains the original 39 rate and 19 readiness pages per
hour and performs no Store work at minutes 58/59.

Identity Mail send and reconciliation keep their separate invocations
(`* * * * *` and `1-59 * * * *`), and release reconciliation retains its
six-hour window. The configuration still has five cron entries. Local parser and Native
validation cover the changed source separately;
Cloudflare backend acceptance of the distinct all-minute expression and
deployment remain operational checks.
Mail send for support
notifications is deferred (templates are defined; create/reply/staff reply omit
notification for this host surface).

Health always reports Support Desk package detail without message content. A
store probe runs only when `SUPPORT_HEALTH_PROBE` is exactly `"true"`.

## Privacy and retention intent

- Tickets are private conversations between the authenticated requester and
  authorized operators.
- Feedback is not automatically published to the roadmap, documentation, or
  GitHub Issues.
- The staff surface is only for operators holding the stored Support role.
  It is not a shared control plane with other hosts.
- Staff ticket views may include requester email after staff authz; customer
  endpoints never gain staff fields.
- Internal notes must never appear on customer reads.
- Queue projection terminal retention follows Support Desk's default
  (30 days) for inactive projection rows; authoritative ticket retention and
  export/redaction procedures remain host operational policy and will be
  documented further before accepting production-sensitive data at scale.

Built in the open by RetireGolden, LLC.

## Optional engineering human composition

The [engineering assembly](SUPPORT_ENGINEERING.md) introduced its grants in policy
version 6. Version 7 added the separate
[release-follow-up controls](SUPPORT_RELEASE_FOLLOWUP.md). Current policy
version 8 retains both sets of grants and adds owner success confirmation.
Support receives the five named human engineering permissions. Admin adds
repository-policy read and manage permissions. Policy operations require
current Admin and Support queue authority together.

The Worker accepts a trusted optional engineering composition. Its current
enabled callback and dependency bundle gate the router and staff-detail hints.
Human review has an additional strict current flag. The default Worker passes
no engineering configuration, leaving intake, review and processing OFF.

The optional [GitHub repository adapter](../worker/src/support-engineering-repository.ts)
supplies Application `repositoryMetadata`, the AI `github` ports and Application
`dispatchResults`. Its immutable allowlist identifies each repository, GitHub
App and installation. A trusted host issuer must supply current, expiring
App-JWT and installation-token authority. No issuer or live repository is
configured by default. Each operation starts with read-only
[installation discovery](https://docs.github.com/en/rest/apps/apps#get-a-repository-installation-for-the-authenticated-app)
and [repository metadata](https://docs.github.com/en/rest/repos/repos#get-a-repository).
Public visibility alone does not prove installation membership. Exact repository
identity, visibility, installation and current host authority must agree.

The existing runtime accepts `adapter.github` through its `ports` option; pass
`adapter.repositoryMetadata` and `adapter.dispatchResults` to the existing
Application engineering options. Creation also requires a separate current
`issueCreationEnabled` callback, false when omitted. After the SDK durably starts
dispatch, creation [mints an installation token](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
with the exact numeric repository ID and only metadata-read and issues-write
permissions. The bounded response must identify that single repository, selected
scope, exact permissions and a live expiry. Fresh trusted authority is checked
after minting. That ephemeral token supplies the exact SDK-approved title, body
and labels in one [issue POST](https://docs.github.com/en/rest/issues/issues#create-an-issue).
Credential minting and issue creation share the same operation deadline. The
issue payload contains the approved fields and marker. An uncertain write stays
with read-only reconciliation. Linking an existing issue records the private
Support association.

[Duplicate search](https://docs.github.com/en/rest/search/search#search-issues-and-pull-requests)
uses trusted ordinary search terms scoped to the configured repository and
issues, returning at most five candidates from one page. This bounded window
is not an exhaustive duplicate guarantee. Reconciliation requires a unique
exact SDK marker, direct issue readback and the expected GitHub App creator;
link reconciliation instead checks the exact existing issue ID and number.
Missing, incomplete, ambiguous or unavailable evidence stays unknown. The
Application verifier independently rereads that evidence and binds its result
to the SDK's retained dispatch identity. The marker does not attest the private
request hash. Reconciliation remains read-only after creation is disabled or
the local proposal body is withdrawn.

One total deadline bounds authentication and all requests to ten seconds or the
earlier caller deadline or credential expiry. An operation makes at most six
GitHub requests, with at most 64 KiB per response, a 24 KiB issue payload, no
pagination, retries or cached observations. The [metadata composition tests](../worker/src/support-engineering-repository.test.ts)
and [issue transport tests](../worker/src/support-engineering-github.test.ts)
use actual SDK policy, approval, dispatch and reconciliation over MemoryStore
with fictional external responses. This optional capability adds no processor,
scheduler or HTTP dispatch route, leaves the default Worker OFF, and does not
qualify a live installation or production export policy.

A configured staged-learning factory receives the same optional composition
as its third `create` argument. It composes `composeSupportEngineeringHuman`
into its existing `createSupportApi` call so current staff-detail hints and
its learning queue use their actual shared runtime. Engineering namespaces
also pass through the request-local root assembly before legacy routes.

Both engineering review entry points pass fresh host authority through the
public coordinator's `verifyBeforeCommit` option. The SDK returns its final
synchronous proof assertion to the Application commit boundary. Exact retained
review commands recover accepted receipts before mutable proof reads.
