import {
  hasPermission,
  resolveAccess,
  type AccessContext,
} from '@pegma/authorization-core';
import type { BrowserApprovalContext } from '@pegma/agent-access';
import type { PrincipalId } from '@pegma/spine';
import {
  ApiError,
  authenticate,
  requireCsrf,
  requireSameOriginMutation,
  type Authenticated,
  type AuthenticationOptions,
} from './api-auth';
import { IDENTITY_ISSUER } from './identity-api';
import type { IdentityLinkProjector, IdentityPort } from './identity-contracts';
import {
  AGENT_LINK_PERMISSION,
  APPLICATION_SCOPE,
  PEGMA_ACCESS_POLICY,
  type SupportRoleReader,
} from './support-access';

export interface AgentAuthorityOptions {
  readonly identity: IdentityPort;
  readonly identityLinkFromClaims: IdentityLinkProjector;
  readonly roleStore: SupportRoleReader;
}
export interface AgentBrowserOptions
  extends AuthenticationOptions, AgentAuthorityOptions {}

/** Current account and stored roles, with no session-era grants or bootstrap writes. */
export function createAgentPrincipalResolver(
  options: AgentAuthorityOptions,
): (principalId: PrincipalId) => Promise<AccessContext | null> {
  return async (principalId) => {
    const assignments = await options.roleStore.listActiveRoleAssignments(
      principalId,
      APPLICATION_SCOPE,
    );
    // Published Identity claimsFor requires an active, verified current user.
    // Keep that account observation after the awaited stored-role lookup.
    let claims;
    try {
      claims = await options.identity.claimsFor(principalId);
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? error.code
          : undefined;
      if (code === 'not_found' || code === 'invalid_state') return null;
      throw error;
    }
    let link;
    try {
      link = options.identityLinkFromClaims(claims);
    } catch {
      return null;
    }
    if (
      claims.issuer !== IDENTITY_ISSUER ||
      claims.subject !== principalId ||
      claims.emailVerified !== true ||
      link.issuer !== IDENTITY_ISSUER ||
      link.subject !== principalId
    )
      return null;
    return resolveAccess(
      { principalId, roles: assignments.map((assignment) => assignment.role) },
      PEGMA_ACCESS_POLICY,
    );
  };
}

/** Browser-only host authority; never accepts an agent credential as staff consent. */
export async function requireCurrentBrowserAccess(
  request: Request,
  options: AgentBrowserOptions,
  permission: string,
  mutation = false,
): Promise<{
  readonly authenticated: Authenticated;
  readonly access: AccessContext;
}> {
  if (new URL(request.url).origin !== IDENTITY_ISSUER)
    throw new ApiError(403, 'cross_origin_denied');
  if (request.headers.has('Authorization'))
    throw new ApiError(403, 'browser_session_required');
  if (mutation) requireSameOriginMutation(request);
  const authenticated = await authenticate(request, options);
  if (authenticated === null)
    throw new ApiError(401, 'authentication_required');
  if (mutation) await requireCsrf(request, authenticated);
  const access = await createAgentPrincipalResolver(options)(
    authenticated.link.subject,
  );
  if (access === null) throw new ApiError(401, 'authentication_required');
  if (!hasPermission(access, permission)) throw new ApiError(403, 'forbidden');
  return { authenticated, access };
}

export async function requireAgentBrowserContext(
  request: Request,
  options: AgentBrowserOptions,
  mutation = false,
): Promise<{
  readonly authenticated: Authenticated;
  readonly context: BrowserApprovalContext;
}> {
  const { authenticated, access } = await requireCurrentBrowserAccess(
    request,
    options,
    AGENT_LINK_PERMISSION,
    mutation,
  );
  return {
    authenticated,
    context: { authentication: 'browser-session', access },
  };
}
