import { isDeepStrictEqual } from 'node:util';
import { identityLinkKeyFromVerifiedIdentityClaims } from '@pegma/authorization-identity';
import { resolveAccess } from '@pegma/authorization-core';
import { createRoleStore } from '@pegma/authorization-storage';
import { articleKinds, knowledgePermissions } from '@pegma/knowledge-base-contracts';
import type {
  EvidenceVerificationRequest,
  KnowledgeBaseApplication,
} from '@pegma/knowledge-base-application';
import { createSupportDeskApplication, supportPermissions } from '@pegma/support-desk-application';
import { createCloudflareD1Store } from '@pegma/storage-cloudflare-d1';
import type { Store } from '@pegma/storage-core';
import { systemClock, type Clock } from '@pegma/spine';
import { createAgentPrincipalResolver } from './agent-authority';
import {
  ADMIN_ROLE,
  APPLICATION_SCOPE,
  AUTHORIZATION_APPLICATION_ID,
  KNOWLEDGE_ROLE,
  SUPPORT_ROLE,
} from './support-access';
import {
  createStageIdentity,
  createStageKnowledge,
  readSupportAssistantStageScenario,
  stageApplicability,
  stageCustomerPolicy,
  stageIds,
  stageReference,
  stageScenarioCurrent,
  type SupportAssistantStageScenario,
} from './support-assistant-stage-scenario';

/** Local SDK setup only. Do not call this from the deployed queue entry. */
export async function seedSupportAssistantStage(
  database: D1Database,
  input: SupportAssistantStageScenario,
  clock: Clock = systemClock,
) {
  const scenario = readSupportAssistantStageScenario(input);
  if (!stageScenarioCurrent(scenario, clock))
    throw new Error('Synthetic stage scenario is outside its fixed window.');
  // The reviewed migration must already exist. Partial seeds require inspection.
  const existing = await database
    .prepare('SELECT COUNT(*) AS count FROM RECORDS')
    .first<{ count: number }>();
  if (existing?.count !== 0)
    throw new Error('Synthetic stage seed requires an empty isolated database.');
  const store = createCloudflareD1Store({
    database,
    createSchemaIfMissing: false,
    readBatchSize: 512,
  });
  return seedSupportAssistantStageStore(store, scenario, clock);
}

