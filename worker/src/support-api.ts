import type { Logger, PrincipalId } from '@pegma/spine';
import type { SessionStore } from '@pegma/sessions';
import type { DurableRateLimiter } from '@pegma/rate-limit';
import type {
  CustomerTicketSummary,
  CustomerTicketView,
  SupportDeskApplication,
} from '@pegma/support-desk-application';
import {
  IDENTITY_ISSUER,
  SESSION_COOKIE,
} from './identity-api';
import type {
  IdentityLinkKey,
  IdentityLinkProjector,
  IdentityPort,
  IdentityUser,
  VerifiedIdentityClaims,
} from './identity-contracts';
import { customerAccessContext } from './support-access';
import {
  mapSupportError,
  mintSupportId,
  PEGMA_SUPPORT_CATEGORY_SET,
  type PegmaSupportCategory,
} from './support-desk';

const JSON_LIMIT = 64 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SESSION_DATA_KEYS = new Set([
  'version',
  'csrfToken',
  'issuer',
  'subject',
]);
const TICKET_ID_PATH =
  /^\/api\/support\/tickets\/([A-Za-z0-9._~-]{1,200})(?:\/(replies))?$/u;

interface SupportApiOptions {
  readonly application: SupportDeskApplication;
  readonly sessions: SessionStore;
  readonly identity: IdentityPort;
  readonly identityLinkFromClaims: IdentityLinkProjector;
  readonly createLimiter: DurableRateLimiter;
  readonly replyLimiter: DurableRateLimiter;
  readonly logger: Logger;
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
    readonly retryAfterSeconds?: number,
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
): Response {
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

function optionalKeysObject(
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

async function invalidateSession(
  rawSessionId: string,
  options: SupportApiOptions,
): Promise<never> {
  try {
    await options.sessions.destroy(rawSessionId);
  } catch (error) {
    options.logger.log('error', 'support.session_invalidation_cleanup_failed');
    throw error;
  }
  throw new InvalidatedSessionError();
}

async function authenticate(
  request: Request,
  options: SupportApiOptions,
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

async function requireAuthentication(
  request: Request,
  options: SupportApiOptions,
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

async function enforceRateLimit(
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

function publicTicketSummary(ticket: CustomerTicketSummary) {
  return {
    id: ticket.id,
    number: ticket.number,
    subject: ticket.subject,
    ...(ticket.category === undefined ? {} : { category: ticket.category }),
    status: ticket.status,
    channel: ticket.channel,
    createdAt: ticket.createdAt,
    customerUpdatedAt: ticket.customerUpdatedAt,
    marker: `[PEG-${ticket.number}]`,
    url: `https://pegma.dev/feedback/${encodeURIComponent(ticket.id)}`,
  };
}

function publicTicketView(view: CustomerTicketView) {
  return {
    ticket: publicTicketSummary(view.ticket),
    messages: view.messages.map((message) => ({
      id: message.id,
      ticketId: message.ticketId,
      authorKind: message.authorKind,
      channel: message.channel,
      visibility: message.visibility,
      format: message.format,
      body: message.body,
      createdAt: message.createdAt,
    })),
  };
}

function publicError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  const mapped = mapSupportError(error);
  return new ApiError(
    mapped.status,
    mapped.code,
    mapped.retryAfterSeconds,
  );
}

function parseCategory(value: unknown): PegmaSupportCategory {
  if (typeof value !== 'string' || !PEGMA_SUPPORT_CATEGORY_SET.has(value)) {
    throw new ApiError(400, 'invalid_category');
  }
  return value as PegmaSupportCategory;
}

/**
 * Authenticated Support Desk customer API.
 *
 * Session cookie `__Host-pegma_session`, CSRF `X-Pegma-CSRF`, same-origin
 * Fetch Metadata for mutations. Principal is the Identity subject from the
 * session — never taken from the request body.
 */
export function createSupportApi(
  options: SupportApiOptions,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (request.method === 'GET' && path === '/api/support/categories') {
        // Categories are public configuration; list requires auth so the
        // feedback form can only load them after sign-in.
        const authenticated = await requireAuthentication(request, options);
        return json({
          categories: [
            'feedback',
            'bug',
            'feature_request',
            'documentation',
            'question',
          ],
          csrfToken: authenticated.csrfToken,
        });
      }

      if (request.method === 'GET' && path === '/api/support/tickets') {
        const authenticated = await requireAuthentication(request, options);
        const access = customerAccessContext(authenticated.link.subject);
        const tickets = await options.application.listCustomerTickets(access);
        return json({
          tickets: tickets.map(publicTicketSummary),
          csrfToken: authenticated.csrfToken,
        });
      }

      const ticketMatch = TICKET_ID_PATH.exec(path);
      if (
        ticketMatch !== null &&
        ticketMatch[2] === undefined &&
        request.method === 'GET'
      ) {
        const ticketId = ticketMatch[1]!;
        const authenticated = await requireAuthentication(request, options);
        const access = customerAccessContext(authenticated.link.subject);
        const view = await options.application.readCustomerTicket(
          access,
          ticketId,
        );
        return json({
          ...publicTicketView(view),
          csrfToken: authenticated.csrfToken,
        });
      }

      if (request.method !== 'POST') {
        throw new ApiError(404, 'not_found');
      }
      requireSameOriginMutation(request);

      if (path === '/api/support/tickets') {
        const authenticated = await requireAuthentication(request, options);
        await requireCsrf(request, authenticated);
        await enforceRateLimit(
          options.createLimiter,
          authenticated.link.subject,
        );

        const body = optionalKeysObject(
          await readJson(request),
          ['subject', 'body', 'category'],
          [],
        );
        const subject = boundedString(body.subject, 1, 200);
        const messageBody = boundedString(body.body, 1, 20_000);
        const category = parseCategory(body.category);

        const access = customerAccessContext(authenticated.link.subject);
        const ticketId = mintSupportId();
        const messageId = mintSupportId();
        const commandId = mintSupportId();
        const correlationId = mintSupportId();

        const view = await options.application.createCustomerTicket(access, {
          commandId,
          correlationId,
          ticketId,
          messageId,
          subject,
          body: messageBody,
          category,
          requesterEmail: authenticated.user.email,
        });

        options.logger.log('info', 'support.ticket_created', {
          ticketNumber: view.ticket.number,
          category,
        });

        return json(publicTicketView(view), { status: 201 });
      }

      if (
        ticketMatch !== null &&
        ticketMatch[2] === 'replies' &&
        request.method === 'POST'
      ) {
        const ticketId = ticketMatch[1]!;
        const authenticated = await requireAuthentication(request, options);
        await requireCsrf(request, authenticated);
        await enforceRateLimit(
          options.replyLimiter,
          authenticated.link.subject,
        );

        const body = exactObject(await readJson(request), ['body']);
        const messageBody = boundedString(body.body, 1, 20_000);
        const access = customerAccessContext(authenticated.link.subject);
        const view = await options.application.replyToCustomerTicket(access, {
          commandId: mintSupportId(),
          correlationId: mintSupportId(),
          ticketId,
          messageId: mintSupportId(),
          body: messageBody,
        });

        options.logger.log('info', 'support.ticket_replied', {
          ticketNumber: view.ticket.number,
        });

        return json(publicTicketView(view), { status: 201 });
      }

      throw new ApiError(404, 'not_found');
    } catch (error) {
      const mapped = publicError(error);
      if (mapped.status >= 500) {
        options.logger.log('error', 'support.api_error', {
          code: mapped.code,
          error: error instanceof Error ? error.name : 'unknown',
        });
      } else {
        options.logger.log('info', 'support.api_rejected', {
          code: mapped.code,
          status: mapped.status,
        });
      }
      const headers: Record<string, string> = {};
      if (mapped.retryAfterSeconds !== undefined) {
        headers['Retry-After'] = String(mapped.retryAfterSeconds);
      }
      return json(
        { error: mapped.code },
        { status: mapped.status, headers },
      );
    }
  };
}
