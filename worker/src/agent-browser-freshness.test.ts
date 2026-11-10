import type {
  ApproveInput,
  GrantType,
  PublicClient,
} from '@pegma/agent-access';
import { identityLinkKeyFromVerifiedIdentityClaims } from '@pegma/authorization-identity';
import { createRoleStore } from '@pegma/authorization-storage';
import { KnowledgeBaseNotFoundError } from '@pegma/knowledge-base-application';
import { createSessionStore } from '@pegma/sessions';
import {
  createMemoryStore,
  type CollectionDefinition,
  type CollectionStore,
  type Store,
} from '@pegma/storage-core';
import { describe, expect, it, vi } from 'vitest';
import {
  createAgentAccessRuntime,
  AGENT_RESOURCE,
} from './agent-access-runtime';
import { isPlainObject } from './api-auth';
import { createAgentPrincipalResolver } from './agent-authority';
import { IDENTITY_ISSUER, SESSION_COOKIE } from './identity-api';
import { createIdentityRuntime } from './identity-runtime';
import { createKnowledgeRuntime } from './knowledge-runtime';
import {
  ADMIN_ROLE,
  AGENT_KNOWLEDGE_PERMISSIONS,
  APPLICATION_SCOPE,
  AUTHORIZATION_APPLICATION_ID,
} from './support-access';

const owner = 'synthetic-browser-owner';
const other = 'synthetic-browser-other-admin';
const client: PublicClient = {
  clientId: 'synthetic-browser-freshness-client',
  name: 'Synthetic browser freshness client',
  redirectUris: ['https://client.example.test/callback'],
  allowedScopes: [...AGENT_KNOWLEDGE_PERMISSIONS],
  grantTypes: ['device_code', 'authorization_code'],
};

function barrier() {
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}

interface StoreHooks {
  afterGrantRead: (() => Promise<void>) | undefined;
  afterGrantCommit: (() => Promise<void>) | undefined;
  afterKbRead: (() => Promise<void>) | undefined;
  afterKbCommit: (() => Promise<void>) | undefined;
  beforeSessionRead: (() => Promise<void>) | undefined;
}

/** Only delay real adapter operations; all records and authority are real. */
function observedStore(backing: Store, hooks: StoreHooks): Store {
  return {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      const target = backing.collection(definition);
      const grant = definition.name === 'agent-access.records.v1';
      const kb = definition.name === 'knowledge-base.records.v1';
      const session = definition.name === 'sessions';
      if (!grant && !kb && !session) return target;
      return {
        ...target,
        async get(key) {
          if (session) await hooks.beforeSessionRead?.();
          const result = await target.get(key);
          if (kb) await hooks.afterKbRead?.();
          return result;
        },
        async getVersioned(key) {
          if (session) await hooks.beforeSessionRead?.();
          const value = await target.getVersioned(key);
          if (grant) await hooks.afterGrantRead?.();
          if (kb) await hooks.afterKbRead?.();
          return value;
        },
        async transact(partition, actions) {
          const result = await target.transact(partition, actions);
          if (result.committed) {
            if (grant) await hooks.afterGrantCommit?.();
            if (kb) await hooks.afterKbCommit?.();
          }
          return result;
        },
      };
    },
  };
}

async function value(
  response: Response | null,
): Promise<Record<string, unknown>> {
  if (response === null) throw new Error('Expected the actual browser route.');
  const result: unknown = await response.json();
  if (!isPlainObject(result)) throw new Error('Expected a JSON object.');
  return result;
}

