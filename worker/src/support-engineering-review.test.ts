import { describe, expect, it } from 'vitest';
import { SUPPORT_ROLE } from './support-access';
import { createSupportEngineeringRuntime } from './support-engineering';
import { createSupportEngineeringHandlers } from './support-engineering-handlers';
import { createSupportEngineeringRouter } from './support-engineering-router';
import {
  createSupportEngineeringHttpFixture, engineeringHttpObject, engineeringHttpResult,
} from './support-engineering-http-fixtures';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function prepared(linkExisting = false) {
  const f = await createSupportEngineeringHttpFixture();
  Object.assign(f.options, { reviewEnabled: () => true });
  await f.verified();
  if (linkExisting) {
    const id = f.engineering.metadata.keys().next().value;
    if (id === undefined) throw new Error('Actual configured repository missing');
    f.engineering.state.linkExisting = true;
    f.engineering.state.duplicates = [{ repositoryId: id, issueId: 'fictional-existing-42', issueNumber: 42,
      title: 'Workspace export loses rows', body: 'A fictional existing issue.' }];
  }
  const work = await f.prepared();
  const response = await f.send(f.request('proposal', undefined, 'staff', '?sourceGeneration=' + f.key().sourceGeneration));
  expect(response.status).toBe(200);
  const view = engineeringHttpResult(await engineeringHttpObject(response));
  if (typeof view.intent !== 'object' || view.intent === null) throw new Error('Expected minted SDK command');
  const packet = { intent: view.intent };
  return { f, work, view, packet };
}

