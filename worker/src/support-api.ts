import { knowledgePermissions } from '@pegma/knowledge-base-contracts';
import type { SupportLearningHandlerOptions } from './support-learning-handlers';
import { createSupportReleaseFollowupHandlers, type SupportReleaseFollowupHandlerOptions } from './support-release-followup-handlers';
import {
  bestEffortSupportAssistantHint,
  supportAssistantAcceptedTarget,
  type SupportAssistantHintCallback,
} from './support-assistant';
import {
  createSupportEngineeringRouter,
  type SupportEngineeringRouterOptions,
} from './support-engineering-router';
import type { Logger, PrincipalId } from '@pegma/spine';
import type { SessionStore } from '@pegma/sessions';
import type { DurableRateLimiter } from '@pegma/rate-limit';
import { hasPermission } from '@pegma/authorization-core';
import type {
  CustomerTicketSummary,
  CustomerTicketView,
  HandoffWorkDto,
  StaffQueueItem,
  StaffQueueQuery,
  StaffTicketView,
  SupportDeskApplication,
} from '@pegma/support-desk-application';
import { supportPermissions } from '@pegma/support-desk-application';
import {
  effectiveTicketHandling,
  TicketWorkflowError,
} from '@pegma/support-desk-core';
import type {
  Ticket,
  TicketMessage,
  TicketPriority,
  TicketStatus,
} from '@pegma/support-desk-contracts';
import { IDENTITY_ISSUER, SESSION_COOKIE } from './identity-api';
import type {
  IdentityLinkKey,
  IdentityLinkProjector,
  IdentityPort,
  IdentityUser,
  VerifiedIdentityClaims,
} from './identity-contracts';
import {
  ApiError,
  authenticate,
  boundedString,
  enforceRateLimit,
  exactObject,
  json,
  optionalKeysObject,
  readJson,
  requireCsrf,
  requireSameOriginMutation,
  type Authenticated,
} from './api-auth';
import {
  ensureBootstrapSupport,
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
import {
  supportHumanBrowser,
  type SupportHumanCoordinates,
} from './support-human-auth';
import {
  createSupportLearningBrowserHandlers,
  type SupportLearningRuntimeOptions,
} from './support-learning';
import {
  SUPPORT_BROWSER_COMMAND_HEADER,
  supportBrowserCommand,
  supportBrowserCommandMode,
} from './support-browser-commands';

const TICKET_ID_PATH =
  /^\/api\/support\/tickets\/([A-Za-z0-9._~-]{1,200})(?:\/(replies))?$/u;
const ADMIN_TICKET_PATH =
  /^\/api\/support\/admin\/tickets\/([A-Za-z0-9._~-]{1,200})(?:\/(messages|notes))?$/u;
const PERSON_PATH =
  /^\/api\/support\/tickets\/([A-Za-z0-9._~-]{1,200})\/request-person$/u;
const SUCCESS_PATH =
  /^\/api\/support\/tickets\/([A-Za-z0-9._~-]{1,200})\/confirm-success$/u;
const HUMAN_STAFF_PATH =
  /^\/api\/support\/admin\/tickets\/([A-Za-z0-9._~-]{1,200})\/(take-over|handoff)$/u;

// Own this namespace before legacy browser-command routing, including unknown
// learning subpaths. Disabled composition is indistinguishable from absence.
const LEARNING_NAMESPACE =
  /^\/api\/support\/admin\/tickets\/[A-Za-z0-9._~-]{1,200}\/learning(?:\/|$)/u;

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
  'assign' | 'unassign' | 'change_priority' | 'resolve' | 'close' | 'reopen';

interface SupportApiOptions {
  /** Trusted body-free advisory wake hint after an accepted customer message. */
  readonly onCustomerMessageAccepted?: SupportAssistantHintCallback;
  readonly application: SupportDeskApplication;
  readonly sessions: SessionStore;
  readonly identity: IdentityPort;
  readonly identityLinkFromClaims: IdentityLinkProjector;
  readonly createLimiter: DurableRateLimiter;
  readonly replyLimiter: DurableRateLimiter;
  readonly logger: Logger;
  /**
   * Audited role store â€” the ONLY staff gate (docs/ROLE_ADOPTION_PLAN.md
   * Phase 4). Absent â‡’ staff routes are a controlled 503, fail closed.
   */
  readonly roleStore?: SupportRoleReader & BootstrapRoleStore;
  /** One-time Support bootstrap principals (Phase 3). */
  readonly bootstrapPrincipals?: ReadonlySet<string>;
  /** Trusted optional composition: construct createSupportLearningHandlers in the host. */
  readonly learningHandler?: (request: Request) => Promise<Response | null>;
  /** Trusted runtime ports; the API owns actual browser/staff resolution. */
  readonly learningRuntime?: Omit<SupportLearningRuntimeOptions, 'staffAccess'>;
  /** Current server flag. Only strict true plus a handler enables this surface. */
  readonly learningEnabled?: () => boolean;
  readonly learningTestReceiptPreparation?: SupportLearningHandlerOptions['testReceiptPreparation'];
  readonly learningTestReceiptEnabled?: () => boolean;
  /** Additive trusted staged-review capability; it never enables learning itself. */
  readonly learningStagedReviewsEnabled?: () => boolean;
  readonly engineering?: SupportEngineeringRouterOptions;
  readonly releaseFollowup?: SupportReleaseFollowupHandlerOptions;
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
  // grant. Fail OPEN â€” a seed failure must not break the request; it
  // retries on the next touch. The set-membership check short-circuits for
  // everyone not listed.
  if (
    options.roleStore !== undefined &&
    options.bootstrapPrincipals !== undefined &&
    options.bootstrapPrincipals.size > 0
  ) {
    try {
      const seeded = await ensureBootstrapSupport(
        options.roleStore,
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
    ...(ticket.handling === undefined ? {} : { handling: ticket.handling }),
    marker: pegSubjectMarker(ticket.number),
    url: publicTicketUrl(ticket.id),
  };
}

export function publicTicketView(view: CustomerTicketView) {
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
    handling: effectiveTicketHandling(ticket),
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
    handling: item.handling,
  };
}

function handoffDto(value: HandoffWorkDto) {
  return {
    ticketId: value.ticketId,
    workId: value.workId,
    status: value.status,
    reason: value.reason,
    ...(value.summary === undefined ? {} : { summary: value.summary }),
    attemptedGuideIds: [...value.attemptedGuideIds],
    transcript: {
      ticketId: value.transcript.ticketId,
      throughRevision: value.transcript.throughRevision,
      lastVisibleMessageId: value.transcript.lastVisibleMessageId,
    },
    handlingGeneration: value.handlingGeneration,
    createdAt: value.createdAt,
  };
}

function clientCommand(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  )
    throw new ApiError(400, 'invalid_request');
  return value;
}

function controlInteger(value: unknown, minimum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum
  )
    throw new ApiError(400, 'invalid_request');
  return value;
}

