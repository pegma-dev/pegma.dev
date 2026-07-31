import {
  createRoleAdministration,
  ensureSeededAssignment,
  type RoleAdministration,
  type RoleAdministrationStore,
  type RoleHolderIndex,
} from '@pegma/authorization-admin';
import { hasPermission, resolveAccess } from '@pegma/authorization-core';
import type { DurableRateLimiter } from '@pegma/rate-limit';
import type { SessionStore } from '@pegma/sessions';
import type { Logger, PrincipalId } from '@pegma/spine';
import {
  ApiError,
  authenticate,
  enforceRateLimit,
  exactObject,
  json,
  readJson,
  requireCsrf,
  requireSameOriginMutation,
  type Authenticated,
} from './api-auth';
import type {
  IdentityLinkProjector,
  IdentityPort,
} from './identity-contracts';
import {
  ADMIN_ROLE,
  APPLICATION_SCOPE,
  PEGMA_ACCESS_POLICY,
  SUPPORT_ROLE,
} from './support-access';

/**
 * Role-administration API (docs/ROLE_ADOPTION_PLAN.md Phase 5): the host
 * HTTP envelope over `@pegma/authorization-admin`. One admin tool per
 * site — this instance administers pegma.dev only. Every route is gated
 * on a permission the stored `Admin` role grants; the service itself does
 * not re-check callers.
 */

const PRINCIPAL_PATH =
  /^\/api\/admin\/principals\/([A-Za-z0-9._~-]{1,200})(?:\/(roles|history))?$/u;
const ASSIGNMENT_PATH = /^\/api\/admin\/assignments\/([A-Za-z0-9._~-]{1,200})$/u;

/** The only roles the surface may assign; entitlements are not roles. */
const ASSIGNABLE_ROLES: ReadonlySet<string> = Object.freeze(
  new Set<string>([SUPPORT_ROLE, ADMIN_ROLE]),
);

export interface AdminApiOptions {
  readonly sessions: SessionStore;
  readonly identity: IdentityPort;
  readonly identityLinkFromClaims: IdentityLinkProjector;
  readonly logger: Logger;
  /** The audited role store (full surface: reads + audited mutations). */
  readonly roleStore: RoleAdministrationStore;
  /** Host by-role holder index (role-holder-index.ts). */
  readonly holderIndex: RoleHolderIndex;
  /** Durable limiter for role mutations. */
  readonly mutationLimiter: DurableRateLimiter;
  /**
   * One-time Admin bootstrap principals (`PEGMA_ADMIN_BOOTSTRAP_PRINCIPALS`).
   * Delete the var once the first administrator holds the role; the
   * surface reports `bootstrapArmed` while it is set.
   */
  readonly bootstrapPrincipals: ReadonlySet<string>;
}

async function rolesView(
  administration: RoleAdministration,
  principalId: PrincipalId,
) {
  const grants = await administration.viewGrants(
    principalId,
    APPLICATION_SCOPE,
  );
  return grants.map(({ assignment, managedBy }) => ({
    assignmentId: assignment.id,
    role: assignment.role,
    grantedBy: assignment.grantedBy,
    grantedAtEpochMs: assignment.grantedAtEpochMs,
    managedBy,
  }));
}

