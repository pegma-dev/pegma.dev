import { identityLinkKeyFromVerifiedIdentityClaims } from '@pegma/authorization-identity';
import { createRoleStore } from '@pegma/authorization-storage';
import { retrievalRecords } from '@pegma/knowledge-base-application';
import {
  articleKinds,
  knowledgePermissions,
  type ValidationPolicy,
} from '@pegma/knowledge-base-contracts';
import type { EvidenceSubmission } from '@pegma/knowledge-base-core';
import { createSessionStore } from '@pegma/sessions';
import { fixedClock, type PrincipalId } from '@pegma/spine';
import {
  createMemoryStore,
  type CollectionDefinition,
  type CollectionStore,
  type Store,
} from '@pegma/storage-core';
import { describe, expect, it, vi } from 'vitest';
import { createAgentPrincipalResolver } from './agent-authority';
import { IDENTITY_ISSUER, SESSION_COOKIE } from './identity-api';
import type { IdentityPort, IdentityUser } from './identity-contracts';
import { createKnowledgeRuntime } from './knowledge-runtime';
import {
  ADMIN_ROLE,
  APPLICATION_SCOPE,
  AUTHORIZATION_APPLICATION_ID,
  KNOWLEDGE_ROLE,
  SUPPORT_ROLE,
} from './support-access';

const authorId = 'portal-author';
const readerId = 'portal-reader';
const otherId = 'portal-other-reader';
const customerId = 'portal-customer';
const collectionId = 'restricted-guides';
const articleId = 'restricted-export';
const privateLabel = 'Restricted export collection';
const privateTitle = 'Restricted export guide';
const privateText = 'Export the restricted synthetic account settings.';
const operations = [
  'getPublishedArticle',
  'searchPublishedArticles',
  'listPortalCollections',
] as const;
type Operation = (typeof operations)[number];