function publicError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }
  const mapped = mapSupportError(error);
  return new ApiError(mapped.status, mapped.code, mapped.retryAfterSeconds);
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
    handling?: 'human' | 'assistant' | 'all';
    status?: TicketStatus;
    priority?: TicketPriority;
    sort?: QueueSort;
    unassignedOnly?: boolean;
  } = {};

  const handling = url.searchParams.get('handling');
  if (handling !== null) {
    if (
      url.searchParams.getAll('handling').length !== 1 ||
      (handling !== 'human' && handling !== 'assistant' && handling !== 'all')
    )
      throw new ApiError(400, 'invalid_request');
    query.handling = handling;
  }

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
  authenticated: Pick<Authenticated, 'link'>,
  options: SupportApiOptions,
) {
  // The stored Support ROLE is the only gate (docs/ROLE_ADOPTION_PLAN.md
  // Phase 4) and it FAILS CLOSED: a host wired without a role store or a
  // role-store failure is a controlled 503, never a quiet allow or a
  // misleading 403.
  if (options.roleStore === undefined) {
    throw new ApiError(503, 'support_not_configured');
  }
  let roleAccess: Awaited<ReturnType<typeof staffAccessContextFromRoles>>;
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

/** Keep the active verified Identity observation after awaited stored roles,
 * matching the existing public browser-principal resolver's ordering. */
async function humanAccess(
  authenticated: SupportHumanCoordinates,
  options: SupportApiOptions,
  staff: boolean,
  observeCurrentUser?: (user: IdentityUser) => void,
) {
  const access = staff
    ? await requireStaffAccess(authenticated, options)
    : customerAccessContext(authenticated.link.subject);
  try {
    if (observeCurrentUser !== undefined) {
      const user = await options.identity.getUser(authenticated.link.subject);
      if (
        user === null ||
        user.principalId !== authenticated.link.subject ||
        user.status !== 'active' ||
        user.emailVerified !== true
      )
        throw new ApiError(401, 'authentication_required');
      if (typeof user.email !== 'string' || user.email.length === 0)
        throw new ApiError(503, 'service_unavailable');
      observeCurrentUser(user);
    }
    const claims = await options.identity.claimsFor(authenticated.link.subject);
    const link = options.identityLinkFromClaims(claims);
    if (
      claims.emailVerified !== true ||
      link.issuer !== authenticated.link.issuer ||
      link.subject !== authenticated.link.subject
    )
      throw new ApiError(401, 'authentication_required');
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? error.code
        : undefined;
    if (code === 'not_found' || code === 'invalid_state')
      throw new ApiError(401, 'authentication_required');
    throw new ApiError(503, 'service_unavailable');
  }
  return access;
}

type StableBrowserRoute =
  | { readonly kind: 'create' }
  | {
      readonly kind: 'customer-reply' | 'staff-reply' | 'note' | 'patch';
      readonly ticketId: string;
    };

function stableBrowserRoute(request: Request): StableBrowserRoute {
  const url = new URL(request.url);
  if (url.search !== '') throw new ApiError(400, 'invalid_request');
  if (url.pathname === '/api/support/tickets' && request.method === 'POST')
    return { kind: 'create' };
  const customer = TICKET_ID_PATH.exec(url.pathname);
  if (
    customer?.[1] !== undefined &&
    customer[2] === 'replies' &&
    request.method === 'POST'
  )
    return { kind: 'customer-reply', ticketId: customer[1] };
  const staff = ADMIN_TICKET_PATH.exec(url.pathname);
  if (staff?.[1] !== undefined) {
    if (staff[2] === undefined && request.method === 'PATCH')
      return { kind: 'patch', ticketId: staff[1] };
    if (
      request.method === 'POST' &&
      (staff[2] === 'messages' || staff[2] === 'notes')
    )
      return {
        kind: staff[2] === 'messages' ? 'staff-reply' : 'note',
        ticketId: staff[1],
      };
  }
  throw new ApiError(400, 'invalid_request');
}

/** Optional browser retries reuse SDK receipts; this host stores no intent state. */
async function stableBrowserMutation(
  request: Request,
  options: SupportApiOptions,
): Promise<Response> {
  const route = stableBrowserRoute(request);
  const staff = route.kind !== 'create' && route.kind !== 'customer-reply';
  const entryPermission =
    route.kind === 'create'
      ? supportPermissions.create
      : route.kind === 'customer-reply'
        ? supportPermissions.replyOwn
        : route.kind === 'staff-reply'
          ? supportPermissions.replyAny
          : route.kind === 'note'
            ? supportPermissions.note
            : supportPermissions.queueRead;
  let requesterEmail: string | undefined;
  let observeContact = false;
  const browser = supportHumanBrowser(request, {
    sessions: options.sessions,
    authenticate: (incoming) => requireAuthentication(incoming, options),
    access: (authenticated) =>
      humanAccess(
        authenticated,
        options,
        staff,
        observeContact
          ? (user) => {
              requesterEmail = user.email;
            }
          : undefined,
      ),
    permission: entryPermission,
    mutation: true,
  });
  async function current(permission: string = entryPermission) {
    if (request.headers.get(SUPPORT_BROWSER_COMMAND_HEADER) !== '1')
      throw new ApiError(403, 'browser_credential_changed');
    const fresh = await browser.current();
    if (request.headers.get(SUPPORT_BROWSER_COMMAND_HEADER) !== '1')
      throw new ApiError(403, 'browser_credential_changed');
    if (!hasPermission(fresh.access, permission))
      throw new ApiError(403, 'forbidden');
    return fresh;
  }
  const initial = await current();
  if (route.kind !== 'patch')
    await enforceRateLimit(
      route.kind === 'create' ? options.createLimiter : options.replyLimiter,
      initial.authenticated.link.subject,
    );
  const raw = await readJson(request, { timeoutMs: 10_000 });
  const body =
    route.kind === 'create'
      ? exactObject(raw, ['command', 'subject', 'body', 'category'])
      : route.kind === 'patch'
        ? optionalKeysObject(raw, ['command', 'action'], ['priority'])
        : exactObject(raw, ['command', 'body']);
  const action =
    route.kind === 'patch' ? parseStaffPatchAction(body.action) : undefined;
  if (
    route.kind === 'patch' &&
    action !== 'change_priority' &&
    Object.hasOwn(body, 'priority')
  )
    throw new ApiError(400, 'invalid_request');
  const permission =
    route.kind === 'patch'
      ? action === 'assign' || action === 'unassign'
        ? supportPermissions.assign
        : supportPermissions.manage
      : entryPermission;
  // No full second bootstrap: resolve current roles, active verified Identity
  // and the same immutable session after the limiter and awaited body.
  // Create contact observations precede the existing claims and closing session
  // reads. They never supply principal or permission authority.
  observeContact = route.kind === 'create';
  const admitted = await current(permission);
  const access = admitted.access;
  const correlationId = mintSupportId();
  if (route.kind === 'create') {
    const { expectedRequesterEmail, ...command } = supportBrowserCommand(
      body.command,
      access.principalId,
      'create',
    );
    const subject = boundedString(body.subject, 1, 200);
    const messageBody = boundedString(body.body, 1, 20_000, {
      allowMultiline: true,
    });
    const category = parseCategory(body.category);
    if (requesterEmail === undefined)
      throw new ApiError(503, 'service_unavailable');
    let createAccess = access;
    if (expectedRequesterEmail !== requesterEmail) {
      // An obsolete contact can only describe a possible receipt replay on a
      // currently owned target. This read is not a command-outcome ACK.
      await options.application.readCustomerTicket(access, command.ticketId);
      createAccess = (await current(permission)).access;
    }
    const view = await options.application.createCustomerTicket(createAccess, {
      ...command,
      correlationId,
      subject,
      body: messageBody,
      category,
      ...(expectedRequesterEmail === null
        ? {}
        : { requesterEmail: expectedRequesterEmail }),
    });
    await current(permission);
    options.logger.log('info', 'support.ticket_created', {
      ticketNumber: view.ticket.number,
      category,
    });
    // Preserve the existing create DTO; no browser protocol metadata is public.
    return json(publicTicketView(view), { status: 201 });
  }
  if (route.kind === 'customer-reply') {
    const command = supportBrowserCommand(
      body.command,
      access.principalId,
      'message',
    );
    const messageBody = boundedString(body.body, 1, 20_000, {
      allowMultiline: true,
    });
    const view = await options.application.replyToCustomerTicket(access, {
      ...command,
      correlationId,
      ticketId: route.ticketId,
      body: messageBody,
    });
    const acceptedTarget = supportAssistantAcceptedTarget(
      view,
      command.messageId,
    );
    if (acceptedTarget !== undefined)
      await bestEffortSupportAssistantHint(
        options.onCustomerMessageAccepted,
        acceptedTarget,
      );
    const final = await current(permission);
    options.logger.log('info', 'support.ticket_replied', {
      ticketNumber: view.ticket.number,
    });
    return json(
      { ...publicTicketView(view), csrfToken: final.authenticated.csrfToken },
      { status: 201 },
    );
  }
  if (route.kind === 'staff-reply' || route.kind === 'note') {
    const command = supportBrowserCommand(
      body.command,
      access.principalId,
      'message',
    );
    const messageBody = boundedString(body.body, 1, 20_000, {
      allowMultiline: true,
    });
    const input = {
      ...command,
      correlationId,
      ticketId: route.ticketId,
      body: messageBody,
    };
    const view =
      route.kind === 'staff-reply'
        ? await options.application.replyAsStaff(access, input)
        : await options.application.addNote(access, input);
    const final = await current(permission);
    options.logger.log(
      'info',
      route.kind === 'staff-reply'
        ? 'support.staff_replied'
        : 'support.staff_note_added',
      { ticketNumber: view.ticket.number },
    );
    return json(
      { ...staffTicketView(view), csrfToken: final.authenticated.csrfToken },
      { status: 201 },
    );
  }
  const command = supportBrowserCommand(
    body.command,
    access.principalId,
    'patch',
  );
  const input = { ...command, correlationId, ticketId: route.ticketId };
  let view: StaffTicketView;
  switch (action) {
    case 'assign':
      view = await options.application.assignTicket(access, {
        ...input,
        assigneeId: access.principalId,
      });
      break;
    case 'unassign':
      view = await options.application.assignTicket(access, {
        ...input,
        assigneeId: null,
      });
      break;
    case 'change_priority':
      view = await options.application.changePriority(access, {
        ...input,
        priority: parseTicketPriority(body.priority),
      });
      break;
    case 'resolve':
      view = await options.application.resolveTicket(access, input);
      break;
    case 'close':
      view = await options.application.closeTicket(access, input);
      break;
    case 'reopen':
      view = await options.application.reopenTicket(access, input);
      break;
    default:
      throw new ApiError(400, 'invalid_request');
  }
  const final = await current(permission);
  options.logger.log('info', 'support.staff_ticket_patched', {
    ticketNumber: view.ticket.number,
    action,
  });
  return json({
    ...staffTicketView(view),
    csrfToken: final.authenticated.csrfToken,
  });
}

/**
 * Authenticated Support Desk customer and staff API.
 *
 * Session cookie `__Host-pegma_session`, CSRF `X-Pegma-CSRF`, same-origin
 * Fetch Metadata for mutations. Principal is the Identity subject from the
 * session â€” never taken from the request body.
 *
 * Staff routes live under `/api/support/admin/â€¦` and require the stored,
 * audited `Support` role.
 */
export function createSupportApi(
  options: SupportApiOptions,
): (request: Request) => Promise<Response> {
  const followupHandler = createSupportReleaseFollowupHandlers(options.releaseFollowup);
  const engineeringRouter = createSupportEngineeringRouter(options.engineering);
  const engineeringReady = (): boolean => {
    if (options.engineering?.configuration === undefined) return false;
    try {
      return options.engineering.enabled?.() === true;
    } catch {
      return false;
    }
  };
  const engineeringReviewReady = (): boolean => {
    if (!engineeringReady()) return false;
    try {
      return options.engineering?.configuration?.reviewEnabled?.() === true;
    } catch {
      return false;
    }
  };
  if (
    options.learningHandler !== undefined &&
    options.learningRuntime !== undefined
  )
    throw new TypeError('Choose one trusted Support learning composition');
  const learningHandler =
    options.learningHandler ??
    (options.learningRuntime !== undefined && options.roleStore !== undefined
      ? createSupportLearningBrowserHandlers({
          identity: options.identity,
          sessions: options.sessions,
          identityLinkFromClaims: options.identityLinkFromClaims,
          logger: options.logger,
          roleStore: options.roleStore,
          ...(options.learningEnabled === undefined
            ? {}
            : { enabled: options.learningEnabled }),
          ...(options.learningTestReceiptPreparation === undefined ? {} : {
            testReceiptPreparation: options.learningTestReceiptPreparation,
            testReceiptPreparationEnabled: options.learningTestReceiptEnabled,
          }),
          limiter: options.replyLimiter,
          learning: options.learningRuntime,
        })
      : undefined);
  const learningReady = (): boolean => {
    if (
      typeof learningHandler !== 'function' ||
      typeof options.learningEnabled !== 'function'
    )
      return false;
    try {
      return options.learningEnabled() === true;
    } catch {
      return false;
    }
  };
  const testReceiptsReady = (): boolean => {
    try {
      return learningReady() && options.learningTestReceiptPreparation !== undefined &&
        options.learningTestReceiptEnabled?.() === true;
    } catch { return false; }
  };
  const stagedReviewsReady = (): boolean => {
    if (
      !learningReady() ||
      options.learningRuntime?.stagedReviews === undefined
    )
      return false;
    try {
      return (
        options.learningStagedReviewsEnabled?.() === true &&
        options.learningRuntime.stagedReviews.enabled() === true
      );
    } catch {
      return false;
    }
  };
  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      const followupResponse = await followupHandler(request);
      if (followupResponse !== null) return followupResponse;
      const engineeringResponse = await engineeringRouter(request);
      if (engineeringResponse !== null) return engineeringResponse;
      if (LEARNING_NAMESPACE.test(path)) {
        if (!learningReady()) throw new ApiError(404, 'not_found');
        let response: Response | null;
        try {
          response = await learningHandler!(request);
        } catch {
          throw new ApiError(503, 'support_learning_unavailable');
        }
        // A flag change may withhold an ACK; the browser retains its exact packet.
        if (!learningReady() || response === null)
          throw new ApiError(404, 'not_found');
        return response;
      }
      const success = SUCCESS_PATH.exec(path);
      if (success !== null) {
        if (request.method !== 'POST')
          return json(
            { error: 'method_not_allowed' },
            { status: 405, headers: { Allow: 'POST' } },
          );
        if (url.search !== '') throw new ApiError(400, 'invalid_request');
        const browser = supportHumanBrowser(request, {
          sessions: options.sessions,
          authenticate: (incoming) => requireAuthentication(incoming, options),
          access: (authenticated) => humanAccess(authenticated, options, false),
          permission: supportPermissions.confirmSuccess,
          mutation: true,
        });
        const initial = await browser.current();
        const packet = exactObject(await readJson(request, { timeoutMs: 10_000 }), [
          'commandId',
          'lastSeenVisibleMessageId',
        ]);
        const commandId = clientCommand(packet.commandId);
        const lastSeenVisibleMessageId = boundedString(
          packet.lastSeenVisibleMessageId,
          1,
          200,
        );
        await enforceRateLimit(
          options.replyLimiter,
          initial.authenticated.link.subject,
        );
        const current = await browser.current();
        const view = await options.application
          .confirmCustomerSuccess(current.access, {
            ticketId: success[1]!,
            commandId,
            correlationId: mintSupportId(),
            lastSeenVisibleMessageId,
          })
          .catch((error: unknown) => {
            if (error instanceof TicketWorkflowError)
              throw new ApiError(409, 'conflict');
            throw error;
          });
        const final = await browser.current();
        return json({
          ...publicTicketView(view),
          csrfToken: final.authenticated.csrfToken,
        });
      }
      if (supportBrowserCommandMode(request))
        return await stableBrowserMutation(request, options);
      const person = PERSON_PATH.exec(path);
      const humanStaff = HUMAN_STAFF_PATH.exec(path);
      if (person !== null || humanStaff !== null) {
        const handoff = humanStaff?.[2] === 'handoff';
        const method = handoff ? 'GET' : 'POST';
        if (request.method !== method)
          return json(
            { error: 'method_not_allowed' },
            { status: 405, headers: { Allow: method } },
          );
        if (url.search !== '' || (handoff && request.body !== null))
          throw new ApiError(400, 'invalid_request');
        const ticketId = (person ?? humanStaff)![1]!;
        const browser = supportHumanBrowser(request, {
          sessions: options.sessions,
          authenticate: (incoming) => requireAuthentication(incoming, options),
          access: (authenticated) =>
            humanAccess(authenticated, options, person === null),
          permission:
            person !== null
              ? supportPermissions.requestPerson
              : handoff
                ? supportPermissions.queueRead
                : supportPermissions.takeOver,
          mutation: !handoff,
        });
        const initial = await browser.current();
        if (handoff) {
          const work = await options.application.readHandoffWork(
            initial.access,
            ticketId,
          );
          const final = await browser.current();
          return json({
            handoff: work.map(handoffDto),
            csrfToken: final.authenticated.csrfToken,
          });
        }
        const packet = exactObject(
          await readJson(request, { timeoutMs: 10_000 }),
          person !== null
            ? ['commandId']
            : ['commandId', 'expectedRevision', 'expectedHandlingGeneration'],
        );
        const commandId = clientCommand(packet.commandId);
        const fence =
          person !== null
            ? undefined
            : {
                expectedRevision: controlInteger(packet.expectedRevision, 1),
                expectedHandlingGeneration: controlInteger(
                  packet.expectedHandlingGeneration,
                  0,
                ),
              };
        // Human controls share the existing durable reply budget, including
        // exact command replays. Recheck live authority after this awaited debit.
        await enforceRateLimit(
          options.replyLimiter,
          initial.authenticated.link.subject,
        );
        const current = await browser.current();
        const command = { commandId, correlationId: mintSupportId(), ticketId };
        if (person !== null) {
          const view = await options.application.requestPerson(
            current.access,
            command,
          );
          const final = await browser.current();
          options.logger.log('info', 'support.ticket_human_requested', {
            ticketNumber: view.ticket.number,
          });
          return json({
            ...publicTicketView(view),
            csrfToken: final.authenticated.csrfToken,
          });
        }
        let view: StaffTicketView;
        try {
          view = await options.application.takeOverTicket(current.access, {
            ...command,
            ...fence!,
          });
        } catch (error) {
          if (error instanceof TicketWorkflowError)
            throw new ApiError(409, 'conflict');
          throw error;
        }
        const final = await browser.current();
        options.logger.log('info', 'support.staff_ticket_taken_over', {
          ticketNumber: view.ticket.number,
        });
        return json({
          ...staffTicketView(view),
          csrfToken: final.authenticated.csrfToken,
        });
      }
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
        if (
          typeof options.learningEnabled === 'function' ||
          options.engineering !== undefined
        ) {
          // This optional hint comes from current real stored Support authority,
          // active Identity and the same live session, never browser role fields.
          const browser = supportHumanBrowser(request, {
            sessions: options.sessions,
            authenticate: (incoming) =>
              requireAuthentication(incoming, options),
            access: (authenticated) =>
              humanAccess(authenticated, options, true),
            permission: supportPermissions.queueRead,
            mutation: false,
          });
          try {
            const initial = await browser.current();
            const view = await options.application.readStaffTicket(
              initial.access,
              ticketId,
            );
            const final = await browser.current();
            return json({
              ...staffTicketView(view),
              csrfToken: final.authenticated.csrfToken,
              ...(options.engineering === undefined
                ? {}
                : {
                    engineeringEnabled:
                      engineeringReady() &&
                      [
                        supportPermissions.engineeringRead,
                        supportPermissions.engineeringEvidenceSubmit,
                        supportPermissions.engineeringWithdraw,
                        supportPermissions.engineeringPolicyRead,
                        supportPermissions.engineeringPolicyManage,
                      ].some((permission) =>
                        hasPermission(final.access, permission),
                      ),
                    engineeringReviewEnabled:
                      engineeringReviewReady() &&
                      hasPermission(
                        final.access,
                        supportPermissions.engineeringReview,
                      ),
                  }),
              learningEnabled:
                learningReady() &&
                hasPermission(final.access, supportPermissions.learningRead),
              learningReviewRecoveryEnabled:
                learningReady() &&
                hasPermission(
                  final.access,
                  supportPermissions.learningReview,
                ) &&
                hasPermission(final.access, supportPermissions.queueRead),
              ...(options.learningTestReceiptEnabled === undefined ? {} : {
                learningTestReceiptEnabled: testReceiptsReady() &&
                  hasPermission(final.access, supportPermissions.learningEvidenceSubmit) &&
                  hasPermission(final.access, knowledgePermissions.draftRead) &&
                  hasPermission(final.access, knowledgePermissions.evidenceRead),
              }),
              ...(options.learningStagedReviewsEnabled === undefined
                ? {}
                : {
                    learningStagedReviewEnabled:
                      stagedReviewsReady() &&
                      hasPermission(
                        final.access,
                        supportPermissions.learningReview,
                      ) &&
                      hasPermission(final.access, supportPermissions.queueRead),
                  }),
            });
          } catch (error) {
            // A raced loss of current access wins over an earlier failed read.
            await browser.current();
            throw error;
          }
        }
        // Preserve the legacy detail contract when no capability callback exists.
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
        // priority is only meaningful for change_priority â€” reject silent ignore.
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

        return json({
          ...staffTicketView(view),
          csrfToken: authenticated.csrfToken,
        });
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
        // Mail/outbound notification deferred (Task 10) â€” omit notification.
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

        return json(
          { ...staffTicketView(view), csrfToken: authenticated.csrfToken },
          { status: 201 },
        );
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

        return json(
          { ...staffTicketView(view), csrfToken: authenticated.csrfToken },
          { status: 201 },
        );
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
        const commandId = mintSupportId();
        const correlationId = mintSupportId();
        const messageId = mintSupportId();
        const view = await options.application.replyToCustomerTicket(access, {
          commandId,
          correlationId,
          ticketId,
          messageId,
          body: messageBody,
        });

        const acceptedTarget = supportAssistantAcceptedTarget(view, messageId);
        if (acceptedTarget !== undefined)
          await bestEffortSupportAssistantHint(
            options.onCustomerMessageAccepted,
            acceptedTarget,
          );
        options.logger.log('info', 'support.ticket_replied', {
          ticketNumber: view.ticket.number,
        });

        return json(
          { ...publicTicketView(view), csrfToken: authenticated.csrfToken },
          { status: 201 },
        );
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
      return json({ error: mapped.code }, { status: mapped.status, headers });
    }
  };
}
