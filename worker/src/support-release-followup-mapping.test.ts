import { describe, expect, it } from 'vitest';
import { createSupportReleaseFollowupFixture } from './support-release-followup-fixtures';
import { createSupportRuntime } from './support-desk';
import { createAgentPrincipalResolver } from './agent-authority';
import {
  componentReleaseCollection,
  componentReleaseKey,
} from './component-release';
import {
  createSupportFollowupMappings,
  supportFollowupMappings,
  type VerifySupportFollowupMappingInput,
} from './support-release-followup-mapping';
import { recordSupportFollowupRelease } from './support-release-followup-releases';
import { supportReleaseFollowupApplicationOptions } from './support-release-followup-ports';
import type { Store } from '@pegma/storage-core';

async function fixture(fault?: 'lost_ack') {
  const f = await createSupportReleaseFollowupFixture();
  const resolved = await f.f.resolve(f.f.principals.staff);
  if (!resolved) throw new Error('Actual current staff required');
  const access = resolved;
  let throwAck = fault === 'lost_ack';
  const store: Store = fault
    ? {
        collection(definition) {
          const actual = f.host.store.collection(definition);
          if (definition.name !== supportFollowupMappings.name) return actual;
          return {
            ...actual,
            async transact(partition, actions) {
              const accepted = await actual.transact(partition, actions);
              if (accepted.committed && throwAck) {
                throwAck = false;
                throw new Error('Fictional lost committed ACK');
              }
              return accepted;
            },
          };
        },
      }
    : f.host.store;
  const release = {
    repositoryId: f.identity.association.repositoryId,
    repositoryName: 'support-desk',
    releaseId: '9001',
    tagName: 'v2.3.1',
    publishedAt: f.clock.now(),
    observedAt: f.clock.now(),
    releaseUrl: 'https://github.com/pegma-dev/support-desk/releases/tag/v2.3.1',
  };
  await store.collection(componentReleaseCollection()).put(release);
  await recordSupportFollowupRelease(store, release.repositoryId);
  let host = f.host;
  const state = { enabled: true };
  const mappings = createSupportFollowupMappings({
    store,
    clock: f.clock,
    application: () => host.application,
    resolvePrincipal: createAgentPrincipalResolver(f.f.options),
    allowedRepositoryIds: () => new Set([release.repositoryId]),
    enabled: () => state.enabled,
  });
  const configured = {
    enabled: () => state.enabled,
    configuration: {
      ...f.configured,
      releaseEvidence: mappings.releaseEvidence,
    },
  };
  host = createSupportRuntime({
    store,
    clock: f.clock,
    identity: f.f.identity,
    sessions: f.f.sessions,
    identityLinkFromClaims: f.f.options.identityLinkFromClaims,
    logger: f.f.options.logger,
    engineeringFollowup: supportReleaseFollowupApplicationOptions(configured),
  });
  const context = {
    current: async () => {
      const current = await f.f.resolve(access.principalId);
      if (!current) throw new Error('Actual staff unavailable');
      return current;
    },
    assertCurrent() {},
    signal: new AbortController().signal,
  };
  const ticket = await host.application.readStaffTicket(
    access,
    f.identity.ticketId,
  );
  const product = (
    await host.application.readEngineeringSource(access, f.identity.ticketId)
  ).product!;
  const packet: VerifySupportFollowupMappingInput = {
    commandId: crypto.randomUUID(),
    expectedPrincipalId: access.principalId,
    expectedTicketRevision: ticket.ticket.revision,
    expectedMappingGeneration: 0,
    ...f.identity.association,
    releaseRef: release.releaseId,
    issueState: 'closed',
    deploymentState: 'deployed',
    fixedProduct: {
      productId: product.productId,
      version: '2.3.1',
      buildId: 'fixed-build',
    },
    deploymentId: 'deployment-1',
    deploymentEpoch: 'epoch-1',
    scopeRef: 'fictional-deployed-product',
    verificationReference: 'explicit-staff-deployment-verification',
    publicFacts: [
      {
        reference: 'release-fact',
        text: 'The deployed fix preserves export rows.',
      },
    ],
  };
  async function observe(reference: string) {
    return host.application.observeEngineeringFollowup(access, {
      ...f.identity,
      commandId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      inputReference: reference,
    });
  }
  return {
    f,
    store,
    host,
    mappings,
    state,
    access,
    context,
    release,
    packet,
    observe,
  };
}

