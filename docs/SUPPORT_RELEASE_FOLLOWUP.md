# Staff release-follow-up controls

The default Worker can compose staff-verified deployed-fix evidence and the
bounded SD05 driver. `PEGMA_SUPPORT_RELEASE_FOLLOWUP_ENABLED` controls the
nonpaid staff/source surface; `PEGMA_SUPPORT_RELEASE_FOLLOWUP_PROCESSING_ENABLED`
separately controls background preparation. Both default to `false`. An explicit
`createWorker({ releaseFollowup })` selection retains its existing behavior,
including an explicitly absent selection. OFF routes return 404 before Store
initialization. No new cron, queue, remote issue write or automatic send/publish
is installed.

This source selects the [current published package graph](SUPPORT_COMPOSITION.md#packages);
the manifest and lockfile record its exact versions. Producer publication is
separate from host deployment acceptance. Development functional evidence and
the unchanged Native 50-query/100-parameter acceptance
are recorded separately; a functional Memory result does not establish that
physical budget, provider quality, CPU use or Workers Free acceptance.

## Composition and current authority

The registered createWorker source composition accepts releaseFollowup.
The [trusted port contract](../worker/src/support-release-followup-ports.ts)
requires current release evidence, complete bundle checks, retest-receipt
verification and explicit KB target resolution. The same evidence verifier
reaches the application and coordinator. Optional generation requires separate
evaluated support_release_followup configuration, current service authority,
model, token counter and bounded durable usage policy. Missing generation is
held without a provider call. Checks on retained content remain independent of
paid generation availability.

The [current host policy](SUPPORT_COMPOSITION.md#authorization) retains the
Support-role grants introduced in version 7: engineeringFollowupRead,
engineeringFollowupReview and engineeringFollowupEvidenceSubmit, alongside its
existing queue and reply authority. Admin or Knowledge alone receives no
follow-up authority. Processing uses an intrinsic service identity with exactly follow-up Process,
Read and queueRead. It has no human account, stored Role grant or review/send
authority. The existing scoped governance reader is reused without new grants.
Work hints contain no saved browser credentials or AccessContext.

The staff ticket detail supplies the optional `releaseFollowupEnabled` hint.
The page shows the panel only when this hint is `true`; omitted or false means
OFF. This is a display hint, not authority for a follow-up route. Suspending the
panel retains any unknown command for recovery by its original account after a
current enabled ticket read.

HTTP controls reuse Identity, Sessions, audited roles and the existing
engineering read/control quotas. They require the original current cookie
session and actor. Mutations require dynamic X-Pegma-CSRF, same-origin headers
and a total ten-second JSON-read deadline. SDK mutations receive the late
current-authority guard and synchronous closing fence; host mapping/receipt
writes close the same browser authority around their own conditional commits. A closing guard can
withhold an acknowledgement after a commit.

## HTTP and exact retry

Paths start at /api/support/admin/tickets/{ticketId}/follow-up/.
Each operation requires current queue authority and its named follow-up grant.
New posting additionally requires replyAny.

| Method and suffix | Exact input                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------- |
| GET scan          | Optional opaque cursor; one SDK page of 16 physical rows, with hints filtered to this ticket |
| GET work          | Query workId                                                                                 |
| POST observe      | commandId, repositoryId, issueId, inputReference                                             |
| POST reassess     | commandId, workId, expectedWorkGeneration, optional complete content                         |
| POST post         | commandId, workId, expectedWorkGeneration, expectedTicketRevision, bundleHash, messageId     |
| POST reject       | commandId, workId, expectedWorkGeneration, bundleHash, reason                                |
| POST retry        | commandId, workId, expectedWorkGeneration                                                    |
| POST abandon      | commandId, workId, expectedWorkGeneration, reason                                            |

Client command IDs are stable UUIDs. The server derives correlation from actor,
operation, ticket and command. Work-command mutations (`observe`, `reassess`,
`post`, `reject`, `retry`, `abandon` and `retest`) return
`{ result, commandId, operation, csrfToken }`. Mapping mutations
(`verify-mapping`, `withdraw-mapping`) and `retest-receipt` instead return
`{ result, csrfToken }`; their command identity is inside `result`, with no
top-level `commandId` or `operation`. Retest preparation can return HTTP 202
while the report phase is pending, then HTTP 200 when its receipt is ready.
The [HTTP adapter](../worker/src/support-release-followup-handlers.ts) owns these
envelopes; SDK result DTOs remain nested under `result`.
The SDK owns exact fingerprints, accepted receipts, generations, semantic
identities and conditional commits. Private
views expose selected metadata and candidate/checked content, while claim
identities, provider metadata and private check receipts stay server-side.

The panel displays complete retained content before explicit posting. Its
buttons are independent of new-draft form validation. Sent commands remain in
memory with their original actor, operation and byte-identical body. Unknown
responses block other writes. Restore the original account and current ticket
view, then use **Retry the exact previous command**. Another actor cannot view
or replay the retained packet. Keep the original tab open until confirmation.

## Current release and deployment evidence

The normal signed GitHub release webhook and existing reconciliation feed
maintain a small release epoch journal even while the SD05 Source flag is OFF.
Projection writers read the epoch observation and conditionally transact it
with the projection. Unchanged refreshes keep their epoch; withdrawal,
replacement and republication advance it. Identical display facts after
republication cannot revive an old mapping. This journal I/O remains required
while OFF; disabling follow-up routes and processing does not remove its fence.

The mapping picker reads at most 16 actual accepted SDK issue associations and
their genuine Source product. Staff explicitly verifies the issue state,
deployed version/build, deployment identity/epoch, scope and public facts under
the current cookie, Role and ticket/mapping generations. The server records the
mapping, exact command receipt and Audit atomically. The reference is meaningful
only with that durable record, current repository policy and the SDK's accepted
association/product checks. It is not a signed-marker claim. Withdrawal and
rollback retain historical receipts and hold new work.

An explicit staff verification is valid for one hour. Mapping reads expose its
`verificationValidUntil` deadline and report `current: false` after expiry.
Operation attestations last at most five minutes and never extend beyond that
original deadline. Reading or replaying an accepted verification command does
not renew it; staff must submit a new verification command against the current
mapping generation. The default verifier does not poll GitHub or deployment
systems for reopen or rollback changes. Staff must record those changes or
withdraw the mapping within this bounded verification window. Current release
epoch, repository policy and Source withdrawal checks still apply immediately.

New mapping routes share the existing namespace and quotas:

| Method and suffix     | Exact input                                                                                                                                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET mapping           | No query: bounded accepted choices. Or exactly repositoryId and issueId for one current mapping/release view                                                                                                                                 |
| POST verify-mapping   | commandId, expectedPrincipalId, expectedTicketRevision, expectedMappingGeneration, repositoryId, issueId, releaseRef, issueState, deploymentState, fixedProduct, deploymentId, deploymentEpoch, scopeRef, verificationReference, publicFacts |
| POST withdraw-mapping | commandId, expectedPrincipalId, expectedTicketRevision, expectedMappingGeneration, repositoryId, issueId, reason                                                                                                                             |

`fixedProduct` is exactly productId/version/buildId. Public facts have 1-4 unique
references (200 characters each), with text bounded to 1,000 characters.
Mapping ACKs contain only actorId, ticketId, commandId, mappingGeneration and
inputReference, plus the normal CSRF envelope. Observing that reference remains
a separate SDK command.

## Retest report association

Default retest association requires `PEGMA_KNOWLEDGE_ENABLED=true` and a valid
`SUPPORT_LEARNING_SOURCE_CONFIGURATION_JSON` with its optional `testEvidence`
block configured. That block contains a positive safe integer
`retentionMilliseconds`; the report article's collection must also appear in
the configuration's `collectionIds`. The existing intrinsic governance reader
uses this scope to read the current validation policy. Follow-up Source and
Knowledge must remain enabled and the selected configuration must remain
current. This governance read does not require learning intake or paid/model
processing to be ON, and it grants no human review or publication permission.
Missing or unavailable scoped governance returns HTTP 503
`followup_retest_unavailable`; HTTP 409 `followup_retest_changed` identifies an
actual report or Work conflict.

A local agent submits the existing KB test report; an authorized staff member
must confirm it through the existing KB controls. Follow-up association neither
confirms a report nor accepts KB evidence. It reads and confirms the actual
current report, draft, requirements, evidence revocations and reviewer authority,
and binds its product/build and request to the exact Work/release/target bundle.
Passed and failed reports retain their actual result.

`POST retest-receipt` accepts exactly commandId, expectedPrincipalId, workId,
expectedWorkGeneration, expectedTicketRevision, retestRequestId and report. The
report object is exactly articleId, ledgerEpoch, reportId,
expectedReportGeneration, reviewBindingHash and receipt, obtained from the
existing `reportRead` KB command.

PG preparation first returns HTTP 202 with actorId, ticketId, commandId, workId,
retestRequestId and `pending: "report"`. This acknowledges a body-free durable
Work intent, not a test result or pass. Retry the same original packet in a
separate invocation. The HTTP 200 result adds the purpose-bound opaque receipt
and validUntil instead of pending. Unknown ACKs retain the same actor, command
and packet; they never cause another association under a new identity.

A staged preparation intent expires after five minutes. An expired intent or
an exact command retained only as a tombstone returns HTTP 410
`followup_retest_expired`. Receipt and intent payloads become eligible for
redaction after 24 hours; associated Audit rows become eligible for deletion at
that age. The existing bounded nonpaid maintenance sweep performs this work
when it reaches each row, rather than purging at an exact time. Redaction keeps
the ticket/key and command/input hashes as exact-command tombstones. Legacy
rows are also swept.

Each ticket admits at most 64 new preparation commands over its lifetime.
Cleanup does not recycle admissions. This counter does not retroactively count
legacy history, so older records can exist in addition to those admissions.
A new command at the limit returns HTTP 429 `followup_retest_capacity`; an
already admitted command can still complete its requested second phase before
its intent expires.

`POST retest` takes commandId, workId, retestRequestId and receiptReference.
The real SDK owns current Source/association/release/Work checks and the late
browser/session guard. The verifier reobserves the KB report under its original
staff authority. Its operation-local observation remains provisional until the
actual KB confirmation closes alongside the SDK's current Source versions.
The original browser guard then runs before the final synchronous assertion
and conditional commit. Handles are never serialized or reused across requests.
Exact accepted SDK receipts recover before mutable proof reads.
A delivered Work uses its handoff requests, original delivered bundle hash and
delivered ticket revision. A later failed retest records failure and holds
further work without retracting or sending another notice.

## Background preparation and operator selection

The optional `releaseFollowup` member of the existing closed paid profile holds
its separate generator route, explicit evaluation, tokenizer evidence, finite
usage policy and one explicit KB target (or none). Its independent route also
needs the SD05-specific qualification. Existing engineering approval is not
relabelled as follow-up approval. The dedicated versioned operator HMAC key
provider remains separate from the provider API key. The fixed Azure Sweden
endpoint allowlist accepts an explicitly approved `max_completion_tokens` route
and retains `max_tokens` for existing qualified profiles. The exact provided
parameter remains part of the approval hash; the host does not rewrite it or
retry a request with a different alias.

The shared optional OpenRouter adapters bind the actual final Support App,
Knowledge App, Store and Clock. Purpose-specific checker handles use the same
global independent-check pool as learning and engineering. Staff reassessment
binds the original current staff resolver; it does not give Review to a service.
Missing model, funding, key, evaluation or route approval holds paid preparation
while ordinary Support and nonpaid Source actions remain available.

Default background processing opts into the SDK's staged invocation mode.
Planning records an explicit durable `not_called` state. A later one-shot begin
marks a possible provider attempt before transport, records the bounded result
and accounting, and releases it for a later completion stage. Unknown attempts
remain held and cannot authorize another call. Independent checks likewise
separate preparation, one provider attempt and a later fresh receipt phase;
a recorded verdict is not an approval receipt. Staff reassessment remains the
existing inline, original-staff-authorized flow. An injected legacy composition
without staged mode retains its prior behavior.

The host prewrites a bounded body-free Work or check-operation continuation
before every possible paid phase, including a lost planning ACK. It does not
infer a new paid chance from `model_prepared` or an unmarked pending result.
Exhausted advisory hints settle in a separate no-SDK tick; a confirmed
`not_claimed` result can drain its hint in that nonprovider invocation. Current
SDK claims, receipts and live authority remain the sole work authority.

Deferred request cleanup uses the existing inactive-sweep lane and accepted
Source-withdraw hook. Its Store/Clock-only SDK helper requires no paid profile,
provider key, receipt key or model funding. It erases private request payloads
while retaining body-free one-shot intent tombstones.

The existing cleanup cron seeds SD05 on UTC minutes 0, 15, 30 and 45. Existing
engineering/learning cadence is unchanged. One queue invocation performs one
body-free scan or one SDK stage, using a separate durable SD05 cursor. Finite
continuations reuse the original bounded queue delivery; no producer send or
cursor write follows a paid/unknown model outcome. Retained SDK state is
rediscovered after a crash or unknown ACK. Background work prepares drafts,
private KB proposals and retest requests; current staff approval still sends a
web notice, and KB review/publication remains separate.

With the current `0-58 * * * *` cleanup schedule, two idle minute domains cost
8,496 queue operations/day and SD05 adds 288, totaling 8,784 before retries or
other queue traffic. Treating the first two as full minute domains gives a
conservative 8,928. A disabled SD05 worker adds zero queue operations; retention
cleanup uses the existing maintenance invocation. These are scheduling
arithmetic, not a universal Free-tier traffic guarantee.

## Evidence and validation

A real ordinary accepted engineering association must already exist through
approved SDK export/reconciliation. Entering an issue ID cannot create that
authority. The verifier must confirm the issue head, affected product/build/
scope and deployed fix mapping. A release tag, closed issue or green CI job alone
is insufficient. The existing signed [release feed](GITHUB_RELEASE_WEBHOOK_PLAN.md)
supplies hints and public facts, not deployment applicability.

Recorded reopened issues and rollback heads, withdrawn sources and expired
verification hold new updates. External issue or deployment changes require the
explicit mapping update described above. Accepted receipts recover before
mutable proof reads. Reassessment can
edit a retained candidate or bundle; it cannot create a first draft for
draftless work. Unknown paid outcomes stay reserved by the purpose-isolated
[durable usage adapter](../worker/src/support-release-followup-usage.ts).
Posting adds one existing web reply. KB proposals and retests remain private
handoffs for separately authorized workflows.

Real-SDK fixtures cover accepted association, complete bundle approval,
role/session loss during proof, rollback/reopen and lost-ACK recovery. Run the
normal check, test:node and build scripts. The focused physical tests are worker/src/support-release-followup.d1.test.ts
and worker/src/support-release-followup-host.d1.test.ts under vitest.d1.config.ts.
They meter cold Worker.fetch and registered queue invocations, including
authentication, quotas, SDK work and closing checks, with unchanged
50-query/100-parameter guards. The host suite also measures the default shared
generator/checker composition and the real paired report preparation and
consumption separately.
