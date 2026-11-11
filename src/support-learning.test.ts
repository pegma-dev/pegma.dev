import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { BrowserNode, browserGate } from './test-support-browser';

// The same inert DOM guard used by existing public Support tests executes the
// actual module and event handlers. HTTP packets here are synthetic adapters;
// backend persistence/authorization and real-browser layout are separate proof.
interface Call { path: string; method: string; body?: string; headers: Headers; signal?: AbortSignal | null }
interface Ticket { ticketId: string; revision: number; actorSubject: string; status?: string; resolvedAt?: string }
interface Panel {
  showTicket(ticket: Ticket, mode?: { recoveryOnly?: boolean }): Promise<void>;
  refresh(): Promise<void>;
  suspend(): void;
  hasPending(): boolean;
  hasPendingReview(): boolean;
}
const ticket = { ticketId: 'ticket-example', revision: 7, actorSubject: 'synthetic-staff-A',
  status: 'resolved', resolvedAt: '2026-11-09T12:00:00.000Z' };
const hash = 'a'.repeat(64);
function intentFor() {
  return { reviewerId: ticket.actorSubject, ticketId: ticket.ticketId, sourceGeneration: 4, expectedWorkGeneration: 8,
    target: { articleId: 'fictional-guide', collectionId: 'fictional-collection', articleRevision: 1,
      contentHash: hash, sourceSnapshotGeneration: 1, sourceSnapshotHash: hash, orderedReferencesHash: hash },
    policy: { version: 'fixture-checks', binding: 'fixture-check-binding',
      verifiedAt: '2026-11-10T12:00:00.000Z', validUntil: '2026-11-10T13:00:00.000Z' } };
}
function failure(status: number, extra = {}) {
  return Object.assign(new Error('request_failed'), { status, ...extra });
}
async function drain() { for (let index = 0; index < 80; index++) await Promise.resolve(); }
async function until(check: () => boolean) {
  for (let index = 0; index < 500; index++) { if (check()) return; await Promise.resolve(); }
  throw new Error('Expected public learning event handler to settle.');
}
function fixture() {
  const root = new BrowserNode('section');
  const calls: Call[] = [];
  const lost: { status: number; hasPending: boolean }[] = [];
  const ownership: boolean[] = [];
  const state = {
    identity: { subject: ticket.actorSubject, csrfToken: 'synthetic-current-A' },
    time: 1_000,
    reviewHash: hash,
    workGeneration: 8,
    sourceState: 'eligible',
    sourceGeneration: 4,
    nextId: 0,
    handler: undefined as ((call: Call) => Promise<unknown>) | undefined,
  };
  const envelope = (result: unknown) => ({ result, csrfToken: state.identity.csrfToken });
  const intent = (id: string) => ({ reviewerId: state.identity.subject, ticketId: id,
    sourceGeneration: state.sourceGeneration, expectedWorkGeneration: state.workGeneration,
    target: { articleId: 'fictional-guide', collectionId: 'fictional-collection', articleRevision: 1,
      contentHash: state.reviewHash, sourceSnapshotGeneration: 1, sourceSnapshotHash: hash, orderedReferencesHash: hash },
    policy: { version: 'fixture-checks', binding: 'fixture-check-binding',
      verifiedAt: '2026-11-10T12:00:00.000Z', validUntil: '2026-11-10T13:00:00.000Z' } });
  function response(call: Call) {
    const id = decodeURIComponent(/\/tickets\/([^/]+)\/learning/u.exec(call.path)?.[1] ?? '');
    if (call.method === 'POST') {
      const packet = JSON.parse(call.body ?? '{}');
      if (call.path.endsWith('/review-cancel')) return envelope({ outcome: 'cancelled', ticketId: id, commandId: packet.commandId });
      const accepted = { ticketId: id, sourceGeneration: packet.intent?.sourceGeneration ?? state.sourceGeneration, resolutionCycle: 2, state: state.sourceState };
      return envelope(packet.intent ? { outcome: 'accepted', result: accepted } : accepted);
    }
    if (call.path.includes('/proposal?')) return envelope({
      ticketId: id, intent: intent(id),
      draft: { generation: 3, revision: {
        articleId: 'fictional-guide', collectionId: 'fictional-collection',
        title: '<img src=x onerror="PRIVATE_TITLE">', summary: 'Checked private draft.',
        content: { format: 'plain_text', text: '<script>PRIVATE_CHECKED_PROPOSAL</script>' },
        tags: ['fictional'], applicability: { productId: 'fictional', productVersion: '1' },
      } },
    });
    if (call.path.includes('/work?')) return envelope({ ticketId: id,
      sourceGeneration: state.sourceGeneration, workGeneration: state.workGeneration,
      status: 'awaiting_review', stage: 'kb_delivery', hasProposal: true });
    return envelope({ ticketId: id, sourceGeneration: state.sourceGeneration,
      resolutionCycle: 2, state: state.sourceState, reconciliationPending: false });
  }
  const request = vi.fn(async (path: string, init: RequestInit) => {
    const call: Call = { path, method: init.method ?? 'GET', body: typeof init.body === 'string' ? init.body : undefined,
      headers: new Headers(init.headers), signal: init.signal };
    calls.push(call);
    return state.handler ? state.handler(call) : response(call);
  });
  const readSession = vi.fn(async () => ({ ...state.identity }));
  const commandId = vi.fn(() => `EXACT-UpperCase-ID-${++state.nextId}`);
  const vm: Record<string, unknown> = { document: { createElement: (tag: string) => new BrowserNode(tag) }, AbortController };
  runInNewContext(readFileSync(new URL('../public/staff-support-learning.js', import.meta.url), 'utf8'), vm,
    { filename: 'staff-support-learning.js' });
  const factory = vm.PegmaSupportLearning as { createPanel(options: unknown): Panel };
  const panel = factory.createPanel({ root, request, readSession, commandId,
    now: () => state.time, onPendingChange: (value: boolean) => ownership.push(value),
    onAccessLost: (value: { status: number; hasPending: boolean }) => lost.push(value) });
  function node(key: string, field = false) {
    const found = root.all().find((value) => value.dataset[field ? 'learningField' : 'learningAction'] === key);
    if (!found) throw new Error('Missing actual learning control: ' + key);
    return found;
  }
  return { root, calls, state, response, envelope, request, readSession, commandId, panel, lost, ownership, node,
    writes: () => calls.filter((call) => call.method === 'POST'),
    async action(key: string) { node(key).fire('click'); await drain(); },
    async proposal() { await panel.showTicket(ticket); await this.action('work'); await this.action('proposal'); },
  };
}

