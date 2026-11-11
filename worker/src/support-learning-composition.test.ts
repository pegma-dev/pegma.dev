import { identityLinkKeyFromVerifiedIdentityClaims } from '@pegma/authorization-identity';
import { createRoleStore } from '@pegma/authorization-storage';
import { createMemoryStore } from '@pegma/storage-core';
import { supportRecords } from '@pegma/support-desk-application';
import { knowledgePermissions } from '@pegma/knowledge-base-contracts';
import { describe, expect, it } from 'vitest';
import { IDENTITY_ISSUER, SESSION_COOKIE } from './identity-api';
import { createIdentityRuntime } from './identity-runtime';
import { createKnowledgeRuntime } from './knowledge-runtime';
import { createKnowledgeRetrievalReady } from './knowledge-retrieval-ready';
import { createKnowledgeRetrievalMaintenance } from './knowledge-retrieval-maintenance';
import {
  APPLICATION_SCOPE,
  AUTHORIZATION_APPLICATION_ID,
  KNOWLEDGE_ROLE,
  SUPPORT_ROLE,
  customerAccessContext,
} from './support-access';
import {
  createSupportLearningFixture,
  learningCanary,
  learningTicketId,
} from './support-learning-fixtures';

/** All domain state is admitted through the existing public SDK fixture. */
async function fixture() {
  const store = createMemoryStore();
  const learning = await createSupportLearningFixture(store);
  // Use the host's actual customer audience before creating the learned draft.
  const preview = await learning.knowledge.previewCollectionPolicy(learning.actors.admin, {
    collectionId: 'learning-guides',
    uses: {
      portal: { enabled: true, audience: { kind: 'permission', permission: knowledgePermissions.articleRead } },
      bot: { enabled: false },
    },
  });
  await learning.knowledge.updateCollectionPolicy(learning.actors.admin, {
    ...learning.command('host-audience', preview.generation), collectionId: 'learning-guides', preview: preview.preview,
  });
  await learning.enrollAndVerify();
  const delivered = await learning.delivered();
  await learning.review(delivered.articleId);
  await learning.evidenceAndPublish(delivered.articleId);

  const logger = { log() {} };
  const identityRuntime = createIdentityRuntime({ store,
    emailCodeSecretBase64: btoa('c'.repeat(32)), emailFrom: 'Pegma <synthetic@pegma.dev>', emailEnabled: false,
  }, logger);
  const roleStore = createRoleStore(store, AUTHORIZATION_APPLICATION_ID);
  const cookies = new Map<string, string>();
  const principals = [learning.actors.staff.principalId, learning.actors.customer.principalId, 'synthetic-learning-unrelated'];
  for (const [index, principalId] of principals.entries()) {
    await identityRuntime.identity.provisionVerifiedUser({ principalId, email: `composition-${index}@example.test` });
    const sessionId = String(index + 1).repeat(43);
    await identityRuntime.sessions.create(sessionId, { principalId, data: JSON.stringify({ version: 1,
      csrfToken: 'c'.repeat(43), issuer: IDENTITY_ISSUER, subject: principalId }) });
    cookies.set(principalId, SESSION_COOKIE + '=' + sessionId);
  }
  for (const role of [SUPPORT_ROLE, KNOWLEDGE_ROLE]) {
    const granted = await roleStore.grantRoleAssignmentWithAudit({ assignment: {
      id: 'learning-composition-' + role, principalId: learning.actors.staff.principalId,
      role, scope: APPLICATION_SCOPE, grantedBy: { kind: 'system', systemId: 'synthetic-learning-composition' },
      grantedAtEpochMs: Date.parse(learning.clock.now()), status: 'active',
    }, auditEventId: 'learning-composition-grant-' + role });
    expect(granted.status).toBe('granted');
  }
  const options = { store, clock: learning.clock, logger, sessions: identityRuntime.sessions,
    identity: identityRuntime.identity, roleStore, identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
    agentAccess: null, isEnabled: () => true };
  const runtime = createKnowledgeRuntime({ ...options, privateSources: learning.sources });
  const absent = createKnowledgeRuntime(options);
  const projection = { store, clock: learning.clock, logger, isEnabled: () => true, privateSources: learning.sources };
  const ready = createKnowledgeRetrievalReady(projection);
  const physical = createKnowledgeRetrievalMaintenance(projection);
  const articleId = delivered.articleId;
  const input = { collectionId: 'learning-guides', query: 'workspace export', applicability: learning.product };
  const search = () => runtime.application.searchPublishedArticles(learning.actors.customer, input);
  async function request(operation: string, principalId = learning.actors.customer.principalId, staff = false) {
    const response = await runtime.handle(new Request(IDENTITY_ISSUER +
      (staff ? '/api/staff/knowledge/command' : '/api/knowledge/portal'), {
      method: 'POST', headers: { Cookie: cookies.get(principalId) ?? '', Origin: IDENTITY_ISSUER,
        'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', 'X-Pegma-CSRF': 'c'.repeat(43) },
      body: JSON.stringify({ operation, input: { articleId } }),
    }));
    if (response === null) throw new Error('Expected the real Knowledge HTTP route');
    return response;
  }
  return { learning, runtime, absent, ready, physical, articleId, search, request, principals };
}

