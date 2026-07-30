import type { InMemoryStorageAdapter } from '@pegma/authorization-storage';
import type { PrincipalId } from '@pegma/spine';
import {
  APPLICATION_SCOPE,
  SUPPORT_ROLE,
} from './support-access';

/**
 * One-time Support-role bootstrap (docs/ROLE_ADOPTION_PLAN.md Phase 3).
 *
 * `PEGMA_SUPPORT_BOOTSTRAP_PRINCIPALS` lists Identity principal ids that
 * receive a REAL audited `Support` assignment on their next authenticated
 * support touch. The env var seeds state; it is never itself an
 * authorization path — every later check reads the role store.
 *
 * Two properties are load-bearing (both learned on the reference host):
 *
 * - The assignment id is DETERMINISTIC (`bootstrap-support-<principalId>`),
 *   so the assignment record — active OR revoked — is the durable
 *   "already seeded" marker. A deliberately revoked operator stays revoked
 *   even while the env var is still configured; re-listing never re-seeds.
 * - The seed is human-managed despite its system actor: `system:bootstrap`
 *   writes once and never touches the assignment again, so it is revocable
 *   like any human grant.
 *
 * Delete the env var once the first operator holds the role.
 */

/** The role-store surface the bootstrap needs. */
export type BootstrapRoleStore = Pick<
  InMemoryStorageAdapter,
  'getRoleAssignment' | 'listActiveRoleAssignments' | 'grantRoleAssignmentWithAudit'
>;

/** Parse the bootstrap principal allowlist (trimmed, empties dropped). */
export function parseBootstrapPrincipals(env: {
  readonly PEGMA_SUPPORT_BOOTSTRAP_PRINCIPALS?: string;
}): ReadonlySet<string> {
  const raw = env.PEGMA_SUPPORT_BOOTSTRAP_PRINCIPALS;
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

/** The one bootstrap seed a principal can ever receive. */
export function bootstrapSupportAssignmentId(principalId: PrincipalId): string {
  return `bootstrap-support-${principalId}`;
}

/**
 * Seed the `Support` role for a listed principal, ONCE PER PRINCIPAL, EVER.
 *
 * Idempotent and race-tolerant: an existing record under the deterministic
 * id (any lifecycle state) or a concurrent seed losing on the assignment-id
 * guard both report `'already'`.
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
  const assignmentId = bootstrapSupportAssignmentId(principalId);
  // Active or revoked, an existing record means the one-time seed already
  // happened — never seed twice, so revocation is durable.
  if ((await roleStore.getRoleAssignment(assignmentId)) !== null) {
    return 'already';
  }
  // A Support role granted some other way also means nothing to bootstrap.
  const active = await roleStore.listActiveRoleAssignments(
    principalId,
    APPLICATION_SCOPE,
  );
  if (active.some((assignment) => assignment.role === SUPPORT_ROLE)) {
    return 'already';
  }
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
