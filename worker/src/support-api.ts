import type { Logger, PrincipalId } from '@pegma/spine';
import type { SessionStore } from '@pegma/sessions';
import type { DurableRateLimiter } from '@pegma/rate-limit';
import type {
  CustomerTicketSummary,
  CustomerTicketView,
  StaffQueueItem,
  StaffQueueQuery,
  StaffTicketView,
  SupportDeskApplication,
} from '@pegma/support-desk-application';
import type {
  Ticket,
  TicketMessage,
  TicketPriority,
  TicketStatus,
} from '@pegma/support-desk-contracts';
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
import {
  ensureBootstrapSupport,
  type BootstrapMarkerStore,
  type BootstrapRoleStore,
} from './role-bootstrap';
import {
  customerAccessContext,
  staffAccessContextFromRoles,
  type SupportRoleReader,
} from './support-access';
import {
  mapSupportError,
  mintSupportId,
  pegSubjectMarker,
  PEGMA_SUPPORT_CATEGORIES,
  PEGMA_SUPPORT_CATEGORY_SET,
  publicTicketUrl,
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
const ADMIN_TICKET_PATH =
  /^\/api\/support\/admin\/tickets\/([A-Za-z0-9._~-]{1,200})(?:\/(messages|notes))?$/u;

const TICKET_STATUSES = new Set<TicketStatus>([
  'open',
  'waiting_on_support',
  'waiting_on_customer',
  'resolved',
  'closed',
]);
const TICKET_PRIORITIES = new Set<TicketPriority>([
  'low',
  'normal',
  'high',
  'urgent',
]);
const QUEUE_SORTS = new Set(['updated_newest', 'updated_oldest'] as const);
const STAFF_PATCH_ACTIONS = new Set([
  'assign',
  'unassign',
  'change_priority',
  'resolve',
  'close',
  'reopen',
] as const);

type QueueSort = 'updated_newest' | 'updated_oldest';
type StaffPatchAction =
  | 'assign'
  | 'unassign'
  | 'change_priority'
  | 'resolve'
  | 'close'
  | 'reopen';

interface SupportApiOptions {
  readonly application: SupportDeskApplication;
  readonly sessions: SessionStore;
  readonly identity: IdentityPort;
  readonly identityLinkFromClaims: IdentityLinkProjector;
  readonly createLimiter: DurableRateLimiter;
  readonly replyLimiter: DurableRateLimiter;
  readonly logger: Logger;
  /**
   * Audited role store — the ONLY staff gate (docs/ROLE_ADOPTION_PLAN.md
   * Phase 4). Absent ⇒ staff routes are a controlled 503, fail closed.
   */
  readonly roleStore?: SupportRoleReader & BootstrapRoleStore;
  /** One-time Support bootstrap principals (Phase 3). */
  readonly bootstrapPrincipals?: ReadonlySet<string>;
  /** Durable bootstrap-seed markers; required for the seed to run. */
  readonly bootstrapMarkers?: BootstrapMarkerStore;
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

/**
 * Validate a host-supplied string.
 * @param options.allowMultiline When true, HT LF/CR/TAB are permitted (message
 * bodies from textareas). Other C0/C1 controls remain rejected.
 */
function boundedString(
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
  // One-time Support bootstrap (docs/ROLE_ADOPTION_PLAN.md Phase 3): any
  // authenticated support touch by a listed principal seeds the audited
  // grant. Fail OPEN — a seed failure must not break the request; it
  // retries on the next touch. The set-membership check short-circuits for
  // everyone not listed.
  if (
    options.roleStore !== undefined &&
    options.bootstrapMarkers !== undefined &&
    options.bootstrapPrincipals !== undefined &&
    options.bootstrapPrincipals.size > 0
  ) {
    try {
      const seeded = await ensureBootstrapSupport(
        options.roleStore,
        options.bootstrapMarkers,
        authenticated.link.subject,
        options.bootstrapPrincipals,
      );
      if (seeded === 'granted') {
        options.logger.log('warn', 'support.bootstrap_support_seeded', {
          principalId: authenticated.link.subject,
        });
      }
    } catch (error) {
      options.logger.log('warn', 'support.bootstrap_support_failed', {
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
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
    marker: pegSubjectMarker(ticket.number),
    url: publicTicketUrl(ticket.id),
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

/** Staff-safe ticket fields for operator surfaces (includes requester email). */
function staffTicketDto(ticket: Ticket) {
  return {
    id: ticket.id,
    number: ticket.number,
    subject: ticket.subject,
    ...(ticket.category === undefined ? {} : { category: ticket.category }),
    status: ticket.status,
    priority: ticket.priority,
    channel: ticket.channel,
    revision: ticket.revision,
    requester: {
      association: ticket.requester.association,
      ...(ticket.requester.principalId === undefined
        ? {}
        : { principalId: ticket.requester.principalId }),
      ...(ticket.requester.email === undefined
        ? {}
        : { email: ticket.requester.email }),
    },
    ...(ticket.assignedTo === undefined
      ? {}
      : { assignedTo: ticket.assignedTo }),
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    customerUpdatedAt: ticket.customerUpdatedAt,
    ...(ticket.resolvedAt === undefined
      ? {}
      : { resolvedAt: ticket.resolvedAt }),
    ...(ticket.closedAt === undefined ? {} : { closedAt: ticket.closedAt }),
    marker: pegSubjectMarker(ticket.number),
  };
}

function staffMessageDto(message: TicketMessage) {
  return {
    id: message.id,
    ticketId: message.ticketId,
    authorKind: message.authorKind,
    channel: message.channel,
    visibility: message.visibility,
    format: message.format,
    body: message.body,
    createdAt: message.createdAt,
  };
}

function staffTicketView(view: StaffTicketView) {
  return {
    ticket: staffTicketDto(view.ticket),
    messages: view.messages.map(staffMessageDto),
  };
}

function staffQueueItemDto(item: StaffQueueItem) {
  return {
    ticketId: item.ticketId,
    revision: item.revision,
    status: item.status,
    priority: item.priority,
    ...(item.category === undefined ? {} : { category: item.category }),
    requesterAssociation: item.requesterAssociation,
    channel: item.channel,
    ...(item.assignedTo === undefined ? {} : { assignedTo: item.assignedTo }),
    updatedAt: item.updatedAt,
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

function parseTicketStatus(value: string): TicketStatus {
  if (!TICKET_STATUSES.has(value as TicketStatus)) {
    throw new ApiError(400, 'invalid_request');
  }
  return value as TicketStatus;
}

function parseTicketPriority(value: unknown): TicketPriority {
  if (
    typeof value !== 'string' ||
    !TICKET_PRIORITIES.has(value as TicketPriority)
  ) {
    throw new ApiError(400, 'invalid_request');
  }
  return value as TicketPriority;
}

function parseQueueSort(value: string): QueueSort {
  if (!QUEUE_SORTS.has(value as QueueSort)) {
    throw new ApiError(400, 'invalid_request');
  }
  return value as QueueSort;
}

function parseStaffPatchAction(value: unknown): StaffPatchAction {
  if (
    typeof value !== 'string' ||
    !STAFF_PATCH_ACTIONS.has(value as StaffPatchAction)
  ) {
    throw new ApiError(400, 'invalid_request');
  }
  return value as StaffPatchAction;
}

function parseStaffQueueQuery(url: URL): StaffQueueQuery {
  const query: {
    status?: TicketStatus;
    priority?: TicketPriority;
    sort?: QueueSort;
    unassignedOnly?: boolean;
  } = {};

  const statusParam = url.searchParams.get('status');
  if (statusParam !== null && statusParam !== '') {
    query.status = parseTicketStatus(statusParam);
  }

  const priorityParam = url.searchParams.get('priority');
  if (priorityParam !== null && priorityParam !== '') {
    query.priority = parseTicketPriority(priorityParam);
  }

  const sortParam = url.searchParams.get('sort');
  if (sortParam !== null && sortParam !== '') {
    query.sort = parseQueueSort(sortParam);
  }

  const unassignedOnly = url.searchParams.get('unassignedOnly');
  if (unassignedOnly !== null && unassignedOnly !== '') {
    if (unassignedOnly === 'true' || unassignedOnly === '1') {
      query.unassignedOnly = true;
    } else if (unassignedOnly === 'false' || unassignedOnly === '0') {
      query.unassignedOnly = false;
    } else {
      throw new ApiError(400, 'invalid_request');
    }
  }

  return query;
}

async function requireStaffAccess(
  authenticated: Authenticated,
  options: SupportApiOptions,
) {
  // The stored Support ROLE is the only gate (docs/ROLE_ADOPTION_PLAN.md
  // Phase 4) and it FAILS CLOSED: a host wired without a role store or a
  // role-store failure is a controlled 503, never a quiet allow or a
  // misleading 403.
  if (options.roleStore === undefined) {
    throw new ApiError(503, 'support_not_configured');
  }
  let roleAccess;
  try {
    roleAccess = await staffAccessContextFromRoles(
      authenticated.link.subject,
      options.roleStore,
    );
  } catch (error) {
    options.logger.log('error', 'support.staff_role_check_failed', {
      error: error instanceof Error ? error.name : 'unknown',
    });
    throw new ApiError(503, 'service_unavailable');
  }
  if (roleAccess === null) {
    throw new ApiError(403, 'forbidden');
  }
  return roleAccess;
}

/**
 * Authenticated Support Desk customer and staff API.
 *
 * Session cookie `__Host-pegma_session`, CSRF `X-Pegma-CSRF`, same-origin
 * Fetch Metadata for mutations. Principal is the Identity subject from the
 * session — never taken from the request body.
 *
 * Staff routes live under `/api/support/admin/…` and require the stored,
 * audited `Support` role.
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
          categories: [...PEGMA_SUPPORT_CATEGORIES],
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

      // --- Staff admin surface ---

      if (request.method === 'GET' && path === '/api/support/admin/queue') {
        const authenticated = await requireAuthentication(request, options);
        const access = await requireStaffAccess(authenticated, options);
        const queueQuery = parseStaffQueueQuery(url);
        const result = await options.application.listStaffQueue(
          access,
          queueQuery,
        );
        return json({
          items: result.items.map(staffQueueItemDto),
          csrfToken: authenticated.csrfToken,
        });
      }

      const adminMatch = ADMIN_TICKET_PATH.exec(path);
      if (
        adminMatch !== null &&
        adminMatch[2] === undefined &&
        request.method === 'GET'
      ) {
        const ticketId = adminMatch[1]!;
        const authenticated = await requireAuthentication(request, options);
        const access = await requireStaffAccess(authenticated, options);
        const view = await options.application.readStaffTicket(
          access,
          ticketId,
        );
        return json({
          ...staffTicketView(view),
          csrfToken: authenticated.csrfToken,
        });
      }

      if (
        adminMatch !== null &&
        adminMatch[2] === undefined &&
        request.method === 'PATCH'
      ) {
        requireSameOriginMutation(request);
        const ticketId = adminMatch[1]!;
        const authenticated = await requireAuthentication(request, options);
        await requireCsrf(request, authenticated);
        const access = await requireStaffAccess(authenticated, options);

        const body = optionalKeysObject(
          await readJson(request),
          ['action'],
          ['priority'],
        );
        const action = parseStaffPatchAction(body.action);
        // priority is only meaningful for change_priority — reject silent ignore.
        if (action !== 'change_priority' && Object.hasOwn(body, 'priority')) {
          throw new ApiError(400, 'invalid_request');
        }
        const commandId = mintSupportId();
        const correlationId = mintSupportId();

        let view: StaffTicketView;
        switch (action) {
          case 'assign':
            view = await options.application.assignTicket(access, {
              commandId,
              correlationId,
              ticketId,
              assigneeId: authenticated.link.subject,
            });
            break;
          case 'unassign':
            view = await options.application.assignTicket(access, {
              commandId,
              correlationId,
              ticketId,
              assigneeId: null,
            });
            break;
          case 'change_priority': {
            if (!Object.hasOwn(body, 'priority')) {
              throw new ApiError(400, 'invalid_request');
            }
            const priority = parseTicketPriority(body.priority);
            view = await options.application.changePriority(access, {
              commandId,
              correlationId,
              ticketId,
              priority,
            });
            break;
          }
          case 'resolve':
            view = await options.application.resolveTicket(access, {
              commandId,
              correlationId,
              ticketId,
            });
            break;
          case 'close':
            view = await options.application.closeTicket(access, {
              commandId,
              correlationId,
              ticketId,
            });
            break;
          case 'reopen':
            view = await options.application.reopenTicket(access, {
              commandId,
              correlationId,
              ticketId,
            });
            break;
          default: {
            action satisfies never;
            throw new ApiError(400, 'invalid_request');
          }
        }

        options.logger.log('info', 'support.staff_ticket_patched', {
          ticketNumber: view.ticket.number,
          action,
        });

        return json(staffTicketView(view));
      }

      if (
        adminMatch !== null &&
        adminMatch[2] === 'messages' &&
        request.method === 'POST'
      ) {
        requireSameOriginMutation(request);
        const ticketId = adminMatch[1]!;
        const authenticated = await requireAuthentication(request, options);
        await requireCsrf(request, authenticated);
        // Authorize before debiting the shared customer/staff reply limiter so
        // non-staff sessions fail closed without mutating quota state.
        const access = await requireStaffAccess(authenticated, options);
        await enforceRateLimit(
          options.replyLimiter,
          authenticated.link.subject,
        );

        const body = exactObject(await readJson(request), ['body']);
        const messageBody = boundedString(body.body, 1, 20_000, {
          allowMultiline: true,
        });
        // Mail/outbound notification deferred (Task 10) — omit notification.
        const view = await options.application.replyAsStaff(access, {
          commandId: mintSupportId(),
          correlationId: mintSupportId(),
          ticketId,
          messageId: mintSupportId(),
          body: messageBody,
        });

        options.logger.log('info', 'support.staff_replied', {
          ticketNumber: view.ticket.number,
        });

        return json(staffTicketView(view), { status: 201 });
      }

      if (
        adminMatch !== null &&
        adminMatch[2] === 'notes' &&
        request.method === 'POST'
      ) {
        requireSameOriginMutation(request);
        const ticketId = adminMatch[1]!;
        const authenticated = await requireAuthentication(request, options);
        await requireCsrf(request, authenticated);
        // Same order as messages: staff check before shared limiter debit.
        const access = await requireStaffAccess(authenticated, options);
        await enforceRateLimit(
          options.replyLimiter,
          authenticated.link.subject,
        );

        const body = exactObject(await readJson(request), ['body']);
        const messageBody = boundedString(body.body, 1, 20_000, {
          allowMultiline: true,
        });
        const view = await options.application.addNote(access, {
          commandId: mintSupportId(),
          correlationId: mintSupportId(),
          ticketId,
          messageId: mintSupportId(),
          body: messageBody,
        });

        options.logger.log('info', 'support.staff_note_added', {
          ticketNumber: view.ticket.number,
        });

        return json(staffTicketView(view), { status: 201 });
      }

      // --- Customer mutations ---

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
        const messageBody = boundedString(body.body, 1, 20_000, {
          allowMultiline: true,
        });
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
        const messageBody = boundedString(body.body, 1, 20_000, {
          allowMultiline: true,
        });
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
