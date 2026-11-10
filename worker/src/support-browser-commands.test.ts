import { createMemoryStore } from '@pegma/storage-core';
import { supportRecords } from '@pegma/support-desk-application';
import { describe, expect, it } from 'vitest';
import { isPlainObject } from './api-auth';
import { IDENTITY_ISSUER } from './identity-api';
import {
  APPLICATION_SCOPE,
  SUPPORT_ROLE,
  customerAccessContext,
} from './support-access';
import {
  controlledHumanBody,
  humanControlFixture,
  humanPrivateNote,
  type HumanActor,
} from './support-human-control-fixtures';

type Fixture = Awaited<ReturnType<typeof humanControlFixture>>;
type Operation = 'reply' | 'staff-reply' | 'note' | 'patch';

function command(f: Fixture, actor: HumanActor) {
  const expectedAccountId = f.principals[actor];
  return {
    version: 1,
    expectedAccountId,
    commandId: expectedAccountId + '~' + crypto.randomUUID().toUpperCase(),
    ticketId: crypto.randomUUID(),
    messageId: expectedAccountId + '~' + crypto.randomUUID().toUpperCase(),
  };
}

function createPacket(f: Fixture) {
  return {
    command: {
      ...command(f, 'owner'),
      expectedRequesterEmail: 'owner@example.test',
    },
    subject: 'Fictional stable browser intent',
    body: 'One synthetic initial customer message.',
    category: 'question',
  };
}

function packet(
  f: Fixture,
  operation: Operation,
  actor: HumanActor = operation === 'reply' ? 'owner' : 'operator',
) {
  const ids = command(f, actor);
  if (operation === 'patch')
    return {
      command: {
        version: ids.version,
        expectedAccountId: ids.expectedAccountId,
        commandId: ids.commandId,
      },
      action: 'change_priority',
      priority: 'high',
    };
  return {
    command: {
      version: ids.version,
      expectedAccountId: ids.expectedAccountId,
      commandId: ids.commandId,
      messageId: ids.messageId,
    },
    body: operation === 'note' ? humanPrivateNote : 'One synthetic reply.',
  };
}

function request(
  f: Fixture,
  path: string,
  actor: HumanActor,
  body: unknown,
  method = 'POST',
  signal?: AbortSignal,
) {
  return new Request(IDENTITY_ISSUER + path, {
    method,
    headers: {
      Cookie: f.cookies.get(actor)!,
      'X-Pegma-CSRF': f.csrf.get(actor)!,
      Origin: IDENTITY_ISSUER,
      'Sec-Fetch-Site': 'same-origin',
      'Content-Type': 'application/json',
      ...(isPlainObject(body) && Object.hasOwn(body, 'command')
        ? { 'x-pegma-support-command': '1' }
        : {}),
    },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  });
}

function path(operation: Operation, ticketId: string) {
  if (operation === 'reply')
    return '/api/support/tickets/' + ticketId + '/replies';
  const base = '/api/support/admin/tickets/' + ticketId;
  return operation === 'patch'
    ? base
    : base + (operation === 'staff-reply' ? '/messages' : '/notes');
}

function operationRequest(
  f: Fixture,
  operation: Operation,
  ticketId: string,
  body: unknown,
  actor: HumanActor = operation === 'reply' ? 'owner' : 'operator',
) {
  return request(
    f,
    path(operation, ticketId),
    actor,
    body,
    operation === 'patch' ? 'PATCH' : 'POST',
  );
}

async function value(response: Response) {
  const result: unknown = await response.json();
  if (!isPlainObject(result)) throw new Error('Expected a JSON object.');
  return result;
}

async function closedError(response: Response, statuses: readonly number[]) {
  expect(statuses).toContain(response.status);
  const result = await value(response);
  expect(Object.keys(result)).toEqual(['error']);
  expect(typeof result.error).toBe('string');
  expect(JSON.stringify(result)).not.toContain(humanPrivateNote);
  expect(JSON.stringify(result)).not.toContain('@example.test');
  return result;
}

