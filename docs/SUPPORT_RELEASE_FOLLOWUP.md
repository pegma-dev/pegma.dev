# Staff release-follow-up controls

This source slice connects optional Support SDK follow-up methods to the
registered Worker and staff ticket panel. The default Worker supplies no trusted
follow-up composition. Its routes return 404 before opening the database. It
adds no scheduled trigger, automatic notification, remote issue mutation or KB
publication.

This isolated source selects all five qualified public Support 0.2.8 packages
and all four public KB 0.1.6 packages. The follow-up mutations pass the original
browser's fresh authority and synchronous closing assertion through the released
late-guard options. The [0.2.8 publication receipt](https://github.com/pegma-dev/support-desk/releases/tag/v0.2.8)
binds the registry packages and their signature, provenance and clean-consumer
qualification.

The trusted composition remains absent from the default Worker. Current public
graph Node and physical invocation results are recorded separately from earlier
private development runs. Reconciliation onto the current host branch, complete
normal gates and the unchanged 50-query/100-parameter Native profile remain
pending. Live deployment, provider, CPU and Workers Free acceptance remain open.

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

Policy version 7 gives the stored Support role engineeringFollowupRead,
engineeringFollowupReview and engineeringFollowupEvidenceSubmit, alongside its
existing queue and reply authority. Admin or Knowledge alone receives no
follow-up authority. Processing uses a separate current service principal.
Work hints contain no saved browser credentials or AccessContext.

HTTP controls reuse Identity, Sessions, audited roles and the existing
engineering read/control quotas. They require the original current cookie
session and actor. Mutations require dynamic X-Pegma-CSRF, same-origin headers
and a total ten-second JSON-read deadline. Each mutation reaches the SDK's late
current-authority guard and synchronous closing fence. A closing guard can
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
operation, ticket and command. Mutation responses contain result, commandId,
operation and the current csrfToken. The SDK owns exact fingerprints, accepted
receipts, generations, semantic identities and conditional commits. Private
views expose selected metadata and candidate/checked content, while claim
identities, provider metadata and private check receipts stay server-side.

The panel displays complete retained content before explicit posting. Its
buttons are independent of new-draft form validation. Sent commands remain in
memory with their original actor, operation and byte-identical body. Unknown
responses block other writes. Restore the original account and current ticket
view, then use **Retry the exact previous command**. Another actor cannot view
or replay the retained packet. Keep the original tab open until confirmation.

## Evidence and remaining integration

A real ordinary accepted engineering association must already exist through
approved SDK export/reconciliation. Entering an issue ID cannot create that
authority. The verifier must confirm the issue head, affected product/build/
scope and deployed fix mapping. A release tag, closed issue or green CI job alone
is insufficient. The existing signed [release feed](GITHUB_RELEASE_WEBHOOK_PLAN.md)
supplies hints and public facts, not deployment applicability.

Reopened issues, rollback heads, withdrawn sources and stale proof hold new
updates. Accepted receipts recover before mutable proof reads. Reassessment can
edit a retained candidate or bundle; it cannot create a first draft for
draftless work. Unknown paid outcomes stay reserved by the purpose-isolated
[durable usage adapter](../worker/src/support-release-followup-usage.ts).
Posting adds one existing web reply. KB proposals and retests remain private
handoffs for separately authorized workflows.

Real-SDK fixtures cover accepted association, complete bundle approval,
role/session loss during proof, rollback/reopen and lost-ACK recovery. Run the
normal check, test:node and build scripts. The focused physical test is
worker/src/support-release-followup.d1.test.ts under vitest.d1.config.ts.
It meters the entire cold Worker.fetch invocation, including authentication,
quotas, SDK work and closing checks, with unchanged 50-query/100-parameter guards.