/** Caller supplies a new empty test Store. Native setup uses the checked wrapper. */
export async function seedSupportAssistantStageStore(
  store: Store,
  input: SupportAssistantStageScenario,
  clock: Clock = systemClock,
) {
  const scenario = readSupportAssistantStageScenario(input);
  const current = () => stageScenarioCurrent(scenario, clock);
  if (!current()) throw new Error('Synthetic stage seed window expired.');
  const identity = createStageIdentity(store, clock);
  const roles = createRoleStore(store, AUTHORIZATION_APPLICATION_ID);
  for (const [id, role] of [
    [stageIds.owner, KNOWLEDGE_ROLE],
    [stageIds.author, KNOWLEDGE_ROLE],
    [stageIds.administrator, ADMIN_ROLE],
    [stageIds.operator, SUPPORT_ROLE],
  ] as const) {
    await identity.provisionVerifiedUser({
      principalId: id,
      email: id + '@example.test',
    });
    await roles.grantRoleAssignmentWithAudit({
      assignment: {
        id: 'fixture-role-' + id,
        principalId: id,
        role,
        scope: APPLICATION_SCOPE,
        grantedBy: { kind: 'system', systemId: 'fictional-answer-setup' },
        grantedAtEpochMs: Date.parse(clock.now()),
        status: 'active',
      },
      auditEventId: 'fixture-role-event-' + id,
    });
  }
  const resolve = createAgentPrincipalResolver({
    identity,
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
    roleStore: roles,
  });
  async function access(principalId: string) {
    const observed = await resolve(principalId);
    if (observed === null || !current())
      throw new Error('Synthetic seed principal is unavailable.');
    return resolveAccess({ principalId, roles: observed.roles }, stageCustomerPolicy);
  }
  const receipts = new Map<string, Omit<EvidenceVerificationRequest, 'receipt'>>();
  const knowledge = createStageKnowledge(store, clock, current, {
    async verify(request) {
      const { receipt, ...binding } = request;
      return current() && isDeepStrictEqual(receipts.get(receipt), binding)
        ? { id: receipt, verifiedBy: 'PRIVATE_FICTIONAL_ATTESTER', verifiedAt: clock.now() }
        : null;
    },
  });
  const admin = await access(stageIds.administrator);
  const writer = await access(stageIds.author);
  let ordinal = 0;
  const command = (label: string, expectedGeneration: number) => ({
    commandId: 'stage-seed-' + scenario.scenarioId + '-' + ++ordinal + '-' + label,
    correlationId: 'fictional-answer-stage-seed',
    expectedGeneration,
  });
  const policy = {
    id: 'fictional-answer-validation',
    version: 1,
    requirements: [
      ...articleKinds.map((kind) => ({
        id: kind + '-content',
        kind,
        testKind: 'content',
        maxAgeMilliseconds: 3_600_000,
        trustedRunnerIds: [stageIds.author],
      })),
      {
        id: 'walkthrough-workflow',
        kind: 'walkthrough' as const,
        testKind: 'workflow',
        maxAgeMilliseconds: 3_600_000,
        trustedRunnerIds: [stageIds.author],
      },
    ],
  };
  const collection = await knowledge.createCollection(admin, {
    ...command('create-collection', 0),
    collectionId: stageIds.collection,
    name: 'Fictional workspace guides',
  });
  await knowledge.putValidationPolicy(admin, { ...command('put-validation', 0), policy });
  await knowledge.putGovernanceConfiguration(admin, {
    ...command('put-governance', collection.value.generation),
    collectionId: stageIds.collection,
    configuration: {
      validationPolicy: { id: policy.id, version: 1 },
      expectedStagingBuildId: stageApplicability.buildId,
      trustedAttesterIds: ['PRIVATE_FICTIONAL_ATTESTER'],
    },
  });
  const preview = await knowledge.previewCollectionPolicy(admin, {
    collectionId: stageIds.collection,
    uses: {
      portal: { enabled: false },
      bot: {
        enabled: true,
        audience: { kind: 'permission', permission: knowledgePermissions.draftRead },
      },
    },
  });
  await knowledge.updateCollectionPolicy(admin, {
    ...command('configure-audience', preview.generation),
    collectionId: stageIds.collection,
    preview: preview.preview,
  });
  await knowledge.createDraft(writer, {
    ...command('create-guide', 0),
    articleId: stageIds.article,
    collectionId: stageIds.collection,
    draft: {
      kind: 'explanation',
      title: 'Export your fictional workspace',
      summary: 'Download an export.',
      content: {
        format: 'plain_text',
        text: 'Open Workspace, choose Export, then download the CSV.',
      },
      tags: ['workspace', 'export', 'csv'],
      applicability: stageApplicability,
    },
  });
  let draft = await knowledge.getDraft(writer, { articleId: stageIds.article });
  await knowledge.setProvenance(admin, {
    ...command('guide-provenance', draft.generation),
    articleId: stageIds.article,
    references: [stageReference],
  });
  draft = await knowledge.getDraft(writer, { articleId: stageIds.article });
  // Real elapsed setup time replaces the native fixture's manual clock advance.
  await new Promise<void>((resolve) => setTimeout(resolve, 1001));
  if (!current()) throw new Error('Synthetic stage seed window expired.');
  const evidence: Parameters<KnowledgeBaseApplication['submitEvidence']>[1]['evidence'] = {
    id: 'fictional-guide-evidence',
    articleId: stageIds.article,
    articleRevision: draft.revision.number,
    contentHash: draft.revision.contentHash,
    validationPolicy: draft.revision.validationPolicy,
    checkId: 'explanation-content',
    testKind: 'content',
    applicability: stageApplicability,
    stagingBuildId: stageApplicability.buildId,
    steps: ['PRIVATE_FICTIONAL_STEPS'],
    result: 'passed',
    executedAt: clock.now(),
    runnerId: stageIds.author,
    artifacts: [{ id: 'PRIVATE_FICTIONAL_ARTIFACT', hash: 'a'.repeat(64) }],
  };
  const governance = await knowledge.getGovernanceConfiguration(admin, {
    collectionId: stageIds.collection,
  });
  const receipt = 'fictional-evidence-receipt';
  receipts.set(
    receipt,
    structuredClone({
      access: writer,
      article: draft.revision,
      submission: evidence,
      configuration: governance.configuration,
    }),
  );
  await knowledge.submitEvidence(writer, {
    ...command('guide-evidence', draft.generation),
    articleId: stageIds.article,
    evidence,
    receipt,
  });
  draft = await knowledge.getDraft(writer, { articleId: stageIds.article });
  await knowledge.submitForReview(writer, {
    ...command('guide-review', draft.generation),
    articleId: stageIds.article,
  });
  const review = await knowledge.getReview(admin, { articleId: stageIds.article });
  await knowledge.publishArticle(admin, {
    ...command('guide-publish', review.generation),
    articleId: stageIds.article,
    review: review.review,
  });
  let indexed = false;
  for (let attempt = 0; attempt < 16; ++attempt) {
    if (!current()) throw new Error('Synthetic stage seed window expired.');
    const result = await knowledge.repairArticleIndex(admin, { articleId: stageIds.article });
    if (result.status === 'ready' && result.indexed) {
      indexed = true;
      break;
    }
    if (result.status === 'blocked') throw new Error('Synthetic guidance index was blocked.');
  }
  if (!indexed) throw new Error('Synthetic guidance setup exceeded its repair bound.');
  const support = createSupportDeskApplication({
    store,
    clock,
    assistantHandlingEnabled: true,
    assistantTurns: { maxAttempts: 2 },
  });
  const producer = resolveAccess(
    { principalId: stageIds.owner },
    {
      version: 'fictional-producer-1',
      defaults: [supportPermissions.create, supportPermissions.assistantStart],
    },
  );
  await support.createCustomerTicket(producer, {
    commandId: 'stage-seed-ticket-' + scenario.scenarioId,
    correlationId: 'fictional-answer-stage-seed',
    ticketId: stageIds.ticket,
    messageId: 'stage-seed-message-' + scenario.scenarioId,
    subject: 'Workspace export help',
    body: 'How do I export my workspace?',
    initialHandling: 'assistant',
  });
  if (!current()) throw new Error('Synthetic stage seed window expired.');
  return { scenario, articleId: stageIds.article, ticketId: stageIds.ticket };
}
