import { afterEach, describe, expect, it, vi } from 'vitest';
import * as d1 from '@pegma/storage-cloudflare-d1';
import { createWorker } from './index';
import { createSupportFollowupHostFixture } from './support-release-followup-host-fixtures';
import {
  engineeringHttpObject,
  engineeringHttpResult,
} from './support-engineering-http-fixtures';
import { supportFollowupMappings } from './support-release-followup-mapping';
import {
  componentReleaseCollection,
  componentReleaseKey,
} from './component-release';
import {
  supportFollowupReleaseObservations,
  supportFollowupReleaseObservationKey,
} from './support-release-followup-releases';

// Select Memory in place of the platform adapter. All host/Identity/RoleStore,
// Sessions, Support/KB application methods, policies, limits and writes are real.
vi.mock('@pegma/storage-cloudflare-d1', async (original) => ({
  ...(await original<typeof import('@pegma/storage-cloudflare-d1')>()),
  createCloudflareD1Store: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());
type Worker = ReturnType<typeof createWorker>;
type Environment = Parameters<Worker['fetch']>[1];
async function fixture(
  options: { readonly numericRepositories?: boolean } = {},
) {
  const f = await createSupportFollowupHostFixture(undefined, options);
  vi.mocked(d1.createCloudflareD1Store).mockReturnValue(f.store);
  const environment = {
    IDENTITY_DB: {},
    IDENTITY_EMAIL_CODE_SECRET_BASE64: btoa('e'.repeat(32)),
    IDENTITY_EMAIL_FROM: 'Pegma <fictional@example.test>',
    IDENTITY_EMAIL_ENABLED: 'false',
    PEGMA_KNOWLEDGE_ENABLED: 'true',
    PEGMA_AGENT_CLIENTS_JSON: '[]',
    PEGMA_SUPPORT_ASSISTANT_ENABLED: 'false',
    PEGMA_SUPPORT_ENGINEERING_PROCESSING_ENABLED: 'false',
    PEGMA_SUPPORT_LEARNING_WORKER_ENABLED: 'false',
    PEGMA_SUPPORT_LEARNING_INTAKE_ENABLED: 'false',
    PEGMA_SUPPORT_RELEASE_FOLLOWUP_ENABLED: 'true',
    PEGMA_SUPPORT_RELEASE_FOLLOWUP_PROCESSING_ENABLED: 'false',
    GITHUB_ALLOWED_REPOSITORY_IDS: f.f.identity.association.repositoryId,
  } as unknown as Environment;
  const worker = createWorker();
  async function fetch(request: Request, selected: Worker = worker) {
    const pending: Promise<unknown>[] = [];
    const context = {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      passThroughOnException() {},
    } as unknown as ExecutionContext;
    const result = await selected.fetch(request, environment, context);
    await Promise.all(pending);
    return result;
  }
  return { ...f, environment, worker, fetch };
}
describe('normal default Worker release-followup Source composition', () => {
  it('records a real staff mapping and queues actual SDK work with every model and paid gate OFF', async () => {
    const f = await fixture();
    const choices = await f.fetch(f.request('mapping'));
    expect(choices.status).toBe(200);
    expect(
      engineeringHttpResult(await engineeringHttpObject(choices)),
    ).toMatchObject({
      choices: [
        {
          ...f.f.identity.association,
          product: { productId: f.product.productId },
        },
      ],
    });
    const mapped = await f.fetch(f.request('verify-mapping', f.mappingPacket));
    expect(mapped.status).toBe(200);
    const ack = engineeringHttpResult(await engineeringHttpObject(mapped));
    expect(Object.keys(ack).sort()).toEqual([
      'actorId',
      'commandId',
      'inputReference',
      'mappingGeneration',
      'ticketId',
    ]);
    const observed = await f.fetch(
      f.request('observe', {
        commandId: crypto.randomUUID(),
        ...f.f.identity.association,
        inputReference: ack.inputReference,
      }),
    );
    expect(observed.status).toBe(200);
    expect(
      engineeringHttpResult(await engineeringHttpObject(observed)),
    ).toMatchObject({ outcome: 'queued' });
    expect(f.f.state.modelCalls).toBe(0);
    const saved = await f.store
      .collection(supportFollowupMappings)
      .list(f.f.identity.ticketId);
    expect(saved).toHaveLength(3);
    const replay = await f.fetch(f.request('verify-mapping', f.mappingPacket));
    expect(replay.status).toBe(200);
    expect(engineeringHttpResult(await engineeringHttpObject(replay))).toEqual(
      ack,
    );
  });
  it('preserves explicit legacy selection presence and disabled default routes without Store initialization', async () => {
    const f = await fixture();
    vi.mocked(d1.createCloudflareD1Store).mockClear();
    expect(
      (
        await f.fetch(
          f.request('mapping'),
          createWorker({ releaseFollowup: undefined }),
        )
      ).status,
    ).toBe(404);
    expect(d1.createCloudflareD1Store).not.toHaveBeenCalled();
    Reflect.set(
      f.environment,
      'PEGMA_SUPPORT_RELEASE_FOLLOWUP_ENABLED',
      'false',
    );
    expect((await f.fetch(f.request('mapping'))).status).toBe(404);
    expect(d1.createCloudflareD1Store).not.toHaveBeenCalled();
  });
  it('requires current original staff, same-origin CSRF and exact accepted immutable coordinates', async () => {
    const f = await fixture();
    const noCsrf = f.request('verify-mapping', f.mappingPacket);
    noCsrf.headers.delete('X-Pegma-CSRF');
    expect((await f.fetch(noCsrf)).status).toBe(403);
    expect(
      (await f.fetch(f.request('verify-mapping', f.mappingPacket, 'knowledge')))
        .status,
    ).toBe(403);
    expect(
      (
        await f.fetch(
          f.request('verify-mapping', {
            ...f.mappingPacket,
            expectedPrincipalId: f.peer.principalId,
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await f.fetch(
          f.request('verify-mapping', {
            ...f.mappingPacket,
            issueId: 'unknown-issue',
          }),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await f.fetch(
          f.request('verify-mapping', {
            ...f.mappingPacket,
            publicFacts: [{ reference: 'test', text: 'x'.repeat(1001) }],
          }),
        )
      ).status,
    ).toBe(400);
    await f.f.f.revoke('staff', 'Support');
    expect((await f.fetch(f.request('mapping'))).status).toBe(403);
    expect(f.f.state.modelCalls).toBe(0);
  });
  it('uses the ordinary durable staff mutation limiter even for exact mapping receipt replay', async () => {
    const f = await fixture();
    let limited = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      const response = await f.fetch(
        f.request('verify-mapping', f.mappingPacket),
      );
      if (response.status === 429) {
        limited = true;
        break;
      }
      expect(response.status).toBe(200);
    }
    expect(limited).toBe(true);
    expect(
      await f.store
        .collection(supportFollowupMappings)
        .list(f.f.identity.ticketId),
    ).toHaveLength(3);
  });
  it('retains a body-free preparation intent and uses the same original packet for real paired KB qualification', async () => {
    const f = await fixture();
    const work = await f.prepared();
    const report = await f.report();
    Reflect.set(f.environment, 'PEGMA_SUPPORT_LEARNING_INTAKE_ENABLED', 'true');
    Reflect.set(
      f.environment,
      'SUPPORT_LEARNING_SOURCE_CONFIGURATION_JSON',
      JSON.stringify({
        version: 1,
        revision: 'fictional-retest-source',
        namespace: 'fictional-followup',
        intakeEnabled: true,
        product: {
          productId: f.product.productId,
          version: f.product.productVersion,
          buildId: f.product.buildId,
        },
        collectionIds: [f.collectionId],
        testEvidence: { retentionMilliseconds: 300000 },
      }),
    );
    const packet = {
      commandId: crypto.randomUUID(),
      expectedPrincipalId: f.staff.principalId,
      workId: work.workId,
      expectedWorkGeneration: work.workGeneration,
      expectedTicketRevision: work.acceptedTicketRevision,
      retestRequestId: work.preparedBundle!.bundle.retestRequests[0]!.requestId,
      report: {
        articleId: report.articleId,
        ledgerEpoch: report.ledgerEpoch,
        reportId: report.reportId,
        expectedReportGeneration: report.reportGeneration,
        reviewBindingHash: report.reviewBindingHash,
        receipt: report.receipt,
      },
    };
    const started = await f.fetch(f.request('retest-receipt', packet));
    expect(started.status).toBe(202);
    const intent = engineeringHttpResult(await engineeringHttpObject(started));
    expect(Object.keys(intent).sort()).toEqual([
      'actorId',
      'commandId',
      'pending',
      'retestRequestId',
      'ticketId',
      'workId',
    ]);
    expect(intent.pending).toBe('report');
    expect(intent).not.toHaveProperty('receipt');
    expect(
      (
        await f.fetch(
          f.request('retest-receipt', {
            ...packet,
            expectedWorkGeneration: packet.expectedWorkGeneration + 1,
          }),
        )
      ).status,
    ).toBe(409);
    const ready = await f.fetch(f.request('retest-receipt', packet));
    expect(ready.status).toBe(200);
    const ack = engineeringHttpResult(await engineeringHttpObject(ready));
    Reflect.set(
      f.environment,
      'SUPPORT_LEARNING_SOURCE_CONFIGURATION_JSON',
      undefined,
    );
    const replay = await f.fetch(f.request('retest-receipt', packet));
    expect(replay.status).toBe(200);
    expect(engineeringHttpResult(await engineeringHttpObject(replay))).toEqual(
      ack,
    );
  });
  it('ingests genuine signed release events but requires explicit deployment mapping and never revives an old mapping after republication', async () => {
    const f = await fixture({ numericRepositories: true });
    const secret = 'FICTIONAL_WEBHOOK_HMAC_FOR_LOCAL_TEST_ONLY';
    const repositoryId = f.f.identity.association.repositoryId;
    Reflect.set(f.environment, 'GITHUB_ORGANIZATION_ID', '309286193');
    Reflect.set(f.environment, 'GITHUB_WEBHOOK_SECRET', secret);
    await f.store
      .collection(componentReleaseCollection())
      .delete(componentReleaseKey(repositoryId));
    const publishedAt = f.f.clock.now();
    let delivery = 0;
    async function event(action: 'published' | 'unpublished') {
      const body = JSON.stringify({
        action,
        organization: { id: 309286193 },
        repository: {
          id: Number(repositoryId),
          name: 'webhooks',
          owner: { id: 309286193 },
        },
        release: {
          id: 9001,
          tag_name: 'v2.3.1',
          published_at: publishedAt,
          updated_at: new Date(
            Date.parse(publishedAt) + ++delivery,
          ).toISOString(),
          draft: false,
          prerelease: false,
        },
      });
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const signature = new Uint8Array(
        await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
      );
      return new Request('https://pegma.dev/api/webhooks/github/releases', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'release',
          'X-GitHub-Delivery': crypto.randomUUID(),
          'X-Hub-Signature-256':
            'sha256=' +
            [...signature]
              .map((value) => value.toString(16).padStart(2, '0'))
              .join(''),
        },
        body,
      });
    }
    expect((await f.fetch(await event('published'))).status).toBe(204);
    const journal = f.store.collection(supportFollowupReleaseObservations);
    expect(
      await journal.get(supportFollowupReleaseObservationKey(repositoryId)),
    ).toMatchObject({ epoch: 1, state: 'active' });
    const missing = await f.fetch(
      f.request('observe', {
        commandId: crypto.randomUUID(),
        ...f.f.identity.association,
        inputReference: 'release-tags-do-not-prove-deployment',
      }),
    );
    expect(missing.status).toBe(200);
    expect(
      engineeringHttpResult(await engineeringHttpObject(missing)),
    ).toMatchObject({ outcome: 'held' });
    const mapped = await f.fetch(f.request('verify-mapping', f.mappingPacket));
    expect(mapped.status).toBe(200);
    const ack = engineeringHttpResult(await engineeringHttpObject(mapped));
    const observe = async () =>
      f.fetch(
        f.request('observe', {
          commandId: crypto.randomUUID(),
          ...f.f.identity.association,
          inputReference: ack.inputReference,
        }),
      );
    expect(
      engineeringHttpResult(await engineeringHttpObject(await observe())),
    ).toMatchObject({ outcome: 'queued' });
    expect((await f.fetch(await event('unpublished'))).status).toBe(204);
    expect(
      await journal.get(supportFollowupReleaseObservationKey(repositoryId)),
    ).toMatchObject({ epoch: 2, state: 'withdrawn' });
    expect(
      engineeringHttpResult(await engineeringHttpObject(await observe())),
    ).toMatchObject({ outcome: 'held' });
    expect((await f.fetch(await event('published'))).status).toBe(204);
    expect(
      await journal.get(supportFollowupReleaseObservationKey(repositoryId)),
    ).toMatchObject({ epoch: 3, state: 'active' });
    expect(
      engineeringHttpResult(await engineeringHttpObject(await observe())),
    ).toMatchObject({ outcome: 'held' });
    expect(f.f.state.modelCalls).toBe(0);
  });
});
