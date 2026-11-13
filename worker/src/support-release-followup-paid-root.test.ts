import { afterEach, describe, expect, it, vi } from 'vitest';
import * as d1 from '@pegma/storage-cloudflare-d1';
import { createWorker } from './index';
import { createSupportFollowupHostFixture } from './support-release-followup-host-fixtures';
import {
  supportFollowupPaidFixture,
  followupProviderResponse,
} from './support-release-followup-paid-fixtures';
import { PAID_START } from './support-paid-bootstrap-fixtures';
import {
  engineeringHttpObject,
  engineeringHttpResult,
} from './support-engineering-http-fixtures';
import { CLEANUP_CRON } from './maintenance-schedule';
import { SUPPORT_ENGINEERING_QUEUE } from './support-engineering-queue';
import * as driverModule from './support-release-followup-driver';
import * as productionModule from './support-release-followup-production';

vi.mock('@pegma/storage-cloudflare-d1', async (original) => ({
  ...(await original<typeof import('@pegma/storage-cloudflare-d1')>()),
  createCloudflareD1Store: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function fixture() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(PAID_START));
  const f = await createSupportFollowupHostFixture();
  const paid = await supportFollowupPaidFixture();
  const source = {
    ...paid.source,
    product: {
      productId: f.product.productId,
      version: f.product.productVersion,
      buildId: f.product.buildId,
    },
    collectionIds: [f.collectionId],
  };
  vi.mocked(d1.createCloudflareD1Store).mockReturnValue(f.store);
  const sends: unknown[] = [];
  const calls: Record<string, unknown>[] = [];
  const ticks: unknown[] = [];
  const bindingErrors: string[] = [];
  const actualDriver = driverModule.createSupportReleaseFollowupDriver;
  vi.spyOn(
    driverModule,
    'createSupportReleaseFollowupDriver',
  ).mockImplementation((options) => {
    const driver = actualDriver(options);
    return {
      async runTick(run) {
        const result = await driver.runTick(run);
        ticks.push(result);
        return result;
      },
    };
  });
  const actualBind = productionModule.bindSupportReleaseFollowupPaid;
  vi.spyOn(
    productionModule,
    'bindSupportReleaseFollowupPaid',
  ).mockImplementation((options) => {
    try {
      return actualBind(options);
    } catch (error) {
      bindingErrors.push(String(error));
      throw error;
    }
  });
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
                body: 'The deployed export fix is ready. Please retry your workspace export.',
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
  const environment = {
    ...paid.env,
    IDENTITY_DB: {},
    IDENTITY_EMAIL_CODE_SECRET_BASE64: btoa('e'.repeat(32)),
    IDENTITY_EMAIL_FROM: 'Pegma <fictional@example.test>',
    IDENTITY_EMAIL_ENABLED: 'false',
    PEGMA_AGENT_CLIENTS_JSON: '[]',
    PEGMA_SUPPORT_ASSISTANT_ENABLED: 'false',
    PEGMA_SUPPORT_ENGINEERING_PROCESSING_ENABLED: 'false',
    SUPPORT_LEARNING_SOURCE_CONFIGURATION_JSON: JSON.stringify(source),
    GITHUB_ALLOWED_REPOSITORY_IDS: f.f.identity.association.repositoryId,
    SUPPORT_ENGINEERING_JOBS: {
      async send(body: unknown) {
        sends.push(body);
      },
    },
  } as unknown as Parameters<ReturnType<typeof createWorker>['fetch']>[1];
  const worker = createWorker();
  const pending: Promise<unknown>[] = [];
  const context = {
    waitUntil: (value: Promise<unknown>) => pending.push(value),
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  const drain = async () => {
    await Promise.all(pending.splice(0));
  };
  async function fetch(operation: string, body?: unknown, query = '') {
    const response = await worker.fetch(
      f.request(operation, body, 'staff', query),
      environment,
      context,
    );
    await drain();
    return response;
  }
  async function wake(attempt = 1) {
    const message = {
      id: 'fictional-followup-wake',
      body: { version: 1, kind: 'support-release-followup-wake' },
      timestamp: new Date(PAID_START),
      attempts: attempt,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    await worker.queue(
      {
        queue: SUPPORT_ENGINEERING_QUEUE,
        messages: [message],
        ackAll: vi.fn(),
        retryAll: vi.fn(),
      } as unknown as MessageBatch,
      environment,
      context,
    );
    await drain();
    return message;
  }
  async function observe() {
    const mapped = await fetch('verify-mapping', f.mappingPacket);
    expect(mapped.status).toBe(200);
    const ack = engineeringHttpResult(await engineeringHttpObject(mapped));
    const observed = await fetch('observe', {
      commandId: crypto.randomUUID(),
      ...f.f.identity.association,
      inputReference: ack.inputReference,
    });
    expect(observed.status).toBe(200);
    const result = engineeringHttpResult(await engineeringHttpObject(observed));
    if (typeof result.workId !== 'string')
      throw new Error('Expected actual SDK follow-up work');
    return { ticketId: f.f.identity.ticketId, workId: result.workId };
  }
  return {
    ...f,
    paid,
    environment,
    worker,
    context,
    drain,
    sends,
    calls,
    ticks,
    bindingErrors,
    fetch,
    wake,
    observe,
  };
}
describe('actual default shared-adapter follow-up production routes and queue', () => {
  it('prepares a checked draft/retest through the registered timer/queue and sends only after explicit current staff approval', async () => {
    const f = await fixture();
    const key = await f.observe();
    await f.worker.scheduled(
      { cron: CLEANUP_CRON, scheduledTime: Date.now(), noRetry() {} },
      f.environment,
      f.context,
    );
    await f.drain();
    expect(f.sends).toContainEqual({
      version: 1,
      kind: 'support-release-followup-wake',
    });
    let prepared = false;
    for (let tick = 0; tick < 20; tick++) {
      await f.wake();
      const work = await f.host.application.readEngineeringFollowupWork(
        f.staff,
        key,
      );
      if (work.status === 'bundle_prepared') {
        prepared = true;
        break;
      }
    }
    const held = await f.host.application.readEngineeringFollowupWork(
      f.staff,
      key,
    );
    expect(
      prepared,
      JSON.stringify({
        status: held.status,
        reason: held.heldReason,
        calls: f.calls.length,
        ticks: f.ticks,
        bindingErrors: f.bindingErrors,
      }),
    ).toBe(true);
    expect(f.calls).toHaveLength(2);
    expect(
      f.calls.filter((call) => call.kind === 'release_followup'),
    ).toHaveLength(1);
    let work = await f.host.application.readEngineeringFollowupWork(
      f.staff,
      key,
    );
    expect(work.delivered).toBeUndefined();
    const report = await f.report();
    const packet = {
      commandId: crypto.randomUUID(),
      expectedPrincipalId: f.staff.principalId,
      workId: key.workId,
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
    expect((await f.fetch('retest-receipt', packet)).status).toBe(202);
    const receipt = await f.fetch('retest-receipt', packet);
    expect(receipt.status).toBe(200);
    const retestAck = engineeringHttpResult(
      await engineeringHttpObject(receipt),
    );
    const result = await f.fetch('retest', {
      commandId: crypto.randomUUID(),
      workId: key.workId,
      retestRequestId: packet.retestRequestId,
      receiptReference: retestAck.receipt,
    });
    expect(result.status).toBe(200);
    expect(
      engineeringHttpResult(await engineeringHttpObject(result)),
    ).toMatchObject({ result: 'passed' });
    work = await f.host.application.readEngineeringFollowupWork(f.staff, key);
    const post = {
      commandId: crypto.randomUUID(),
      workId: key.workId,
      expectedWorkGeneration: work.workGeneration,
      expectedTicketRevision: work.acceptedTicketRevision,
      bundleHash: work.preparedBundle!.bundleHash,
      messageId: crypto.randomUUID(),
    };
    Reflect.set(
      f.environment,
      'PEGMA_SUPPORT_RELEASE_FOLLOWUP_PROCESSING_ENABLED',
      'false',
    );
    const posted = await f.fetch('post', post);
    expect(posted.status).toBe(200);
    expect(f.calls).toHaveLength(2);
    Reflect.set(f.environment, 'SUPPORT_PAID_CONFIGURATION_JSON', undefined);
    expect((await f.fetch('post', post)).status).toBe(200);
    const ticket = await f.host.application.readStaffTicket(
      f.staff,
      key.ticketId,
    );
    expect(
      ticket.messages.filter((message) => message.id === post.messageId),
    ).toHaveLength(1);
  });
});
