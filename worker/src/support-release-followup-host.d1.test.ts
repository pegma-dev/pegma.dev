/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import {
  createExecutionContext,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { createCloudflareD1Store } from '@pegma/storage-cloudflare-d1';
import { supportRecords } from '@pegma/support-desk-application';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createWorker } from './index';
import { SUPPORT_ENGINEERING_QUEUE } from './support-engineering-queue';
import { PAID_START } from './support-paid-bootstrap-fixtures';
import {
  followupProviderResponse,
  supportFollowupPaidFixture,
} from './support-release-followup-paid-fixtures';
import { createSupportFollowupHostFixture } from './support-release-followup-host-fixtures';
import { createSupportAssistantStageDatabase } from './support-assistant-stage-budget';
import {
  engineeringHttpObject,
  engineeringHttpResult,
} from './support-engineering-http-fixtures';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

beforeAll(async () => {
  await createCloudflareD1Store({ database: env.IDENTITY_DB })
    .collection(supportRecords)
    .get({ partition: 'followup-schema', id: 'probe' });
});
beforeEach(async () => {
  await env.IDENTITY_DB.prepare('DELETE FROM RECORDS').run();
  await env.IDENTITY_DB.prepare('DELETE FROM PEGMA_STORAGE_D1_TX_GUARD').run();
});
async function fixture() {
  const f = await createSupportFollowupHostFixture(
    createCloudflareD1Store({
      database: env.IDENTITY_DB,
      createSchemaIfMissing: false,
      readBatchSize: 512,
    }),
  );
  const work = await f.prepared();
  const report = await f.report();
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
  const configuration = JSON.stringify({
    version: 1,
    revision: 'fictional-followup-source-v1',
    namespace: 'fictional-followup',
    intakeEnabled: true,
    product: {
      productId: f.product.productId,
      version: f.product.productVersion,
      buildId: f.product.buildId,
    },
    collectionIds: [f.collectionId],
    testEvidence: { retentionMilliseconds: 300000 },
  });
  async function invoke(
    operation: string,
    request: Request,
    sourceConfiguration: string | null = configuration,
  ) {
    const meter = createSupportAssistantStageDatabase(env.IDENTITY_DB);
    const worker = createWorker();
    const environment = {
      ...env,
      IDENTITY_DB: meter.database,
      IDENTITY_EMAIL_CODE_SECRET_BASE64: btoa('e'.repeat(32)),
      PEGMA_KNOWLEDGE_ENABLED: 'true',
      PEGMA_SUPPORT_LEARNING_INTAKE_ENABLED: 'true',
      PEGMA_SUPPORT_RELEASE_FOLLOWUP_ENABLED: 'true',
      PEGMA_SUPPORT_RELEASE_FOLLOWUP_PROCESSING_ENABLED: 'false',
      GITHUB_ALLOWED_REPOSITORY_IDS: f.f.identity.association.repositoryId,
      SUPPORT_LEARNING_SOURCE_CONFIGURATION_JSON:
        sourceConfiguration ?? undefined,
    } as const;
    const context = createExecutionContext();
    try {
      const response = await worker.fetch(
        request,
        environment as unknown as Parameters<typeof worker.fetch>[1],
        context,
      );
      await response.clone().arrayBuffer();
      const budget = meter.snapshot();
      console.info(
        'support-followup-host-d1',
        JSON.stringify({ operation, status: response.status, budget }),
      );
      expect(
        budget.physicalQueries,
        JSON.stringify({ operation, budget }),
      ).toBeLessThanOrEqual(50);
      expect(budget.maximumParameters).toBeLessThanOrEqual(100);
      expect(budget.blockedQueries).toBe(0);
      expect(budget.blockedParameters).toBe(0);
      return response;
    } finally {
      await waitOnExecutionContext(context);
    }
  }
  return { ...f, work, report, packet, invoke };
}
describe('default SD05 Source and real paired report entrypoints on Native D1', () => {
  it('prepares a purpose-bound retest, records it and recovers exact ACKs after optional configuration removal', async () => {
    const f = await fixture();
    const pending = await f.invoke(
      'default.retest.intent',
      f.request('retest-receipt', f.packet),
    );
    expect(pending.status).toBe(202);
    const intent = engineeringHttpResult(await engineeringHttpObject(pending));
    expect(intent).toMatchObject({
      pending: 'report',
      commandId: f.packet.commandId,
      workId: f.work.workId,
    });
    expect(intent).not.toHaveProperty('receipt');
    const response = await f.invoke(
      'default.retest.prepare',
      f.request('retest-receipt', f.packet),
    );
    expect(response.status).toBe(200);
    const ack = engineeringHttpResult(await engineeringHttpObject(response));
    const replay = await f.invoke(
      'default.retest.prepare.exact',
      f.request('retest-receipt', f.packet),
      null,
    );
    expect(replay.status).toBe(200);
    expect(engineeringHttpResult(await engineeringHttpObject(replay))).toEqual(
      ack,
    );
    const packet = {
      commandId: crypto.randomUUID(),
      workId: f.work.workId,
      retestRequestId: f.packet.retestRequestId,
      receiptReference: ack.receipt,
    };
    const submitted = await f.invoke(
      'default.retest.submit',
      f.request('retest', packet),
    );
    expect(submitted.status).toBe(200);
    expect(
      engineeringHttpResult(await engineeringHttpObject(submitted)),
    ).toMatchObject({ result: 'passed' });
    const recovered = await f.invoke(
      'default.retest.submit.exact',
      f.request('retest', packet),
      null,
    );
    expect(recovered.status).toBe(200);
  });
});