type CompositionFixture = Awaited<ReturnType<typeof fixture>>;
type Worker = 'ready' | 'physical';

async function converge(f: CompositionFixture, worker: Worker, indexed: boolean) {
  if (worker === 'ready') await f.ready.enqueue(f.articleId);
  // Full physical cycles include immutable rows; one row/step is still used per call.
  for (let tick = 0; tick < 512; tick++) {
    if (worker === 'ready') await f.ready.runPage();
    else await f.physical.runPage();
    const status = await f.runtime.application.getArticleIndexStatus(f.learning.actors.admin, { articleId: f.articleId });
    if (status.status === 'ready' && status.indexed === indexed) return;
  }
  throw new Error(`The actual ${worker} worker did not converge to indexed=${indexed}`);
}

function expectPublic(value: unknown) {
  const encoded = JSON.stringify(value);
  for (const privateValue of [learningCanary, learningTicketId, 'pegma.support-desk',
    'SYNTHETIC_PRIVATE_VERIFICATION', 'synthetic-independent-learning-check']) {
    expect(encoded).not.toContain(privateValue);
  }
}

describe('support learning verifier host composition', () => {
  it('uses the actual request verifier and keeps private provenance unavailable to another actor', async () => {
    const f = await fixture();
    const input = { articleId: f.articleId };
    await expect(f.absent.application.getPublishedArticle(f.learning.actors.customer, input)).rejects.toThrow();
    const accepted = await f.request('getPublishedArticle');
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ articleId: f.articleId, title: 'Export your workspace' });
    const own = await f.request('getProvenance', f.learning.actors.staff.principalId, true);
    expect(own.status).toBe(200);
    const provenance: unknown = await own.json();
    expect(JSON.stringify(provenance)).toContain('pegma.support-desk');
    expect(JSON.stringify(provenance)).toContain(learningTicketId);
    for (const principalId of [f.learning.actors.customer.principalId, 'synthetic-learning-unrelated']) {
      const denied = await f.request('getProvenance', principalId, true);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: 'forbidden' });
      await expect(f.learning.application.readStaffTicket(
        customerAccessContext(principalId), learningTicketId,
      )).rejects.toThrow();
      const publicView = await f.request('getPublishedArticle', principalId);
      expect(publicView.status).toBe(200);
      expectPublic(await publicView.json());
    }
  });

  for (const worker of ['ready', 'physical'] as const) {
    for (const change of ['reopen', 'withdraw', 'missing-ticket'] as const) {
      it(`${worker} propagates current source eligibility through indexing and ${change}`, async () => {
        const f = await fixture();
        expect(await f.search()).toEqual({ outcome: 'no_result', articles: [] });
        await converge(f, worker, true);
        const visible = await f.search();
        expect(visible.outcome).toBe('results');
        expect(visible.articles.map((article) => article.articleId)).toEqual([f.articleId]);
        expectPublic(visible);
        expect((await f.request('getPublishedArticle')).status).toBe(200);

        if (change === 'reopen') {
          await f.learning.application.reopenTicket(f.learning.actors.staff, {
            ...f.learning.command('composition-reopen'), ticketId: learningTicketId,
          });
          expect((await f.learning.runtime.readSource(f.learning.actors.staff, learningTicketId)).state).toBe('held');
        } else if (change === 'withdraw') {
          const withdrawn = await f.learning.runtime.withdraw(f.learning.actors.staff, {
            ticketId: learningTicketId, clientCommandId: 'composition-withdraw', reason: 'privacy_withdrawal',
          });
          expect(withdrawn.state).toBe('withdrawn');
        } else {
          // Missing-source storage case: remove only the real SDK-created ticket.
          // This is not a claim that a host-wide data-erasure procedure ran.
          const records = f.learning.store.collection(supportRecords);
          const ticket = (await records.list(learningTicketId)).find((row) => row.kind === 'ticket');
          if (ticket === undefined) throw new Error('Actual source ticket absent before deletion');
          expect(await records.delete(supportRecords.key(ticket))).toBe(true);
          await expect(f.learning.runtime.readSource(f.learning.actors.staff, learningTicketId)).rejects.toThrow();
        }

        // A stale posting cannot override the current source even before repair.
        expect((await f.request('getPublishedArticle')).status).toBe(404);
        expect(await f.search()).toEqual({ outcome: 'no_result', articles: [] });
        await converge(f, worker, false);
        expect(await f.search()).toEqual({ outcome: 'no_result', articles: [] });
        const denied = await f.request('getProvenance', 'synthetic-learning-unrelated', true);
        expect(denied.status).toBe(403);
        expectPublic(await denied.json());
        expect(f.learning.state.modelCalls).toBe(1);
      });
    }
  }
});
