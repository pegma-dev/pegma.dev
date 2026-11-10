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

The host pins Support Desk packages to **0.2.1** and its direct Knowledge Base
packages to **0.1.5**. The optional AI package still recognizes the exact KB
**0.1.2** error constructors. The registry alias
`@pegma/knowledge-base-ai-compat` supplies those constructors;
[the compatibility port](../worker/src/support-learning-ports.ts) translates only
recognized not-found and concurrency errors from the direct KB application.
It does not create another KB application, Store or authorization policy. See
[package pins](../package.json) and the [lockfile](../pnpm-lock.yaml).

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
Proposal reads and reviews additionally require current KB `draftRead` **and**
`provenanceRead`, normally through the separately assigned **Knowledge** role.
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
The actual transitions, including `unverified0 → eligible1` and a missing-product
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

All mutation bodies are closed objects. There are no client actor, role, target,
provenance, product, policy, timestamp, receipt-authority or correlation fields.
The server preserves `commandId` exactly, including case, and derives its own
stable correlation identity from actor, operation, ticket and that exact ID.
Scalar IDs and reasons are bounded to 200 characters; `reviewBindingHash` is
64 lowercase hexadecimal characters. Ticket revisions,
resolution cycles and requested work/review generations are positive safe
integers. Query generations use canonical positive decimal text, with no
duplicate or extra query keys. The existing JSON reader limits the body to
64 KiB with a 10-second
body deadline.

| Method and suffix | Accepted fields or query | Result boundary |
| --- | --- | --- |
| `GET` base | No query | Source generation, resolution cycle, state, reconciliation flag and optional hold reason |
| `GET /work` | Exactly `sourceGeneration=N`, positive | Work generation, status, stage, proposal-presence flag and optional hold reason |
| `GET /proposal` | Exactly `sourceGeneration=N`, positive | Current eligible source/work, actual checked private KB draft, expected work generation and server-issued `reviewBindingHash` |
| `POST /enroll` | `commandId`, `expectedRevision` | Actual SDK source result; initial generation may be zero |
| `POST /evidence` | `commandId`, `expectedRevision`, `resolutionCycle`, `solutionMessageId`, `verificationReference` | Server fixes the evidence kind to `staff_verified_fix` |
| `POST /review` | `commandId`, `sourceGeneration`, `expectedWorkGeneration`, `reviewBindingHash`, `decision`; optional `reason` | `approve` or `reject` of the exact currently checked proposal |
| `POST /invalidate` | `commandId`, `reason` | Evidence/product/check-policy invalidation |
| `POST /withdraw` | `commandId`, `reason` | Privacy/access/deletion withdrawal |

Invalidation reasons are exactly `evidence_revoked`, `product_binding_revoked` and
`check_policy_revoked`. Withdrawal reasons are exactly `privacy_withdrawal`,
`source_access_revoked` and `source_deleted`.

Ordinary source/work DTOs contain no KB body, generated candidate, draft payload,
private proof or exact delivery request. The separate proposal route requires KB
authority, reads the actual draft and provenance, resolves the current trusted
check policy and binds what was shown. Review rereads those facts and compares
the shown binding before the SDK's final guard. A changed proposal needs a new
explicit review; it cannot rebind an earlier command ID.

Success is `{result, csrfToken}`. Errors use closed safe codes and the existing
no-store JSON response convention; durable rate limiting supplies `Retry-After`
when applicable. Raw dependency errors, model output and private proof are not
returned as error messages. See the actual
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
not infer it from a 404. The old detail JSON shape stays unchanged when the
callback is omitted. The learning namespace is dispatched before legacy generic
mutations, and stays 404 without both a configured handler and a current strict
true readiness callback.

A sent action retains its original actor, ticket, route and **exact JSON bytes**
in the panel's page-lifetime closure. A timeout, denial, malformed ACK or raced
session change leaves it unresolved. No GET, new proposal or apparent state
change acknowledges it. Recovery is a fresh read under the original account and
ticket followed by an explicit retry of the same packet, using current CSRF;
it never invents a replacement command ID. A valid ACK must also pass the closing
same-session check before the packet can clear.

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
| [HTTP handler](../worker/src/support-learning-handlers.ts) and [Support router](../worker/src/support-api.ts) | Supply real auth, lazy runtime, direct KB reads, trusted review policy, clock, existing durable limiter and current surface/readiness callbacks |

Intake, model processing and HTTP availability are separate controls. Model
processing defaults off; an incomplete processing assembly returns a held result.
Do not gate privacy withdrawal, invalidation or source reconciliation on the model
switch. With their real authority ports present, cleanup can continue while
models are off. Current source verification can refuse an already published guide
immediately after reopening or withdrawal; physical reconciliation does not
restore publication authority. These paths are exercised in
[the learning assembly tests](../worker/src/support-learning.test.ts).

No provider route, account/project configuration, service grant, scheduler or
worker is constructed from an HTTP packet. The current production entry point
omits this learning composition entirely. There is no deployment flag or model
configuration example to copy from this document.

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

The released-pin learning baseline has passed **24 Memory cases and three genuine
local Native D1 cases**; the HTTP surface has passed **39 cases**. The current
focused browser/backend run passed **93 cases**: 24 assembly, 45 panel, nine actual
browser integration and 15 router cases. The current Astro, Worker and recipe
check reported zero errors. These counts overlap the assembly baseline; they are
scoped results, not a sum proving a complete workflow.

Relevant executable sources are the
[Memory assembly](../worker/src/support-learning.test.ts),
[Native D1 assembly](../worker/src/support-learning.d1.test.ts),
[HTTP](../worker/src/support-learning-handlers.test.ts),
[panel](../src/support-learning.test.ts),
[browser integration](../src/support-learning-integration.test.ts) and
[router](../worker/src/support-learning-routing.test.ts) tests.

Whole current Native-suite and whole HTTP-invocation query/parameter evidence,
CPU/day limits, deployment, actual client/provider privacy evidence, complete
customer/staff/admin workflow acceptance and pilot gates remain open. A separate
native answering run with released Support 0.2.1, KB 0.1.5 and the D1 adapter
failed the Workers Free 50-call whole-invocation limit. The proposed staged
retrieval Support 0.2.2 remains an **unpublished SDK candidate** under separate
producer review; it is not a released dependency or evidence that this host fits
Free. Neither grouped reads nor these focused source results close activation.
