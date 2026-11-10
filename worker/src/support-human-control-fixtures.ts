import {
  createSupportDeskApplication,
  supportPermissions,
  supportRecords,
} from '@pegma/support-desk-application';
import { resolveAccess } from '@pegma/authorization-core';
import { identityLinkKeyFromVerifiedIdentityClaims } from '@pegma/authorization-identity';
import type {
  CollectionDefinition,
  CollectionStore,
  EntityKey,
  Store,
} from '@pegma/storage-core';
import { createIdentityRuntime } from './identity-runtime';
import { createSupportRuntime, PEGMA_SUPPORT_CATEGORIES } from './support-desk';
import { createSupportApi } from './support-api';
import { IDENTITY_ISSUER, SESSION_COOKIE } from './identity-api';
import {
  ADMIN_ROLE,
  APPLICATION_SCOPE,
  KNOWLEDGE_ROLE,
  SUPPORT_ROLE,
  customerAccessContext,
  staffAccessContextFromRoles,
} from './support-access';

export type HumanRoute = 'request-person' | 'take-over' | 'handoff';
export type HumanActor =
  'owner' | 'peer' | 'operator' | 'administrator' | 'knowledge' | 'both';
export const humanSecret = btoa('h'.repeat(32));
export const humanPrivateSummary = 'SYNTHETIC_PRIVATE_HANDOFF_SUMMARY';
export const humanPrivateGuide = 'synthetic-private-guide-reference';
export const humanPrivateNote = 'SYNTHETIC_PRIVATE_STAFF_NOTE';

export function humanLatch() {
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}

