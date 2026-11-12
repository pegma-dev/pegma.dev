# Support resolution learning

Maintained by RetireGolden, LLC.

This optional assembly turns a verified support resolution into a private KB
proposal for human review. Approval records the exact checked proposal; KB
publication remains a separate human workflow. The learning panel does not
publish articles, call a model, or notify customers.

The factories, authenticated routes and staff panel exist in source. The current
[Worker entry point](../worker/src/index.ts) does **not** compose the learning
handler, processing worker or required trusted processing ports. Learning remains
default off. Passing factory and synthetic integration tests is not deployment or
activation evidence.

## Packages and authority

The host selects all five published Support Desk packages at **0.2.7** and its
four direct Knowledge Base packages at **0.1.6**. The qualified
[Support 0.2.7 release](https://github.com/pegma-dev/support-desk/releases/tag/v0.2.7)
also uses exact KB **0.1.6** public contracts. The
[public forwarding port](../worker/src/support-learning-ports.ts) preserves the
actual KB error instances; the obsolete KB 0.1.2 constructor alias and translation
shim are removed. See [package pins](../package.json) and the
[lockfile](../pnpm-lock.yaml). Package publication and installation do not qualify
this host's changed review flow or activate learning.

Historically, Support **0.2.1** used nested KB **0.1.2** while this host selected
direct KB **0.1.5**. The exact `@pegma/knowledge-base-ai-compat` registry alias and
recognized-error translation belonged to that earlier assembly. Its failed
isolated production-layout diagnostic remains historical evidence; neither its
ordinary fixture passes nor that failure qualifies the current 0.2.7 graph.

The current [host policy](../worker/src/support-access.ts) grants four human
learning permissions through the actual stored, audited **Support** role:

| Permission | Human operation |
| --- | --- |
| `support.learning.read` | Read source state and work metadata |
| `support.learning.evidence.submit` | Enroll, submit a staff-verified fix, enter the invalidation route |
| `support.learning.review` | Approve or reject an exactly checked proposal |
| `support.learning.withdraw` | Withdraw a source for privacy, access or deletion |

The routes also require current Support queue-read authority. Invalidation keeps
the SDK's learning-withdraw check as well as the HTTP evidence-submit entry
check; the entry permission never replaces application/resource guards. Human Support does
not gain `support.learning.process`, service identities or KB permissions.
Proposal reads and new review mutations additionally require current KB
`draftRead` **and** `provenanceRead`, normally through the separately assigned
**Knowledge** role. The runtime rechecks those permissions, learning review and
queue authority before and after the SDK's actual commit-proof callback, for
browser submissions and trusted direct SDK reviews. HTTP requires a complete
review intent and fences the original browser session and headers at commit. Exact accepted-receipt recovery and explicit
cancellation require current learning review/queue and browser authority without
reconstructing obsolete KB proof or requiring a retained Knowledge grant.
Knowledge or Admin alone does not grant Support access. Learning approval does
not grant KB review or publication authority.

Agent delegation remains exactly the existing three scopes: KB draft-read,
draft-write and evidence-submit. There is no added learning, provenance,
human-report-confirmation, review, publication or role-administration scope.
Browser role fields never establish authority.

## Source generation zero is real state

Enrollment creates `unverified`, `sourceGeneration: 0`, `resolutionCycle: 1`.
It does not establish verified evidence or create generation work. Source
counters are nonnegative; work and review keys require positive generations.
A valid generation-zero source read or mutation ACK must not be treated as an
unknown failed write.

The first staff-verified fix uses the current ticket revision and resolution
cycle, a current customer-visible solution message, and a bounded verification
reference. The SDK requires a resolved or closed ticket with `resolvedAt` and
current human permission. The server supplies the authenticated actor and trusted
product/build facts. Current eligible evidence advances the initial source to
`eligible`, generation **1**, and creates bounded work. Missing or expired trusted
product context can instead produce **held generation 0** with no work or model
call; that is also a valid acknowledged result.

The panel enables initial evidence from current resolved-ticket metadata; it does
not require generation 1 before the evidence that creates it. Work, proposal and
review controls require a current **eligible, positive-generation** source, and
review additionally requires the separately checked target. A zero counter alone
never qualifies a source for processing. Reopened, invalidated or withdrawn
sources cannot borrow authority from an earlier review.

Processing uses only the permitted customer-visible solution/transcript rows;
internal notes never enter model input or customer KB output. A generated
candidate is bounded untrusted data, not publication proof. Trusted checks,
current target selection and human KB governance remain separate gates.
The actual transitions, including `unverified0 -> eligible1` and a missing-product
`held0`, run through real auth, routes and SDKs in
[the browser integration tests](../src/support-learning-integration.test.ts).
The [panel tests](../src/support-learning.test.ts) also cover invalid counters,
terminal-ticket prerequisites and exact unknown-packet recovery.

## Authenticated HTTP contract

[The handler](../worker/src/support-learning-handlers.ts) owns only this prefix:

`/api/support/admin/tickets/:ticketId/learning`

It accepts the existing authenticated browser session, same-origin mutation
headers and current CSRF token. Current Identity, stored roles, session and
request-header bindings are fenced across awaited reads, body parsing, operations
and final responses. A postcommit denial can withhold an ACK while a durable SDK
effect remains; it does not roll the effect back.

All mutation bodies are closed objects. Ordinary packets cannot independently
supply actor, role, target, provenance, product, policy, timestamp,
receipt-authority or correlation fields. Review packets echo the complete
server-prepared immutable intent, including its actor/target/policy coordinates;
that echo grants no authority and remains subject to SDK validation. The server
preserves `commandId` exactly, including case, and derives its own stable
correlation identity from actor, operation, ticket and that exact ID for submit,
receipt and cancellation alike. Scalar IDs and reasons are bounded to 200
characters. A hash-only body fails review packet validation. Ticket revisions,
resolution cycles and requested work/review generations are positive safe
integers. Query generations use canonical positive decimal text, with no
duplicate or extra query keys. The existing JSON reader limits the body to
64 KiB with a 10-second
body deadline.

| Method and suffix | Accepted fields or query | Result boundary |
| --- | --- | --- |
| `GET` base | No query | Source generation, resolution cycle, state, reconciliation flag and optional hold reason |
| `GET /work` | Exactly `sourceGeneration=N`, positive | Work generation, status, stage, proposal-presence flag and optional hold reason |
| `GET /proposal` | Exactly `sourceGeneration=N`, positive | Actual checked private KB draft and complete immutable review intent, including source/work/target and full trusted policy binding |
| `POST /enroll` | `commandId`, `expectedRevision` | Actual SDK source result; initial generation may be zero |
| `POST /enroll-recovery` | The byte-identical retained enrollment body | `200` accepted/pending/superseded retry-and-reconcile result |
| `POST /evidence` | `commandId`, `expectedRevision`, `resolutionCycle`, `solutionMessageId`, `verificationReference` | Server fixes the evidence kind to `staff_verified_fix` |
| `POST /evidence-recovery` | The byte-identical retained evidence body | `200` accepted/pending/superseded retry-and-reconcile result |
| `POST /review` | `commandId`, `intent`, `decision`; optional `reason` | `approve` or `reject`; accepted result is `{outcome:'accepted',result}` |
| `POST /review-receipt` | The identical retained review packet | Actual accepted/cancelled receipt union, or `null`; no stale source/KB reconstruction |
| `POST /review-cancel` | The identical retained review packet | Atomically fence that exact unaccepted review, or recover its existing accepted receipt |
| `POST /invalidate` | `commandId`, `reason` | Evidence/product/check-policy invalidation |
| `POST /withdraw` | `commandId`, `reason` | Privacy/access/deletion withdrawal |

Invalidation reasons are exactly `evidence_revoked`, `product_binding_revoked` and
`check_policy_revoked`. Withdrawal reasons are exactly `privacy_withdrawal`,
`source_access_revoked` and `source_deleted`.

Ordinary source/work DTOs contain no KB body, generated candidate, draft payload,
private proof or exact delivery request. The separate proposal route requires KB
authority and prepares the actual draft plus the SDK's full immutable intent.
The entire policy binding, including verification and expiry timestamps, remains
part of that exact command. A new review checks current source, target and
policy plus the fresh human commit guards. Accepted receipt recovery precedes
obsolete proof reads. A changed proposal needs a new explicit review after the
old command is acknowledged or explicitly cancelled; it cannot rebind an earlier
command ID. Cancellation does not undo an already accepted review. A `null`
receipt or any error is not a terminal acknowledgement. An external commit-guard
refusal may conservatively surface as `503` acknowledgement uncertainty; retain
the packet instead of inferring a new command is safe.

Success is `{result, csrfToken}`. Errors use closed safe codes and the existing
no-store JSON response convention; durable rate limiting supplies `Retry-After`
when applicable. Raw dependency errors, model output and private proof are not
returned as error messages.

### Retained intake retry and reconciliation

The existing manual Retry control sends retained enrollment/evidence packets to
`enroll-recovery` or `evidence-recovery` with byte-identical original bodies.
These operations can apply the original valid command; they are retry and
reconciliation endpoints rather than read-only receipt/status queries. They
retain the original EvidenceSubmit/queue permissions, authenticated browser,
CSRF, limiter and closing authority fences. There is no automatic mutation
polling or new command ID.

Each `200` response uses `{result, csrfToken}`. Its result always binds
`ticketId`, the exact `commandId` and `operation:'enroll'|'evidence'`, plus one
closed variant:

| Outcome | Additional fields and meaning |
| --- | --- |
| `accepted` | `result` contains the actual SDK source result for that exact command |
| `pending` | The original command remains unresolved |
| `superseded`, newer revision | `expectedRevision` and strictly newer `observedRevision` prove that the old-revision command cannot apply in the future. This variant has no `fence` field |
| `superseded`, same-revision evidence | Equal `expectedRevision` and `observedRevision`, with required `fence` set to `solution_unavailable`, `resolution_unavailable` or `resolution_cycle_changed`, prove that the original evidence command cannot apply in the future |

A superseded result leaves the earlier historical outcome unknown. The panel
requires its closing same-actor/session/epoch checks before releasing that
retained owner and directs the operator to read current state before another
action. Generic `409`/`503` responses, mutable-read failures and other errors
retain ownership. The server attempts exact SDK recovery before observing the
current ticket and retries that exact command again after the proof before
reporting superseded. For same-revision evidence, it verifies the current
resolution status and customer-visible solution message, or separately reads
the current source cycle with the existing learning-read permission. Repairs
to these prerequisites advance the ticket revision. Enrollment has no
same-revision content-fence result.

A pending result keeps the original packet. If the ticket needs an ordinary
reply or status change, an authorized operator can use another staff tab and
then retry the exact original packet here after the revision advances. Reads,
generic conflicts and an unrecognized same-revision fence do not release the
retained owner.

### Opt-in staged review HTTP

The staged protocol uses the same authenticated prefix and complete retained
`{commandId, intent, decision, reason?}` packet as inline review. It requires the
configured staged capability. The staff-ticket response's optional
`learningStagedReviewEnabled` hint selects this protocol in the panel; current
server authority and SDK guards still decide every operation.

| Method and suffix | Accepted body | Status and result |
| --- | --- | --- |
| `POST /review-queue` | The complete original review packet | `202` when the durable intent is pending; `200` for an existing accepted/cancelled result |
| `POST /review-queue-status` | The identical retained review packet | `200` with pending status, an accepted/cancelled result, or `null` |
| `POST /review-queue-cancel` | The identical retained review packet | `200` with the exact cancellation or an already accepted result |

Each success retains the `{result, csrfToken}` envelope. A pending result has
`outcome:'pending'`, `ticketId`, `commandId`, `phase:'proof'|'commit'`, boolean
`claimed` and `held`, and canonical ISO `expiresAt`. It records an admitted human
intent, not a completed review or KB publication. Claims and proof phases remain
SDK-owned. Expiry, a hold, a `null` observation or an error does not settle the
original command. Accepted receipt recovery and cancellation use current
browser/review/queue authority without reconstructing obsolete KB proofs; new
admission and proof still require their current KB authority.

After a valid non-held pending acknowledgement, the panel schedules only
review-status requests: at most ten automatic polls, thirty seconds apart.
A hold, terminal result, changed owner/ticket context or suspension stops polling.
The limit leaves the exact packet available for explicit status/retry/cancel
recovery. Polling never submits another approval or changes its command bytes,
and an unknown cancellation keeps cancellation as the retained operation.

See the actual
[HTTP tests](../worker/src/support-learning-handlers.test.ts) and
[router tests](../worker/src/support-learning-routing.test.ts).

## One panel, current capability, exact retry

The [staff ticket page](../src/pages/staff/support/ticket.astro) loads one
[persistent panel instance](../public/staff-support-learning.js), wired by the
[existing controller](../public/staff-support-ticket.js) to its current session,
CSRF and request primitives. Private content uses inert text rendering.

Only a fully refreshed current staff detail response with
`learningEnabled === true` can show the panel. This boolean is a display hint,
not a credential. [The router](../worker/src/support-api.ts) emits it only when the
optional server callback is configured, after current stored Support,
Identity/session and ticket reads. Absent capability is false; the browser does
not infer it from a 404. The separate `learningReviewRecoveryEnabled` hint can
keep only a retained review's receipt/cancel controls available when ordinary
learning reads are unavailable. It grants no authority; the server still checks
the original browser and current review/queue permissions. Recovery controls
remain outside the hidden private-draft panel. The old detail JSON shape stays
unchanged when the callback is omitted. The learning namespace is dispatched
before legacy generic mutations, and stays 404 without both a configured handler and a current strict
true readiness callback.

A sent action retains its original actor, ticket, route and **exact JSON bytes**
in the panel's page-lifetime closure. A timeout, denial, malformed ACK or raced
session change leaves it unresolved. No GET, new proposal or apparent state
change acknowledges it. Recovery uses the original account and ticket with
current CSRF and the identical retained packet. Explicit receipt lookup or exact submission retry can recover
acceptance without reopening obsolete source/KB facts. Explicit cancellation
becomes sticky: after an unknown cancellation ACK, Retry keeps cancelling the
same command instead of resending approval. A null receipt, ordinary GET or new
proposal never clears it. A valid accepted/cancelled ACK must also pass the
closing same-session check before the packet can clear; no replacement command
ID is invented.

Ticket refresh, sign-out, address changes and account A-to-B-to-A transitions
clear private DOM immediately while preserving that unresolved packet for its
owner. Pending state blocks competing writes and automatic navigation; sign-in
opens separately and the page has an unload guard. This is in-memory intent
preservation for the current page, not a new browser persistence service. A full
page unload discards that closure, so the controller does not automatically
navigate away to recover from a 401.

## Compose trusted factories before activation

The source seams are optional and preserve previous defaults:

| Factory or seam | Host responsibility |
| --- | --- |
| [Support runtime](../worker/src/support-desk.ts) `resolutionLearning` option | Supply reviewed SDK intake options; ordinary runtime construction keeps intake off |
| [Application option helper and source bridge](../worker/src/support-learning.ts) | Intake `enabled` is explicit; construct the source verifier from current real Support facts before KB |
| [Learning processing ports](../worker/src/support-learning-ports.ts) | Supply actual service, KB and retirement authority, verified configuration, checks, model, usage, target selection and local token counter |
| [Learning runtime](../worker/src/support-learning.ts) | Supply actual applications, source verifier, clock and a current staff resolver; `processingEnabled` defaults false and missing ports hold work before claiming or paying |
| [Knowledge runtime](../worker/src/knowledge-runtime.ts) `privateSources` option | Pass the same current source verifier into the direct KB application and its ready path |
| [Projection application and maintenance](../worker/src/knowledge-retrieval-maintenance.ts), [ready factory](../worker/src/knowledge-retrieval-ready.ts) `privateSources` options | Preserve that verifier when constructing projection/repair applications, so derived hints cannot bypass current source authority |
| [HTTP handler](../worker/src/support-learning-handlers.ts) and [Support router](../worker/src/support-api.ts) | Supply real auth, lazy learning runtime, existing durable limiter and current surface/readiness callbacks. The runtime supplies trusted KB, checks and clock ports. |

Intake, model processing and HTTP availability are separate controls. Model
processing defaults off; an incomplete processing assembly returns a held result.
Do not gate privacy withdrawal, invalidation or source reconciliation on the model
switch. With their real authority ports present, cleanup can continue while
models are off. Current source verification can refuse an already published guide
immediately after reopening or withdrawal; physical reconciliation does not
restore publication authority. These paths are exercised in
[the learning assembly tests](../worker/src/support-learning.test.ts).

No provider route, account/project configuration, service grant, scheduler or
worker is constructed from an HTTP packet. Staged review requires
`PEGMA_SUPPORT_LEARNING_REVIEWS_ENABLED` exactly `"true"`, a
`SUPPORT_LEARNING_REVIEWS` binding and a trusted `learningReviews` composition
whose readiness callback returns true. The checked-in flag is `"false"`, and the
production default `createWorker()` supplies no such learning bundle. The flag
alone supplies neither that runtime nor its trusted processing ports. See the
[composition controls](SUPPORT_COMPOSITION.md#optional-resolution-learning).

For executed lower-layer composition, see
[Bench Ticket](../recipes/bench-ticket/README.md), its
[composition](../recipes/bench-ticket/composition.ts) and
[composition tests](../recipes/bench-ticket/composition.test.ts). That recipe is a
support-queue foundation, not a learning activation recipe. The learning assembly
itself is explicit in the public
[SDK fixture](../worker/src/support-learning-fixtures.ts) and authenticated
integration tests; all business data and external model/check ports there are
synthetic.

## Validation status and remaining gates

At the earlier Support **0.2.1** / direct KB **0.1.5** learning checkpoint,
**24 Memory cases and three genuine local Native D1 cases** passed; the HTTP
surface passed **39 cases**. That earlier focused browser/backend run passed
**93 cases**: 24 assembly, 45 panel, nine actual browser integration and 15 router
cases, with zero errors in its Astro, Worker and recipe check. These historical
counts overlap the assembly baseline. They predate the earlier 0.2.2 adoption and
full-intent/commit-guard changes and do not qualify the current host source.
The earlier public `0.2.5` [adoption checkpoint](KNOWLEDGE_COMPOSITION.md#public-025-adoption-checkpoint)
passed 1,125 tests locally and in CI. It does not qualify the current `0.2.7`
graph. Current host validation, review and deployment acceptance remain pending.

Relevant executable sources are the
[Memory assembly](../worker/src/support-learning.test.ts),
[Native D1 assembly](../worker/src/support-learning.d1.test.ts),
[HTTP](../worker/src/support-learning-handlers.test.ts),
[panel](../src/support-learning.test.ts),
[browser integration](../src/support-learning-integration.test.ts) and
[router](../worker/src/support-learning-routing.test.ts) tests.

The normal Native suite and its bounded HTTP/Queue profiles passed at that
checkpoint. Those fixture-profile results leave CPU/day limits, deployment,
actual client/provider privacy evidence, complete customer/staff/admin workflow
acceptance and pilot gates open. A separate
native answering run with released Support 0.2.1, KB 0.1.5 and the D1 adapter
failed the Workers Free 50-call whole-invocation limit. Published Support
**0.2.2** introduced opt-in staged assistant retrieval, separately from learning:
preparation consumes attempt one without paid usage or a model call, and paid
generation consumes attempt two in a genuinely later physical invocation. Both
attempt limits must allow at least two. Only a durable acknowledged no-call finish
returns `prepared`; an uncertain finish remains `pending`. Default behavior stays
monolithic, and an opted-in host must return rather than resume through the same
invocation or `waitUntil`. These producer semantics are not a passed whole-host
Free, CPU or daily-quota result. Neither grouped reads nor historical focused
source results close activation.
