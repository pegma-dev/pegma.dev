import type { PrincipalId } from '@pegma/spine';
import {
  defineCollection,
  type CollectionStore,
  type EntityKey,
  type StoredRecord,
} from '@pegma/storage-core';
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
 * "Already seeded" is recorded in a host marker collection, not inferred
 * from role state. The role store refuses a second ACTIVE assignment per
 * (principal, role, scope) and cannot enumerate revoked assignments
 * (authorization-core#24), so no assignment-shaped signal survives every
 * case — in particular a listed principal holding `Support` through some
 * other assignment would carry no trace, and revoking that assignment
 * while the env var lingers would silently re-grant on the next touch.
 * The marker is written whenever the seed converges (granted, or nothing
 * to grant), making a later revocation durable in all cases. The grant
 * itself is human-managed despite its system actor: `system:bootstrap`
 * writes once and never touches the assignment again, so it is revocable
 * like any human grant.
 *
 * Delete the env var once the first operator holds the role.
 */

const BOOTSTRAP_MARKER_PARTITION = 'support-bootstrap';

/** Durable "the one-time seed already happened" record for one principal. */
export interface BootstrapMarker {
  readonly principalId: string;
  readonly seededAtEpochMs: number;
  /** Whether the seed granted, or found `Support` already held elsewhere. */
  readonly outcome: 'granted' | 'held_elsewhere';
}

function bootstrapMarkerKey(principalId: string): EntityKey {
  return { partition: BOOTSTRAP_MARKER_PARTITION, id: principalId };
}

function encode(value: BootstrapMarker): StoredRecord {
  return {
    principalId: value.principalId,
    seededAtEpochMs: value.seededAtEpochMs,
    outcome: value.outcome,
  };
}

function decode(record: StoredRecord): BootstrapMarker {
  return {
    principalId:
      typeof record['principalId'] === 'string' ? record['principalId'] : '',
    seededAtEpochMs:
      typeof record['seededAtEpochMs'] === 'number'
        ? record['seededAtEpochMs']
        : 0,
    outcome: record['outcome'] === 'held_elsewhere' ? 'held_elsewhere' : 'granted',
  };
}

/** The host collection holding bootstrap markers (`support-bootstrap.markers.v1`). */
export function bootstrapMarkerCollection() {
  return defineCollection<BootstrapMarker>({
    name: 'support-bootstrap.markers.v1',
    key: (value) => bootstrapMarkerKey(value.principalId),
    codec: { encode, decode },
  });
}

/** The marker store surface the bootstrap needs. */
export type BootstrapMarkerStore = Pick<
  CollectionStore<BootstrapMarker>,
  'get' | 'insertIfAbsent'
>;

/** The role-store surface the bootstrap needs. */
export type BootstrapRoleStore = Pick<
  RoleStore,
  'grantRoleAssignmentWithAudit'
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
 * Order matters: the grant lands BEFORE the marker, so a crash between the
 * two heals on the next touch (the re-grant converges on the deterministic
 * assignment id, then the marker is written), while a marker written ahead
 * of a failed grant would strand the principal unseeded forever.
 *
 * Idempotent and race-tolerant: an existing marker, a replayed grant, or a
 * concurrent seed losing on the assignment-id guard all report `'already'`.
 */
export async function ensureBootstrapSupport(
  roleStore: BootstrapRoleStore,
  markers: BootstrapMarkerStore,
  principalId: PrincipalId,
  bootstrapPrincipals: ReadonlySet<string>,
  nowEpochMs: () => number = () => Date.now(),
): Promise<'granted' | 'already' | 'not_listed'> {
  if (!bootstrapPrincipals.has(principalId)) {
    return 'not_listed';
  }
  if ((await markers.get(bootstrapMarkerKey(principalId))) !== null) {
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
  // 'granted'/'unchanged' seeded the assignment. 'conflict' converged too:
  // on the assignment id (a pre-marker seed already exists, active or
  // revoked) or on the active tuple (`Support` held through another
  // assignment — nothing to grant, but the seed is HANDLED and must leave
  // a trace so revoking that other assignment can't trigger a reseed).
  const heldElsewhere =
    result.status === 'conflict' && result.reason === 'active_tuple';
  await markers.insertIfAbsent({
    principalId,
    seededAtEpochMs: nowEpochMs(),
    outcome: heldElsewhere ? 'held_elsewhere' : 'granted',
  });
  return result.status === 'granted' ? 'granted' : 'already';
}
