import { identityLinkKeyFromVerifiedIdentityClaims } from '@pegma/authorization-identity';
import {
  createHmacEmailCodeProtector,
  createIdentity,
  type Identity,
  type MailWorker,
} from '@pegma/identity';
import {
  createDurableLimiter,
  defineRateLimitPolicy,
  type DurableRateLimiter,
} from '@pegma/rate-limit';
import { createSessionStore, type SessionStore } from '@pegma/sessions';
import { createCloudflareD1Store } from '@pegma/storage-cloudflare-d1';
import type { Store } from '@pegma/storage-core';
import type { Logger } from '@pegma/spine';
import { createIdentityApi } from './identity-api';
import {
  classifyResendFailure,
  createIdentityMailRenderer,
  createResendMailPorts,
} from './resend-mail';

export interface IdentityRuntimeEnv {
  readonly IDENTITY_DB: D1Database;
  readonly IDENTITY_EMAIL_CODE_SECRET_BASE64: string;
  readonly IDENTITY_EMAIL_FROM: string;
  readonly IDENTITY_EMAIL_ENABLED: string;
  readonly RESEND_API_KEY?: string;
}

export interface IdentityRuntime {
  readonly store: Store;
  readonly identity: Identity;
  readonly api: (request: Request) => Promise<Response>;
  readonly mailWorker: MailWorker | null;
  readonly emailCodeReady: boolean;
  readonly limiters: readonly DurableRateLimiter[];
  readonly sessions: SessionStore;
}

export interface IdentityCompositionOptions {
  readonly store: Store;
  readonly emailCodeSecretBase64: string;
  readonly emailFrom: string;
  readonly emailEnabled: boolean;
  readonly resendApiKey?: string;
  readonly fetch?: typeof fetch;
}

function emailCodeSecret(value: unknown): Uint8Array {
  if (
    typeof value !== 'string' ||
    value.length < 44 ||
    value.length > 172 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  ) {
    throw new Error('Identity email-code secret is not configured.');
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error('Identity email-code secret is invalid.');
  }
  if (binary.length < 32 || binary.length > 128) {
    throw new Error('Identity email-code secret is invalid.');
  }
  if (btoa(binary) !== value) {
    throw new Error('Identity email-code secret is invalid.');
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
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
 * Production composition for pegma.dev's first-party Identity provider.
 *
 * The D1 adapter remains the only storage implementation. Sessions, Identity,
 * rate limits, and the Authorization claims projector are exact public
 * packages. Mail is enabled only when a Resend API key is present; otherwise
 * email-code endpoints fail closed before committing delivery work.
 */
export function createProductionIdentityRuntime(
  env: IdentityRuntimeEnv,
  logger: Logger,
): IdentityRuntime {
  const store = createCloudflareD1Store({
    database: env.IDENTITY_DB,
    createSchemaIfMissing: false,
  });
  return createIdentityRuntime(
    {
      store,
      emailCodeSecretBase64: env.IDENTITY_EMAIL_CODE_SECRET_BASE64,
      emailFrom: env.IDENTITY_EMAIL_FROM,
      emailEnabled: String(env.IDENTITY_EMAIL_ENABLED) === 'true',
      ...(env.RESEND_API_KEY === undefined
        ? {}
        : { resendApiKey: env.RESEND_API_KEY }),
    },
    logger,
  );
}

/** Exact package composition with an injected conforming Store for tests. */
export function createIdentityRuntime(
  options: IdentityCompositionOptions,
  logger: Logger,
): IdentityRuntime {
  const store = options.store;
  const registrationLimiter = durableLimiter(
    store,
    'pegma-dev-passkey-registration',
    10,
    5 * 60_000,
  );
  const authenticationLimiter = durableLimiter(
    store,
    'pegma-dev-passkey-authentication',
    30,
    5 * 60_000,
  );
  const emailCodeRequestLimiter = durableLimiter(
    store,
    'pegma-dev-email-code-request',
    5,
    10 * 60_000,
  );
  const emailCodeVerificationLimiter = durableLimiter(
    store,
    'pegma-dev-email-code-verification',
    10,
    10 * 60_000,
  );
  const identity = createIdentity({
    store,
    issuer: 'https://pegma.dev',
    rpName: 'Pegma',
    rpID: 'pegma.dev',
    origins: ['https://pegma.dev'],
    registrationLimiter,
    authenticationLimiter,
    emailCodeProtector: createHmacEmailCodeProtector(
      emailCodeSecret(options.emailCodeSecretBase64),
    ),
    emailCodeRequestLimiter,
    emailCodeVerificationLimiter,
  });

  const resendKey =
    options.emailEnabled &&
    typeof options.resendApiKey === 'string' &&
    options.resendApiKey.length > 0
      ? options.resendApiKey
      : null;
  const mailWorker =
    resendKey === null
      ? null
      : (() => {
          const ports = createResendMailPorts({
            apiKey: resendKey,
            from: options.emailFrom,
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
          });
          return identity.createMailWorker({
            workerId: 'pegma-dev-identity-mail',
            provider: ports.provider,
            reconciliation: ports.reconciliation,
            renderer: createIdentityMailRenderer(),
            leaseMilliseconds: 30_000,
            acceptedCallbackMilliseconds: 5 * 60_000,
            classifyFailure: classifyResendFailure,
          });
        })();
  const emailCodeReady = mailWorker !== null;
  const sessions = createSessionStore(store, { logger });
  const api = createIdentityApi({
    sessions,
    identity,
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
    emailCodes: identity,
    emailCodeReady,
    logger,
  });

  return Object.freeze({
    store,
    identity,
    api,
    mailWorker,
    emailCodeReady,
    limiters: Object.freeze([
      registrationLimiter,
      authenticationLimiter,
      emailCodeRequestLimiter,
      emailCodeVerificationLimiter,
    ]),
    sessions,
  });
}
