import { createMemoryStore, type Store } from '@pegma/storage-core';
import { createSupportReleaseFollowupFixture } from './support-release-followup-fixtures';
import { createSupportRuntime } from './support-desk';
import { createKnowledgeRuntime } from './knowledge-runtime';
import { createSupportReleaseFollowupBootstrap } from './support-release-followup-bootstrap';
import { createSupportReleaseFollowupRuntime } from './support-release-followup';
import { supportReleaseFollowupApplicationOptions } from './support-release-followup-ports';
import { composeSupportReleaseFollowup } from './support-release-followup-composition';
import { createSupportApi } from './support-api';
import { KNOWLEDGE_ROLE, APPLICATION_SCOPE } from './support-access';
import { componentReleaseCollection } from './component-release';
import type { EvidenceSubmission } from '@pegma/knowledge-base-core';
import { articleKinds } from '@pegma/knowledge-base-contracts';
import { engineeringRepositories } from './support-engineering-fixtures';

/** Real host Identity/RoleStore/KB reports/Support and Store. Only provider
 * generation/checker responses and explicit staff deployment facts are fictional. */
export async function createSupportFollowupHostFixture(
  store: Store = createMemoryStore(),
  options: { readonly numericRepositories?: boolean } = {},
) {
  const fixture = options.numericRepositories
    ? {
        repositories: engineeringRepositories.map((value, index) => ({
          ...value,
          repositoryId: String(1313911960 + index),
          owner: 'pegma-dev',
          name: index === 0 ? 'webhooks' : 'workspace-api',
        })),
      }
    : {};
  const f = await createSupportReleaseFollowupFixture(store, fixture);
  for (const actor of ['staff', 'peer'] as const) {
    await f.host.roleStore.grantRoleAssignmentWithAudit({
      assignment: {
        id: 'followup-knowledge-' + actor,
        principalId: f.f.principals[actor],
        role: KNOWLEDGE_ROLE,
        scope: APPLICATION_SCOPE,
        status: 'active',
        grantedBy: { kind: 'system', systemId: 'fictional-followup-test' },
        grantedAtEpochMs: Date.now(),
      },
      auditEventId: 'followup-knowledge-' + actor,
    });
  }
  const resolve = f.f.resolve;
  async function access(actor: keyof typeof f.f.principals = 'staff') {
    const value = await resolve(f.f.principals[actor]);
    if (!value) throw new Error('Actual host principal is unavailable');
    return value;
  }
  const staff = await access();
  const admin = await access('admin');
  const peer = await access('peer');
  const knowledge = createKnowledgeRuntime({
    ...f.f.options,
    store,
    clock: f.clock,
    agentAccess: null,
  });
  let host = f.host;
  const environment = {
    PEGMA_SUPPORT_RELEASE_FOLLOWUP_ENABLED: 'true',
    GITHUB_ALLOWED_REPOSITORY_IDS: f.identity.association.repositoryId,
  };
  const source = createSupportReleaseFollowupBootstrap({
    environment,
    store,
    clock: f.clock,
    application: () => host.application,
    resolvePrincipal: resolve,
    knowledge: () => knowledge.application,
    reports: () => knowledge.evidence,
    stagedRetestPreparation: false,
    readGovernance: async (collectionId) =>
      knowledge.application.getGovernanceConfiguration(await access('admin'), {
        collectionId,
      }),
  });
  if (!source?.configuration || !source.mappings || !source.retests)
    throw new Error('Actual source factory unavailable');
  const generation = f.configured.generation!;
  const composition = {
    ...source,
    configuration: {
      ...source.configuration,
      checks: f.configured.checks,
      generation: {
        ...generation,
        model: {
          async generate(
            ...input: Parameters<typeof generation.model.generate>
          ) {
            const result = await generation.model.generate(...input);
            return {
              ...result,
              outputJson: JSON.stringify({
                customerDraft: {
                  body: 'The deployed fix is ready for a customer retry.',
                },
                kbProposal: null,
                retestRequests: [
                  {
                    steps: ['Export the fictional workspace.'],
                    expectedBehavior: 'The export contains its rows.',
                  },
                ],
              }),
            };
          },
        },
      },
    },
  };
  host = createSupportRuntime({
    store,
    clock: f.clock,
    identity: f.f.identity,
    sessions: f.f.sessions,
    identityLinkFromClaims: f.f.options.identityLinkFromClaims,
    logger: f.f.options.logger,
    engineeringFollowup: supportReleaseFollowupApplicationOptions(composition),
  });
  const runtime = createSupportReleaseFollowupRuntime({
    application: host.application,
    store,
    clock: f.clock,
    configuration: composition.configuration,
    enabled: () =>
      environment.PEGMA_SUPPORT_RELEASE_FOLLOWUP_ENABLED === 'true',
  });
  const api = createSupportApi({
    ...f.f.options,
    application: host.application,
    createLimiter: host.createLimiter,
    replyLimiter: host.replyLimiter,
    releaseFollowup: composeSupportReleaseFollowup(
      host,
      f.f.options.logger,
      composition,
    ),
  });
  const sourceProduct = (
    await host.application.readEngineeringSource(staff, f.identity.ticketId)
  ).product!;
  const product = {
    productId: sourceProduct.productId,
    productVersion: '2.3.1',
    buildId: 'fictional-fixed-build',
  };
  await store.collection(componentReleaseCollection()).put({
    repositoryId: f.identity.association.repositoryId,
    repositoryName: 'support-desk',
    releaseId: '9001',
    tagName: 'v2.3.1',
    publishedAt: f.clock.now(),
    observedAt: f.clock.now(),
    releaseUrl: 'https://github.com/pegma-dev/support-desk/releases/tag/v2.3.1',
  });
  const context = {
    current: () => access(),
    assertCurrent() {},
    signal: new AbortController().signal,
  };
  const ticket = await host.application.readStaffTicket(
    staff,
    f.identity.ticketId,
  );
  const mappingPacket = {
    commandId: crypto.randomUUID(),
    expectedPrincipalId: staff.principalId,
    expectedTicketRevision: ticket.ticket.revision,
    expectedMappingGeneration: 0,
    ...f.identity.association,
    releaseRef: '9001',
    issueState: 'closed' as const,
    deploymentState: 'deployed' as const,
    fixedProduct: {
      productId: product.productId,
      version: product.productVersion,
      buildId: product.buildId,
    },
    deploymentId: 'fictional-deployment',
    deploymentEpoch: 'fictional-deployment-epoch',
    scopeRef: 'fictional-current-installation',
    verificationReference: 'explicit-staff-observation',
    publicFacts: [
      {
        reference: 'public-release-note',
        text: 'The deployed export preserves the workspace rows.',
      },
    ],
  };
  let ordinal = 0;
  const command = (label: string, expectedGeneration = 0) => ({
    commandId: label + '-' + ++ordinal,
    correlationId: 'fictional-followup-test',
    expectedGeneration,
  });
  const collectionId = 'followup-retests';
  const articleId = 'followup-export-test';
  await knowledge.application.createCollection(admin, {
    ...command('collection'),
    collectionId,
    name: 'Fictional follow-up tests',
  });
  const policy = {
    id: 'followup-test-policy',
    version: 1,
    requirements: [
      ...articleKinds.map((kind) => ({
        id: kind + '-content',
        kind,
        testKind: 'content' as const,
        maxAgeMilliseconds: 3600000,
        trustedRunnerIds: [peer.principalId],
      })),
      {
        id: 'walkthrough-workflow',
        kind: 'walkthrough' as const,
        testKind: 'workflow' as const,
        maxAgeMilliseconds: 3600000,
        trustedRunnerIds: [peer.principalId],
      },
    ],
  };
  await knowledge.application.putValidationPolicy(admin, {
    ...command('validation'),
    policy,
  });
  const collection = await knowledge.application.getCollection(admin, {
    collectionId,
  });
  await knowledge.application.putGovernanceConfiguration(admin, {
    ...command('governance', collection.generation),
    collectionId,
    configuration: {
      validationPolicy: { id: policy.id, version: 1 },
      expectedStagingBuildId: product.buildId,
      trustedAttesterIds: [staff.principalId],
    },
  });
  await knowledge.application.createDraft(admin, {
    ...command('draft'),
    articleId,
    collectionId,
    draft: {
      kind: 'explanation',
      title: 'Test the deployed export fix',
      summary: 'Fictional verified export test.',
      content: {
        format: 'plain_text',
        text: 'Export a workspace and check its rows.',
      },
      tags: ['fictional'],
      applicability: product,
    },
  });
  async function report(
    result: 'passed' | 'failed' = 'passed',
    confirmed = true,
  ) {
    const draft = await knowledge.application.getDraft(peer, { articleId });
    const requirements = await knowledge.application.getValidationRequirements(
      peer,
      { collectionId, kind: 'explanation' },
    );
    const rule = requirements.checks[0]!;
    const evidence: EvidenceSubmission = {
      id: crypto.randomUUID(),
      articleId,
      articleRevision: draft.revision.number,
      contentHash: draft.revision.contentHash,
      validationPolicy: draft.revision.validationPolicy,
      checkId: rule.id,
      testKind: rule.testKind,
      applicability: draft.revision.applicability,
      stagingBuildId: requirements.expectedStagingBuildId,
      steps: ['Export the fictional workspace.'],
      result,
      executedAt: f.clock.now(),
      runnerId: peer.principalId,
      artifacts: [{ id: 'fictional-local-test-output', hash: 'a'.repeat(64) }],
    };
    const ledger = await knowledge.evidence.ledger(peer, { articleId });
    const ack = await knowledge.evidence.report(peer, {
      commandId: crypto.randomUUID(),
      articleId,
      ledgerEpoch: ledger.ledgerEpoch,
      evidence,
      report: {
        summary: 'Fictional local export test',
        details: 'PRIVATE_RETEST_BODY_NEVER_COPIED_TO_RECEIPT',
      },
    });
    const key = {
      articleId,
      ledgerEpoch: ack.ledgerEpoch,
      reportId: ack.reportId,
    };
    const before = await knowledge.evidence.read(staff, key);
    if (confirmed)
      await knowledge.evidence.decide(
        staff,
        {
          ...key,
          commandId: crypto.randomUUID(),
          expectedReportGeneration: before.reportGeneration,
          reviewBindingHash: before.reviewBindingHash,
        },
        'confirmed',
      );
    return knowledge.evidence.read(staff, key);
  }
  async function prepared() {
    const mapping = await source!.mappings!.verify(
      context,
      f.identity.ticketId,
      mappingPacket,
    );
    const observed = await runtime.observe(context, {
      ...f.identity,
      commandId: crypto.randomUUID(),
      inputReference: mapping.inputReference,
    });
    if (!observed.workId)
      throw new Error('Actual mapping did not create SDK work');
    const key = { ticketId: f.identity.ticketId, workId: observed.workId };
    const packet = {
      ...key,
      workerId: 'fictional-followup-worker',
      leaseMilliseconds: 30000,
    };
    const first = await runtime.process(packet);
    const second = await runtime.process(packet);
    if (first.outcome !== 'candidate' || second.outcome !== 'prepared')
      throw new Error(
        'Actual SDK preparation failed: ' + JSON.stringify({ first, second }),
      );
    return host.application.readEngineeringFollowupWork(staff, key);
  }
  return {
    f,
    store,
    host,
    knowledge,
    source,
    composition,
    runtime,
    api,
    access,
    staff,
    admin,
    peer,
    environment,
    context,
    mappingPacket,
    articleId,
    collectionId,
    product,
    report,
    prepared,
    request: f.request,
    command,
  };
}