describe('real staff-verified durable release/deployment mapping', () => {
  it('binds an actual accepted association and authenticated-projection facts before SDK observation with models OFF', async () => {
    const f = await fixture();
    const choices = await f.mappings.choices(f.context, f.f.identity.ticketId);
    expect(choices.choices).toMatchObject([
      {
        repositoryId: f.packet.repositoryId,
        issueId: f.packet.issueId,
        product: { productId: f.packet.fixedProduct.productId },
      },
    ]);
    const ack = await f.mappings.verify(
      f.context,
      f.f.identity.ticketId,
      f.packet,
    );
    expect(ack).toMatchObject({
      actorId: f.access.principalId,
      mappingGeneration: 1,
      inputReference: expect.stringMatching(/^pgfix1\.[a-f0-9]{64}\.1$/u),
    });
    const observed = await f.observe(ack.inputReference);
    expect(observed.outcome).toBe('queued');
    expect(observed.workId).toBeDefined();
    expect(f.f.state.modelCalls).toBe(0);
    const rows = await f.store
      .collection(supportFollowupMappings)
      .list(f.f.identity.ticketId);
    expect(rows.map((row) => row.kind).sort()).toEqual([
      'audit',
      'mapping',
      'receipt',
    ]);
    expect(rows.find((row) => row.kind === 'audit')).toMatchObject({
      event: {
        actor: { kind: 'principal', principalId: f.access.principalId },
        action: 'support.release_followup.mapping.verified',
        sequence: 1,
      },
    });
  });
  it('recovers the exact atomic mapping receipt after lost ACK and refuses changed content or actor reuse', async () => {
    const f = await fixture('lost_ack');
    const ack = await f.mappings.verify(
      f.context,
      f.f.identity.ticketId,
      f.packet,
    );
    expect(
      await f.mappings.verify(f.context, f.f.identity.ticketId, f.packet),
    ).toEqual(ack);
    await expect(
      f.mappings.verify(f.context, f.f.identity.ticketId, {
        ...f.packet,
        scopeRef: 'changed',
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      f.mappings.verify(f.context, f.f.identity.ticketId, {
        ...f.packet,
        expectedPrincipalId: 'another-actor',
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await f.store
        .collection(supportFollowupMappings)
        .list(f.f.identity.ticketId),
    ).toHaveLength(3);
  });
  it('never interprets issue closure alone or an unaccepted association as deployed availability', async () => {
    const f = await fixture();
    await expect(
      f.mappings.verify(f.context, f.f.identity.ticketId, {
        ...f.packet,
        issueId: 'unknown-issue',
      }),
    ).rejects.toMatchObject({ status: 409 });
    const closed = await f.mappings.verify(f.context, f.f.identity.ticketId, {
      ...f.packet,
      deploymentState: 'unknown',
    });
    expect(await f.observe(closed.inputReference)).toMatchObject({
      outcome: 'held',
    });
    expect(f.f.state.modelCalls).toBe(0);
  });
  it('holds a withdrawn release and never revives an old mapping after identical republication', async () => {
    const f = await fixture();
    const ack = await f.mappings.verify(
      f.context,
      f.f.identity.ticketId,
      f.packet,
    );
    expect((await f.observe(ack.inputReference)).outcome).toBe('queued');
    const releases = f.store.collection(componentReleaseCollection());
    await releases.delete(componentReleaseKey(f.release.repositoryId));
    await recordSupportFollowupRelease(f.store, f.release.repositoryId);
    expect(await f.observe(ack.inputReference)).toMatchObject({
      outcome: 'held',
    });
    await releases.put({ ...f.release, observedAt: f.f.clock.now() });
    await recordSupportFollowupRelease(f.store, f.release.repositoryId);
    expect(await f.observe(ack.inputReference)).toMatchObject({
      outcome: 'held',
    });
    const current = await f.mappings.read(
      f.context,
      f.f.identity.ticketId,
      f.packet.repositoryId,
      f.packet.issueId,
    );
    expect(current.mapping?.current).toBe(false);
    expect(f.f.state.modelCalls).toBe(0);
  });
  it('keeps unchanged reconciliation refreshes current and holds explicit rollback or mapping withdrawal', async () => {
    const f = await fixture();
    const ack = await f.mappings.verify(
      f.context,
      f.f.identity.ticketId,
      f.packet,
    );
    expect((await f.observe(ack.inputReference)).outcome).toBe('queued');
    await f.store.collection(componentReleaseCollection()).put({
      ...f.release,
      observedAt: new Date(Date.now() + 1000).toISOString(),
    });
    await recordSupportFollowupRelease(f.store, f.release.repositoryId);
    expect(
      (
        await f.mappings.read(
          f.context,
          f.f.identity.ticketId,
          f.packet.repositoryId,
          f.packet.issueId,
        )
      ).mapping?.current,
    ).toBe(true);
    const rolled = await f.mappings.verify(f.context, f.f.identity.ticketId, {
      ...f.packet,
      commandId: crypto.randomUUID(),
      expectedMappingGeneration: 1,
      deploymentState: 'rolled_back',
    });
    expect(await f.observe(rolled.inputReference)).toMatchObject({
      outcome: 'held',
    });
    const withdrawn = await f.mappings.withdraw(
      f.context,
      f.f.identity.ticketId,
      {
        commandId: crypto.randomUUID(),
        expectedPrincipalId: f.access.principalId,
        expectedTicketRevision: f.packet.expectedTicketRevision,
        expectedMappingGeneration: 2,
        repositoryId: f.packet.repositoryId,
        issueId: f.packet.issueId,
        reason: 'Staff withdrew the deployment mapping.',
      },
    );
    expect(await f.observe(withdrawn.inputReference)).toMatchObject({
      outcome: 'held',
    });
    expect(f.f.state.modelCalls).toBe(0);
  });
});