async function fixture() {
  const backing = createMemoryStore();
  let afterRead: (() => Promise<void>) | undefined;
  let reads = 0;
  const store: Store = {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      const target = backing.collection(definition);
      if (
        definition.name !== 'knowledge-base.records.v1' &&
        definition.name !== retrievalRecords.name
      )
        return target;
      async function observed() {
        reads += 1;
        const hook = afterRead;
        afterRead = undefined;
        await hook?.();
      }
      // Pause only after the real adapter has returned its actual KB facts.
      return {
        ...target,
        list(partition) {
          reads += 1;
          return target.list(partition);
        },
        listVersioned(partition) {
          reads += 1;
          return target.listVersioned(partition);
        },
        scan(options) {
          reads += 1;
          return target.scan(options);
        },
        async get(key) {
          const value = await target.get(key);
          await observed();
          return value;
        },
        async getVersioned(key) {
          const value = await target.getVersioned(key);
          await observed();
          return value;
        },
      };
    },
  };
  const clock = fixedClock('2026-11-08T12:00:00.000Z');
  const logger = { log: vi.fn() };
  const roleStore = createRoleStore(store, AUTHORIZATION_APPLICATION_ID);
  const sessions = createSessionStore(store, { logger, clock });
  const users = new Map<PrincipalId, IdentityUser>(
    [authorId, readerId, otherId, customerId].map((principalId) => [
      principalId,
      {
        principalId,
        email: principalId + '@example.test',
        emailVerified: true,
        status: 'active',
        createdAt: clock.now(),
        updatedAt: clock.now(),
      },
    ]),
  );
  // Identity is the external authority port; sessions, roles and KB state use
  // their real released services over the same MemoryStore.
  const identity: IdentityPort = {
    async claimsFor(id) {
      const user = users.get(id);
      if (user === undefined || user.status !== 'active' || !user.emailVerified)
        throw Object.assign(new Error('Unavailable synthetic account.'), {
          code: 'invalid_state',
        });
      return {
        issuer: IDENTITY_ISSUER,
        subject: id,
        emailVerified: true,
      };
    },
    getUser: async (id) => users.get(id) ?? null,
    findUserByEmail: async () => null,
    beginPasskeyRegistration: vi.fn(),
    finishPasskeyRegistration: vi.fn(),
    beginPasskeyAuthentication: vi.fn(),
    finishPasskeyAuthentication: vi.fn(),
    listPasskeys: async () => [],
    removePasskey: async () => true,
  };
  async function grant(id: string, principalId: string, role: string) {
    await roleStore.grantRoleAssignmentWithAudit({
      assignment: {
        id,
        principalId,
        role,
        scope: APPLICATION_SCOPE,
        grantedBy: { kind: 'system', systemId: 'synthetic-portal-test' },
        grantedAtEpochMs: Date.parse(clock.now()),
        status: 'active',
      },
      auditEventId: 'grant-' + id,
    });
  }
  await grant('author-admin', authorId, ADMIN_ROLE);
  await grant('reader-knowledge', readerId, KNOWLEDGE_ROLE);
  await grant('other-knowledge', otherId, KNOWLEDGE_ROLE);
  const sessionIds = new Map<string, string>();
  for (const [index, principalId] of [
    authorId,
    readerId,
    otherId,
    customerId,
    readerId,
  ].entries()) {
    const id = String(index + 1).repeat(43);
    await sessions.create(id, {
      principalId,
      data: JSON.stringify({
        version: 1,
        csrfToken: 'c'.repeat(43),
        issuer: IDENTITY_ISSUER,
        subject: principalId,
      }),
    });
    sessionIds.set(index === 4 ? 'reader-second-session' : principalId, id);
  }
  const options = {
    store,
    clock,
    logger,
    sessions,
    roleStore,
    identity,
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
  };
  const resolve = createAgentPrincipalResolver(options);
  const author = await resolve(authorId);
  if (author === null) throw new Error('Missing real author authority.');
  const runtime = createKnowledgeRuntime({ ...options, agentAccess: null });
  const app = runtime.application;
  await app.createCollection(author, {
    commandId: 'collection',
    correlationId: 'setup',
    expectedGeneration: 0,
    collectionId,
    name: privateLabel,
  });
  const preview = await app.previewCollectionPolicy(author, {
    collectionId,
    uses: {
      portal: {
        enabled: true,
        audience: {
          kind: 'permission',
          permission: knowledgePermissions.draftRead,
        },
      },
      bot: { enabled: false },
    },
  });
  await app.updateCollectionPolicy(author, {
    commandId: 'audience',
    correlationId: 'setup',
    collectionId,
    expectedGeneration: preview.generation,
    preview: preview.preview,
  });
  const policy: ValidationPolicy = {
    id: 'portal-policy',
    version: 1,
    requirements: [
      ...articleKinds.map((kind) => ({
        id: kind + '-content',
        kind,
        testKind: 'content' as const,
        maxAgeMilliseconds: 60_000,
        trustedRunnerIds: ['portal-runner'],
      })),
      {
        id: 'walkthrough-workflow',
        kind: 'walkthrough',
        testKind: 'workflow',
        maxAgeMilliseconds: 60_000,
        trustedRunnerIds: ['portal-runner'],
      },
      {
        id: 'walkthrough-staging',
        kind: 'walkthrough',
        testKind: 'staging',
        maxAgeMilliseconds: 60_000,
        trustedRunnerIds: ['portal-runner'],
      },
    ],
  };
  await app.putValidationPolicy(author, {
    commandId: 'policy',
    correlationId: 'setup',
    expectedGeneration: 0,
    policy,
  });
  await app.putGovernanceConfiguration(author, {
    commandId: 'governance',
    correlationId: 'setup',
    collectionId,
    expectedGeneration: (await app.getCollection(author, { collectionId }))
      .generation,
    configuration: {
      validationPolicy: { id: policy.id, version: policy.version },
      expectedStagingBuildId: 'portal-build',
      trustedAttesterIds: [authorId],
    },
  });
  await app.createDraft(author, {
    commandId: 'draft',
    correlationId: 'setup',
    expectedGeneration: 0,
    articleId,
    collectionId,
    draft: {
      kind: 'explanation',
      title: privateTitle,
      summary: 'Restricted synthetic export instructions.',
      content: { format: 'plain_text', text: privateText },
      tags: ['export'],
      applicability: { productId: 'portal-product', productVersion: '1' },
    },
  });
  const current = await app.getDraft(author, { articleId });
  const evidence: EvidenceSubmission = {
    id: 'portal-content-run',
    articleId,
    articleRevision: current.revision.number,
    contentHash: current.revision.contentHash,
    validationPolicy: current.revision.validationPolicy,
    checkId: 'explanation-content',
    testKind: 'content',
    applicability: current.revision.applicability,
    stagingBuildId: 'portal-build',
    steps: ['Read and verify the synthetic export guide.'],
    result: 'passed',
    executedAt: clock.now(),
    runnerId: 'portal-runner',
    artifacts: [{ id: 'portal-artifact', hash: 'a'.repeat(64) }],
  };
  const report = await runtime.evidence.report(author, {
    commandId: 'report',
    articleId,
    ledgerEpoch: 1,
    evidence,
    report: {
      summary: 'Private test report.',
      details: 'Private test details.',
    },
  });
  const view = await runtime.evidence.read(author, {
    articleId,
    reportId: report.reportId,
    ledgerEpoch: report.ledgerEpoch,
  });
  await runtime.evidence.decide(
    author,
    {
      commandId: 'confirm',
      articleId,
      reportId: report.reportId,
      ledgerEpoch: report.ledgerEpoch,
      expectedReportGeneration: view.expectedReportGeneration,
      reviewBindingHash: view.reviewBindingHash,
    },
    'confirmed',
  );
  await app.submitEvidence(author, {
    commandId: 'evidence',
    correlationId: 'setup',
    articleId,
    expectedGeneration: current.generation,
    evidence,
    receipt: report.receipt,
  });
  await app.submitForReview(author, {
    commandId: 'review',
    correlationId: 'setup',
    articleId,
    expectedGeneration: (await app.getDraft(author, { articleId })).generation,
  });
  const review = await app.getReview(author, { articleId });
  await app.publishArticle(author, {
    commandId: 'publish',
    correlationId: 'setup',
    articleId,
    expectedGeneration: review.generation,
    review: review.review,
  });
  let indexed = await app.repairArticleIndex(author, {
    articleId,
    maxBatches: 1,
  });
  for (let attempt = 0; attempt < 7 && indexed.status === 'pending'; attempt++)
    indexed = await app.repairArticleIndex(author, {
      articleId,
      maxBatches: 1,
    });
  expect(indexed.status).toBe('ready');

  function cookie(key: string) {
    const sessionId = sessionIds.get(key);
    if (sessionId === undefined) throw new Error('Missing real session.');
    return SESSION_COOKIE + '=' + sessionId;
  }
  function request(operation: Operation, principal = readerId) {
    return new Request(IDENTITY_ISSUER + '/api/knowledge/portal', {
      method: 'POST',
      headers: {
        Cookie: cookie(principal),
        Origin: IDENTITY_ISSUER,
        'Sec-Fetch-Site': 'same-origin',
        'X-Pegma-CSRF': 'c'.repeat(43),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        operation,
        input:
          operation === 'getPublishedArticle'
            ? { articleId }
            : operation === 'listPortalCollections'
              ? {}
              : {
                  collectionId,
                  query: 'export',
                  applicability: current.revision.applicability,
                },
      }),
    });
  }
  function block() {
    let entered = () => {};
    let release = () => {};
    const ready = new Promise<void>((resolve) => (entered = resolve));
    const resume = new Promise<void>((resolve) => (release = resolve));
    afterRead = async () => {
      entered();
      await resume;
    };
    return {
      release,
      async waitFor(pending: Promise<unknown>) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            ready,
            pending.then(() => {
              throw new Error('Portal returned before its real KB barrier.');
            }),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error('Portal did not reach its KB barrier.')),
                3_000,
              );
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      },
    };
  }
  async function revokeReader() {
    const assignment = await roleStore.getRoleAssignment('reader-knowledge');
    if (assignment === null) throw new Error('Missing actual Knowledge role.');
    const result = await roleStore.revokeRoleAssignmentWithAudit({
      assignmentId: assignment.assignment.id,
      expectedConcurrencyToken: assignment.concurrencyToken,
      revokedBy: { kind: 'principal', principalId: authorId },
      revokedAtEpochMs: Date.parse(clock.now()),
      reason: 'Synthetic audience revocation.',
      auditEventId: 'revoke-reader',
    });
    expect(result.status).toBe('revoked');
  }
  return {
    runtime,
    request,
    cookie,
    block,
    revokeReader,
    grant,
    reads: () => reads,
  };
}

