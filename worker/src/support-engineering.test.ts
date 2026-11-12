import { createMemoryStore } from '@pegma/storage-core';
import { createSupportDeskApplication, SupportDeskAuthorizationError, supportPermissions } from '@pegma/support-desk-application';
import { describe, expect, it, vi } from 'vitest';
import { createSupportEngineeringRuntime, SupportEngineeringUnavailableError, supportEngineeringApplicationOptions } from './support-engineering';
import { supportEngineeringCommandIdentity } from './support-engineering-ports';
import {
  createSupportEngineeringFixture, engineeringCanary, engineeringProofReference,
  engineeringRepositories, engineeringTicketId, type SupportEngineeringFixture,
} from './support-engineering-fixtures';

function fixture(options?: Parameters<typeof createSupportEngineeringFixture>[1]) {
  return createSupportEngineeringFixture(createMemoryStore(), options);
}

async function reviewHints(f: SupportEngineeringFixture, restricted: boolean) {
  const sources = new Set<string>();
  const work: { ticketId: string; sourceGeneration: number }[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 64; page += 1) {
    const result = await f.runtime.scanReview(restricted ? f.actors.security : f.actors.staff,
      { limit: 2, ...(cursor === undefined ? {} : { cursor }) });
    expect(result.physicalRows).toBeLessThanOrEqual(2);
    expect(result.pages).toBe(1);
    expect(result.candidates).toEqual([]);
    result.reviewSources.forEach((id) => sources.add(id));
    work.push(...result.reviewCandidates);
    if (result.nextCursor === null) return { sources: [...sources], work };
    cursor = result.nextCursor;
  }
  throw new Error('Synthetic engineering scan did not terminate');
}

function barrier() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const resumed = new Promise<void>((resolve) => { release = resolve; });
  return { entered, release, async wait() { enter(); await resumed; } };
}

