import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
const context: any = { URLSearchParams, Date };
runInNewContext(
  readFileSync(
    new URL('../public/staff-support-review-inbox.js', import.meta.url),
    'utf8',
  ),
  context,
);
const { createReviewInbox } = context.PegmaSupportReviewInbox;
// Synthetic DOM/HTTP ports exercise the actual event controller, not model quality or live deployment.
class TestDocument {
  createElement(tag: string): TestElement {
    return new TestElement(tag, this);
  }
}
class TestElement extends EventTarget {
  readonly attributes = new Map<string, string>();
  children: TestElement[] = [];
  disabled = false;
  type = '';
  className = '';
  private text = '';
  constructor(
    readonly tag: string,
    readonly ownerDocument: TestDocument,
  ) {
    super();
  }
  get textContent(): string {
    return this.text + this.children.map((n) => n.textContent).join('');
  }
  set textContent(v: string) {
    this.text = v;
    this.children = [];
  }
  set innerHTML(_v: string) {
    throw new Error('Use literal text.');
  }
  setAttribute(k: string, v: string) {
    this.attributes.set(k, v);
  }
  append(...v: TestElement[]) {
    this.children.push(...v);
  }
  replaceChildren(...v: TestElement[]) {
    this.text = '';
    this.children = v;
  }
}
const all = (n: TestElement): TestElement[] => [n, ...n.children.flatMap(all)];
function fixture() {
  const doc = new TestDocument();
  const host = doc.createElement('section');
  let actor = 'Account:A';
  let valid = true;
  const page = {
    reviewSources: ['Ticket:<literal>'],
    reviewCandidates: [{ ticketId: 'Ticket:B', sourceGeneration: 3 }],
    physicalRows: 3,
    pages: 1,
    nextCursor: 'Opaque:Cursor:ExactCase',
  };
  const request = vi.fn(async (_path: string): Promise<any> => ({
    status: 200,
    body: { result: page },
  }));
  const session = vi.fn(async () => ({ accountId: actor }));
  const openTicket = vi.fn();
  const denied = vi.fn();
  const panel = createReviewInbox({
    host,
    request,
    session,
    capture: () => () => valid,
    openTicket,
    denied,
  });
  const node = (key: string) =>
    all(host).find((n) => n.attributes.get('data-engineering-inbox') === key)!;
  const settle = () => new Promise<void>((done) => setImmediate(done));
  const click = async (key: string) => {
    expect(node(key).disabled).toBe(false);
    node(key).dispatchEvent(new Event('click'));
    await settle();
  };
  return {
    panel,
    host,
    page,
    request,
    session,
    openTicket,
    denied,
    node,
    click,
    settle,
    actor(next: string) {
      actor = next;
    },
    leave() {
      valid = false;
    },
  };
}
function barrier() {
  let release = () => {};
  const pending = new Promise<void>((done) => {
    release = done;
  });
  return { pending, release };
}
describe('bounded engineering review inbox', () => {
  it('loads only on explicit action, projects literal review labels and opens the current ticket panel', async () => {
    const f = fixture();
    expect(f.request).not.toHaveBeenCalled();
    await f.click('load');
    expect(f.request).toHaveBeenCalledExactlyOnceWith(
      '/api/support/admin/engineering/review-inbox?limit=10',
    );
    expect(f.host.textContent).toContain('Ticket:<literal>');
    expect(f.host.textContent).toContain('Proposal generation 3');
    expect(f.session).toHaveBeenCalledTimes(2);
    await f.click('ticket');
    expect(f.openTicket).toHaveBeenCalledWith('Ticket:<literal>');
    expect(f.node('list').textContent).toBe('');
  });
  it('follows one exact opaque cursor only after the next-page action', async () => {
    const f = fixture();
    await f.click('load');
    expect(f.request).toHaveBeenCalledTimes(1);
    await f.click('next');
    expect(f.request.mock.calls[1]?.[0]).toContain(
      'cursor=Opaque%3ACursor%3AExactCase',
    );
    f.page.nextCursor = null as any;
    await f.click('load');
    expect(f.node('next').disabled).toBe(true);
  });
  it('clears previous private results before a read and drops a late result after view invalidation', async () => {
    const f = fixture();
    await f.click('load');
    const gate = barrier();
    f.request.mockImplementation(async () => {
      await gate.pending;
      return { status: 200, body: { result: f.page } };
    });
    f.node('load').dispatchEvent(new Event('click'));
    await f.settle();
    expect(f.node('list').textContent).toBe('');
    f.panel.clear();
    f.leave();
    gate.release();
    await f.settle();
    expect(f.node('list').textContent).toBe('');
  });
  it('withholds the response when the authenticated account changes during the read', async () => {
    const f = fixture();
    f.request.mockImplementation(async () => {
      f.actor('Account:B');
      return { status: 200, body: { result: f.page } };
    });
    await f.click('load');
    expect(f.node('list').textContent).toBe('');
    expect(f.denied).toHaveBeenCalledWith(403);
  });
  it.each([401, 403])(
    'clears results and delegates a current %s denial',
    async (status) => {
      const f = fixture();
      await f.click('load');
      f.request.mockResolvedValue({
        status,
        body: { private: 'MUST_NOT_RENDER' },
      });
      await f.click('load');
      expect(f.node('list').textContent).toBe('');
      expect(f.denied).toHaveBeenCalledWith(status);
      expect(f.host.textContent).not.toContain('MUST_NOT_RENDER');
    },
  );
  it('bounds rate-limit retries and makes no automatic request', async () => {
    const f = fixture();
    f.request.mockResolvedValue({
      status: 429,
      headers: new Headers({ 'Retry-After': '60' }),
    });
    await f.click('load');
    await f.click('load');
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.node('status').textContent).toContain('wait');
  });
  it('holds malformed or oversized result pages without rendering them', async () => {
    const f = fixture();
    f.page.reviewSources = Array.from({ length: 11 }, () => 'Ticket:Extra');
    await f.click('load');
    expect(f.node('list').textContent).toBe('');
    expect(f.node('status').textContent).toContain('unavailable');
  });
});
