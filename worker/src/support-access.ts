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

/**
 * The operator role name (docs/ROLE_ADOPTION_PLAN.md). An `Admin` role is
 * deliberately NOT mapped yet — it arrives with the Phase 5 management
 * surface; a role nothing checks is a loaded gun.
 */
export const SUPPORT_ROLE = 'Support' as const;

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
 * Staff permissions are granted via the stored, audited `Support` role.
 */
export const PEGMA_ACCESS_POLICY: PolicyDocumentV1 = Object.freeze({
  schemaVersion: 1,
  version: 'pegma.dev-policy-1',
  defaults: [...SUPPORT_CUSTOMER_PERMISSIONS],
  roles: Object.freeze({
    [SUPPORT_ROLE]: [...SUPPORT_STAFF_PERMISSIONS],
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

/** Parsed host allowlists for Support Desk staff operators. */
export interface StaffAllowlist {
  /** Lowercased verified emails. */
  readonly emails: ReadonlySet<string>;
  /** Identity principal / subject ids. */
  readonly principals: ReadonlySet<string>;
}

const EMPTY_STAFF_ALLOWLIST: StaffAllowlist = Object.freeze({
  emails: Object.freeze(new Set<string>()),
  principals: Object.freeze(new Set<string>()),
});

function parseCommaList(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') {
    return [];
  }
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Parse `SUPPORT_STAFF_EMAILS` and `SUPPORT_STAFF_PRINCIPALS` from host env.
 *
 * Emails are lowercased for case-insensitive comparison. Principal ids are
 * kept as-is (trimmed). Empty or missing env → empty allowlist (no staff).
 */
export function parseStaffAllowlist(env: {
  readonly SUPPORT_STAFF_EMAILS?: string;
  readonly SUPPORT_STAFF_PRINCIPALS?: string;
}): StaffAllowlist {
  const emails = new Set(
    parseCommaList(env.SUPPORT_STAFF_EMAILS).map((email) =>
      email.toLowerCase(),
    ),
  );
  const principals = new Set(parseCommaList(env.SUPPORT_STAFF_PRINCIPALS));
  return Object.freeze({
    emails: Object.freeze(emails),
    principals: Object.freeze(principals),
  });
}

/** Empty allowlist for hosts/tests that inject staff later. */
export function emptyStaffAllowlist(): StaffAllowlist {
  return EMPTY_STAFF_ALLOWLIST;
}

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

/**
 * LEGACY staff AccessContext from the host env allowlist — honored beside
 * the role path during the lockout-safe retirement order
 * (docs/ROLE_ADOPTION_PLAN.md Phases 2–4), then deleted whole.
 *
 * A principal is staff only when authenticated **and** (principal id is in
 * `SUPPORT_STAFF_PRINCIPALS` **or** verified user email is in
 * `SUPPORT_STAFF_EMAILS`). Returns `null` when not staff — callers map that
 * to HTTP 403 `forbidden` (not 404).
 */
export function staffAccessContext(
  principalId: PrincipalId,
  allowlist: StaffAllowlist,
  userEmail?: string,
): AccessContext | null {
  const principalAllowed = allowlist.principals.has(principalId);
  const emailAllowed =
    userEmail !== undefined &&
    userEmail.trim() !== '' &&
    allowlist.emails.has(userEmail.trim().toLowerCase());
  if (!principalAllowed && !emailAllowed) {
    return null;
  }
  return resolveAccess(
    { principalId, roles: [SUPPORT_ROLE] },
    PEGMA_ACCESS_POLICY,
  );
}