async function waitForGate(ready: Promise<void>, pending: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      pending.then(() => {
        throw new Error(
          'The real operation returned before its fixture barrier.',
        );
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('The fixture barrier was not reached.')),
          3000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Public SDK services over an injected real Store; no invented records/codec. */
export async function humanControlFixture(
  backing: Store,
  invoke?: (request: Request) => Promise<Response>,
) {
  const hooks: {
    read?: () => Promise<void>;
    commit?: () => Promise<void>;
    role?: () => Promise<void>;
  } = {};
  let captureUser: ((remove: () => Promise<boolean>) => void) | undefined;
  const store: Store = {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      const target = backing.collection(definition);
      if (definition.name === 'pegma_identity_users')
        return {
          ...target,
          async get(key: EntityKey) {
            const value = await target.get(key);
            if (value !== null) {
              const observed = { partition: key.partition, id: key.id };
              captureUser?.(() => target.delete(observed));
            }
            return value;
          },
        };
      if (definition.name !== supportRecords.name) return target;
      return {
        ...target,
        async list(partition: string) {
          const value = await target.list(partition);
          await hooks.read?.();
          return value;
        },
        async transact(partition, actions) {
          const value = await target.transact(partition, actions);
          if (value.committed) await hooks.commit?.();
          return value;
        },
      };
    },
  };
  const logger = { log() {} };
  const identityRuntime = createIdentityRuntime(
    {
      store,
      emailCodeSecretBase64: humanSecret,
      emailFrom: 'Pegma <synthetic@pegma.dev>',
      emailEnabled: false,
    },
    logger,
  );
  const { identity, sessions } = identityRuntime;
  const runtime = createSupportRuntime({
    store,
    sessions,
    identity,
    logger,
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
  });
  const principals = {
    owner: 'public-control-owner',
    peer: 'public-control-peer',
    operator: 'public-control-operator',
    administrator: 'public-control-admin',
    knowledge: 'public-control-knowledge',
    both: 'public-control-both',
  } as const;
  const cookies = new Map<HumanActor, string>();
  const csrf = new Map<HumanActor, string>();
  const sessionIds = new Map<HumanActor, string>();
  for (const [index, actor] of (
    Object.keys(principals) as HumanActor[]
  ).entries()) {
    const principalId = principals[actor];
    await identity.provisionVerifiedUser({
      principalId,
      email: actor + '@example.test',
    });
    const sessionId = String(index + 1).repeat(43);
    const token = String.fromCharCode(97 + index).repeat(43);
    await sessions.create(sessionId, {
      principalId,
      data: JSON.stringify({
        version: 1,
        csrfToken: token,
        issuer: IDENTITY_ISSUER,
        subject: principalId,
      }),
    });
    sessionIds.set(actor, sessionId);
    cookies.set(actor, SESSION_COOKIE + '=' + sessionId);
    csrf.set(actor, token);
    const roles =
      actor === 'operator'
        ? [SUPPORT_ROLE]
        : actor === 'administrator'
          ? [ADMIN_ROLE]
          : actor === 'knowledge'
            ? [KNOWLEDGE_ROLE]
            : actor === 'both'
              ? [ADMIN_ROLE, KNOWLEDGE_ROLE]
              : [];
    for (const role of roles)
      await runtime.roleStore.grantRoleAssignmentWithAudit({
        assignment: {
          id: 'public-control-' + actor + '-' + role,
          principalId,
          role,
          scope: APPLICATION_SCOPE,
          grantedBy: { kind: 'system', systemId: 'synthetic-public-setup' },
          grantedAtEpochMs: Date.now(),
          status: 'active',
        },
        auditEventId: crypto.randomUUID(),
      });
  }
  const api = createSupportApi({
    application: runtime.application,
    sessions,
    identity,
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
    createLimiter: runtime.createLimiter,
    replyLimiter: runtime.replyLimiter,
    logger,
    roleStore: {
      ...runtime.roleStore,
      async listActiveRoleAssignments(principalId, scope) {
        const value = await runtime.roleStore.listActiveRoleAssignments(
          principalId,
          scope,
        );
        await hooks.role?.();
        return value;
      },
    },
  });
  const producer = createSupportDeskApplication({
    store,
    clock: { now: () => new Date().toISOString() },
    assistantHandlingEnabled: true,
    allowedCategories: PEGMA_SUPPORT_CATEGORIES,
  });
  async function staffAccess() {
    const access = await staffAccessContextFromRoles(
      principals.operator,
      runtime.roleStore,
    );
    if (access === null)
      throw new Error('Synthetic operator has no current Support role.');
    return access;
  }
  async function createTicket(managed = false, notes = 0) {
    const ticketId = crypto.randomUUID();
    const access = managed
      ? resolveAccess(
          { principalId: principals.owner },
          {
            version: 'synthetic-public-producer-1',
            defaults: [
              supportPermissions.create,
              supportPermissions.assistantStart,
            ],
          },
        )
      : customerAccessContext(principals.owner);
    await (managed ? producer : runtime.application).createCustomerTicket(
      access,
      {
        commandId: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        ticketId,
        messageId: crypto.randomUUID(),
        subject: 'Synthetic public help',
        body: 'A fictional public fixture question.',
        category: 'question',
        ...(managed ? { initialHandling: 'assistant' as const } : {}),
      },
    );
    const operator = await staffAccess();
    for (let i = 0; i < notes; i++)
      await runtime.application.addNote(operator, {
        commandId: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        ticketId,
        messageId: crypto.randomUUID(),
        body: humanPrivateNote + ':' + i,
      });
    return ticketId;
  }
  async function privateEscalation(ticketId: string) {
    // An explicit synthetic service authority seeds actual SDK handoff state;
    // it is not a host role, model implementation or runtime provider grant.
    const access = resolveAccess(
      { principalId: 'synthetic-control-service' },
      {
        version: 'synthetic-service-1',
        defaults: [
          supportPermissions.assistantRead,
          supportPermissions.assistantEscalate,
        ],
      },
    );
    const current = await producer.readAssistantConversation(access, ticketId);
    if (current.triggerMessageId === undefined)
      throw new Error('Missing actual visible trigger.');
    return producer.escalateToHuman(access, {
      commandId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      ticketId,
      expectedRevision: current.revision,
      expectedHandlingGeneration: current.handling.generation,
      triggerMessageId: current.triggerMessageId,
      reason: 'other',
      summary: humanPrivateSummary,
      attemptedGuideIds: [humanPrivateGuide],
    });
  }
  function request(
    route: HumanRoute,
    ticketId: string,
    actor: HumanActor,
    packet?: unknown,
  ) {
    const path =
      route === 'request-person'
        ? '/api/support/tickets/'
        : '/api/support/admin/tickets/';
    return new Request(IDENTITY_ISSUER + path + ticketId + '/' + route, {
      method: route === 'handoff' ? 'GET' : 'POST',
      headers: {
        Cookie: cookies.get(actor)!,
        'X-Pegma-CSRF': csrf.get(actor)!,
        Origin: IDENTITY_ISSUER,
        'Sec-Fetch-Site': 'same-origin',
        ...(packet === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(packet === undefined ? {} : { body: JSON.stringify(packet) }),
    });
  }
  async function packet(ticketId: string) {
    const view = await runtime.application.readStaffTicket(
      await staffAccess(),
      ticketId,
    );
    return {
      commandId: crypto.randomUUID(),
      expectedRevision: view.ticket.revision,
      expectedHandlingGeneration: view.ticket.handling?.generation ?? 0,
    };
  }
  function block(hook: keyof typeof hooks) {
    const entered = humanLatch();
    const resume = humanLatch();
    hooks[hook] = async () => {
      hooks[hook] = undefined;
      entered.release();
      await resume.ready;
    };
    return {
      entered: entered.ready,
      release: resume.release,
      waitFor: (pending: Promise<unknown>) =>
        waitForGate(entered.ready, pending),
    };
  }
  return {
    store,
    identity,
    sessions,
    runtime,
    api: invoke ?? api,
    principals,
    cookies,
    csrf,
    producer,
    createTicket,
    staffAccess,
    privateEscalation,
    request,
    packet,
    block,
    rows: (ticketId: string) =>
      backing.collection(supportRecords).list(ticketId),
    async revokeSession(actor: HumanActor) {
      await sessions.destroy(sessionIds.get(actor)!);
    },
    async revokeSupport() {
      const row = await runtime.roleStore.getRoleAssignment(
        'public-control-operator-' + SUPPORT_ROLE,
      );
      if (row === null) throw new Error('Missing genuine Support assignment.');
      return runtime.roleStore.revokeRoleAssignmentWithAudit({
        assignmentId: row.assignment.id,
        expectedConcurrencyToken: row.concurrencyToken,
        revokedBy: { kind: 'principal', principalId: principals.administrator },
        revokedAtEpochMs: Date.now(),
        auditEventId: crypto.randomUUID(),
      });
    },
    async restoreSupport() {
      return runtime.roleStore.grantRoleAssignmentWithAudit({
        assignment: {
          id: crypto.randomUUID(),
          principalId: principals.operator,
          role: SUPPORT_ROLE,
          scope: APPLICATION_SCOPE,
          grantedBy: {
            kind: 'principal',
            principalId: principals.administrator,
          },
          grantedAtEpochMs: Date.now(),
          status: 'active',
        },
        auditEventId: crypto.randomUUID(),
      });
    },
    async removeIdentity(actor: HumanActor) {
      const observed: { remove?: () => Promise<boolean> } = {};
      captureUser = (operation) => {
        observed.remove = operation;
      };
      try {
        await identity.getUser(principals[actor]);
      } finally {
        captureUser = undefined;
      }
      const remove = observed.remove;
      if (remove === undefined)
        throw new Error('No actual user row was observed.');
      return remove();
    },
  };
}

export async function controlledHumanBody(base: Request) {
  const data = new TextEncoder().encode(await base.text());
  const reading = humanLatch();
  const resume = humanLatch();
  let source: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  let sent = 0;
  let cancellations = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        source = controller;
      },
      pull() {
        reading.release();
        return resume.ready;
      },
      cancel() {
        closed = true;
        cancellations += 1;
      },
    },
    { highWaterMark: 0 },
  );
  const init: RequestInit & { duplex: 'half' } = {
    method: 'POST',
    headers: base.headers,
    body: stream,
    duplex: 'half',
  };
  return {
    request: new Request(base.url, init),
    reading: reading.ready,
    waitFor: (pending: Promise<unknown>) => waitForGate(reading.ready, pending),
    get cancellations() {
      return cancellations;
    },
    trickle() {
      if (closed || source === undefined) throw new Error('Body is closed.');
      const end = Math.min(data.length, sent + 8);
      source.enqueue(data.slice(sent, end));
      sent = end;
    },
    complete() {
      if (!closed && source !== undefined) {
        source.enqueue(data.slice(sent));
        source.close();
        closed = true;
      }
      resume.release();
    },
  };
}
