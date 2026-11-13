import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { supportBrowser, disposeSupportBrowsers } from './test-support-browser';
const PG = true;
const context: any = { Date, setTimeout, clearTimeout, URLSearchParams };
runInNewContext(
  readFileSync(
    new URL('../public/staff-support-followup.js', import.meta.url),
    'utf8',
  ),
  context,
);
const { createPanel } = context.PegmaSupportFollowup;
// Real host controller, synthetic DOM/closed HTTP transport. Backend owners test SDK/KB proof acceptance.
class Doc {
  createElement(tag: string): Node {
    return new Node(tag, this);
  }
}
class Node extends EventTarget {
  children: Node[] = [];
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  value = '';
  checked = false;
  disabled = false;
  hidden = false;
  type = '';
  className = '';
  maxLength = 0;
  rows = 0;
  readOnly = false;
  private text = '';
  constructor(
    readonly tag: string,
    readonly ownerDocument: Doc,
  ) {
    super();
  }
  get textContent(): string {
    return this.text + this.children.map((n) => n.textContent).join('');
  }
  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }
  set innerHTML(_value: string) {
    throw new Error('Use literal text.');
  }
  append(...nodes: Node[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: Node[]) {
    this.text = '';
    this.children = nodes;
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
}
const all = (n: Node): Node[] => [n, ...n.children.flatMap(all)];
function barrier() {
  let release = () => {};
  const pending = new Promise<void>((done) => {
    release = done;
  });
  return { pending, release };
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  disposeSupportBrowsers();
});
function fixture() {
  const doc = new Doc();
  const root = doc.createElement('section');
  const state = {
    actor: 'Actor:A',
    revision: 10,
    ids: 0,
    enabled: true,
    losePreparation: false,
    loseResult: false,
    http: 200,
    resultHTTP: 200,
    pendingCount: 0,
    malformed: false,
    afterPreparation: undefined as (() => void) | undefined,
    reportGate: undefined as ReturnType<typeof barrier> | undefined,
    prepGate: undefined as ReturnType<typeof barrier> | undefined,
  };
  const work = {
    ticketId: 'Ticket:A',
    workId: 'Work:A',
    workGeneration: 7,
    status: 'delivered',
    stage: 'delivered',
    acceptedTicketRevision: 9,
    handoff: {
      kbProposal: null,
      retestRequests: [
        {
          requestId: 'Retest:ExactCase',
          steps: ['Run the exact export regression'],
          expectedBehavior: 'The deployed fix exports every row.',
          productBinding: 'Product:ExactBinding',
          validationRequirementIds: ['export-regression'],
        },
      ],
    },
    delivered: {
      messageId: 'Message:A',
      ticketRevision: 10,
      postedAt: '2026-11-12T10:00:00.000Z',
    },
    retestResults: [] as any[],
  };
  const report = {
    articleId: 'Article:A',
    ledgerEpoch: 2,
    reportId: 'Report:A',
    reportGeneration: 3,
    expectedReportGeneration: 3,
    reviewBindingHash: 'a'.repeat(64),
    receipt: 'PRIVATE_KB_RECEIPT',
    status: 'confirmed',
    confirmation: { attesterId: 'Staff:Actual' },
    evidence: {
      result: 'passed',
      executionId: 'PRIVATE_EXECUTION',
      runnerId: 'PRIVATE_RUNNER',
    },
    report: {
      summary: '<literal> Exact regression run',
      details: 'The reported behavior is documented here.',
    },
    sourceMetadata: { private: 'PRIVATE_SOURCE_METADATA' },
  };
  const calls: { path: string; bytes?: string; status?: number }[] = [];
  const resultPackets: any[] = [];
  const session = async () =>
    state.enabled
      ? PG
        ? { subject: state.actor, csrfToken: 'csrf' }
        : { accountId: state.actor }
      : null;
  const wrap = (result: any) =>
    PG ? { result, csrfToken: 'csrf' } : { result };
  const request = vi.fn(async (path: string, init: any = {}) => {
    const bytes =
      init.body === undefined
        ? undefined
        : typeof init.body === 'string'
          ? init.body
          : JSON.stringify(init.body);
    calls.push({ path, bytes });
    if (path.includes('/work?')) return wrap(work);
    if (path === '/api/staff/knowledge/command') {
      expect(JSON.parse(bytes!)).toEqual({
        operation: 'reportRead',
        input: { articleId: 'Article:A', ledgerEpoch: 2, reportId: 'Report:A' },
      });
      await state.reportGate?.pending;
      return report;
    }
    if (path.endsWith('/retest')) {
      const packet = JSON.parse(bytes!);
      resultPackets.push(packet);
      if (state.resultHTTP !== 200)
        throw Object.assign(new Error('request_failed'), {
          status: state.resultHTTP,
        });
      if (state.loseResult) {
        state.loseResult = false;
        throw new Error('lost_result_ack');
      }
      work.retestResults = [
        {
          requestId: packet.retestRequestId,
          result: report.evidence.result,
          verifiedAt: '2026-11-12T10:05:00.000Z',
        },
      ];
      return {
        ...wrap({
          ticketId: 'Ticket:A',
          workId: 'Work:A',
          outcome: 'recorded',
          result: report.evidence.result,
        }),
        commandId: packet.commandId,
        operation: 'retest',
      };
    }
    throw new Error('Unexpected retest UI request ' + path);
  });
  const requestWithStatus = vi.fn(async (path: string, init: any) => {
    const bytes =
      typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
    const packet = JSON.parse(bytes);
    expect(path).toBe(
      '/api/support/admin/tickets/Ticket%3AA/follow-up/retest-receipt',
    );
    let status = state.pendingCount > 0 ? 202 : state.http;
    if (state.pendingCount > 0) --state.pendingCount;
    calls.push({ path, bytes, status });
    await state.prepGate?.pending;
    if (state.losePreparation) {
      state.losePreparation = false;
      throw new Error('lost_preparation_ack');
    }
    if (status !== 200 && status !== 202)
      throw Object.assign(new Error('request_failed'), { status });
    const result = {
      actorId: 'Actor:A',
      ticketId: 'Ticket:A',
      commandId: packet.commandId,
      workId: packet.workId,
      retestRequestId: packet.retestRequestId,
      ...(status === 202
        ? { pending: 'report' }
        : {
            receipt: 'PRIVATE_RETEST_RECEIPT',
            validUntil: '2026-11-13T10:00:00.000Z',
          }),
    };
    if (state.malformed) Object.assign(result, { unexpected: true });
    state.afterPreparation?.();
    return { status, body: wrap(result) };
  });
  const settled = vi.fn();
  const accessLost = vi.fn();
  const panel = createPanel({
    root,
    request,
    requestWithStatus,
    readSession: session,
    readCurrentTicket: async () => ({
      ticket: { id: 'Ticket:A', revision: state.revision },
      ...(PG ? { csrfToken: 'csrf' } : {}),
    }),
    commandId: () =>
      '15df8c75-33ac-4e45-a144-' + String(++state.ids).padStart(12, '0'),
    onSettled: settled,
    onAccessLost: accessLost,
  });
  cleanups.push(() => panel.suspend());
  const field = (key: string) =>
    all(root).find((n) => n.dataset.followupField === key)!;
  const open = (ticketId = 'Ticket:A') =>
    panel.showTicket({
      ticketId,
      ...(PG ? { actorSubject: state.actor } : { accountId: state.actor }),
    });
  async function load() {
    open();
    field('workId').value = 'Work:A';
    await panel.perform('work');
    field('retestRequestId').value = 'Retest:ExactCase';
    field('retestRequestId').dispatchEvent(new Event('change'));
    field('articleId').value = 'Article:A';
    field('ledgerEpoch').value = '2';
    field('reportId').value = 'Report:A';
    await panel.perform('report-read');
  }
  const prepare = () => panel.perform('retest-receipt');
  const prepCalls = () =>
    calls.filter((c) => c.path.endsWith('/retest-receipt'));
  return {
    panel,
    root,
    field,
    state,
    work,
    report,
    calls,
    resultPackets,
    requestWithStatus,
    open,
    load,
    prepare,
    prepCalls,
    settled,
    accessLost,
  };
}
function channels(root: Node) {
  return all(root)
    .flatMap((n) => [n.textContent, n.value, ...n.attributes.values()])
    .join('\n');
}
describe('current confirmed-report retest association and exact recovery', () => {
  it('explicitly discards an associated but unsent result without submitting any result', async () => {
    const f = fixture();
    await f.load();
    await f.prepare();
    expect(f.panel.hasPending()).toBe(true);
    await f.panel.perform('discard');
    expect(f.panel.hasPending()).toBe(false);
    expect(f.resultPackets).toEqual([]);
    expect(f.work.retestResults).toEqual([]);
    expect(f.settled).not.toHaveBeenCalled();
    await f.load();
    await f.prepare();
    expect(f.prepCalls()).toHaveLength(2);
    expect(JSON.parse(f.prepCalls()[0]!.bytes!).commandId).not.toBe(
      JSON.parse(f.prepCalls()[1]!.bytes!).commandId,
    );
  });
  it('recovers locally from an expired result receipt’s first closed conflict and prepares a fresh result', async () => {
    const f = fixture();
    await f.load();
    await f.prepare();
    f.state.resultHTTP = 409;
    await f.panel.perform('retest-result');
    expect(f.work.retestResults).toEqual([]);
    expect(f.panel.hasPending()).toBe(true);
    await f.panel.perform('discard');
    expect(f.panel.hasPending()).toBe(false);
    f.state.resultHTTP = 200;
    await f.load();
    await f.prepare();
    await f.panel.perform('retest-result');
    expect(f.work.retestResults).toHaveLength(1);
    expect(f.resultPackets).toHaveLength(2);
    expect(f.resultPackets[1].commandId).not.toBe(f.resultPackets[0].commandId);
    expect(f.settled).toHaveBeenCalledTimes(1);
  });
  it('preserves an uncertain result despite a later expired-receipt conflict and explicit discard action', async () => {
    const f = fixture();
    await f.load();
    await f.prepare();
    f.state.loseResult = true;
    await f.panel.perform('retest-result');
    f.state.resultHTTP = 409;
    await f.panel.perform('exact-retry');
    await f.panel.perform('discard');
    expect(f.panel.hasPending()).toBe(true);
    expect(f.resultPackets[1]).toEqual(f.resultPackets[0]);
    expect(f.prepCalls()).toHaveLength(1);
    expect(f.settled).not.toHaveBeenCalled();
  });
  it('uses delivered handoff choices, fresh ticket revision and the exact current staff-read report tuple', async () => {
    const f = fixture();
    await f.load();
    expect(f.root.textContent).toContain('Retest:ExactCase');
    expect(f.root.textContent).toContain('<literal>');
    for (const hidden of [
      'PRIVATE_KB_RECEIPT',
      'PRIVATE_EXECUTION',
      'PRIVATE_RUNNER',
      'PRIVATE_SOURCE_METADATA',
      'a'.repeat(64),
    ])
      expect(channels(f.root)).not.toContain(hidden);
    await f.prepare();
    expect(f.prepCalls()).toHaveLength(1);
    expect(f.resultPackets).toEqual([]);
    const packet = JSON.parse(f.prepCalls()[0]!.bytes!);
    expect(Object.keys(packet).sort()).toEqual(
      [
        'commandId',
        'expectedPrincipalId',
        'workId',
        'expectedWorkGeneration',
        'expectedTicketRevision',
        'retestRequestId',
        'report',
      ].sort(),
    );
    expect(packet).toMatchObject({
      expectedPrincipalId: 'Actor:A',
      workId: 'Work:A',
      expectedWorkGeneration: 7,
      expectedTicketRevision: 10,
      retestRequestId: 'Retest:ExactCase',
      report: {
        articleId: 'Article:A',
        ledgerEpoch: 2,
        reportId: 'Report:A',
        expectedReportGeneration: 3,
        reviewBindingHash: 'a'.repeat(64),
        receipt: 'PRIVATE_KB_RECEIPT',
      },
    });
    expect(channels(f.root)).not.toContain('PRIVATE_RETEST_RECEIPT');
    expect(f.panel.hasPending()).toBe(true);
    await f.panel.perform('retest-result');
    expect(f.resultPackets).toHaveLength(1);
    expect(Object.keys(f.resultPackets[0]).sort()).toEqual(
      ['commandId', 'workId', 'retestRequestId', 'receiptReference'].sort(),
    );
    expect(f.resultPackets[0].commandId).not.toBe(packet.commandId);
    expect(f.panel.hasPending()).toBe(false);
  });
  it.each([
    { delivered: true, expected: 10 },
    { delivered: false, expected: 9 },
  ])(
    'binds a new preparation to its immutable work revision after unrelated current ticket changes: %j',
    async ({ delivered, expected }) => {
      const f = fixture();
      f.state.revision = 20;
      if (!delivered)
        Object.assign(f.work, {
          delivered: undefined,
          prepared: {
            bundle: { retestRequests: f.work.handoff.retestRequests },
          },
        });
      await f.load();
      await f.prepare();
      expect(f.prepCalls()).toHaveLength(1);
      expect(JSON.parse(f.prepCalls()[0]!.bytes!).expectedTicketRevision).toBe(
        expected,
      );
    },
  );
  it('uses the prepared exact retest request set before the handoff fallback', async () => {
    const f = fixture();
    const requests = f.work.handoff.retestRequests;
    Object.assign(f.work, {
      prepared: { bundle: { retestRequests: requests } },
      handoff: {
        kbProposal: null,
        retestRequests: [{ ...requests[0], requestId: 'Retest:OtherHandoff' }],
      },
    });
    await f.load();
    await f.prepare();
    expect(f.prepCalls()).toHaveLength(1);
    expect(JSON.parse(f.prepCalls()[0]!.bytes!).retestRequestId).toBe(
      'Retest:ExactCase',
    );
  });
  it('makes exactly one automatic identical next request after a known closed202', async () => {
    const f = fixture();
    await f.load();
    f.state.pendingCount = 1;
    await f.prepare();
    expect(f.prepCalls()).toHaveLength(2);
    expect(f.prepCalls()[1]!.bytes).toBe(f.prepCalls()[0]!.bytes);
    expect(f.resultPackets).toEqual([]);
    expect(f.state.ids).toBe(2);
  });
  it('stops after two pending responses, keeps the original packet and resumes only on explicit retry', async () => {
    const f = fixture();
    await f.load();
    f.state.pendingCount = 2;
    await f.prepare();
    expect(f.prepCalls()).toHaveLength(2);
    expect(f.panel.hasPending()).toBe(true);
    expect(f.root.textContent).toContain('No retest result has been recorded');
    expect(f.resultPackets).toEqual([]);
    await f.panel.perform('exact-retry');
    expect(f.prepCalls()).toHaveLength(3);
    expect(
      f.prepCalls().every((c) => c.bytes === f.prepCalls()[0]!.bytes),
    ).toBe(true);
  });
  it('does not automatically retry an unknown preparation acknowledgement or rebind edited report fields', async () => {
    const f = fixture();
    await f.load();
    f.state.losePreparation = true;
    await f.prepare();
    expect(f.prepCalls()).toHaveLength(1);
    f.field('reportId').value = 'MUST_NOT_REBIND';
    await f.panel.perform('exact-retry');
    expect(f.prepCalls()).toHaveLength(2);
    expect(f.prepCalls()[1]!.bytes).toBe(f.prepCalls()[0]!.bytes);
  });
  it('cannot discard an unknown preparation after a later closed conflict', async () => {
    const f = fixture();
    await f.load();
    f.state.losePreparation = true;
    await f.prepare();
    f.state.http = 409;
    await f.panel.perform('exact-retry');
    await f.panel.perform('discard');
    expect(f.panel.hasPending()).toBe(true);
    expect(f.prepCalls()).toHaveLength(2);
    expect(f.prepCalls()[1]!.bytes).toBe(f.prepCalls()[0]!.bytes);
    expect(f.resultPackets).toEqual([]);
  });
  it('retains the exact result command after lost ACK without rereading or re-associating the report', async () => {
    const f = fixture();
    await f.load();
    await f.prepare();
    f.state.loseResult = true;
    await f.panel.perform('retest-result');
    const first = f.resultPackets[0];
    f.report.status = 'rejected';
    f.field('retestRequestId').value = 'MUST_NOT_REBIND';
    await f.panel.perform('exact-retry');
    expect(f.resultPackets).toEqual([first, first]);
    expect(f.prepCalls()).toHaveLength(1);
    expect(
      f.calls.filter((c) => c.path === '/api/staff/knowledge/command'),
    ).toHaveLength(1);
    expect(f.panel.hasPending()).toBe(false);
  });
  it.each([
    { status: 'pending', result: 'passed' },
    { status: 'rejected', result: 'passed' },
    { status: 'confirmed', result: 'inconclusive' },
  ])(
    'holds unqualified report %j before preparation',
    async ({ status, result }) => {
      const f = fixture();
      f.report.status = status;
      f.report.evidence.result = result;
      await f.load();
      await f.prepare();
      expect(f.prepCalls()).toEqual([]);
      expect(f.resultPackets).toEqual([]);
    },
  );
  it('submits a confirmed failed report as failed rather than reporting a pass', async () => {
    const f = fixture();
    f.report.evidence.result = 'failed';
    await f.load();
    await f.prepare();
    await f.panel.perform('retest-result');
    expect(f.work.retestResults[0].result).toBe('failed');
    expect(f.root.textContent).toContain('Retest failed result acknowledged');
  });
  it('invalidates a late report read after the user changes the selected locator', async () => {
    const f = fixture();
    f.state.reportGate = barrier();
    const loading = f.load();
    await vi.waitFor(() =>
      expect(
        f.calls.some((c) => c.path === '/api/staff/knowledge/command'),
      ).toBe(true),
    );
    f.field('reportId').value = 'Report:Different';
    f.field('reportId').dispatchEvent(new Event('input'));
    f.state.reportGate.release();
    await loading;
    await f.prepare();
    expect(f.prepCalls()).toEqual([]);
  });
  it('stops a known202 continuation when the authenticated account changes', async () => {
    const f = fixture();
    await f.load();
    f.state.pendingCount = 1;
    f.state.afterPreparation = () => {
      f.state.actor = 'Actor:B';
    };
    await f.prepare();
    expect(f.prepCalls()).toHaveLength(1);
    expect(f.resultPackets).toEqual([]);
    expect(f.panel.hasPending()).toBe(true);
  });
  it('withholds preparation after current session authority is removed', async () => {
    const f = fixture();
    await f.load();
    f.state.enabled = false;
    await f.prepare();
    expect(f.prepCalls()).toEqual([]);
    expect(f.accessLost).toHaveBeenCalled();
  });
  it('retains the original packet after source revision changes between staged physical requests', async () => {
    const f = fixture();
    await f.load();
    f.state.pendingCount = 1;
    f.state.afterPreparation = () => {
      f.state.revision = 11;
      f.state.http = 409;
    };
    await f.prepare();
    expect(f.prepCalls()).toHaveLength(2);
    expect(f.prepCalls()[1]!.bytes).toBe(f.prepCalls()[0]!.bytes);
    expect(JSON.parse(f.prepCalls()[1]!.bytes!).expectedTicketRevision).toBe(
      10,
    );
    expect(f.resultPackets).toEqual([]);
    expect(f.panel.hasPending()).toBe(true);
    await f.panel.perform('discard');
    expect(f.panel.hasPending()).toBe(false);
  });
  it('rejects a malformed pending ACK instead of inventing receipt or success authority', async () => {
    const f = fixture();
    await f.load();
    f.state.pendingCount = 1;
    f.state.malformed = true;
    await f.prepare();
    expect(f.prepCalls()).toHaveLength(1);
    expect(f.resultPackets).toEqual([]);
    expect(f.panel.hasPending()).toBe(true);
    await f.panel.perform('discard');
    expect(f.panel.hasPending()).toBe(true);
  });
  it('drops a late preparation result after suspension and preserves its original packet for recovery', async () => {
    const f = fixture();
    await f.load();
    f.state.prepGate = barrier();
    const sending = f.prepare();
    await vi.waitFor(() => expect(f.prepCalls()).toHaveLength(1));
    f.panel.suspend();
    f.state.prepGate.release();
    await sending;
    expect(f.resultPackets).toEqual([]);
    expect(f.panel.hasPending()).toBe(true);
    f.open();
    await f.panel.perform('exact-retry');
    expect(f.prepCalls()[1]!.bytes).toBe(f.prepCalls()[0]!.bytes);
  });
});

