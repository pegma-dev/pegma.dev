import {
  createDurableLimiter,
  defineRateLimitPolicy,
  type DurableRateLimiter,
} from '@pegma/rate-limit';
import {
  systemClock,
  type Clock,
  type Logger,
  type PrincipalId,
} from '@pegma/spine';
import { createCloudflareD1Store } from '@pegma/storage-cloudflare-d1';
import type { Store } from '@pegma/storage-core';
import {
  createSupportDeskApplication,
  defaultQueueTerminalRetentionMilliseconds,
  SupportDeskAuthorizationError,
  SupportDeskConflictError,
  SupportDeskLimitError,
  SupportDeskNotFoundError,
  SupportDeskQueueCapacityError,
  ticketNumbers,
  type SupportDeskApplication,
} from '@pegma/support-desk-application';
import { defineTemplate } from '@pegma/support-desk-templates';
import type { IdentityLinkProjector, IdentityPort } from './identity-contracts';
import type { SessionStore } from '@pegma/sessions';

/** Host-configured category allowlist for pegma.dev product feedback. */
export const PEGMA_SUPPORT_CATEGORIES = Object.freeze([
  'feedback',
  'bug',
  'feature_request',
  'documentation',
  'question',
] as const);

export type PegmaSupportCategory = (typeof PEGMA_SUPPORT_CATEGORIES)[number];

export const PEGMA_SUPPORT_CATEGORY_SET: ReadonlySet<string> = new Set(
  PEGMA_SUPPORT_CATEGORIES,
);

/** Durable rate-limit policy names (separate from Identity). */
export const SUPPORT_CREATE_LIMIT_POLICY = 'pegma.support.ticket.create';
export const SUPPORT_REPLY_LIMIT_POLICY = 'pegma.support.ticket.reply';

export const SUPPORT_TERMINAL_RETENTION_MS =
  defaultQueueTerminalRetentionMilliseconds;

/** Public ticket URL on pegma.dev (own-ticket tracking page). */
export function publicTicketUrl(ticketId: string): string {
  return `https://pegma.dev/feedback/${encodeURIComponent(ticketId)}`;
}

/** Subject marker helpers: `[PEG-1042]`. */
export function pegSubjectMarker(ticketNumber: number): string {
  if (!Number.isSafeInteger(ticketNumber) || ticketNumber <= 0) {
    throw new TypeError('ticketNumber must be a positive safe integer');
  }
  return `[PEG-${ticketNumber}]`;
}

export function formatPegmaTicketSubject(
  ticketNumber: number,
  subject: string,
): string {
  return `${pegSubjectMarker(ticketNumber)} ${subject}`;
}

/** Pegma-branded templates (available for later mail activation). */
export const pegmaStaffNewTicketTemplate = defineTemplate({
  id: 'pegma.staff-new-ticket',
  version: 1,
  variables: ['ticket_number', 'subject'],
  plainText: 'New pegma.dev feedback #{{ticket_number}}: {{subject}}',
  html: '<p>New pegma.dev feedback #{{ticket_number}}: {{subject}}</p>',
});

export const pegmaCustomerReplyTemplate = defineTemplate({
  id: 'pegma.customer-reply',
  version: 1,
  variables: ['ticket_number', 'message_body', 'ticket_url'],
  httpsUrlVariables: ['ticket_url'],
  plainText:
    'Pegma replied to ticket #{{ticket_number}}.\n\n{{message_body}}\n\nView and reply: {{ticket_url}}',
  html: '<p>Pegma replied to ticket #{{ticket_number}}.</p><p>{{message_body}}</p><p><a href="{{ticket_url}}">View and reply</a></p>',
});

/** Server-minted opaque IDs for commands, tickets, and messages. */
export function mintSupportId(): string {
  return crypto.randomUUID();
}

export interface SupportErrorBody {
  readonly error: string;
}

/**
 * Map Support Desk application outcomes to host HTTP status + stable code.
 * Never include raw exception messages, storage keys, or conversation content.
 */
export function mapSupportError(error: unknown): {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds?: number;
} {
  if (error instanceof SupportDeskAuthorizationError) {
    return { status: 403, code: 'forbidden' };
  }
  if (error instanceof SupportDeskNotFoundError) {
    // Missing and non-owned tickets share one content-free 404.
    return { status: 404, code: 'not_found' };
  }
  if (error instanceof SupportDeskConflictError) {
    return { status: 409, code: 'conflict' };
  }
  if (error instanceof SupportDeskQueueCapacityError) {
    return { status: 503, code: 'queue_unavailable' };
  }
  if (error instanceof SupportDeskLimitError) {
    if (error.field === 'subject' || error.field === 'body') {
      return { status: 413, code: 'payload_too_large' };
    }
    return { status: 409, code: 'limit_exceeded' };
  }
  if (error instanceof TypeError) {
    return { status: 400, code: 'invalid_request' };
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'rate_limited'
  ) {
    const retryAfter =
      'retryAfter' in error &&
      typeof (error as { readonly retryAfter?: unknown }).retryAfter ===
        'number' &&
      Number.isFinite((error as { readonly retryAfter: number }).retryAfter) &&
      (error as { readonly retryAfter: number }).retryAfter > 0
        ? Math.ceil(
            (error as { readonly retryAfter: number }).retryAfter / 1_000,
          )
        : undefined;
    return { status: 429, code: 'rate_limited', retryAfterSeconds: retryAfter };
  }
  return { status: 500, code: 'internal_error' };
}

