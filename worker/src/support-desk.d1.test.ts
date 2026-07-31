import { env } from 'cloudflare:workers';
import { identityLinkKeyFromVerifiedIdentityClaims } from '@pegma/authorization-identity';
import { createCloudflareD1Store } from '@pegma/storage-cloudflare-d1';
import { createSessionStore } from '@pegma/sessions';
import { fixedClock, type Logger, type PrincipalId } from '@pegma/spine';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IDENTITY_ISSUER,
  SESSION_COOKIE,
} from './identity-api';
import type {
  IdentityPort,
  IdentityUser,
  VerifiedIdentityClaims,
} from './identity-contracts';
import { createSupportApi } from './support-api';
import { createSupportRuntime } from './support-desk';

declare global {
  namespace Cloudflare {
    interface Env {
      IDENTITY_DB: D1Database;
    }
  }
}

const logger: Logger = { log: vi.fn() };
const clock = fixedClock('2026-07-29T15:00:00.000Z');
const principalId = 'd1-principal' as PrincipalId;

/** Semantically matches worker/migrations/0001_pegma_storage.sql. */
const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS RECORDS (
  partition_key TEXT NOT NULL,
  row_key TEXT NOT NULL,
  record_json TEXT,
  version INTEGER NOT NULL,
  deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
  PRIMARY KEY (partition_key, row_key)
) STRICT`,
  `CREATE TABLE IF NOT EXISTS PEGMA_STORAGE_D1_TX_GUARD (
  reason TEXT NOT NULL
) STRICT`,
  `CREATE TRIGGER IF NOT EXISTS PEGMA_STORAGE_D1_TX_ABORT_EXISTS
BEFORE INSERT ON PEGMA_STORAGE_D1_TX_GUARD
WHEN NEW.reason = 'exists'
BEGIN
  SELECT RAISE(ABORT, 'PEGMA_STORAGE_D1_TX_EXISTS');
END`,
  `CREATE TRIGGER IF NOT EXISTS PEGMA_STORAGE_D1_TX_ABORT_MISSING
BEFORE INSERT ON PEGMA_STORAGE_D1_TX_GUARD
WHEN NEW.reason = 'missing'
BEGIN
  SELECT RAISE(ABORT, 'PEGMA_STORAGE_D1_TX_MISSING');
END`,
  `CREATE TRIGGER IF NOT EXISTS PEGMA_STORAGE_D1_TX_ABORT_CHANGED
BEFORE INSERT ON PEGMA_STORAGE_D1_TX_GUARD
WHEN NEW.reason = 'changed'
BEGIN
  SELECT RAISE(ABORT, 'PEGMA_STORAGE_D1_TX_CHANGED');
END`,
] as const;

beforeAll(async () => {
  for (const statement of SCHEMA_STATEMENTS) {
    await env.IDENTITY_DB.prepare(statement).run();
  }
});

beforeEach(async () => {
  await env.IDENTITY_DB.prepare('DELETE FROM RECORDS').run();
  await env.IDENTITY_DB.prepare('DELETE FROM PEGMA_STORAGE_D1_TX_GUARD').run();
});

function identity(): IdentityPort {
  const user: IdentityUser = {
    principalId,
    email: 'd1@example.test',
    emailVerified: true,
    status: 'active',
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z',
  };
  return {
    claimsFor: vi.fn(async () =>
      ({
        issuer: IDENTITY_ISSUER,
        subject: principalId,
        emailVerified: true,
      }) satisfies VerifiedIdentityClaims,
    ),
    findUserByEmail: vi.fn(async () => null),
    getUser: vi.fn(async () => user),
    beginPasskeyRegistration: vi.fn(),
    finishPasskeyRegistration: vi.fn(),
    beginPasskeyAuthentication: vi.fn(),
    finishPasskeyAuthentication: vi.fn(),
    listPasskeys: vi.fn(async () => []),
    removePasskey: vi.fn(async () => true),
  };
}

describe('Support Desk over Cloudflare D1', () => {
  it('proves create/list/read/reply with createSchemaIfMissing: false', async () => {
    const store = createCloudflareD1Store({
      database: env.IDENTITY_DB,
      createSchemaIfMissing: false,
    });
    const sessions = createSessionStore(store, { logger });
    const id = identity();
    const runtime = createSupportRuntime({
      store,
      sessions,
      identity: id,
      identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
      logger,
      clock,
    });
    const api = createSupportApi({
      application: runtime.application,
      sessions,
      identity: id,
      identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
      createLimiter: runtime.createLimiter,
      replyLimiter: runtime.replyLimiter,
      logger,
    });

    const sessionId = 'd'.repeat(43);
    const csrfToken = 'e'.repeat(43);
    await sessions.create(sessionId, {
      principalId,
      data: JSON.stringify({
        version: 1,
        csrfToken,
        issuer: IDENTITY_ISSUER,
        subject: principalId,
      }),
    });
    const cookie = `${SESSION_COOKIE}=${sessionId}`;

    const created = await api(
      new Request('https://pegma.dev/api/support/tickets', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: IDENTITY_ISSUER,
          'Sec-Fetch-Site': 'same-origin',
          Cookie: cookie,
          'X-Pegma-CSRF': csrfToken,
        },
        body: JSON.stringify({
          subject: 'D1 feedback',
          body: 'End-to-end against real D1 collections.',
          category: 'feature_request',
        }),
      }),
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      ticket: { id: string; number: number; marker: string };
      messages: readonly unknown[];
    };
    expect(createdBody.ticket.number).toBe(1);
    expect(createdBody.ticket.marker).toBe('[PEG-1]');
    expect(createdBody.messages).toHaveLength(1);

    const listed = await api(
      new Request('https://pegma.dev/api/support/tickets', {
        headers: { Cookie: cookie },
      }),
    );
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as {
      tickets: readonly { id: string }[];
    };
    expect(listBody.tickets.map((ticket) => ticket.id)).toEqual([
      createdBody.ticket.id,
    ]);

    const read = await api(
      new Request(
        `https://pegma.dev/api/support/tickets/${createdBody.ticket.id}`,
        { headers: { Cookie: cookie } },
      ),
    );
    expect(read.status).toBe(200);

    const reply = await api(
      new Request(
        `https://pegma.dev/api/support/tickets/${createdBody.ticket.id}/replies`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: IDENTITY_ISSUER,
            'Sec-Fetch-Site': 'same-origin',
            Cookie: cookie,
            'X-Pegma-CSRF': csrfToken,
          },
          body: JSON.stringify({ body: 'Follow-up on D1 path.' }),
        },
      ),
    );
    expect(reply.status).toBe(201);
    const replyBody = (await reply.json()) as {
      messages: readonly unknown[];
    };
    expect(replyBody.messages).toHaveLength(2);

    const unauth = await api(
      new Request('https://pegma.dev/api/support/tickets'),
    );
    expect(unauth.status).toBe(401);
  });
});
