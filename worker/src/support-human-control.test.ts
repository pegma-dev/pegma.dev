import { createMemoryStore } from '@pegma/storage-core';
import { describe, expect, it, vi } from 'vitest';
import { isPlainObject } from './api-auth';
import {
  humanControlFixture,
  controlledHumanBody,
  humanPrivateGuide,
  humanPrivateNote,
  humanPrivateSummary,
  type HumanRoute,
} from './support-human-control-fixtures';

async function value(response: Response) {
  const result: unknown = await response.json();
  if (!isPlainObject(result)) throw new Error('Expected a JSON response.');
  return result;
}
const fixture = () => humanControlFixture(createMemoryStore());

describe('public SDK human controls with real Identity, sessions and audited roles', () => {
  it('projects legacy generation0 without a write, takes over without assignment and replays the exact original fences', async () => {
    const f = await fixture();
    const ticket = await f.createTicket();
    const rows = await f.rows(ticket);
    const initial = await f.api(
      new Request('https://pegma.dev/api/support/admin/tickets/' + ticket, {
        headers: { Cookie: f.cookies.get('operator')! },
      }),
    );
    expect(await value(initial)).toMatchObject({
      ticket: {
        revision: 1,
        handling: { state: 'human-pending', generation: 0 },
      },
    });
    expect(await f.rows(ticket)).toEqual(rows);
    const packet = await f.packet(ticket);
    const taken = await f.api(
      f.request('take-over', ticket, 'operator', packet),
    );
    expect(taken.status).toBe(200);
    const accepted = await value(taken);
    expect(accepted).toMatchObject({
      ticket: { handling: { state: 'human-active', generation: 1 } },
      csrfToken: f.csrf.get('operator'),
    });
    expect(
      isPlainObject(accepted.ticket) && accepted.ticket.assignedTo,
    ).toBeFalsy();
    const after = await f.rows(ticket);
    expect(
      await value(
        await f.api(f.request('take-over', ticket, 'operator', packet)),
      ),
    ).toEqual(accepted);
    expect(await f.rows(ticket)).toEqual(after);
    expect(
      (
        await f.api(
          f.request('take-over', ticket, 'operator', {
            ...packet,
            expectedRevision: packet.expectedRevision + 1,
          }),
        )
      ).status,
    ).toBe(409);
  });

  it('performs an owned no-op and atomically creates one real managed handoff, with exact request-person replay', async () => {
    const f = await fixture();
    const legacy = await f.createTicket();
    const before = await f.rows(legacy);
    expect(
      (
        await f.api(
          f.request('request-person', legacy, 'owner', {
            commandId: crypto.randomUUID(),
          }),
        )
      ).status,
    ).toBe(200);
    expect(await f.rows(legacy)).toEqual(before);
    const ticket = await f.createTicket(true, 1);
    const packet = { commandId: crypto.randomUUID() };
    const result = await f.api(
      f.request('request-person', ticket, 'owner', packet),
    );
    expect(result.status).toBe(200);
    const customer = await value(result);
    expect(customer).toMatchObject({
      ticket: { id: ticket, handling: 'human-pending' },
      csrfToken: f.csrf.get('owner'),
    });
    expect(JSON.stringify(customer)).not.toContain(humanPrivateNote);
    expect(customer.ticket).not.toHaveProperty('revision');
    expect(customer.ticket).not.toHaveProperty('requester');
    const after = await f.rows(ticket);
    expect(after.filter((row) => row.kind === 'handoff_work')).toHaveLength(1);
    expect(
      after.filter(
        (row) => row.kind === 'command' && row.commandId === packet.commandId,
      ),
    ).toHaveLength(1);
    expect(
      (await f.api(f.request('request-person', ticket, 'owner', packet)))
        .status,
    ).toBe(200);
    expect(await f.rows(ticket)).toEqual(after);
    expect(
      (await f.api(f.request('request-person', ticket, 'peer', packet))).status,
    ).toBe(404);
    expect(
      (
        await f.api(
          f.request('request-person', 'missing-ticket', 'owner', packet),
        )
      ).status,
    ).toBe(404);
  });

  it('returns the explicit private handoff projection only to current Support, with no Admin/Knowledge implication', async () => {
    const f = await fixture();
    const ticket = await f.createTicket(true);
    await f.privateEscalation(ticket);
    const response = await f.api(f.request('handoff', ticket, 'operator'));
    expect(response.status).toBe(200);
    expect(await value(response)).toMatchObject({
      handoff: [
        {
          ticketId: ticket,
          summary: humanPrivateSummary,
          attemptedGuideIds: [humanPrivateGuide],
          transcript: { ticketId: ticket },
        },
      ],
      csrfToken: f.csrf.get('operator'),
    });
    for (const actor of [
      'owner',
      'peer',
      'administrator',
      'knowledge',
      'both',
    ] as const)
      expect((await f.api(f.request('handoff', ticket, actor))).status).toBe(
        403,
      );
    const own = await f.api(
      f.request('request-person', ticket, 'owner', {
        commandId: crypto.randomUUID(),
      }),
    );
    const encoded = JSON.stringify(await own.json());
    expect(encoded).not.toContain(humanPrivateSummary);
    expect(encoded).not.toContain(humanPrivateGuide);
    expect(encoded).not.toContain('transcript');
  });

  it('keeps terminal takeover separate from explicit reopen and preserves stale-fence conflicts', async () => {
    const f = await fixture();
    const ticket = await f.createTicket();
    await f.runtime.application.resolveTicket(await f.staffAccess(), {
      commandId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      ticketId: ticket,
    });
    expect(
      (
        await f.api(
          f.request('take-over', ticket, 'operator', await f.packet(ticket)),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await f.api(
          f.request('request-person', ticket, 'owner', {
            commandId: crypto.randomUUID(),
          }),
        )
      ).status,
    ).toBe(200);
    const current = await f.packet(ticket);
    expect(
      (
        await f.api(
          f.request('take-over', ticket, 'operator', {
            ...current,
            expectedHandlingGeneration: current.expectedHandlingGeneration + 1,
          }),
        )
      ).status,
    ).toBe(409);
    expect(
      (await f.api(f.request('take-over', ticket, 'operator', current))).status,
    ).toBe(200);
  });

  it('returns the current browser CSRF token after actual staff PATCH, reply and note commits', async () => {
    const f = await fixture();
    const ticket = await f.createTicket();
    const headers = f.request('take-over', ticket, 'operator', {}).headers;
    const staffRequest = (suffix: string, method: string, body: unknown) =>
      new Request(
        'https://pegma.dev/api/support/admin/tickets/' + ticket + suffix,
        { method, headers, body: JSON.stringify(body) },
      );
    const patched = await f.api(
      staffRequest('', 'PATCH', {
        action: 'change_priority',
        priority: 'high',
      }),
    );
    expect(patched.status).toBe(200);
    expect(await value(patched)).toMatchObject({
      ticket: { id: ticket, priority: 'high' },
      csrfToken: f.csrf.get('operator'),
    });
    expect(
      (
        await f.runtime.application.readStaffTicket(
          await f.staffAccess(),
          ticket,
        )
      ).ticket.priority,
    ).toBe('high');

    const reply = 'A fictional public staff reply.';
    const replied = await f.api(
      staffRequest('/messages', 'POST', { body: reply }),
    );
    expect(replied.status).toBe(201);
    expect(await value(replied)).toMatchObject({
      ticket: { id: ticket },
      csrfToken: f.csrf.get('operator'),
    });
    const note = 'A fictional private staff note.';
    const noted = await f.api(staffRequest('/notes', 'POST', { body: note }));
    expect(noted.status).toBe(201);
    expect(await value(noted)).toMatchObject({
      ticket: { id: ticket },
      csrfToken: f.csrf.get('operator'),
    });
    const stored = await f.runtime.application.readStaffTicket(
      await f.staffAccess(),
      ticket,
    );
    expect(
      stored.messages.filter((message) => message.body === reply),
    ).toHaveLength(1);
    expect(
      stored.messages.filter((message) => message.body === note),
    ).toHaveLength(1);
    const customer = await f.api(
      new Request('https://pegma.dev/api/support/tickets/' + ticket, {
        headers: { Cookie: f.cookies.get('owner')! },
      }),
    );
    const visible = JSON.stringify(await customer.json());
    expect(customer.status).toBe(200);
    expect(visible).toContain(reply);
    expect(visible).not.toContain(note);
  });

  it.each(['request-person', 'take-over'] as const)(
    'validates the closed immutable %s packet and method/query boundary',
    async (route) => {
      const f = await fixture();
      const ticket = await f.createTicket();
      const actor = route === 'request-person' ? 'owner' : 'operator';
      const packet =
        route === 'request-person'
          ? { commandId: crypto.randomUUID() }
          : await f.packet(ticket);
      for (const extra of [
        'principalId',
        'correlationId',
        'handling',
        'summary',
        'access',
      ])
        expect(
          (
            await f.api(
              f.request(route, ticket, actor, {
                ...packet,
                [extra]: 'untrusted',
              }),
            )
          ).status,
        ).toBe(400);
      expect(
        (
          await f.api(
            f.request(route, ticket, actor, {
              ...packet,
              commandId: 'not-a-uuid',
            }),
          )
        ).status,
      ).toBe(400);
      const normal = f.request(route, ticket, actor, packet);
      expect(
        (
          await f.api(
            new Request(normal.url + '?extra=1', {
              method: 'POST',
              headers: normal.headers,
              body: await normal.clone().text(),
            }),
          )
        ).status,
      ).toBe(400);
      const wrong = new Request(normal.url, { headers: normal.headers });
      const denied = await f.api(wrong);
      expect(denied.status).toBe(405);
      expect(denied.headers.get('Allow')).toBe('POST');
    },
  );

  it.each(['request-person', 'take-over'] as const)(
    'shares the actual durable 30/hour reply budget with legacy routes and exact %s replays',
    async (route) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2035-01-01T00:00:00.000Z'));
      try {
        const f = await fixture();
        const actor = route === 'request-person' ? 'owner' : 'operator';
        const ticket = await f.createTicket(route === 'request-person');
        const headers = f.request(route, ticket, actor, {}).headers;
        const legacyPath =
          route === 'request-person'
            ? '/api/support/tickets/' + ticket + '/replies'
            : '/api/support/admin/tickets/' + ticket + '/messages';
        const legacyRequest = () =>
          new Request('https://pegma.dev' + legacyPath, {
            method: 'POST',
            headers,
            body: JSON.stringify({ body: 'A fictional shared-budget reply.' }),
          });
        expect((await f.api(legacyRequest())).status).toBe(201);
        const packet =
          route === 'request-person'
            ? { commandId: crypto.randomUUID() }
            : await f.packet(ticket);
        for (let attempt = 0; attempt < 29; attempt += 1)
          expect(
            (await f.api(f.request(route, ticket, actor, packet))).status,
          ).toBe(200);
        const afterReplays = await f.rows(ticket);
        const replayDenied = await f.api(
          f.request(route, ticket, actor, packet),
        );
        expect(replayDenied.status).toBe(429);
        expect(Number(replayDenied.headers.get('Retry-After'))).toBeGreaterThan(
          0,
        );
        expect((await f.api(legacyRequest())).status).toBe(429);
        expect(await f.rows(ticket)).toEqual(afterReplays);

        // A newly eligible actual transition must also remain uncommitted while
        // the principal's durable budget is exhausted; a new command ID is no bypass.
        const freshTicket = await f.createTicket(route === 'request-person');
        const freshPacket =
          route === 'request-person'
            ? { commandId: crypto.randomUUID() }
            : await f.packet(freshTicket);
        const before = await f.rows(freshTicket);
        expect(
          (await f.api(f.request(route, freshTicket, actor, freshPacket)))
            .status,
        ).toBe(429);
        expect(await f.rows(freshTicket)).toEqual(before);
        if (route === 'take-over')
          expect(
            (await f.api(f.request('handoff', ticket, actor))).status,
          ).toBe(200);

        vi.setSystemTime(new Date('2035-01-01T01:00:00.000Z'));
        expect(
          (await f.api(f.request(route, freshTicket, actor, freshPacket)))
            .status,
        ).toBe(200);
        const committed = await f.rows(freshTicket);
        if (route === 'request-person')
          expect(
            committed.filter((row) => row.kind === 'handoff_work'),
          ).toHaveLength(1);
        else
          expect(committed.find((row) => row.kind === 'ticket')).toMatchObject({
            ticket: { handling: { state: 'human-active', generation: 1 } },
          });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(['request-person', 'take-over'] as const)(
    'uses fresh real session/account/role authority after the %s body',
    async (route) => {
      for (const revoked of route === 'request-person'
        ? (['session', 'identity'] as const)
        : (['session', 'role', 'identity'] as const)) {
        const f = await fixture();
        const ticket = await f.createTicket(true);
        const actor = route === 'request-person' ? 'owner' : 'operator';
        const packet =
          route === 'request-person'
            ? { commandId: crypto.randomUUID() }
            : await f.packet(ticket);
        const body = await controlledHumanBody(
          f.request(route, ticket, actor, packet),
        );
        const before = await f.rows(ticket);
        const pending = f.api(body.request);
        try {
          await body.waitFor(pending);
          if (revoked === 'session') await f.revokeSession(actor);
          if (revoked === 'role') await f.revokeSupport();
          if (revoked === 'identity') await f.removeIdentity(actor);
        } finally {
          body.complete();
        }
        expect((await pending).status).toBe(revoked === 'role' ? 403 : 401);
        expect(await f.rows(ticket)).toEqual(before);
      }
    },
  );

  it.each([
    'Cookie',
    'X-Pegma-CSRF',
    'Origin',
    'Sec-Fetch-Site',
    'Authorization',
  ] as const)('binds original %s across delayed body input', async (header) => {
    const f = await fixture();
    const ticket = await f.createTicket();
    const body = await controlledHumanBody(
      f.request('take-over', ticket, 'operator', await f.packet(ticket)),
    );
    const before = await f.rows(ticket);
    const pending = f.api(body.request);
    try {
      await body.waitFor(pending);
      body.request.headers.set(
        header,
        header === 'Cookie'
          ? f.cookies.get('administrator')!
          : header === 'Authorization'
            ? 'Bearer synthetic-forbidden'
            : 'changed',
      );
    } finally {
      body.complete();
    }
    expect((await pending).status).toBe(403);
    expect(await f.rows(ticket)).toEqual(before);
  });

  it('withholds a committed takeover ACK after role revocation without undoing the real commit', async () => {
    const f = await fixture();
    const ticket = await f.createTicket();
    const packet = await f.packet(ticket);
    const blocked = f.block('commit');
    const pending = f.api(f.request('take-over', ticket, 'operator', packet));
    try {
      await blocked.waitFor(pending);
      await f.revokeSupport();
    } finally {
      blocked.release();
    }
    expect((await pending).status).toBe(403);
    expect(
      (await f.rows(ticket)).some(
        (row) =>
          row.kind === 'ticket' &&
          row.ticket.handling?.state === 'human-active',
      ),
    ).toBe(true);
    const committed = await f.rows(ticket);
    await f.restoreSupport();
    expect(
      (await f.api(f.request('take-over', ticket, 'operator', packet))).status,
    ).toBe(200);
    expect(await f.rows(ticket)).toEqual(committed);
  });

  it.each(['session', 'role'] as const)(
    'withholds real private handoff content after %s revocation during its SDK read',
    async (kind) => {
      const f = await fixture();
      const ticket = await f.createTicket(true);
      await f.privateEscalation(ticket);
      const blocked = f.block('read');
      const pending = f.api(f.request('handoff', ticket, 'operator'));
      try {
        await blocked.waitFor(pending);
        if (kind === 'role') await f.revokeSupport();
        else await f.revokeSession('operator');
      } finally {
        blocked.release();
      }
      const response = await pending;
      expect(response.status).toBe(kind === 'role' ? 403 : 401);
      expect(JSON.stringify(await response.json())).not.toContain(
        humanPrivateSummary,
      );
    },
  );

  it('checks actual Identity again after awaited roles before releasing private handoff content', async () => {
    const f = await fixture();
    const ticket = await f.createTicket(true);
    await f.privateEscalation(ticket);
    const read = f.block('read');
    const pending = f.api(f.request('handoff', ticket, 'operator'));
    let role: ReturnType<typeof f.block> | undefined;
    try {
      await read.waitFor(pending);
      role = f.block('role');
      read.release();
      await role.waitFor(pending);
      await f.removeIdentity('operator');
    } finally {
      read.release();
      role?.release();
    }
    const response = await pending;
    expect(response.status).toBe(401);
    expect(JSON.stringify(await response.json())).not.toContain(
      humanPrivateSummary,
    );
  });

  it.each(['destroy', 'expire'] as const)(
    'withholds private handoff content when the original session is %s during the final stored-role read',
    async (kind) => {
      if (kind === 'expire') vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const f = await fixture();
        const ticket = await f.createTicket(true);
        await f.privateEscalation(ticket);
        const rawSessionId = f.cookies
          .get('operator')!
          .slice('__Host-pegma_session='.length);
        const session = await f.sessions.get(rawSessionId);
        if (session === null)
          throw new Error('Missing actual operator session.');
        const before = await f.rows(ticket);
        const read = f.block('read');
        const pending = f.api(f.request('handoff', ticket, 'operator'));
        let role: ReturnType<typeof f.block> | undefined;
        try {
          // Initial authority has passed. Pause the real SDK read, then the
          // final authority's real role read after its session observation.
          await read.waitFor(pending);
          role = f.block('role');
          read.release();
          await role.waitFor(pending);
          if (kind === 'destroy') await f.revokeSession('operator');
          else vi.setSystemTime(new Date(session.expiresAt));
        } finally {
          read.release();
          role?.release();
        }
        const response = await pending;
        expect(response.status).toBe(401);
        expect(JSON.stringify(await response.json())).not.toContain(
          humanPrivateSummary,
        );
        expect(await f.rows(ticket)).toEqual(before);
        expect(await f.sessions.get(rawSessionId)).toBeNull();
      } finally {
        if (kind === 'expire') vi.useRealTimers();
      }
    },
  );

  it.each(['request-person', 'take-over'] as const)(
    'enforces a total %s body deadline and accepts timely input',
    async (route: HumanRoute) => {
      for (const late of [true, false]) {
        const f = await fixture();
        const ticket = await f.createTicket();
        const actor = route === 'request-person' ? 'owner' : 'operator';
        const packet =
          route === 'request-person'
            ? { commandId: crypto.randomUUID() }
            : await f.packet(ticket);
        const body = await controlledHumanBody(
          f.request(route, ticket, actor, packet),
        );
        const before = await f.rows(ticket);
        vi.useFakeTimers({
          toFake: ['setTimeout', 'clearTimeout', 'performance'],
        });
        let settled = false;
        const pending = f.api(body.request).finally(() => {
          settled = true;
        });
        try {
          await body.waitFor(pending);
          await vi.advanceTimersByTimeAsync(9000);
          body.trickle();
          await vi.advanceTimersByTimeAsync(late ? 1000 : 999);
          if (late) expect(settled).toBe(true);
          else body.complete();
          const response = await pending;
          expect(response.status).toBe(late ? 408 : 200);
          if (late) expect(await f.rows(ticket)).toEqual(before);
          expect(body.cancellations).toBe(late ? 1 : 0);
          expect(body.request.body?.locked).toBe(false);
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          body.complete();
          try {
            await pending;
          } finally {
            vi.useRealTimers();
          }
        }
      }
    },
  );
});
