import { resolveAccess } from '@pegma/authorization-core';
import { createRoleStore } from '@pegma/authorization-storage';
import type { Store } from '@pegma/storage-core';
import { isDeepStrictEqual } from 'node:util';
import {
  createSupportDeskApplication, supportPermissions, supportRecords,
  type EngineeringCandidate, type EngineeringDispatchProofBinding,
  type EngineeringExportRequest, type EngineeringIssueAcknowledgement,
  type EngineeringKey, type EngineeringRepositoryDescriptor,
  type EngineeringRepositoryObservation, type EngineeringSecurity,
  type VerifiedEngineeringDispatchResult, type VerifiedEngineeringExportChecks,
  type VerifiedEngineeringRouting,
} from '@pegma/support-desk-application';
import type {
  EngineeringChecksPort, EngineeringGitHubPort, EngineeringModelInput,
  EngineeringProposalPort, EngineeringRoutingPort, VerifiedEngineeringConfiguration,
} from '@pegma/support-desk-ai';
import {
  createSupportEngineeringRuntime, supportEngineeringApplicationOptions,
  type EngineeringFailurePacket,
} from './support-engineering';
import type { SupportEngineeringPorts } from './support-engineering-ports';

export const engineeringTicketId = 'engineering-ticket';
export const engineeringCanary = 'SYNTHETIC_PRIVATE_ENGINEERING_NOTE';
export const engineeringProofReference = 'SYNTHETIC_PRIVATE_FAILURE_REFERENCE';
const scope = { kind: 'application' } as const;
type Actor = 'customer' | 'staff' | 'security' | 'admin' | 'processor' | 'reconciler';
export const engineeringRepositories: readonly EngineeringRepositoryDescriptor[] = [
  { repositoryId: 'synthetic-repository-101', owner: 'synthetic-org', name: 'workspace-core', visibility: 'public',
    responsibilities: 'Workspace export creation and file generation.', product: 'workspace', component: 'export',
    version: '2.x', allowedLabels: ['bug', 'export'], allowedTemplates: ['bug-report'], publicationMode: 'approval_required', enabled: true },
  { repositoryId: 'synthetic-repository-202', owner: 'synthetic-org', name: 'workspace-api', visibility: 'private',
    responsibilities: 'Workspace export requests and downloads.', product: 'workspace', component: 'api',
    version: '2.x', allowedLabels: ['bug'], allowedTemplates: ['bug-report'], publicationMode: 'approval_required', enabled: true },
];