describe('actual PG ticket status-preserving preparation transport', () => {
  it('preserves the actual202 status, current CSRF and credential fences without changing ordinary reads', async () => {
    let options: any;
    const panel = {
      showTicket: () => {},
      suspend: () => {},
      hasPending: () => false,
    };
    const view = {
      ticket: {
        id: 'ticket-example',
        number: 1,
        subject: 'Status transport fixture',
        status: 'waiting_on_support',
        priority: 'normal',
        revision: 10,
        handling: { state: 'human-active', generation: 1 },
      },
      messages: [],
      csrfToken: 'csrf',
      releaseFollowupEnabled: true,
    };
    const page = supportBrowser(
      'staff',
      (call) => ({
        status: call.path.endsWith('/retest-receipt') ? 202 : 200,
        body:
          call.path === '/api/identity/session'
            ? { account: { subject: 'Actor:A' }, csrfToken: 'csrf' }
            : call.path.endsWith('/handoff')
              ? { handoff: [] }
              : call.path.endsWith('/retest-receipt')
                ? { result: { pending: 'report' }, csrfToken: 'csrf' }
                : view,
      }),
      {
        PegmaSupportFollowup: {
          createPanel: (received: any) => {
            options = received;
            return panel;
          },
        },
      },
    );
    await page.until(() => !page.node('staff-ticket-detail').hidden && options?.canRequest() === true);
    await page.drain();
    expect(typeof options.requestWithStatus).toBe('function');
    const body = JSON.stringify({ commandId: 'Command:Exact' });
    const response = await options.requestWithStatus(
      '/api/support/admin/tickets/ticket-example/follow-up/retest-receipt',
      { method: 'POST', body },
    );
    expect(response).toEqual({
      status: 202,
      body: { result: { pending: 'report' }, csrfToken: 'csrf' },
    });
    const sent = page.calls.find((call) =>
      call.path.endsWith('/retest-receipt'),
    )!;
    expect(sent.headers.get('X-Pegma-CSRF')).toBe('csrf');
    expect(sent.body).toBe(body);
    expect(
      await options.request('/api/support/admin/tickets/ticket-example'),
    ).toEqual(view);
  });
});
