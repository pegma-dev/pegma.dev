import {
  hasPermission,
  resolveAccess,
  type AccessContext,
} from '@pegma/authorization-core';
import type { PolicyDocumentV1 } from '@pegma/authorization-policy';
import type { RoleAssignmentReader } from '@pegma/authorization-storage';
import type { PrincipalId } from '@pegma/spine';
import { supportPermissions } from '@pegma/support-desk-application';

/** Customer permission set for authenticated pegma.dev accounts. */
export const SUPPORT_CUSTOMER_PERMISSIONS = Object.freeze([
  supportPermissions.create,
  supportPermissions.readOwn,
  supportPermissions.replyOwn,
] as const);

/** Staff permission set, granted via the {@link SUPPORT_ROLE} role. */
export const SUPPORT_STAFF_PERMISSIONS = Object.freeze([
  supportPermissions.queueRead,
  supportPermissions.replyAny,
  supportPermissions.note,
  supportPermissions.assign,
  supportPermissions.manage,
  supportPermissions.auditRead,
] as const);

/** The support-operator role name (docs/ROLE_ADOPTION_PLAN.md). */
export const SUPPORT_ROLE = 'Support' as const;

/**
 * The role-administration role name — mapped since the Phase 5 surface
 * shipped; the permissions below are exactly what the admin API checks.
 */
export const ADMIN_ROLE = 'Admin' as const;

/** Admin permission set, granted via the {@link ADMIN_ROLE} role. */
export const ADMIN_PERMISSIONS = Object.freeze([
  'admin.principal.read',
  'admin.role.assign',
  'admin.role.revoke',
  'admin.audit.read',
] as const);

/**
 * The application partition every pegma.dev authorization record belongs
 * to. One value, forever — changing it strands every role assignment.
 */
export const AUTHORIZATION_APPLICATION_ID = 'pegma.dev' as const;

/** The only scope this host uses (no organizations). */
export const APPLICATION_SCOPE = Object.freeze({
  kind: 'application',
} as const);

/**
 * The one host policy (docs/ROLE_ADOPTION_PLAN.md Phase 1),
 * schema-validated in tests with `@pegma/authorization-policy` so drift
 * fails CI.
 *
 * Customer permissions are granted to any authenticated account via
 * `defaults` — not a paid entitlement or invented multi-tenant role (there
 * is no billing ledger on pegma.dev; roles are the only stored grant).
 * Staff permissions are granted via the stored, audited `Support` role,
 * and role administration via the stored, audited `Admin` role — mapped
 * with the Phase 5 surface (version 2 of the document).
 */
export const PEGMA_ACCESS_POLICY: PolicyDocumentV1 = Object.freeze({
  schemaVersion: 1,
  version: 'pegma.dev-policy-2',
  defaults: [...SUPPORT_CUSTOMER_PERMISSIONS],
  roles: Object.freeze({
    [SUPPORT_ROLE]: [...SUPPORT_STAFF_PERMISSIONS],
    [ADMIN_ROLE]: [...ADMIN_PERMISSIONS],
  }),
});

/**
 * The role-store read surface the staff gate needs — matches the object
 * `createRoleStore` from `@pegma/authorization-storage` returns.
 */
export type SupportRoleReader = Pick<
  RoleAssignmentReader,
  'listActiveRoleAssignments'
>;

/**
 * Resolve an AccessContext for an authenticated Identity principal.
 *
 * `principalId` must be the opaque Identity subject / account id from the
 * server-side session (never a browser-supplied claim). Customer
 * permissions come from the unified policy's `defaults`.
 */
export function customerAccessContext(
  principalId: PrincipalId,
): AccessContext {
  return resolveAccess({ principalId }, PEGMA_ACCESS_POLICY);
}

/**
 * Resolve a staff AccessContext from the STORED `Support` role
 * (docs/ROLE_ADOPTION_PLAN.md Phase 2) — the real gate.
 *
 * Re-resolved on every request, uncached: that is what honors the
 * library's 60-second staff-check cache bound; a revocation is effective
 * on the next request. Returns `null` when the resolved context does not
 * grant the queue permission — callers map that to HTTP 403.
 */
export async function staffAccessContextFromRoles(
  principalId: PrincipalId,
  roleStore: SupportRoleReader,
): Promise<AccessContext | null> {
  const assignments = await roleStore.listActiveRoleAssignments(
    principalId,
    APPLICATION_SCOPE,
  );
  const context = resolveAccess(
    { principalId, roles: assignments.map((assignment) => assignment.role) },
    PEGMA_ACCESS_POLICY,
  );
  return hasPermission(context, supportPermissions.queueRead)
    ? context
    : null;
}