const fixture = () => humanControlFixture(createMemoryStore());

async function changeEmail(f: Fixture, email: string) {
  // The real public Mail renderer exposes this fictional code only in memory.
  let deliveredCode: string | undefined;
  const mail = f.identity.createMailWorker({
    workerId: 'synthetic-public-contact-change',
    provider: {
      async send() {
        return { providerMessageRef: 'synthetic-contact-code' };
      },
    },
    reconciliation: {
      async reconcile() {
        return { status: 'unknown' };
      },
    },
    renderer: {
      async render(content) {
        if (content.purpose === 'email_change') deliveredCode = content.code;
        return {
          subject: 'Synthetic public fixture',
          text: 'A fictional in-memory email-code delivery.',
        };
      },
    },
  });
  const started = await f.identity.beginEmailChange(
    f.principals.owner,
    email,
    'synthetic-public-email-change',
  );
  // Physical rows include the adjacent Identity operation as well as its mail.
  const sent = await mail.runSendPage({ limit: 100 });
  expect(sent.results).toHaveLength(1);
  expect(sent.results[0]).toMatchObject({ status: 'accepted' });
  if (deliveredCode === undefined)
    throw new Error('The actual Identity renderer did not render a code.');
  const changed = await f.identity.finishEmailChange({
    principalId: f.principals.owner,
    codeHandle: started.codeHandle,
    code: deliveredCode,
    rateLimitKey: 'synthetic-public-email-change',
  });
  expect(changed).toMatchObject({
    principalId: f.principals.owner,
    email,
    status: 'active',
    emailVerified: true,
  });
  expect(await f.identity.claimsFor(f.principals.owner)).toMatchObject({
    subject: f.principals.owner,
    emailVerified: true,
  });
}