async function expectPrivateResult(
  response: Response | null,
  operation: Operation,
) {
  expect(response?.status).toBe(200);
  const value: unknown = await response?.json();
  const encoded = JSON.stringify(value);
  expect(encoded).toContain(
    operation === 'listPortalCollections' ? privateLabel : privateTitle,
  );
  expect(encoded).not.toContain('Private test report.');
  expect(encoded).not.toContain('Private test details.');
}

async function controlledPortalBody(base: Request) {
  const encoded = new TextEncoder().encode(await base.text());
  let source: ReadableStreamDefaultController<Uint8Array> | undefined;
  let entered = () => {};
  let resume = () => {};
  const reading = new Promise<void>((resolve) => (entered = resolve));
  const released = new Promise<void>((resolve) => (resume = resolve));
  let closed = false;
  let sent = 0;
  const cancel = vi.fn(() => {
    closed = true;
  });
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        source = controller;
      },
      pull() {
        entered();
        return released;
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  const options: RequestInit & { duplex: 'half' } = {
    method: 'POST',
    headers: base.headers,
    body: stream,
    duplex: 'half',
  };
  return {
    request: new Request(base.url, options),
    reading,
    cancel,
    trickle() {
      if (closed || source === undefined)
        throw new Error('The actual portal body is no longer open.');
      const end = Math.min(encoded.length, sent + 8);
      source.enqueue(encoded.slice(sent, end));
      sent = end;
    },
    complete() {
      if (!closed && source !== undefined) {
        source.enqueue(encoded.slice(sent));
        sent = encoded.length;
        source.close();
        closed = true;
      }
      resume();
    },
  };
}

