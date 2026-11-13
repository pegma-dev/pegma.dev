import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { BrowserNode, browserGate, disposeSupportBrowsers, supportBrowser, type BrowserCall, type BrowserResponse } from './test-support-browser';

afterEach(disposeSupportBrowsers);

interface Panel {
  hasPending(): boolean;
  perform(action: string): Promise<void>;
}
interface PanelOptions {
  canRequest(): boolean;
  request(path: string, init?: RequestInit): Promise<unknown>;
}
class PanelNode extends BrowserNode {
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
}

// Both real browser scripts run against inert DOM/HTTP adapters. These cases
// establish page admission and exact packet retention, not SDK persistence.
function harness(initialHint: unknown) {
  const state = { hint: initialHint, subject: 'synthetic-followup-staff', loseAck: false,
    held: undefined as ReturnType<typeof browserGate<BrowserResponse>> | undefined };
  const vm: Record<string, unknown> = {
    document: { createElement: (tag: string) => new PanelNode(tag) },
    crypto: { randomUUID }, Date, setTimeout, clearTimeout,
  };
  runInNewContext(readFileSync(new URL('../public/staff-support-followup.js', import.meta.url), 'utf8'), vm);
  const factory = vm.PegmaSupportFollowup as { createPanel(options: PanelOptions): Panel };
  let panel!: Panel;
  let options!: PanelOptions;
  const account = () => ({ account: { subject: state.subject }, csrfToken: 'synthetic-followup-csrf' });
  const view = () => ({
    ticket: { id: 'ticket-example', revision: 1, number: 1, marker: '[PEG-1]', subject: 'Fictional fix', status: 'open',
      category: 'question', priority: 'normal', handling: { state: 'human-active', generation: 0 } },
    messages: [], csrfToken: account().csrfToken,
    ...(state.hint === undefined ? {} : { releaseFollowupEnabled: state.hint }),
  });
  const writes: BrowserCall[] = [];
  const page = supportBrowser('staff', (call) => {
    if (call.path === '/api/identity/session') return { body: account() };
    if (call.path.endsWith('/handoff')) return { body: { handoff: [], csrfToken: account().csrfToken } };
    if (call.path.endsWith('/follow-up/observe')) {
      writes.push(call);
      if (state.held) return state.held.promise;
      if (state.loseAck) throw new Error('Synthetic lost acknowledgement');
      return { body: { commandId: JSON.parse(call.body!).commandId, operation: 'observe',
        result: { ticketId: 'ticket-example', headGeneration: 1, outcome: 'queued' }, csrfToken: account().csrfToken } };
    }
    return { body: view() };
  }, { PegmaSupportFollowup: { createPanel(value: PanelOptions) {
    options = value;
    panel = factory.createPanel(value);
    return panel;
  } } });
  const field = (name: string) => {
    const node = page.node('staff-followup-panel').all().find((entry) => entry.dataset.followupField === name);
    if (!node) throw new Error('Missing actual follow-up field ' + name);
    return node;
  };
  const ready = async () => {
    // drain() observes HTTP idleness, which can occur between the session JSON
    // and the next ticket request. Wait for the actual complete page outcome.
    await page.until(() => page.node('staff-ticket-status').textContent === 'Ticket loaded.' ||
      page.node('staff-ticket-status').textContent.startsWith('Could not confirm the ticket read result'));
    if (!page.node('staff-ticket-detail').hidden)
      await page.until(() => page.node('staff-handoff-status').textContent === 'No handoff records for this ticket.');
  };
  const reload = async () => { page.node('staff-ticket-reload').fire('click'); await ready(); };
  const fillObserve = () => {
    field('repositoryId').value = 'synthetic-repository';
    field('issueId').value = 'synthetic-issue';
    field('inputReference').value = 'synthetic-input';
  };
  return { state, page, writes, ready, reload, fillObserve, panel: () => panel, options: () => options };
}

