import { resolveAccess } from '@pegma/authorization-core';
import { createRoleStore } from '@pegma/authorization-storage';
import type { PrincipalId } from '@pegma/spine';
import { createMemoryStore } from '@pegma/storage-core';
import { supportPermissions } from '@pegma/support-desk-application';
import { knowledgePermissions } from '@pegma/knowledge-base-contracts';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_ROLE,
  AGENT_KNOWLEDGE_PERMISSIONS,
  APPLICATION_SCOPE,
  AUTHORIZATION_APPLICATION_ID,
  customerAccessContext,
  KNOWLEDGE_ROLE,
  PEGMA_ACCESS_POLICY,
  staffAccessContextFromRoles,
  SUPPORT_ROLE,
} from './support-access';

const operator = 'synthetic-support-operator' as PrincipalId;
const customer = 'synthetic-support-customer' as PrincipalId;
const customerPermissions = [
  supportPermissions.create,
  supportPermissions.readOwn,
  supportPermissions.replyOwn,
  supportPermissions.requestPerson,
];
const staffPermissions = [
  supportPermissions.queueRead,
  supportPermissions.replyAny,
  supportPermissions.note,
  supportPermissions.assign,
  supportPermissions.manage,
  supportPermissions.auditRead,
  supportPermissions.takeOver,
  supportPermissions.learningRead,
  supportPermissions.learningEvidenceSubmit,
  supportPermissions.learningReview,
  supportPermissions.learningWithdraw,
];

function roleStore() {
  return createRoleStore(createMemoryStore(), AUTHORIZATION_APPLICATION_ID);
}

async function grantRole(
  store: ReturnType<typeof roleStore>,
  role: typeof ADMIN_ROLE | typeof KNOWLEDGE_ROLE | typeof SUPPORT_ROLE,
) {
  const result = await store.grantRoleAssignmentWithAudit({
    assignment: {
      id: `synthetic-${role}`,
      principalId: operator,
      role,
      scope: APPLICATION_SCOPE,
      grantedBy: { kind: 'system', systemId: 'public-support-fixture' },
      grantedAtEpochMs: Date.parse('2026-11-09T12:00:00.000Z'),
      status: 'active',
    },
    auditEventId: `synthetic-grant-${role}`,
  });
  expect(result.status).toBe('granted');
}

describe('Support human-control grants', () => {
  it('gives authenticated customers owned human requests without staff authority', () => {
    const access = customerAccessContext(customer);
    expect(access.principalId).toBe(customer);
    expect(access.roles).toEqual([]);
    expect(access.entitlements).toEqual([]);
    expect(
      access.permissions
        .filter((permission) => permission.startsWith('support.'))
        .sort(),
    ).toEqual([...customerPermissions].sort());
  });

  it.each([
    { label: 'Admin', roles: [ADMIN_ROLE] },
    { label: 'Knowledge', roles: [KNOWLEDGE_ROLE] },
    { label: 'Admin and Knowledge', roles: [ADMIN_ROLE, KNOWLEDGE_ROLE] },
  ] as const)(
    'requires an explicit Support grant alongside $label, and observes its revocation',
    async ({ roles }) => {
      const store = roleStore();
      for (const role of roles) await grantRole(store, role);

      const assignments = await store.listActiveRoleAssignments(
        operator,
        APPLICATION_SCOPE,
      );
      const access = resolveAccess(
        {
          principalId: operator,
          roles: assignments.map((assignment) => assignment.role),
        },
        PEGMA_ACCESS_POLICY,
      );
      expect(access.permissions).not.toContain(supportPermissions.queueRead);
      expect(access.permissions).not.toContain(supportPermissions.takeOver);
      for (const permission of [supportPermissions.learningRead, supportPermissions.learningEvidenceSubmit,
        supportPermissions.learningReview, supportPermissions.learningWithdraw, supportPermissions.learningProcess]) {
        expect(access.permissions).not.toContain(permission);
      }
      expect(await staffAccessContextFromRoles(operator, store)).toBeNull();

      await grantRole(store, SUPPORT_ROLE);
      const staff = await staffAccessContextFromRoles(operator, store);
      expect(staff).not.toBeNull();
      expect(
        staff?.permissions
          .filter((permission) => permission.startsWith('support.'))
          .sort(),
      ).toEqual([...customerPermissions, ...staffPermissions].sort());
      expect(staff?.permissions).not.toContain(supportPermissions.learningProcess);

      const current = await store.getRoleAssignment(
        `synthetic-${SUPPORT_ROLE}`,
      );
      expect(current).not.toBeNull();
      const revoked = await store.revokeRoleAssignmentWithAudit({
        assignmentId: `synthetic-${SUPPORT_ROLE}`,
        expectedConcurrencyToken: current!.concurrencyToken,
        revokedBy: { kind: 'system', systemId: 'public-support-fixture' },
        revokedAtEpochMs: Date.parse('2026-11-09T12:01:00.000Z'),
        auditEventId: 'synthetic-revoke-Support',
      });
      expect(revoked.status).toBe('revoked');
      expect(await staffAccessContextFromRoles(operator, store)).toBeNull();
      expect(
        (await store.listActiveRoleAssignments(operator, APPLICATION_SCOPE))
          .map((assignment) => assignment.role)
          .sort(),
      ).toEqual([...roles].sort());
      expect(customerAccessContext(operator).permissions).toContain(
        supportPermissions.requestPerson,
      );
    },
  );

  it('keeps human learning separate from KB powers and the exact three delegated client scopes', async () => {
    const store = roleStore();
    await grantRole(store, SUPPORT_ROLE);
    const staff = await staffAccessContextFromRoles(operator, store);
    expect(staff).not.toBeNull();
    for (const permission of [knowledgePermissions.draftRead, knowledgePermissions.draftWrite,
      knowledgePermissions.evidenceSubmit, knowledgePermissions.provenanceRead, knowledgePermissions.review,
      knowledgePermissions.publish, supportPermissions.learningProcess]) {
      expect(staff?.permissions).not.toContain(permission);
    }
    expect([...AGENT_KNOWLEDGE_PERMISSIONS]).toEqual([
      knowledgePermissions.draftRead, knowledgePermissions.draftWrite, knowledgePermissions.evidenceSubmit,
    ]);
    for (const permission of [supportPermissions.learningRead, supportPermissions.learningEvidenceSubmit,
      supportPermissions.learningReview, supportPermissions.learningWithdraw, supportPermissions.learningProcess]) {
      expect(AGENT_KNOWLEDGE_PERMISSIONS).not.toContain(permission);
    }
  });
});
