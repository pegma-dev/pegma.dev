import { createMemoryStore } from '@pegma/storage-core';
import {
  KnowledgeBaseNotFoundError,
  KnowledgeBaseAuthorizationError,
  RepositoryConflictError,
} from '@pegma/knowledge-base-application';
import {
  KnowledgeBaseNotFoundError as LegacyNotFoundError,
  RepositoryConflictError as LegacyConflictError,
} from '@pegma/knowledge-base-ai-compat';
import { SupportDeskAuthorizationError, supportPermissions } from '@pegma/support-desk-application';
import { knowledgePermissions } from '@pegma/knowledge-base-contracts';
import { describe, expect, it } from 'vitest';
import {
  createSupportLearningRuntime,
  supportLearningApplicationOptions,
} from './support-learning';
import {
  createSupportLearningKnowledgePort,
  supportLearningCommandIdentity,
} from './support-learning-ports';
import {
  createSupportLearningFixture,
  learningCanary,
  learningTicketId,
} from './support-learning-fixtures';

function fixture(options?: Parameters<typeof createSupportLearningFixture>[1]) {
  return createSupportLearningFixture(createMemoryStore(), options);
}

describe('published learning assembly', () => {
  it('preserves exact client bytes and derives a stable actor/operation/ticket correlation', async () => {
    const input = { principalId: 'staff-one', ticketId: 'ticket-one', operation: 'enroll' as const,
      clientCommandId: 'A1B2C3D4-1234-4ABC-8DEF-ABCDEF123456' };
    const identity = await supportLearningCommandIdentity(input);
    expect(await supportLearningCommandIdentity({ ...input })).toEqual(identity);
    expect(identity.commandId).toBe(input.clientCommandId);
    for (const changed of [{ ...input, principalId: 'staff-two' }, { ...input, ticketId: 'ticket-two' },
      { ...input, operation: 'verified_fix' as const }, { ...input, clientCommandId: input.clientCommandId.toLowerCase() }]) {
      expect((await supportLearningCommandIdentity(changed)).correlationId).not.toBe(identity.correlationId);
    }
  });

  it('defaults intake OFF and refuses explicit enrollment without writing a source', async () => {
    expect(supportLearningApplicationOptions().enabled).toBe(false);
    const f = await fixture({ intake: false });
    const ticket = await f.terminal();
    const before = await f.rows();
    await expect(f.runtime.enroll(f.actors.staff, { ticketId: learningTicketId,
      clientCommandId: 'enroll-disabled', expectedRevision: ticket.revision })).rejects.toThrow();
    expect(await f.rows()).toEqual(before);
  });

  it('keeps generation OFF separately from accepted evidence and private reads', async () => {
    const f = await fixture({ processing: false });
    await f.enrollAndVerify();
    expect((await f.runtime.readSource(f.actors.staff, learningTicketId)).state).toBe('eligible');
    const before = await f.rows();
    expect(await f.process()).toEqual({ outcome: 'held', reason: 'learning_disabled' });
    expect(await f.runtime.scanCandidates({ limit: 8 })).toEqual({ outcome: 'held', reason: 'learning_disabled' });
    expect(f.state.modelCalls).toBe(0);
    expect(await f.rows()).toEqual(before);
  });

  it('holds an incompletely configured generation path before claiming or paying', async () => {
    const f = await fixture();
    await f.enrollAndVerify();
    const runtime = createSupportLearningRuntime({ application: f.application, knowledge: f.knowledge,
      sources: f.sources, clock: f.clock, processingEnabled: () => true,
      staffAccess: { resolve: (id) => f.resolve(id) } });
    const source = await runtime.readSource(f.actors.staff, learningTicketId);
    const before = await f.rows();
    expect(await runtime.processWork({ ticketId: learningTicketId, sourceGeneration: source.sourceGeneration,
      workerId: 'synthetic-worker', leaseMilliseconds: 30_000 })).toEqual({ outcome: 'held', reason: 'learning_unavailable' });
    expect(await f.rows()).toEqual(before);
    expect(f.state.modelCalls).toBe(0);
  });

  it.each(['missing', 'expired'] as const)('holds %s trusted product evidence instead of creating generation work', async (mode) => {
    const f = await fixture(); f.state.product = mode;
    await f.enrollAndVerify();
    expect((await f.runtime.readSource(f.actors.staff, learningTicketId)).state).toBe('held');
    expect((await f.rows()).filter((row) => row.kind === 'resolution_learning_work')).toEqual([]);
    expect(f.state.modelCalls).toBe(0);
  });

  it('refuses a derived candidate that changes the trusted product/build binding', async () => {
    const f = await fixture(); await f.enrollAndVerify();
    f.setModel(async (_input, _context, configuration) => ({
      outputJson: JSON.stringify({ ...f.candidate,
        applicability: { ...f.candidate.applicability, buildId: 'different-build' } }),
      provider: configuration.provider, model: configuration.model, requestId: 'synthetic-wrong-build',
      usage: { inputTokens: 100, outputTokens: 50, costMicros: 10, currency: 'USD' },
    }));
    expect((await f.process()).outcome).not.toBe('candidate');
    const source = await f.runtime.readSource(f.actors.staff, learningTicketId);
    const work = await f.runtime.readWork(f.actors.staff, { ticketId: learningTicketId, sourceGeneration: source.sourceGeneration });
    expect(work.candidate).toBeUndefined();
    expect(work.target).toBeUndefined();
  });

  it('delivers one private checked draft, reviews its exact target and accepts only human-confirmed KB evidence', async () => {
    const f = await fixture();
    await f.enrollAndVerify();
    const result = await f.delivered();
    const draft = await f.knowledge.getDraft(f.actors.staff, { articleId: result.articleId });
    const provenance = await f.knowledge.getProvenance(f.actors.staff, { articleId: result.articleId });
    expect(draft.state).toBe('draft');
    for (const advisory of f.candidate.validationRequirements)
      expect(draft.revision.content.text).toContain(advisory);
    const requirements = await f.knowledge.getValidationRequirements(f.actors.runner, {
      collectionId: draft.revision.collectionId, kind: draft.revision.kind,
    });
    expect(requirements.checks.map((check) => check.id)).toContain('explanation-content');
    expect(provenance.snapshot.references).toHaveLength(1);
    expect(JSON.stringify(provenance.snapshot)).toContain('pegma.support-desk');
    expect(JSON.stringify(f.state.modelInputs)).not.toContain(learningCanary);
    expect(JSON.stringify(f.state.modelInputs)).not.toContain('SYNTHETIC_PRIVATE_VERIFICATION');
    expect(JSON.stringify(f.state.modelInputs)).not.toContain('synthetic-independent-learning-check');
    await f.review(result.articleId);
    const published = await f.evidenceAndPublish(result.articleId);
    expect(published.title).toBe('Export your workspace');
    expect(JSON.stringify(published)).not.toContain(learningTicketId);
    expect(JSON.stringify(published)).not.toContain('pegma.support-desk');
    expect(JSON.stringify(published)).not.toContain(learningCanary);
    expect(f.state.modelCalls).toBe(1);
    expect((await f.rows()).filter((row) => row.kind === 'resolution_learning_work')).toHaveLength(1);
  });

  it('replays the same staff evidence packet without another work or receipt', async () => {
    const f = await fixture(); const packet = await f.enrollAndVerify();
    const before = await f.rows();
    const result = await f.runtime.submitVerifiedFix(f.actors.staff, structuredClone(packet));
    expect(result.state).toBe('eligible');
    expect(await f.rows()).toEqual(before);
  });

  it('lets only one overlapping physical worker enter the paid model stage', async () => {
    const f = await fixture(); await f.enrollAndVerify();
    let entered = () => {}; let release = () => {};
    const reached = new Promise<void>((resolve) => { entered = resolve; });
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    f.state.beforeModelReturn = async () => { entered(); await waiting; };
    const first = f.process();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        reached,
        first.then(() => { throw new Error('The first worker did not reach its model barrier'); }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Learning model barrier not reached')), 3000);
        }),
      ]);
      expect(await f.process()).toEqual({ outcome: 'not_claimed' });
      expect(f.state.modelCalls).toBe(1);
    } finally {
      release(); if (timer !== undefined) clearTimeout(timer);
    }
    expect((await first).outcome).toBe('candidate');
    expect((await f.process()).outcome).toBe('delivered');
    expect(f.state.modelCalls).toBe(1);
    expect((await f.rows()).filter((row) => row.kind === 'resolution_learning_work')).toHaveLength(1);
  });

  it('recovers a host ACK lost after actual SDK acceptance with the original immutable packet', async () => {
    const f = await fixture(); const original = await f.enrollAndVerify();
    let lost = true;
    const runtime = createSupportLearningRuntime({
      application: { ...f.application, async submitResolutionEvidence(...args) {
        const result = await f.application.submitResolutionEvidence(...args);
        if (lost) { lost = false; throw new Error('Synthetic withheld host acknowledgement'); }
        return result;
      } },
      knowledge: f.knowledge, sources: f.sources, clock: f.clock, ports: f.ports,
      staffAccess: { resolve: (id) => f.resolve(id) },
    });
    const packet = { ...original, clientCommandId: 'lost-host-ack-exact' };
    const before = await f.rows();
    await expect(runtime.submitVerifiedFix(f.actors.staff, packet)).rejects.toThrow('Synthetic withheld host acknowledgement');
    const committed = await f.rows(); expect(committed.length).toBeGreaterThan(before.length);
    expect((await runtime.submitVerifiedFix(f.actors.staff, structuredClone(packet))).state).toBe('eligible');
    expect(await f.rows()).toEqual(committed);
  });

  it('does not promote a restricted caller through a broader current staff resolver', async () => {
    const f = await fixture(); const ticket = await f.terminal();
    const restricted = { ...f.actors.staff,
      permissions: f.actors.staff.permissions.filter((name) => name !== supportPermissions.learningEvidenceSubmit) };
    const before = await f.rows();
    await expect(f.runtime.enroll(restricted, { ticketId: learningTicketId, clientCommandId: 'restricted',
      expectedRevision: ticket.revision })).rejects.toBeInstanceOf(SupportDeskAuthorizationError);
    expect(await f.rows()).toEqual(before);
  });

  it('observes a real audited role revocation on the next call', async () => {
    const f = await fixture(); await f.enrollAndVerify();
    await f.revokeStaff();
    const before = await f.rows();
    await expect(f.runtime.readSource(f.actors.staff, learningTicketId)).rejects.toBeInstanceOf(SupportDeskAuthorizationError);
    expect(await f.rows()).toEqual(before);
  });

  it('rejects a caller principal changed while current authority is being read', async () => {
    const f = await fixture(); const ticket = await f.terminal();
    const caller = { ...f.actors.staff };
    f.state.beforeStaffResolve = async () => { caller.principalId = 'another-principal'; };
    const before = await f.rows();
    await expect(f.runtime.enroll(caller, { ticketId: learningTicketId, clientCommandId: 'actor-changed',
      expectedRevision: ticket.revision })).rejects.toBeInstanceOf(SupportDeskAuthorizationError);
    expect(await f.rows()).toEqual(before);
  });

  it('withholds a committed enrollment ACK when the actual staff role is revoked before return', async () => {
    const f = await fixture(); const ticket = await f.terminal();
    let reads = 0;
    f.state.beforeStaffResolve = async () => { if (++reads === 2) await f.revokeStaff(); };
    const packet = { ticketId: learningTicketId, clientCommandId: 'commit-then-revoke', expectedRevision: ticket.revision };
    await expect(f.runtime.enroll(f.actors.staff, packet)).rejects.toBeInstanceOf(SupportDeskAuthorizationError);
    const accepted = await f.application.readResolutionLearningSource(f.actors.admin, learningTicketId);
    expect(accepted.sourceGeneration).toBe(0);
    const committed = await f.rows();
    await expect(f.runtime.enroll(f.actors.staff, packet)).rejects.toBeInstanceOf(SupportDeskAuthorizationError);
    expect(await f.rows()).toEqual(committed);
  });

  it.each(['held', 'revoked'] as const)('refuses independent checks that are %s without transferring a draft', async (mode) => {
    const f = await fixture(); await f.enrollAndVerify();
    expect((await f.process()).outcome).toBe('candidate');
    if (mode === 'held') f.state.check = 'held'; else f.state.checkReadable = false;
    const result = await f.process(); expect(result.outcome).toBe('held');
    const source = await f.runtime.readSource(f.actors.staff, learningTicketId);
    const work = await f.runtime.readWork(f.actors.staff, { ticketId: learningTicketId, sourceGeneration: source.sourceGeneration });
    expect(work.target).toBeUndefined();
    expect(f.state.modelCalls).toBe(1);
  });

  it('rejects a changed exact review binding without adding a review', async () => {
    const f = await fixture(); await f.enrollAndVerify(); const { articleId } = await f.delivered();
    const packet = await f.review(articleId); const before = await f.rows();
    await expect(f.runtime.reviewProposal(f.actors.staff, { ...packet,
      target: { ...packet.target, contentHash: '0'.repeat(64) } })).rejects.toThrow();
    expect(await f.rows()).toEqual(before);
  });

  it('reopening the source denies an already published guide without trusting its old review', async () => {
    const f = await fixture(); await f.enrollAndVerify(); const result = await f.delivered();
    await f.review(result.articleId); await f.evidenceAndPublish(result.articleId);
    await f.application.reopenTicket(f.actors.staff, { ...f.command('reopen'), ticketId: learningTicketId });
    const current = await f.runtime.readSource(f.actors.staff, learningTicketId);
    expect(current.sourceGeneration).toBeGreaterThan(result.source.sourceGeneration);
    expect(current.state).toBe('held');
    await expect(f.knowledge.getPublishedArticle(f.actors.customer, { articleId: result.articleId })).rejects.toThrow();
    expect(f.state.modelCalls).toBe(1);
  });

  it('honors a generation kill switch during the actual model await', async () => {
    const f = await fixture(); await f.enrollAndVerify();
    f.state.beforeModelReturn = async () => { f.state.enabled = false; };
    expect((await f.process()).outcome).not.toBe('candidate');
    const source = await f.runtime.readSource(f.actors.staff, learningTicketId);
    const work = await f.runtime.readWork(f.actors.staff, { ticketId: learningTicketId, sourceGeneration: source.sourceGeneration });
    expect(work.candidate).toBeUndefined();
    expect(f.state.modelCalls).toBe(1);
    expect(await f.process()).toEqual({ outcome: 'held', reason: 'learning_disabled' });
    expect(f.state.modelCalls).toBe(1);
  });

  it('keeps privacy withdrawal and actual source reconciliation available with generation OFF', async () => {
    const f = await fixture(); await f.enrollAndVerify(); const { articleId } = await f.delivered();
    await f.review(articleId); await f.evidenceAndPublish(articleId);
    expect(f.actors.staff.permissions).not.toContain(supportPermissions.learningProcess);
    const retirement = await f.ports.retirementAccess.resolve(new AbortController().signal);
    expect(retirement.outcome).toBe('ready');
    if (retirement.outcome !== 'ready') throw new Error('Synthetic retirement authority unavailable');
    expect(retirement.authority.access.permissions).toContain(supportPermissions.learningProcess);
    expect(retirement.authority.access.permissions).not.toContain(knowledgePermissions.publish);
    f.state.enabled = false;
    const result = await f.runtime.withdraw(f.actors.staff, { ticketId: learningTicketId,
      clientCommandId: 'privacy-withdraw-exact', reason: 'privacy_withdrawal' });
    expect(result.state).toBe('withdrawn');
    expect((await f.runtime.reconcileSource(learningTicketId)).outcome).toBe('reconciled');
    await expect(f.knowledge.getPublishedArticle(f.actors.customer, { articleId })).rejects.toThrow();
    expect(f.state.modelCalls).toBe(1);
  });

  it('translates a genuine missing direct-KB draft into the nested012 instance and actual coordinator target_unavailable', async () => {
    const f = await fixture();
    const port = createSupportLearningKnowledgePort(f.knowledge);
    await expect(f.knowledge.getDraft(f.actors.admin, { articleId: 'missing-guide' })).rejects.toBeInstanceOf(KnowledgeBaseNotFoundError);
    await expect(port.getDraft(f.actors.admin, { articleId: 'missing-guide' })).rejects.toBeInstanceOf(LegacyNotFoundError);
    await f.enrollAndVerify(); expect((await f.process()).outcome).toBe('candidate');
    f.state.explicitDraftIds = ['missing-guide'];
    expect(await f.process()).toMatchObject({ outcome: 'held', reason: 'target_unavailable' });
  });

  it('preserves an unrecognized genuine KB authorization error without translating its identity', async () => {
    const f = await fixture();
    let observed: unknown;
    const port = createSupportLearningKnowledgePort({ ...f.knowledge, async getDraft(...args) {
      try { return await f.knowledge.getDraft(...args); }
      catch (error) { observed = error; throw error; }
    } });
    const failure = await port.getDraft(f.actors.customer, { articleId: 'private-guide' }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KnowledgeBaseAuthorizationError);
    expect(failure).toBe(observed);
  });

  it('retries actual reconciliation when a genuine SDK conflict is forwarded at the public read boundary', async () => {
    const f = await fixture(); await f.enrollAndVerify(); const { articleId } = await f.delivered();
    await f.review(articleId); await f.evidenceAndPublish(articleId);
    const draft = await f.knowledge.getDraft(f.actors.admin, { articleId });
    let actualConflict: RepositoryConflictError | undefined;
    try {
      await f.knowledge.updateDraft(f.actors.admin, { ...f.command('stale-edit', draft.generation - 1), articleId, collectionId: draft.revision.collectionId,
        draft: { kind: draft.revision.kind, title: draft.revision.title, summary: draft.revision.summary,
          content: draft.revision.content, tags: draft.revision.tags, applicability: draft.revision.applicability } });
    } catch (error) {
      if (!(error instanceof RepositoryConflictError)) throw error;
      actualConflict = error;
    }
    expect(actualConflict).toBeInstanceOf(RepositoryConflictError);
    const conflict = actualConflict;
    if (conflict === undefined) throw new Error('Actual stale SDK mutation did not conflict');
    let injected = false; let reads = 0;
    // The error is genuine SDK output from the stale public mutation above.
    // Forward it once after a real read; this is not a fabricated Store race.
    f.setKnowledge({ ...f.knowledge, async getDraft(...args) {
      reads += 1;
      const result = await f.knowledge.getDraft(...args);
      if (!injected) { injected = true; throw conflict; }
      return result;
    } });
    await expect(createSupportLearningKnowledgePort({ ...f.knowledge, async getDraft(...args) {
      await f.knowledge.getDraft(...args); throw conflict;
    } }).getDraft(f.actors.admin, { articleId })).rejects.toBeInstanceOf(LegacyConflictError);
    await f.runtime.withdraw(f.actors.staff, { ticketId: learningTicketId,
      clientCommandId: 'withdraw-before-conflict', reason: 'privacy_withdrawal' });
    expect((await f.runtime.reconcileSource(learningTicketId)).outcome).toBe('reconciled');
    expect(injected).toBe(true); expect(reads).toBeGreaterThan(1);
    expect(f.state.modelCalls).toBe(1);
  });
});