describe('optional public staff learning panel', () => {
  it('retains a null receipt and makes cancellation retry sticky after its ACK is lost', async () => {
    const f = fixture(); await f.proposal();
    f.state.handler = async (call) => { if (call.method === 'POST') throw failure(503); return f.response(call); };
    await f.action('approve'); const original = f.writes()[0]!;
    await f.panel.showTicket(ticket, { recoveryOnly: true });
    f.state.handler = async (call) => call.path.endsWith('/review-receipt') ? f.envelope(null)
      : call.path.endsWith('/review-cancel') ? Promise.reject(failure(503)) : f.response(call);
    await f.action('check-review'); expect(f.panel.hasPending()).toBe(true);
    await f.action('cancel-review'); expect(f.panel.hasPending()).toBe(true);
    f.state.handler = undefined;
    await f.action('retry');
    expect(f.writes().map((call) => call.path.split('/').at(-1))).toEqual(['review', 'review-receipt', 'review-cancel', 'review-cancel']);
    expect(f.writes().every((call) => call.body === original.body)).toBe(true);
    expect(f.panel.hasPending()).toBe(false); expect(f.commandId).toHaveBeenCalledOnce();
  });

  it('registers no request until a current staff view is supplied and separates every private read', async () => {
    const f = fixture();
    expect(f.calls).toEqual([]);
    await f.panel.showTicket(ticket);
    expect(f.calls.map((call) => call.path)).toEqual(['/api/support/admin/tickets/ticket-example/learning']);
    expect(f.readSession).toHaveBeenCalledTimes(2);
    expect(f.node('proposal').disabled).toBe(true);
    await f.action('work');
    expect(f.calls.at(-1)?.path).toBe('/api/support/admin/tickets/ticket-example/learning/work?sourceGeneration=4');
    expect(f.node('proposal').disabled).toBe(false);
    expect(f.root.textContent).not.toContain('PRIVATE_CHECKED_PROPOSAL');
    await f.action('proposal');
    expect(f.calls.at(-1)?.path).toBe('/api/support/admin/tickets/ticket-example/learning/proposal?sourceGeneration=4');
    expect(f.root.textContent).toContain('<script>PRIVATE_CHECKED_PROPOSAL</script>');
    expect(f.root.all().some((node) => node.tagName === 'script' || node.tagName === 'img')).toBe(false);
    expect(f.writes()).toEqual([]);
  });

  it.each(['unverified', 'held'] as const)('accepts SDK %s source generation0 for initial evidence without allowing work or review', async (state) => {
    const f = fixture(); f.state.sourceGeneration = 0; f.state.sourceState = state;
    await f.panel.showTicket(ticket);
    expect(f.root.textContent).toContain('Source 0');
    expect(f.node('evidence').disabled).toBe(false);
    for (const action of ['work', 'proposal', 'approve', 'reject']) {
      expect(f.node(action).disabled).toBe(true);
      await f.action(action);
    }
    expect(f.calls.some((call) => /\/(work|proposal)\?/u.test(call.path))).toBe(false);
    f.node('solution', true).value = 'public-solution-message';
    f.node('verification', true).value = 'staff-verification-reference';
    await f.action('evidence');
    expect(f.writes()).toHaveLength(1);
    expect(f.panel.hasPending()).toBe(false);
    expect(JSON.parse(f.writes()[0]?.body ?? '{}')).toEqual({ commandId: 'EXACT-UpperCase-ID-1',
      expectedRevision: ticket.revision, resolutionCycle: 2,
      solutionMessageId: 'public-solution-message', verificationReference: 'staff-verification-reference' });
  });

  it('keeps an unknown generation0 enrollment pending through GET until its exact manual retry ACK', async () => {
    const f = fixture(); f.state.sourceGeneration = 0; f.state.sourceState = 'unverified';
    await f.panel.showTicket(ticket);
    f.state.handler = async (call) => { if (call.method === 'POST') throw failure(503); return f.response(call); };
    await f.action('enroll'); const first = f.writes()[0]!;
    expect(f.panel.hasPending()).toBe(true);
    await f.panel.refresh();
    expect(f.panel.hasPending()).toBe(true);
    expect(f.node('retry').disabled).toBe(false);
    expect(f.node('evidence').disabled).toBe(true);
    expect(f.writes()).toHaveLength(1);
    f.state.handler = undefined; await f.action('retry');
    expect(f.writes()[1]?.body).toBe(first.body);
    expect(f.panel.hasPending()).toBe(false);
    expect(f.commandId).toHaveBeenCalledOnce();
  });

  it.each(['open', 'missing-resolved-at', 'invalid-resolved-at', 'withdrawn'] as const)(
    'does not enable first evidence from %s metadata', async (variant) => {
      const f = fixture(); f.state.sourceGeneration = 0; f.state.sourceState = variant === 'withdrawn' ? 'withdrawn' : 'unverified';
      const bound: Ticket = variant === 'missing-resolved-at'
        ? { ticketId: ticket.ticketId, revision: ticket.revision, actorSubject: ticket.actorSubject, status: 'resolved' }
        : { ...ticket, ...(variant === 'open' ? { status: 'open' }
          : variant === 'invalid-resolved-at' ? { resolvedAt: 'not-a-timestamp' } : {}) };
      await f.panel.showTicket(bound);
      expect(f.node('evidence').disabled).toBe(true);
      await f.action('evidence'); expect(f.writes()).toEqual([]);
      expect(f.panel.hasPending()).toBe(false);
    },
  );

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])('still rejects invalid source counter %s', async (generation) => {
    const f = fixture(); f.state.sourceGeneration = generation; f.state.sourceState = 'unverified';
    await f.panel.showTicket(ticket);
    expect(f.node('enroll').disabled).toBe(true);
    expect(f.node('evidence').disabled).toBe(true);
    expect(f.node('work').disabled).toBe(true);
    expect(f.writes()).toEqual([]);
  });
  it.each(['enroll', 'evidence', 'approve', 'reject', 'withdraw', 'invalidate'] as const)(
    'sends the closed %s packet with an exact echoed intent and no added authority', async (action) => {
      const f = fixture();
      await f.proposal();
      f.node('solution', true).value = 'public-solution-message';
      f.node('verification', true).value = 'staff-verification-reference';
      f.node('review-reason', true).value = 'Reviewed the shown proposal.';
      await f.action(action);
      const post = f.writes()[0]!;
      expect(post.path).toBe(`/api/support/admin/tickets/ticket-example/learning/${action === 'approve' || action === 'reject' ? 'review' : action}`);
      const packet = JSON.parse(post.body ?? '{}');
      expect(packet.commandId).toBe('EXACT-UpperCase-ID-1');
      if (action === 'enroll') expect(packet).toEqual({ commandId: packet.commandId, expectedRevision: 7 });
      if (action === 'evidence') expect(packet).toEqual({ commandId: packet.commandId,
        expectedRevision: 7, resolutionCycle: 2, solutionMessageId: 'public-solution-message',
        verificationReference: 'staff-verification-reference' });
      if (action === 'approve' || action === 'reject') expect(packet).toEqual({
        commandId: packet.commandId, intent: intentFor(), decision: action, reason: 'Reviewed the shown proposal.' });
      if (action === 'withdraw') expect(packet).toEqual({ commandId: packet.commandId, reason: 'privacy_withdrawal' });
      if (action === 'invalidate') expect(packet).toEqual({ commandId: packet.commandId, reason: 'evidence_revoked' });
      for (const forbidden of ['target', 'provenance', 'actor', 'policyVersion', 'product', 'evidence', 'correlationId'])
        expect(packet).not.toHaveProperty(forbidden);
      expect(post.headers.get('X-Pegma-CSRF')).toBe('synthetic-current-A');
      expect(post.headers.get('Content-Type')).toBe('application/json');
      expect(f.panel.hasPending()).toBe(false);
      expect(f.ownership).toEqual([true, false]);
      expect(f.node('enroll').disabled).toBe(true);
      expect(f.root.textContent).not.toContain('PRIVATE_CHECKED_PROPOSAL');
      expect(f.writes()).toHaveLength(1);
    },
  );

  it.each([400, 401, 403, 404, 409, 429, 500, 503])(
    'retains an unknown mutation through HTTP%s and GET never acknowledges it', async (status) => {
      const f = fixture();
      f.state.handler = async (call) => { if (call.method === 'POST') throw failure(status); return f.response(call); };
      await f.panel.showTicket(ticket);
      await f.action('enroll');
      const first = f.writes()[0]!;
      expect(f.panel.hasPending()).toBe(true);
      expect(f.root.textContent).not.toContain('Source 4');
      await f.panel.refresh();
      expect(f.panel.hasPending()).toBe(true);
      expect(f.node('enroll').disabled).toBe(true);
      expect(f.writes()).toHaveLength(1);
      if (status === 401 || status === 403) expect(f.lost).toEqual([{ status, hasPending: true }]);
      f.state.time = 100_000;
      f.state.handler = undefined;
      await f.action('retry');
      expect(f.writes()[1]?.body).toBe(first.body);
      expect(f.writes()[1]?.path).toBe(first.path);
      expect(f.commandId).toHaveBeenCalledOnce();
      expect(f.panel.hasPending()).toBe(false);
    },
  );

  it('keeps the exact A-owned packet through account A to B to A and uses only fresh A credentials', async () => {
    const f = fixture();
    f.state.handler = async (call) => { if (call.method === 'POST') throw failure(503); return f.response(call); };
    await f.proposal();
    await f.action('approve');
    const original = f.writes()[0]!;
    f.state.identity = { subject: 'synthetic-staff-B', csrfToken: 'synthetic-current-B' };
    await f.panel.showTicket({ ...ticket, actorSubject: 'synthetic-staff-B' });
    await f.action('retry');
    expect(f.writes()).toHaveLength(1);
    expect(f.panel.hasPending()).toBe(true);
    expect(f.root.textContent).not.toContain('PRIVATE_CHECKED_PROPOSAL');
    expect(f.root.textContent).not.toContain('Source 4');
    f.state.identity = { subject: ticket.actorSubject, csrfToken: 'synthetic-fresh-A' };
    await f.panel.showTicket(ticket);
    f.state.handler = undefined;
    await f.action('retry');
    expect(f.writes()[1]?.body).toBe(original.body);
    expect(f.writes()[1]?.headers.get('X-Pegma-CSRF')).toBe('synthetic-fresh-A');
    expect(f.commandId).toHaveBeenCalledOnce();
  });

  it('retains ticket A ownership through ticket A to B to A without sending under B', async () => {
    const f = fixture();
    f.state.handler = async (call) => { if (call.method === 'POST') throw failure(503); return f.response(call); };
    await f.panel.showTicket(ticket); await f.action('enroll');
    const original = f.writes()[0]!;
    await f.panel.showTicket({ ...ticket, ticketId: 'another-ticket' });
    await f.action('retry');
    expect(f.writes()).toHaveLength(1);
    expect(f.calls.some((call) => call.path.includes('/another-ticket/'))).toBe(false);
    await f.panel.showTicket(ticket);
    f.state.handler = undefined;
    await f.action('retry');
    expect(f.writes()[1]?.body).toBe(original.body);
    expect(f.writes()[1]?.path).toBe(original.path);
  });

  it('immediately clears private DOM and fields on sign-out while retaining an unknown command', async () => {
    const f = fixture();
    await f.proposal();
    f.node('verification', true).value = 'PRIVATE_UNSENT_REFERENCE';
    f.state.handler = async (call) => { if (call.method === 'POST') throw failure(503); return f.response(call); };
    await f.action('approve');
    f.panel.suspend();
    expect(f.panel.hasPending()).toBe(true);
    expect(f.root.textContent).not.toContain('PRIVATE_CHECKED_PROPOSAL');
    expect(f.node('verification', true).value).toBe('');
    expect(f.node('retry').disabled).toBe(true);
    expect(f.node('refresh').disabled).toBe(true);
  });

  it('does not consume a command ID or hold a phantom packet for locally invalid evidence', async () => {
    const f = fixture(); await f.panel.showTicket(ticket);
    f.node('solution', true).value = 'solution';
    f.node('verification', true).value = 'bad\u009breference';
    await f.action('evidence');
    expect(f.writes()).toEqual([]);
    expect(f.panel.hasPending()).toBe(false);
    expect(f.commandId).not.toHaveBeenCalled();
    f.node('verification', true).value = 'valid-reference';
    await f.action('evidence');
    expect(f.writes()).toHaveLength(1);
  });

  it('does not send if the current actor or session changes before submission', async () => {
    const f = fixture(); await f.panel.showTicket(ticket);
    f.state.identity = { subject: ticket.actorSubject, csrfToken: 'rotated-session' };
    await f.action('enroll');
    expect(f.writes()).toEqual([]);
    expect(f.panel.hasPending()).toBe(false);
    expect(f.lost).toEqual([{ status: 401, hasPending: false }]);
    expect(f.root.textContent).not.toContain('Source 4');
  });

  it('keeps an ACK unknown when the closing session changes, then retries the exact packet', async () => {
    const f = fixture(); await f.panel.showTicket(ticket);
    f.state.handler = async (call) => {
      if (call.method !== 'POST') return f.response(call);
      const ack = f.response(call);
      f.state.identity = { subject: 'synthetic-staff-B', csrfToken: 'new-cookie' };
      return ack;
    };
    await f.action('enroll');
    const first = f.writes()[0]!;
    expect(f.panel.hasPending()).toBe(true);
    f.state.identity = { subject: ticket.actorSubject, csrfToken: 'fresh-owner-session' };
    f.state.handler = undefined;
    await f.panel.showTicket(ticket);
    expect(f.panel.hasPending()).toBe(true);
    await f.action('retry');
    expect(f.writes()[1]?.body).toBe(first.body);
    expect(f.panel.hasPending()).toBe(false);
  });

  it.each(['csrf', 'missing-result', 'invalid-result'])(
    'does not settle a mutation from a malformed %s acknowledgment', async (kind) => {
      const f = fixture(); await f.panel.showTicket(ticket);
      f.state.handler = async () => kind === 'csrf' ? { result: {}, csrfToken: 'wrong' }
        : kind === 'missing-result' ? { csrfToken: f.state.identity.csrfToken }
          : f.envelope(null);
      await f.action('enroll');
      expect(f.panel.hasPending()).toBe(true);
      expect(f.ownership).toEqual([true]);
      expect(f.root.textContent).not.toContain('Source 4');
    },
  );

  it('never rebinds an unknown review to a later GET proposal or invents a new command ID', async () => {
    const f = fixture(); await f.proposal();
    f.state.handler = async (call) => { if (call.method === 'POST') throw failure(409); return f.response(call); };
    await f.action('reject');
    const first = f.writes()[0]!;
    f.state.reviewHash = 'b'.repeat(64); f.state.workGeneration = 9;
    await f.panel.refresh(); await f.action('work'); await f.action('proposal');
    expect(f.panel.hasPending()).toBe(true);
    expect(f.node('approve').disabled).toBe(true);
    await f.action('retry');
    expect(f.writes()[1]?.body).toBe(first.body);
    expect(JSON.parse(f.writes()[1]?.body ?? '{}').intent.target.contentHash).toBe(hash);
    expect(JSON.parse(f.writes()[1]?.body ?? '{}').intent.expectedWorkGeneration).toBe(8);
    expect(f.commandId).toHaveBeenCalledOnce();
  });

  it('does not infer KB access after a proposal denial or continue to a review', async () => {
    const f = fixture(); await f.panel.showTicket(ticket); await f.action('work');
    f.state.handler = async (call) => { if (call.path.includes('/proposal?')) throw failure(403); return f.response(call); };
    await f.action('proposal'); await f.action('approve');
    expect(f.writes()).toEqual([]);
    expect(f.root.textContent).not.toContain('PRIVATE_CHECKED_PROPOSAL');
    expect(f.root.textContent).not.toContain('Source 4');
    expect(f.lost).toEqual([{ status: 403, hasPending: false }]);
    expect(f.calls.some((call) => /roles|policy|permissions/u.test(call.path))).toBe(false);
  });

  it('allows explicit enrollment after a source 404 without treating that read as an ACK', async () => {
    const f = fixture();
    f.state.handler = async (call) => { if (call.method === 'GET') throw failure(404); return f.response(call); };
    await f.panel.showTicket(ticket);
    expect(f.node('enroll').disabled).toBe(false);
    expect(f.node('evidence').disabled).toBe(true);
    await f.action('enroll');
    expect(f.writes()).toHaveLength(1);
    expect(f.panel.hasPending()).toBe(false);
  });

  it('discards a delayed private proposal after suspension even when the request ignores abort', async () => {
    const f = fixture(); await f.panel.showTicket(ticket); await f.action('work');
    const gate = browserGate<unknown>();
    f.state.handler = async (call) => call.path.includes('/proposal?') ? gate.promise : f.response(call);
    f.node('proposal').fire('click');
    await until(() => f.calls.some((call) => call.path.includes('/proposal?')));
    const call = f.calls.at(-1)!;
    f.panel.suspend();
    expect(call.signal?.aborted).toBe(true);
    gate.resolve(f.response(call)); await drain();
    expect(f.root.textContent).not.toContain('PRIVATE_CHECKED_PROPOSAL');
    expect(f.node('approve').disabled).toBe(true);
  });

  it('discards a delayed mutation ACK after sign-out and retains the packet for its owner', async () => {
    const f = fixture(); await f.panel.showTicket(ticket);
    const gate = browserGate<unknown>();
    f.state.handler = async (call) => call.method === 'POST' ? gate.promise : f.response(call);
    f.node('enroll').fire('click'); await until(() => f.writes().length === 1);
    const original = f.writes()[0]!;
    f.panel.suspend();
    gate.resolve(f.response(original)); await drain();
    expect(f.panel.hasPending()).toBe(true);
    expect(f.ownership).toEqual([true]);
    f.state.handler = undefined;
    await f.panel.showTicket(ticket); await f.action('retry');
    expect(f.writes()[1]?.body).toBe(original.body);
    expect(f.panel.hasPending()).toBe(false);
  });

  it('does not overlap writes or automatically retry while a mutation is pending', async () => {
    const f = fixture(); await f.panel.showTicket(ticket);
    const gate = browserGate<unknown>();
    f.state.handler = async (call) => call.method === 'POST' ? gate.promise : f.response(call);
    f.node('enroll').fire('click'); f.node('withdraw').fire('click');
    await until(() => f.writes().length === 1);
    await drain(); expect(f.writes()).toHaveLength(1);
    gate.reject(new Error('Synthetic request deadline')); await drain();
    expect(f.panel.hasPending()).toBe(true);
    expect(f.writes()).toHaveLength(1);
  });

  it('respects the injected existing Retry-After deadline without an automatic retry', async () => {
    const f = fixture(); await f.panel.showTicket(ticket);
    f.state.handler = async (call) => { if (call.method === 'POST') throw failure(429, { retryAt: 9_000 }); return f.response(call); };
    await f.action('enroll'); await f.panel.refresh(); await f.action('retry');
    expect(f.writes()).toHaveLength(1);
    f.state.time = 9_000; f.state.handler = undefined;
    await f.action('retry'); expect(f.writes()).toHaveLength(2);
    expect(f.writes()[1]?.body).toBe(f.writes()[0]?.body);
  });

  it.each(['ticket', 'generation', 'hash', 'draft'])(
    'never enables review for a malformed proposal %s', async (kind) => {
      const f = fixture(); await f.panel.showTicket(ticket); await f.action('work');
      f.state.handler = async (call) => {
        const response = f.response(call) as { result: Record<string, unknown>; csrfToken: string };
        if (call.path.includes('/proposal?')) {
          if (kind === 'ticket') response.result.ticketId = 'another-ticket';
          if (kind === 'generation') (response.result.intent as Record<string, unknown>).sourceGeneration = 99;
          if (kind === 'hash') ((response.result.intent as Record<string, unknown>).target as Record<string, unknown>).contentHash = 'forged';
          if (kind === 'draft') response.result.draft = { revision: { title: 'Incomplete' } };
        }
        return response;
      };
      await f.action('proposal'); await f.action('approve');
      expect(f.writes()).toEqual([]);
      expect(f.node('approve').disabled).toBe(true);
      expect(f.root.textContent).not.toContain('PRIVATE_CHECKED_PROPOSAL');
    },
  );
});