describe('staff page release-follow-up capability admission', () => {
  it.each([undefined, false])('hides the panel and admits no requests when the hint is %s', async (hint) => {
    const h = harness(hint); await h.ready();
    expect(h.page.node('staff-ticket-detail').hidden).toBe(false);
    expect(h.page.node('staff-followup-panel').hidden).toBe(true);
    expect(h.options().canRequest()).toBe(false);
    await h.panel().perform('mapping-list');
    await expect(h.options().request('/api/support/admin/tickets/ticket-example/follow-up/scan')).rejects.toMatchObject({ stale: true });
    expect(h.page.calls.some((call) => call.path.includes('/follow-up/'))).toBe(false);
  });

  it.each([null, 'true', 1])('rejects a malformed capability hint %s before showing the panel', async (hint) => {
    const h = harness(hint); await h.ready();
    expect(h.page.node('staff-ticket-detail').hidden).toBe(true);
    expect(h.page.node('staff-followup-panel').hidden).toBe(true);
    expect(h.options().canRequest()).toBe(false);
    expect(h.page.calls.some((call) => call.path.includes('/follow-up/'))).toBe(false);
  });

  it('shows current enabled controls, then suspends them on a current OFF view', async () => {
    const h = harness(true); await h.ready();
    expect(h.page.node('staff-followup-panel').hidden).toBe(false);
    expect(h.options().canRequest()).toBe(true);
    h.fillObserve(); await h.panel().perform('observe'); await h.ready();
    expect(h.writes).toHaveLength(1);
    expect(h.panel().hasPending()).toBe(false);
    h.state.hint = false; await h.reload();
    expect(h.page.node('staff-followup-panel').hidden).toBe(true);
    expect(h.options().canRequest()).toBe(false);
    await h.panel().perform('observe');
    expect(h.writes).toHaveLength(1);
    h.state.hint = true; await h.reload();
    expect(h.page.node('staff-followup-panel').hidden).toBe(false);
    expect(h.options().canRequest()).toBe(true);
  });

  it('retires an in-flight request when Reload observes OFF without exposing its late response', async () => {
    const h = harness(true); await h.ready();
    const held = browserGate<BrowserResponse>(); h.state.held = held;
    const pending = h.options().request('/api/support/admin/tickets/ticket-example/follow-up/observe', {
      method: 'POST', body: JSON.stringify({ commandId: randomUUID() }),
    });
    const rejected = (async () => { await expect(pending).rejects.toBeDefined(); })();
    await h.page.until(() => h.writes.length === 1);
    h.state.hint = false; h.page.node('staff-ticket-reload').fire('click');
    await rejected;
    await h.ready(); held.resolve({ body: { late: true } }); await h.page.drain();
    expect(h.page.node('staff-followup-panel').hidden).toBe(true);
    expect(h.options().canRequest()).toBe(false);
    expect(h.writes).toHaveLength(1);
  });

  it('retires cached ON admission when the panel current-ticket refresh observes OFF', async () => {
    const h = harness(true); await h.ready();
    h.fillObserve(); h.state.hint = false;
    await h.panel().perform('observe');
    expect(h.writes).toEqual([]);
    expect(h.page.node('staff-followup-panel').hidden).toBe(true);
    expect(h.options().canRequest()).toBe(false);
    expect(h.panel().hasPending()).toBe(false);
  });

  it('retains the real panel unknown-ACK packet across OFF and account changes until exact same-owner retry', async () => {
    const h = harness(true); await h.ready();
    h.state.loseAck = true; h.fillObserve(); await h.panel().perform('observe');
    expect(h.panel().hasPending()).toBe(true);
    expect(h.writes).toHaveLength(1);
    const original = h.writes[0]!.body;
    h.state.hint = false; await h.reload();
    expect(h.page.node('staff-followup-panel').hidden).toBe(true);
    expect(h.panel().hasPending()).toBe(true);
    h.page.node('compose-body').value = 'A fictional reply while the acknowledgement is unknown.';
    h.page.mode('public');
    h.page.node('staff-compose-form').fire('change');
    expect(h.page.node('compose-submit').disabled).toBe(true);
    await h.panel().perform('exact-retry'); expect(h.writes).toHaveLength(1);
    h.state.subject = 'synthetic-other-staff'; h.state.hint = true; await h.reload();
    await h.panel().perform('exact-retry');
    expect(h.panel().hasPending()).toBe(true);
    expect(h.writes).toHaveLength(1);
    h.state.subject = 'synthetic-followup-staff'; await h.reload();
    h.state.loseAck = false; await h.panel().perform('exact-retry'); await h.ready();
    expect(h.writes).toHaveLength(2);
    expect(h.writes[1]!.body).toBe(original);
    expect(h.panel().hasPending()).toBe(false);
  });
});