async function fixture() {
  const backing = createMemoryStore();
  const hooks: StoreHooks = {
    afterGrantRead: undefined,
    afterGrantCommit: undefined,
    afterKbRead: undefined,
    afterKbCommit: undefined,
    beforeSessionRead: undefined,
  };
  const store = observedStore(backing, hooks);
  const logger = { log() {} };
  const clock = { now: () => new Date().toISOString() };
  const identity = createIdentityRuntime(
    {
      store,
      emailCodeSecretBase64: btoa('s'.repeat(32)),
      emailFrom: 'Pegma <identity@example.test>',
      emailEnabled: false,
    },
    logger,
  ).identity;
  const sessions = createSessionStore(store, { logger, clock });
  const roleStore = createRoleStore(store, AUTHORIZATION_APPLICATION_ID);
  const cookies = new Map<string, string>();
  const sessionIds = new Map<string, string>();
  for (const [index, principalId] of [owner, other].entries()) {
    await identity.provisionVerifiedUser({
      principalId,
      email: principalId + '@example.test',
    });
    await roleStore.grantRoleAssignmentWithAudit({
      assignment: {
        id: 'admin-' + principalId,
        principalId,
        role: ADMIN_ROLE,
        scope: APPLICATION_SCOPE,
        grantedBy: { kind: 'system', systemId: 'synthetic-browser-setup' },
        grantedAtEpochMs: Date.now(),
        status: 'active',
      },
      auditEventId: 'grant-' + principalId,
    });
    const sessionId = String(index) + 's'.repeat(42);
    await sessions.create(sessionId, {
      principalId,
      data: JSON.stringify({
        version: 1,
        csrfToken: 'c'.repeat(43),
        issuer: IDENTITY_ISSUER,
        subject: principalId,
      }),
    });
    cookies.set(principalId, SESSION_COOKIE + '=' + sessionId);
    sessionIds.set(principalId, sessionId);
  }
  const options = {
    store,
    clock,
    logger,
    identity,
    sessions,
    roleStore,
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
  };
  const candidateRuntime = createAgentAccessRuntime({
    ...options,
    clients: [client],
  });
  if (candidateRuntime === null)
    throw new Error('Expected the explicitly registered synthetic client.');
  const runtime = candidateRuntime;
  const knowledge = createKnowledgeRuntime({
    ...options,
    agentAccess: runtime,
  });
  const resolve = createAgentPrincipalResolver(options);
  async function access(principalId = other) {
    const current = await resolve(principalId);
    if (current === null) throw new Error('Expected a current real principal.');
    return current;
  }
  function cookie(principalId: string) {
    const found = cookies.get(principalId);
    if (found === undefined)
      throw new Error('Expected an actual session cookie.');
    return found;
  }
  function browser(
    path: string,
    method = 'GET',
    input?: unknown,
    principalId = owner,
  ) {
    return new Request(IDENTITY_ISSUER + path, {
      method,
      headers: {
        Cookie: cookie(principalId),
        Origin: IDENTITY_ISSUER,
        'Sec-Fetch-Site': 'same-origin',
        'X-Pegma-CSRF': 'c'.repeat(43),
        ...(input === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
  }
  async function prepared() {
    const device = await runtime.service.beginDeviceAuthorization({
      clientId: client.clientId,
      resource: AGENT_RESOURCE,
      scopes: [...AGENT_KNOWLEDGE_PERMISSIONS],
    });
    const viewed = await runtime.api(
      browser(
        '/api/agent-access/approval?user_code=' +
          encodeURIComponent(device.user_code),
      ),
    );
    expect(viewed?.status).toBe(200);
    const view = await value(viewed);
    if (typeof view.requestId !== 'string')
      throw new Error('Expected the real approval request ID.');
    return {
      device,
      requestId: view.requestId,
      input: {
        requestId: view.requestId,
        decision: 'approve',
        userCode: device.user_code,
        approvedScopes: [...AGENT_KNOWLEDGE_PERMISSIONS],
      } satisfies ApproveInput,
    };
  }
  async function approved() {
    const pending = await prepared();
    expect(
      (
        await runtime.api(
          browser('/api/agent-access/approval', 'POST', pending.input),
        )
      )?.status,
    ).toBe(200);
    const loaded = await runtime.api(
      browser('/api/agent-access/grants/' + pending.requestId),
    );
    expect(loaded?.status).toBe(200);
    const grant = await value(loaded);
    if (typeof grant.grantId !== 'string')
      throw new Error('Expected the actual returned GrantView identity.');
    return { ...pending, grantId: grant.grantId };
  }
  async function pendingApproval(flow: GrantType) {
    if (flow === 'device_code') {
      const pending = await prepared();
      return {
        requestId: pending.requestId,
        input: pending.input,
        viewPath:
          '/api/agent-access/approval?user_code=' +
          encodeURIComponent(pending.device.user_code),
        async issue(result: Record<string, unknown>) {
          expect(result).toMatchObject({ flow, approved: true });
          return runtime.service.pollDeviceToken({
            clientId: client.clientId,
            resource: AGENT_RESOURCE,
            deviceCode: pending.device.device_code,
          });
        },
      };
    }
    const codeVerifier = 'v'.repeat(43);
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(codeVerifier),
    );
    const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/gu, '-')
      .replace(/\//gu, '_')
      .replace(/=+$/gu, '');
    const request = await runtime.service.beginAuthorization(
      { authentication: 'browser-session', access: await access(owner) },
      {
        clientId: client.clientId,
        resource: AGENT_RESOURCE,
        scopes: [...AGENT_KNOWLEDGE_PERMISSIONS],
        redirectUri: client.redirectUris[0]!,
        codeChallenge,
        codeChallengeMethod: 'S256',
        state: 'synthetic-delayed-consent',
      },
    );
    expect(request.status).toBe('pending');
    return {
      requestId: request.requestId,
      input: {
        requestId: request.requestId,
        decision: 'approve',
        approvedScopes: [...AGENT_KNOWLEDGE_PERMISSIONS],
      } satisfies ApproveInput,
      viewPath:
        '/api/agent-access/approval?request_id=' +
        encodeURIComponent(request.requestId),
      async issue(result: Record<string, unknown>) {
        expect(result.flow).toBe(flow);
        if (typeof result.redirectUri !== 'string')
          throw new Error('Expected the actual PKCE approval redirect.');
        const redirect = new URL(result.redirectUri);
        expect(redirect.origin + redirect.pathname).toBe(
          client.redirectUris[0],
        );
        expect(redirect.searchParams.get('state')).toBe(
          'synthetic-delayed-consent',
        );
        const code = redirect.searchParams.get('code');
        if (code === null)
          throw new Error('Expected an actual authorization code.');
        return runtime.service.exchangeAuthorizationCode({
          clientId: client.clientId,
          resource: AGENT_RESOURCE,
          code,
          redirectUri: client.redirectUris[0]!,
          codeVerifier,
        });
      },
    };
  }
  async function revokeAdmin() {
    const assignment = await roleStore.getRoleAssignment('admin-' + owner);
    if (assignment === null)
      throw new Error('Expected the actual active assignment.');
    expect(
      (
        await roleStore.revokeRoleAssignmentWithAudit({
          assignmentId: assignment.assignment.id,
          expectedConcurrencyToken: assignment.concurrencyToken,
          revokedBy: { kind: 'principal', principalId: other },
          revokedAtEpochMs: Date.now(),
          auditEventId: 'revoke-browser-admin',
        })
      ).status,
    ).toBe('revoked');
  }
  async function restoreAdmin() {
    await roleStore.grantRoleAssignmentWithAudit({
      assignment: {
        id: 'restored-admin-' + owner,
        principalId: owner,
        role: ADMIN_ROLE,
        scope: APPLICATION_SCOPE,
        grantedBy: { kind: 'principal', principalId: other },
        grantedAtEpochMs: Date.now(),
        status: 'active',
      },
      auditEventId: 'restore-browser-admin',
    });
  }
  async function revokeSession() {
    const sessionId = sessionIds.get(owner);
    if (sessionId === undefined)
      throw new Error('Expected the actual owner session.');
    await sessions.destroy(sessionId);
  }
  async function restoreSession() {
    const sessionId = 'r'.repeat(43);
    await sessions.create(sessionId, {
      principalId: owner,
      data: JSON.stringify({
        version: 1,
        csrfToken: 'c'.repeat(43),
        issuer: IDENTITY_ISSUER,
        subject: owner,
      }),
    });
    cookies.set(owner, SESSION_COOKIE + '=' + sessionId);
    sessionIds.set(owner, sessionId);
  }
  function block(hook: keyof StoreHooks) {
    const entered = barrier();
    const resume = barrier();
    hooks[hook] = async () => {
      hooks[hook] = undefined;
      entered.release();
      await resume.ready;
    };
    return {
      waitFor: (operation: Promise<unknown>) =>
        Promise.race([
          entered.ready,
          operation.then(() => {
            throw new Error('The operation ended before its storage barrier.');
          }),
        ]),
      release: resume.release,
    };
  }
  return {
    runtime,
    knowledge,
    access,
    hooks,
    browser,
    cookie,
    prepared,
    pendingApproval,
    approved,
    revokeAdmin,
    restoreAdmin,
    revokeSession,
    restoreSession,
    block,
  };
}

describe('actual current browser authority after AA service awaits', () => {
  it('keeps the original owner-only grant view and browser protections', async () => {
    const f = await fixture();
    const grant = await f.approved();
    const own = await f.runtime.api(
      f.browser('/api/agent-access/grants/' + grant.grantId),
    );
    expect(own?.status).toBe(200);
    expect(await value(own)).toMatchObject({
      grantId: grant.grantId,
      ownerId: owner,
    });
    expect(
      (
        await f.runtime.api(
          f.browser(
            '/api/agent-access/grants/' + grant.grantId,
            'GET',
            undefined,
            other,
          ),
        )
      )?.status,
    ).toBe(403);
    const csrf = f.browser(
      '/api/agent-access/grants/' + grant.grantId,
      'DELETE',
    );
    csrf.headers.delete('X-Pegma-CSRF');
    expect((await f.runtime.api(csrf))?.status).toBe(403);
    const foreign = f.browser(
      '/api/agent-access/grants/' + grant.grantId,
      'DELETE',
    );
    foreign.headers.set('Origin', 'https://foreign.example.test');
    expect((await f.runtime.api(foreign))?.status).toBe(403);
    expect(
      (
        await f.runtime.api(
          f.browser('/api/agent-access/grants/' + grant.grantId),
        )
      )?.status,
    ).toBe(200);
  });

  it.each(['role', 'session'] as const)(
    'withholds the private owned-grant DTO after %s revocation during its real AA read',
    async (kind) => {
      const f = await fixture();
      const grant = await f.approved();
      const blocked = f.block('afterGrantRead');
      const pending = f.runtime.api(
        f.browser('/api/agent-access/grants/' + grant.grantId),
      );
      await blocked.waitFor(pending);
      try {
        if (kind === 'role') await f.revokeAdmin();
        else await f.revokeSession();
      } finally {
        blocked.release();
      }
      const result = await pending;
      expect(result?.status).toBe(kind === 'role' ? 403 : 401);
      const denied = await value(result);
      expect(denied).not.toHaveProperty('grantId');
      expect(denied).not.toHaveProperty('scopes');
      expect(denied).not.toHaveProperty('ownerId');
    },
  );

  it('withholds a private approval view after stored Admin revocation during its real head read', async () => {
    const f = await fixture();
    const request = await f.prepared();
    const blocked = f.block('afterGrantRead');
    const pending = f.runtime.api(
      f.browser(
        '/api/agent-access/approval?user_code=' +
          encodeURIComponent(request.device.user_code),
      ),
    );
    await blocked.waitFor(pending);
    try {
      await f.revokeAdmin();
    } finally {
      blocked.release();
    }
    const result = await pending;
    expect(result?.status).toBe(403);
    expect(await value(result)).not.toHaveProperty('requestedScopes');
  });

  it('binds the response to the original browser principal even if a different current Admin session replaces it', async () => {
    const f = await fixture();
    const grant = await f.approved();
    const request = f.browser('/api/agent-access/grants/' + grant.grantId);
    const blocked = f.block('afterGrantRead');
    const pending = f.runtime.api(request);
    await blocked.waitFor(pending);
    request.headers.set('Cookie', f.cookie(other));
    blocked.release();
    const result = await pending;
    expect(result?.status).toBe(403);
    expect(await value(result)).not.toHaveProperty('grantId');
  });

  it('withholds a committed approval ACK after Admin removal and retains the actual approval', async () => {
    const f = await fixture();
    const request = await f.prepared();
    const blocked = f.block('afterGrantCommit');
    const pending = f.runtime.api(
      f.browser('/api/agent-access/approval', 'POST', request.input),
    );
    await blocked.waitFor(pending);
    try {
      await f.revokeAdmin();
    } finally {
      blocked.release();
    }
    const result = await pending;
    expect(result?.status).toBe(403);
    expect(await value(result)).not.toHaveProperty('approved');
    await f.restoreAdmin();
    const retained = await f.runtime.api(
      f.browser(
        '/api/agent-access/approval?user_code=' +
          encodeURIComponent(request.device.user_code),
      ),
    );
    expect(retained?.status).toBe(200);
    expect(await value(retained)).toMatchObject({
      requestId: request.requestId,
      status: 'approved',
    });
  });

  it('withholds a committed revoke ACK after Admin removal and retains the actual revocation', async () => {
    const f = await fixture();
    const grant = await f.approved();
    const blocked = f.block('afterGrantCommit');
    const pending = f.runtime.api(
      f.browser('/api/agent-access/grants/' + grant.grantId, 'DELETE'),
    );
    await blocked.waitFor(pending);
    try {
      await f.revokeAdmin();
    } finally {
      blocked.release();
    }
    const result = await pending;
    expect(result?.status).toBe(403);
    expect(await value(result)).toMatchObject({ error: 'forbidden' });
    await f.restoreAdmin();
    const retained = await f.runtime.api(
      f.browser('/api/agent-access/grants/' + grant.grantId),
    );
    expect(retained?.status).toBe(200);
    expect(await value(retained)).toMatchObject({
      grantId: grant.grantId,
      status: 'revoked',
    });
  });
});

function staffInput(collectionId: string) {
  return {
    operation: 'createCollection',
    input: {
      commandId: 'create-' + collectionId,
      correlationId: 'synthetic-browser-command',
      expectedGeneration: 0,
      collectionId,
      name: 'Private synthetic collection',
    },
  };
}

function delayedCommand(base: Request, input: unknown) {
  const reading = barrier();
  const resume = barrier();
  let pulled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        pulled = true;
        reading.release();
        await resume.ready;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(input)));
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const options = {
    method: 'POST',
    headers: base.headers,
    body,
    duplex: 'half',
  };
  return {
    request: new Request(base.url, options),
    get pulled() {
      return pulled;
    },
    waitFor: (operation: Promise<unknown>) =>
      Promise.race([
        reading.ready,
        operation.then(() => {
          throw new Error('Expected the bounded body read.');
        }),
      ]),
    release: resume.release,
  };
}

function controlledApprovalBody(base: Request, input: ApproveInput) {
  const encoded = new TextEncoder().encode(JSON.stringify(input));
  const reading = barrier();
  const releasePull = barrier();
  let source: ReadableStreamDefaultController<Uint8Array> | undefined;
  let closed = false;
  let sent = 0;
  const cancel = vi.fn(() => {
    closed = true;
  });
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        source = controller;
      },
      pull() {
        reading.release();
        return releasePull.ready;
      },
      cancel,
    },
    { highWaterMark: 0 },
  );
  const options: RequestInit & { duplex: 'half' } = {
    method: 'POST',
    headers: base.headers,
    body: stream,
    duplex: 'half',
  };
  return {
    request: new Request(base.url, options),
    reading: reading.ready,
    cancel,
    trickle() {
      if (closed || source === undefined)
        throw new Error('The actual consent body is no longer open.');
      const end = Math.min(encoded.length, sent + 8);
      source.enqueue(encoded.slice(sent, end));
      sent = end;
    },
    complete() {
      if (!closed && source !== undefined) {
        source.enqueue(encoded.slice(sent));
        sent = encoded.length;
        source.close();
        closed = true;
      }
      releasePull.release();
    },
  };
}