/** Authenticated pegma.dev role-administration API. */
export function createAdminApi(
  options: AdminApiOptions,
): (request: Request) => Promise<Response> {
  const administration = createRoleAdministration({
    store: options.roleStore,
    holderIndex: options.holderIndex,
    policy: { administratorRole: ADMIN_ROLE },
  });

  async function requireAdminAccess(
    request: Request,
    permission: string,
  ): Promise<Authenticated> {
    const authenticated = await authenticate(request, options);
    if (authenticated === null) {
      throw new ApiError(401, 'authentication_required');
    }
    // One-time Admin bootstrap: an authenticated admin-surface touch by a
    // listed principal seeds the audited grant BEFORE the permission
    // check — the first administrator does not hold the role yet. Fail
    // OPEN: a seed failure must not break the request; it retries on the
    // next touch. Fresh opaque ids per attempt are safe because lifecycle
    // history is the already-seeded signal (`docs/ADMINISTRATION.md`).
    if (
      options.bootstrapPrincipals.size > 0 &&
      options.bootstrapPrincipals.has(authenticated.link.subject)
    ) {
      try {
        const seeded = await ensureSeededAssignment({
          store: options.roleStore,
          holderIndex: options.holderIndex,
          principalId: authenticated.link.subject,
          role: ADMIN_ROLE,
          scope: APPLICATION_SCOPE,
          assignmentId: crypto.randomUUID(),
          auditEventId: crypto.randomUUID(),
        });
        if (seeded === 'granted') {
          options.logger.log('warn', 'admin.bootstrap_admin_seeded', {
            principalId: authenticated.link.subject,
          });
        } else if (seeded === 'conflict') {
          options.logger.log('error', 'admin.bootstrap_admin_conflict', {
            principalId: authenticated.link.subject,
          });
        }
      } catch (error) {
        options.logger.log('warn', 'admin.bootstrap_admin_failed', {
          error: error instanceof Error ? error.name : 'unknown',
        });
      }
    }
    // Re-resolved per request, uncached: a revocation is effective on the
    // caller's next request. Fail closed on store errors — a 503, never a
    // quiet allow or a misleading 403.
    let roles;
    try {
      roles = await options.roleStore.listActiveRoleAssignments(
        authenticated.link.subject,
        APPLICATION_SCOPE,
      );
    } catch (error) {
      options.logger.log('error', 'admin.role_check_failed', {
        error: error instanceof Error ? error.name : 'unknown',
      });
      throw new ApiError(503, 'service_unavailable');
    }
    const context = resolveAccess(
      {
        principalId: authenticated.link.subject,
        roles: roles.map((assignment) => assignment.role),
      },
      PEGMA_ACCESS_POLICY,
    );
    if (!hasPermission(context, permission)) {
      throw new ApiError(403, 'forbidden');
    }
    return authenticated;
  }

  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (request.method === 'GET' && path === '/api/admin/state') {
        const authenticated = await requireAdminAccess(
          request,
          'admin.principal.read',
        );
        return json({
          bootstrapArmed: options.bootstrapPrincipals.size > 0,
          csrfToken: authenticated.csrfToken,
        });
      }

      const principalMatch = PRINCIPAL_PATH.exec(path);
      if (principalMatch !== null) {
        const principalId = principalMatch[1] as PrincipalId;
        const section = principalMatch[2];

        if (request.method === 'GET' && section === undefined) {
          await requireAdminAccess(request, 'admin.principal.read');
          const user = await options.identity.getUser(principalId);
          if (user === null) {
            throw new ApiError(404, 'not_found');
          }
          return json({
            principal: {
              principalId: user.principalId,
              email: user.email,
              status: user.status,
              createdAt: user.createdAt,
            },
            roles: await rolesView(administration, principalId),
          });
        }

        if (request.method === 'GET' && section === 'history') {
          await requireAdminAccess(request, 'admin.audit.read');
          const events = await administration.listHistory(
            principalId,
            APPLICATION_SCOPE,
          );
          return json({ events });
        }

        if (request.method === 'POST' && section === 'roles') {
          requireSameOriginMutation(request);
          const authenticated = await requireAdminAccess(
            request,
            'admin.role.assign',
          );
          await requireCsrf(request, authenticated);
          await enforceRateLimit(
            options.mutationLimiter,
            authenticated.link.subject,
          );
          const body = exactObject(await readJson(request), ['role']);
          const role = body.role;
          if (typeof role !== 'string' || !ASSIGNABLE_ROLES.has(role)) {
            throw new ApiError(400, 'invalid_role');
          }
          // The target must be a real account — an assignment to a typo'd
          // principal would be an unreachable grant.
          if ((await options.identity.getUser(principalId)) === null) {
            throw new ApiError(404, 'not_found');
          }
          const result = await administration.assignRole({
            principalId,
            role,
            scope: APPLICATION_SCOPE,
            actor: {
              kind: 'principal',
              principalId: authenticated.link.subject,
            },
          });
          if (result.status === 'duplicate') {
            throw new ApiError(409, 'duplicate_role');
          }
          if (result.status === 'conflict') {
            throw new ApiError(409, 'conflict');
          }
          return json(
            { roles: await rolesView(administration, principalId) },
            { status: 201 },
          );
        }
      }

      const assignmentMatch = ASSIGNMENT_PATH.exec(path);
      if (assignmentMatch !== null && request.method === 'DELETE') {
        requireSameOriginMutation(request);
        const authenticated = await requireAdminAccess(
          request,
          'admin.role.revoke',
        );
        await requireCsrf(request, authenticated);
        await enforceRateLimit(
          options.mutationLimiter,
          authenticated.link.subject,
        );
        const result = await administration.revokeRole({
          assignmentId: assignmentMatch[1]!,
          actor: {
            kind: 'principal',
            principalId: authenticated.link.subject,
          },
        });
        switch (result.status) {
          case 'revoked':
            if (result.compensated) {
              options.logger.log('warn', 'admin.last_admin_compensated', {
                assignmentId: assignmentMatch[1],
              });
            }
            return json({ revoked: true, compensated: result.compensated });
          case 'not_found':
            throw new ApiError(404, 'not_found');
          case 'already_revoked':
            throw new ApiError(409, 'already_revoked');
          case 'system_managed':
            throw new ApiError(409, 'system_managed');
          case 'last_administrator':
            throw new ApiError(409, 'last_administrator');
          case 'conflict':
            throw new ApiError(409, 'conflict');
        }
      }

      throw new ApiError(404, 'not_found');
    } catch (error) {
      if (error instanceof ApiError) {
        return json(
          { error: error.code },
          {
            status: error.status,
            headers:
              error.retryAfterSeconds === undefined
                ? {}
                : { 'Retry-After': String(error.retryAfterSeconds) },
          },
        );
      }
      options.logger.log('error', 'admin.unhandled_error', {
        error: error instanceof Error ? error.name : 'unknown',
      });
      return json({ error: 'internal_error' }, { status: 500 });
    }
  };
}
