import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BrowserNode } from './test-support-browser';

interface Panel {
  showTicket(ticket: { ticketId: string; revision: number; actorSubject: string; status: string; resolvedAt: string }): Promise<void>;
  suspend(): void;
  hasPending(): boolean;
}
interface Call { readonly path: string; readonly body?: string }
const actor = 'fictional-reviewer-A';
const ticket = { ticketId: 'fictional-ticket', revision: 3, actorSubject: actor,
  status: 'resolved', resolvedAt: '2026-11-11T12:00:00.000Z' };
async function drain() { for (let index = 0; index < 160; index++) await Promise.resolve(); }

function fixture() {
  const root = new BrowserNode('section');
  const calls: Call[] = [];
  const timers = new Map<number, () => void>();
  const state = { enabled: true, subject: actor, csrf: 'fictional-A-csrf', terminal: false,
    held: false, failCancel: false, deny: false, nextTimer: 0 };
  const hash = 'a'.repeat(64);
  const intent = { reviewerId: actor, ticketId: ticket.ticketId, sourceGeneration: 1, expectedWorkGeneration: 2,
    target: { articleId: 'fictional-guide', collectionId: 'fictional-guides', articleRevision: 1,
      contentHash: hash, sourceSnapshotGeneration: 1, sourceSnapshotHash: hash, orderedReferencesHash: hash },
    policy: { version: 'fictional-checks', binding: 'fictional-check-binding',
      verifiedAt: '2026-11-11T12:00:00.000Z', validUntil: '2026-11-11T13:00:00.000Z' } };
  const pending = () => ({ outcome: 'pending', ticketId: ticket.ticketId, commandId: 'EXACT-UPPERCASE',
    phase: 'proof', claimed: false, held: state.held, expiresAt: '2026-11-11T13:00:00.000Z' });
  const accepted = { outcome: 'accepted', result: { ticketId: ticket.ticketId, sourceGeneration: 1,
    resolutionCycle: 1, state: 'eligible' } };
  const vm = { document: { createElement: (tag: string) => new BrowserNode(tag) }, AbortController,
    setTimeout(run: () => void, delay: number) {
      expect(delay).toBe(30_000); const id = ++state.nextTimer; timers.set(id, run); return id;
    }, clearTimeout(id: number) { timers.delete(id); } };
  runInNewContext(readFileSync(new URL('../public/staff-support-learning.js', import.meta.url), 'utf8'), vm);
  const factory = (vm as typeof vm & { PegmaSupportLearning: { createPanel(options: unknown): Panel } }).PegmaSupportLearning;
  const panel = factory.createPanel({ root, stagedReviewsEnabled: () => state.enabled,
    commandId: () => 'EXACT-UPPERCASE', readSession: async () => ({ subject: state.subject, csrfToken: state.csrf }),
    request: async (path: string, init: RequestInit) => {
      calls.push({ path, body: typeof init.body === 'string' ? init.body : undefined });
      if (state.deny) throw Object.assign(new Error('fictional denied'), { status: 403 });
      let result: unknown;
      if (path.endsWith('/review-queue-cancel')) {
        if (state.failCancel) throw Object.assign(new Error('fictional lost cancellation ACK'), { status: 503 });
        result = { outcome: 'cancelled', ticketId: ticket.ticketId, commandId: 'EXACT-UPPERCASE' };
      } else if (/\/review-queue(?:-status)?$/u.test(path)) result = state.terminal ? accepted : pending();
      else if (path.endsWith('/review')) result = accepted;
      else if (path.includes('/proposal?')) result = { ticketId: ticket.ticketId, intent,
        draft: { revision: { articleId: 'fictional-guide', title: 'PRIVATE_REVIEW_TITLE', content: { text: 'PRIVATE_REVIEW_BODY' } } } };
      else if (path.includes('/work?')) result = { ticketId: ticket.ticketId, sourceGeneration: 1,
        workGeneration: 2, status: 'awaiting_review', stage: 'kb_delivery', hasProposal: true };
      else result = { ticketId: ticket.ticketId, sourceGeneration: 1, resolutionCycle: 1, state: 'eligible', reconciliationPending: false };
      return { result, csrfToken: state.csrf };
    } });
  function control(action: string) {
    const value = root.all().find((node) => node.dataset.learningAction === action);
    if (value === undefined) throw new Error('Missing actual panel control');
    return value;
  }
  async function click(action: string) { control(action).fire('click'); await drain(); }
  async function proposal() {
    await panel.showTicket(ticket);
    expect(control('work').disabled, 'The actual source DTO must make work readable').toBe(false);
    await click('work');
    expect(control('proposal').disabled, 'The actual work DTO must make the proposal readable').toBe(false);
    await click('proposal');
    expect(control('approve').disabled, 'The checked proposal must be ready before a review intent is minted').toBe(false);
  }
  async function tick() {
    const entry = timers.entries().next().value;
    if (entry === undefined) throw new Error('Expected a bounded read-only poll');
    timers.delete(entry[0]); entry[1](); await drain();
  }
  return { panel, root, calls, timers, state, click, proposal, tick, control };
}

