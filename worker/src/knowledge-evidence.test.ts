import {
  hasPermission,
  resolveAccess,
  type AccessContext,
} from '@pegma/authorization-core';
import {
  createKnowledgeBaseApplication,
  type KnowledgeBaseApplication,
} from '@pegma/knowledge-base-application';
import {
  articleKinds,
  knowledgePermissions,
  type ValidationPolicy,
} from '@pegma/knowledge-base-contracts';
import {
  validateValidationPolicy,
  type EvidenceSubmission,
} from '@pegma/knowledge-base-core';
import {
  createMemoryStore,
  type CollectionDefinition,
  type CollectionStore,
  type Store,
} from '@pegma/storage-core';
import { describe, expect, it } from 'vitest';
import {
  createKnowledgeEvidenceService,
  KnowledgeLedgerError,
  type KnowledgeEvidenceOptions,
} from './knowledge-evidence';
import { ApiError } from './api-auth';
import {
  KNOWLEDGE_ROLE,
  PEGMA_ACCESS_POLICY,
  SUPPORT_ROLE,
} from './support-access';

const at = '2026-11-08T12:00:00.000Z';
const owner = resolveAccess(
  { principalId: 'author', roles: ['Admin'] },
  PEGMA_ACCESS_POLICY,
);
const reviewer = resolveAccess(
  { principalId: 'reviewer', roles: [KNOWLEDGE_ROLE] },
  PEGMA_ACCESS_POLICY,
);
const other = resolveAccess(
  { principalId: 'other-author', roles: ['Admin'] },
  PEGMA_ACCESS_POLICY,
);
const legacySupport = resolveAccess(
  { principalId: 'legacy-support', roles: [SUPPORT_ROLE] },
  PEGMA_ACCESS_POLICY,
);
const restricted = (access: AccessContext): AccessContext => ({
  ...access,
  permissions: [
    knowledgePermissions.draftRead,
    knowledgePermissions.evidenceSubmit,
  ],
});

interface StoredReportRow {
  readonly articleId: string;
  readonly id: string;
  readonly payload: string;
}