describe('default SD05 shared adapters on Native D1', () => {
  it('keeps every real queued generation/checking stage within the invocation budget', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(PAID_START));
    const f = await createSupportFollowupHostFixture(
      createCloudflareD1Store({
        database: env.IDENTITY_DB,
        createSchemaIfMissing: false,
        readBatchSize: 512,
      }),
    );
    const paid = await supportFollowupPaidFixture();
    const mapped = await f.source.mappings!.verify(
      f.context,
      f.f.identity.ticketId,
      f.mappingPacket,
    );
    const observed = await f.runtime.observe(f.context, {
      ...f.f.identity,
      commandId: crypto.randomUUID(),
      inputReference: mapped.inputReference,
    });
    if (!observed.workId) throw new Error('Actual follow-up work required');
    const key = { ticketId: f.f.identity.ticketId, workId: observed.workId };
    const calls: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const wire = JSON.parse(String(init.body));
        const input = JSON.parse(wire.messages[1].content);
        calls.push(input);
        return followupProviderResponse(
          input.kind
            ? {
                privacy: 'passed',
                factual: 'passed',
                applicability: 'passed',
                security: 'clear',
                duplication: 'passed',
                publicReproduction: 'not_applicable',
                findings: [],
              }
            : {
                customerDraft: {
                  body: 'The deployed fix is ready for a retry.',
                },
                kbProposal: null,
                retestRequests: [
                  {
                    steps: ['Export the fictional workspace.'],
                    expectedBehavior: 'The export contains its rows.',
                  },
                ],
              },
        );
      }),
    );
    const source = {
      ...paid.source,
      collectionIds: [f.collectionId],
      product: {
        productId: f.product.productId,
        version: f.product.productVersion,
        buildId: f.product.buildId,
      },
    };
    let prepared = false;
    for (let tick = 0; tick < 16; tick++) {
      const meter = createSupportAssistantStageDatabase(env.IDENTITY_DB);
      const worker = createWorker();
      const environment = {
        ...env,
        ...paid.env,
        IDENTITY_DB: meter.database,
        IDENTITY_EMAIL_CODE_SECRET_BASE64: btoa('e'.repeat(32)),
        PEGMA_KNOWLEDGE_ENABLED: 'true',
        PEGMA_SUPPORT_ASSISTANT_ENABLED: 'false',
        PEGMA_SUPPORT_ENGINEERING_PROCESSING_ENABLED: 'false',
        SUPPORT_LEARNING_SOURCE_CONFIGURATION_JSON: JSON.stringify(source),
        GITHUB_ALLOWED_REPOSITORY_IDS: f.f.identity.association.repositoryId,
      } as unknown as Parameters<typeof worker.fetch>[1];
      const context = createExecutionContext();
      try {
        await worker.queue(
          {
            queue: SUPPORT_ENGINEERING_QUEUE,
            messages: [
              {
                id: 'native-followup-' + tick,
                body: { version: 1, kind: 'support-release-followup-wake' },
                timestamp: new Date(PAID_START),
                attempts: 1,
                ack() {},
                retry() {},
              },
            ],
            ackAll() {},
            retryAll() {},
          } as unknown as MessageBatch,
          environment,
          context,
        );
        const budget = meter.snapshot();
        const work = await f.host.application.readEngineeringFollowupWork(
          f.staff,
          key,
        );
        console.info(
          'support-followup-host-d1',
          JSON.stringify({
            operation: 'default.queue.' + tick,
            status: work.status,
            heldReason: work.heldReason,
            calls: calls.length,
            budget,
          }),
        );
        expect(budget.physicalQueries).toBeLessThanOrEqual(50);
        expect(budget.maximumParameters).toBeLessThanOrEqual(100);
        expect(budget.blockedQueries).toBe(0);
        expect(budget.blockedParameters).toBe(0);
        if (work.status === 'bundle_prepared') {
          prepared = true;
          break;
        }
      } finally {
        await waitOnExecutionContext(context);
      }
    }
    expect(prepared).toBe(true);
    expect(calls).toHaveLength(2);
  });
});
