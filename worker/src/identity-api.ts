import type { Logger, PrincipalId } from '@pegma/spine';
import type { SessionStore } from '@pegma/sessions';
import type {
  EmailCodeIdentityPort,
  IdentityLinkKey,
  IdentityLinkProjector,
  IdentityPort,
  IdentityUser,
  VerificationEmailSender,
  VerifiedIdentityClaims,
} from './identity-contracts';

export const IDENTITY_ISSUER = 'https://pegma.dev';
export const IDENTITY_RP_ID = 'pegma.dev';
export const SESSION_COOKIE = '__Host-pegma_session';

const JSON_LIMIT = 64 * 1024;
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SESSION_DATA_KEYS = new Set([
  'version',
  'csrfToken',
  'issuer',
  'subject',
]);

interface IdentityApiOptions {
  readonly sessions: SessionStore;
  readonly identity?: IdentityPort;
  readonly identityLinkFromClaims?: IdentityLinkProjector;
  readonly emailCodes?: EmailCodeIdentityPort;
  readonly verificationEmailSender?: VerificationEmailSender;
  readonly logger: Logger;
  readonly randomBytes?: (target: Uint8Array) => Uint8Array;
}

interface SessionData {
  readonly version: 1;
  readonly csrfToken: string;
  readonly issuer: typeof IDENTITY_ISSUER;
  readonly subject: PrincipalId;
}

interface Authenticated {
  readonly rawSessionId: string;
  readonly csrfToken: string;
  readonly link: IdentityLinkKey;
  readonly user: IdentityUser;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

class InvalidatedSessionError extends ApiError {
  constructor() {
    super(401, 'authentication_required');
  }
}

function json(
  body: unknown,
  init: ResponseInit = {},
  cookie?: string,
): Response {
  const headers = new Headers(init.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('Pragma', 'no-cache');
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Vary', 'Cookie');
  if (cookie !== undefined) {
    headers.append('Set-Cookie', cookie);
  }
  return Response.json(body, { ...init, headers });
}

function sessionCookie(sessionId: string): string {
  return `${SESSION_COOKIE}=${sessionId}; Path=/; Max-Age=604800; Secure; HttpOnly; SameSite=Strict`;
}

function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function randomToken(
  fill: (target: Uint8Array) => Uint8Array = (target) =>
    crypto.getRandomValues(target),
): string {
  return base64Url(fill(new Uint8Array(TOKEN_BYTES)));
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (header === null || header.length > 8_192) {
    return null;
  }
  let found: string | null = null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) {
      continue;
    }
    if (found !== null) {
      return null;
    }
    found = part.slice(separator + 1).trim();
  }
  return found !== null && TOKEN_PATTERN.test(found) ? found : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function exactObject(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !isPlainObject(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new ApiError(400, 'invalid_request');
  }
  return value;
}

function boundedString(
  value: unknown,
  minimum: number,
  maximum: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length < minimum ||
    value.length > maximum ||
    /[\u0000-\u001F\u007F-\u009F]/u.test(value)
  ) {
    throw new ApiError(400, 'invalid_request');
  }
  return value;
}

async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get('Content-Type')?.split(';', 1)[0];
  if (contentType?.trim().toLowerCase() !== 'application/json') {
    throw new ApiError(415, 'json_required');
  }
  const declaredLength = request.headers.get('Content-Length');
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > JSON_LIMIT)
  ) {
    throw new ApiError(413, 'request_too_large');
  }
  if (request.body === null) {
    throw new ApiError(400, 'invalid_json');
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      length += chunk.value.byteLength;
      if (length > JSON_LIMIT) {
        await reader.cancel();
        throw new ApiError(413, 'request_too_large');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ApiError(400, 'invalid_json');
  }
}

function requireSameOriginMutation(request: Request): void {
  const url = new URL(request.url);
  if (
    url.origin !== IDENTITY_ISSUER ||
    request.headers.get('Origin') !== IDENTITY_ISSUER ||
    request.headers.get('Sec-Fetch-Site') !== 'same-origin'
  ) {
    throw new ApiError(403, 'cross_origin_denied');
  }
}

