import { describe, expect, it, vi } from 'vitest';
import { changeAnsweringContact, supportAnsweringFixture } from './support-answering-fixtures';
import { supportPermissions } from '@pegma/support-desk-application';
import { resolveAccess } from '@pegma/authorization-core';
import { createSupportAnsweringIngress } from './support-assistant-ingress';
import {
  composeSupportAnswering,
  supportAnsweringTurns,
  supportAnsweringEnabled,
} from './support-assistant-composition';
import { createSupportRuntime } from './support-desk';
import { createSupportRequestHandler, createWorker } from './index';
import { controlledHumanBody } from './support-human-control-fixtures';
import { APPLICATION_SCOPE } from './support-access';
import { assistantGate } from './support-assistant-fixtures';

describe('current public SDK receipt-first customer answering ingress', () => {
  it('keeps the default root absent before production dependencies and exposes no manual fallback route', async () => {
    const handler = createSupportRequestHandler(
      {} as Parameters<typeof createSupportRequestHandler>[0],
      { log() {} },
    );
    for (const path of ['capability', 'tickets', 'dispatch']) {
      const response = await handler(
        new Request('https://pegma.dev/api/support/assistant/' + path),
      );
      expect(response.status).toBe(404);
    }
    expect(createWorker).toBeTypeOf('function');
    const reduced = { configuration: { turns: { maxAttempts: 1 } } } as Parameters<
      typeof supportAnsweringTurns
    >[0];
    expect(supportAnsweringTurns(reduced)).toEqual({ maxAttempts: 1 });
    expect(supportAnsweringEnabled(reduced)).toBe(false);
  });

  it('admits one real assistant ticket with an exact disclosed packet and no model/key use', async () => {
    const f = await supportAnsweringFixture();
    expect(await (await f.ingress()(f.request())).json()).toMatchObject({
      enabled: true,
      disclosureVersion: 'pegma-support-answering-1',
    });
    const packet = f.packet();
    const response = await f.ingress()(f.request(packet));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      initialMode: 'assistant',
      ticket: { id: packet.command.ticketId, handling: 'assistant' },
    });
    const service = resolveAccess(
      { principalId: 'fictional-inspector' },
      { version: 'fixture', defaults: [supportPermissions.assistantRead] },
    );
    const page = await f.runtime.application.scanAssistantTurnCandidates(service, { limit: 100 });
    expect(page.candidates).toHaveLength(1);
    expect(f.state.keys).toBe(0);
    expect(f.state.calls).toBe(0);
  });

  it('withholds a stale capability after real qualification-role revocation before closing browser resolution', async () => {
    const f = await supportAnsweringFixture();
    const configuration = f.composition.configuration;
    if (!configuration) throw new Error('Actual source composition required.');
    const role = 'FictionalAnsweringQualification';
    const composition = {
      ...f.composition,
      configuration: {
        ...configuration,
        customerPolicy: {
          ...configuration.customerPolicy,
          defaults: configuration.customerPolicy.defaults?.filter(
            (permission) => permission !== supportPermissions.assistantStart,
          ),
          roles: {
            ...configuration.customerPolicy.roles,
            [role]: [supportPermissions.assistantStart],
          },
        },
      },
    };
    const id = 'fictional-capability-qualification';
    await f.runtime.roleStore.grantRoleAssignmentWithAudit({
      assignment: {
        id,
        principalId: f.human.principals.owner,
        role,
        scope: APPLICATION_SCOPE,
        grantedBy: { kind: 'system', systemId: 'fictional-setup' },
        grantedAtEpochMs: Date.now(),
        status: 'active',
      },
      auditEventId: crypto.randomUUID(),
    });
    const answering = composeSupportAnswering(f.runtime, f.logger, composition, () => true);
    const ingress = createSupportAnsweringIngress(f.runtime, f.logger, {
      ...answering,
      async admission(principalId) {
        const available = await answering.admission(principalId);
        expect(available).not.toBeNull();
        const found = await f.runtime.roleStore.getRoleAssignment(id);
        if (!found) throw new Error('Real qualification assignment required.');
        await f.runtime.roleStore.revokeRoleAssignmentWithAudit({
          assignmentId: id,
          expectedConcurrencyToken: found.concurrencyToken,
          revokedBy: { kind: 'system', systemId: 'fictional-revocation' },
          revokedAtEpochMs: Date.now(),
          auditEventId: crypto.randomUUID(),
        });
        return available;
      },
    });
    const response = await ingress(f.request());
    expect(response.status).toBe(503);
    expect(await response.json()).not.toHaveProperty('enabled');
    expect(f.state.calls).toBe(0);
    expect(f.state.keys).toBe(0);
  });

  it('uses a distinct physical request correlation for unexpected intake failures', async () => {
    const f = await supportAnsweringFixture();
    const runtime = {
      ...f.runtime,
      application: {
        ...f.runtime.application,
        async createAdmittedCustomerTicket() {
          throw new Error('FICTIONAL_PRIVATE_FAILURE');
        },
      },
    };
    const ingress = createSupportAnsweringIngress(runtime, f.logger, f.answering());
    const first = await ingress(f.request(f.packet()));
    const second = await ingress(f.request(f.packet()));
    expect(first.status).toBe(503);
    expect(second.status).toBe(503);
    const a = (await first.json()) as { correlationId: string };
    const b = (await second.json()) as { correlationId: string };
    expect(a.correlationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(b.correlationId).not.toBe(a.correlationId);
    expect(JSON.stringify([a, b])).not.toContain('FICTIONAL_PRIVATE_FAILURE');
  });

  it.each(['flag', 'route', 'environment', 'human'] as const)(
    'recovers an accepted ACK after %s change without provider admission replay',
    async (change) => {
      const f = await supportAnsweringFixture();
      const packet = f.packet(change === 'human' ? 'human' : 'assistant_if_available');
      f.state.loseAck = true;
      expect((await f.ingress()(f.request(packet))).status).toBe(503);
      const expected = await f.runtime.application.readCustomerTicket(
        resolveAccess(
          { principalId: f.human.principals.owner },
          { version: 'fixture', defaults: [supportPermissions.readOwn] },
        ),
        packet.command.ticketId,
      );
      const beforeReads = f.state.routeReads;
      if (change === 'flag' || change === 'human') f.state.enabled = false;
      if (change === 'route') f.state.routeCurrent = false;
      if (change === 'environment') f.state.environment = false;
      const response = await f.ingress()(f.request(packet));
      expect(response.status).toBe(201);
      expect(await response.json()).toMatchObject({
        ticket: { id: expected.ticket.id, number: expected.ticket.number },
        initialMode: change === 'human' ? 'human' : 'assistant',
      });
      expect(f.state.routeReads).toBe(beforeReads);
      expect(f.state.keys).toBe(0);
      expect(f.state.calls).toBe(0);
      expect((await f.ingress()(f.request(packet, 'peer'))).status).toBe(403);
    },
  );

  it('routes unavailable or unacknowledged disclosure to human support and never invents bot authority', async () => {
    const f = await supportAnsweringFixture();
    const packet = { ...f.packet(), disclosureVersion: 'obsolete-disclosure' };
    expect(await (await f.ingress()(f.request(packet))).json()).toMatchObject({
      initialMode: 'human',
    });
    const configured = f.composition.configuration!;
    const unavailable = composeSupportAnswering(
      f.runtime,
      f.logger,
      {
        ...f.composition,
        configuration: {
          ...configured,
          customerPolicy: {
            ...configured.customerPolicy,
            defaults: [supportPermissions.create, supportPermissions.readOwn],
          },
        },
      },
      () => true,
    );
    const denied = createSupportAnsweringIngress(f.runtime, f.logger, unavailable);
    expect(await (await denied(f.request())).json()).toMatchObject({ enabled: false });
    expect(await (await denied(f.request(f.packet()))).json()).toMatchObject({
      initialMode: 'human',
    });
  });

  it('blocks a genuine original-session revocation while the request body is pending before any ticket exists', async () => {
    const f = await supportAnsweringFixture();
    const packet = f.packet();
    const body = await controlledHumanBody(f.request(packet));
    const pending = f.ingress()(body.request);
    await body.waitFor(pending);
    await f.human.revokeSession('owner');
    body.complete();
    expect((await pending).status).toBe(401);
    const access = resolveAccess(
      { principalId: f.human.principals.owner },
      { version: 'fixture', defaults: [supportPermissions.readOwn] },
    );
    await expect(
      f.runtime.application.readCustomerTicket(access, packet.command.ticketId),
    ).rejects.toThrow();
  });

  it.each(['session', 'synchronous-route'] as const)(
    'keeps the real SDK create uncommitted after a late %s revocation',
    async (change) => {
      const f = await supportAnsweringFixture();
      const packet = f.packet();
      const original = f.answering();
      let observations = 0;
      let closing = false;
      const answering = {
        ...original,
        async admission(principalId: string) {
          const result = await original.admission(principalId);
          if (++observations === 2) {
            if (change === 'session') await f.human.revokeSession('owner');
            else closing = true;
          }
          return result;
        },
      };
      const runtime = {
        ...f.runtime,
        sessions: {
          ...f.runtime.sessions,
          async get(id: string) {
            const value = await f.runtime.sessions.get(id);
            if (closing) f.state.routeCurrent = false;
            return value;
          },
        },
      };
      const response = await createSupportAnsweringIngress(
        runtime,
        f.logger,
        answering,
      )(f.request(packet));
      expect(response.status).toBe(change === 'session' ? 401 : 503);
      expect(observations).toBe(2);
      expect(await f.human.rows(packet.command.ticketId)).toEqual([]);
      expect(f.state.keys).toBe(0);
      expect(f.state.calls).toBe(0);
    },
  );

  it('bounds a noncancellable authority wait and prevents its late continuation from creating a ticket', async () => {
    const f = await supportAnsweringFixture();
    const packet = f.packet();
    const entered = assistantGate();
    const released = assistantGate();
    const runtime = {
      ...f.runtime,
      sessions: {
        ...f.runtime.sessions,
        async get(id: string) {
          const value = await f.runtime.sessions.get(id);
          entered.release();
          await released.ready;
          return value;
        },
      },
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = createSupportAnsweringIngress(
        runtime,
        f.logger,
        f.answering(),
      )(f.request(packet));
      await entered.ready;
      await vi.advanceTimersByTimeAsync(25_000);
      expect((await pending).status).toBe(503);
      released.release();
      await Promise.resolve();
      expect(await f.human.rows(packet.command.ticketId)).toEqual([]);
    } finally {
      released.release();
      vi.useRealTimers();
    }
  });

  it('recovers the genuine accepted create when its SDK acknowledgement arrives after the HTTP deadline', async () => {
    const f = await supportAnsweringFixture();
    const packet = f.packet();
    const entered = assistantGate();
    const released = assistantGate();
    const runtime = {
      ...f.runtime,
      application: {
        ...f.runtime.application,
        async createAdmittedCustomerTicket(
          ...args: Parameters<typeof f.runtime.application.createAdmittedCustomerTicket>
        ) {
          const result = await f.runtime.application.createAdmittedCustomerTicket(...args);
          entered.release();
          await released.ready;
          return result;
        },
      },
    };
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pending = createSupportAnsweringIngress(
        runtime,
        f.logger,
        f.answering(),
      )(f.request(packet));
      await entered.ready;
      await vi.advanceTimersByTimeAsync(25_000);
      expect((await pending).status).toBe(503);
      expect(
        (await f.human.rows(packet.command.ticketId)).filter((row) => row.kind === 'ticket'),
      ).toHaveLength(1);
      released.release();
      f.state.enabled = false;
      expect((await f.ingress()(f.request(packet))).status).toBe(201);
      expect(
        (await f.human.rows(packet.command.ticketId)).filter((row) => row.kind === 'ticket'),
      ).toHaveLength(1);
    } finally {
      released.release();
      vi.useRealTimers();
    }
  });
  it('recovers the exact accepted outcome through a fresh application with cap1 without raising that cap or admitting new staged work', async () => {
    const f = await supportAnsweringFixture();
    const packet = f.packet();
    f.state.loseAck = true;
    expect((await f.ingress()(f.request(packet))).status).toBe(503);
    const reduced = {
      ...f.composition,
      configuration: { ...f.composition.configuration!, turns: { maxAttempts: 1 } },
    };
    const runtime = createSupportRuntime({
      ...f.runtime,
      logger: f.logger,
      assistantTurns: supportAnsweringTurns(reduced),
    });
    const answering = composeSupportAnswering(runtime, f.logger, reduced, () => true);
    expect(answering.enabled()).toBe(false);
    const handler = createSupportAnsweringIngress(runtime, f.logger, answering);
    expect(await (await handler(f.request(packet))).json()).toMatchObject({
      initialMode: 'assistant',
      ticket: { id: packet.command.ticketId },
    });
    const fresh = f.packet();
    expect((await handler(f.request(fresh))).status).toBe(409);
    expect(await f.human.rows(fresh.command.ticketId)).toEqual([]);
    expect(f.state.keys).toBe(0);
    expect(f.state.calls).toBe(0);
  });
  it.each(['human', 'assistant_if_available'] as const)(
    'rejects a new %s create after a real verified contact change while its body is held',
    async (preference) => {
      const f = await supportAnsweringFixture();
      const packet = f.packet(preference);
      expect(packet.command.expectedRequesterEmail).toBe('owner@example.test');
      expect(await f.human.rows(packet.command.ticketId)).toEqual([]);
      const body = await controlledHumanBody(f.request(packet));
      const pending = f.ingress()(body.request);
      await body.waitFor(pending);
      await changeAnsweringContact(f, 'changed-answering-owner@example.test');
      body.complete();
      const response = await pending;
      expect(response.status).toBe(409);
      expect(await f.human.rows(packet.command.ticketId)).toEqual([]);
      expect(f.state.keys).toBe(0);
      expect(f.state.calls).toBe(0);
    },
  );

  it('recovers the exact accepted old-contact create after a real verified contact change without new admission or effects', async () => {
    const f = await supportAnsweringFixture();
    const packet = f.packet();
    f.state.loseAck = true;
    expect((await f.ingress()(f.request(packet))).status).toBe(503);
    const committed = await f.human.rows(packet.command.ticketId);
    expect(committed.filter((row) => row.kind === 'ticket')).toHaveLength(1);
    await changeAnsweringContact(f, 'changed-answering-owner@example.test');
    const reads = f.state.routeReads;
    const response = await f.ingress()(f.request(packet));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      initialMode: 'assistant',
      ticket: { id: packet.command.ticketId },
    });
    expect(f.state.routeReads).toBe(reads);
    expect(await f.human.rows(packet.command.ticketId)).toEqual(committed);
    const staff = await f.runtime.application.readStaffTicket(
      await f.human.staffAccess(),
      packet.command.ticketId,
    );
    expect(staff.ticket.requester.email).toBe(packet.command.expectedRequesterEmail);
    expect(f.state.keys).toBe(0);
    expect(f.state.calls).toBe(0);
  });
});