/** Real SDK persistence/roles; only trusted external systems are fictional. */
export async function createSupportEngineeringFixture(store: Store, options: {
  readonly intake?: boolean; readonly processing?: boolean;
  readonly repositories?: readonly EngineeringRepositoryDescriptor[];
} = {}) {
  const selectedRepositories = options.repositories ?? engineeringRepositories;
  let milliseconds = Date.parse('2026-11-10T12:00:00.000Z');
  const clock = { now: () => new Date(milliseconds).toISOString() };
  let ordinal = 0;
  const next = (label: string) => 'synthetic-engineering-' + label + '-' + ++ordinal;
  const command = (label: string) => ({ commandId: next(label), correlationId: 'synthetic-engineering-fixture' });
  const ordinary = [supportPermissions.queueRead, supportPermissions.engineeringRead,
    supportPermissions.engineeringEvidenceSubmit, supportPermissions.engineeringReview,
    supportPermissions.engineeringWithdraw, supportPermissions.engineeringPolicyRead,
    supportPermissions.replyAny, supportPermissions.note, supportPermissions.manage];
  const permissions: Record<Actor, readonly string[]> = {
    customer: [supportPermissions.create, supportPermissions.readOwn, supportPermissions.replyOwn],
    staff: ordinary,
    security: [...ordinary, supportPermissions.engineeringRestrictedRead, supportPermissions.engineeringSecurityReview],
    admin: [supportPermissions.queueRead, supportPermissions.engineeringPolicyRead, supportPermissions.engineeringPolicyManage],
    processor: [supportPermissions.queueRead, supportPermissions.engineeringRead, supportPermissions.engineeringProcess],
    reconciler: [supportPermissions.queueRead, supportPermissions.engineeringRead, supportPermissions.engineeringReconcile],
  };
  const roleStore = createRoleStore(store, 'pegma-engineering-fixture');
  const policy = { version: 'synthetic-engineering-fixture-v1', roles: permissions };
  for (const actor of Object.keys(permissions) as Actor[]) await roleStore.grantRoleAssignmentWithAudit({
    assignment: { id: 'engineering-role-' + actor, principalId: 'engineering-' + actor, role: actor, scope,
      grantedBy: { kind: 'system', systemId: 'synthetic-engineering-fixture' }, grantedAtEpochMs: milliseconds, status: 'active' },
    auditEventId: 'engineering-grant-' + actor,
  });
  async function resolve(principalId: string) {
    const assignments = await roleStore.listActiveRoleAssignments(principalId, scope);
    return resolveAccess({ principalId, roles: assignments.map((row) => row.role) }, policy);
  }
  const actors = { customer: await resolve('engineering-customer'), staff: await resolve('engineering-staff'),
    security: await resolve('engineering-security'), admin: await resolve('engineering-admin') };
  const state = {
    enabled: options.processing ?? true,
    product: 'ready' as 'ready' | 'missing' | 'expired',
    configuration: 'ready' as 'ready' | 'disabled',
    calibrationReady: true,
    calibrationPolicyHash: '',
    routing: 'checked' as 'checked' | 'human_required' | 'restricted',
    checks: 'checked' as 'checked' | 'held' | 'restricted',
    checksReadable: true,
    publicReproduction: 'passed' as 'passed' | 'not_applicable',
    modelSecurity: 'ordinary' as EngineeringSecurity,
    modelRouting: 'selected' as 'selected' | 'ambiguous' | 'out_of_scope',
    modelRepositoryId: selectedRepositories[0]!.repositoryId,
    modelCalls: 0,
    modelInputs: [] as EngineeringModelInput[],
    modelHook: undefined as (() => Promise<void>) | undefined,
    duplicateQuery: 'workspace export empty file' as string | null,
    duplicates: [] as Awaited<ReturnType<EngineeringGitHubPort['searchDuplicates']>>['issues'],
    searches: [] as Parameters<EngineeringGitHubPort['searchDuplicates']>[0][],
    linkExisting: false,
    createMode: 'accept' as 'accept' | 'accept_then_lose' | 'unknown',
    reconciliation: 'known' as 'known' | 'unknown',
    creates: [] as EngineeringExportRequest[],
    reservations: [] as string[],
    accounting: [] as string[],
    installationActive: true,
  };
  const validUntil = new Date(milliseconds + 3_600_000).toISOString();
  const metadata = new Map<string, EngineeringRepositoryObservation>(selectedRepositories.map((repository) => [repository.repositoryId,
    { repositoryId: repository.repositoryId, owner: repository.owner, name: repository.name, visibility: repository.visibility,
      installationBinding: 'synthetic-installation-' + repository.repositoryId, metadataVersion: 'synthetic-metadata-v1' }]));
  const issuedRouting = new Map<string, VerifiedEngineeringRouting>();
  const issuedChecks = new Map<string, VerifiedEngineeringExportChecks>();
  const issuedDispatch: VerifiedEngineeringDispatchResult[] = [];
  const remote = new Map<string, { acknowledgement: EngineeringIssueAcknowledgement; binding: EngineeringDispatchProofBinding }>();
  const routing: EngineeringRoutingPort = {
    async resolve() {
      if (!state.calibrationReady) return { outcome: 'unavailable' };
      return { outcome: 'ready', calibration: { version: 'synthetic-calibration-v1', artifactRef: 'synthetic-calibration-artifact',
        rubricVersion: 'synthetic-rubric-v1', evaluationRef: 'synthetic-labeled-evaluation', modelVersion: 'synthetic-model-v1',
        promptVersion: 'synthetic-prompt-v1', parserVersion: 'synthetic-parser-v1', policyHash: state.calibrationPolicyHash,
        verifiedAt: clock.now(), validUntil } };
    },
    async check({ binding }) {
      if (state.routing !== 'checked') return { outcome: state.routing };
      const receipt = next('routing');
      issuedRouting.set(receipt, { binding: structuredClone(binding), outcome: 'accepted', verifierReceiptId: receipt,
        verifierVersion: 'synthetic-routing-verifier-v1', verifiedAt: clock.now(), validUntil });
      return { outcome: 'checked', receipt };
    },
    async verify(receipt, binding) {
      const proof = issuedRouting.get(receipt);
      return proof !== undefined && isDeepStrictEqual(proof.binding, binding) ? structuredClone(proof) : null;
    },
  };
  const checks: EngineeringChecksPort = {
    async resolvePolicy() { return { outcome: 'ready', policy: { version: 'synthetic-check-policy-v1',
      binding: 'synthetic-independent-check-binding', verifiedAt: clock.now(), validUntil } }; },
    async check({ binding, exactRequest }) {
      if (state.checks !== 'checked') return { outcome: state.checks };
      if (JSON.stringify(exactRequest).includes(engineeringCanary) || JSON.stringify(exactRequest).includes(engineeringProofReference))
        return { outcome: 'held' };
      const receipt = next('check');
      issuedChecks.set(receipt, { binding: structuredClone(binding), privacy: 'passed', factual: 'passed', security: 'clear',
        publicReproduction: exactRequest.repository.visibility === 'public' ? state.publicReproduction : 'not_applicable',
        verifierReceiptId: receipt, verifierVersion: 'synthetic-check-verifier-v1', verifiedAt: clock.now(), validUntil });
      return { outcome: 'checked', receipt };
    },
    async verify(receipt, binding) {
      const proof = issuedChecks.get(receipt);
      return state.checksReadable && proof !== undefined && isDeepStrictEqual(proof.binding, binding) ? structuredClone(proof) : null;
    },
  };
  const application = createSupportDeskApplication({ store, clock, engineering: supportEngineeringApplicationOptions({
    enabled: options.intake ?? true, maxModelAttempts: 1, routing, checks,
    productContext: { async resolve(context, signal) {
      if (signal.aborted || state.product === 'missing') return null;
      return { productId: 'workspace', version: '2.3.0', buildId: 'synthetic-build-230', binding: 'synthetic-workspace-230-binding',
        contextVersion: 'synthetic-product-context-v1', receiptId: next('product'), verifiedAt: context.acceptedAt,
        validUntil: state.product === 'expired' ? new Date(milliseconds - 1).toISOString() : validUntil };
    } },
    repositoryMetadata: { async resolve(id, signal) {
      const observation = metadata.get(id);
      return signal.aborted || !state.installationActive || observation === undefined ? null : structuredClone(observation);
    } },
    dispatchResults: { async verify(binding, signal) {
      const proof = issuedDispatch.find((item) => isDeepStrictEqual(item.binding, binding));
      return signal.aborted || proof === undefined ? null : structuredClone(proof);
    } },
  }) });
  function dispatchProof(binding: EngineeringDispatchProofBinding) {
    const value: VerifiedEngineeringDispatchResult = { binding: structuredClone(binding), verifierReceiptId: next('dispatch-proof'),
      verifierVersion: 'synthetic-github-verifier-v1', verifiedAt: clock.now(), validUntil };
    issuedDispatch.push(value);
  }
  const github: EngineeringGitHubPort = {
    async getMetadata(id) {
      const repository = metadata.get(id);
      return !state.installationActive || repository === undefined ? null : { repository: structuredClone(repository),
        authority: { active: true, binding: repository.installationBinding, validUntil } };
    },
    async searchDuplicates(input) {
      state.searches.push(structuredClone(input));
      return { issues: structuredClone(state.duplicates), physicalResults: state.duplicates.length };
    },
    async createIssue(request, context) {
      // The external fake checks the actual durable SDK dispatch first. It does
      // not create or edit any producer row or call a real GitHub endpoint.
      const work = await application.readEngineeringWork(actors.security, {
        ticketId: context.sourceFence.ticketId, sourceGeneration: context.sourceFence.sourceGeneration });
      if (work.dispatch?.dispatchId !== context.dispatchId || work.proposal === undefined ||
        work.dispatch.requestHash !== context.requestHash)
        throw new Error('Synthetic GitHub call preceded actual durable dispatch');
      state.creates.push(structuredClone(request));
      if (state.createMode === 'unknown') throw new Error('Synthetic unknown external acceptance');
      const acknowledgement = { repositoryId: request.repository.repositoryId, issueId: 'synthetic-issue-' + state.creates.length,
        issueNumber: state.creates.length };
      const binding: EngineeringDispatchProofBinding = { ...context.sourceFence, repositoryId: request.repository.repositoryId,
        repositoryMetadataHash: work.proposal.repositoryMetadataHash, dispatchId: context.dispatchId, requestHash: context.requestHash,
        exportMarker: request.bundle.exportMarker, operation: 'create_issue', result: { outcome: 'accepted', acknowledgement } };
      remote.set(request.bundle.exportMarker, { acknowledgement, binding }); dispatchProof(binding);
      if (state.createMode === 'accept_then_lose') throw new Error('Synthetic accepted response loss');
      return acknowledgement;
    },
    async reconcile(input) {
      if (state.reconciliation === 'unknown' || input.sourceFence === undefined || input.repositoryMetadataHash === undefined)
        return { outcome: 'unknown' };
      if (input.operation === 'link_existing_issue') {
        const issue = state.duplicates.find((row) => row.repositoryId === input.repositoryId && row.issueId === input.issueId && row.issueNumber === input.issueNumber);
        if (issue === undefined) return { outcome: 'unknown' };
        const acknowledgement = { repositoryId: issue.repositoryId, issueId: issue.issueId, issueNumber: issue.issueNumber };
        dispatchProof({ ...input.sourceFence, repositoryId: input.repositoryId, repositoryMetadataHash: input.repositoryMetadataHash,
          dispatchId: input.dispatchId, requestHash: input.requestHash, exportMarker: input.exportMarker,
          operation: 'link_existing_issue', result: { outcome: 'accepted', acknowledgement } });
        return { outcome: 'accepted', acknowledgement, proof: 'synthetic-existing-issue-proof' };
      }
      const accepted = remote.get(input.exportMarker);
      if (accepted === undefined || accepted.binding.repositoryId !== input.repositoryId || accepted.binding.dispatchId !== input.dispatchId ||
        accepted.binding.requestHash !== input.requestHash || accepted.binding.repositoryMetadataHash !== input.repositoryMetadataHash ||
        !isDeepStrictEqual(input.sourceFence, { ticketId: accepted.binding.ticketId, sourceGeneration: accepted.binding.sourceGeneration,
          sourceBindingHash: accepted.binding.sourceBindingHash })) return { outcome: 'unknown' };
      dispatchProof(accepted.binding);
      return { outcome: 'accepted', acknowledgement: structuredClone(accepted.acknowledgement), proof: 'synthetic-unique-acceptance-proof' };
    },
  };
  const configuration: VerifiedEngineeringConfiguration = { purpose: 'support_bug_assessment', version: 'synthetic-config-v1',
    promptVersion: 'synthetic-prompt-v1', modelVersion: 'synthetic-model-v1', parserVersion: 'synthetic-parser-v1',
    provider: 'synthetic-provider', model: 'synthetic-model', pricingRef: 'synthetic-price-v1',
    trustedInstructions: 'Assess only the verified fictional failure and allowed repositories.', framingTokens: 20,
    budgets: { maxMessages: 10, maxInputBytes: 32_768, maxInputTokens: 12_000, maxContextTokens: 16_000,
      maxOutputBytes: 16_000, maxOutputTokens: 1_500, maxCandidateBytes: 16_000, maxDurationMilliseconds: 5_000,
      maxCostMicros: 1_000, currency: 'USD', maxAttempts: 1, maxRepositories: 2, maxRepositoryBytes: 10_000 },
    dataControls: { status: 'verified', purpose: 'support_bug_assessment', configurationBinding: 'synthetic-config-v1',
      accountRef: 'synthetic-account', projectRef: 'synthetic-project', endpointRef: 'synthetic-endpoint',
      modelRef: 'synthetic-model-route', featuresRef: 'synthetic-features', exceptionsRef: 'synthetic-exceptions',
      intermediaryRefs: ['synthetic-intermediary'], verifiedAt: clock.now(), validUntil } };
  function candidate(): EngineeringCandidate {
    return { title: 'Workspace export produces an empty file', summary: 'A fictional workspace export omits its rows.',
      expectedBehavior: 'The export contains the workspace rows.', actualBehavior: 'The downloaded export is empty.',
      reproductionSteps: ['Create a fictional workspace with one row.', 'Export it and inspect the file.'],
      applicability: { productId: 'workspace', version: '2.3.0', buildId: 'synthetic-build-230' }, security: state.modelSecurity,
      routing: state.modelRouting === 'selected' ? { outcome: 'selected', repositoryId: state.modelRepositoryId,
        alternativeRepositoryIds: [], rationale: 'The allowlisted core owns file generation.' } : {
        outcome: state.modelRouting, alternativeRepositoryIds: selectedRepositories.map((row) => row.repositoryId),
        rationale: 'Staff must choose between the two allowed components.' } };
  }
  const proposals: EngineeringProposalPort = {
    async duplicateQuery() { return state.duplicateQuery; },
    async prepare(input) {
      const previous = input.previousRequest;
      const bundle = previous === undefined ? { title: input.candidate.title,
        body: [input.candidate.summary, 'Expected: ' + input.candidate.expectedBehavior,
          'Actual: ' + input.candidate.actualBehavior, ...input.candidate.reproductionSteps,
          'Export marker: ' + input.exportMarker].join('\n\n'), labels: ['bug'], templateId: 'bug-report',
        evidenceReferences: ['synthetic-approved-public-reproduction'], exportMarker: input.exportMarker } : {
        ...previous.bundle, body: previous.bundle.body.replaceAll(previous.bundle.exportMarker, input.exportMarker),
        exportMarker: input.exportMarker };
      if (state.linkExisting) {
        const issue = input.duplicates[0];
        if (issue === undefined) return { outcome: 'held' };
        return { outcome: 'prepared', request: { operation: 'link_existing_issue', repository: input.repository, bundle,
          issueId: issue.issueId, issueNumber: issue.issueNumber } };
      }
      return { outcome: 'prepared', request: { operation: 'create_issue', repository: input.repository, bundle } };
    },
  };
  const ports: SupportEngineeringPorts = {
    serviceAccess: { async resolve(signal) {
      if (signal.aborted) return { outcome: 'inactive' };
      return { outcome: 'ready', authority: { access: await resolve('engineering-processor'),
        authorityVersion: 'synthetic-processor-v1', usageScopeRef: 'synthetic-engineering-budget' } };
    } },
    reconciliationAccess: { async resolve(signal) {
      if (signal.aborted) return { outcome: 'inactive' };
      return { outcome: 'ready', authority: { access: await resolve('engineering-reconciler'),
        authorityVersion: 'synthetic-reconciler-v1', usageScopeRef: 'synthetic-engineering-reconciliation' } };
    } },
    configuration: { async resolve() { return state.configuration === 'ready'
      ? { outcome: 'ready', configuration: structuredClone(configuration) } : { outcome: 'disabled' }; } },
    routing, checks, github, proposals,
    model: { async generate(input, _context, configured) {
      state.modelCalls += 1; state.modelInputs.push(structuredClone(input)); await state.modelHook?.();
      return { outputJson: JSON.stringify(candidate()), provider: configured.provider, model: configured.model,
        requestId: 'synthetic-model-request', usage: { inputTokens: 100, outputTokens: 100, costMicros: 10, currency: 'USD' } };
    } },
    // Scripted external budget behavior only, not a host durable-budget claim.
    usage: { async reserve(context) { state.reservations.push(context.usageReservationId);
      return { outcome: 'reserved', usageReservationId: context.usageReservationId }; },
    async reconcile(_identity, observation) { state.accounting.push(observation.state); return 'reconciled'; } },
    tokenCounter: { count: (value) => Math.max(1, Math.ceil(new TextEncoder().encode(value).byteLength / 4)) },
  };
  const runtime = createSupportEngineeringRuntime({ application, clock, staffAccess: { resolve: (id) => resolve(id) },
    processingEnabled: () => state.enabled, ports });
  const initialPolicy = await runtime.putPolicy(actors.admin, { clientCommandId: 'POLICY-EXACT', expectedGeneration: 0,
    policy: { enabled: true, repositories: selectedRepositories } });
  state.calibrationPolicyHash = initialPolicy.policyHash;
  let acceptedKey: EngineeringKey | undefined;
  async function createTicket() {
    await application.createCustomerTicket(actors.customer, { ...command('ticket'), ticketId: engineeringTicketId,
      messageId: 'engineering-question', subject: 'Workspace export is empty', body: 'Exporting a fictional workspace produces an empty file.' });
    await application.addNote(actors.staff, { ...command('note'), ticketId: engineeringTicketId,
      messageId: 'engineering-note', body: engineeringCanary });
    return (await application.readStaffTicket(actors.staff, engineeringTicketId)).ticket;
  }
  async function eligible(security: EngineeringSecurity = 'ordinary') {
    const ticket = await createTicket();
    await runtime.enroll(actors.staff, { ticketId: engineeringTicketId, clientCommandId: 'ENROLL-EXACT', expectedRevision: ticket.revision });
    const packet: EngineeringFailurePacket = { ticketId: engineeringTicketId, clientCommandId: 'FAILURE-EXACT',
      expectedRevision: ticket.revision, security, evidence: { kind: 'staff_verified_failure',
        expectedBehavior: 'The export contains the workspace rows.', actualBehavior: 'The downloaded export is empty.',
        reproductionSteps: ['Create a fictional workspace with one row.', 'Export it and inspect the file.'],
        visibleMessageIds: ['engineering-question'], verificationReference: engineeringProofReference } };
    const source = await runtime.submitVerifiedFailure(actors.staff, packet);
    acceptedKey = { ticketId: engineeringTicketId, sourceGeneration: source.sourceGeneration };
    return { source, packet, key: structuredClone(acceptedKey) };
  }
  function key() { if (acceptedKey === undefined) throw new Error('No actual accepted engineering key'); return structuredClone(acceptedKey); }
  const work = () => runtime.readWork(actors.security, key());
  const process = () => runtime.processWork({ ...key(), workerId: 'synthetic-engineering-worker', leaseMilliseconds: 30_000 });
  async function prepared() {
    const assessed = await process();
    if (assessed.outcome !== 'candidate') throw new Error('Synthetic assessment unavailable: ' + assessed.outcome);
    const result = await process();
    if (result.outcome !== 'prepared') throw new Error('Synthetic proposal unavailable: ' + result.outcome);
    const current = await work();
    if (current.proposal === undefined) throw new Error('Actual prepared proposal missing');
    return current;
  }
  async function approve() {
    const current = await work();
    if (current.proposal === undefined) throw new Error('Actual proposal required for review');
    const packet = { ...key(), clientCommandId: 'REVIEW-EXACT', expectedWorkGeneration: current.workGeneration,
      proposalHash: current.proposal.proposalHash, decision: 'approve' as const };
    await runtime.reviewProposal(actors.staff, packet); return packet;
  }
  return { store, clock, state, application, actors, runtime, ports, metadata, configuration,
    command, createTicket, eligible, key, work, process, prepared, approve, resolve,
    rows: () => store.collection(supportRecords).list(engineeringTicketId),
    source: () => runtime.readSource(actors.security, engineeringTicketId),
    advance: (value: number) => { milliseconds += value; },
    async revoke(actor: Actor) {
      const row = await roleStore.getRoleAssignment('engineering-role-' + actor);
      if (row === null) throw new Error('Actual role assignment missing');
      return roleStore.revokeRoleAssignmentWithAudit({ assignmentId: 'engineering-role-' + actor,
        expectedConcurrencyToken: row.concurrencyToken, revokedBy: { kind: 'system', systemId: 'synthetic-engineering-fixture' },
        revokedAtEpochMs: milliseconds, auditEventId: next('revoke') });
    },
  };
}

export type SupportEngineeringFixture = Awaited<ReturnType<typeof createSupportEngineeringFixture>>;