async function fixedTimeEqual(first: string, second: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [firstDigest, secondDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(first)),
    crypto.subtle.digest('SHA-256', encoder.encode(second)),
  ]);
  const firstBytes = new Uint8Array(firstDigest);
  const secondBytes = new Uint8Array(secondDigest);
  let difference = 0;
  for (let index = 0; index < firstBytes.length; index += 1) {
    difference |= firstBytes[index]! ^ secondBytes[index]!;
  }
  return difference === 0;
}

function parseSessionData(value: string): SessionData | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const csrfToken =
    typeof parsed === 'object' &&
    parsed !== null &&
    'csrfToken' in parsed &&
    typeof parsed.csrfToken === 'string'
      ? parsed.csrfToken
      : '';
  if (
    !isPlainObject(parsed) ||
    Object.keys(parsed).length !== SESSION_DATA_KEYS.size ||
    Object.keys(parsed).some((key) => !SESSION_DATA_KEYS.has(key)) ||
    parsed.version !== 1 ||
    !TOKEN_PATTERN.test(csrfToken) ||
    parsed.issuer !== IDENTITY_ISSUER ||
    typeof parsed.subject !== 'string' ||
    parsed.subject.length === 0
  ) {
    return null;
  }
  return {
    version: 1,
    csrfToken,
    issuer: IDENTITY_ISSUER,
    subject: parsed.subject as PrincipalId,
  };
}

async function rateLimitKey(request: Request): Promise<string> {
  const address = request.headers.get('CF-Connecting-IP') ?? 'unavailable';
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`pegma.dev|${address}`),
  );
  return base64Url(new Uint8Array(digest));
}

function expectedIdentity(options: IdentityApiOptions): IdentityPort {
  if (options.identity === undefined) {
    throw new ApiError(503, 'identity_unavailable');
  }
  return options.identity;
}

function expectedProjector(options: IdentityApiOptions): IdentityLinkProjector {
  if (options.identityLinkFromClaims === undefined) {
    throw new ApiError(503, 'identity_unavailable');
  }
  return options.identityLinkFromClaims;
}

function requireIdentityCapability(options: IdentityApiOptions): void {
  expectedIdentity(options);
  expectedProjector(options);
}

async function readyEmailRecovery(options: IdentityApiOptions): Promise<{
  readonly codes: EmailCodeIdentityPort;
  readonly sender: VerificationEmailSender;
} | null> {
  const codes = composedEmailRecovery(options);
  if (codes === null || options.verificationEmailSender === undefined) {
    return null;
  }
  try {
    return (await options.verificationEmailSender.ready()) === true
      ? {
          codes,
          sender: options.verificationEmailSender,
        }
      : null;
  } catch {
    return null;
  }
}

function composedEmailRecovery(
  options: IdentityApiOptions,
): EmailCodeIdentityPort | null {
  return options.identity !== undefined &&
    options.identityLinkFromClaims !== undefined &&
    options.emailCodes !== undefined
    ? options.emailCodes
    : null;
}

async function invalidateSession(
  rawSessionId: string,
  options: IdentityApiOptions,
): Promise<never> {
  try {
    await options.sessions.destroy(rawSessionId);
  } catch (error) {
    options.logger.log('error', 'identity.session_invalidation_cleanup_failed');
    throw error;
  }
  throw new InvalidatedSessionError();
}

async function authenticate(
  request: Request,
  options: IdentityApiOptions,
): Promise<Authenticated | null> {
  const rawSessionId = cookieValue(request, SESSION_COOKIE);
  if (rawSessionId === null) {
    return null;
  }
  const record = await options.sessions.get(rawSessionId);
  if (record === null) {
    throw new InvalidatedSessionError();
  }
  const data = parseSessionData(record.data);
  if (data === null || data.subject !== record.principalId) {
    return invalidateSession(rawSessionId, options);
  }

  let claims: VerifiedIdentityClaims;
  try {
    claims = await expectedIdentity(options).claimsFor(record.principalId);
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
    if (code === 'invalid_state' || code === 'not_found') {
      return invalidateSession(rawSessionId, options);
    }
    throw error;
  }

  let link: IdentityLinkKey;
  try {
    link = expectedProjector(options)(claims);
  } catch {
    return invalidateSession(rawSessionId, options);
  }
  if (
    claims.emailVerified !== true ||
    link.issuer !== data.issuer ||
    link.subject !== data.subject
  ) {
    return invalidateSession(rawSessionId, options);
  }

  const user = await expectedIdentity(options).getUser(link.subject);
  if (
    user === null ||
    user.principalId !== link.subject ||
    user.status !== 'active' ||
    user.emailVerified !== true
  ) {
    return invalidateSession(rawSessionId, options);
  }
  return {
    rawSessionId,
    csrfToken: data.csrfToken,
    link,
    user,
  };
}

