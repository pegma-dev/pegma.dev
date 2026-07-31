import type { PrincipalId } from '@pegma/spine';
import { APPLICATION_SCOPE, SUPPORT_ROLE } from './support-access';
import type { RoleStore } from './support-desk';

/**
 * One-time Support-role bootstrap (docs/ROLE_ADOPTION_PLAN.md Phase 3).
 *
 * `PEGMA_SUPPORT_BOOTSTRAP_PRINCIPALS` lists Identity principal ids that
 * receive a REAL audited `Support` assignment on their next authenticated
 * support touch. The env var seeds state; it is never itself an
 * authorization path — every later check reads the role store.
 *
 * "Already seeded" is ANY `Support` assignment record for the principal —
 * active or revoked, whatever its provenance — read first-class via
 * `listRoleAssignments` (authorization-storage 0.3.0, shipped from
 * upstream issue #24; this check previously needed a host marker
 * collection because enumeration was active-only). A deliberately revoked
 * operator therefore stays revoked even while the env var is still
 * configured: history is the durable evidence, and re-listing never
 * re-seeds. The grant is human-managed despite its system actor:
 * `system:bootstrap` writes once and never touches the assignment again,
 * so it is revocable like any human grant.
 *
 * Delete the env var once the first operator holds the role.
 */

/** The role-store surface the bootstrap needs. */
export type BootstrapRoleStore = Pick<
  RoleStore,
  'listRoleAssignments' | 'grantRoleAssignmentWithAudit'
>;

function parsePrincipalList(raw: string | undefined): ReadonlySet<string> {
  if (raw === undefined || raw.trim() === '') {
    return new Set();
  }
  return new Set(
    raw
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );
}

/** Parse the Support bootstrap allowlist (trimmed, empties dropped). */
export function parseBootstrapPrincipals(env: {
  readonly PEGMA_SUPPORT_BOOTSTRAP_PRINCIPALS?: string;
}): ReadonlySet<string> {
  return parsePrincipalList(env.PEGMA_SUPPORT_BOOTSTRAP_PRINCIPALS);
}

/** Parse the Admin bootstrap allowlist (docs/ROLE_ADOPTION_PLAN.md Phase 5). */
export function parseAdminBootstrapPrincipals(env: {
  readonly PEGMA_ADMIN_BOOTSTRAP_PRINCIPALS?: string;
}): ReadonlySet<string> {
  return parsePrincipalList(env.PEGMA_ADMIN_BOOTSTRAP_PRINCIPALS);
}

/** The one bootstrap seed a principal can ever receive. */
export function bootstrapSupportAssignmentId(principalId: PrincipalId): string {
  return `bootstrap-support-${principalId}`;
}

/**
 * Seed the `Support` role for a listed principal, ONCE PER PRINCIPAL, EVER.
 *
 * Idempotent and race-tolerant: existing `Support` history, a replayed
 * grant, or a concurrent seed losing on the deterministic assignment-id
 * guard all report `'already'`.
 */
export async function ensureBootstrapSupport(
  roleStore: BootstrapRoleStore,
  principalId: PrincipalId,
  bootstrapPrincipals: ReadonlySet<string>,
  nowEpochMs: () => number = () => Date.now(),
): Promise<'granted' | 'already' | 'not_listed'> {
  if (!bootstrapPrincipals.has(principalId)) {
    return 'not_listed';
  }
  // Full lifecycle history: any Support record — active OR revoked — means
  // there is nothing for the one-time seed to do.
  const history = await roleStore.listRoleAssignments(
    principalId,
    APPLICATION_SCOPE,
  );
  if (history.some((assignment) => assignment.role === SUPPORT_ROLE)) {
    return 'already';
  }
  const assignmentId = bootstrapSupportAssignmentId(principalId);
  const result = await roleStore.grantRoleAssignmentWithAudit({
    assignment: {
      id: assignmentId,
      principalId,
      role: SUPPORT_ROLE,
      scope: APPLICATION_SCOPE,
      grantedBy: { kind: 'system', systemId: 'bootstrap' },
      grantedAtEpochMs: nowEpochMs(),
      status: 'active',
    },
    // Deterministic like the assignment id: exact replays are 'unchanged'.
    auditEventId: `evt-${assignmentId}`,
  });
  if (result.status === 'granted') {
    return 'granted';
  }
  // 'unchanged' = exact replay; 'conflict' = another request seeded first —
  // converged either way.
  return 'already';
}
