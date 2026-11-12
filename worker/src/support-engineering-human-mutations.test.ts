import type { AccessContext } from '@pegma/authorization-core';
import type { EngineeringMutationOptions } from '@pegma/support-desk-application';
import { describe, expect, it } from 'vitest';
import { ADMIN_ROLE, SUPPORT_ROLE } from './support-access';
import { createSupportEngineeringRuntime } from './support-engineering';
import { engineeringRepositories } from './support-engineering-fixtures';
import { createSupportEngineeringHttpFixture, engineeringHttpObject, engineeringHttpResult } from './support-engineering-http-fixtures';

type Operation = 'enroll' | 'evidence' | 'repository' | 'invalidate' | 'withdraw' | 'policy' | 'policy/disable';

function barrier() {
  let enter!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const resumed = new Promise<void>((resolve) => { resume = resolve; });
  return { entered, resume, async wait() { enter(); await resumed; } };
}

async function scenario(operation: Operation) {
  const f = await createSupportEngineeringHttpFixture();
  const actor = operation.startsWith('policy') ? 'both' as const : 'staff' as const;
  let body: unknown;
  if (operation === 'enroll') {
    const ticket = await f.legacyTicket();
    body = { commandId: 'LATE-ENROLL-EXACT', expectedRevision: ticket.revision };
  } else if (operation === 'evidence') {
    const ticket = await f.enrolled();
    body = { commandId: 'LATE-EVIDENCE-EXACT', expectedRevision: ticket.revision, security: 'ordinary',
      expectedBehavior: 'The fictional export contains rows.', actualBehavior: 'The fictional export is empty.',
      reproductionSteps: ['Export the fictional workspace.'], visibleMessageIds: ['engineering-question'],
      verificationReference: 'public-late-guard-reproduction' };
  } else if (operation === 'repository') {
    await f.verified(); f.engineering.state.modelRouting = 'ambiguous';
    expect((await f.process()).outcome).toBe('candidate');
    const response = await f.send(f.request('work', undefined, actor, '?sourceGeneration=' + f.key().sourceGeneration));
    expect(response.status).toBe(200);
    const work = engineeringHttpResult(await engineeringHttpObject(response));
    const selection = work.selection;
    if (typeof selection !== 'object' || selection === null || !('repositoryChoices' in selection) ||
      !Array.isArray(selection.repositoryChoices)) throw new Error('Expected actual checked repository choices');
    const choice = selection.repositoryChoices[0];
    body = { commandId: 'LATE-SELECTION-EXACT', sourceGeneration: work.sourceGeneration,
      expectedWorkGeneration: work.workGeneration, repositoryKey: choice.key, repositoryId: choice.repositoryId,
      repositoryDescriptorHash: choice.descriptorHash,
      policyGeneration: 'policyGeneration' in selection ? selection.policyGeneration : undefined,
      policyHash: 'policyHash' in selection ? selection.policyHash : undefined, reason: 'The checked fictional API owns this bug.' };
  } else if (operation === 'policy') {
    body = await f.preparePolicy({ commandId: 'LATE-POLICY-EXACT', expectedGeneration: 1, enabled: true,
      repositoryKeys: [engineeringRepositories[0]!.repositoryId] }, actor);
  } else if (operation === 'policy/disable') {
    body = { commandId: 'LATE-DISABLE-EXACT', expectedGeneration: 1 };
  } else {
    await f.verified();
    body = { commandId: 'LATE-' + operation.toUpperCase() + '-EXACT',
      reason: operation === 'withdraw' ? 'privacy_withdrawal' : 'evidence_revoked' };
  }
  const boundary = barrier();
  const application = f.engineering.application;
  // Instrument only the actual public callback: all SDK validation, reads,
  // receipts, optimistic transactions and results are delegated unchanged.
  function paused<Command, Result>(run: (access: AccessContext, input: Command,
    control?: EngineeringMutationOptions) => Promise<Result>) {
    return (access: AccessContext, input: Command, control?: EngineeringMutationOptions) => run(access, input, {
      ...control, verifyBeforeCommit: async () => {
        await boundary.wait();
        return control?.verifyBeforeCommit?.();
      },
    });
  }
  const guardedApplication = { ...application,
    enrollEngineeringSource: paused(application.enrollEngineeringSource),
    submitEngineeringEvidence: paused(application.submitEngineeringEvidence),
    selectEngineeringRepository: paused(application.selectEngineeringRepository),
    invalidateEngineeringSource: paused(application.invalidateEngineeringSource),
    withdrawEngineeringSource: paused(application.withdrawEngineeringSource),
    putRepositoryPolicy: paused(application.putRepositoryPolicy),
    disableEngineeringExports: paused(application.disableEngineeringExports),
  };
  f.state.runtime = createSupportEngineeringRuntime({ application: guardedApplication, clock: f.engineering.clock,
    staffAccess: { resolve: (id) => f.resolve(id) }, ports: f.engineering.ports, processingEnabled: () => false });
  return { f, actor, body, boundary };
}

describe('actual026 late human engineering mutation guards', () => {
  for (const operation of ['enroll', 'evidence', 'repository', 'invalidate', 'withdraw', 'policy', 'policy/disable'] as const) {
    it.each(['session', 'support-role'] as const)('prevents NEW ' + operation + ' after %s loss at the actual SDK commit callback', async (change) => {
      const { f, actor, body, boundary } = await scenario(operation);
      const sourceBefore = await f.rows(); const policyBefore = await f.policyRows();
      const modelCalls = f.engineering.state.modelCalls;
      const pending = f.send(f.request(operation, body, actor));
      await Promise.race([boundary.entered, pending.then(() => { throw new Error('Expected the actual public late callback'); })]);
      try {
        if (change === 'session') await f.destroy(actor);
        else await f.revoke(actor, SUPPORT_ROLE);
      } finally { boundary.resume(); }
      const response = await pending; expect([401, 403]).toContain(response.status);
      expect(await f.rows()).toEqual(sourceBefore); expect(await f.policyRows()).toEqual(policyBefore);
      expect(f.engineering.state.modelCalls).toBe(modelCalls); expect(f.engineering.state.creates).toEqual([]);
    });
  }

  it.each([ADMIN_ROLE, SUPPORT_ROLE])('rechecks trusted direct callers without a browser callback after %s loss', async (role) => {
    const { f, boundary } = await scenario('policy/disable');
    const access = await f.resolve(f.principals.both);
    if (access === null) throw new Error('Expected current actual Admin + Support authority');
    const before = await f.policyRows();
    const pending = f.state.runtime.disableExports(access, {
      clientCommandId: 'DIRECT-LATE-DISABLE', expectedGeneration: 1,
    });
    await Promise.race([boundary.entered, pending.then(() => { throw new Error('Expected the actual public late callback'); })]);
    try { await f.revoke('both', role); } finally { boundary.resume(); }
    await expect(pending).rejects.toThrow();
    expect(await f.policyRows()).toEqual(before);
    expect(f.engineering.state.modelCalls).toBe(0); expect(f.engineering.state.creates).toEqual([]);
  });

  it.each(['policy', 'policy/disable'] as const)('requires current Admin authority for NEW %s at the same late boundary', async (operation) => {
    const { f, actor, body, boundary } = await scenario(operation);
    const before = await f.policyRows(); const pending = f.send(f.request(operation, body, actor));
    await Promise.race([boundary.entered, pending.then(() => { throw new Error('Expected the actual public late callback'); })]);
    try { await f.revoke(actor, ADMIN_ROLE); } finally { boundary.resume(); }
    expect((await pending).status).toBe(403); expect(await f.policyRows()).toEqual(before);
  });
});