describe.each(['device_code', 'authorization_code'] as const)(
  'authenticated %s consent body deadline',
  (flow) => {
    it.each(['stalled', 'trickled'] as const)(
      'rejects a %s body at the total deadline without persisting approval',
      async (kind) => {
        const f = await fixture();
        const approval = await f.pendingApproval(flow);
        let commits = 0;
        f.hooks.afterGrantCommit = async () => {
          commits += 1;
        };
        const body = controlledApprovalBody(
          f.browser('/api/agent-access/approval', 'POST', approval.input),
          approval.input,
        );
        vi.useFakeTimers({
          toFake: ['setTimeout', 'clearTimeout', 'performance'],
        });
        let settled = false;
        const pending = f.runtime.api(body.request).finally(() => {
          settled = true;
        });
        try {
          await body.reading;
          expect(commits).toBe(0);
          await vi.advanceTimersByTimeAsync(9_000);
          if (kind === 'trickled') body.trickle();
          await vi.advanceTimersByTimeAsync(999);
          expect(settled).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
          // The old unbounded route fails here; finally releases its actual
          // body so ROOT's RED run cannot leave the consent operation parked.
          expect(settled).toBe(true);
          const result = await pending;
          expect(result?.status).toBe(408);
          expect(await value(result)).toEqual({ error: 'request_timeout' });
          expect(body.cancel).toHaveBeenCalledTimes(1);
          expect(body.request.body?.locked).toBe(false);
          expect(commits).toBe(0);
          const retained = await f.runtime.api(f.browser(approval.viewPath));
          expect(retained?.status).toBe(200);
          expect(await value(retained)).toMatchObject({
            requestId: approval.requestId,
            flow,
            status: 'pending',
          });
          expect(commits).toBe(0);
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          body.complete();
          try {
            await pending;
          } finally {
            vi.useRealTimers();
          }
        }
      },
    );

    it('approves the real request and issues tokens when its body completes before expiry', async () => {
      const f = await fixture();
      const approval = await f.pendingApproval(flow);
      let commits = 0;
      f.hooks.afterGrantCommit = async () => {
        commits += 1;
      };
      const body = controlledApprovalBody(
        f.browser('/api/agent-access/approval', 'POST', approval.input),
        approval.input,
      );
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'performance'],
      });
      let settled = false;
      const pending = f.runtime.api(body.request).finally(() => {
        settled = true;
      });
      try {
        await body.reading;
        await vi.advanceTimersByTimeAsync(9_999);
        expect(settled).toBe(false);
        expect(commits).toBe(0);
        body.complete();
        const result = await pending;
        expect(result?.status).toBe(200);
        expect(commits).toBe(1);
        const tokens = await approval.issue(await value(result));
        expect(tokens.token_type).toBe('Bearer');
        expect(tokens.refresh_token).toEqual(expect.any(String));
        expect(
          await f.runtime.service.authenticate({
            token: tokens.access_token,
            resource: AGENT_RESOURCE,
          }),
        ).toMatchObject({
          clientId: client.clientId,
          access: { principalId: owner },
        });
        expect(body.cancel).not.toHaveBeenCalled();
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
    });
  },
);