describe('published engineering assembly', () => {
  it('retains exact client command bytes and stable actor, operation and ticket correlation', async () => {
    const input = { principalId: 'staff-one', ticketId: 'ticket-one', operation: 'failure' as const,
      clientCommandId: 'ABCDEF12-1234-4ABC-8DEF-ABCDEF123456' };
    const packet = await supportEngineeringCommandIdentity(input);
    expect(await supportEngineeringCommandIdentity({ ...input })).toEqual(packet);
    expect(packet.commandId).toBe(input.clientCommandId);
    for (const changed of [{ ...input, principalId: 'staff-two' }, { ...input, ticketId: 'ticket-two' },
      { ...input, operation: 'review' as const }, { ...input, clientCommandId: input.clientCommandId.toLowerCase() }])
      expect((await supportEngineeringCommandIdentity(changed)).correlationId).not.toBe(packet.correlationId);
  });

  it('defaults intake OFF without creating an engineering source', async () => {
    expect(supportEngineeringApplicationOptions().enabled).toBe(false);
    const f = await fixture({ intake: false });
    const ticket = await f.createTicket(); const before = await f.rows();
    await expect(f.runtime.enroll(f.actors.staff, { ticketId: engineeringTicketId,
      clientCommandId: 'disabled-enrollment', expectedRevision: ticket.revision })).rejects.toThrow();
    expect(await f.rows()).toEqual(before);
  });

  it('keeps worker admission OFF independently of accepted evidence and staff reads', async () => {
    const f = await fixture({ processing: false }); await f.eligible();
    expect((await f.runtime.readSource(f.actors.staff, engineeringTicketId)).state).toBe('eligible');
    const before = await f.rows();
    expect(await f.process()).toEqual({ outcome: 'held', reason: 'engineering_disabled' });
    expect(await f.runtime.scanCandidates({ limit: 8 })).toEqual({ outcome: 'held', reason: 'engineering_disabled' });
    expect(f.state.modelCalls).toBe(0); expect(await f.rows()).toEqual(before);
  });

  it('holds a runtime with no service ports before a claim, reservation or paid call', async () => {
    const f = await fixture(); await f.eligible(); const before = await f.rows();
    const runtime = createSupportEngineeringRuntime({ application: f.application, clock: f.clock,
      staffAccess: { resolve: (id) => f.resolve(id) }, processingEnabled: () => true });
    expect(await runtime.processWork({ ...f.key(), workerId: 'unconfigured-worker', leaseMilliseconds: 30_000 }))
      .toEqual({ outcome: 'held', reason: 'engineering_unavailable' });
    expect(await runtime.scanCandidates({ limit: 8 })).toEqual({ outcome: 'held', reason: 'engineering_unavailable' });
    expect(f.state.reservations).toEqual([]); expect(await f.rows()).toEqual(before);
  });

  it('separates current human, policy administrator and worker grants', async () => {
    const f = await fixture(); await f.eligible();
    const processor = await f.resolve('engineering-processor');
    expect(processor.permissions).not.toContain(supportPermissions.engineeringReview);
    expect(processor.permissions).not.toContain(supportPermissions.engineeringRestrictedRead);
    expect(f.actors.staff.permissions).not.toContain(supportPermissions.engineeringProcess);
    await expect(f.runtime.readSource(f.actors.admin, engineeringTicketId)).rejects.toThrow(SupportDeskAuthorizationError);
    await expect(f.runtime.disableExports(f.actors.staff, { clientCommandId: 'staff-policy-denied', expectedGeneration: 1 }))
      .rejects.toThrow(SupportDeskAuthorizationError);
    await expect(f.runtime.scanReview(processor, { limit: 8 })).rejects.toThrow(SupportDeskAuthorizationError);
  });

  it('does not broaden an original restricted caller after rereading its current stored role', async () => {
    const f = await fixture(); await f.eligible();
    const restricted = { ...f.actors.staff,
      permissions: f.actors.staff.permissions.filter((entry) => entry !== supportPermissions.engineeringRead) };
    await expect(f.runtime.readSource(restricted, engineeringTicketId)).rejects.toThrow(SupportDeskAuthorizationError);
  });

  it('refuses the private response after actual role revocation at the final authority read', async () => {
    const f = await fixture(); await f.eligible(); let resolves = 0;
    const runtime = createSupportEngineeringRuntime({ application: f.application, clock: f.clock,
      staffAccess: { async resolve(id) {
        resolves += 1; if (resolves === 2) await f.revoke('staff'); return f.resolve(id);
      } } });
    const before = await f.rows();
    await expect(runtime.readSource(f.actors.staff, engineeringTicketId)).rejects.toThrow(SupportDeskAuthorizationError);
    expect(await f.rows()).toEqual(before);
  });

  it('records an actual staff-verified failure and exactly replays its immutable packet', async () => {
    const f = await fixture(); const accepted = await f.eligible(); const before = await f.rows();
    expect(await f.runtime.submitVerifiedFailure(f.actors.staff, structuredClone(accepted.packet))).toEqual(accepted.source);
    expect(await f.rows()).toEqual(before);
    const source = await f.source();
    expect(source.evidence).toMatchObject({ kind: 'staff_verified_failure', actorId: f.actors.staff.principalId });
    expect(source.product).toMatchObject({ productId: 'workspace', buildId: 'synthetic-build-230' });
    expect((await f.work()).status).toBe('pending'); expect(f.state.modelCalls).toBe(0);
  });

  it('rejects a private note as visible evidence without altering accepted authority', async () => {
    const f = await fixture(); const accepted = await f.eligible(); const before = await f.rows();
    await expect(f.runtime.submitVerifiedFailure(f.actors.staff, { ...accepted.packet,
      clientCommandId: 'private-evidence-denied', evidence: { ...accepted.packet.evidence, visibleMessageIds: ['engineering-note'] } }))
      .rejects.toThrow();
    expect(await f.rows()).toEqual(before);
  });

  it.each(['missing', 'expired'] as const)('holds %s trusted product evidence without model work', async (product) => {
    const f = await fixture(); f.state.product = product;
    const result = await f.eligible(); expect(result.source.state).toBe('held');
    expect((await f.rows()).filter((row) => row.kind === 'engineering_work')).toEqual([]);
    expect(f.state.modelCalls).toBe(0); expect(f.state.reservations).toEqual([]);
    expect((await reviewHints(f, false)).sources).toContain(engineeringTicketId);
  });

  it('keeps initial uncertain sources private during actual cursor-based review discovery', async () => {
    const f = await fixture(); const ticket = await f.createTicket();
    await f.runtime.enroll(f.actors.staff, { ticketId: engineeringTicketId,
      clientCommandId: 'unverified-source', expectedRevision: ticket.revision });
    await expect(f.runtime.readSource(f.actors.staff, engineeringTicketId)).rejects.toThrow(SupportDeskAuthorizationError);
    expect((await f.source()).security).toBe('uncertain');
    expect((await reviewHints(f, false)).sources).toEqual([]);
    expect((await reviewHints(f, true)).sources).toContain(engineeringTicketId);
  });

  it.each(['restricted', 'uncertain'] as const)('does not queue or expose a %s verified source to the ordinary worker', async (security) => {
    const f = await fixture(); const accepted = await f.eligible(security);
    expect(accepted.source.state).toBe('restricted');
    await expect(f.runtime.readSource(f.actors.staff, engineeringTicketId)).rejects.toThrow(SupportDeskAuthorizationError);
    expect((await f.rows()).filter((row) => row.kind === 'engineering_work')).toEqual([]);
    const scan = await f.runtime.scanCandidates({ limit: 64 });
    expect('candidates' in scan && scan.candidates).toEqual([]);
    expect((await reviewHints(f, true)).sources).toContain(engineeringTicketId);
    expect(f.state.modelCalls).toBe(0); expect(f.state.creates).toEqual([]);
  });

  it('requires current calibrated routing before a paid assessment', async () => {
    const f = await fixture(); await f.eligible(); f.state.calibrationReady = false;
    expect((await f.process()).outcome).toBe('held');
    expect((await f.work()).candidate).toBeUndefined();
    expect(f.state.modelCalls).toBe(0); expect(f.state.reservations).toEqual([]);
  });

  it('requires an exact checked request and staff approval before one physical issue creation', async () => {
    const f = await fixture(); await f.eligible(); const prepared = await f.prepared();
    expect(prepared.status).toBe('prepared'); expect(prepared.approval).toBeUndefined();
    expect(f.state.creates).toEqual([]);
    const packet = await f.approve(); const approved = await f.rows();
    await f.runtime.reviewProposal(f.actors.staff, structuredClone(packet));
    expect(await f.rows()).toEqual(approved);
    expect((await f.process()).outcome).toBe('dispatched');
    expect((await f.work()).status).toBe('accepted');
    expect((await f.source()).destinations).toMatchObject([{ outcome: 'accepted', reconciliation: 'confirmed' }]);
    await f.process(); expect(f.state.creates).toHaveLength(1); expect(f.state.modelCalls).toBe(1);
    for (const value of [f.state.modelInputs, f.state.searches, f.state.creates]) {
      expect(JSON.stringify(value)).not.toContain(engineeringCanary);
      expect(JSON.stringify(value)).not.toContain(engineeringProofReference);
    }
    expect(f.state.searches).toMatchObject([{ query: 'workspace export empty file', limit: 5 }]);
  });

  it('refuses a changed proposal hash without changing review or dispatch state', async () => {
    const f = await fixture(); await f.eligible(); const work = await f.prepared(); const before = await f.rows();
    await expect(f.runtime.reviewProposal(f.actors.staff, { ...f.key(), clientCommandId: 'wrong-review',
      expectedWorkGeneration: work.workGeneration, proposalHash: '0'.repeat(64), decision: 'approve' })).rejects.toThrow();
    expect(await f.rows()).toEqual(before); expect(f.state.creates).toEqual([]);
  });

  it.each(['held', 'restricted'] as const)('holds a final independent check outcome of %s', async (outcome) => {
    const f = await fixture(); await f.eligible();
    expect((await f.process()).outcome).toBe('candidate'); f.state.checks = outcome;
    const result = await f.process(); expect(result.outcome).toBe(outcome);
    expect((await f.work()).proposal).toBeUndefined(); expect(f.state.creates).toEqual([]);
    if (outcome === 'restricted')
      await expect(f.runtime.readWork(f.actors.staff, f.key())).rejects.toThrow(SupportDeskAuthorizationError);
  });

  it('requires independently approved public reproduction for a public repository', async () => {
    const f = await fixture(); await f.eligible();
    expect((await f.process()).outcome).toBe('candidate'); f.state.publicReproduction = 'not_applicable';
    expect((await f.process()).outcome).toBe('held');
    expect((await f.work()).proposal).toBeUndefined(); expect(f.state.creates).toEqual([]);
  });

  it('keeps model security classification private and unclaimable on its original work key', async () => {
    const f = await fixture(); await f.eligible(); f.state.modelSecurity = 'restricted';
    expect((await f.process()).outcome).toBe('restricted');
    const source = await f.source(); const work = await f.work();
    expect(source.sourceGeneration).toBeGreaterThan(work.sourceGeneration);
    expect(work.status).toBe('restricted');
    await expect(f.runtime.readWork(f.actors.staff, f.key())).rejects.toThrow(SupportDeskAuthorizationError);
    expect((await reviewHints(f, false)).work).toEqual([]);
    expect((await reviewHints(f, true)).work).toContainEqual(f.key());
    expect((await f.process()).outcome).toBe('not_claimed'); expect(f.state.modelCalls).toBe(1);
    expect(f.state.creates).toEqual([]);
  });

  it('does not export a model-selected repository outside the actual allowlist', async () => {
    const f = await fixture(); await f.eligible(); f.state.modelRepositoryId = 'not-allowlisted';
    expect((await f.process()).outcome).toBe('candidate');
    expect((await f.work()).candidate?.routing.outcome).toBe('out_of_scope');
    expect((await f.process()).outcome).toBe('held');
    expect((await f.work()).proposal).toBeUndefined(); expect(f.state.creates).toEqual([]);
  });

  it('allows exact staff selection after ambiguous routing without another model call', async () => {
    const f = await fixture(); await f.eligible(); f.state.modelRouting = 'ambiguous';
    expect((await f.process()).outcome).toBe('candidate');
    expect((await f.process()).outcome).toBe('held');
    expect((await reviewHints(f, false)).work).toContainEqual(f.key());
    const work = await f.work(); const policy = await f.runtime.readPolicy(f.actors.staff);
    const packet = { ...f.key(), clientCommandId: 'SELECT-EXACT', expectedWorkGeneration: work.workGeneration,
      repositoryId: engineeringRepositories[1]!.repositoryId, policyGeneration: policy.generation,
      policyHash: policy.policyHash, reason: 'The verified failure concerns the allowlisted download API.' };
    const before = await f.rows();
    await expect(f.runtime.selectRepository(f.actors.staff, { ...packet, repositoryId: 'not-allowlisted' })).rejects.toThrow();
    expect(await f.rows()).toEqual(before);
    await f.runtime.selectRepository(f.actors.staff, packet);
    expect((await f.process()).outcome).toBe('prepared');
    await f.approve(); expect((await f.process()).outcome).toBe('dispatched');
    expect(f.state.creates).toMatchObject([{ repository: { repositoryId: engineeringRepositories[1]!.repositoryId } }]);
    expect(f.state.modelCalls).toBe(1);
  });

  it('does not replace a missing trusted duplicate query with raw ticket text', async () => {
    const f = await fixture(); await f.eligible();
    expect((await f.process()).outcome).toBe('candidate'); f.state.duplicateQuery = null;
    expect((await f.process()).outcome).toBe('held');
    expect(f.state.searches).toEqual([]); expect(f.state.creates).toEqual([]);
  });

  it('revokes export authority when the actual repository policy is disabled after approval', async () => {
    const f = await fixture(); await f.eligible(); await f.prepared(); await f.approve();
    const policy = await f.runtime.readPolicy(f.actors.admin);
    await f.runtime.disableExports(f.actors.admin, { clientCommandId: 'disable-current-policy', expectedGeneration: policy.generation });
    await f.process(); expect(f.state.creates).toEqual([]);
    expect((await f.work()).dispatch).toBeUndefined();
  });

  it('refuses changed current repository visibility and revoked independent checks', async () => {
    const f = await fixture(); await f.eligible(); await f.prepared();
    f.state.checksReadable = false;
    await expect(f.approve()).rejects.toThrow();
    expect((await f.work()).approval).toBeUndefined();
    f.state.checksReadable = true; await f.approve();
    const repository = f.metadata.get(engineeringRepositories[0]!.repositoryId);
    if (repository === undefined) throw new Error('Synthetic repository metadata missing');
    f.metadata.set(repository.repositoryId, { ...repository, visibility: 'private', metadataVersion: 'synthetic-metadata-v2' });
    await f.process(); expect(f.state.creates).toEqual([]); expect((await f.work()).dispatch).toBeUndefined();
  });

  it('keeps an empty remote observation unknown without a second creation call', async () => {
    const f = await fixture(); await f.eligible(); await f.prepared(); await f.approve();
    f.state.createMode = 'unknown';
    expect(await f.process()).toEqual({ outcome: 'pending', stage: 'dispatch' });
    expect((await f.work()).status).toBe('unknown');
    f.advance(60_000); await f.process(); await f.runtime.reconcileSource(engineeringTicketId);
    expect((await f.work()).status).toBe('unknown');
    expect((await f.source()).destinations[0]?.outcome).toBe('unknown');
    expect(f.state.creates).toHaveLength(1); expect(f.state.modelCalls).toBe(1);
  });

  it('reconciles a lost accepted response with independent authority while generation is OFF', async () => {
    const f = await fixture(); await f.eligible(); await f.prepared(); await f.approve();
    f.state.createMode = 'accept_then_lose';
    expect(await f.process()).toEqual({ outcome: 'pending', stage: 'dispatch' });
    f.state.enabled = false; f.state.configuration = 'disabled';
    expect((await f.runtime.reconcileSource(engineeringTicketId)).outcome).toBe('reconciled');
    expect((await f.work()).status).toBe('accepted');
    expect(f.state.creates).toHaveLength(1); expect(f.state.modelCalls).toBe(1);
  });

  it('scrubs engineering bodies on privacy withdrawal and reconciles retained opaque identities', async () => {
    const f = await fixture(); await f.eligible(); const prepared = await f.prepared(); await f.approve();
    f.state.createMode = 'accept_then_lose'; await f.process();
    const dispatchId = (await f.work()).dispatch?.dispatchId;
    f.state.enabled = false; f.state.configuration = 'disabled';
    await f.runtime.withdraw(f.actors.staff, { ticketId: engineeringTicketId,
      clientCommandId: 'privacy-withdrawal', reason: 'privacy_withdrawal' });
    const source = await f.source(); const work = await f.work();
    expect(source.state).toBe('withdrawn'); expect(source.evidence).toBeUndefined(); expect(source.product).toBeUndefined();
    expect(work.evidence).toBeUndefined(); expect(work.candidate).toBeUndefined(); expect(work.proposal).toBeUndefined();
    expect(work.dispatch?.dispatchId).toBe(dispatchId);
    expect(work.withdrawnRequest?.exportMarker).toBe(prepared.proposal?.request.bundle.exportMarker);
    const engineeringRows = (await f.rows()).filter((row) => row.kind.startsWith('engineering_'));
    expect(JSON.stringify(engineeringRows)).not.toContain(engineeringProofReference);
    expect(JSON.stringify(engineeringRows)).not.toContain('A fictional workspace export omits its rows.');
    expect(JSON.stringify(await f.rows())).toContain(engineeringCanary);
    expect((await f.runtime.reconcileSource(engineeringTicketId)).outcome).toBe('reconciled');
    expect((await f.work()).status).toBe('accepted'); expect(f.state.creates).toHaveLength(1);
  });

  it('links an existing issue only as a private checked association without a GitHub write', async () => {
    const f = await fixture(); await f.eligible(); f.state.linkExisting = true;
    f.state.duplicates = [{ repositoryId: engineeringRepositories[0]!.repositoryId, issueId: 'synthetic-existing-42',
      issueNumber: 42, title: 'Workspace export loses rows', body: 'A synthetic existing report.' }];
    await f.prepared(); await f.approve();
    expect((await f.process()).outcome).toBe('dispatched');
    expect((await f.work()).acknowledgement?.issueId).toBe('synthetic-existing-42');
    expect(f.state.creates).toEqual([]); expect(f.state.modelCalls).toBe(1);
  });

  it('uses actual claim fencing when two workers overlap a paid model call', async () => {
    const f = await fixture(); await f.eligible(); const gate = barrier(); f.state.modelHook = gate.wait;
    const first = f.process();
    try {
      await Promise.race([gate.entered, first.then((result) => {
        throw new Error('Synthetic model barrier was not reached: ' + result.outcome);
      })]);
      expect(await f.runtime.processWork({ ...f.key(), workerId: 'synthetic-second-worker', leaseMilliseconds: 30_000 }))
        .toEqual({ outcome: 'not_claimed' });
    } finally { gate.release(); }
    expect((await first).outcome).toBe('candidate');
    expect(f.state.modelCalls).toBe(1); expect(f.state.reservations).toHaveLength(1);
  });

  it('invalidates a reviewed source on an actual visible customer reply before export', async () => {
    const f = await fixture(); await f.eligible(); await f.prepared(); await f.approve();
    await f.application.replyToCustomerTicket(f.actors.customer, { ...f.command('new-visible-evidence'), ticketId: engineeringTicketId,
      messageId: 'engineering-new-observation', body: 'A new fictional observation changes the report.' });
    expect((await f.source()).state).toBe('held');
    expect((await f.work()).status).toBe('superseded');
    expect((await f.process()).outcome).toBe('not_claimed'); expect(f.state.creates).toEqual([]);
  });
});


