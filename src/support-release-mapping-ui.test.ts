import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
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
// Real event controller with synthetic closed HTTP DTOs; backend/SDK tests own proof acceptance.
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
function fixture() {
  const doc = new Doc();
  const root = doc.createElement('section');
  let actor = 'Actor:A';
  let sessionEnabled = true;
  let ids = 0;
  let loseAck = false;
  let refused = 0;
  let failClosingSession = 0;
  let closingStatus = 0;
  const calls: { path: string; body?: any }[] = [];
  const accepted: any[] = [];
  const mapping = {
    actorId: actor,
    ticketId: 'Ticket:A',
    ticketRevision: 9,
    repositoryId: 'Repo:ExactCase',
    issueId: 'Issue:ExactCase',
    issueNumber: 17,
    mappingGeneration: 0,
    mapping: null,
    release: { releaseRef: 'Release:ExactCase' },
  };
  const entry = {
    repositoryId: mapping.repositoryId,
    issueId: mapping.issueId,
    issueNumber: 17,
    repositoryName: 'Owner/Repo',
    product: { productId: 'Product:A', version: '1', buildId: 'old' },
  };
  const request = vi.fn(async (path: string, init: any = {}) => {
    const body =
      typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    calls.push({ path, ...(body ? { body } : {}) });
    const wrap = (result: any) =>
      PG ? { result, csrfToken: 'csrf' } : { result };
    if (path.endsWith('/mapping') && init.method !== 'POST')
      return wrap(
        PG
          ? {
              actorId: actor,
              ticketId: 'Ticket:A',
              ticketRevision: 9,
              choices: [entry],
              hasMore: false,
            }
          : { ticketId: 'Ticket:A', ticketRevision: 9, associations: [entry] },
      );
    if (path.includes('/mapping?')) return wrap(mapping);
    if (
      path.endsWith(PG ? '/verify-mapping' : '/mapping') &&
      init.method === 'POST'
    ) {
      const result = {
        actorId: 'Actor:A',
        ticketId: 'Ticket:A',
        commandId: body.commandId,
        mappingGeneration: 1,
        inputReference: 'Opaque:Mapping:1',
      };
      if (refused)
        throw Object.assign(new Error('request_failed'), { status: refused });
      accepted.push(body);
      if (loseAck) {
        loseAck = false;
        throw new Error('lost_ack');
      }
      closingStatus = failClosingSession;
      return wrap(result);
    }
    if (path.includes('/work?'))
      return wrap({
        ticketId: 'Ticket:A',
        workId: 'Work:A',
        workGeneration: 4,
        acceptedTicketRevision: 9,
        prepared: {
          bundleHash: 'a'.repeat(64),
          bundle: { customerDraft: { body: '<literal> verified update' } },
        },
      });
    if (path.endsWith('/post'))
      return {
        ...wrap({
          ticketId: 'Ticket:A',
          workId: 'Work:A',
          ticketRevision: 10,
          messageId: body.messageId,
          bundleHash: body.bundleHash,
        }),
        commandId: body.commandId,
        operation: 'post',
      };
    throw new Error('Unexpected followup UI request ' + path);
  });
  const settled = vi.fn();
  const accessLost = vi.fn();
  const panel = createPanel({
    root,
    request,
    readSession: async () => {
      if (closingStatus) {
        const status = closingStatus;
        closingStatus = 0;
        throw Object.assign(new Error('session_read_failed'), { status });
      }
      return sessionEnabled
        ? PG
          ? { subject: actor, csrfToken: 'csrf' }
          : { accountId: actor }
        : null;
    },
    readCurrentTicket: async () => ({
      ticket: { id: 'Ticket:A', revision: 9 },
      ...(PG ? { csrfToken: 'csrf' } : {}),
    }),
    commandId: () =>
      '15df8c75-33ac-4e45-a144-' + String(++ids).padStart(12, '0'),
    onSettled: settled,
    onAccessLost: accessLost,
  });
  const field = (key: string) =>
    all(root).find((n) => n.dataset.followupField === key)!;
  const open = (ticketId = 'Ticket:A') =>
    panel.showTicket({
      ticketId,
      ...(PG ? { actorSubject: actor } : { accountId: actor }),
    });
  async function load() {
    open();
    await panel.perform('mapping-list');
    field('association').value = '0';
    field('association').dispatchEvent(new Event('change'));
    await panel.perform('mapping');
  }
  function fill() {
    for (const [key, value] of Object.entries({
      releaseRef: 'Release:ExactCase',
      version: '2.0',
      buildId: 'Build:2',
      deploymentId: 'Deployment:A',
      deploymentEpoch: 'Epoch:2',
      scopeRef: 'Production:Scope',
      verificationReference: 'Proof:Staff',
      issueState: 'closed',
      deploymentState: 'deployed',
      publicFacts: JSON.stringify([
        {
          reference: 'Public:Proof',
          text: 'The verified fix handles export rows.',
        },
      ]),
    }))
      field(key).value = value;
    field('mappingVerified').checked = true;
  }
  return {
    panel,
    root,
    request,
    calls,
    accepted,
    mapping,
    entry,
    field,
    open,
    load,
    fill,
    settled,
    accessLost,
    lose() {
      loseAck = true;
    },
    refuse(status: number) {
      refused = status;
    },
    failClosing(status: number) {
      failClosingSession = status;
    },
    changeActor() {
      actor = 'Actor:B';
    },
    deny() {
      sessionEnabled = false;
    },
  };
}
describe('explicit staff verified mapping UI', () => {
  it('loads real association choices, keeps product bound and requires explicit verification', async () => {
    const f = fixture();
    await f.load();
    expect(f.field('repositoryId').value).toBe('Repo:ExactCase');
    expect(f.field('productId').value).toBe('Product:A');
    expect(f.field('productId').readOnly).toBe(true);
    f.fill();
    f.field('mappingVerified').checked = false;
    await f.panel.perform('verify-mapping');
    expect(f.accepted).toEqual([]);
    f.field('mappingVerified').checked = true;
    await f.panel.perform('verify-mapping');
    expect(f.accepted).toHaveLength(1);
    expect(f.accepted[0]).toMatchObject({
      expectedPrincipalId: 'Actor:A',
      expectedTicketRevision: 9,
      expectedMappingGeneration: 0,
      repositoryId: 'Repo:ExactCase',
      issueId: 'Issue:ExactCase',
      fixedProduct: {
        productId: 'Product:A',
        version: '2.0',
        buildId: 'Build:2',
      },
    });
    expect(
      f.calls.some(
        (c) => c.path.endsWith('/observe') || c.path.endsWith('/post'),
      ),
    ).toBe(false);
  });
  it('retains the original immutable packet after lost acknowledgement and ignores edited fields on exact retry', async () => {
    const f = fixture();
    await f.load();
    f.fill();
    f.lose();
    await f.panel.perform('verify-mapping');
    expect(f.panel.hasPending()).toBe(true);
    f.field('version').value = 'MUST_NOT_REBIND';
    await f.panel.perform('exact-retry');
    expect(f.accepted).toHaveLength(2);
    expect(f.accepted[1]).toEqual(f.accepted[0]);
    expect(f.panel.hasPending()).toBe(false);
    expect(f.settled).toHaveBeenCalledTimes(1);
  });
  it.each([400, 409, 413])(
    'lets the original actor explicitly discard a closed %s refusal and reload before creating a new packet',
    async (status) => {
      const f = fixture();
      await f.load();
      f.fill();
      f.refuse(status);
      await f.panel.perform('verify-mapping');
      const rejected = f.calls.at(-1)!.body;
      expect(f.panel.hasPending()).toBe(true);
      expect(f.accepted).toEqual([]);
      await f.panel.perform('discard');
      expect(f.panel.hasPending()).toBe(false);
      expect(f.root.textContent).toContain('discarded locally');
      f.refuse(0);
      await f.load();
      f.fill();
      await f.panel.perform('verify-mapping');
      expect(f.accepted).toHaveLength(1);
      expect(f.accepted[0].commandId).not.toBe(rejected.commandId);
      expect(f.settled).toHaveBeenCalledTimes(1);
    },
  );
  it.each([400, 409, 413, 503])(
    'keeps an earlier unknown ACK nondiscardable after a later %s refusal',
    async (status) => {
      const f = fixture();
      await f.load();
      f.fill();
      f.lose();
      await f.panel.perform('verify-mapping');
      f.refuse(status);
      await f.panel.perform('exact-retry');
      await f.panel.perform('discard');
      expect(f.panel.hasPending()).toBe(true);
      expect(f.accepted).toHaveLength(1);
      expect(f.calls.at(-1)!.body).toEqual(f.accepted[0]);
      f.refuse(0);
      await f.panel.perform('exact-retry');
      expect(f.panel.hasPending()).toBe(false);
      expect(f.accepted[1]).toEqual(f.accepted[0]);
    },
  );
  it.each([400, 409, 413])(
    'does not mistake a closing session-read %s failure for rejection of the accepted command',
    async (status) => {
      const f = fixture();
      await f.load();
      f.fill();
      f.failClosing(status);
      await f.panel.perform('verify-mapping');
      expect(f.accepted).toHaveLength(1);
      await f.panel.perform('discard');
      expect(f.panel.hasPending()).toBe(true);
      f.failClosing(0);
      await f.panel.perform('exact-retry');
      expect(f.accepted[1]).toEqual(f.accepted[0]);
      expect(f.panel.hasPending()).toBe(false);
    },
  );
  it('does not let another account discard the original actor’s rejected packet', async () => {
    const f = fixture();
    await f.load();
    f.fill();
    f.refuse(409);
    await f.panel.perform('verify-mapping');
    f.changeActor();
    f.open();
    const calls = f.calls.length;
    await f.panel.perform('discard');
    expect(f.panel.hasPending()).toBe(true);
    expect(f.calls).toHaveLength(calls);
  });
  it('keeps original command ownership across suspension and refuses a different account/ticket', async () => {
    const f = fixture();
    await f.load();
    f.fill();
    f.lose();
    await f.panel.perform('verify-mapping');
    f.panel.suspend();
    f.changeActor();
    f.open('Ticket:B');
    await f.panel.perform('exact-retry');
    expect(f.accepted).toHaveLength(1);
    expect(f.panel.hasPending()).toBe(true);
  });
  it('withholds verification after current session authority is lost', async () => {
    const f = fixture();
    await f.load();
    f.fill();
    f.deny();
    await f.panel.perform('verify-mapping');
    expect(f.accepted).toEqual([]);
    expect(f.accessLost).toHaveBeenCalled();
  });
  it('rejects malformed or unbounded public facts locally', async () => {
    const f = fixture();
    await f.load();
    f.fill();
    f.field('publicFacts').value = JSON.stringify(
      Array.from({ length: 5 }, () => ({ reference: 'p', text: 'fact' })),
    );
    await f.panel.perform('verify-mapping');
    expect(f.accepted).toEqual([]);
  });
  it.each([
    { facts: [] },
    {
      facts: [
        { reference: 'duplicate', text: 'one' },
        { reference: 'duplicate', text: 'two' },
      ],
    },
    { facts: [{ reference: 'bounded', text: 'x'.repeat(1001) }] },
  ])(
    'rejects public facts outside the actual SDK proof bounds: %j',
    async ({ facts }) => {
      const f = fixture();
      await f.load();
      f.fill();
      f.field('publicFacts').value = JSON.stringify(facts);
      await f.panel.perform('verify-mapping');
      expect(f.accepted).toEqual([]);
    },
  );
  it('reads the complete exact bundle before an explicit post and forwards its current fences', async () => {
    const f = fixture();
    f.open();
    await f.panel.perform('post');
    expect(f.calls).toEqual([]);
    f.field('workId').value = 'Work:A';
    await f.panel.perform('work');
    expect(f.root.textContent).toContain('<literal> verified update');
    expect(f.calls.some((c) => c.path.endsWith('/post'))).toBe(false);
    await f.panel.perform('post');
    expect(f.calls.at(-1)?.body).toMatchObject({
      workId: 'Work:A',
      expectedWorkGeneration: 4,
      expectedTicketRevision: 9,
      bundleHash: 'a'.repeat(64),
    });
  });
});