export interface SupportRuntimeEnv {
  readonly IDENTITY_DB: D1Database;
  /** When `"true"`, health includes a lightweight Support Desk store probe. */
  readonly SUPPORT_HEALTH_PROBE?: string;
}

export interface SupportCompositionOptions {
  readonly store: Store;
  readonly sessions: SessionStore;
  readonly identity: IdentityPort;
  readonly identityLinkFromClaims: IdentityLinkProjector;
  readonly logger: Logger;
  readonly clock?: Clock;
  readonly createLimiter?: DurableRateLimiter;
  readonly replyLimiter?: DurableRateLimiter;
}

export interface SupportRuntime {
  readonly store: Store;
  readonly application: SupportDeskApplication;
  readonly clock: Clock;
  readonly createLimiter: DurableRateLimiter;
  readonly replyLimiter: DurableRateLimiter;
  readonly limiters: readonly DurableRateLimiter[];
  readonly terminalRetentionMilliseconds: number;
  readonly sessions: SessionStore;
  readonly identity: IdentityPort;
  readonly identityLinkFromClaims: IdentityLinkProjector;
}

function durableLimiter(
  store: Store,
  name: string,
  limit: number,
  windowMs: number,
  clock: Clock,
): DurableRateLimiter {
  return createDurableLimiter(
    defineRateLimitPolicy({ name, limit, windowMs }),
    store,
    { clock },
  );
}

/**
 * Production Support Desk composition for pegma.dev.
 *
 * Uses the same `IDENTITY_DB` D1 binding with Support Desk's own collection
 * names (`support-desk.*.v1`). Isolation is by collection, not by sharing
 * Identity mail cursors or session row layouts.
 */
export function createProductionSupportRuntime(
  env: SupportRuntimeEnv,
  options: Omit<SupportCompositionOptions, 'store'>,
): SupportRuntime {
  const store = createCloudflareD1Store({
    database: env.IDENTITY_DB,
    createSchemaIfMissing: false,
  });
  return createSupportRuntime({ ...options, store });
}

/** Exact package composition with an injected conforming Store for tests. */
export function createSupportRuntime(
  options: SupportCompositionOptions,
): SupportRuntime {
  const store = options.store;
  const clock = options.clock ?? systemClock;
  const createLimiter =
    options.createLimiter ??
    durableLimiter(store, SUPPORT_CREATE_LIMIT_POLICY, 10, 60 * 60_000, clock);
  const replyLimiter =
    options.replyLimiter ??
    durableLimiter(store, SUPPORT_REPLY_LIMIT_POLICY, 30, 60 * 60_000, clock);

  const application = createSupportDeskApplication({
    store,
    clock,
    logger: options.logger,
    allowedCategories: PEGMA_SUPPORT_CATEGORIES,
    queueTerminalRetentionMilliseconds: SUPPORT_TERMINAL_RETENTION_MS,
  });

  return Object.freeze({
    store,
    application,
    clock,
    createLimiter,
    replyLimiter,
    limiters: Object.freeze([createLimiter, replyLimiter]),
    terminalRetentionMilliseconds: SUPPORT_TERMINAL_RETENTION_MS,
    sessions: options.sessions,
    identity: options.identity,
    identityLinkFromClaims: options.identityLinkFromClaims,
  });
}

/** Lightweight store probe for health — no ticket or message content. */
export async function probeSupportStore(store: Store): Promise<{
  readonly ok: boolean;
  readonly collections: 'support-desk';
}> {
  // Touch the ticket-number collection key path without reading message bodies.
  // A get that returns null is success; thrown storage errors fail the probe.
  await store.collection(ticketNumbers).get({
    partition: 'instance',
    id: 'ticket-number',
  });
  return { ok: true, collections: 'support-desk' };
}

export function supportHealthProbeEnabled(env: {
  readonly SUPPORT_HEALTH_PROBE?: string;
}): boolean {
  return String(env.SUPPORT_HEALTH_PROBE ?? '') === 'true';
}

/** Type-only re-export helper for principal branding at the host boundary. */
export type SupportPrincipalId = PrincipalId;
