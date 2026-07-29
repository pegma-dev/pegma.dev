/**
 * Recipe: cf-passkey-accounts
 *
 * Synthetic host: Northshelf Branch — a fictional community library.
 * Teaches first-party accounts on a Cloudflare-shaped Worker host:
 * Identity (passkeys + email codes, no passwords), Sessions, durable
 * rate limits, Authorization claims projection, and Storage Core.
 *
 * Tests use the memory store. Production Workers should inject
 * `@pegma/storage-cloudflare-d1` with the same composition shape.
 *
 * This is not pegma.dev’s production account API. Do not copy commercial
 * route maps or cookie names from any live product.
 */

import { identityLinkKeyFromVerifiedIdentityClaims } from '@pegma/authorization-identity';
import {
  createHmacEmailCodeProtector,
  createIdentity,
  type Identity,
  type IdentityMailRenderer,
  type MailProvider,
  type MailReconciliationPort,
  type MailWorker,
  type VerifiedIdentityClaims,
} from '@pegma/identity';
import {
  createDurableLimiter,
  defineRateLimitPolicy,
  type DurableRateLimiter,
} from '@pegma/rate-limit';
import { createSessionStore, type SessionStore } from '@pegma/sessions';
import { systemClock, type Clock, type Logger, type PrincipalId } from '@pegma/spine';
import type { Store } from '@pegma/storage-core';

/** Fictional relying-party surface for the Northshelf Branch library. */
export const NORTHSHELF_RP = {
  issuer: 'https://accounts.northshelf.example',
  rpName: 'Northshelf Branch',
  rpID: 'northshelf.example',
  origins: ['https://northshelf.example'] as const,
} as const;

/** Host-owned mail delivery ports — required for email-code account flows. */
export interface NorthshelfMailDelivery {
  readonly provider: MailProvider;
  readonly reconciliation: MailReconciliationPort;
  readonly renderer: IdentityMailRenderer;
  readonly workerId?: string;
}

export interface NorthshelfCompositionOptions {
  /**
   * Required injected store. Production hosts pass a durable adapter
   * (e.g. Cloudflare D1). Tests pass `createMemoryStore()` explicitly —
   * memory is never the silent default.
   */
  readonly store: Store;
  /**
   * Base64-encoded email-code HMAC secret (≥32 raw bytes).
   * Host-managed; never generated at process start in production.
   */
  readonly emailCodeSecretBase64: string;
  /**
   * Required mail ports so email-code account creation can be drained.
   * Production: real provider (e.g. Resend). Tests: recording stubs.
   */
  readonly mailDelivery: NorthshelfMailDelivery;
  readonly clock?: Clock;
  readonly logger?: Logger;
}

export interface NorthshelfComposition {
  readonly store: Store;
  readonly identity: Identity;
  readonly sessions: SessionStore;
  /** Drains Identity mail outbox jobs (email codes, notices). */
  readonly mailWorker: MailWorker;
  readonly registrationLimiter: DurableRateLimiter;
  readonly authenticationLimiter: DurableRateLimiter;
  readonly emailCodeRequestLimiter: DurableRateLimiter;
  readonly emailCodeVerificationLimiter: DurableRateLimiter;
  readonly emailCodeProtector: ReturnType<typeof createHmacEmailCodeProtector>;
  readonly clock: Clock;
  /** Project already-verified Identity claims into Authorization Core link keys. */
  readonly identityLinkFromClaims: (
    claims: VerifiedIdentityClaims,
  ) => ReturnType<typeof identityLinkKeyFromVerifiedIdentityClaims>;
}

function decodeEmailCodeSecret(value: string): Uint8Array {
  if (
    value.length < 44 ||
    value.length > 172 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  ) {
    throw new Error(
      'Northshelf email-code secret is missing or invalid (expected base64 of 32–128 raw bytes).',
    );
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error(
      'Northshelf email-code secret is missing or invalid (expected base64 of 32–128 raw bytes).',
    );
  }
  if (binary.length < 32 || binary.length > 128) {
    throw new Error(
      'Northshelf email-code secret is missing or invalid (expected base64 of 32–128 raw bytes).',
    );
  }
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function durableLimiter(
  store: Store,
  name: string,
  limit: number,
  windowMs: number,
): DurableRateLimiter {
  return createDurableLimiter(
    defineRateLimitPolicy({ name, limit, windowMs }),
    store,
  );
}

/**
 * Explicit composition root for the Northshelf Branch accounts recipe.
 *
 * Wire once. Hosts still own HTTP routes, cookies, WebAuthn ceremony
 * completion in the browser, email provider/DNS, and any UI.
 */
export function createNorthshelfComposition(
  options: NorthshelfCompositionOptions,
): NorthshelfComposition {
  const store = options.store;
  // Live clock by default so production-shaped hosts expire challenges/sessions.
  // Tests inject fixedClock when they need deterministic timestamps.
  const clock = options.clock ?? systemClock;
  const emailCodeProtector = createHmacEmailCodeProtector(
    decodeEmailCodeSecret(options.emailCodeSecretBase64),
  );

  const registrationLimiter = durableLimiter(
    store,
    'northshelf-passkey-registration',
    10,
    5 * 60_000,
  );
  const authenticationLimiter = durableLimiter(
    store,
    'northshelf-passkey-authentication',
    30,
    5 * 60_000,
  );
  const emailCodeRequestLimiter = durableLimiter(
    store,
    'northshelf-email-code-request',
    5,
    10 * 60_000,
  );
  const emailCodeVerificationLimiter = durableLimiter(
    store,
    'northshelf-email-code-verification',
    10,
    10 * 60_000,
  );

  const identity = createIdentity({
    store,
    issuer: NORTHSHELF_RP.issuer,
    rpName: NORTHSHELF_RP.rpName,
    rpID: NORTHSHELF_RP.rpID,
    origins: [...NORTHSHELF_RP.origins],
    registrationLimiter,
    authenticationLimiter,
    emailCodeProtector,
    emailCodeRequestLimiter,
    emailCodeVerificationLimiter,
    clock,
  });

  const sessions = createSessionStore(store, {
    clock,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  const mailWorker = identity.createMailWorker({
    workerId: options.mailDelivery.workerId ?? 'northshelf-identity-mail',
    provider: options.mailDelivery.provider,
    reconciliation: options.mailDelivery.reconciliation,
    renderer: options.mailDelivery.renderer,
    leaseMilliseconds: 30_000,
    acceptedCallbackMilliseconds: 5 * 60_000,
  });

  return Object.freeze({
    store,
    identity,
    sessions,
    mailWorker,
    registrationLimiter,
    authenticationLimiter,
    emailCodeRequestLimiter,
    emailCodeVerificationLimiter,
    emailCodeProtector,
    clock,
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
  });
}

/**
 * Host sketch: after Identity verifies a principal, open a server-side
 * session. Session `data` is opaque to `@pegma/sessions` — never put IdP
 * access tokens or other re-presentable credentials here.
 *
 * The session principal is always `claims.subject` so a mismatched caller
 * argument cannot create a cross-account session.
 */
export async function openNorthshelfSession(
  composition: NorthshelfComposition,
  sessionId: string,
  claims: VerifiedIdentityClaims,
): Promise<void> {
  const principalId = claims.subject as PrincipalId;
  const link = composition.identityLinkFromClaims(claims);
  await composition.sessions.create(sessionId, {
    principalId,
    data: JSON.stringify({
      version: 1,
      issuer: claims.issuer,
      subject: claims.subject,
      authorizationLink: link,
    }),
  });
}
