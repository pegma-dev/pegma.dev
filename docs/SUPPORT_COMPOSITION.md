# Support Desk composition (pegma.dev)

Public host composition notes for authenticated product feedback on
[pegma.dev](https://pegma.dev). This is the ecosystem's Cloudflare reference
environment for Support Desk customer create / list / read / reply.

## Packages

Exact published versions:

- `@pegma/support-desk-application@0.1.0`
- `@pegma/support-desk-contracts@0.1.0`
- `@pegma/support-desk-core@0.1.0`
- `@pegma/support-desk-templates@0.1.0`
- `@pegma/authorization-core@0.1.2` (AccessContext resolution)

Peers already present on the host: `@pegma/storage-core@0.4.0`,
`@pegma/storage-cloudflare-d1@0.4.0`, `@pegma/sessions@0.1.0`,
`@pegma/rate-limit@0.1.0`, `@pegma/identity@0.1.0`, `@pegma/spine@0.1.1`.

## Storage namespace

Support Desk uses the existing `IDENTITY_DB` D1 binding. Isolation is by
collection name, not by sharing Identity mail cursors or session rows:

| Concern | Collection / host key |
| --- | --- |
| Tickets, messages, audit, commands | `support-desk.records.v1` |
| Customer ticket index | `support-desk.customer-ticket-index.v1` |
| Ticket numbers | `support-desk.ticket-numbers.v1` |
| Queue projection | `support-desk.queue-index.v1` |
| Host maintenance cursors | `pegma-dev-support-maintenance` |

Identity keeps its own collections and `pegma-dev-maintenance` cursors. The
two never share a cursor key.

## Authorization

Any authenticated pegma.dev account receives customer permissions through host
AccessContext defaults (no paid entitlement):

- `support.ticket.create`
- `support.ticket.read.own`
- `support.ticket.reply.own`

`principalId` is the Identity principal / account id from the server-side
session (`__Host-pegma_session`). Browser-supplied identity fields are ignored.

## Categories and markers

Allowlist: `feedback`, `bug`, `feature_request`, `documentation`, `question`.

Display marker: `[PEG-{number}]`. Public tracking URL:

`https://pegma.dev/feedback/{ticketId}`

## HTTP boundary

Worker routes (same-origin session + CSRF `X-Pegma-CSRF`):

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/support/categories` | Auth required |
| `GET` | `/api/support/tickets` | List own tickets |
| `POST` | `/api/support/tickets` | Create (rate-limited) |
| `GET` | `/api/support/tickets/:id` | Read own; missing/non-owned → same 404 |
| `POST` | `/api/support/tickets/:id/replies` | Reply (rate-limited) |

Durable rate-limit policies (separate from Identity):

- `pegma.support.ticket.create`
- `pegma.support.ticket.reply`

Site pages: `/feedback` (create + list), `/feedback/[ticketId]` (read + reply).

## Maintenance and health

Minute cron runs Support Desk queue repair and inactive projection sweep with
independent cursors, plus Support Desk rate-limit sweeps. Mail send for support
notifications is deferred (templates are defined; create/reply omit
notification for this first host PR).

Health always reports Support Desk package detail without message content. A
store probe runs only when `SUPPORT_HEALTH_PROBE` is exactly `"true"`.

## Privacy and retention intent

- Tickets are private conversations between the authenticated requester and
  authorized operators.
- Feedback is not automatically published to the roadmap, documentation, or
  GitHub Issues.
- Staff UI is deferred.
- Queue projection terminal retention follows Support Desk's default
  (30 days) for inactive projection rows; authoritative ticket retention and
  export/redaction procedures remain host operational policy and will be
  documented further before accepting production-sensitive data at scale.

Built in the open by RetireGolden, LLC.
