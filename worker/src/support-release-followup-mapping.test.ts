import { describe, expect, it, vi } from 'vitest';
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

const SUPPORT_FOLLOWUP_MAPPING_VERIFICATION_MS = 3600000;

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
  it('permits minute-staged reads inside one hour without renewing the original staff verification', async () => {
    const f = await fixture();
    let now = Date.parse(f.f.clock.now());
    const started = now;
    const clock = vi.spyOn(f.f.clock, 'now').mockImplementation(() => new Date(now).toISOString());
    const verify = vi.spyOn(f.mappings.releaseEvidence, 'verifyInput');
    try {
      const ack = await f.mappings.verify(f.context, f.f.identity.ticketId, f.packet);
      expect((await f.observe(ack.inputReference)).outcome).toBe('queued');
      const proof = verify.mock.calls[0]![1];
      for (const minute of [1, 5, 15, 30, 59]) {
        now = started + minute * 60000;
        const observed = await f.mappings.releaseEvidence.verifyInput(ack.inputReference, proof, f.context.signal);
        expect(observed).not.toBeNull();
        expect(Date.parse(observed!.attestation.validUntil)).toBeLessThanOrEqual(started + SUPPORT_FOLLOWUP_MAPPING_VERIFICATION_MS);
        expect(Date.parse(observed!.attestation.validUntil)).toBeLessThanOrEqual(now + 300000);
      }
      now = started + SUPPORT_FOLLOWUP_MAPPING_VERIFICATION_MS;
      expect(await f.mappings.releaseEvidence.verifyInput(ack.inputReference, proof, f.context.signal)).toBeNull();
      expect((await f.mappings.read(f.context, f.f.identity.ticketId, f.packet.repositoryId, f.packet.issueId)).mapping).toMatchObject({ current: false, verificationValidUntil: new Date(now).toISOString() });
      // Recovering an already accepted command is not an instruction to renew.
      expect(await f.mappings.verify(f.context, f.f.identity.ticketId, f.packet)).toEqual(ack);
      expect(await f.mappings.releaseEvidence.verifyInput(ack.inputReference, proof, f.context.signal)).toBeNull();
      const ticket = await f.host.application.readStaffTicket(f.access, f.f.identity.ticketId);
      const renewed = await f.mappings.verify(f.context, f.f.identity.ticketId, {
        ...f.packet, commandId: crypto.randomUUID(), expectedMappingGeneration: ack.mappingGeneration,
        expectedTicketRevision: ticket.ticket.revision,
      });
      expect(renewed.mappingGeneration).toBe(ack.mappingGeneration + 1);
      expect(await f.mappings.releaseEvidence.verifyInput(ack.inputReference, proof, f.context.signal)).toBeNull();
      expect(await f.mappings.releaseEvidence.verifyInput(renewed.inputReference, proof, f.context.signal)).not.toBeNull();
      expect((await f.mappings.read(f.context, f.f.identity.ticketId, f.packet.repositoryId, f.packet.issueId)).mapping?.current).toBe(true);
      expect(f.f.state.modelCalls).toBe(0);
    } finally {
      verify.mockRestore(); clock.mockRestore();
    }
  });

  it('refuses original verification expiry during the closing asynchronous proof reads', async () => {
    const f = await fixture();
    let now = Date.parse(f.f.clock.now());
    const started = now;
    const clock = vi.spyOn(f.f.clock, 'now').mockImplementation(() => new Date(now).toISOString());
    const verify = vi.spyOn(f.mappings.releaseEvidence, 'verifyInput');
    const original = crypto.subtle.digest.bind(crypto.subtle);
    let expire = false;
    const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
      const result = await original(algorithm, data);
      if (expire) now = started + SUPPORT_FOLLOWUP_MAPPING_VERIFICATION_MS;
      return result;
    });
    try {
      const ack = await f.mappings.verify(f.context, f.f.identity.ticketId, f.packet);
      await f.observe(ack.inputReference);
      const proof = verify.mock.calls[0]![1];
      now = started + SUPPORT_FOLLOWUP_MAPPING_VERIFICATION_MS - 1;
      expire = true;
      expect(await f.mappings.releaseEvidence.verifyInput(ack.inputReference, proof, f.context.signal)).toBeNull();
    } finally {
      digest.mockRestore(); verify.mockRestore(); clock.mockRestore();
    }
  });
  it('keeps legacy journal mappings unapproved until explicit current staff verification', async () => {
    const f = await fixture();
    const original = await f.mappings.verify(
      f.context,
      f.f.identity.ticketId,
      f.packet,
    );
    const records = f.store.collection(supportFollowupMappings);
    const head = (await records.list(f.f.identity.ticketId)).find(
      (row) => row.kind === 'mapping',
    );
    if (head?.kind !== 'mapping')
      throw new Error('Actual host mapping required');
    const { releaseJournalVersion: _version, ...legacy } = head;
    await records.put(legacy);
    expect(
      (
        await f.mappings.read(
          f.context,
          f.f.identity.ticketId,
          f.packet.repositoryId,
          f.packet.issueId,
        )
      ).mapping?.current,
    ).toBe(false);
    expect(await f.observe(original.inputReference)).toMatchObject({
      outcome: 'held',
    });
    const ticket = await f.host.application.readStaffTicket(
      f.access,
      f.f.identity.ticketId,
    );
    const verified = await f.mappings.verify(f.context, f.f.identity.ticketId, {
      ...f.packet,
      commandId: crypto.randomUUID(),
      expectedTicketRevision: ticket.ticket.revision,
      expectedMappingGeneration: original.mappingGeneration,
    });
    expect(verified.mappingGeneration).toBe(original.mappingGeneration + 1);
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
    expect(f.f.state.modelCalls).toBe(0);
  });

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
