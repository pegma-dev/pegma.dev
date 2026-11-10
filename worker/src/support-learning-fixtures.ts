import { hasPermission, resolveAccess, type AccessContext } from '@pegma/authorization-core';
import { createRoleStore } from '@pegma/authorization-storage';
import {
  createKnowledgeBaseApplication,
  createKnowledgeEvidenceReports,
  type KnowledgeBaseApplication,
} from '@pegma/knowledge-base-application';
import { articleKinds, knowledgePermissions } from '@pegma/knowledge-base-contracts';
import type { EvidenceSubmission } from '@pegma/knowledge-base-core';
import type { Store } from '@pegma/storage-core';
import {
  learningTargetBinding,
  type LearningChecksPort,
  type LearningModelInput,
  type LearningModelPort,
  type VerifiedLearningConfiguration,
} from '@pegma/support-desk-ai';
import {
  createSupportDeskApplication,
  supportPermissions,
  supportRecords,
  type ResolutionLearningChecksBinding,
} from '@pegma/support-desk-application';
import { isDeepStrictEqual } from 'node:util';
import { KNOWLEDGE_EVIDENCE_CONFIRM_PERMISSION } from './support-access';
import {
  createSupportLearningRuntime,
  createSupportLearningSourceBridge,
  supportLearningApplicationOptions,
  type LearningVerifiedFixPacket,
} from './support-learning';
import type { DirectLearningKnowledge, SupportLearningProcessingPorts } from './support-learning-ports';

export const learningCanary = 'SYNTHETIC_PRIVATE_LEARNING_NOTE';
export const learningTicketId = 'learning-ticket';
const collectionId = 'learning-guides';
const audience = 'fixture.learning.audience';
const scope = { kind: 'application' } as const;
const principalIds = {
  admin: 'fixture-learning-admin',
  staff: 'fixture-learning-staff',
  runner: 'fixture-learning-runner',
  supportService: 'fixture-learning-support-service',
  knowledgeService: 'fixture-learning-draft-service',
  retirementService: 'fixture-learning-retirement-service',
  customer: 'fixture-learning-customer',
} as const;
type Actor = keyof typeof principalIds;

