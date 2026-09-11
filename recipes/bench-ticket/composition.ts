/**
 * Recipe: support-queue-slice (Bench Ticket)
 *
 * Synthetic host: a fictional makerspace helpdesk. Teaches a small
 * support-desk site with first-party Identity **email-code** login (not
 * Auth0, Entra, or passkeys-required), Sessions, Mail to a catcher,
 * Support Desk create/list/reply, and Health. Tests inject
 * `createMemoryStore()`. Cloud runbooks inject D1, Azure Tables, or the
 * forthcoming `@pegma/storage-dynamodb` adapter — same composition shape.
 *
 * Not pegma.dev’s production feedback API. Do not copy commercial route
 * maps, cookie names, or CSRF tokens from any live product.
 */

import type { AccessContext } from '@pegma/authorization-core';
import {
  createProcessCheck,
  createStorePingCheck,
  healthProbeCollection,
  runHealthChecks,
  toHealthResponse,
  type HealthHttpResponse,
} from '@pegma/health';
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
  createMemoryLimiter,
  defineRateLimitPolicy,
  type DurableRateLimiter,
} from '@pegma/rate-limit';
import { createSessionStore, type SessionStore } from '@pegma/sessions';
import {
  systemClock,
  type Clock,
  type Logger,
  type PrincipalId,
} from '@pegma/spine';
import type { Store } from '@pegma/storage-core';
import {
  createSupportDeskApplication,
  supportPermissions,
  type SupportDeskApplication,
} from '@pegma/support-desk-application';

/** Fictional makerspace helpdesk. */
export const BENCH_TICKET = {
  service: 'bench-ticket',
  policyVersion: 'bench-ticket-policy-1',
  defaultOrigin: 'http://localhost:8787',
} as const;

export const BENCH_TICKET_CATEGORIES = Object.freeze(['general', 'tools', 'access'] as const);

/** Host-owned mail delivery ports — required for email-code account flows. */
export interface BenchTicketMailDelivery {
  readonly provider: MailProvider;
  readonly reconciliation: MailReconciliationPort;
  readonly renderer: IdentityMailRenderer;
  readonly workerId?: string;
}

export interface BenchTicketCompositionOptions {
  /**
   * Required injected store. Local Docker tests and compose use
   * `createMemoryStore()`. Production-shaped hosts pass a durable adapter
   * (D1, Azure Tables, or `@pegma/storage-dynamodb` once published).
   * Memory is never the silent default.
   */
  readonly store: Store;
  /**
   * Public origin of this host (`http://localhost:8787` locally). Used as
   * Identity issuer and the sole relying-party origin. HTTP is allowed only
   * for local development hostnames.
   */
  readonly origin: string;
  /**
   * Base64-encoded email-code HMAC secret (≥32 raw bytes).
   * Host-managed; never generated at process start in production.
   */
  readonly emailCodeSecretBase64: string;
  readonly mailDelivery: BenchTicketMailDelivery;
  readonly clock?: Clock;
  readonly logger?: Logger;
}

export interface BenchTicketComposition {
  readonly store: Store;
  readonly origin: string;
  readonly identity: Identity;
  readonly sessions: SessionStore;
  readonly support: SupportDeskApplication;
  readonly mailWorker: MailWorker;
  readonly emailCodeRequestLimiter: DurableRateLimiter;
  readonly emailCodeVerificationLimiter: DurableRateLimiter;
  readonly clock: Clock;
  readonly health: () => Promise<HealthHttpResponse>;
  readonly customerAccess: (principalId: PrincipalId) => AccessContext;
}