describe.each(operations)(
  'authenticated portal %s body deadline',
  (operation) => {
    it.each(['stalled', 'trickled'] as const)(
      'rejects a %s body at the total deadline before reading private KB facts',
      async (kind) => {
        const f = await fixture();
        const body = await controlledPortalBody(f.request(operation));
        const initialReads = f.reads();
        vi.useFakeTimers({
          toFake: ['setTimeout', 'clearTimeout', 'performance'],
        });
        let settled = false;
        const pending = f.runtime.handle(body.request).finally(() => {
          settled = true;
        });
        try {
          await body.reading;
          expect(f.reads()).toBe(initialReads);
          await vi.advanceTimersByTimeAsync(9_000);
          if (kind === 'trickled') body.trickle();
          await vi.advanceTimersByTimeAsync(999);
          expect(settled).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
          // Fail promptly on the old path; finally releases its real body so a
          // ROOT RED run observes the defect without leaving a parked request.
          expect(settled).toBe(true);
          const result = await pending;
          expect(result?.status).toBe(408);
          expect(await result?.json()).toEqual({ error: 'request_timeout' });
          expect(f.reads()).toBe(initialReads);
          expect(body.cancel).toHaveBeenCalledTimes(1);
          expect(body.request.body?.locked).toBe(false);
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          body.complete();
          try {
            await pending;
          } finally {
            vi.useRealTimers();
          }
        }
      },
    );

    it('returns the actual restricted publication when the body completes before expiry', async () => {
      const f = await fixture();
      const body = await controlledPortalBody(f.request(operation));
      const initialReads = f.reads();
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'performance'],
      });
      let settled = false;
      const pending = f.runtime.handle(body.request).finally(() => {
        settled = true;
      });
      try {
        await body.reading;
        await vi.advanceTimersByTimeAsync(9_999);
        expect(settled).toBe(false);
        expect(f.reads()).toBe(initialReads);
        body.complete();
        await expectPrivateResult(await pending, operation);
        expect(f.reads()).toBeGreaterThan(initialReads);
        expect(body.cancel).not.toHaveBeenCalled();
        expect(body.request.body?.locked).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        body.complete();
        try {
          await pending;
        } finally {
          vi.useRealTimers();
        }
      }
    });
  },
);

describe('current permission-scoped portal authority after real KB reads', () => {
  it.each(operations)(
    'keeps same-session authorized %s available',
    async (operation) => {
      const f = await fixture();
      await expectPrivateResult(
        await f.runtime.handle(f.request(operation)),
        operation,
      );
      const customer = await f.runtime.handle(f.request(operation, customerId));
      const encoded = JSON.stringify(await customer?.json());
      expect(encoded).not.toContain(privateLabel);
      expect(encoded).not.toContain(privateTitle);
      expect(encoded).not.toContain(privateText);
    },
  );

  it.each(operations)(
    'withholds %s after its real audience role is revoked',
    async (operation) => {
      const f = await fixture();
      await expectPrivateResult(
        await f.runtime.handle(f.request(operation)),
        operation,
      );
      const blocked = f.block();
      const pending = f.runtime.handle(f.request(operation));
      try {
        await blocked.waitFor(pending);
        await f.revokeReader();
      } finally {
        blocked.release();
      }
      const response = await pending;
      expect(response?.status).toBe(403);
      expect(await response?.json()).toEqual({ error: 'forbidden' });
    },
  );

  it.each(operations)(
    'allows added grants without changing %s authority',
    async (operation) => {
      const f = await fixture();
      const blocked = f.block();
      const pending = f.runtime.handle(f.request(operation));
      try {
        await blocked.waitFor(pending);
        await f.grant('reader-support', readerId, SUPPORT_ROLE);
      } finally {
        blocked.release();
      }
      await expectPrivateResult(await pending, operation);
    },
  );

  for (const replacement of [otherId, 'reader-second-session']) {
    it.each(operations)(
      `withholds %s after a valid ${replacement} session replaces the caller`,
      async (operation) => {
        const f = await fixture();
        const request = f.request(operation);
        const blocked = f.block();
        const pending = f.runtime.handle(request);
        try {
          await blocked.waitFor(pending);
          request.headers.set('Cookie', f.cookie(replacement));
        } finally {
          blocked.release();
        }
        const response = await pending;
        expect(response?.status).toBe(403);
        expect(await response?.json()).toEqual({
          error: 'browser_credential_changed',
        });
      },
    );
  }
});
