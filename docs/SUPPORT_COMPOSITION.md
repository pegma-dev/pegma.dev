# Support Desk composition (pegma.dev)

Public host composition notes for authenticated product feedback on
[pegma.dev](https://pegma.dev). This is the ecosystem's Cloudflare reference
environment for Support Desk customer create / list / read / reply and a small
staff operator surface over the same application services.

## Packages

Exact published versions:

- `@pegma/support-desk-application@0.1.0`
- `@pegma/support-desk-contracts@0.1.0`
- `@pegma/support-desk-core@0.1.0`
- `@pegma/support-desk-templates@0.1.0`
- `@pegma/authorization-core@0.2.0` (AccessContext resolution)
- `@pegma/authorization-policy@0.2.0` (PolicyDocumentV1 schema validation)
- `@pegma/authorization-storage@0.2.0` (D1-backed role store)

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
| Bootstrap-seed markers | `support-bootstrap.markers.v1` |

Identity keeps its own collections and `pegma-dev-maintenance` cursors. The
two never share a cursor key.

## Authorization

### Customer

Any authenticated pegma.dev account receives customer permissions through the
unified host policy's `defaults` (no paid entitlement):

- `support.ticket.create`
- `support.ticket.read.own`
- `support.ticket.reply.own`

Policy version: `pegma.dev-policy-1` — one `PolicyDocumentV1` for the whole
host, schema-validated in tests (see `docs/ROLE_ADOPTION_PLAN.md`).

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

**Bootstrap (one-time seeding).** `PEGMA_SUPPORT_BOOTSTRAP_PRINCIPALS`
(comma-separated Identity principal ids) seeds a real audited `Support`
assignment (actor `system:bootstrap`, deterministic assignment id
`bootstrap-support-<principalId>`) on a listed principal's next authenticated
support request. Each principal is seeded at most once, ever: the handled
seed is recorded in the `support-bootstrap.markers.v1` collection — even when
nothing was granted because `Support` was already held through another
assignment — so a later revocation stays revoked while the env var lingers.
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

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/support/categories` | Auth required |
| `GET` | `/api/support/tickets` | List own tickets |
| `POST` | `/api/support/tickets` | Create (rate-limited) |
| `GET` | `/api/support/tickets/:id` | Read own; missing/non-owned → same 404 |
| `POST` | `/api/support/tickets/:id/replies` | Reply (rate-limited) |

### Staff (`/api/support/admin/…`)

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/support/admin/queue` | `listStaffQueue`; query: `status`, `priority`, `sort` (`updated_newest` / `updated_oldest`), `unassignedOnly` |
| `GET` | `/api/support/admin/tickets/:id` | `readStaffTicket` (includes requester email when present, internal notes) |
| `POST` | `/api/support/admin/tickets/:id/messages` | Public staff reply → `replyAsStaff` body `{ body }` (rate-limited) |
| `POST` | `/api/support/admin/tickets/:id/notes` | Internal note → `addNote` body `{ body }` (rate-limited) |
| `PATCH` | `/api/support/admin/tickets/:id` | Lifecycle / assign / priority |

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
- Command, correlation, and message IDs are server-minted.

**Compose modes are distinct endpoints.** Public replies use `/messages`;
internal notes use `/notes`. The staff UI requires an explicit mode selection
with no default and styles the two modes differently. Mail / outbound
notification is still deferred (Task 10) — staff reply omits `notification`
like customer create/reply.

Durable rate-limit policies (separate from Identity):

- `pegma.support.ticket.create`
- `pegma.support.ticket.reply` (customer replies and staff message/note posts)

## Site pages

| URL | Audience |
| --- | --- |
| `/feedback` | Customer create + list |
| `/feedback/ticket/?id=…` | Customer read + reply |
| `/staff/support` | Staff queue (Support role holders) |
| `/staff/support/ticket/?id=…` | Staff ticket detail, compose, lifecycle |

## Maintenance and health

Minute cron runs Support Desk queue repair and inactive projection sweep with
independent cursors, plus Support Desk rate-limit sweeps. Mail send for support
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