describe('stable browser commands over real public Support Desk HTTP composition', () => {
  it('maps all three stable create IDs directly and replays exactly one ticket and initial message', async () => {
    const f = await fixture();
    const body = createPacket(f);
    const first = await f.api(
      request(f, '/api/support/tickets', 'owner', body),
    );
    expect(first.status).toBe(201);
    const accepted = await value(first);
    expect(accepted).toMatchObject({
      ticket: { id: body.command.ticketId },
      messages: [{ id: body.command.messageId, body: body.body }],
    });
    const rows = await f.rows(body.command.ticketId);
    expect(rows.filter((row) => row.kind === 'ticket')).toHaveLength(1);
    expect(rows.filter((row) => row.kind === 'message')).toHaveLength(1);
    expect(
      rows.filter(
        (row) =>
          row.kind === 'command' && row.commandId === body.command.commandId,
      ),
    ).toHaveLength(1);
    const replay = await f.api(
      request(f, '/api/support/tickets', 'owner', body),
    );
    expect(replay.status).toBe(201);
    expect(await value(replay)).toEqual(accepted);
    expect(await f.rows(body.command.ticketId)).toEqual(rows);
    const tickets = await f.runtime.application.listCustomerTickets(
      customerAccessContext(f.principals.owner),
    );
    expect(tickets.map((ticket) => ticket.id)).toEqual([body.command.ticketId]);
  });

  it('keeps a client-aborted original create and its concurrent exact retry at one durable SDK effect', async () => {
    const f = await fixture();
    const body = createPacket(f);
    const abort = new AbortController();
    const originalRequest = request(
      f,
      '/api/support/tickets',
      'owner',
      body,
      'POST',
      abort.signal,
    );
    const gate = f.block('commit');
    const original = f.api(originalRequest);
    try {
      await gate.waitFor(original);
      abort.abort();
      expect(originalRequest.signal.aborted).toBe(true);
      // The server has committed and remains paused; a browser's failed fetch
      // cannot turn that existing command into a new intent with new IDs.
      const retry = await f.api(
        request(f, '/api/support/tickets', 'owner', body),
      );
      expect(retry.status).toBe(201);
      expect(await value(retry)).toMatchObject({
        ticket: { id: body.command.ticketId },
      });
    } finally {
      gate.release();
      await original;
    }
    const rows = await f.rows(body.command.ticketId);
    expect(rows.filter((row) => row.kind === 'ticket')).toHaveLength(1);
    expect(rows.filter((row) => row.kind === 'message')).toHaveLength(1);
    expect(rows.filter((row) => row.kind === 'command')).toHaveLength(1);
  });

  it('recovers the original create receipt after a real same-principal verified email change and lost acknowledgement', async () => {
    const f = await fixture();
    const body = createPacket(f);
    const originalContact = (await f.identity.getUser(f.principals.owner))
      ?.email;
    expect(originalContact).toBe('owner@example.test');
    const abort = new AbortController();
    const gate = f.block('commit');
    const original = f.api(
      request(f, '/api/support/tickets', 'owner', body, 'POST', abort.signal),
    );
    try {
      await gate.waitFor(original);
      abort.abort();
      const committed = await f.rows(body.command.ticketId);
      expect(committed.filter((row) => row.kind === 'ticket')).toHaveLength(1);

      await changeEmail(f, 'changed-owner@example.test');

      // An ordinary reload still authenticates the same real cookie/session.
      const current = await f.api(
        new Request(
          IDENTITY_ISSUER + '/api/support/tickets/' + body.command.ticketId,
          { headers: { Cookie: f.cookies.get('owner')! } },
        ),
      );
      expect(current.status).toBe(200);
      const retry = await f.api(
        request(f, '/api/support/tickets', 'owner', body),
      );
      expect(retry.status).toBe(201);
      expect(await value(retry)).toMatchObject({
        ticket: { id: body.command.ticketId },
        messages: [{ id: body.command.messageId, body: body.body }],
      });
      expect(await f.rows(body.command.ticketId)).toEqual(committed);
      const staff = await f.runtime.application.readStaffTicket(
        await f.staffAccess(),
        body.command.ticketId,
      );
      expect(staff.ticket.requester.email).toBe(originalContact);
    } finally {
      gate.release();
      await original;
    }
  });

  it('observes the actual changed contact after an awaited body and refuses a new target asserted under the old contact', async () => {
    const f = await fixture();
    const body = createPacket(f);
    const controlled = await controlledHumanBody(
      request(f, '/api/support/tickets', 'owner', body),
    );
    const pending = f.api(controlled.request);
    try {
      await controlled.waitFor(pending);
      await changeEmail(f, 'changed-owner@example.test');
    } finally {
      controlled.complete();
    }
    await closedError(await pending, [404]);
    expect(await f.rows(body.command.ticketId)).toEqual([]);
  });

  it.each(['missing', 'foreign'] as const)(
    'never creates a new ticket from a stale contact when the stable target is %s',
    async (target) => {
      const f = await fixture();
      const body = createPacket(f);
      body.command.expectedRequesterEmail = 'old-owner@example.test';
      if (target === 'foreign') {
        await f.runtime.application.createCustomerTicket(
          customerAccessContext(f.principals.peer),
          {
            commandId: body.command.commandId,
            messageId: body.command.messageId,
            ticketId: body.command.ticketId,
            correlationId: crypto.randomUUID(),
            subject: body.subject,
            body: body.body,
            category: body.category,
            requesterEmail: 'peer@example.test',
          },
        );
      }
      const rows = await f.rows(body.command.ticketId);
      await closedError(
        await f.api(request(f, '/api/support/tickets', 'owner', body)),
        [404],
      );
      expect(await f.rows(body.command.ticketId)).toEqual(rows);
      expect(
        await f.runtime.application.listCustomerTickets(
          customerAccessContext(f.principals.owner),
        ),
      ).toEqual([]);
    },
  );

  it('fails closed when a real owned-target read becomes unavailable without treating it as a command outcome', async () => {
    const backing = createMemoryStore();
    let unavailable = false;
    const f = await humanControlFixture({
      collection(definition) {
        const target = backing.collection(definition);
        if (definition.name !== supportRecords.name) return target;
        return {
          ...target,
          async list(partition: string) {
            const rows = await target.list(partition);
            if (unavailable) throw new Error('Synthetic storage unavailable.');
            return rows;
          },
        };
      },
    });
    const body = createPacket(f);
    expect(
      (await f.api(request(f, '/api/support/tickets', 'owner', body))).status,
    ).toBe(201);
    const rows = await f.rows(body.command.ticketId);
    body.command.expectedRequesterEmail = 'old-owner@example.test';
    unavailable = true;
    await closedError(
      await f.api(request(f, '/api/support/tickets', 'owner', body)),
      [500],
    );
    unavailable = false;
    expect(await f.rows(body.command.ticketId)).toEqual(rows);
  });

  it.each(['contact', 'body', 'message-id'] as const)(
    'keeps the real receipt fingerprint authoritative for an owned stale-contact recovery with changed %s',
    async (changed) => {
      const f = await fixture();
      const body = createPacket(f);
      expect(
        (await f.api(request(f, '/api/support/tickets', 'owner', body))).status,
      ).toBe(201);
      await changeEmail(f, 'changed-owner@example.test');
      const rows = await f.rows(body.command.ticketId);
      const altered = {
        ...body,
        ...(changed === 'body' ? { body: 'Another synthetic intent.' } : {}),
        command: {
          ...body.command,
          ...(changed === 'contact'
            ? { expectedRequesterEmail: 'bogus-old@example.test' }
            : {}),
          ...(changed === 'message-id'
            ? { messageId: f.principals.owner + '~' + crypto.randomUUID() }
            : {}),
        },
      };
      await closedError(
        await f.api(request(f, '/api/support/tickets', 'owner', altered)),
        [409],
      );
      expect(await f.rows(body.command.ticketId)).toEqual(rows);
    },
  );

  it.each(['logout', 'identity-removal', 'cookie-replacement'] as const)(
    'rechecks the original current browser after the owned recovery read and refuses %s',
    async (change) => {
      const f = await fixture();
      const body = createPacket(f);
      expect(
        (await f.api(request(f, '/api/support/tickets', 'owner', body))).status,
      ).toBe(201);
      await changeEmail(f, 'changed-owner@example.test');
      const rows = await f.rows(body.command.ticketId);
      const incoming = request(f, '/api/support/tickets', 'owner', body);
      const gate = f.block('read');
      const pending = f.api(incoming);
      try {
        await gate.waitFor(pending);
        if (change === 'logout') await f.revokeSession('owner');
        else if (change === 'identity-removal')
          expect(await f.removeIdentity('owner')).toBe(true);
        else incoming.headers.set('Cookie', f.cookies.get('peer')!);
      } finally {
        gate.release();
      }
      await closedError(await pending, [
        change === 'cookie-replacement' ? 403 : 401,
      ]);
      expect(await f.rows(body.command.ticketId)).toEqual(rows);
    },
  );

  it.each([null, 'CaseSensitive@EXAMPLE.TEST'])(
    'recovers a genuinely owned historical receipt with asserted contact %s without replacing SDK contact semantics',
    async (contact) => {
      const f = await fixture();
      const body = createPacket(f);
      const ids = {
        commandId: body.command.commandId,
        messageId: body.command.messageId,
        ticketId: body.command.ticketId,
      };
      await f.runtime.application.createCustomerTicket(
        customerAccessContext(f.principals.owner),
        {
          ...ids,
          correlationId: crypto.randomUUID(),
          subject: body.subject,
          body: body.body,
          category: body.category,
          ...(contact === null ? {} : { requesterEmail: contact }),
        },
      );
      const rows = await f.rows(ids.ticketId);
      const replay = {
        ...body,
        command: { ...body.command, expectedRequesterEmail: contact },
      };
      const response = await f.api(
        request(f, '/api/support/tickets', 'owner', replay),
      );
      expect(response.status).toBe(201);
      expect(await value(response)).toMatchObject({
        ticket: { id: ids.ticketId },
      });
      expect(await f.rows(ids.ticketId)).toEqual(rows);
      const staff = await f.runtime.application.readStaffTicket(
        await f.staffAccess(),
        ids.ticketId,
      );
      expect(staff.ticket.requester.email).toBe(
        contact === null ? undefined : 'CaseSensitive@example.test',
      );
      if (contact !== null) {
        await closedError(
          await f.api(
            request(f, '/api/support/tickets', 'owner', {
              ...replay,
              command: {
                ...replay.command,
                expectedRequesterEmail: contact.toLowerCase(),
              },
            }),
          ),
          [409],
        );
        expect(await f.rows(ids.ticketId)).toEqual(rows);
      }
    },
  );

  it.each(['reply', 'staff-reply', 'note', 'patch'] as const)(
    'rejects create-only contact metadata on a %s envelope',
    async (operation) => {
      const f = await fixture();
      const ticketId = await f.createTicket();
      const before = await f.rows(ticketId);
      const body = packet(f, operation);
      await closedError(
        await f.api(
          operationRequest(f, operation, ticketId, {
            ...body,
            command: { ...body.command, expectedRequesterEmail: null },
          }),
        ),
        [400],
      );
      expect(await f.rows(ticketId)).toEqual(before);
    },
  );

  it.each([
    'missing',
    'number',
    'empty',
    'control',
    'del',
    'overlong',
  ] as const)(
    'rejects an invalid required create contact without an SDK effect: %s',
    async (fault) => {
      const f = await fixture();
      const body = createPacket(f);
      const { expectedRequesterEmail: _contact, ...without } = body.command;
      const contact: unknown = {
        missing: undefined,
        number: 1,
        empty: '',
        control: 'owner\u0000@example.test',
        del: 'owner\u007F@example.test',
        overlong: 'x'.repeat(255),
      }[fault];
      await closedError(
        await f.api(
          request(f, '/api/support/tickets', 'owner', {
            ...body,
            command:
              fault === 'missing'
                ? without
                : { ...without, expectedRequesterEmail: contact },
          }),
        ),
        [400],
      );
      expect(await f.rows(body.command.ticketId)).toEqual([]);
    },
  );

  it.each(['reply', 'staff-reply', 'note', 'patch'] as const)(
    'replays an identical %s packet without another message, revision, audit or receipt',
    async (operation) => {
      const f = await fixture();
      const ticketId = await f.createTicket(false, 1);
      const body = packet(f, operation);
      const first = await f.api(operationRequest(f, operation, ticketId, body));
      expect(first.status).toBe(operation === 'patch' ? 200 : 201);
      const accepted = await value(first);
      const rows = await f.rows(ticketId);
      const retry = await f.api(operationRequest(f, operation, ticketId, body));
      expect(retry.status).toBe(first.status);
      expect(await value(retry)).toEqual(accepted);
      expect(await f.rows(ticketId)).toEqual(rows);
      const changed =
        operation === 'patch'
          ? { ...body, priority: 'urgent' }
          : { ...body, body: 'A different synthetic intent.' };
      await closedError(
        await f.api(operationRequest(f, operation, ticketId, changed)),
        [409],
      );
      expect(await f.rows(ticketId)).toEqual(rows);
      const customer = await f.api(
        new Request(IDENTITY_ISSUER + '/api/support/tickets/' + ticketId, {
          headers: { Cookie: f.cookies.get('owner')! },
        }),
      );
      expect(customer.status).toBe(200);
      expect(JSON.stringify(await value(customer))).not.toContain(
        humanPrivateNote,
      );
    },
  );

  it('refuses changed create semantics or another customer while preserving the committed receipt and private error DTO', async () => {
    const f = await fixture();
    const body = createPacket(f);
    expect(
      (await f.api(request(f, '/api/support/tickets', 'owner', body))).status,
    ).toBe(201);
    const rows = await f.rows(body.command.ticketId);
    await closedError(
      await f.api(
        request(f, '/api/support/tickets', 'owner', {
          ...body,
          body: 'Changed intent.',
        }),
      ),
      [409],
    );
    await closedError(
      await f.api(request(f, '/api/support/tickets', 'peer', body)),
      [403],
    );
    expect(await f.rows(body.command.ticketId)).toEqual(rows);
  });

  it.each(['staff-reply', 'note', 'patch'] as const)(
    'binds an original %s command to its current staff principal even though the SDK receipt fingerprint omits actor',
    async (operation) => {
      const f = await fixture();
      const ticketId = await f.createTicket();
      const granted = await f.runtime.roleStore.grantRoleAssignmentWithAudit({
        assignment: {
          id: crypto.randomUUID(),
          principalId: f.principals.peer,
          role: SUPPORT_ROLE,
          scope: APPLICATION_SCOPE,
          grantedBy: { kind: 'system', systemId: 'synthetic-public-setup' },
          grantedAtEpochMs: Date.now(),
          status: 'active',
        },
        auditEventId: crypto.randomUUID(),
      });
      expect(granted.status).toBe('granted');
      // Admin does not imply Support. Establish B through an actual audited
      // Support assignment, then prove its own operation passes this route.
      const own = packet(f, operation, 'peer');
      const permitted = await f.api(
        operationRequest(
          f,
          operation,
          ticketId,
          operation === 'patch' ? { ...own, priority: 'urgent' } : own,
          'peer',
        ),
      );
      expect(permitted.status).toBe(operation === 'patch' ? 200 : 201);
      const body = packet(f, operation);
      expect(
        (await f.api(operationRequest(f, operation, ticketId, body))).status,
      ).toBe(operation === 'patch' ? 200 : 201);
      const rows = await f.rows(ticketId);
      await closedError(
        await f.api(operationRequest(f, operation, ticketId, body, 'peer')),
        [403],
      );
      await closedError(
        await f.api(
          operationRequest(
            f,
            operation,
            ticketId,
            {
              ...body,
              command: {
                ...body.command,
                expectedAccountId: f.principals.peer,
              },
            },
            'peer',
          ),
        ),
        [400],
      );
      expect(await f.rows(ticketId)).toEqual(rows);
    },
  );

  it.each(['staff-reply', 'note', 'patch'] as const)(
    'withholds a committed %s ACK after real role revocation, then recovers its exact receipt under restored authority',
    async (operation) => {
      const f = await fixture();
      const ticketId = await f.createTicket();
      const body = packet(f, operation);
      const before = await f.rows(ticketId);
      const gate = f.block('commit');
      const original = f.api(operationRequest(f, operation, ticketId, body));
      try {
        await gate.waitFor(original);
        await f.revokeSupport();
      } finally {
        gate.release();
      }
      await closedError(await original, [403]);
      const committed = await f.rows(ticketId);
      expect(committed.length).toBeGreaterThan(before.length);
      expect(
        committed.filter(
          (row) =>
            row.kind === 'command' && row.commandId === body.command.commandId,
        ),
      ).toHaveLength(1);
      await f.restoreSupport();
      const retry = await f.api(operationRequest(f, operation, ticketId, body));
      expect(retry.status).toBe(operation === 'patch' ? 200 : 201);
      expect(await f.rows(ticketId)).toEqual(committed);
    },
  );

  it('rechecks current staff authority after an awaited body without creating a new command', async () => {
    const f = await fixture();
    const ticketId = await f.createTicket();
    const before = await f.rows(ticketId);
    const body = await controlledHumanBody(
      operationRequest(f, 'note', ticketId, packet(f, 'note')),
    );
    const pending = f.api(body.request);
    try {
      await body.waitFor(pending);
      await f.revokeSupport();
    } finally {
      body.complete();
    }
    await closedError(await pending, [403]);
    expect(await f.rows(ticketId)).toEqual(before);
  });

  it('keeps the original cookie coordinates across body parsing and refuses an authenticated replacement principal', async () => {
    const f = await fixture();
    const ticketId = await f.createTicket();
    const before = await f.rows(ticketId);
    const body = await controlledHumanBody(
      operationRequest(f, 'reply', ticketId, packet(f, 'reply')),
    );
    const pending = f.api(body.request);
    try {
      await body.waitFor(pending);
      body.request.headers.set('Cookie', f.cookies.get('peer')!);
      body.request.headers.set('X-Pegma-CSRF', f.csrf.get('peer')!);
    } finally {
      body.complete();
    }
    await closedError(await pending, [403]);
    expect(await f.rows(ticketId)).toEqual(before);
  });

  it.each(['logout', 'identity-removal'] as const)(
    'refuses %s during the awaited body without writing a customer reply',
    async (change) => {
      const f = await fixture();
      const ticketId = await f.createTicket();
      const before = await f.rows(ticketId);
      const body = await controlledHumanBody(
        operationRequest(f, 'reply', ticketId, packet(f, 'reply')),
      );
      const pending = f.api(body.request);
      try {
        await body.waitFor(pending);
        if (change === 'logout') await f.revokeSession('owner');
        else expect(await f.removeIdentity('owner')).toBe(true);
      } finally {
        body.complete();
      }
      await closedError(await pending, [401]);
      expect(await f.rows(ticketId)).toEqual(before);
    },
  );

  it.each([
    'null',
    'array',
    'string',
    'empty',
    'partial',
    'missing-version',
    'wrong-version',
    'correlation',
    'principal',
    'number',
    'leading-space',
    'trailing-space',
    'overlong',
    'slash',
    'control',
    'prefixed-ticket',
  ] as const)(
    'rejects a malformed or partial create envelope without a ticket effect: %s',
    async (fault) => {
      const f = await fixture();
      const body = createPacket(f);
      const { version: _version, ...missingVersion } = body.command;
      const { ticketId: _ticketId, ...partial } = body.command;
      const invalid = {
        null: null,
        array: [],
        string: 'command',
        empty: {},
        partial,
        'missing-version': missingVersion,
        'wrong-version': { ...body.command, version: 2 },
        correlation: { ...body.command, correlationId: 'untrusted' },
        principal: { ...body.command, principalId: 'untrusted' },
        number: { ...body.command, commandId: 1 },
        'leading-space': {
          ...body.command,
          commandId: ' ' + body.command.commandId,
        },
        'trailing-space': {
          ...body.command,
          messageId: body.command.messageId + ' ',
        },
        overlong: {
          ...body.command,
          commandId: f.principals.owner + '~' + 'x'.repeat(129),
        },
        slash: {
          ...body.command,
          messageId: f.principals.owner + '~other/value',
        },
        control: {
          ...body.command,
          messageId: body.command.messageId + '\u0000',
        },
        'prefixed-ticket': {
          ...body.command,
          ticketId: body.command.commandId,
        },
      }[fault];
      await closedError(
        await f.api(
          request(f, '/api/support/tickets', 'owner', {
            ...body,
            command: invalid,
          }),
        ),
        [400],
      );
      expect(await f.rows(body.command.ticketId)).toEqual([]);
    },
  );

  it.each(['missing-header', 'wrong-header', 'missing-envelope'] as const)(
    'requires a complete explicit V1 protocol pair: %s',
    async (fault) => {
      const f = await fixture();
      const body = createPacket(f);
      const incoming = request(
        f,
        '/api/support/tickets',
        'owner',
        fault === 'missing-envelope'
          ? { subject: body.subject, body: body.body, category: body.category }
          : body,
      );
      if (fault === 'missing-header')
        incoming.headers.delete('x-pegma-support-command');
      else
        incoming.headers.set(
          'x-pegma-support-command',
          fault === 'wrong-header' ? '2' : '1',
        );
      await closedError(await f.api(incoming), [400]);
      expect(await f.rows(body.command.ticketId)).toEqual([]);
    },
  );

  it.each(['csrf', 'origin', 'bearer'] as const)(
    'retains the actual browser security gate for V1: %s',
    async (fault) => {
      const f = await fixture();
      const body = createPacket(f);
      const incoming = request(f, '/api/support/tickets', 'owner', body);
      if (fault === 'csrf')
        incoming.headers.set('X-Pegma-CSRF', 'x'.repeat(43));
      else if (fault === 'origin')
        incoming.headers.set('Origin', 'https://other.example.test');
      else
        incoming.headers.set(
          'Authorization',
          'Bearer synthetic-untrusted-credential',
        );
      await closedError(await f.api(incoming), [403]);
      expect(await f.rows(body.command.ticketId)).toEqual([]);
    },
  );

  it('rejects message envelopes with a body ticket ID and PATCH envelopes with a message ID', async () => {
    const f = await fixture();
    const ticketId = await f.createTicket();
    const before = await f.rows(ticketId);
    for (const operation of [
      'reply',
      'staff-reply',
      'note',
      'patch',
    ] as const) {
      const body = packet(f, operation);
      const conflicting =
        operation === 'patch'
          ? { ...body.command, messageId: 'unexpected-message' }
          : { ...body.command, ticketId: 'another-ticket' };
      await closedError(
        await f.api(
          operationRequest(f, operation, ticketId, {
            ...body,
            command: conflicting,
          }),
        ),
        [400],
      );
    }
    expect(await f.rows(ticketId)).toEqual(before);
  });

  it('maps each existing PATCH action to a stable SDK receipt and keeps action semantics in the fingerprint', async () => {
    const f = await fixture();
    const ticketId = await f.createTicket();
    for (const action of [
      'assign',
      'unassign',
      'change_priority',
      'resolve',
      'close',
      'reopen',
    ] as const) {
      const ids = command(f, 'operator');
      const body = {
        command: {
          version: ids.version,
          expectedAccountId: ids.expectedAccountId,
          commandId: ids.commandId,
        },
        action,
        ...(action === 'change_priority' ? { priority: 'high' } : {}),
      };
      const response = await f.api(
        operationRequest(f, 'patch', ticketId, body),
      );
      expect(response.status).toBe(200);
      const accepted = await value(response);
      const rows = await f.rows(ticketId);
      const retry = await f.api(operationRequest(f, 'patch', ticketId, body));
      expect(retry.status).toBe(200);
      expect(await value(retry)).toEqual(accepted);
      expect(await f.rows(ticketId)).toEqual(rows);
      await closedError(
        await f.api(
          operationRequest(f, 'patch', ticketId, {
            command: body.command,
            action: action === 'assign' ? 'unassign' : 'assign',
          }),
        ),
        [409],
      );
      expect(await f.rows(ticketId)).toEqual(rows);
    }
  });

  it('retains the old server-minted create behavior when the optional envelope is omitted', async () => {
    const f = await fixture();
    const body = {
      subject: 'Fictional legacy caller',
      body: 'Synthetic legacy message.',
      category: 'question',
    };
    const response = await f.api(
      request(f, '/api/support/tickets', 'owner', body),
    );
    expect(response.status).toBe(201);
    const result = await value(response);
    if (!isPlainObject(result.ticket) || typeof result.ticket.id !== 'string')
      throw new Error('Expected a real generated ticket ID.');
    expect(result.ticket.id).not.toBe('');
    expect(
      (await f.rows(result.ticket.id)).filter((row) => row.kind === 'message'),
    ).toHaveLength(1);
  });
});
