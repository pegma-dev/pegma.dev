# Support engineering intake and repository policy

Developer and operator documentation for the optional engineering assembly.
The Worker and staff ticket controller accept the human engineering composition
through explicit trusted configuration. The default Worker supplies no such
configuration, so engineering intake and review remain OFF. This assembly uses
the [current public package graph](SUPPORT_COMPOSITION.md#packages), with exact
selections recorded in the manifest and lockfile.

The [runtime](../worker/src/support-engineering.ts),
[HTTP adapter](../worker/src/support-engineering-handlers.ts),
[router](../worker/src/support-engineering-router.ts) and
[panel](../public/staff-support-engineering.js) reuse the host's existing
Support application, Identity, sessions, stored roles and durable limiters.
The [human composition](../worker/src/support-engineering-composition.ts)
provides the request-local assembly. The existing learning queue and its
physical phase boundaries continue through the same Worker entry point.

The separate [release-follow-up controls](SUPPORT_RELEASE_FOLLOWUP.md) connect
trusted deployment evidence and explicit staff web updates. Their current
producer and host validation holds are documented in that guide.

## Authority and defaults

The [stored-role policy](../worker/src/support-access.ts) retains these five
human engineering permissions. See the [current policy and full permission
sets](SUPPORT_COMPOSITION.md#authorization) for its authority revision, customer
defaults and separate human release-follow-up grants:

| Published `supportPermissions` member | Current human surface |
| --- | --- |
| `engineeringRead` | Source and bounded work metadata |
| `engineeringEvidenceSubmit` | Explicit enrollment and staff-verified failure evidence |
| `engineeringReview` | Repository selection and exact proposal approval or rejection |
| `engineeringWithdraw` | Withdrawal and evidence/product/check-policy invalidation |
| `engineeringPolicyRead` | Current repository policy metadata |

All HTTP operations also require current Support queue-read authority. Admin
adds `engineeringPolicyRead` and `engineeringPolicyManage`; it does not imply
Support or queue-read. Policy HTTP operations require **Admin + Support**.
Neither role gains processing, reconciliation, restricted-source read, security
review or issue-dispatch authority from these additions. Knowledge and customer
permissions do not establish Support authority. Local-agent delegation remains
exactly KB draft-read, draft-write and evidence-submit; there is no new engineering
scope.

The router requires both a configured dependency bundle and a current strict
`true` callback. Missing, false or throwing flags return an owned 404 before any
legacy Support route; unknown engineering subpaths cannot fall through. Direct
adapter calls report disabled operation as 503. These are different boundaries,
not signals that a source is absent. See the
[router tests](../worker/src/support-engineering-router.test.ts).

Human intake and policy controls must remain independent of model-processing
readiness. The runtime's `processingEnabled` gate stops worker processing; it
must not be substituted for a configured human withdrawal or policy-disable
surface. Missing purpose ports remain unavailable. The existing
[Support factory](../worker/src/support-desk.ts) accepts optional engineering
application options without changing its absent-option defaults. The
[runtime tests](../worker/src/support-engineering.test.ts) exercise these
separations through the actual SDK.

## Browser HTTP operations

Let **T** be `/api/support/admin/tickets/:ticketId/engineering` and **P** be
`/api/support/admin/engineering/policy`. The optional router owns these paths before legacy Support commands.

| Method/path | Closed request body or query |
| --- | --- |
| `GET T` | No body/query |
| `GET T/work` | Exactly `sourceGeneration=N`, canonical positive safe integer |
| `GET T/proposal` | Exactly `sourceGeneration=N`, canonical positive safe integer |
| `POST T/review` | Only `intent`, the complete actor-bound SDK command |
| `POST T/enroll` | `commandId`, `expectedRevision` |
| `POST T/evidence` | `commandId`, `expectedRevision`, `expectedBehavior`, `actualBehavior`, `reproductionSteps`, `visibleMessageIds`, `verificationReference`, `security` |
| `POST T/repository` | `commandId`, `sourceGeneration`, `expectedWorkGeneration`, `repositoryKey`, `repositoryId`, `repositoryDescriptorHash`, `policyGeneration`, `policyHash`, `reason` |
| `POST T/withdraw` | `commandId`, `reason` |
| `POST T/invalidate` | `commandId`, `reason` |
| `GET P` | No body/query |
| `POST P/prepare` | `commandId`, `expectedGeneration`, `enabled`, `repositoryKeys` |
| `POST P` | Only `intent`, the complete server-prepared snapshot |
| `POST P/disable` | `commandId`, `expectedGeneration` |

These use the existing authenticated browser session, same-origin protections
and current `X-Pegma-CSRF`; bearer and agent credentials do not substitute.
Success is `{result, csrfToken}` with no-store responses. Current Identity,
session, stored roles and original request-header bindings are checked across
awaits and before responses. A closing denial can withhold an ACK after a real
SDK commit; it does not undo that commit. Errors expose bounded codes, not private
proof or raw dependency messages. Honor `Retry-After`.

Engineering reads have their own durable 120-per-hour policy; engineering
mutations have a separate 30-per-hour policy, both keyed by the current human
principal. These counters share the existing Store but consume neither the
ordinary ticket-reply quota nor each other's quota. Their expired windows are
swept in separate rotating cleanup invocations. A denied request returns the
actual limiter's `Retry-After`; crossing that deadline permits an explicit
retry and never schedules a command automatically.

Ordinary bodies, including preparation, use the existing **64 KiB / 10-second**
reader. Only full policy submission uses **128 KiB / 10 seconds**; its prepared
response is also bounded. Scalar command IDs remain case-preserved and bounded
to 200 characters; repository keys to 100, with at most 20 configured entries.
Expected/actual behavior are each at most 2,000 characters. Evidence requires
1–16 reproduction steps of at most 1,000 characters each and 1–16 unique actual
customer-visible message IDs. Validate the complete UTF-8 packet, not just each
field. The [HTTP tests](../worker/src/support-engineering-handlers.test.ts)
include a genuine legal multibyte full intent above 64 KiB.

Withdrawal reasons are `privacy_withdrawal`, `source_access_revoked` and
`source_deleted`; invalidation reasons are `evidence_revoked`,
`product_binding_revoked` and `check_policy_revoked`.

Source and work results contain bounded operational metadata. The separate
proposal read projects the complete checked outbound request for explicit human
inspection. Review uses a retained full command with its exact actor, ticket,
source and work generations, proposal hash, decision and command identity.
The current SDK receipt lookup precedes mutable export proofs. Exact accepted
replay therefore survives source withdrawal or unavailable repository facts.

The runtime passes its fresh staff check and original-browser callback through
the public SDK's `verifyBeforeCommit` option for all seven human intake and
policy mutations. The SDK looks for an exact accepted receipt before invoking
the new-command guard. Its async check resolves current browser and human
roles; the final synchronous fence checks abort/deadline and the original
caller's bound principal at the Application transaction boundary. Current
browser and role checks still protect every replay and response. The separate proposal
review guard applies to both approval and rejection. New approval also requires
the configured read-only routing, checks and repository proof ports. The
independent review switch defaults OFF.

An unresolved engineering review retains its original full command. The public
SDK exposes receipt-first replay through `reviewProposal`. A never-accepted
stale command remains held until an authoritative resolution is available.
Current reads and transport errors preserve that unknown owner.

## Generation zero and verified failure evidence

An initial source can be `sourceGeneration:0`, `state:unverified`,
`security:uncertain`. Ordinary Support can receive 403 for that source because it
has no restricted-read grant. Neither 403 nor 404 establishes absence,
ordinary sensitivity or evidence eligibility.

The panel requires an explicit known enrollment ACK, then a **new same-actor
staff-ticket read started after that ACK**, before permitting initial evidence
when the source remains protected. Evidence uses that current ticket revision
and explicitly selected existing public messages. It does not require generation
1 before the evidence that creates it. Unknown enrollment cannot admit another
intent. This exact source-zero/403 path runs through real browser authority and
the actual SDK in the
[browser integration tests](../src/support-engineering-integration.test.ts).

Staff evidence is `staff_verified_failure`: expected and observed behavior,
reproduction steps, public message references and a verification reference.
Sensitivity must be explicitly `ordinary`, `restricted` or `uncertain`, with no
ordinary default. The server supplies authenticated actor/time and independently
trusted product context; a typed verification reference is not a trusted automated
test receipt. Missing product proof can hold the source without creating work.
Restricted/uncertain evidence does not become ordinary through a Support-only
form. Internal notes are not public message choices. See the
[HTTP fixture](../worker/src/support-engineering-http-fixtures.ts) and
[panel tests](../src/support-engineering-ui.test.ts).

A known, bound evidence ACK can settle after a new same-actor staff-ticket
read even when the private source still returns 403. This does not grant
restricted-read permission or prove the current source state. In that case
the panel permits explicit withdrawal, while evidence reclassification and
invalidation remain unavailable. Unknown commands stay retained; a denial
alone cannot acknowledge them.

## Immutable policy intent and recovery

Policy GET distinguishes saved mapped entries, `unmappedRepositoryCount` and the
full configured `catalog`, including unselected entries. Empty catalog does not
mean empty saved policy. Show unmapped saved rows, block ordinary replacement
rather than silently dropping them, and retain explicit authorized disable.

Preparation returns an opaque version-1 intent containing `actorId`, exact
`commandId`, `expectedGeneration`, ordered `repositoryKeys` and the complete
ordered policy descriptors. Preparation does not write a policy. Retain that
full JSON unchanged and submit only `{intent}`; it is not a token or permission.
Keep it out of DOM, URLs, logs and browser storage. Do not reconstruct it from a
later catalog. Current Admin + Support and browser authority are still required
on every preparation, submission and replay.

The SDK checks the complete retained command for an accepted receipt before
new-command policy and catalog checks. Only a new command must match current
trusted configuration and pass the SDK's expected-generation CAS. Changed
descriptors or removed keys cannot strand an already committed ACK. A missing
or pruned receipt cannot create a new commit under a stale generation. Do not
reset/reuse policy heads or edit SDK policy rows outside supported operations.
Complete normalized intent bytes, including wrapper keys and ordering, bind the
server-derived correlation identity. Altering a snapshot while reusing an ID
is a conflict, not a corrected retry.

Repository selection follows the same boundary. The checked work response
provides ordered `repositoryChoices` containing each friendly key, immutable
repository ID and full normalized descriptor hash, together with the current
policy generation and hash. Retain the chosen pair, descriptor hash and policy
fences in the original command. Only the friendly key is displayed; descriptors
and installation bindings are not browser fields. New selections must match the
current configured descriptor and SDK policy. Exact accepted replay bypasses
obsolete catalog facts while still requiring current browser and Support
review authority. A removed key or changed descriptor without an accepted
receipt cannot authorize a new selection.

The [actual HTTP policy cases](../worker/src/support-engineering-handlers.test.ts)
cover changed/removed catalogs, altered wrappers, future heads, missing/pruned
receipts, current-role revocation and CAS races. Repository keys only select
immutable server-configured descriptors; never rebind an existing key to a
different repository. A saved descriptor or enabled policy does not prove
installation access, current remote visibility/metadata, routing calibration,
independent checks or publication authority. Those remain later SDK gates.

For any sent mutation, preserve the original actor, domain/ticket, method,
route, complete packet and command identity. A timeout, malformed ACK or
postcommit denial remains uncertain. No successful GET or apparent state change
acknowledges an unknown write. Explicit retries reuse the exact packet and ID
with current browser authority; never blindly mint a replacement. Once a bound
ACK is known, recovery becomes matching fresh reads only, not another mutation.

The standalone panel keeps separate pending owners for ticket and policy
operations. Its `pendingOwners()` callback inventory is the recovery authority;
a selected ticket must never replace another ticket's retained owner. Access,
feature loss and view changes clear private presentation while preserving those
owners for their original account. Full-page unload loses in-memory packets.
The controller keeps one panel lifecycle and offers sign-in in another tab.
Its retained-owner controls preserve the original account and ticket coordinates.
Global repository-policy recovery uses current account authority independently
of ticket selection.

## GitHub creation receipts and current repository authority

The [repository adapter](../worker/src/support-engineering-repository.ts) keeps
issue creation separately OFF by default. Its explicit trusted configuration
supplies immutable repository/App/installation coordinates and current issuer
authority. Numeric token scope proves only the selected repository ID, exact
permission scope and expiry; token response entries may contain only that ID.
Full names, ownership, visibility and repository state come from an authoritative
scoped-token repository GET after every asynchronous authentication boundary,
for every issue read and write. That snapshot must still match the approved
identity/state/version. Only synchronous current/enablement guards separate it
from the issue request.

GitHub offers no atomic visibility precondition for issue creation. A repository
administrator can publish a private repository or its existing content at any
time. The final GET rejects visibility changes during token minting or awaited
authentication; it does not make visibility atomic with the POST. Trusted
activation must retain that external administrator disclosure boundary.

New issue creation also requires a durable
[creation receipt port](../worker/src/support-engineering-acceptance.ts).
The production composition's existing `attachRuntime` binds it to the actual
Support Store and clock, independently of model/checker readiness. Before that
binding, a new issue write is unavailable. Missing or incomplete production
configuration retains the original OFF behavior and performs no receipt Store
I/O. This adds no default customer, service, role or publication authority.

An acknowledged one-shot durable intent precedes a new POST. Existing, uncertain
or accepted intents never authorize another physical POST. The captured provider
response must match the approved title, body and normalized label set before the
exact issue acknowledgement is durably recorded. The stored receipt contains
opaque request/source/App/installation/repository bindings, immutable issue
coordinates and the historical accepted payload hash; it stores no issue text,
labels or credentials.

Create reconciliation and its independent verifier require that matching known
receipt and a current direct observation of its exact issue coordinates/App
origin and repository authority. Mutable markers, copied same-App content,
search absence or indexing delay cannot create acceptance. If the provider HTTP
ACK never arrived, the operation remains unknown for human review with no second
POST. If the exact response was recorded and only the later SDK ACK was lost,
recovery can confirm it with model and creation OFF, including after source
withdrawal. Later legitimate remote title/body/label edits do not erase that
historical receipt. Existing-issue links instead use their approved immutable
coordinates and current reads without creating a receipt or modifying the issue.

Remote issue text is bounded by the 64 KiB response limit; duplicate display
context is projected to the SDK's title200/body12000 bounds. Projection grants
no issue identity or acceptance authority. Search and create inputs are captured
before awaits. The stream reader skips empty chunks, rejects more than 64
consecutive empty chunks and enforces a finite 65,600-chunk read budget alongside
the existing byte, abort and nonrenewing operation deadline bounds.

Per operation, metadata uses two GETs. Duplicate search uses five HTTP requests:
two metadata GETs, one exact-ID scoped-token POST, the final scoped repository GET
and one search GET. Creation uses the same five-request shape with one issue POST
in place of search. Known-receipt create/link reconciliation and its independent
verifier each use five: two metadata GETs, one scoped-token POST, the final scoped
repository GET and one direct issue GET. Read tokens have Metadata read and Issues
read only. Tokens stay private to the operation; no App JWT is minted and no HTTP
request is automatically retried.

The [actual SDK/MemoryStore cases](../worker/src/support-engineering-github.test.ts)
separate missing provider ACKs from ACK loss after durable recording, retained
source withdrawal, mutable/copyable markers, indexing delay and ID-only grants.
Earlier marker-only Native measurements do not qualify this new receipt path;
fresh registered-route Native qualification must use the actual Store-backed
creation capability and both uncertainty cases.

## Qualification and configuration

The earlier standalone source checkpoint passed its 1,142-test suite with
1,066 Node cases, 74 Native D1 cases and two benchmark cases. Its five focused
engineering HTTP scenarios passed the 50-binding-call and 100-parameter test
ceilings. Those results describe the earlier standalone assembly.

The current Sessions selection is recorded in the
[public package graph](SUPPORT_COMPOSITION.md#packages) and manifest. The earlier
[Sessions `0.2.1` producer checkpoint](https://github.com/pegma-dev/sessions/releases/tag/v0.2.1)
established that default read and expiry-sweep observations follow their awaited storage
snapshots under a consistent advancing clock. Explicit caller instants retain
their semantics, and future idle anchors from rollback or skew still fail closed.

The combined current-parent root, controller and review changes require fresh
format, types, full Node 22 and 24 tests, build and current-head CI and review.
Actual registered-route Native D1 measurements must cover intake, policy,
proposal, review, recovery and late current-authority denial. The measurements
include the real Identity, sessions, role checks and durable limiter.

Trusted configuration supplies product/build evidence, the immutable repository
catalog and current read-only review proof ports. Processing and export require
separate provider, usage, calibration, independent checks and GitHub connector
qualification. The human composition keeps processing OFF. Customer AI and
provider activation remain OFF while their own operational gates are pending.