async function fixture(options: { portal?: boolean } = {}) {
  const backing = createMemoryStore();
  let reportDefinition: CollectionDefinition<StoredReportRow> | undefined;
  const store: Store = {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      if (definition.name === 'pegma-dev.knowledge-evidence.v1')
        reportDefinition =
          definition as unknown as CollectionDefinition<StoredReportRow>;
      return backing.collection(definition);
    },
  };
  function reportRows() {
    if (reportDefinition === undefined)
      throw new Error('The public report factory did not open its collection.');
    return backing.collection(reportDefinition);
  }
  let now = at;
  const clock = { now: () => now };
  const principals = new Map([
    [owner.principalId, owner],
    [reviewer.principalId, reviewer],
    [other.principalId, other],
    [legacySupport.principalId, legacySupport],
  ]);
  let app: KnowledgeBaseApplication;
  const evidenceOptions: KnowledgeEvidenceOptions = {
    store,
    clock,
    resolvePrincipal: async (id) => principals.get(id) ?? null,
    async readContext(access, articleId) {
      const draft = await app.getDraft(access, { articleId });
      const requirements = await app.getValidationRequirements(access, {
        collectionId: draft.revision.collectionId,
        kind: draft.revision.kind,
      });
      return {
        draft,
        requirements,
        ...(hasPermission(access, knowledgePermissions.evidenceRead)
          ? { evidence: await app.getEvidence(access, { articleId }) }
          : {}),
      };
    },
  };
  const freshEvidence = (overrides: Partial<KnowledgeEvidenceOptions> = {}) =>
    createKnowledgeEvidenceService({ ...evidenceOptions, ...overrides });
  const evidence = freshEvidence();
  app = createKnowledgeBaseApplication({
    store,
    clock,
    evidenceVerifier: evidence.verifier,
  });
  await app.createCollection(owner, {
    commandId: 'collection',
    correlationId: 'setup',
    expectedGeneration: 0,
    collectionId: 'guides',
    name: 'Guides',
  });
  const policy: ValidationPolicy = {
    id: 'guide-policy',
    version: 1,
    requirements: [
      ...articleKinds.map((kind) => ({
        id: kind + '-content',
        kind,
        testKind: 'content',
        maxAgeMilliseconds: 60_000,
        trustedRunnerIds: ['runner'],
      })),
      {
        id: 'walkthrough-workflow',
        kind: 'walkthrough',
        testKind: 'workflow',
        maxAgeMilliseconds: 60_000,
        trustedRunnerIds: ['runner'],
      },
      {
        id: 'staging-check',
        kind: 'walkthrough',
        testKind: 'staging',
        maxAgeMilliseconds: 60_000,
        trustedRunnerIds: ['runner'],
      },
    ],
  };
  validateValidationPolicy(policy);
  await app.putValidationPolicy(owner, {
    commandId: 'policy',
    correlationId: 'setup',
    expectedGeneration: 0,
    policy,
  });
  await app.putGovernanceConfiguration(owner, {
    commandId: 'governance',
    correlationId: 'setup',
    expectedGeneration: 1,
    collectionId: 'guides',
    configuration: {
      validationPolicy: { id: 'guide-policy', version: 1 },
      expectedStagingBuildId: 'staging-1',
      trustedAttesterIds: ['reviewer'],
    },
  });
  if (options.portal === true) {
    const preview = await app.previewCollectionPolicy(owner, {
      collectionId: 'guides',
      uses: {
        portal: {
          enabled: true,
          audience: {
            kind: 'permission',
            permission: knowledgePermissions.articleRead,
          },
        },
        bot: { enabled: false },
      },
    });
    await app.updateCollectionPolicy(owner, {
      commandId: 'portal',
      correlationId: 'setup',
      expectedGeneration: preview.generation,
      collectionId: 'guides',
      preview: preview.preview,
    });
  }
  const draft = {
    kind: 'walkthrough' as const,
    title: 'Reset an example setting',
    summary: 'A bounded synthetic guide.',
    content: {
      format: 'plain_text' as const,
      text: 'Open the example settings and reset the setting.',
    },
    tags: ['settings'],
    applicability: {
      productId: 'example',
      productVersion: '1',
      buildId: 'staging-1',
    },
  };
  await app.createDraft(owner, {
    commandId: 'draft',
    correlationId: 'setup',
    expectedGeneration: 0,
    articleId: 'guide',
    collectionId: 'guides',
    draft,
  });
  const revision = (await app.getDraft(owner, { articleId: 'guide' })).revision;
  const submission: EvidenceSubmission = {
    id: 'run-1',
    articleId: 'guide',
    articleRevision: revision.number,
    contentHash: revision.contentHash,
    validationPolicy: revision.validationPolicy,
    checkId: 'staging-check',
    testKind: 'staging',
    applicability: revision.applicability,
    stagingBuildId: 'staging-1',
    steps: ['Open settings.', 'Reset the example setting.'],
    result: 'passed',
    executedAt: at,
    runnerId: 'runner',
    artifacts: [{ id: 'report-artifact', hash: 'a'.repeat(64) }],
  };
  const input = {
    commandId: 'report-1',
    articleId: 'guide',
    ledgerEpoch: 1,
    evidence: submission,
    report: {
      summary: 'Staging test passed',
      details: 'Observed the expected example setting after reset.',
    },
  };
  const agent = restricted(owner);
  const ack = await evidence.report(agent, input);
  const view = await evidence.read(reviewer, {
    articleId: 'guide',
    ledgerEpoch: ack.ledgerEpoch,
    reportId: ack.reportId,
  });
  const confirm = {
    commandId: 'confirm-1',
    articleId: 'guide',
    ledgerEpoch: ack.ledgerEpoch,
    reportId: ack.reportId,
    expectedReportGeneration: view.expectedReportGeneration,
    reviewBindingHash: view.reviewBindingHash,
  };
  const accept = async (
    access = agent,
    fullEvidence = submission,
    commandId = 'accept-1',
  ) =>
    app.submitEvidence(access, {
      commandId,
      correlationId: 'test',
      expectedGeneration: (await app.getDraft(owner, { articleId: 'guide' }))
        .generation,
      articleId: 'guide',
      evidence: fullEvidence,
      receipt: ack.receipt,
    });
  return {
    store,
    reportRows,
    reportDefinition: () => {
      if (reportDefinition === undefined)
        throw new Error('Missing the actual report collection definition.');
      return reportDefinition;
    },
    freshEvidence,
    app,
    evidence,
    clock,
    principals,
    agent,
    submission,
    input,
    ack,
    view,
    confirm,
    accept,
    draft,
    setTime(value: string) {
      now = value;
    },
  };
}