describe('one engineering staff operation deadline', () => {
  it('bounds an abort-ignoring actual SDK read within the time left after initial authority', async () => {
    const f = await fixture(); await f.eligible();
    const before = await f.rows(); const initial = barrier(); const read = barrier();
    let completeRead!: () => void;
    const readCompleted = new Promise<void>((resolve) => { completeRead = resolve; });
    let authoritySignal: AbortSignal | undefined; let resolves = 0; let returned = false;
    const runtime = createSupportEngineeringRuntime({ clock: f.clock,
      application: { ...f.application, async readEngineeringSource(...args: Parameters<typeof f.application.readEngineeringSource>) {
        try {
          const actual = await f.application.readEngineeringSource(...args);
          await read.wait(); returned = true; return actual;
        } finally { completeRead(); }
      } },
      staffAccess: { async resolve(id, signal) {
        authoritySignal = signal; resolves += 1;
        if (resolves === 1) await initial.wait();
        return f.resolve(id);
      } },
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = runtime.readSource(f.actors.staff, engineeringTicketId);
    let settled = false;
    const observed = pending.then((value) => { settled = true; return { kind: 'returned' as const, value }; },
      (error: unknown) => { settled = true; return { kind: 'failed' as const, error }; });
    try {
      await initial.entered;
      await vi.advanceTimersByTimeAsync(9_000); initial.release();
      await Promise.race([read.entered, pending.then(() => { throw new Error('Actual read did not reach its barrier'); })]);
      expect(authoritySignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(16_001);
      expect(settled).toBe(true);
      const result = await observed;
      expect(result.kind).toBe('failed');
      if (result.kind !== 'failed') throw new Error('Private SDK result escaped the staff deadline');
      expect(result.error).toBeInstanceOf(SupportEngineeringUnavailableError);
      expect(authoritySignal?.aborted).toBe(true);
      expect(returned).toBe(false);
      expect(await f.rows()).toEqual(before);
    } finally {
      initial.release(); read.release(); await readCompleted; vi.useRealTimers();
    }
    expect(returned).toBe(true);
    expect(resolves).toBe(1);
    expect((await observed).kind).toBe('failed');
    expect(await f.rows()).toEqual(before);
  });

  it('withholds a delayed real commit acknowledgement and recovers only the original immutable packet', async () => {
    // Intake was disabled when this real ticket was created. Enrolling through
    // a newly enabled factory over the SAME Store must therefore mutate it.
    const f = await fixture({ intake: false }); const ticket = await f.createTicket();
    const application = createSupportDeskApplication({ store: f.store, clock: f.clock,
      engineering: supportEngineeringApplicationOptions({ enabled: true }) });
    const before = await f.rows(); const committed = barrier();
    expect(before.some((row) => row.kind === 'engineering_source')).toBe(false);
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => { complete = resolve; });
    let acknowledgement: Awaited<ReturnType<typeof f.application.enrollEngineeringSource>> | undefined;
    let authoritySignal: AbortSignal | undefined;
    const runtime = createSupportEngineeringRuntime({ clock: f.clock,
      application: { ...application, async enrollEngineeringSource(...args: Parameters<typeof application.enrollEngineeringSource>) {
        try {
          const actual = await application.enrollEngineeringSource(...args);
          acknowledgement ??= actual;
          await committed.wait(); return actual;
        } finally { complete(); }
      } },
      staffAccess: { resolve(id, signal) { authoritySignal = signal; return f.resolve(id); } },
    });
    const packet = { ticketId: engineeringTicketId,
      clientCommandId: 'DEADLINE-COMMIT-EXACT', expectedRevision: ticket.revision };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = runtime.enroll(f.actors.staff, packet);
    let settled = false;
    const observed = pending.then((value) => { settled = true; return { kind: 'returned' as const, value }; },
      (error: unknown) => { settled = true; return { kind: 'failed' as const, error }; });
    let committedRows: Awaited<ReturnType<typeof f.rows>> = [];
    try {
      await Promise.race([committed.entered, pending.then(() => { throw new Error('Real commit acknowledgement was not delayed'); })]);
      committedRows = await f.rows();
      expect(committedRows).not.toEqual(before);
      expect(committedRows).toHaveLength(before.length + 3);
      expect(committedRows.filter((row) => row.kind === 'engineering_receipt')).toHaveLength(1);
      expect(committedRows.some((row) => row.kind === 'audit' &&
        row.event.action === 'support.engineering.enrolled' &&
        row.event.details?.commandId === packet.clientCommandId)).toBe(true);
      await vi.advanceTimersByTimeAsync(25_001);
      expect(settled).toBe(true);
      const result = await observed;
      expect(result.kind).toBe('failed');
      if (result.kind !== 'failed') throw new Error('Committed SDK acknowledgement escaped the deadline');
      expect(result.error).toBeInstanceOf(SupportEngineeringUnavailableError);
      expect(authoritySignal?.aborted).toBe(true);
      expect(await f.rows()).toEqual(committedRows);
    } finally {
      committed.release(); await completed; vi.useRealTimers();
    }
    expect(acknowledgement).toBeDefined();
    expect(await runtime.enroll(f.actors.staff, structuredClone(packet))).toEqual(acknowledgement);
    expect(await f.rows()).toEqual(committedRows);
    expect(f.state.modelCalls).toBe(0); expect(f.state.creates).toEqual([]);
  });

  it('uses the same remaining deadline for final authority after an actual SDK read', async () => {
    const f = await fixture(); await f.eligible(); const before = await f.rows();
    const initial = barrier(); const final = barrier(); let resolves = 0;
    let finalSignal: AbortSignal | undefined;
    const runtime = createSupportEngineeringRuntime({ application: f.application, clock: f.clock,
      staffAccess: { async resolve(id, signal) {
        resolves += 1;
        if (resolves === 1) await initial.wait();
        else { finalSignal = signal; await final.wait(); }
        return f.resolve(id);
      } },
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = runtime.readSource(f.actors.staff, engineeringTicketId);
    let settled = false;
    const observed = pending.then((value) => { settled = true; return { kind: 'returned' as const, value }; },
      (error: unknown) => { settled = true; return { kind: 'failed' as const, error }; });
    try {
      await initial.entered; await vi.advanceTimersByTimeAsync(9_000); initial.release();
      await Promise.race([final.entered, pending.then(() => { throw new Error('Actual read did not reach final authority'); })]);
      await vi.advanceTimersByTimeAsync(16_001);
      expect(settled).toBe(true);
      const result = await observed;
      expect(result.kind).toBe('failed');
      if (result.kind !== 'failed') throw new Error('SDK result escaped final authority deadline');
      expect(result.error).toBeInstanceOf(SupportEngineeringUnavailableError);
      expect(finalSignal?.aborted).toBe(true);
    } finally { initial.release(); final.release(); vi.useRealTimers(); }
    expect(await f.rows()).toEqual(before);
    expect((await observed).kind).toBe('failed');
  });

  it('honors an earlier real SDK review deadline and abort cleanup for an uncooperative policy port', async () => {
    const f = await fixture(); await f.eligible(); const work = await f.prepared();
    if (work.proposal === undefined) throw new Error('Actual checked proposal required');
    const before = await f.rows(); const policy = barrier();
    let authoritySignal: AbortSignal | undefined; let sdkSignal: AbortSignal | undefined;
    const runtime = createSupportEngineeringRuntime({ application: f.application, clock: f.clock,
      staffAccess: { resolve(id, signal) { authoritySignal = signal; return f.resolve(id); } },
      ports: { ...f.ports, checks: { ...f.ports.checks, async resolvePolicy(expectedVersion, signal) {
        const actual = await f.ports.checks.resolvePolicy(expectedVersion, signal);
        sdkSignal = signal; await policy.wait(); return actual;
      } } },
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = runtime.reviewProposal(f.actors.staff, { ...f.key(),
      clientCommandId: 'REVIEW-DEADLINE-EXACT', expectedWorkGeneration: work.workGeneration,
      proposalHash: work.proposal.proposalHash, decision: 'approve' });
    let settled = false;
    const observed = pending.then((value) => { settled = true; return { kind: 'returned' as const, value }; },
      (error: unknown) => { settled = true; return { kind: 'failed' as const, error }; });
    try {
      await Promise.race([policy.entered, pending.then(() => { throw new Error('Actual SDK review did not reach its policy port'); })]);
      expect(sdkSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(25_001);
      expect(settled).toBe(true);
      const result = await observed;
      expect(result.kind).toBe('failed');
      if (result.kind !== 'failed') throw new Error('Unverified engineering review escaped its deadline');
      // SDK runtime.within floors its remaining timer and may reject before
      // the outer host timer. Its review guard preserves this exact deadline
      // category; it is not a host-unavailable error or proof of noncommit.
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error).toMatchObject({ name: 'AssistantBoundaryError', category: 'deadline' });
      expect(authoritySignal?.aborted).toBe(true);
      expect(sdkSignal?.aborted).toBe(true);
    } finally { policy.release(); vi.useRealTimers(); }
    expect(await f.rows()).toEqual(before);
    expect(f.state.creates).toEqual([]);
    expect(f.state.modelCalls).toBe(1);
  });
});