describe('actual AA approval authority after delayed browser input', () => {
  it.each(['device_code', 'authorization_code'] as const)(
    'approves a pending %s request for the same current Admin after delayed input',
    async (flow) => {
      const f = await fixture();
      const approval = await f.pendingApproval(flow);
      let commits = 0;
      f.hooks.afterGrantCommit = async () => {
        commits += 1;
      };
      const delayed = delayedCommand(
        f.browser('/api/agent-access/approval', 'POST', approval.input),
        approval.input,
      );
      const pending = f.runtime.api(delayed.request);
      try {
        await delayed.waitFor(pending);
        expect(commits).toBe(0);
      } finally {
        delayed.release();
      }
      const result = await pending;
      expect(result?.status).toBe(200);
      expect(commits).toBe(1);
      const tokens = await approval.issue(await value(result));
      expect(tokens.token_type).toBe('Bearer');
      expect(tokens.access_token).toEqual(expect.any(String));
      expect(tokens.refresh_token).toEqual(expect.any(String));
      expect(
        await f.runtime.service.authenticate({
          token: tokens.access_token,
          resource: AGENT_RESOURCE,
        }),
      ).toMatchObject({
        clientId: client.clientId,
        access: { principalId: owner },
      });
    },
  );

  it.each([
    ['device_code', 'session'],
    ['device_code', 'role'],
    ['authorization_code', 'session'],
    ['authorization_code', 'role'],
  ] as const)(
    'leaves the actual %s request pending when %s is revoked while reading its body',
    async (flow, revoked) => {
      const f = await fixture();
      const approval = await f.pendingApproval(flow);
      let commits = 0;
      f.hooks.afterGrantCommit = async () => {
        commits += 1;
      };
      const delayed = delayedCommand(
        f.browser('/api/agent-access/approval', 'POST', approval.input),
        approval.input,
      );
      const pending = f.runtime.api(delayed.request);
      try {
        await delayed.waitFor(pending);
        expect(commits).toBe(0);
        if (revoked === 'session') await f.revokeSession();
        else await f.revokeAdmin();
      } finally {
        delayed.release();
      }
      const result = await pending;
      expect(result?.status).toBe(revoked === 'session' ? 401 : 403);
      const denied = await value(result);
      expect(denied).not.toHaveProperty('approved');
      expect(denied).not.toHaveProperty('redirectUri');
      expect(denied).not.toHaveProperty('access_token');
      expect(denied).not.toHaveProperty('refresh_token');
      // Observe real AA commits, not just the final withheld HTTP response.
      expect(commits).toBe(0);
      if (revoked === 'session') await f.restoreSession();
      else await f.restoreAdmin();
      const retained = await f.runtime.api(f.browser(approval.viewPath));
      expect(retained?.status).toBe(200);
      expect(await value(retained)).toMatchObject({
        requestId: approval.requestId,
        flow,
        status: 'pending',
      });
      expect(commits).toBe(0);
    },
  );

  it.each([
    ['device_code', 'same-owner'],
    ['device_code', 'other-admin'],
    ['authorization_code', 'same-owner'],
    ['authorization_code', 'other-admin'],
  ] as const)(
    'refuses delayed %s consent after a %s browser-session replacement',
    async (flow, replacement) => {
      const f = await fixture();
      const approval = await f.pendingApproval(flow);
      let commits = 0;
      f.hooks.afterGrantCommit = async () => {
        commits += 1;
      };
      const delayed = delayedCommand(
        f.browser('/api/agent-access/approval', 'POST', approval.input),
        approval.input,
      );
      const pending = f.runtime.api(delayed.request);
      try {
        await delayed.waitFor(pending);
        if (replacement === 'same-owner') await f.restoreSession();
        delayed.request.headers.set(
          'Cookie',
          f.cookie(replacement === 'same-owner' ? owner : other),
        );
      } finally {
        delayed.release();
      }
      expect((await pending)?.status).toBe(403);
      expect(commits).toBe(0);
      const retained = await f.runtime.api(f.browser(approval.viewPath));
      expect(retained?.status).toBe(200);
      expect(await value(retained)).toMatchObject({
        requestId: approval.requestId,
        status: 'pending',
      });
    },
  );

  it.each(['device_code', 'authorization_code'] as const)(
    'refuses a header swap during awaited post-body session authentication for %s',
    async (flow) => {
      const f = await fixture();
      const approval = await f.pendingApproval(flow);
      let commits = 0;
      f.hooks.afterGrantCommit = async () => {
        commits += 1;
      };
      const delayed = delayedCommand(
        f.browser('/api/agent-access/approval', 'POST', approval.input),
        approval.input,
      );
      const pending = f.runtime.api(delayed.request);
      let blocked: ReturnType<typeof f.block> | undefined;
      try {
        await delayed.waitFor(pending);
        blocked = f.block('beforeSessionRead');
        delayed.release();
        await blocked.waitFor(pending);
        delayed.request.headers.set('Cookie', f.cookie(other));
      } finally {
        delayed.release();
        blocked?.release();
      }
      expect((await pending)?.status).toBe(403);
      expect(commits).toBe(0);
      const retained = await f.runtime.api(f.browser(approval.viewPath));
      expect(retained?.status).toBe(200);
      expect(await value(retained)).toMatchObject({
        requestId: approval.requestId,
        status: 'pending',
      });
    },
  );
});