/** Actual audited role assignments are read again for every authority resolve. */
export async function createSupportLearningFixture(
  store: Store,
  options: { readonly intake?: boolean; readonly processing?: boolean } = {},
) {
  let milliseconds = Date.parse('2026-11-10T12:00:00.000Z');
  const clock = { now: () => new Date(milliseconds).toISOString() };
  let ordinal = 0;
  const command = (label: string, expectedGeneration = 0) => ({
    commandId: `fixture-learning-${label}-${++ordinal}`,
    correlationId: 'fixture-learning',
    expectedGeneration,
  });
  const sourceRead = [supportPermissions.learningRead, supportPermissions.queueRead];
  const rolePermissions: Record<Actor, readonly string[]> = {
    admin: [...Object.values(knowledgePermissions), ...Object.values(supportPermissions), audience, KNOWLEDGE_EVIDENCE_CONFIRM_PERMISSION],
    staff: [...sourceRead, supportPermissions.learningEvidenceSubmit, supportPermissions.learningReview,
      supportPermissions.learningWithdraw, supportPermissions.replyAny, supportPermissions.note,
      supportPermissions.manage, knowledgePermissions.collectionRead, knowledgePermissions.articleRead,
      knowledgePermissions.draftRead, knowledgePermissions.draftWrite, knowledgePermissions.provenanceRead,
      knowledgePermissions.evidenceRead, knowledgePermissions.evidenceSubmit, knowledgePermissions.review,
      knowledgePermissions.reviewSubmit, knowledgePermissions.publish, KNOWLEDGE_EVIDENCE_CONFIRM_PERMISSION],
    runner: [...sourceRead, knowledgePermissions.collectionRead, knowledgePermissions.draftRead,
      knowledgePermissions.provenanceRead, knowledgePermissions.evidenceSubmit, knowledgePermissions.reviewSubmit],
    supportService: [...sourceRead, supportPermissions.learningProcess],
    knowledgeService: [...sourceRead, knowledgePermissions.collectionRead, knowledgePermissions.articleRead,
      knowledgePermissions.draftRead, knowledgePermissions.draftWrite, knowledgePermissions.provenanceRead,
      knowledgePermissions.provenanceWrite, audience],
    retirementService: [...sourceRead, supportPermissions.learningProcess,
      knowledgePermissions.collectionRead, knowledgePermissions.draftRead,
      knowledgePermissions.provenanceRead, knowledgePermissions.retire],
    customer: [supportPermissions.create, supportPermissions.readOwn, supportPermissions.replyOwn,
      knowledgePermissions.articleRead, audience],
  };
  const policy = { version: 'synthetic-learning-fixture-v1', roles: rolePermissions };
  const roles = createRoleStore(store, 'pegma-learning-fixture');
  for (const actor of Object.keys(principalIds) as Actor[]) {
    const result = await roles.grantRoleAssignmentWithAudit({
      assignment: {
        id: `fixture-learning-role-${actor}`, principalId: principalIds[actor], role: actor,
        scope, grantedBy: { kind: 'system', systemId: 'synthetic-learning-fixture' },
        grantedAtEpochMs: milliseconds, status: 'active',
      },
      auditEventId: `fixture-learning-role-grant-${actor}`,
    });
    if (result.status !== 'granted') throw new Error('Synthetic role grant failed');
  }
  async function resolve(principalId: string): Promise<AccessContext> {
    const assignments = await roles.listActiveRoleAssignments(principalId, scope);
    return resolveAccess({ principalId, roles: assignments.map((entry) => entry.role) }, policy);
  }
  const actors = {
    admin: await resolve(principalIds.admin), staff: await resolve(principalIds.staff),
    runner: await resolve(principalIds.runner), customer: await resolve(principalIds.customer),
  };
  const state = {
    enabled: options.processing ?? true,
    product: 'ready' as 'ready' | 'missing' | 'expired',
    check: 'checked' as 'checked' | 'held',
    checkReadable: true,
    explicitDraftIds: [] as string[],
    modelCalls: 0,
    modelInputs: [] as LearningModelInput[],
    beforeModelReturn: undefined as (() => Promise<void>) | undefined,
    beforeStaffResolve: undefined as (() => Promise<void>) | undefined,
  };
  const product = { productId: 'synthetic-workspace', productVersion: '1.0.0', buildId: 'synthetic-build-1' };
  const candidate = {
    problem: 'Export a workspace.',
    applicability: { productId: product.productId, version: product.productVersion, buildId: product.buildId },
    steps: ['Open Workspace.', 'Choose Export.'],
    solution: 'Download and verify the workspace export.',
    validationRequirements: ['Verify the exported file opens.'],
  };
  const policyStamp = {
    version: 'synthetic-learning-check-policy-v1', binding: 'synthetic-independent-learning-checks',
    verifiedAt: clock.now(), validUntil: new Date(milliseconds + 3_600_000).toISOString(),
  };
  const checkReceipts = new Map<string, ResolutionLearningChecksBinding>();
  const checks: LearningChecksPort = {
    async resolvePolicy(expected) {
      return expected !== undefined && expected !== policyStamp.version
        ? { outcome: 'unavailable' } : { outcome: 'ready', policy: structuredClone(policyStamp) };
    },
    async check(input) {
      if (state.check !== 'checked') return { outcome: 'held' };
      const receipt = `synthetic-independent-learning-check-${++ordinal}`;
      checkReceipts.set(receipt, structuredClone(input.binding));
      return { outcome: 'checked', receipt };
    },
    async verify(receipt, binding) {
      if (!state.checkReadable || !isDeepStrictEqual(checkReceipts.get(receipt), binding)) return null;
      return {
        binding: structuredClone(binding), privacy: 'passed', factual: 'passed', applicability: 'passed', duplication: 'passed',
        verifierReceiptId: receipt, verifierVersion: 'synthetic-independent-checker-v1',
        verifiedAt: clock.now(), validUntil: policyStamp.validUntil,
      };
    },
  };
  const application = createSupportDeskApplication({
    store, clock,
    resolutionLearning: supportLearningApplicationOptions({
      enabled: options.intake ?? true,
      checks,
      productContext: {
        async resolve(context) {
          if (state.product === 'missing') return null;
          return {
            productId: product.productId, version: product.productVersion, buildId: product.buildId,
            binding: 'synthetic-workspace-build-1', contextVersion: 'synthetic-product-context-v1',
            receiptId: `synthetic-product-${context.ticketId}-${context.resolutionCycle}`,
            verifiedAt: context.acceptedAt,
            validUntil: new Date(Date.parse(context.acceptedAt) + (state.product === 'expired' ? -1 : 60_000)).toISOString(),
          };
        },
      },
    }),
  });
  const serviceAccess: SupportLearningProcessingPorts['serviceAccess'] = {
    async resolve() {
      return { outcome: 'ready', authority: {
        access: await resolve(principalIds.supportService), authorityVersion: 'synthetic-support-authority-v1',
        usageScopeRef: 'synthetic-learning-only-usage',
      } };
    },
  };
  const sources = createSupportLearningSourceBridge({ application, serviceAccess, reviewPolicy: checks, clock });
  let knowledge: KnowledgeBaseApplication;
  const reports = createKnowledgeEvidenceReports({
    store, clock, collectionName: 'synthetic-support-learning-reports.v1',
    confirmationPermission: KNOWLEDGE_EVIDENCE_CONFIRM_PERMISSION,
    resolvePrincipal: resolve,
    async readContext(access, articleId) {
      const result = await knowledge.getAuthoringContext(access, {
        articleId, includeEvidence: hasPermission(access, knowledgePermissions.evidenceRead),
      });
      return result.context;
    },
  });
  knowledge = createKnowledgeBaseApplication({ store, clock, privateSources: sources, evidenceVerifier: reports.verifier });
  const configuration: VerifiedLearningConfiguration = {
    purpose: 'support_learning', version: 'synthetic-learning-config-v1', promptVersion: 'synthetic-learning-prompt-v1',
    modelVersion: 'synthetic-learning-model-v1', provider: 'synthetic-learning-provider', model: 'synthetic-learning-model',
    pricingRef: 'synthetic-learning-pricing', trustedInstructions: 'Generalize the visible verified solution.', framingTokens: 20,
    budgets: { maxMessages: 20, maxInputBytes: 32_768, maxInputTokens: 32_768, maxContextTokens: 65_536,
      maxOutputBytes: 16_000, maxOutputTokens: 8_192, maxCandidateBytes: 16_000, maxDurationMilliseconds: 5_000,
      maxCostMicros: 10_000, currency: 'USD', maxAttempts: 2 },
    dataControls: { status: 'verified', purpose: 'support_learning', configurationBinding: 'synthetic-learning-config-v1',
      accountRef: 'synthetic-account', projectRef: 'synthetic-project', endpointRef: 'synthetic-endpoint',
      modelRef: 'synthetic-model', featuresRef: 'synthetic-features', exceptionsRef: 'synthetic-exceptions', intermediaryRefs: [],
      verifiedAt: clock.now(), validUntil: new Date(milliseconds + 3_600_000).toISOString() },
  };
  let generate: LearningModelPort['generate'] = async (input) => {
    state.modelCalls += 1; state.modelInputs.push(structuredClone(input));
    await state.beforeModelReturn?.();
    return { outputJson: JSON.stringify(candidate), provider: configuration.provider, model: configuration.model,
      requestId: 'synthetic-learning-request', usage: { inputTokens: 100, outputTokens: 50, costMicros: 10, currency: 'USD' } };
  };
  const ports: SupportLearningProcessingPorts = {
    serviceAccess,
    knowledgeAccess: { async resolve() { return { outcome: 'ready', authority: {
      access: await resolve(principalIds.knowledgeService), authorityVersion: 'synthetic-draft-authority-v1' } }; } },
    retirementAccess: { async resolve() { return { outcome: 'ready', authority: {
      access: await resolve(principalIds.retirementService), authorityVersion: 'synthetic-retirement-authority-v1' } }; } },
    configuration: { async resolve() { return { outcome: 'ready', configuration: structuredClone(configuration) }; } },
    checks,
    model: { generate: (...args) => generate(...args) },
    usage: { async reserve(context) { return { outcome: 'reserved', usageReservationId: context.usageReservationId }; },
      async reconcile() { return 'reconciled'; } },
    tokenCounter: { count: (text) => new TextEncoder().encode(text).byteLength },
    targets: {
      async resolveScope() {
        return { outcome: 'ready', scope: { version: 'synthetic-learning-target-v1', collectionId,
          kind: 'explanation', searchQuery: 'workspace export', explicitDraftIds: [...state.explicitDraftIds] } };
      },
      async select(input) {
        return { outcome: 'selected', operation: 'create', articleId: input.newArticleId,
          draft: { kind: 'explanation', title: 'Export your workspace', summary: 'Download and verify an export.',
            content: { format: 'plain_text', text: [input.candidate.problem, ...input.candidate.steps,
              input.candidate.solution, ...input.candidate.validationRequirements].join('\n\n') },
            tags: ['export'], applicability: product } };
      },
    },
  };
  let directKnowledge: DirectLearningKnowledge = knowledge;
  const runtimeFor = () => createSupportLearningRuntime({
    application, knowledge: directKnowledge, sources, clock, ports,
    processingEnabled: () => state.enabled,
    staffAccess: { async resolve(id) { await state.beforeStaffResolve?.(); return resolve(id); } },
  });
  let runtime = runtimeFor();
  await knowledge.createCollection(actors.admin, { ...command('collection'), collectionId, name: 'Synthetic learned guides' });
  const validation = { id: 'synthetic-learning-validation', version: 1,
    requirements: [...articleKinds.map((kind) => ({ id: `${kind}-content`, kind, testKind: 'content' as const,
      maxAgeMilliseconds: 3_600_000, trustedRunnerIds: [principalIds.runner] })),
      { id: 'walkthrough-workflow', kind: 'walkthrough' as const, testKind: 'workflow' as const,
        maxAgeMilliseconds: 3_600_000, trustedRunnerIds: [principalIds.runner] }] };
  await knowledge.putValidationPolicy(actors.admin, { ...command('policy'), policy: validation });
  const collection = await knowledge.getCollection(actors.admin, { collectionId });
  await knowledge.putGovernanceConfiguration(actors.admin, { ...command('governance', collection.generation), collectionId,
    configuration: { validationPolicy: { id: validation.id, version: 1 }, expectedStagingBuildId: product.buildId,
      trustedAttesterIds: [principalIds.staff] } });
  const preview = await knowledge.previewCollectionPolicy(actors.admin, { collectionId,
    uses: { portal: { enabled: true, audience: { kind: 'permission', permission: audience } },
      bot: { enabled: true, audience: { kind: 'permission', permission: audience } } } });
  await knowledge.updateCollectionPolicy(actors.admin, { ...command('audience', preview.generation), collectionId, preview: preview.preview });

  async function terminal() {
    // Existing unenrolled ticket: explicit enrollment must not rewrite history.
    const oldApplication = createSupportDeskApplication({ store, clock });
    await oldApplication.createCustomerTicket(actors.customer, { ...command('ticket'), ticketId: learningTicketId,
      messageId: 'learning-question', subject: 'Synthetic workspace export', body: 'How do I export a workspace?' });
    await oldApplication.replyAsStaff(actors.staff, { ...command('solution'), ticketId: learningTicketId,
      messageId: 'learning-solution', body: 'Open Workspace and choose Export.' });
    await oldApplication.addNote(actors.staff, { ...command('note'), ticketId: learningTicketId,
      messageId: 'learning-note', body: learningCanary });
    await oldApplication.resolveTicket(actors.staff, { ...command('resolve'), ticketId: learningTicketId });
    return (await oldApplication.readStaffTicket(actors.staff, learningTicketId)).ticket;
  }
  async function enrollAndVerify(): Promise<LearningVerifiedFixPacket> {
    const ticket = await terminal();
    await runtime.enroll(actors.staff, { clientCommandId: 'ENROLL-EXACT-1', ticketId: learningTicketId, expectedRevision: ticket.revision });
    const source = await runtime.readSource(actors.staff, learningTicketId);
    const packet: LearningVerifiedFixPacket = { clientCommandId: 'VERIFY-EXACT-1', ticketId: learningTicketId,
      expectedRevision: ticket.revision, resolutionCycle: source.resolutionCycle,
      evidence: { kind: 'staff_verified_fix', solutionMessageId: 'learning-solution', verificationReference: 'SYNTHETIC_PRIVATE_VERIFICATION' } };
    await runtime.submitVerifiedFix(actors.staff, packet);
    return packet;
  }
  async function process() {
    const source = await runtime.readSource(actors.staff, learningTicketId);
    return runtime.processWork({ ticketId: learningTicketId, sourceGeneration: source.sourceGeneration,
      workerId: 'synthetic-learning-worker', leaseMilliseconds: 30_000 });
  }
  async function delivered() {
    const generated = await process();
    if (generated.outcome !== 'candidate') throw new Error(`Learning candidate unavailable: ${generated.outcome}`);
    const result = await process();
    if (result.outcome !== 'delivered') throw new Error(`Learning draft unavailable: ${result.outcome}`);
    const source = await runtime.readSource(actors.staff, learningTicketId);
    const work = await runtime.readWork(actors.staff, { ticketId: learningTicketId, sourceGeneration: source.sourceGeneration });
    if (work.target === undefined) throw new Error('Actual delivered target missing');
    return { source, work, articleId: work.target.articleId };
  }
  async function review(articleId: string) {
    const source = await runtime.readSource(actors.staff, learningTicketId);
    const work = await runtime.readWork(actors.staff, { ticketId: learningTicketId, sourceGeneration: source.sourceGeneration });
    const draft = await knowledge.getDraft(actors.staff, { articleId });
    const provenance = await knowledge.getProvenance(actors.staff, { articleId });
    const packet = { clientCommandId: 'REVIEW-EXACT-1', ticketId: learningTicketId,
      sourceGeneration: source.sourceGeneration, expectedWorkGeneration: work.workGeneration,
      target: await learningTargetBinding(draft.revision, provenance.snapshot), decision: 'approve' as const,
      policyVersion: policyStamp.version };
    await runtime.reviewProposal(actors.staff, packet);
    return packet;
  }
  async function evidenceAndPublish(articleId: string) {
    const draft = await knowledge.getDraft(actors.runner, { articleId });
    const requirements = await knowledge.getValidationRequirements(actors.runner, {
      collectionId, kind: draft.revision.kind,
    });
    for (const check of requirements.checks) {
      const current = await knowledge.getDraft(actors.runner, { articleId });
      const evidence: EvidenceSubmission = { id: `synthetic-learning-evidence-${++ordinal}`, articleId,
        articleRevision: current.revision.number, contentHash: current.revision.contentHash,
        validationPolicy: current.revision.validationPolicy, checkId: check.id, testKind: check.testKind,
        applicability: current.revision.applicability, stagingBuildId: requirements.expectedStagingBuildId,
        steps: ['Open the synthetic workspace.', 'Export and verify the file.'], result: 'passed', executedAt: clock.now(),
        runnerId: principalIds.runner, artifacts: [{ id: 'synthetic-export-artifact', hash: 'a'.repeat(64) }] };
      const ledger = await reports.ledger(actors.runner, { articleId });
      const reported = await reports.report(actors.runner, { commandId: `synthetic-report-${ordinal}`, articleId,
        ledgerEpoch: ledger.ledgerEpoch, evidence, report: { summary: 'Synthetic export passed', details: 'The exported synthetic fixture opened.' } });
      const key = { articleId, ledgerEpoch: reported.ledgerEpoch, reportId: reported.reportId };
      const viewed = await reports.read(actors.staff, key);
      const confirmed = await reports.decide(actors.staff, { ...key, commandId: `synthetic-confirm-${ordinal}`,
        expectedReportGeneration: viewed.expectedReportGeneration, reviewBindingHash: viewed.reviewBindingHash }, 'confirmed');
      await knowledge.submitEvidence(actors.runner, { ...command('submit-evidence', current.generation), articleId,
        evidence, receipt: confirmed.receipt });
    }
    const current = await knowledge.getDraft(actors.runner, { articleId });
    await knowledge.submitForReview(actors.runner, { ...command('submit-review', current.generation), articleId });
    const reviewed = await knowledge.getReview(actors.staff, { articleId });
    await knowledge.publishArticle(actors.staff, { ...command('publish', reviewed.generation), articleId, review: reviewed.review });
    return knowledge.getPublishedArticle(actors.customer, { articleId });
  }
  return {
    store, clock, application, knowledge, reports, sources, actors, state, ports, product, candidate, command,
    get runtime() { return runtime; },
    resolve, terminal, enrollAndVerify, process, delivered, review, evidenceAndPublish,
    rows: () => store.collection(supportRecords).list(learningTicketId),
    advance: (amount: number) => { milliseconds += amount; },
    setKnowledge(port: DirectLearningKnowledge) { directKnowledge = port; runtime = runtimeFor(); },
    setModel(value: LearningModelPort['generate']) { generate = value; },
    async revokeStaff() {
      const role = await roles.getRoleAssignment('fixture-learning-role-staff');
      if (role === null) throw new Error('Synthetic staff role absent');
      return roles.revokeRoleAssignmentWithAudit({ assignmentId: 'fixture-learning-role-staff',
        expectedConcurrencyToken: role.concurrencyToken, revokedBy: { kind: 'system', systemId: 'synthetic-learning-fixture' },
        revokedAtEpochMs: milliseconds, auditEventId: 'synthetic-learning-staff-revoke' });
    },
  };
}

export type SupportLearningFixture = Awaited<ReturnType<typeof createSupportLearningFixture>>;