function decodeEmailCodeSecret(value: string): Uint8Array {
  if (
    value.length < 44 ||
    value.length > 172 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  ) {
    throw new Error(
      'Bench Ticket email-code secret is missing or invalid (expected base64 of 32–128 raw bytes).',
    );
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error(
      'Bench Ticket email-code secret is missing or invalid (expected base64 of 32–128 raw bytes).',
    );
  }
  if (binary.length < 32 || binary.length > 128) {
    throw new Error(
      'Bench Ticket email-code secret is missing or invalid (expected base64 of 32–128 raw bytes).',
    );
  }
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function originParts(origin: string): { readonly issuer: string; readonly rpID: string } {
  let url: URL;
  try {
    url = new URL(origin);
  } catch (cause) {
    throw new Error('Bench Ticket origin is invalid.', { cause });
  }
  if (url.origin !== origin) {
    throw new Error('Bench Ticket origin must be a full origin with no path, query, or fragment.');
  }
  return { issuer: url.origin, rpID: url.hostname.toLowerCase() };
}

const CUSTOMER_PERMISSIONS = Object.freeze([
  supportPermissions.create,
  supportPermissions.readOwn,
  supportPermissions.replyOwn,
]);

/**
 * Authenticated-customer AccessContext. This demo grants ticket create /
 * read-own / reply-own to every signed-in principal (host defaults, not a
 * paid entitlement and not an external IdP).
 */
export function benchTicketCustomerAccess(
  principalId: PrincipalId,
): AccessContext {
  return {
    principalId,
    policyVersion: BENCH_TICKET.policyVersion,
    roles: [],
    entitlements: [],
    permissions: [...CUSTOMER_PERMISSIONS],
  };
}

/**
 * Identity mail renderer. The one-time code is in the subject and body so
 * Mailpit and console catchers are greppable (`Your Bench Ticket code is …`).
 */
export function createBenchTicketMailRenderer(): IdentityMailRenderer {
  return {
    async render(content) {
      if (content.expired) {
        throw new Error('code expired');
      }
      if (content.purpose === 'email_changed') {
        return {
          subject: 'Bench Ticket email changed',
          text: `Changed to ${content.newEmail ?? ''}`,
        };
      }
      const code = content.code ?? 'unknown';
      return {
        subject: `Your Bench Ticket code is ${code}`,
        text: `Your Bench Ticket code is ${code}\n\nIt expires at ${content.expiresAt ?? 'unknown'}.`,
      };
    },
  };
}

/**
 * Explicit composition root. Wire once. Hosts still own HTTP, cookies,
 * the mail catcher, and the Store adapter.
 */
export function createBenchTicketComposition(
  options: BenchTicketCompositionOptions,
): BenchTicketComposition {
  const store = options.store;
  const clock = options.clock ?? systemClock;
  const { issuer, rpID } = originParts(options.origin);
  const emailCodeProtector = createHmacEmailCodeProtector(
    decodeEmailCodeSecret(options.emailCodeSecretBase64),
  );

  // Passkey limiters exist because Identity requires them. This demo does not
  // require passkeys; email-code is the login path.
  const registrationLimiter = createMemoryLimiter(
    defineRateLimitPolicy({
      name: 'bench-ticket-passkey-registration',
      limit: 10,
      windowMs: 5 * 60_000,
    }),
    { clock },
  );
  const authenticationLimiter = createMemoryLimiter(
    defineRateLimitPolicy({
      name: 'bench-ticket-passkey-authentication',
      limit: 30,
      windowMs: 5 * 60_000,
    }),
    { clock },
  );
  const emailCodeRequestLimiter = createDurableLimiter(
    defineRateLimitPolicy({
      name: 'bench-ticket-email-code-request',
      limit: 10,
      windowMs: 10 * 60_000,
    }),
    store,
    { clock },
  );
  const emailCodeVerificationLimiter = createDurableLimiter(
    defineRateLimitPolicy({
      name: 'bench-ticket-email-code-verification',
      limit: 20,
      windowMs: 10 * 60_000,
    }),
    store,
    { clock },
  );

  const identity = createIdentity({
    store,
    issuer,
    rpName: 'Bench Ticket',
    rpID,
    origins: [options.origin],
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

  const support = createSupportDeskApplication({
    store,
    clock,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    allowedCategories: BENCH_TICKET_CATEGORIES,
  });

  const mailWorker = identity.createMailWorker({
    workerId: options.mailDelivery.workerId ?? 'bench-ticket-identity-mail',
    provider: options.mailDelivery.provider,
    reconciliation: options.mailDelivery.reconciliation,
    renderer: options.mailDelivery.renderer,
    leaseMilliseconds: 30_000,
    acceptedCallbackMilliseconds: 5 * 60_000,
  });

  const health = async (): Promise<HealthHttpResponse> => {
    const result = await runHealthChecks({
      service: BENCH_TICKET.service,
      clock,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      checks: [
        createProcessCheck('process'),
        createStorePingCheck({
          store,
          collection: healthProbeCollection,
          name: 'storage',
          clock,
        }),
      ],
    });
    return toHealthResponse(result);
  };

  return Object.freeze({
    store,
    origin: options.origin,
    identity,
    sessions,
    support,
    mailWorker,
    emailCodeRequestLimiter,
    emailCodeVerificationLimiter,
    clock,
    health,
    customerAccess: benchTicketCustomerAccess,
  });
}

/**
 * After Identity verifies a principal, open a server-side session.
 * Session `data` is opaque to `@pegma/sessions` — never put IdP tokens here.
 */
export async function openBenchTicketSession(
  composition: BenchTicketComposition,
  sessionId: string,
  claims: VerifiedIdentityClaims,
): Promise<void> {
  const principalId = claims.subject as PrincipalId;
  await composition.sessions.create(sessionId, {
    principalId,
    data: JSON.stringify({
      version: 1,
      issuer: claims.issuer,
      subject: claims.subject,
    }),
  });
}
