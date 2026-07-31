import type { RoleHolderIndex } from '@pegma/authorization-admin';
import {
  defineCollection,
  type EntityKey,
  type Store,
  type StoredRecord,
} from '@pegma/storage-core';

/**
 * Host implementation of `@pegma/authorization-admin`'s holder-index port
 * (the `docs/STORAGE.md` superset-with-verification recipe): rows are
 * written BEFORE grants, never deleted, and every reader verifies
 * candidates against the authoritative role store — a dangling row from a
 * crashed or refused grant is harmless noise. The index may over-report;
 * it must never under-report a grant that exists, which is what lets the
 * last-administrator guard fail only in the safe direction.
 */

const HOLDER_PARTITION_PREFIX = 'role|';

interface HolderRow {
  readonly role: string;
  readonly principalId: string;
  readonly assignmentId: string;
}

function holderKey(row: HolderRow): EntityKey {
  return {
    partition: `${HOLDER_PARTITION_PREFIX}${row.role}`,
    id: row.assignmentId,
  };
}

function encode(value: HolderRow): StoredRecord {
  return {
    role: value.role,
    principalId: value.principalId,
    assignmentId: value.assignmentId,
  };
}

function decode(record: StoredRecord): HolderRow {
  return {
    role: typeof record['role'] === 'string' ? record['role'] : '',
    principalId:
      typeof record['principalId'] === 'string' ? record['principalId'] : '',
    assignmentId:
      typeof record['assignmentId'] === 'string' ? record['assignmentId'] : '',
  };
}

/** The by-role holder rows (`role-holder-index.v1`). */
export function roleHolderIndexCollection() {
  return defineCollection<HolderRow>({
    name: 'role-holder-index.v1',
    key: holderKey,
    codec: { encode, decode },
  });
}

/** Bind the holder-index port over the host's shared Store. */
export function createRoleHolderIndex(store: Store): RoleHolderIndex {
  const rows = store.collection(roleHolderIndexCollection());
  return Object.freeze({
    async record(row) {
      await rows.put({
        role: row.role,
        principalId: row.principalId,
        assignmentId: row.assignmentId,
      });
    },
    async listByRole(role) {
      const stored = await rows.list(`${HOLDER_PARTITION_PREFIX}${role}`);
      return stored.map((row) => ({
        role: row.role,
        principalId: row.principalId,
        assignmentId: row.assignmentId,
      }));
    },
  } satisfies RoleHolderIndex);
}
