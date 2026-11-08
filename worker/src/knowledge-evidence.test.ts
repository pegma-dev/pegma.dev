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
import { createMemoryStore } from '@pegma/storage-core';
import { describe, expect, it } from 'vitest';
import {
  createKnowledgeEvidenceService,
  knowledgeEvidenceRecords,
} from './knowledge-evidence';
import { PEGMA_ACCESS_POLICY } from './support-access';

const at = '2026-11-08T12:00:00.000Z';
const owner = resolveAccess(
  { principalId: 'author', roles: ['Admin'] },
  PEGMA_ACCESS_POLICY,
);
const reviewer = resolveAccess(
  { principalId: 'reviewer', roles: ['Support'] },
  PEGMA_ACCESS_POLICY,
);
const other = resolveAccess(
  { principalId: 'other-author', roles: ['Admin'] },
  PEGMA_ACCESS_POLICY,
);
const restricted = (access: AccessContext): AccessContext => ({
  ...access,
  permissions: [
    knowledgePermissions.draftRead,
    knowledgePermissions.evidenceSubmit,
  ],
});

async function fixture(options: { portal?: boolean } = {}) {
  const store = createMemoryStore();
  let now = at;
  const clock = { now: () => now };
  const principals = new Map([
    [owner.principalId, owner],
    [reviewer.principalId, reviewer],
    [other.principalId, other],
  ]);
  let app: KnowledgeBaseApplication;
  const evidence = createKnowledgeEvidenceService({
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
  });
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
    reportId: ack.reportId,
  });
  const confirm = {
    commandId: 'confirm-1',
    articleId: 'guide',
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
  it('requires a browser-authorized human review before actual KB acceptance', async () => {
    const f = await fixture();
    expect(f.view.status).toBe('pending');
    expect(Object.keys(f.ack).sort()).toEqual([
      'receipt',
      'reportGeneration',
      'reportId',
    ]);
    await expect(f.accept()).rejects.toThrow();
    await expect(
      f.evidence.decide(f.agent, f.confirm, 'confirmed'),
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
      id: f.ack.reportId,
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
    const rows = f.store.collection(knowledgeEvidenceRecords);
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
        reportId: f.ack.reportId,
      }),
    ).toEqual({ ...f.ack, reportGeneration: 2, status: 'confirmed' });
    await expect(
      f.evidence.status(restricted(other), {
        articleId: 'guide',
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
      reportId: wrong.reportId,
    });
    await f.evidence.decide(
      reviewer,
      {
        ...f.confirm,
        commandId: 'review-wrong-runner',
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
        reportId: report.reportId,
      });
      await f.evidence.decide(
        reviewer,
        {
          commandId: 'confirm-' + checkId,
          articleId: 'guide',
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
    const rows = f.store.collection(knowledgeEvidenceRecords);
    const before = await rows.list('guide');
    await expect(
      f.evidence.report(f.agent, { ...f.input, commandId: 'report-over-cap' }),
    ).rejects.toMatchObject({ code: 'report_capacity' });
    expect(await rows.list('guide')).toEqual(before);
    expect(
      (await f.evidence.list(reviewer, { articleId: 'guide' })).reports,
    ).toHaveLength(16);
  });
});
