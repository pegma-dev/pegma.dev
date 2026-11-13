import { resolveAccess } from '@pegma/authorization-core';
import { createRoleStore } from '@pegma/authorization-storage';
import { createMemoryStore, type Store } from '@pegma/storage-core';
import {
  createSupportDeskReleaseFollowup,
  type VerifiedReleaseFollowupConfiguration,
} from '@pegma/support-desk-ai';
import {
  supportPermissions,
  supportRecords,
  type EngineeringFollowupContext,
  type EngineeringRepositoryDescriptor,
  type VerifiedEngineeringFollowupChecks,
} from '@pegma/support-desk-application';
import { isDeepStrictEqual } from 'node:util';
import {
  createSupportEngineeringHttpFixture,
  type EngineeringHttpActor,
} from './support-engineering-http-fixtures';
import { engineeringTicketId } from './support-engineering-fixtures';
import { createSupportRuntime } from './support-desk';
import { createSupportApi } from './support-api';
import { createSupportReleaseFollowupRuntime } from './support-release-followup';
import { composeSupportReleaseFollowup } from './support-release-followup-composition';
import {
  supportReleaseFollowupApplicationOptions,
  type SupportReleaseFollowupComposition,
  type SupportReleaseFollowupConfiguration,
} from './support-release-followup-ports';
import { createSupportReleaseFollowupUsage } from './support-release-followup-usage';

export const followupRoute =
  '/api/support/admin/tickets/' + engineeringTicketId + '/follow-up';
export const followupPrivateMarker = 'SYNTHETIC_FOLLOWUP_PRIVATE_RECEIPT';
export const followupCommandId = '2df42b40-83da-460b-9765-152e36393753';

/** Real accepted engineering export, host Identity/Sessions/RoleStore and SDK work.
 * Only independent issue/deployment/model/check systems are fictional. */
