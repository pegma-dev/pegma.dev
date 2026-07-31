/**
 * Session-authenticated API primitives shared by the Support Desk API and
 * the role-administration API: cookie session resolution against Identity,
 * CSRF and same-origin enforcement for mutations, strict JSON parsing, and
 * the typed error envelope. Extracted from the Support Desk API when the
 * admin surface became its second consumer; behavior, error codes, and
 * emitted log events are unchanged (diff against the pre-extraction
 * support-api.ts to verify).
 */
import type { Logger, PrincipalId } from '@pegma/spine';
import type { SessionStore } from '@pegma/sessions';
import type { DurableRateLimiter } from '@pegma/rate-limit';
import { IDENTITY_ISSUER, SESSION_COOKIE } from './identity-api';
import type {
  IdentityLinkKey,
  IdentityLinkProjector,
  IdentityPort,
  IdentityUser,
  VerifiedIdentityClaims,
} from './identity-contracts';

export const JSON_LIMIT = 64 * 1024;
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SESSION_DATA_KEYS = new Set([
  'version',
  'csrfToken',
  'issuer',
  'subject',
]);

interface SessionData {
  readonly version: 1;
  readonly csrfToken: string;
  readonly issuer: typeof IDENTITY_ISSUER;
  readonly subject: PrincipalId;
}

export interface Authenticated {
  readonly rawSessionId: string;
  readonly csrfToken: string;
  readonly link: IdentityLinkKey;
  readonly user: IdentityUser;
}

/** The ports session authentication needs; both APIs supply supersets. */
export interface AuthenticationOptions {
  readonly sessions: SessionStore;
  readonly identity: IdentityPort;
  readonly identityLinkFromClaims: IdentityLinkProjector;
  readonly logger: Logger;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
  }
}

export class InvalidatedSessionError extends ApiError {
  constructor() {
    super(401, 'authentication_required');
  }
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('Pragma', 'no-cache');
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Vary', 'Cookie');
  return Response.json(body, { ...init, headers });
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

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function exactObject(
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

export function optionalKeysObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new ApiError(400, 'invalid_request');
  }
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (
    keys.some((key) => !allowed.has(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new ApiError(400, 'invalid_request');
  }
  return value;
}

/**
 * Validate a host-supplied string.
 * @param options.allowMultiline When true, HT LF/CR/TAB are permitted (message
 * bodies from textareas). Other C0/C1 controls remain rejected.
 */
export function boundedString(
  value: unknown,
  minimum: number,
  maximum: number,
  options: { allowMultiline?: boolean } = {},
): string {
  if (
    typeof value !== 'string' ||
    value.length < minimum ||
    value.length > maximum
  ) {
    throw new ApiError(400, 'invalid_request');
  }
  // Never write literal control characters into source; use escapes.
  // Multiline fields may include \t, \n, \r only.
  const controlPattern = options.allowMultiline
    ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u
    : /[\u0000-\u001F\u007F-\u009F]/u;
  if (controlPattern.test(value)) {
    throw new ApiError(400, 'invalid_request');
  }
  return value;
}

export async function readJson(request: Request): Promise<unknown> {
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

export function requireSameOriginMutation(request: Request): void {
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

async function invalidateSession(
  rawSessionId: string,
  options: AuthenticationOptions,
): Promise<never> {
  try {
    await options.sessions.destroy(rawSessionId);
  } catch (error) {
    options.logger.log('error', 'support.session_invalidation_cleanup_failed');
    throw error;
  }
  throw new InvalidatedSessionError();
}

export async function authenticate(
  request: Request,
  options: AuthenticationOptions,
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
    claims = await options.identity.claimsFor(record.principalId);
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
    link = options.identityLinkFromClaims(claims);
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

  const user = await options.identity.getUser(link.subject);
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

export async function requireCsrf(
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

export async function enforceRateLimit(
  limiter: DurableRateLimiter,
  key: string,
): Promise<void> {
  const decision = await limiter.allow(key);
  if (!decision.allowed) {
    const retryAfterSeconds =
      decision.retryAfter !== undefined &&
      Number.isFinite(decision.retryAfter) &&
      decision.retryAfter > 0
        ? Math.ceil(decision.retryAfter / 1_000)
        : undefined;
    throw new ApiError(429, 'rate_limited', retryAfterSeconds);
  }
}
