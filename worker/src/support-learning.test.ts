import { createMemoryStore } from '@pegma/storage-core';
import {
  KnowledgeBaseNotFoundError,
  KnowledgeBaseAuthorizationError,
  RepositoryConflictError,
} from '@pegma/knowledge-base-application';
import { SupportDeskAuthorizationError, supportPermissions } from '@pegma/support-desk-application';
import { learningTargetBinding } from '@pegma/support-desk-ai';
import { knowledgePermissions } from '@pegma/knowledge-base-contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  createSupportLearningRuntime,
  SupportLearningUnavailableError,
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

function barrier() {
  let release = () => {};
  const reached = new Promise<void>((resolve) => { release = resolve; });
  return { reached, release };
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

  it('distinguishes a readiness callback outage from deliberately disabled processing without exposing its cause', async () => {
    const f = await fixture(); await f.enrollAndVerify();
    const runtime = createSupportLearningRuntime({ application: f.application, knowledge: f.knowledge,
      sources: f.sources, clock: f.clock, ports: f.ports,
      processingEnabled() { throw new Error(learningCanary); },
      staffAccess: { resolve: (id) => f.resolve(id) } });
    const source = await runtime.readSource(f.actors.staff, learningTicketId);
    const before = await f.rows();
    const result = await runtime.processWork({ ticketId: learningTicketId,
      sourceGeneration: source.sourceGeneration, workerId: 'synthetic-worker', leaseMilliseconds: 30_000 });
    expect(result).toEqual({ outcome: 'held', reason: 'learning_readiness_unavailable' });
    expect(await runtime.scanCandidates({ limit: 8 })).toEqual(result);
    expect(JSON.stringify(result)).not.toContain(learningCanary);
    expect(await f.rows()).toEqual(before);
    expect(f.state.modelCalls).toBe(0);
  });

  it('reports an opaque staff authority outage separately from a deadline', async () => {
    const f = await fixture(); await f.enrollAndVerify();
    const runtime = createSupportLearningRuntime({ application: f.application, knowledge: f.knowledge,
      sources: f.sources, clock: f.clock,
      staffAccess: { async resolve() { throw new Error(learningCanary); } } });
    const failure: unknown = await runtime.readSource(f.actors.staff, learningTicketId).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SupportLearningUnavailableError);
    expect(failure).toMatchObject({ code: 'support_learning_unavailable', reason: 'staff_authority_unavailable',
      message: 'Support learning is unavailable' });
    expect(failure).not.toHaveProperty('cause');
    expect(JSON.stringify(failure)).not.toContain(learningCanary);
  });

  it.each([0, -1, 25_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid server staff boundary %s', async (staffOperationMilliseconds) => {
      const f = await fixture();
      expect(() => createSupportLearningRuntime({ application: f.application, knowledge: f.knowledge,
        sources: f.sources, clock: f.clock, staffOperationMilliseconds,
        staffAccess: { resolve: (id) => f.resolve(id) } })).toThrow('Invalid staff operation boundary');
    },
  );

  it('bounds a deferred actual application read and aborts the same authority signal', async () => {
    const f = await fixture(); await f.enrollAndVerify();
    const entered = barrier(); const wait = barrier(); const returned = barrier();
    let signal: AbortSignal | undefined; let reads = 0;
    const runtime = createSupportLearningRuntime({
      application: { ...f.application, async readResolutionLearningSource(...args) {
        reads += 1; const result = await f.application.readResolutionLearningSource(...args);
        entered.release(); await wait.reached; returned.release(); return result;
      } },
      knowledge: f.knowledge, sources: f.sources, clock: f.clock, staffOperationMilliseconds: 1000,
      staffAccess: { async resolve(id, currentSignal) { signal = currentSignal; return f.resolve(id); } },
    });
    const before = await f.rows();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      let settled = false;
      const result = runtime.readSource(f.actors.staff, learningTicketId)
        .catch((error: unknown) => error).finally(() => { settled = true; });
      await entered.reached;
      await vi.advanceTimersByTimeAsync(999); expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toMatchObject({ code: 'support_learning_unavailable', reason: 'staff_deadline' });
      expect(signal?.aborted).toBe(true); expect(reads).toBe(1);
      wait.release(); await returned.reached;
      expect(await f.rows()).toEqual(before);
    } finally { wait.release(); vi.useRealTimers(); }
  });

  it.each(['initial', 'final'] as const)('classifies an %s authority deadline without treating it as revocation or an outage', async (phase) => {
    const f = await fixture(); await f.enrollAndVerify();
    const entered = barrier(); const wait = barrier();
    let authorityCalls = 0; let signal: AbortSignal | undefined;
    const runtime = createSupportLearningRuntime({ application: f.application, knowledge: f.knowledge,
      sources: f.sources, clock: f.clock, staffOperationMilliseconds: 1000,
      staffAccess: { async resolve(id, currentSignal) {
        const access = await f.resolve(id); authorityCalls += 1; signal = currentSignal;
        if (authorityCalls === (phase === 'initial' ? 1 : 2)) {
          entered.release(); await wait.reached;
        }
        return access;
      } },
    });
    const before = await f.rows();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const result = runtime.readSource(f.actors.staff, learningTicketId).catch((error: unknown) => error);
      await entered.reached; await vi.advanceTimersByTimeAsync(1000);
      expect(await result).toMatchObject({ reason: 'staff_deadline' });
      expect(signal?.aborted).toBe(true);
      expect(await f.rows()).toEqual(before);
    } finally { wait.release(); vi.useRealTimers(); }
  });

  it('uses one staff deadline and preserves a late actual enrollment for exact historical receipt replay', async () => {
    const f = await fixture(); const ticket = await f.terminal();
    const authorityEntered = barrier(); const authorityWait = barrier();
    const entered = barrier(); const wait = barrier(); const committed = barrier();
    let calls = 0; let authorityCalls = 0;
    const runtime = createSupportLearningRuntime({
      application: { ...f.application, async enrollResolutionLearning(...args) {
        calls += 1; entered.release(); await wait.reached;
        const result = await f.application.enrollResolutionLearning(...args);
        committed.release(); return result;
      } },
      knowledge: f.knowledge, sources: f.sources, clock: f.clock, staffOperationMilliseconds: 1000,
      staffAccess: { async resolve(id) {
        const access = await f.resolve(id);
        if (++authorityCalls === 1) { authorityEntered.release(); await authorityWait.reached; }
        return access;
      } },
    });
    const packet = Object.freeze({ ticketId: learningTicketId, clientCommandId: 'deadline-enroll-exact',
      expectedRevision: ticket.revision });
    const before = await f.rows();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      let settled = false;
      const result = runtime.enroll(f.actors.staff, packet)
        .catch((error: unknown) => error).finally(() => { settled = true; });
      await authorityEntered.reached;
      await vi.advanceTimersByTimeAsync(600); authorityWait.release(); await entered.reached;
      await vi.advanceTimersByTimeAsync(399); expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toMatchObject({ reason: 'staff_deadline' });
      expect(calls).toBe(1); expect(authorityCalls).toBe(1);
      expect(await f.rows()).toEqual(before);
      wait.release(); await committed.reached;
      const accepted = await f.application.readResolutionLearningSource(f.actors.staff, learningTicketId);
      expect(accepted.sourceGeneration).toBe(0);
      const acceptedRows = await f.rows();
      expect(acceptedRows.filter((row) => row.kind === 'resolution_learning_receipt')).toHaveLength(1);
      await f.application.reopenTicket(f.actors.staff, { ...f.command('after-timeout-reopen'), ticketId: learningTicketId });
      const current = await f.application.readResolutionLearningSource(f.actors.staff, learningTicketId);
      expect(current.sourceGeneration).toBeGreaterThan(accepted.sourceGeneration);
      const history = await f.rows();
      expect((await runtime.enroll(f.actors.staff, structuredClone(packet))).sourceGeneration).toBe(0);
      expect(calls).toBe(2); expect(await f.rows()).toEqual(history);
      expect(await f.application.readResolutionLearningSource(f.actors.staff, learningTicketId)).toEqual(current);
    } finally { authorityWait.release(); wait.release(); vi.useRealTimers(); }
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

  it('makes missing independent checks explicitly unavailable for a real review while leaving private reads enabled', async () => {
    const f = await fixture(); await f.enrollAndVerify();
    const { source, work, articleId } = await f.delivered();
    const draft = await f.knowledge.getDraft(f.actors.staff, { articleId });
    const provenance = await f.knowledge.getProvenance(f.actors.staff, { articleId });
    const policy = await f.ports.checks.resolvePolicy(undefined, new AbortController().signal);
    if (policy.outcome !== 'ready') throw new Error('Synthetic checks unavailable');
    const packet = { ticketId: learningTicketId, clientCommandId: 'missing-checks-exact-review',
      sourceGeneration: source.sourceGeneration, expectedWorkGeneration: work.workGeneration,
      target: await learningTargetBinding(draft.revision, provenance.snapshot),
      decision: 'approve' as const, policyVersion: policy.policy.version };
    const { checks, ...ports } = f.ports; expect(checks).toBeDefined();
    const runtime = createSupportLearningRuntime({ application: f.application, knowledge: f.knowledge,
      sources: f.sources, clock: f.clock, ports, processingEnabled: () => false,
      staffAccess: { resolve: (id) => f.resolve(id) } });
    const before = await f.rows();
    expect(await runtime.readSource(f.actors.staff, learningTicketId)).toEqual(source);
    await expect(runtime.reviewProposal(f.actors.staff, packet)).rejects.toMatchObject({
      code: 'support_learning_unavailable', reason: 'review_checks_unavailable',
    });
    expect(await f.rows()).toEqual(before);
    // The same exact live target succeeds through the actual independent checks.
    expect((await f.runtime.reviewProposal(f.actors.staff, packet)).sourceGeneration).toBe(source.sourceGeneration);
    expect((await f.rows()).filter((row) => row.kind === 'resolution_learning_review')).toHaveLength(1);
  });

  it('propagates the staff deadline to SDK review guards and never approves after a delayed actual target read', async () => {
    const f = await fixture(); await f.enrollAndVerify();
    const { source, work, articleId } = await f.delivered();
    const draft = await f.knowledge.getDraft(f.actors.staff, { articleId });
    const provenance = await f.knowledge.getProvenance(f.actors.staff, { articleId });
    const policy = await f.ports.checks.resolvePolicy(undefined, new AbortController().signal);
    if (policy.outcome !== 'ready') throw new Error('Synthetic checks unavailable');
    const packet = { ticketId: learningTicketId, clientCommandId: 'deadline-review-exact',
      sourceGeneration: source.sourceGeneration, expectedWorkGeneration: work.workGeneration,
      target: await learningTargetBinding(draft.revision, provenance.snapshot),
      decision: 'approve' as const, policyVersion: policy.policy.version };
    const entered = barrier(); const wait = barrier(); const returned = barrier();
    let reviewCalls = 0; let policySignal: AbortSignal | undefined;
    const runtime = createSupportLearningRuntime({
      application: { ...f.application, async reviewResolutionLearningProposal(...args) {
        reviewCalls += 1; return f.application.reviewResolutionLearningProposal(...args);
      } },
      knowledge: { ...f.knowledge, async getDraft(...args) {
        const result = await f.knowledge.getDraft(...args);
        entered.release(); await wait.reached; returned.release(); return result;
      } },
      sources: f.sources, clock: f.clock, staffOperationMilliseconds: 1000,
      ports: { ...f.ports, checks: { ...f.ports.checks, async resolvePolicy(...args) {
        policySignal = args[1]; return f.ports.checks.resolvePolicy(...args);
      } } },
      staffAccess: { resolve: (id) => f.resolve(id) },
    });
    const before = await f.rows();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const result = runtime.reviewProposal(f.actors.staff, packet).catch((error: unknown) => error);
      await entered.reached; await vi.advanceTimersByTimeAsync(1000);
      expect(await result).toMatchObject({ reason: 'staff_deadline' });
      expect(policySignal?.aborted).toBe(true);
      wait.release(); await returned.reached; await vi.advanceTimersByTimeAsync(0);
      expect(reviewCalls).toBe(0); expect(await f.rows()).toEqual(before);
      expect(f.state.modelCalls).toBe(1);
    } finally { wait.release(); vi.useRealTimers(); }
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

  it('preserves actual aligned KB015 missing-draft identity and public coordinator target_unavailable', async () => {
    const f = await fixture();
    const port = createSupportLearningKnowledgePort(f.knowledge);
    await expect(f.knowledge.getDraft(f.actors.admin, { articleId: 'missing-guide' })).rejects.toBeInstanceOf(KnowledgeBaseNotFoundError);
    await expect(port.getDraft(f.actors.admin, { articleId: 'missing-guide' })).rejects.toBeInstanceOf(KnowledgeBaseNotFoundError);
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
    } }).getDraft(f.actors.admin, { articleId })).rejects.toBeInstanceOf(RepositoryConflictError);
    await f.runtime.withdraw(f.actors.staff, { ticketId: learningTicketId,
      clientCommandId: 'withdraw-before-conflict', reason: 'privacy_withdrawal' });
    expect((await f.runtime.reconcileSource(learningTicketId)).outcome).toBe('reconciled');
    expect(injected).toBe(true); expect(reads).toBeGreaterThan(1);
    expect(f.state.modelCalls).toBe(1);
  });
});