describe('human engineering proposal view and exact public review command', () => {
  it('projects only the checked outbound request and mints a complete actor-bound original command', async () => {
    const { f, work, view } = await prepared();
    const proposal = work.proposal;
    if (proposal === undefined) throw new Error('Actual SDK proposal missing');
    expect(view).toMatchObject({ ticketId: work.ticketId, sourceGeneration: work.sourceGeneration,
      workGeneration: work.workGeneration, proposalHash: proposal.proposalHash, approvable: true, rejectionAvailable: true,
      request: { operation: proposal.request.operation, repository: { repositoryId: proposal.request.repository.repositoryId,
        owner: proposal.request.repository.owner, name: proposal.request.repository.name, visibility: proposal.request.repository.visibility },
        bundle: proposal.request.bundle },
      intent: { actorId: f.principals.staff, command: { ticketId: work.ticketId, sourceGeneration: work.sourceGeneration,
        expectedWorkGeneration: work.workGeneration, proposalHash: proposal.proposalHash, decision: 'approve' } } });
    const encoded = JSON.stringify(view);
    for (const privateName of ['installationBinding', 'metadataVersion', 'checksReceipt', 'checksBinding',
      'routingReceipt', 'routingBinding', 'candidate', 'evidence', 'product', 'modelAttempts'])
      expect(encoded).not.toContain(JSON.stringify(privateName) + ':');
    expect(encoded).not.toContain(proposal.checksReceipt);
    expect(encoded).not.toContain(proposal.request.repository.installationBinding);
    if (proposal.routingReceipt !== undefined) expect(encoded).not.toContain(proposal.routingReceipt);
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThanOrEqual(65536);
    expect(f.engineering.state.creates).toEqual([]);
  });

  it('shows the exact existing issue coordinates without creating an issue or linking automatically', async () => {
    const { f, view, work } = await prepared(true);
    expect(view.request).toMatchObject({ operation: 'link_existing_issue', issueId: 'fictional-existing-42', issueNumber: 42 });
    expect(work.approval).toBeUndefined(); expect(work.dispatch).toBeUndefined(); expect(f.engineering.state.creates).toEqual([]);
  });

  it('approves using only explicit read-only proof ports while generation remains OFF', async () => {
    const { f, work, packet } = await prepared();
    const priorCalls = f.engineering.state.modelCalls;
    const ports = f.engineering.ports;
    f.state.runtime = createSupportEngineeringRuntime({ application: f.engineering.application, clock: f.engineering.clock,
      staffAccess: { resolve: (id) => f.resolve(id) }, processingEnabled: () => false,
      reviewProofs: { serviceAccess: ports.serviceAccess,
        routing: { resolve: ports.routing.resolve, verify: ports.routing.verify },
        checks: { resolvePolicy: ports.checks.resolvePolicy, verify: ports.checks.verify },
        github: { getMetadata: ports.github.getMetadata } } });
    const response = await f.send(f.request('review', packet));
    expect(response.status).toBe(200);
    expect(engineeringHttpResult(await engineeringHttpObject(response))).toEqual({ ticketId: work.ticketId,
      sourceGeneration: work.sourceGeneration, workGeneration: work.workGeneration + 1, status: 'approved' });
    const accepted = await f.work();
    expect(accepted.approval).toMatchObject({ decision: 'approve', reviewedBy: f.principals.staff,
      proposalHash: work.proposal?.proposalHash });
    expect(accepted.dispatch).toBeUndefined();
    expect(f.engineering.state.modelCalls).toBe(priorCalls); expect(f.engineering.state.creates).toEqual([]);
    const rows = await f.rows();
    const replay = await f.send(f.request('review', packet)); expect(replay.status).toBe(200);
    expect(await f.rows()).toEqual(rows);
  });

  it('missing read-only proof composition holds new approval without model calls or mutations', async () => {
    const { f, packet } = await prepared(); const rows = await f.rows();
    const calls = f.engineering.state.modelCalls;
    f.state.runtime = createSupportEngineeringRuntime({ application: f.engineering.application, clock: f.engineering.clock,
      staffAccess: { resolve: (id) => f.resolve(id) }, processingEnabled: () => false });
    expect((await f.send(f.request('review', packet))).status).toBe(503);
    expect(await f.rows()).toEqual(rows); expect(f.engineering.state.modelCalls).toBe(calls);
    expect(f.engineering.state.creates).toEqual([]);
  });

  it.each(['source', 'policy', 'repository'] as const)('recovers the original committed review after lost HTTP ACK and %s drift', async (drift) => {
    const { f, work, packet } = await prepared();
    f.hooks.commit = async () => { f.state.enabled = false; throw new Error('Synthetic loss AFTER real commit'); };
    expect((await f.send(f.request('review', packet))).status).toBe(503);
    delete f.hooks.commit;
    const accepted = await f.work(); expect(accepted.status).toBe('approved');
    if (drift === 'source') await f.engineering.runtime.withdraw(f.engineering.actors.staff,
      { ticketId: work.ticketId, clientCommandId: 'AFTER-REVIEW-WITHDRAW', reason: 'privacy_withdrawal' });
    else if (drift === 'policy') await f.engineering.runtime.disableExports(f.engineering.actors.admin,
      { clientCommandId: 'AFTER-REVIEW-DISABLE', expectedGeneration: (await f.engineering.runtime.readPolicy(f.engineering.actors.admin)).generation });
    else { f.engineering.metadata.clear(); f.engineering.state.installationActive = false; }
    const rows = await f.rows(); const calls = f.engineering.state.modelCalls;
    f.state.enabled = true;
    // Receipt-first SDK recovery must not call any now-unavailable external fact.
    f.engineering.state.configuration = 'disabled'; f.engineering.state.checksReadable = false;
    const response = await f.send(f.request('review', packet)); expect(response.status).toBe(200);
    expect(engineeringHttpResult(await engineeringHttpObject(response))).toEqual({ ticketId: work.ticketId,
      sourceGeneration: work.sourceGeneration, workGeneration: work.workGeneration + 1, status: 'approved' });
    expect(await f.rows()).toEqual(rows); expect(f.engineering.state.modelCalls).toBe(calls);
    expect(f.engineering.state.creates).toEqual([]);
  });

  it.each(['session', 'role'] as const)('rejects new approval when %s is revoked during the real lazy proof guard', async (kind) => {
    const { f, packet } = await prepared(); const entered = deferred(); const release = deferred();
    const actual = f.engineering.ports; const rows = await f.rows();
    f.state.runtime = createSupportEngineeringRuntime({ application: f.engineering.application, clock: f.engineering.clock,
      staffAccess: { resolve: (id) => f.resolve(id) }, ports: { ...actual, routing: { ...actual.routing,
        async resolve(...args) { entered.resolve(); await release.promise; return actual.routing.resolve(...args); } } } });
    const response = f.send(f.request('review', packet));
    try {
      await entered.promise;
      if (kind === 'session') await f.destroy('staff'); else await f.revoke('staff', SUPPORT_ROLE);
    } finally { release.resolve(); }
    expect((await response).status).toBe(kind === 'session' ? 401 : 403);
    expect(await f.rows()).toEqual(rows); expect(f.engineering.state.creates).toEqual([]);
  });

  it('a never-accepted stale proposal is held, not silently rebuilt or presented as cancelled', async () => {
    const { f, work, packet } = await prepared();
    await f.engineering.runtime.withdraw(f.engineering.actors.staff,
      { ticketId: work.ticketId, clientCommandId: 'WITHDRAW-BEFORE-REVIEW', reason: 'privacy_withdrawal' });
    const rows = await f.rows();
    expect((await f.send(f.request('review', packet))).status).toBe(503);
    expect(await f.rows()).toEqual(rows); expect(f.engineering.state.creates).toEqual([]);
  });

  it('rejects through the current browser commit guard and replays the complete original command', async () => {
    const { f, packet } = await prepared();
    const rejected = structuredClone(packet);
    const value = rejected.intent;
    if (!('command' in value) || typeof value.command !== 'object' || value.command === null) throw new Error('Missing command');
    Object.assign(value.command, { decision: 'reject' });
    const response = await f.send(f.request('review', rejected));
    expect(response.status).toBe(200);
    expect((await f.work()).approval).toMatchObject({ decision: 'reject', reviewedBy: f.principals.staff });
    const rows = await f.rows();
    expect((await f.send(f.request('review', rejected))).status).toBe(200);
    expect(await f.rows()).toEqual(rows); expect(f.engineering.state.creates).toEqual([]);
  });

  it.each(['approve', 'reject'] as const)('refreshes the original browser at the actual Application %s commit guard', async (decision) => {
    const { f, packet } = await prepared(); const rows = await f.rows();
    const actual = f.engineering.application; let guardEntered = 0;
    const body = structuredClone(packet);
    if (typeof body.intent !== 'object' || body.intent === null || !('command' in body.intent) ||
      typeof body.intent.command !== 'object' || body.intent.command === null) throw new Error('Missing actual command');
    Object.assign(body.intent.command, { decision });
    f.state.runtime = createSupportEngineeringRuntime({ application: { ...actual,
      reviewEngineeringProposal(actor, command, guard) {
        return actual.reviewEngineeringProposal(actor, command, async () => {
          ++guardEntered; await f.destroy('staff'); return guard?.();
        });
      },
    }, clock: f.engineering.clock, staffAccess: { resolve: (id) => f.resolve(id) }, ports: f.engineering.ports });
    const response = await f.send(f.request('review', body));
    expect(guardEntered).toBeGreaterThan(0); expect(response.status).toBe(401);
    expect(await f.rows()).toEqual(rows); expect(f.engineering.state.creates).toEqual([]);
  });

  it('preserves the SDK synchronous proof assertion through the last Application handoff', async () => {
    const { f, packet } = await prepared(); const rows = await f.rows(); const actual = f.engineering.application;
    let assertions = 0;
    f.state.runtime = createSupportEngineeringRuntime({ application: { ...actual,
      reviewEngineeringProposal(actor, command, guard) {
        return actual.reviewEngineeringProposal(actor, command, async () => {
          const assertion = await guard?.();
          if (typeof assertion !== 'function') throw new Error('Expected genuine SDK final proof assertion');
          ++assertions; f.engineering.advance(3_600_001); return assertion;
        });
      },
    }, clock: f.engineering.clock, staffAccess: { resolve: (id) => f.resolve(id) }, ports: f.engineering.ports });
    expect((await f.send(f.request('review', packet))).status).toBe(503);
    expect(assertions).toBeGreaterThan(0); expect(await f.rows()).toEqual(rows);
    expect(f.engineering.state.creates).toEqual([]);
  });

  it('keeps human identity, CSRF, closed input, and current review grants on original receipt retry', async () => {
    const { f, packet } = await prepared(); const rows = await f.rows();
    expect((await f.send(f.request('review', { ...packet, source: {} }))).status).toBe(400);
    expect((await f.send(f.request('review', packet, 'peer'))).status).toBe(403);
    expect((await f.send(f.request('review', packet, 'knowledge'))).status).toBe(403);
    const missing = f.request('review', packet); missing.headers.delete('X-Pegma-CSRF');
    expect((await f.send(missing)).status).toBe(403);
    expect(await f.rows()).toEqual(rows);
    const accepted = await f.send(f.request('review', packet)); expect(accepted.status).toBe(200);
    await f.revoke('staff', SUPPORT_ROLE); const committed = await f.rows();
    expect((await f.send(f.request('review', packet))).status).toBe(403); expect(await f.rows()).toEqual(committed);
  });

  it('review admission is independently OFF and exceptions fail closed before runtime access', async () => {
    const { f, packet } = await prepared(); const rows = await f.rows(); const calls = f.state.runtimeCalls;
    Object.assign(f.options, { reviewEnabled: () => false });
    expect((await f.send(f.request('review', packet))).status).toBe(503);
    expect((await f.send(f.request('proposal', undefined, 'staff', '?sourceGeneration=' + f.key().sourceGeneration))).status).toBe(503);
    Object.assign(f.options, { reviewEnabled: () => { throw new Error('Synthetic flag outage'); } });
    expect((await f.send(f.request('review', packet))).status).toBe(503);
    expect(f.state.runtimeCalls).toBe(calls); expect(await f.rows()).toEqual(rows);
  });

  it('default-disabled router stays inert and never exposes processor or dispatch routes', async () => {
    const { f, packet } = await prepared(); const rows = await f.rows();
    expect((await createSupportEngineeringRouter()(f.request('review', packet)))?.status).toBe(404);
    const route = createSupportEngineeringRouter({ enabled: () => true, configuration: f.options });
    for (const excluded of ['process', 'dispatch', 'file'])
      expect((await route(f.request(excluded, packet)))?.status).toBe(404);
    expect(await createSupportEngineeringHandlers(f.options)(f.request('file', packet))).toBeNull();
    expect(await f.rows()).toEqual(rows); expect(f.engineering.state.creates).toEqual([]);
  });
});