describe('staff KB command browser authority around bounded input and real SDK work', () => {
  it('executes a current authorized browser command through the actual KB service', async () => {
    const f = await fixture();
    const input = staffInput('browser-allowed');
    const result = await f.knowledge.handle(
      f.browser('/api/staff/knowledge/command', 'POST', input),
    );
    expect(result?.status).toBe(200);
    expect(await value(result)).toMatchObject({ replayed: false });
    expect(
      await f.knowledge.application.getCollection(await f.access(), {
        collectionId: input.input.collectionId,
      }),
    ).toMatchObject({ collection: { name: input.input.name } });
  });

  it.each(['session', 'role'] as const)(
    'refuses %s revocation during delayed input before any protected read or write',
    async (kind) => {
      const f = await fixture();
      const input = staffInput('browser-body-' + kind);
      const delayed = delayedCommand(
        f.browser('/api/staff/knowledge/command', 'POST', input),
        input,
      );
      let kbReads = 0;
      f.hooks.afterKbRead = async () => {
        kbReads += 1;
      };
      const pending = f.knowledge.handle(delayed.request);
      await delayed.waitFor(pending);
      expect(kbReads).toBe(0);
      try {
        if (kind === 'session') await f.revokeSession();
        else await f.revokeAdmin();
      } finally {
        delayed.release();
      }
      const result = await pending;
      expect(result?.status).toBe(kind === 'session' ? 401 : 403);
      expect(kbReads).toBe(0);
      await expect(
        f.knowledge.application.getCollection(await f.access(), {
          collectionId: input.input.collectionId,
        }),
      ).rejects.toBeInstanceOf(KnowledgeBaseNotFoundError);
    },
  );

  it.each(['Cookie', 'Origin', 'X-Pegma-CSRF', 'Authorization'] as const)(
    'refuses original %s changes during input even when another current session is valid',
    async (header) => {
      const f = await fixture();
      const input = staffInput('browser-header-' + header);
      const delayed = delayedCommand(
        f.browser('/api/staff/knowledge/command', 'POST', input),
        input,
      );
      const pending = f.knowledge.handle(delayed.request);
      await delayed.waitFor(pending);
      try {
        delayed.request.headers.set(
          header,
          header === 'Cookie'
            ? f.cookie(other)
            : header === 'Origin'
              ? 'https://foreign.example.test'
              : header === 'X-Pegma-CSRF'
                ? 'd'.repeat(43)
                : 'Bearer synthetic-forbidden',
        );
      } finally {
        delayed.release();
      }
      expect((await pending)?.status).toBe(403);
      await expect(
        f.knowledge.application.getCollection(await f.access(), {
          collectionId: input.input.collectionId,
        }),
      ).rejects.toBeInstanceOf(KnowledgeBaseNotFoundError);
    },
  );

  it('refuses a current session swap while full post-body authentication awaits real session storage', async () => {
    const f = await fixture();
    const input = staffInput('browser-auth-swap');
    const blocked = f.block('beforeSessionRead');
    const request = f.browser('/api/staff/knowledge/command', 'POST', input);
    const pending = f.knowledge.handle(request);
    await blocked.waitFor(pending);
    try {
      request.headers.set('Cookie', f.cookie(other));
    } finally {
      blocked.release();
    }
    expect((await pending)?.status).toBe(403);
    await expect(
      f.knowledge.application.getCollection(await f.access(), {
        collectionId: input.input.collectionId,
      }),
    ).rejects.toBeInstanceOf(KnowledgeBaseNotFoundError);
  });

  it.each(['missing_cookie', 'bearer', 'origin', 'csrf', 'oversize'] as const)(
    'rejects %s before consuming command bytes or reading KB facts',
    async (kind) => {
      const f = await fixture();
      const input = staffInput('browser-static-' + kind);
      const delayed = delayedCommand(
        f.browser('/api/staff/knowledge/command', 'POST', input),
        input,
      );
      if (kind === 'missing_cookie') delayed.request.headers.delete('Cookie');
      if (kind === 'bearer')
        delayed.request.headers.set(
          'Authorization',
          'Bearer synthetic-forbidden',
        );
      if (kind === 'origin')
        delayed.request.headers.set('Origin', 'https://foreign.example.test');
      if (kind === 'csrf') delayed.request.headers.delete('X-Pegma-CSRF');
      if (kind === 'oversize')
        delayed.request.headers.set('Content-Length', String(64 * 1024 + 1));
      let kbReads = 0;
      f.hooks.afterKbRead = async () => {
        kbReads += 1;
      };
      try {
        const result = await f.knowledge.handle(delayed.request);
        expect(result?.status).toBe(
          kind === 'missing_cookie' ? 401 : kind === 'oversize' ? 413 : 403,
        );
        expect(delayed.pulled).toBe(false);
        expect(kbReads).toBe(0);
      } finally {
        delayed.release();
      }
    },
  );

  it('bounds actual input bytes and exposes the explicit malformed-cookie JSON-error precedence', async () => {
    const f = await fixture();
    const base = f.browser('/api/staff/knowledge/command', 'POST', {});
    base.headers.set('Cookie', 'malformed-but-bounded');
    const invalid = await f.knowledge.handle(
      new Request(base.url, {
        method: 'POST',
        headers: base.headers,
        body: '{',
      }),
    );
    expect(invalid?.status).toBe(400);
    expect(await value(invalid)).toEqual({ error: 'invalid_json' });
    const oversized = await f.knowledge.handle(
      new Request(base.url, {
        method: 'POST',
        headers: base.headers,
        body: JSON.stringify({
          operation: 'createCollection',
          input: 'x'.repeat(64 * 1024),
        }),
      }),
    );
    expect(oversized?.status).toBe(413);
  });

  it.each(['session', 'role'] as const)(
    'withholds private collection content after %s revocation during actual KB reads',
    async (kind) => {
      const f = await fixture();
      const input = staffInput('browser-read-' + kind);
      await f.knowledge.application.createCollection(
        await f.access(),
        input.input,
      );
      const blocked = f.block('afterKbRead');
      const pending = f.knowledge.handle(
        f.browser('/api/staff/knowledge/command', 'POST', {
          operation: 'getCollection',
          input: { collectionId: input.input.collectionId },
        }),
      );
      await blocked.waitFor(pending);
      try {
        if (kind === 'session') await f.revokeSession();
        else await f.revokeAdmin();
      } finally {
        blocked.release();
      }
      const result = await pending;
      expect(result?.status).toBe(kind === 'session' ? 401 : 403);
      expect(JSON.stringify(await value(result))).not.toContain(
        input.input.name,
      );
    },
  );

  it.each(['session', 'role'] as const)(
    'withholds a committed command ACK after %s revocation and preserves the actual collection',
    async (kind) => {
      const f = await fixture();
      const input = staffInput('browser-commit-' + kind);
      const blocked = f.block('afterKbCommit');
      const pending = f.knowledge.handle(
        f.browser('/api/staff/knowledge/command', 'POST', input),
      );
      await blocked.waitFor(pending);
      try {
        if (kind === 'session') await f.revokeSession();
        else await f.revokeAdmin();
      } finally {
        blocked.release();
      }
      const result = await pending;
      expect(result?.status).toBe(kind === 'session' ? 401 : 403);
      expect(await value(result)).not.toHaveProperty('value');
      expect(
        await f.knowledge.application.getCollection(await f.access(), {
          collectionId: input.input.collectionId,
        }),
      ).toMatchObject({ collection: { name: input.input.name } });
    },
  );

  it('withholds a committed command ACK when another valid browser session replaces the original', async () => {
    const f = await fixture();
    const input = staffInput('browser-commit-cookie-swap');
    const request = f.browser('/api/staff/knowledge/command', 'POST', input);
    const blocked = f.block('afterKbCommit');
    const pending = f.knowledge.handle(request);
    await blocked.waitFor(pending);
    try {
      request.headers.set('Cookie', f.cookie(other));
    } finally {
      blocked.release();
    }
    const result = await pending;
    expect(result?.status).toBe(403);
    expect(await value(result)).not.toHaveProperty('value');
    expect(
      await f.knowledge.application.getCollection(await f.access(), {
        collectionId: input.input.collectionId,
      }),
    ).toMatchObject({ collection: { name: input.input.name } });
  });
});
