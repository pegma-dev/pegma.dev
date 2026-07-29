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
