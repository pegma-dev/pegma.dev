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

const readerAttribution = vi.hoisted(() => ({
  active: undefined as NativeAttribution | undefined,
}));
interface NativeAttribution {
  labels: { label: string; executedBefore?: number; stack?: string }[];
  executions: { method: string; statements: number; maximumParameters: number; stack?: string }[];
}
/** Forward genuine native statements unchanged. Capture method/count/stack only,
 * never SQL, bind values, keys, row values, request bodies or provider data. */
function attributedBacking(backing: D1Database, attribution: NativeAttribution): D1Database {
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const bindings = new WeakMap<D1PreparedStatement, number>();
  function executed(method: string, statements: number, maximumParameters: number) {
    if (attribution.executions.length < 50) attribution.executions.push({ method, statements, maximumParameters, stack: new Error('Actual native execution caller').stack });
  }
  function statement(original: D1PreparedStatement, parameters = 0): D1PreparedStatement {
    const proxy = new Proxy(original, { get(target, method, receiver) {
      if (method === 'bind') return (...values: unknown[]) => statement(target.bind(...values), values.length);
      const value = Reflect.get(target, method, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (['first', 'all', 'run', 'raw'].includes(String(method))) executed(String(method), 1, parameters);
        return Reflect.apply(value, target, args);
      };
    } });
    originals.set(proxy, original); bindings.set(proxy, parameters);
    return proxy;
  }
  return new Proxy(backing, { get(target, method, receiver) {
    if (method === 'prepare') return (query: string) => statement(target.prepare(query));
    if (method === 'batch') return (statements: D1PreparedStatement[]) => {
      executed('batch', statements.length, Math.max(0, ...statements.map((value) => bindings.get(value) ?? 0)));
      return target.batch(statements.map((value) => {
        const original = originals.get(value);
        if (!original) throw new Error('Expected actual attributed native statement');
        return original;
      }));
    };
    const value = Reflect.get(target, method, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}
vi.mock('./support-release-followup-retests', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./support-release-followup-retests')>();
  return { ...actual,
    createSupportFollowupRetests(options: Parameters<typeof actual.createSupportFollowupRetests>[0]) {
      const origin = new Error('Actual retest factory origin').stack;
      const read = options.readGovernance;
      return actual.createSupportFollowupRetests({ ...options,
        readGovernance(...args) {
          const active = readerAttribution.active;
          const label = (value: string, stack?: string) => {
            if (active && active.labels.length < 100) active.labels.push({ label: value, executedBefore: active.executions.length, ...(stack ? { stack } : {}) });
          };
          label('actual-reader-enter', origin);
          const pending = read(...args);
          // Observe the same promise without adding a data read/await wave.
          void pending.then((value) => {
            const capability = value?.confirmAuthority;
            label(typeof capability === 'function' ? 'actual-capability-present' : 'actual-capability-absent');
            if (!value || typeof capability !== 'function' || Object.isFrozen(value)) return;
            Reflect.set(value, 'confirmAuthority', (...current: Parameters<typeof capability>) => {
              label('actual-confirm-authority-invoked', new Error('Actual authority caller').stack);
              return capability(...current);
            });
          }, () => { label('actual-reader-rejected'); });
          return pending;
        },
      });
    },
  };
});

const nativeBudgets: {
  operation: string;
  status: number | string;
  budget: ReturnType<ReturnType<typeof createSupportAssistantStageDatabase>['snapshot']>;
  readerAttribution?: NativeAttribution;
}[] = [];

afterEach(({ task }) => {
  Object.assign(task.meta, { followupNativeBudgets: structuredClone(nativeBudgets) });
  vi.unstubAllGlobals();
  vi.useRealTimers();
  readerAttribution.active = undefined;
});

beforeAll(async () => {
  await createCloudflareD1Store({ database: env.IDENTITY_DB })
    .collection(supportRecords)
    .get({ partition: 'followup-schema', id: 'probe' });
});
beforeEach(async () => {
  nativeBudgets.length = 0;
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
    const attribution: NativeAttribution = { labels: [], executions: [] };
    readerAttribution.active = attribution;
    const meter = createSupportAssistantStageDatabase(attributedBacking(env.IDENTITY_DB, attribution));
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
    let drained = false;
    try {
      const response = await worker.fetch(
        request,
        environment as unknown as Parameters<typeof worker.fetch>[1],
        context,
      );
      await response.clone().arrayBuffer();
      await waitOnExecutionContext(context);
      drained = true;
      const budget = meter.snapshot();
      nativeBudgets.push({ operation, status: response.status, budget, readerAttribution: attribution });
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
      if (!drained) await waitOnExecutionContext(context);
      readerAttribution.active = undefined;
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
  it('prepares checked work through queued phases and sends only after a real report and explicit staff approval', async () => {
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
    const mapping = await invoke('verify-mapping', f.mappingPacket);
    expect(mapping.status).toBe(200);
    const mappingAck = engineeringHttpResult(
      await engineeringHttpObject(mapping),
    );
    const observed = await invoke('observe', {
      commandId: crypto.randomUUID(),
      ...f.f.identity.association,
      inputReference: mappingAck.inputReference,
    });
    expect(observed.status).toBe(200);
    const observedResult = engineeringHttpResult(
      await engineeringHttpObject(observed),
    );
    if (typeof observedResult.workId !== 'string')
      throw new Error('Actual follow-up work required');
    const key = {
      ticketId: f.f.identity.ticketId,
      workId: observedResult.workId,
    };
    expect(calls).toHaveLength(0);
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
      let drained = false;
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
        await waitOnExecutionContext(context);
        drained = true;
        const budget = meter.snapshot();
        const work = await f.host.application.readEngineeringFollowupWork(
          f.staff,
          key,
        );
        nativeBudgets.push({ operation: 'default.queue.' + tick, status: work.status, budget });
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
        if (!drained) await waitOnExecutionContext(context);
      }
    }
    expect(prepared).toBe(true);
    expect(calls).toHaveLength(2);

    async function invoke(
      operation: string,
      packet: unknown,
      paidConfiguration = true,
    ) {
      const attribution: NativeAttribution = { labels: [], executions: [] };
      readerAttribution.active = attribution;
      const meter = createSupportAssistantStageDatabase(attributedBacking(env.IDENTITY_DB, attribution));
      const worker = createWorker();
      const environment = {
        ...env,
        ...paid.env,
        IDENTITY_DB: meter.database,
        IDENTITY_EMAIL_CODE_SECRET_BASE64: btoa('e'.repeat(32)),
        PEGMA_KNOWLEDGE_ENABLED: 'true',
        PEGMA_SUPPORT_RELEASE_FOLLOWUP_PROCESSING_ENABLED: 'false',
        SUPPORT_LEARNING_SOURCE_CONFIGURATION_JSON: JSON.stringify(source),
        GITHUB_ALLOWED_REPOSITORY_IDS: f.f.identity.association.repositoryId,
      } as unknown as Parameters<typeof worker.fetch>[1];
      if (!paidConfiguration) {
        for (const name of [
          'SUPPORT_PAID_CONFIGURATION_JSON',
          'SUPPORT_ASSISTANT_OPENROUTER_API_KEY',
          'SUPPORT_INDEPENDENT_CHECK_RECEIPT_KEY_BASE64',
        ])
          Reflect.deleteProperty(environment, name);
      }
      const context = createExecutionContext();
      let drained = false;
      try {
        const response = await worker.fetch(
          f.request(operation, packet),
          environment,
          context,
        );
        await response.clone().arrayBuffer();
        await waitOnExecutionContext(context);
        drained = true;
        const budget = meter.snapshot();
        console.info(
          'support-followup-host-d1',
          JSON.stringify({
            operation: 'default.paid.' + operation,
            status: response.status,
            paidConfiguration,
            budget,
          }),
        );
        nativeBudgets.push({ operation: 'default.paid.' + operation, status: response.status, budget, readerAttribution: attribution });
        expect(budget.physicalQueries).toBeLessThanOrEqual(50);
        expect(budget.maximumParameters).toBeLessThanOrEqual(100);
        expect(budget.blockedQueries).toBe(0);
        expect(budget.blockedParameters).toBe(0);
        return response;
      } finally {
        if (!drained) await waitOnExecutionContext(context);
        readerAttribution.active = undefined;
      }
    }
    let work = await f.host.application.readEngineeringFollowupWork(
      f.staff,
      key,
    );
    expect(work.delivered).toBeUndefined();
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
    expect((await invoke('retest-receipt', packet)).status).toBe(202);
    const receipt = await invoke('retest-receipt', packet);
    expect(receipt.status).toBe(200);
    const ack = engineeringHttpResult(await engineeringHttpObject(receipt));
    expect(
      (
        await invoke('retest', {
          commandId: crypto.randomUUID(),
          workId: work.workId,
          retestRequestId: packet.retestRequestId,
          receiptReference: ack.receipt,
        })
      ).status,
    ).toBe(200);
    work = await f.host.application.readEngineeringFollowupWork(f.staff, key);
    const post = {
      commandId: crypto.randomUUID(),
      workId: work.workId,
      expectedWorkGeneration: work.workGeneration,
      expectedTicketRevision: work.acceptedTicketRevision,
      bundleHash: work.preparedBundle!.bundleHash,
      messageId: crypto.randomUUID(),
    };
    expect((await invoke('post', post)).status).toBe(200);
    expect((await invoke('post', post, false)).status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(
      (
        await f.host.application.readStaffTicket(f.staff, work.ticketId)
      ).messages.filter((message) => message.id === post.messageId),
    ).toHaveLength(1);
  });
});