export async function createSupportReleaseFollowupFixture(
  backing: Store = createMemoryStore(),
  fixture: { readonly repositories?: readonly EngineeringRepositoryDescriptor[] } = {},
) {
  const f = await createSupportEngineeringHttpFixture(backing, fixture);
  await f.verified();
  const proposal = await f.prepared();
  if (proposal.proposal === undefined)
    throw new Error('Expected actual checked engineering proposal');
  const resolvedStaff = await f.resolve(f.principals.staff);
  if (resolvedStaff === null)
    throw new Error('Expected real current Support role');
  const staff = resolvedStaff;
  await f.state.runtime.reviewProposal(staff, {
    ...f.key(),
    clientCommandId: 'FOLLOWUP-ASSOCIATION-APPROVAL',
    expectedWorkGeneration: proposal.workGeneration,
    proposalHash: proposal.proposal.proposalHash,
    decision: 'approve',
  });
  if ((await f.process()).outcome !== 'dispatched')
    throw new Error('Expected genuine fictional connector dispatch');
  const engineeringWork = await f.work();
  const source = await f.engineering.source();
  const accepted = engineeringWork.acknowledgement;
  if (
    accepted === undefined ||
    source.product === undefined ||
    !source.destinations.some((entry) => entry.outcome === 'accepted')
  )
    throw new Error('Missing actual accepted SDK association');
  const clock = { now: () => new Date().toISOString() };
  const until = () => new Date(Date.now() + 3_600_000).toISOString();
  let ordinal = 0;
  const receipt = () => followupPrivateMarker + '-' + ++ordinal;
  const context: EngineeringFollowupContext = {
    issueHead: {
      ...accepted,
      generation: 1,
      hash: 'synthetic-issue-head-1',
      state: 'closed',
    },
    deploymentHead: {
      contextRef: 'synthetic-private-deployment',
      generation: 1,
      hash: 'synthetic-deployment-head-1',
      state: 'deployed',
      deploymentEpoch: 'synthetic-deployment-epoch-1',
    },
    mapping: {
      semanticMappingId: 'synthetic-export-fix',
      mappingId: 'synthetic-mapping',
      mappingVersion: 'synthetic-mapping-v1',
      affectedProductBinding: source.product.binding,
      fixedProduct: {
        productId: source.product.productId,
        version: '2.3.1',
        buildId: 'synthetic-fixed-build-231',
      },
      releaseRef: 'synthetic-private-release',
      deploymentId: 'synthetic-deployment-1',
      scopeRef: 'synthetic-workspace-installation',
      issueHeadHash: 'synthetic-issue-head-1',
      deploymentHeadHash: 'synthetic-deployment-head-1',
      verification: {
        kind: 'host_release',
        reference: 'synthetic-confirmed-deployment-receipt',
      },
    },
  };
  const state = {
    enabled: true,
    proofAvailable: true,
    modelCalls: 0,
    modelOutcome: 'known' as 'known' | 'unknown',
    confirm: undefined as (() => Promise<void>) | undefined,
    checks: undefined as (() => Promise<void>) | undefined,
    context,
    checkedBindings: [] as string[],
    modelInputs: [] as unknown[],
  };
  const proofs = new Map<string, VerifiedEngineeringFollowupChecks>();
  const attestation = () => ({
    verifierReceiptId: receipt(),
    verifierVersion: 'synthetic-followup-verifier-v1',
    verifiedAt: clock.now(),
    validUntil: until(),
  });
  const checkPolicy = {
    version: 'synthetic-followup-checks-v1',
    binding: 'synthetic-complete-bundle-checks',
    verifiedAt: clock.now(),
    validUntil: until(),
  };
  const config: SupportReleaseFollowupConfiguration = {
    application: { maxModelAttempts: 1 },
    releaseEvidence: {
      async verifyInput(inputReference, proofContext, signal) {
        if (
          inputReference !== 'synthetic-release-input' ||
          signal.aborted ||
          !state.proofAvailable ||
          proofContext.association.repositoryId !== accepted.repositoryId ||
          proofContext.association.issueId !== accepted.issueId
        )
          return null;
        return {
          context: structuredClone(state.context),
          publicFacts: [
            {
              reference: 'synthetic-public-release',
              text: 'The deployed export fix preserves workspace rows.',
            },
          ],
          attestation: attestation(),
        };
      },
      async confirm(_binding, proofContext, signal) {
        await state.confirm?.();
        if (
          signal.aborted ||
          !state.proofAvailable ||
          proofContext.association.issueId !== accepted.issueId
        )
          return null;
        return {
          context: structuredClone(state.context),
          publicFacts: [
            {
              reference: 'synthetic-public-release',
              text: 'The deployed export fix preserves workspace rows.',
            },
          ],
          attestation: attestation(),
        };
      },
    },
    targets: {
      async resolve() {
        return { kind: 'none' };
      },
    },
    retestReceipts: {
      async verify() {
        return null;
      },
    },
    checks: {
      async resolvePolicy() {
        return { outcome: 'ready', policy: structuredClone(checkPolicy) };
      },
      async check({ binding, exactBundle }) {
        await state.checks?.();
        if (JSON.stringify(exactBundle).includes(followupPrivateMarker))
          return { outcome: 'held' };
        const value = receipt();
        proofs.set(value, {
          binding: structuredClone(binding),
          privacy: 'passed',
          factual: 'passed',
          applicability: 'passed',
          security: 'clear',
          ...attestation(),
        });
        state.checkedBindings.push(value);
        return { outcome: 'checked', receipt: value };
      },
      async verify(value, binding) {
        const proof = proofs.get(value);
        return proof !== undefined && isDeepStrictEqual(proof.binding, binding)
          ? structuredClone(proof)
          : null;
      },
    },
  };
  const serviceRoles = createRoleStore(backing, 'synthetic-followup-service');
  const serviceId = 'synthetic-followup-service';
  await serviceRoles.grantRoleAssignmentWithAudit({
    assignment: {
      id: 'followup-service-role',
      principalId: serviceId,
      role: 'FollowupProcessor',
      scope: { kind: 'application' },
      status: 'active',
      grantedAtEpochMs: Date.now(),
      grantedBy: { kind: 'system', systemId: 'synthetic-followup-fixture' },
    },
    auditEventId: 'followup-service-grant',
  });
  const generation: VerifiedReleaseFollowupConfiguration = {
    purpose: 'support_release_followup',
    version: 'synthetic-followup-route-v1',
    promptVersion: 'synthetic-followup-prompt-v1',
    modelVersion: 'synthetic-followup-model-v1',
    parserVersion: 'synthetic-followup-parser-v1',
    evaluationVersion: 'synthetic-followup-evaluation-v1',
    provider: 'synthetic-followup-provider',
    model: 'synthetic-followup-model',
    pricingRef: 'synthetic-followup-price-v1',
    trustedInstructions:
      'Prepare an exact private update from visible messages and public deployed-release facts.',
    framingTokens: 20,
    budgets: {
      maxMessages: 10,
      maxInputBytes: 32_768,
      maxInputTokens: 12_000,
      maxContextTokens: 16_000,
      maxOutputBytes: 16_000,
      maxOutputTokens: 1_500,
      maxCandidateBytes: 16_000,
      maxDurationMilliseconds: 5_000,
      maxCostMicros: 100,
      currency: 'USD',
      maxAttempts: 1,
    },
    dataControls: {
      purpose: 'support_release_followup',
      status: 'verified',
      configurationBinding: 'synthetic-followup-route-v1',
      accountRef: 'synthetic-followup-account',
      projectRef: 'synthetic-followup-project',
      endpointRef: 'synthetic-followup-endpoint',
      modelRef: 'synthetic-followup-model-route',
      featuresRef: 'synthetic-followup-features',
      exceptionsRef: 'synthetic-followup-exceptions',
      intermediaryRefs: [],
      verifiedAt: clock.now(),
      validUntil: until(),
    },
  };
  const evaluation = {
    version: generation.evaluationVersion,
    artifactRef: 'synthetic-reviewed-followup-evaluation',
    modelVersion: generation.modelVersion,
    promptVersion: generation.promptVersion,
    parserVersion: generation.parserVersion,
    verifiedAt: clock.now(),
    validUntil: until(),
  };
  const configured: SupportReleaseFollowupConfiguration = {
    ...config,
    generation: {
      serviceAccess: {
        async resolve(signal) {
          if (signal.aborted) return { outcome: 'inactive' };
          const assignments = await serviceRoles.listActiveRoleAssignments(
            serviceId,
            { kind: 'application' },
          );
          const access = resolveAccess(
            {
              principalId: serviceId,
              roles: assignments.map((row) => row.role),
            },
            {
              version: 'synthetic-followup-service-policy',
              roles: {
                FollowupProcessor: [
                  supportPermissions.queueRead,
                  supportPermissions.engineeringFollowupRead,
                  supportPermissions.engineeringFollowupProcess,
                ],
              },
            },
          );
          return {
            outcome: 'ready',
            authority: {
              access,
              authorityVersion: 'synthetic-followup-service-v1',
              usageScopeRef: 'synthetic-followup-budget',
            },
          };
        },
      },
      configuration: {
        async resolve() {
          return {
            outcome: 'ready',
            configuration: structuredClone(generation),
          };
        },
      },
      evaluations: {
        async resolve() {
          return { outcome: 'ready', evaluation: structuredClone(evaluation) };
        },
      },
      model: {
        async generate(input) {
          state.modelCalls += 1;
          state.modelInputs.push(structuredClone(input));
          if (state.modelOutcome === 'unknown')
            throw new Error('Synthetic provider accepted but response unknown');
          return {
            outputJson: JSON.stringify({
              customerDraft: {
                body: 'The deployed export fix is ready. Please retry the fictional export.',
              },
              kbProposal: null,
              retestRequests: [],
            }),
            provider: generation.provider,
            model: generation.model,
            requestId: 'synthetic-followup-model-response',
            usage: {
              inputTokens: 80,
              outputTokens: 30,
              costMicros: 10,
              currency: 'USD',
            },
          };
        },
      },
      tokenCounter: {
        count: (input) =>
          Math.max(
            1,
            Math.ceil(new TextEncoder().encode(input).byteLength / 4),
          ),
      },
      usagePolicy: {
        version: 'synthetic-followup-budget-v1',
        scopeRef: 'synthetic-followup-budget',
        configurationVersion: generation.version,
        modelVersion: generation.modelVersion,
        pricingRef: generation.pricingRef,
        currency: 'USD',
        maxCostMicros: 1_000,
        maxReservationCostMicros: 100,
        maxReservations: 8,
        validFrom: clock.now(),
        validUntil: until(),
        terminalRetentionMilliseconds: 300_000,
      },
    },
  };
  const composition: SupportReleaseFollowupComposition = {
    enabled: () => state.enabled,
    configuration: configured,
  };
  const host = createSupportRuntime({
    store: f.engineering.store,
    identity: f.identity,
    sessions: f.sessions,
    identityLinkFromClaims: f.options.identityLinkFromClaims,
    logger: f.options.logger,
    clock,
    engineeringFollowup: supportReleaseFollowupApplicationOptions(composition),
  });
  const runtime = createSupportReleaseFollowupRuntime({
    application: host.application,
    store: host.store,
    clock,
    configuration: configured,
    enabled: () => state.enabled,
  });
  const api = createSupportApi({
    ...f.options,
    application: host.application,
    createLimiter: host.createLimiter,
    replyLimiter: host.replyLimiter,
    releaseFollowup: composeSupportReleaseFollowup(
      host,
      f.options.logger,
      composition,
    ),
  });
  const identity = {
    ...f.engineering.command('followup-observe'),
    ticketId: engineeringTicketId,
    association: {
      repositoryId: accepted.repositoryId,
      issueId: accepted.issueId,
    },
    inputReference: 'synthetic-release-input',
  };
  async function observe() {
    const value = await host.application.observeEngineeringFollowup(
      staff,
      identity,
    );
    if (value.workId === undefined)
      throw new Error(
        'Expected real eligible follow-up work: ' + JSON.stringify(value),
      );
    return { ticketId: engineeringTicketId, workId: value.workId };
  }
  async function prepare() {
    const key = await observe();
    const command = {
      ...key,
      workerId: 'synthetic-followup-worker',
      leaseMilliseconds: 30_000,
    };
    const first = await runtime.process(command);
    if (first.outcome !== 'candidate') {
      const held = await host.application.readEngineeringFollowupWork(
        staff,
        key,
      );
      throw new Error(
        'Expected actual follow-up candidate: ' +
          JSON.stringify({
            result: first,
            heldReason: held.heldReason,
            modelCalls: state.modelCalls,
          }),
      );
    }
    const second = await runtime.process(command);
    if (second.outcome !== 'prepared')
      throw new Error(
        'Expected actual checked follow-up bundle: ' + JSON.stringify(second),
      );
    return host.application.readEngineeringFollowupWork(staff, key);
  }
  function request(
    operation: string,
    body?: unknown,
    actor: EngineeringHttpActor = 'staff',
    query = '',
  ) {
    const original = f.request('', body, actor);
    return new Request(
      'https://pegma.dev' + followupRoute + '/' + operation + query,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: original.headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
  }
  return {
    f,
    host,
    state,
    runtime,
    composition,
    configured,
    clock,
    api,
    request,
    observe,
    prepare,
    identity,
    rows: () => backing.collection(supportRecords).list(engineeringTicketId),
    async coordinator() {
      const inputs = configured.generation!;
      return createSupportDeskReleaseFollowup({
        application: host.application,
        clock,
        releaseEvidence: config.releaseEvidence,
        checks: config.checks,
        targets: config.targets,
        ...inputs,
        usage: createSupportReleaseFollowupUsage({
          store: backing,
          clock,
          policy: inputs.usagePolicy,
        }),
      });
    },
  };
}