describe('stored staff report confirmation', () => {
  it('reopens retained raw ledger rows without changing physical keys, payloads or receipts', async () => {
    const f = await fixture();
    const confirmed = await f.evidence.decide(reviewer, f.confirm, 'confirmed');
    const rows = f.reportRows();
    const before = await rows.listVersioned('guide');
    const definition = f.reportDefinition();
    const physical = await rows.scan({ limit: 160 });
    expect(physical.nextCursor).toBeNull();
    expect(physical.records).toHaveLength(before.length);
    for (const item of physical.records) {
      expect(item.key).toEqual({ partition: 'guide', id: item.value.id });
      expect(definition.codec.encode(item.value)).toEqual({
        articleId: 'guide',
        id: item.value.id,
        payload: item.value.payload,
      });
    }
    expect(f.ack.receipt).toBe('e1.1.' + f.ack.reportId);
    expect(confirmed.receipt).toBe(f.ack.receipt);

    const fresh = f.freshEvidence();
    expect(fresh.agentReports).toEqual(
      expect.objectContaining({
        ledger: expect.any(Function),
        report: expect.any(Function),
        status: expect.any(Function),
      }),
    );
    expect(
      await fresh.status(f.agent, {
        articleId: 'guide',
        ledgerEpoch: f.ack.ledgerEpoch,
        reportId: f.ack.reportId,
      }),
    ).toEqual({ ...confirmed, status: 'confirmed' });
    expect(
      await fresh.agentReports.status(f.agent, {
        articleId: 'guide',
        ledgerEpoch: f.ack.ledgerEpoch,
        reportId: f.ack.reportId,
      }),
    ).toEqual({ ...confirmed, status: 'confirmed' });
    expect(await fresh.report(f.agent, f.input)).toEqual(f.ack);
    expect(await fresh.decide(reviewer, f.confirm, 'confirmed')).toEqual(
      confirmed,
    );
    expect(await rows.listVersioned('guide')).toEqual(before);

    const reopened = createKnowledgeBaseApplication({
      store: f.store,
      clock: f.clock,
      evidenceVerifier: fresh.verifier,
    });
    await reopened.submitEvidence(f.agent, {
      commandId: 'accept-retained-receipt',
      correlationId: 'test',
      expectedGeneration: (
        await reopened.getDraft(owner, { articleId: 'guide' })
      ).generation,
      articleId: 'guide',
      evidence: f.submission,
      receipt: f.ack.receipt,
    });
    expect(
      (await reopened.getEvidence(owner, { articleId: 'guide' })).evidence[0]
        ?.attestation.id,
    ).toBe(f.ack.receipt);
    expect(await rows.listVersioned('guide')).toEqual(before);
  });

  it('keeps a missing actual KB target as a safe HTTP not-found refusal', async () => {
    const f = await fixture();
    const before = await f.reportRows().scan({ limit: 160 });
    await expect(
      f.evidence.report(f.agent, {
        ...f.input,
        commandId: 'missing-target',
        articleId: 'missing-guide',
        evidence: { ...f.submission, articleId: 'missing-guide' },
      }),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect(await f.reportRows().scan({ limit: 160 })).toEqual(before);
  });

  it('preserves a controlled host context conflict and safely classifies an unknown read failure', async () => {
    const f = await fixture();
    const before = await f.reportRows().listVersioned('guide');
    const key = {
      articleId: 'guide',
      ledgerEpoch: 1,
      reportId: f.ack.reportId,
    };
    const conflict = f.freshEvidence({
      async readContext() {
        throw new ApiError(409, 'report_target_changed');
      },
    });
    await expect(conflict.read(reviewer, key)).rejects.toMatchObject({
      status: 409,
      code: 'report_target_changed',
    });
    const unavailable = f.freshEvidence({
      async readContext() {
        throw new Error('private-context-error-marker');
      },
    });
    const failure: unknown = await unavailable
      .read(reviewer, key)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(KnowledgeLedgerError);
    expect(failure).toMatchObject({
      stage: 'context_read',
      message: 'Knowledge report ledger is unavailable.',
    });
    expect(JSON.stringify(failure)).not.toContain(
      'private-context-error-marker',
    );
    expect(await f.reportRows().listVersioned('guide')).toEqual(before);
  });

  it('lists the exact current report identity without changing ledger rows', async () => {
    const f = await fixture();
    const rows = f.reportRows();
    const before = await rows.listVersioned('guide');
    const result = await f.evidence.list(reviewer, { articleId: 'guide' });
    expect(result.reports).toEqual([
      {
        articleId: 'guide',
        ledgerEpoch: f.ack.ledgerEpoch,
        reportId: f.ack.reportId,
        reportGeneration: f.ack.reportGeneration,
        status: 'pending',
        submittedBy: f.agent.principalId,
        submittedAt: at,
        summary: f.input.report.summary,
      },
    ]);
    expect(await rows.listVersioned('guide')).toEqual(before);
  });

  it.each([
    { field: 'articleId', value: 'other-guide' },
    { field: 'ledgerEpoch', value: 2 },
    { field: 'reportId', value: 'other-report' },
  ])(
    'refuses a payload-only $field mismatch without writing ledger rows',
    async ({ field, value }) => {
      const f = await fixture();
      const rows = f.reportRows();
      const key = {
        partition: 'guide',
        id: 'report:' + f.ack.ledgerEpoch + ':' + f.ack.reportId,
      };
      const before = await rows.listVersioned('guide');
      const report = await rows.get(key);
      if (report === null)
        throw new Error('Expected the actual stored report.');
      const payload = JSON.parse(report.payload) as Record<string, unknown>;
      await rows.put({
        ...report,
        payload: JSON.stringify({ ...payload, [field]: value }),
      });
      const corrupted = await rows.listVersioned('guide');
      expect(corrupted).toHaveLength(before.length);
      expect(corrupted.filter((item) => item.value.id !== key.id)).toEqual(
        before.filter((item) => item.value.id !== key.id),
      );
      expect(await rows.get(key)).toMatchObject({
        articleId: 'guide',
        id: key.id,
      });

      const failure = await f.evidence
        .list(reviewer, { articleId: 'guide' })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(failure).toBeInstanceOf(KnowledgeLedgerError);
      expect(failure).toMatchObject({
        stage: 'report_identity',
        message: 'Knowledge report ledger is unavailable.',
      });
      expect(await rows.listVersioned('guide')).toEqual(corrupted);
    },
  );

  it('requires a browser-authorized human review before actual KB acceptance', async () => {
    const f = await fixture();
    expect(f.view.status).toBe('pending');
    expect(Object.keys(f.ack).sort()).toEqual([
      'ledgerEpoch',
      'receipt',
      'reportGeneration',
      'reportId',
    ]);
    await expect(f.accept()).rejects.toThrow();
    await expect(
      f.evidence.decide(f.agent, f.confirm, 'confirmed'),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      f.evidence.decide(legacySupport, f.confirm, 'confirmed'),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      f.evidence.read(legacySupport, {
        articleId: 'guide',
        ledgerEpoch: f.ack.ledgerEpoch,
        reportId: f.ack.reportId,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await f.evidence.decide(reviewer, f.confirm, 'confirmed'),
    ).toMatchObject({ reportGeneration: 2 });
    expect(
      (await f.app.getEvidence(owner, { articleId: 'guide' })).evidence,
    ).toEqual([]);
    await f.accept();
    const actual = (await f.app.getEvidence(owner, { articleId: 'guide' }))
      .evidence[0];
    expect(actual?.attestation).toEqual({
      id: f.ack.receipt,
      verifiedBy: reviewer.principalId,
      verifiedAt: at,
    });
    expect(actual?.runnerId).toBe('runner');
    expect(actual?.artifacts).toEqual(f.submission.artifacts);
    expect(hasPermission(reviewer, knowledgePermissions.validationManage)).toBe(
      false,
    );
  });

  it('binds the full report, actor and submission with exact immutable command replay', async () => {
    const f = await fixture();
    const rows = f.reportRows();
    const count = (await rows.list('guide')).length;
    expect(await f.evidence.report(f.agent, f.input)).toEqual(f.ack);
    expect((await rows.list('guide')).length).toBe(count);
    await expect(
      f.evidence.report(f.agent, {
        ...f.input,
        report: { ...f.input.report, details: 'Changed result narrative.' },
      }),
    ).rejects.toMatchObject({ status: 409 });
    await f.evidence.decide(reviewer, f.confirm, 'confirmed');
    const afterConfirm = (await rows.list('guide')).length;
    expect(
      await f.evidence.decide(reviewer, f.confirm, 'confirmed'),
    ).toMatchObject({ reportGeneration: 2 });
    expect((await rows.list('guide')).length).toBe(afterConfirm);
    await expect(f.accept(restricted(other))).rejects.toThrow();
    await expect(
      f.accept(f.agent, { ...f.submission, result: 'failed' }),
    ).rejects.toThrow();
    await expect(
      f.accept(f.agent, {
        ...f.submission,
        artifacts: [{ id: 'report-artifact', hash: 'b'.repeat(64) }],
      }),
    ).rejects.toThrow();
    expect(
      await f.evidence.status(f.agent, {
        articleId: 'guide',
        ledgerEpoch: f.ack.ledgerEpoch,
        reportId: f.ack.reportId,
      }),
    ).toEqual({ ...f.ack, reportGeneration: 2, status: 'confirmed' });
    await expect(
      f.evidence.status(restricted(other), {
        articleId: 'guide',
        ledgerEpoch: f.ack.ledgerEpoch,
        reportId: f.ack.reportId,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('rejects confirmation of a changed draft or changed governance generation', async () => {
    const f = await fixture();
    await f.app.updateDraft(owner, {
      commandId: 'edit',
      correlationId: 'test',
      expectedGeneration: 1,
      articleId: 'guide',
      collectionId: 'guides',
      draft: { ...f.draft, title: 'Changed example guide' },
    });
    await expect(
      f.evidence.decide(reviewer, f.confirm, 'confirmed'),
    ).rejects.toMatchObject({ status: 409 });
    const g = await fixture();
    await g.app.putGovernanceConfiguration(owner, {
      commandId: 'new-governance',
      correlationId: 'test',
      expectedGeneration: 2,
      collectionId: 'guides',
      configuration: {
        validationPolicy: { id: 'guide-policy', version: 1 },
        expectedStagingBuildId: 'staging-2',
        trustedAttesterIds: ['reviewer'],
      },
    });
    await expect(
      g.evidence.decide(reviewer, g.confirm, 'confirmed'),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('preserves execution age and fails closed after reviewer revocation', async () => {
    const f = await fixture();
    await f.evidence.decide(reviewer, f.confirm, 'confirmed');
    f.setTime('2026-11-08T12:01:00.001Z');
    await expect(f.accept()).rejects.toThrow();
    const g = await fixture();
    await g.evidence.decide(reviewer, g.confirm, 'confirmed');
    g.principals.set(
      reviewer.principalId,
      resolveAccess({ principalId: reviewer.principalId }, PEGMA_ACCESS_POLICY),
    );
    await expect(g.accept()).rejects.toThrow();
    await expect(
      g.evidence.read(reviewer, {
        articleId: 'guide',
        ledgerEpoch: g.ack.ledgerEpoch,
        reportId: g.ack.reportId,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('keeps runner trust and exact evidence revocation in the real KB', async () => {
    const f = await fixture();
    const wrong = await f.evidence.report(f.agent, {
      ...f.input,
      commandId: 'wrong-runner',
      evidence: {
        ...f.submission,
        id: 'wrong-run',
        runnerId: 'untrusted-runner',
      },
    });
    const read = await f.evidence.read(reviewer, {
      articleId: 'guide',
      ledgerEpoch: wrong.ledgerEpoch,
      reportId: wrong.reportId,
    });
    await f.evidence.decide(
      reviewer,
      {
        ...f.confirm,
        commandId: 'review-wrong-runner',
        ledgerEpoch: wrong.ledgerEpoch,
        reportId: wrong.reportId,
        expectedReportGeneration: read.expectedReportGeneration,
        reviewBindingHash: read.reviewBindingHash,
      },
      'confirmed',
    );
    await expect(
      f.app.submitEvidence(f.agent, {
        commandId: 'accept-wrong-runner',
        correlationId: 'test',
        expectedGeneration: 1,
        articleId: 'guide',
        evidence: {
          ...f.submission,
          id: 'wrong-run',
          runnerId: 'untrusted-runner',
        },
        receipt: wrong.receipt,
      }),
    ).rejects.toThrow();
    await f.evidence.decide(reviewer, f.confirm, 'confirmed');
    await f.accept();
    const accepted = (await f.app.getEvidence(owner, { articleId: 'guide' }))
      .evidence[0];
    if (accepted === undefined) throw new Error('Missing actual evidence.');
    await f.app.revokeEvidence(owner, {
      commandId: 'revoke',
      correlationId: 'test',
      expectedGeneration: 2,
      articleId: 'guide',
      articleRevision: 1,
      evidenceId: accepted.id,
      evidenceVersion: accepted.version,
      evidenceHash: accepted.hash,
      reason: 'Staff withdrew the test result.',
    });
    expect(
      (await f.app.getEvidence(owner, { articleId: 'guide' })).revokedEvidence,
    ).toEqual([
      expect.objectContaining({
        id: accepted.id,
        version: accepted.version,
        hash: accepted.hash,
        articleRevision: 1,
      }),
    ]);
    await expect(
      f.accept(f.agent, f.submission, 'reuse-revoked'),
    ).rejects.toThrow();
    expect(
      (await f.app.getProvenance(owner, { articleId: 'guide' })).snapshot
        .references,
    ).toEqual([]);
  });

  it('retains approved v1 after evidence age passes and a separate v2 draft clears current evidence', async () => {
    const f = await fixture({ portal: true });
    await f.evidence.decide(reviewer, f.confirm, 'confirmed');
    await f.accept();
    for (const [checkId, testKind] of [
      ['walkthrough-content', 'content'],
      ['walkthrough-workflow', 'workflow'],
    ]) {
      if (checkId === undefined || testKind === undefined)
        throw new Error('Missing required synthetic check.');
      const submission = {
        ...f.submission,
        id: checkId + '-run',
        checkId,
        testKind,
      };
      const report = await f.evidence.report(f.agent, {
        ...f.input,
        commandId: 'report-' + checkId,
        evidence: submission,
      });
      const view = await f.evidence.read(reviewer, {
        articleId: 'guide',
        ledgerEpoch: report.ledgerEpoch,
        reportId: report.reportId,
      });
      await f.evidence.decide(
        reviewer,
        {
          commandId: 'confirm-' + checkId,
          articleId: 'guide',
          ledgerEpoch: report.ledgerEpoch,
          reportId: report.reportId,
          expectedReportGeneration: view.expectedReportGeneration,
          reviewBindingHash: view.reviewBindingHash,
        },
        'confirmed',
      );
      await f.app.submitEvidence(f.agent, {
        commandId: 'submit-' + checkId,
        correlationId: 'test',
        articleId: 'guide',
        expectedGeneration: (
          await f.app.getDraft(owner, { articleId: 'guide' })
        ).generation,
        evidence: submission,
        receipt: report.receipt,
      });
    }
    await f.app.submitForReview(reviewer, {
      commandId: 'review',
      correlationId: 'test',
      articleId: 'guide',
      expectedGeneration: (await f.app.getDraft(owner, { articleId: 'guide' }))
        .generation,
    });
    const review = await f.app.getReview(reviewer, { articleId: 'guide' });
    await f.app.publishArticle(reviewer, {
      commandId: 'publish',
      correlationId: 'test',
      articleId: 'guide',
      expectedGeneration: review.generation,
      review: review.review,
    });
    const customer = resolveAccess(
      { principalId: 'customer' },
      PEGMA_ACCESS_POLICY,
    );
    const published = await f.app.getPublishedArticle(customer, {
      articleId: 'guide',
    });
    expect(published.revision).toBe(1);
    const acceptedEvidence = await f.app.getEvidence(owner, {
      articleId: 'guide',
    });
    await f.evidence.reset(reviewer, {
      commandId: 'retention-reset',
      articleId: 'guide',
      expectedLedgerEpoch: 1,
    });
    await f.evidence.drain(reviewer, { articleId: 'guide', ledgerEpoch: 2 });
    expect(await f.app.getEvidence(owner, { articleId: 'guide' })).toEqual(
      acceptedEvidence,
    );
    expect(
      await f.app.getPublishedArticle(customer, { articleId: 'guide' }),
    ).toEqual(published);
    f.setTime('2026-11-08T12:02:00.000Z');
    expect(
      await f.app.getPublishedArticle(customer, { articleId: 'guide' }),
    ).toEqual(published);
    await f.app.updateDraft(owner, {
      commandId: 'v2',
      correlationId: 'test',
      articleId: 'guide',
      collectionId: 'guides',
      expectedGeneration: (await f.app.getDraft(owner, { articleId: 'guide' }))
        .generation,
      draft: { ...f.draft, title: 'Unapproved v2' },
    });
    expect(
      (await f.app.getDraft(owner, { articleId: 'guide' })).revision.number,
    ).toBe(2);
    expect(
      (await f.app.getEvidence(owner, { articleId: 'guide' })).evidence,
    ).toEqual([]);
    expect(
      await f.app.getPublishedArticle(customer, { articleId: 'guide' }),
    ).toEqual(published);
    const sources = await f.app.getProvenance(owner, { articleId: 'guide' });
    expect(sources.snapshot.references).toEqual([]);
    expect(sources.publishedSnapshot?.references).toEqual([]);
  });

  it('bounds the physical report ledger before admitting another report', async () => {
    const f = await fixture();
    for (let index = 1; index < 16; index += 1)
      await f.evidence.report(f.agent, {
        ...f.input,
        commandId: 'report-' + (index + 1),
      });
    const rows = f.reportRows();
    const before = await rows.list('guide');
    await expect(
      f.evidence.report(f.agent, { ...f.input, commandId: 'report-over-cap' }),
    ).rejects.toMatchObject({ code: 'report_capacity' });
    expect(await rows.list('guide')).toEqual(before);
    expect(
      (await f.evidence.list(reviewer, { articleId: 'guide' })).reports,
    ).toHaveLength(16);
  });

  it('restores bounded capacity through a staff epoch reset without reviving stale commands', async () => {
    const f = await fixture();
    for (let index = 1; index < 16; index += 1)
      await f.evidence.report(f.agent, {
        ...f.input,
        commandId: 'fill-' + index,
      });
    const reset = {
      commandId: 'reset-1',
      articleId: 'guide',
      expectedLedgerEpoch: f.ack.ledgerEpoch,
    };
    await expect(f.evidence.reset(f.agent, reset)).rejects.toMatchObject({
      status: 403,
    });
    const started = await f.evidence.reset(reviewer, reset);
    expect(started).toMatchObject({
      ledgerEpoch: 2,
      status: 'resetting',
      reportsRemaining: 0,
    });
    await expect(f.evidence.report(f.agent, f.input)).rejects.toMatchObject({
      code: 'ledger_epoch_changed',
    });
    await expect(
      f.evidence.report(f.agent, { ...f.input, ledgerEpoch: 2 }),
    ).rejects.toMatchObject({ code: 'ledger_resetting' });
    await expect(
      f.evidence.decide(reviewer, f.confirm, 'confirmed'),
    ).rejects.toMatchObject({ code: 'ledger_epoch_changed' });
    await expect(
      f.evidence.status(f.agent, {
        articleId: 'guide',
        ledgerEpoch: 1,
        reportId: f.ack.reportId,
      }),
    ).rejects.toMatchObject({ code: 'ledger_epoch_changed' });
    const rows = f.reportRows();
    let progress = started;
    let calls = 0;
    while (progress.status === 'resetting' && calls < 4) {
      const before = (await rows.list('guide')).length;
      progress = await f.evidence.drain(owner, {
        articleId: 'guide',
        ledgerEpoch: 2,
      });
      expect(before - (await rows.list('guide')).length).toBeLessThanOrEqual(
        48,
      );
      calls += 1;
    }
    expect(progress).toMatchObject({
      ledgerEpoch: 2,
      status: 'active',
      reportsRemaining: 16,
    });
    expect(await rows.list('guide')).toHaveLength(1);
    expect(await f.evidence.reset(reviewer, reset)).toEqual(progress);
    const fresh = await f.evidence.report(f.agent, {
      ...f.input,
      ledgerEpoch: 2,
    });
    const view = await f.evidence.read(reviewer, {
      articleId: 'guide',
      ledgerEpoch: 2,
      reportId: fresh.reportId,
    });
    await f.evidence.decide(
      reviewer,
      {
        ...f.confirm,
        commandId: 'confirm-fresh',
        ledgerEpoch: 2,
        reportId: fresh.reportId,
        expectedReportGeneration: view.expectedReportGeneration,
        reviewBindingHash: view.reviewBindingHash,
      },
      'confirmed',
    );
    await expect(
      f.accept(f.agent, f.submission, 'old-receipt'),
    ).rejects.toThrow();
    await f.app.submitEvidence(f.agent, {
      commandId: 'fresh-receipt',
      correlationId: 'test',
      expectedGeneration: 1,
      articleId: 'guide',
      evidence: f.submission,
      receipt: fresh.receipt,
    });
    expect(
      (await f.app.getEvidence(owner, { articleId: 'guide' })).evidence[0]
        ?.attestation.id,
    ).toBe(fresh.receipt);
    await f.evidence.reset(owner, {
      commandId: 'reset-2',
      articleId: 'guide',
      expectedLedgerEpoch: 2,
    });
    await f.evidence.drain(owner, { articleId: 'guide', ledgerEpoch: 3 });
    await expect(f.evidence.reset(reviewer, reset)).rejects.toMatchObject({
      code: 'ledger_epoch_changed',
    });
    expect(await rows.list('guide')).toHaveLength(1);
  });

  it('allows a trusted human to reassess an unaccepted confirmation and invalidates its old receipt cycle', async () => {
    const f = await fixture();
    await f.evidence.decide(
      owner,
      { ...f.confirm, commandId: 'owner-review' },
      'confirmed',
    );
    await expect(f.accept()).rejects.toThrow();
    const view = await f.evidence.read(reviewer, {
      articleId: 'guide',
      ledgerEpoch: 1,
      reportId: f.ack.reportId,
    });
    const pending = await f.evidence.decide(
      reviewer,
      {
        ...f.confirm,
        commandId: 'reassess',
        expectedReportGeneration: view.expectedReportGeneration,
        reviewBindingHash: view.reviewBindingHash,
      },
      'pending',
    );
    expect(pending.receipt).not.toBe(f.ack.receipt);
    const updated = await f.evidence.read(reviewer, {
      articleId: 'guide',
      ledgerEpoch: 1,
      reportId: f.ack.reportId,
    });
    expect(updated.status).toBe('pending');
    expect(updated.confirmation).toBeNull();
    await f.evidence.decide(
      reviewer,
      {
        ...f.confirm,
        commandId: 'trusted-review',
        expectedReportGeneration: updated.expectedReportGeneration,
        reviewBindingHash: updated.reviewBindingHash,
      },
      'confirmed',
    );
    await expect(
      f.accept(f.agent, f.submission, 'old-cycle'),
    ).rejects.toThrow();
    await f.app.submitEvidence(f.agent, {
      commandId: 'new-cycle',
      correlationId: 'test',
      expectedGeneration: 1,
      articleId: 'guide',
      evidence: f.submission,
      receipt: pending.receipt,
    });
    expect(
      (await f.app.getEvidence(owner, { articleId: 'guide' })).evidence[0]
        ?.attestation.id,
    ).toBe(pending.receipt);
  });

  it('allows an explicitly trusted Admin to human-review their own agent report', async () => {
    const f = await fixture();
    await f.app.putGovernanceConfiguration(owner, {
      commandId: 'trust-owner',
      correlationId: 'test',
      expectedGeneration: 2,
      collectionId: 'guides',
      configuration: {
        validationPolicy: { id: 'guide-policy', version: 1 },
        expectedStagingBuildId: 'staging-1',
        trustedAttesterIds: [owner.principalId],
      },
    });
    const report = await f.evidence.report(f.agent, {
      ...f.input,
      commandId: 'same-owner-report',
    });
    const view = await f.evidence.read(owner, {
      articleId: 'guide',
      ledgerEpoch: report.ledgerEpoch,
      reportId: report.reportId,
    });
    await f.evidence.decide(
      owner,
      {
        commandId: 'same-owner-confirm',
        articleId: 'guide',
        ledgerEpoch: report.ledgerEpoch,
        reportId: report.reportId,
        expectedReportGeneration: view.expectedReportGeneration,
        reviewBindingHash: view.reviewBindingHash,
      },
      'confirmed',
    );
    await f.app.submitEvidence(f.agent, {
      commandId: 'same-owner-accept',
      correlationId: 'test',
      expectedGeneration: 1,
      articleId: 'guide',
      evidence: f.submission,
      receipt: report.receipt,
    });
    expect(
      (await f.app.getEvidence(owner, { articleId: 'guide' })).evidence[0]
        ?.attestation.verifiedBy,
    ).toBe(owner.principalId);
  });
});
