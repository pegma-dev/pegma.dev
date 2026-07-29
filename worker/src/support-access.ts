import { resolveAccess, type AccessContext } from '@pegma/authorization-core';
import type { PrincipalId } from '@pegma/spine';
import { supportPermissions } from '@pegma/support-desk-application';

/**
 * Host policy version for pegma.dev product feedback.
 *
 * Customer permissions are granted to any authenticated account via defaults —
 * not a paid entitlement or invented multi-tenant role.
 */
export const SUPPORT_CUSTOMER_POLICY_VERSION =
  'pegma.dev-support-customer-1' as const;

/** Customer permission set for authenticated pegma.dev accounts. */
export const SUPPORT_CUSTOMER_PERMISSIONS = Object.freeze([
  supportPermissions.create,
  supportPermissions.readOwn,
  supportPermissions.replyOwn,
] as const);

/**
 * Host policy version for pegma.dev Support Desk staff operators.
 *
 * Staff are selected by host env allowlists only — not a full role store.
 */
export const SUPPORT_STAFF_POLICY_VERSION =
  'pegma.dev-support-staff-1' as const;

/** Staff permission set for allowlisted operators. */
export const SUPPORT_STAFF_PERMISSIONS = Object.freeze([
  supportPermissions.queueRead,
  supportPermissions.replyAny,
  supportPermissions.note,
  supportPermissions.assign,
  supportPermissions.manage,
  supportPermissions.auditRead,
] as const);

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
 * server-side session (never a browser-supplied claim).
 */
export function customerAccessContext(
  principalId: PrincipalId,
): AccessContext {
  return resolveAccess(
    { principalId },
    {
      version: SUPPORT_CUSTOMER_POLICY_VERSION,
      defaults: [...SUPPORT_CUSTOMER_PERMISSIONS],
    },
  );
}

/**
 * Resolve staff AccessContext when the principal is on the host allowlist.
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
    { principalId },
    {
      version: SUPPORT_STAFF_POLICY_VERSION,
      defaults: [...SUPPORT_STAFF_PERMISSIONS],
    },
  );
}