async function requireAuthentication(
  request: Request,
  options: IdentityApiOptions,
): Promise<Authenticated> {
  const authenticated = await authenticate(request, options);
  if (authenticated === null) {
    throw new ApiError(401, 'authentication_required');
  }
  return authenticated;
}

async function requireCsrf(
  request: Request,
  authenticated: Authenticated,
): Promise<void> {
  const supplied = request.headers.get('X-Pegma-CSRF') ?? '';
  if (
    !TOKEN_PATTERN.test(supplied) ||
    !(await fixedTimeEqual(supplied, authenticated.csrfToken))
  ) {
    throw new ApiError(403, 'csrf_denied');
  }
}

async function establishSession(
  request: Request,
  claims: VerifiedIdentityClaims,
  options: IdentityApiOptions,
): Promise<Response> {
  if (claims.issuer !== IDENTITY_ISSUER || claims.emailVerified !== true) {
    throw new ApiError(401, 'verification_failed');
  }
  const link = expectedProjector(options)(claims);
  if (link.issuer !== IDENTITY_ISSUER || link.subject !== claims.subject) {
    throw new ApiError(401, 'verification_failed');
  }

  const fill = options.randomBytes;
  const sessionId = randomToken(fill);
  const csrfToken = randomToken(fill);
  const data: SessionData = {
    version: 1,
    csrfToken,
    issuer: IDENTITY_ISSUER,
    subject: link.subject,
  };
  await options.sessions.create(sessionId, {
    principalId: link.subject,
    data: JSON.stringify(data),
  });
  const prior = cookieValue(request, SESSION_COOKIE);
  if (prior !== null && prior !== sessionId) {
    try {
      await options.sessions.destroy(prior);
    } catch {
      options.logger.log('warn', 'identity.session_rotation_cleanup_failed');
    }
  }

  return json(
    { authenticated: true, csrfToken },
    { status: 200 },
    sessionCookie(sessionId),
  );
}

function publicError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  if (typeof error === 'object' && error !== null && 'code' in error) {
    switch ((error as { readonly code?: unknown }).code) {
      case 'invalid_input':
      case 'verification_failed':
        return new ApiError(400, 'verification_failed');
      case 'rate_limited':
        return new ApiError(429, 'rate_limited');
      case 'not_found':
        return new ApiError(404, 'not_found');
      case 'conflict':
      case 'invalid_state':
        return new ApiError(409, 'invalid_state');
    }
  }
  return new ApiError(500, 'internal_error');
}

/**
 * Creates the account API over injected Pegma components.
 *
 * All browser mutations require exact same-origin Fetch Metadata. Mutations
 * after authentication additionally require a synchronizer token stored only
 * in the hashed, server-side session record.
 */
