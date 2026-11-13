import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {
  BrowserNode,
  browserGate,
  disposeSupportBrowsers,
  supportBrowser,
  type BrowserResponse,
} from './test-support-browser';
afterEach(disposeSupportBrowsers);
class InboxNode extends BrowserNode {
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
}
function queueInbox(hold = false) {
  const vm: any = {
    Date,
    URLSearchParams,
    document: { createElement: (tag: string) => new InboxNode(tag) },
  };
  runInNewContext(
    readFileSync(
      new URL('../public/staff-support-review-inbox.js', import.meta.url),
      'utf8',
    ),
    vm,
  );
  const delayed = browserGate<BrowserResponse>();
  let inboxReads = 0;
  const page = supportBrowser(
    'queue',
    (call) => {
      if (call.path.startsWith('/api/identity/'))
        return {
          body: {
            account: { subject: 'Staff:A', email: 'staff@example.test' },
            csrfToken: 'csrf',
          },
        };
      if (call.path.startsWith('/api/support/admin/queue'))
        return { body: { items: [], csrfToken: 'csrf' } };
      if (call.path.startsWith('/api/support/admin/engineering/review-inbox')) {
        ++inboxReads;
        if (hold && inboxReads === 1) return delayed.promise;
        return {
          body: {
            result: {
              reviewSources: ['Ticket:Current'],
              reviewCandidates: [],
              physicalRows: 1,
              pages: 1,
              nextCursor: 'Exact:Cursor',
            },
          },
        };
      }
      throw new Error('Unexpected queue request ' + call.path);
    },
    { PegmaSupportReviewInbox: vm.PegmaSupportReviewInbox },
  );
  const node = (name: string) =>
    page
      .node('engineering-review-inbox')
      .all()
      .find((n) => n.attributes.get('data-engineering-inbox') === name)!;
  return { page, node, delayed, reads: () => inboxReads };
}
describe('actual staff queue handling form', () => {
  it('clears an in-flight inbox when the real queue refresh invalidates its captured generation', async () => {
    const f = queueInbox(true);
    await f.page.until(() => !f.page.node('staff-queue-panel').hidden);
    f.node('load').fire('click');
    await f.page.until(() => f.reads() === 1);
    f.page.node('filter-handling').value = 'all';
    f.page.node('queue-filters').fire('submit');
    await f.page.until(
      () => f.page.node('staff-queue-status').textContent === 'Queue updated.',
    );
    expect(f.node('load').disabled).toBe(false);
    expect(f.node('next').disabled).toBe(true);
    expect(f.node('list').textContent).toBe('');
    f.delayed.resolve({
      body: {
        result: {
          reviewSources: ['Ticket:Stale'],
          reviewCandidates: [],
          physicalRows: 1,
          pages: 1,
          nextCursor: null,
        },
      },
    });
    await f.page.drain();
    expect(f.node('list').textContent).toBe('');
    expect(f.reads()).toBe(1);
    f.node('load').fire('click');
    await f.page.until(() =>
      f.node('list').textContent.includes('Ticket:Current'),
    );
    expect(f.reads()).toBe(2);
    expect(f.node('next').disabled).toBe(false);
  });
  it('removes completed inbox buttons on queue refresh and opens tickets only from a fresh page', async () => {
    const f = queueInbox();
    await f.page.until(() => !f.page.node('staff-queue-panel').hidden);
    f.node('load').fire('click');
    await f.page.until(() =>
      f.node('list').textContent.includes('Ticket:Current'),
    );
    const previous = f.node('ticket');
    f.page.node('queue-filters').fire('submit');
    await f.page.until(
      () => f.page.node('staff-queue-status').textContent === 'Queue updated.',
    );
    expect(f.node('list').textContent).toBe('');
    const originalURL = f.page.window.location.href;
    previous.fire('click');
    expect(f.page.window.location.href).toBe(originalURL);
    f.node('load').fire('click');
    await f.page.until(() =>
      f.node('list').textContent.includes('Ticket:Current'),
    );
    f.node('ticket').fire('click');
    expect(f.page.window.location.href).toBe(
      '/staff/support/ticket/?id=Ticket%3ACurrent',
    );
  });
  it('keeps the human default implicit and forwards explicit assistant/all choices', async () => {
    const page = supportBrowser('queue', (call) => ({
      body:
        call.path === '/api/identity/account'
          ? {
              account: { subject: 'Staff:A', email: 'staff@example.test' },
              csrfToken: 'csrf',
            }
          : { items: [], csrfToken: 'csrf' },
    }));
    await page.until(() => !page.node('staff-queue-panel').hidden);
    expect(
      page.calls.find((c) => c.path.startsWith('/api/support/admin/queue'))
        ?.path,
    ).toBe('/api/support/admin/queue?sort=updated_newest');
    for (const handling of ['assistant', 'all', 'human']) {
      const before = page.calls.length;
      page.node('filter-handling').value = handling;
      page.node('queue-filters').fire('submit');
      await page.drain();
      const path = page.calls
        .slice(before)
        .find((c) => c.path.startsWith('/api/support/admin/queue'))?.path;
      expect(
        new URL(path!, 'https://pegma.dev').searchParams.get('handling'),
      ).toBe(handling === 'human' ? null : handling);
      expect(page.node('queue-heading').textContent).toBe(
        handling === 'assistant'
          ? 'Assistant supervision'
          : handling === 'all'
            ? 'All support work'
            : 'Human queue',
      );
    }
  });
});
