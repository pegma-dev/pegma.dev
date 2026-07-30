# Adopting the Authorization Core role store on pegma.dev

Status: **PLANNED.** pegma.dev is the ecosystem's second host to need stored,
audited roles — the first, retiregolden.org, completed its adoption on
2026-07-29 (its plan and execution ledger:
[`docs/pegma-authorization-migration.md`](https://github.com/RetireGolden/retiregolden.org/blob/main/docs/pegma-authorization-migration.md)
and
[`docs/account-preview/admin-panel.md`](https://github.com/RetireGolden/retiregolden.org/blob/main/docs/account-preview/admin-panel.md)).
This plan is deliberately smaller than that one: pegma.dev has no billing
ledger, no derived entitlements, and no frozen offline wire contract — only
one thing to fix, the staff env allowlist.

**Nothing is copied from retiregolden.org.** Shared capability arrives as a
published package or not at all (the rule both hosts follow); until the
shared admin surface exists (Phase 5, gated), pegma.dev composes the same
published packages against its own store with its own thin host code.

## What exists today

- Support Desk staff access is a **host env allowlist**
  (`SUPPORT_STAFF_EMAILS` / `SUPPORT_STAFF_PRINCIPALS` — see
  [`SUPPORT_COMPOSITION.md`](SUPPORT_COMPOSITION.md)), which its own comment
  calls out as "not a full role store".
- The worker already composes `@pegma/identity`, `@pegma/sessions`,
  `@pegma/rate-limit`, and `@pegma/authorization-identity` over one
  `@pegma/storage-cloudflare-d1` `Store` (`worker/src/identity-runtime.ts`).
  `principalId` is already the Identity account id from the server-side
  session — exactly the principal the role store expects.
- `worker/src/support-access.ts` already resolves AccessContexts through
  `resolveAccess` from `@pegma/authorization-core`.

Missing: `@pegma/authorization-storage` (the role store), a host policy with
a `Support` role, and the staff gate reading it.

## Phase 1 — policy + role store binding

- [ ] Add `@pegma/authorization-storage` (exact pin, same 0.x line as the
      packages already composed).
- [ ] One host policy document (schema-validated in a test with
      `@pegma/authorization-policy`, the way retiregolden.org pins its
      `rg-policy-v1`): customer support permissions stay granted via
      `defaults` to any authenticated account (unchanged semantics), and a
      `Support` role maps to the six staff permissions. Define an `Admin`
      role name in the policy prose now, but map it only when Phase 5's
      surface exists to consume it — a role nothing checks is a loaded gun.
- [ ] Bind `createRoleStore(store, 'pegma.dev')` at the worker composition
      root, over the SAME D1-backed `Store` the other components share. The
      application id is one value, forever — changing it strands every
      assignment.

## Phase 2 — the staff gate reads roles (allowlist becomes legacy)

The lockout-safe order proven on retiregolden.org, transplanted:

- [ ] Staff access resolves the full context (stored roles + policy) **per
      request, uncached** — that is what honors the library's 60-second
      staff-check cache bound; a revocation is effective on the next request.
- [ ] Gate = role **or** legacy allowlist, both honored; a role-store
      failure falls through to the allowlist while the legacy path exists
      (it stays authoritative until deleted).

## Phase 3 — first-operator seed

- [ ] `PEGMA_SUPPORT_BOOTSTRAP_PRINCIPALS` (comma-separated Identity
      principal ids): on an authorization touch, a listed principal lacking
      the grant receives a REAL audited `Support` assignment with actor
      `system:bootstrap`. Two properties are load-bearing, both learned the
      hard way on the reference host:
      - **Deterministic assignment id** (`bootstrap-support-<principalId>`):
        the assignment record — active OR revoked — is the durable "already
        seeded" marker, so a deliberately revoked operator stays revoked
        even while the env var is still configured. Never seed twice.
      - **Human-managed despite the system actor**: `system:bootstrap`
        writes once and never touches the assignment again, so it is
        revocable like any human grant.
- [ ] Delete the env var after the first operator holds the role. It seeds
      state; it is never itself an authorization path.

## Phase 4 — retire the allowlist

- [ ] Delete the allowlist path whole (`SUPPORT_STAFF_EMAILS` /
      `SUPPORT_STAFF_PRINCIPALS` parsing and the legacy staff context) — it
      must not survive as a quiet second gate. After this, a role-store
      failure is a controlled **503, fail closed, no fallback**.
- [ ] Delete the env vars from the Worker configuration and update
      `SUPPORT_COMPOSITION.md`'s staff section to role-only.

## Phase 5 — the shared admin surface (GATED)

Both hosts now want the same role-management surface (lookup → grants view →
audited assign/revoke → history). Per the ecosystem's
extract-on-second-consumer rule this is the extraction trigger — but it is
**gated on upstream first**:
[authorization-core#23](https://github.com/pegma-dev/authorization-core/issues/23)
(identity-link writes) and
[authorization-core#24](https://github.com/pegma-dev/authorization-core/issues/24)
(per-principal/by-role assignment enumeration) decide how much of
retiregolden.org's host-side index the shared component would otherwise have
to carry. Extracting before those decisions would bake a workaround into a
public package right as the library makes it unnecessary.

When the gate clears, Phase 5 activates in this order — the `Admin` mapping
and its bootstrap are PART OF this phase, because a surface gated on a role
nobody holds and nothing grants is unreachable by construction:

1. Map the `Admin` role in the policy (the name already exists in prose from
   Phase 1) to the surface's permission set.
2. One-time Admin bootstrap, identical in shape to Phase 3's Support seed:
   `PEGMA_ADMIN_BOOTSTRAP_PRINCIPALS`, a REAL audited assignment with actor
   `system:bootstrap`, a **deterministic assignment id**
   (`bootstrap-admin-<principalId>`) so revocation stays durable while the
   var lingers, human-managed after the write. Delete the var once the
   first admin exists; the surface shows a standing warning while it is set.
3. Only then does the surface ship gated on `Admin` — with the last-admin
   guard meaningful from its first request, because an admin exists.

Recorded for that extraction (from the reference host's build):

- Generic: grants-model rendering (management policy: ongoing system actors
  lock; one-time system writes and human grants stay editable), audited
  assign/revoke flows, the last-admin guard — which MUST carry its
  concurrency treatment (serialize revocations in-process; re-verify after
  an admin-role revocation commits and compensate if none remain; the naive
  check-then-act version has a real TOCTOU that review caught upstream).
- Host-specific, per site forever: principal lookup (first-party Identity
  here, Auth0 there), any entitlement display (none here), the HTTP
  envelope, page chrome. **One admin tool per site** — shared package,
  separate instances, nothing crossing between hosts.

## Non-goals

Cross-site administration or any shared control plane with retiregolden.org;
copying host code between the two repos; a paid-tier/entitlement concept on
pegma.dev (there is no billing ledger — roles are the only stored grant
here); an `Admin` role before a surface exists that checks it.