export function createIdentityApi(
  options: IdentityApiOptions,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const path = new URL(request.url).pathname;
    try {
      if (request.method === 'GET' && path === '/api/identity/capabilities') {
        const emailCode = (await readyEmailRecovery(options)) !== null;
        return json({
          issuer: IDENTITY_ISSUER,
          rpID: IDENTITY_RP_ID,
          passkeys:
            options.identity !== undefined &&
            options.identityLinkFromClaims !== undefined,
          emailCode,
        });
      }

      if (request.method === 'GET' && path === '/api/identity/account') {
        const authenticated = await requireAuthentication(request, options);
        const passkeys = await expectedIdentity(options).listPasskeys(
          authenticated.link.subject,
        );
        return json({
          account: {
            subject: authenticated.link.subject,
            email: authenticated.user.email,
          },
          passkeys,
          csrfToken: authenticated.csrfToken,
        });
      }

      if (request.method !== 'POST' && request.method !== 'DELETE') {
        throw new ApiError(404, 'not_found');
      }
      requireSameOriginMutation(request);

      if (
        request.method === 'POST' &&
        path === '/api/identity/passkeys/authentication/options'
      ) {
        exactObject(await readJson(request), []);
        requireIdentityCapability(options);
        const started = await expectedIdentity(
          options,
        ).beginPasskeyAuthentication(await rateLimitKey(request));
        return json(started);
      }

      if (
        request.method === 'POST' &&
        path === '/api/identity/passkeys/authentication/verify'
      ) {
        const body = exactObject(await readJson(request), [
          'challengeHandle',
          'response',
        ]);
        requireIdentityCapability(options);
        const claims = await expectedIdentity(
          options,
        ).finishPasskeyAuthentication({
          challengeHandle: boundedString(body.challengeHandle, 1, 512),
          response: body.response,
        });
        return await establishSession(request, claims, options);
      }

      if (
        request.method === 'POST' &&
        path === '/api/identity/email-code/options'
      ) {
        const body = exactObject(await readJson(request), ['email']);
        const recovery = await readyEmailRecovery(options);
        if (recovery === null) {
          throw new ApiError(503, 'email_code_unavailable');
        }
        const started = await recovery.codes.begin(
          boundedString(body.email, 3, 320),
          await rateLimitKey(request),
        );
        await recovery.sender.sendVerificationCode(started.delivery);
        return json({
          challengeHandle: started.challengeHandle,
          delivery: 'email',
        });
      }

      if (
        request.method === 'POST' &&
        path === '/api/identity/email-code/verify'
      ) {
        const body = exactObject(await readJson(request), [
          'challengeHandle',
          'code',
        ]);
        const codes = composedEmailRecovery(options);
        if (codes === null) {
          throw new ApiError(503, 'email_code_unavailable');
        }
        const claims = await codes.finish(
          boundedString(body.challengeHandle, 1, 512),
          boundedString(body.code, 4, 32),
          await rateLimitKey(request),
        );
        return await establishSession(request, claims, options);
      }

      const authenticated = await requireAuthentication(request, options);
      await requireCsrf(request, authenticated);

      if (request.method === 'POST' && path === '/api/identity/logout') {
        exactObject(await readJson(request), []);
        await options.sessions.destroy(authenticated.rawSessionId);
        return json(
          { authenticated: false },
          { status: 200 },
          clearSessionCookie(),
        );
      }

      if (
        request.method === 'POST' &&
        path === '/api/identity/passkeys/registration/options'
      ) {
        exactObject(await readJson(request), []);
        const started = await expectedIdentity(
          options,
        ).beginPasskeyRegistration(
          authenticated.link.subject,
          await rateLimitKey(request),
        );
        return json(started);
      }

      if (
        request.method === 'POST' &&
        path === '/api/identity/passkeys/registration/verify'
      ) {
        const body = exactObject(await readJson(request), [
          'challengeHandle',
          'label',
          'response',
        ]);
        const passkey = await expectedIdentity(
          options,
        ).finishPasskeyRegistration({
          principalId: authenticated.link.subject,
          challengeHandle: boundedString(body.challengeHandle, 1, 512),
          label: boundedString(body.label, 1, 100),
          response: body.response,
        });
        return json({ passkey });
      }

      if (request.method === 'DELETE' && path === '/api/identity/passkeys') {
        const body = exactObject(await readJson(request), ['credentialId']);
        if ((await readyEmailRecovery(options)) === null) {
          throw new ApiError(409, 'recovery_required');
        }
        const removed = await expectedIdentity(options).removePasskey(
          authenticated.link.subject,
          boundedString(body.credentialId, 1, 2_048),
        );
        return json({ removed });
      }

      throw new ApiError(404, 'not_found');
    } catch (error) {
      const safe = publicError(error);
      options.logger.log(
        safe.status >= 500 ? 'error' : 'warn',
        'identity.request_rejected',
        { path, status: safe.status, code: safe.code },
      );
      return json(
        { error: safe.code },
        { status: safe.status },
        error instanceof InvalidatedSessionError
          ? clearSessionCookie()
          : undefined,
      );
    }
  };
}
