import { afterEach, describe, expect, it } from 'vitest';
import { disposeSupportBrowsers, supportBrowser } from './test-support-browser';
afterEach(disposeSupportBrowsers);
describe('actual staff queue handling form', () => {
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