describe('staged learning review in the actual public panel', () => {
  it('retains a durable pending packet and polls only its exact status until terminal receipt', async () => {
    const f = fixture(); await f.proposal(); await f.click('approve');
    const original = f.calls.find((call) => call.path.endsWith('/review-queue'))!;
    expect(f.panel.hasPending()).toBe(true);
    expect(f.root.textContent).toContain('not a completed review');
    expect(f.root.textContent).not.toContain('PRIVATE_REVIEW_BODY');
    await f.tick(); expect(f.calls.at(-1)).toEqual({ path: original.path + '-status', body: original.body });
    expect(f.panel.hasPending()).toBe(true);
    f.state.terminal = true; await f.tick();
    expect(f.panel.hasPending()).toBe(false); expect(f.timers.size).toBe(0);
    expect(f.calls.filter((call) => call.path === original.path)).toHaveLength(1);
  });

  it('keeps cancellation sticky after lost ACK and never resends approval', async () => {
    const f = fixture(); await f.proposal(); await f.click('approve');
    const original = f.calls.at(-1)!; f.state.failCancel = true;
    await f.click('cancel-review'); expect(f.panel.hasPending()).toBe(true);
    expect(f.timers.size).toBe(0);
    f.state.failCancel = false; await f.panel.showTicket(ticket); await f.click('retry');
    expect(f.calls.at(-1)).toEqual({ path: original.path + '-cancel', body: original.body });
    expect(f.panel.hasPending()).toBe(false);
    expect(f.calls.filter((call) => call.path === original.path)).toHaveLength(1);
  });

  it('clears private state and polling on current denial while retaining exact original ownership', async () => {
    const f = fixture(); await f.proposal(); await f.click('approve'); const original = f.calls.at(-1)!;
    f.state.deny = true; await f.tick();
    expect(f.panel.hasPending()).toBe(true); expect(f.timers.size).toBe(0);
    expect(f.root.textContent).not.toContain('PRIVATE_REVIEW_TITLE');
    const count = f.calls.length; f.state.subject = 'fictional-reviewer-B'; f.state.deny = false;
    await f.panel.showTicket({ ...ticket, actorSubject: 'fictional-reviewer-B' }); await f.click('retry');
    expect(f.calls).toHaveLength(count);
    f.state.subject = actor; await f.panel.showTicket(ticket); await f.click('check-review');
    expect(f.calls.at(-1)).toEqual({ path: original.path + '-status', body: original.body });
  });

  it('bounds automatic polling and stops immediately when suspended or held', async () => {
    const f = fixture(); await f.proposal(); await f.click('approve');
    for (let index = 0; index < 10; index++) await f.tick();
    expect(f.timers.size).toBe(0); expect(f.panel.hasPending()).toBe(true);
    f.panel.suspend(); expect(f.timers.size).toBe(0);
    const held = fixture(); held.state.held = true; await held.proposal(); await held.click('approve');
    expect(held.timers.size).toBe(0); expect(held.panel.hasPending()).toBe(true);
    expect(held.root.textContent).toContain('held');
  });

  it('uses the original inline path when the trusted capability is false', async () => {
    const f = fixture(); f.state.enabled = false; await f.proposal(); await f.click('approve');
    expect(f.calls.at(-1)?.path).toMatch(/\/review$/u); expect(f.panel.hasPending()).toBe(false);
    expect(f.timers.size).toBe(0);
  });
});
