import { createWebhookLedger, type WebhookLedger } from '@pegma/webhooks';
import { createCloudflareD1Store } from '@pegma/storage-cloudflare-d1';
import type { Store } from '@pegma/storage-core';
import type { Logger } from '@pegma/spine';
import { verifyGitHubWebhookSignature } from './github-webhook-signature';
import {
  applyReleaseProjection,
  decideReleaseProjection,
  type ReleaseEventFacts,
} from './release-projection';

export const GITHUB_RELEASE_EVENT_TYPE = 'github.release.published';
export const MAX_GITHUB_WEBHOOK_BODY_BYTES = 1024 * 1024;

const DELIVERY_GUID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface GitHubReleaseWebhookEnv {
  readonly IDENTITY_DB: D1Database;
  readonly GITHUB_WEBHOOK_SECRET?: string;
  readonly GITHUB_ORGANIZATION_ID?: string;
  readonly GITHUB_ALLOWED_REPOSITORY_IDS?: string;
}

export interface GitHubReleaseWebhookConfig {
  readonly webhookSecret: string;
  readonly organizationId: string;
  readonly allowedRepositoryIds: ReadonlySet<string>;
}

export interface HandleGitHubReleaseWebhookOptions {
  readonly request: Request;
  readonly store: Store;
  readonly logger: Logger;
  readonly config: GitHubReleaseWebhookConfig;
  readonly now?: string;
  readonly ledger?: WebhookLedger;
}

function jsonResponse(
  status: number,
  body: Record<string, unknown>,
): Response {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export function parseAllowedRepositoryIds(value: unknown): ReadonlySet<string> {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return new Set();
  }
  return new Set(
    value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );
}

export function readGitHubReleaseWebhookConfig(
  env: GitHubReleaseWebhookEnv,
): GitHubReleaseWebhookConfig | null {
  const webhookSecret = env.GITHUB_WEBHOOK_SECRET;
  const organizationId = env.GITHUB_ORGANIZATION_ID;
  const allowedRepositoryIds = parseAllowedRepositoryIds(
    env.GITHUB_ALLOWED_REPOSITORY_IDS,
  );
  if (
    typeof webhookSecret !== 'string' ||
    webhookSecret.length === 0 ||
    typeof organizationId !== 'string' ||
    organizationId.length === 0 ||
    allowedRepositoryIds.size === 0
  ) {
    return null;
  }
  return {
    webhookSecret,
    organizationId,
    allowedRepositoryIds,
  };
}

export function createProductionStore(env: GitHubReleaseWebhookEnv): Store {
  return createCloudflareD1Store({
    database: env.IDENTITY_DB,
    createSchemaIfMissing: false,
  });
}

async function readBoundedBody(
  request: Request,
): Promise<
  | { readonly ok: true; readonly body: Uint8Array }
  | { readonly ok: false; readonly reason: 'too_large' | 'unreadable' }
> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      return { ok: false, reason: 'unreadable' };
    }
    const length = Number(declared);
    if (length > MAX_GITHUB_WEBHOOK_BODY_BYTES) {
      return { ok: false, reason: 'too_large' };
    }
  }

  if (request.body === null) {
    return { ok: true, body: new Uint8Array() };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value === undefined) {
      continue;
    }
    total += value.byteLength;
    if (total > MAX_GITHUB_WEBHOOK_BODY_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // Ignore cancel failures; the size rejection is what matters.
      }
      return { ok: false, reason: 'too_large' };
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === 'string' && /^\d+$/.test(value) && value !== '0') {
    return value;
  }
  return null;
}

export function extractReleaseEventFacts(
  payload: unknown,
): ReleaseEventFacts | null {
  const root = asRecord(payload);
  if (root === null || typeof root['action'] !== 'string') {
    return null;
  }
  const repository = asRecord(root['repository']);
  const release = asRecord(root['release']);
  if (repository === null || release === null) {
    return null;
  }
  const repositoryId = asId(repository['id']);
  const releaseId = asId(release['id']);
  const action = root['action'];
  if (
    repositoryId === null ||
    releaseId === null ||
    typeof repository['name'] !== 'string' ||
    typeof release['tag_name'] !== 'string' ||
    typeof release['draft'] !== 'boolean' ||
    typeof release['prerelease'] !== 'boolean'
  ) {
    return null;
  }

  let publishedAt: string;
  if (typeof release['published_at'] === 'string') {
    publishedAt = release['published_at'];
  } else if (
    release['published_at'] == null &&
    (action === 'unpublished' || action === 'deleted')
  ) {
    publishedAt = '';
  } else {
    return null;
  }

  return {
    action,
    repositoryId,
    repositoryName: repository['name'],
    releaseId,
    tagName: release['tag_name'],
    publishedAt,
    draft: release['draft'],
    prerelease: release['prerelease'],
  };
}

function organizationIdFromPayload(payload: unknown): string | null {
  const root = asRecord(payload);
  if (root === null) {
    return null;
  }
  const organization = asRecord(root['organization']);
  if (organization !== null) {
    return asId(organization['id']);
  }
  const repository = asRecord(root['repository']);
  const owner = repository === null ? null : asRecord(repository['owner']);
  return owner === null ? null : asId(owner['id']);
}

/**
 * Authenticate and process one GitHub organization release webhook delivery.
 */
export async function handleGitHubReleaseWebhook(
  options: HandleGitHubReleaseWebhookOptions,
): Promise<Response> {
  const { request, store, logger, config } = options;
  const contentType = request.headers.get('content-type') ?? '';

  if (request.method !== 'POST') {
    return jsonResponse(405, { error: 'method_not_allowed' });
  }
  if (!contentType.toLowerCase().startsWith('application/json')) {
    return jsonResponse(415, { error: 'unsupported_media_type' });
  }

  const bounded = await readBoundedBody(request);
  if (!bounded.ok) {
    if (bounded.reason === 'too_large') {
      logger.log('warn', 'github_release_webhook.body_too_large', {});
      return jsonResponse(413, { error: 'payload_too_large' });
    }
    return jsonResponse(400, { error: 'unreadable_body' });
  }

  const signatureHeader = request.headers.get('x-hub-signature-256');
  const verified = await verifyGitHubWebhookSignature(
    config.webhookSecret,
    signatureHeader,
    bounded.body,
  );
  if (!verified) {
    logger.log('warn', 'github_release_webhook.signature_rejected', {});
    return jsonResponse(401, { error: 'invalid_signature' });
  }

  const eventName = request.headers.get('x-github-event');
  const deliveryId = request.headers.get('x-github-delivery');

  if (eventName === 'ping') {
    logger.log('info', 'github_release_webhook.ping', {});
    return emptyResponse(204);
  }

  if (eventName !== 'release') {
    logger.log('warn', 'github_release_webhook.event_rejected', {
      event: eventName ?? 'missing',
    });
    return jsonResponse(400, { error: 'unsupported_event' });
  }

  if (typeof deliveryId !== 'string' || !DELIVERY_GUID.test(deliveryId)) {
    logger.log('warn', 'github_release_webhook.delivery_rejected', {});
    return jsonResponse(400, { error: 'invalid_delivery' });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bounded.body));
  } catch {
    return jsonResponse(400, { error: 'invalid_json' });
  }

  const organizationId = organizationIdFromPayload(payload);
  if (organizationId !== config.organizationId) {
    logger.log('warn', 'github_release_webhook.organization_rejected', {});
    return jsonResponse(403, { error: 'organization_not_allowed' });
  }

  const facts = extractReleaseEventFacts(payload);
  if (facts === null) {
    return jsonResponse(400, { error: 'invalid_release_payload' });
  }

  if (!config.allowedRepositoryIds.has(facts.repositoryId)) {
    logger.log('warn', 'github_release_webhook.repository_rejected', {
      repositoryId: facts.repositoryId,
    });
    return jsonResponse(403, { error: 'repository_not_allowed' });
  }

  const ledger =
    options.ledger ??
    createWebhookLedger({
      store,
      source: 'github',
      logger,
    });

  try {
    const begin = await ledger.begin(deliveryId, GITHUB_RELEASE_EVENT_TYPE);
    if (begin.status === 'processed' || begin.status === 'quarantined') {
      logger.log('info', 'github_release_webhook.duplicate', {
        deliveryId,
        status: begin.status,
      });
      return emptyResponse(204);
    }

    const observedAt = options.now ?? new Date().toISOString();
    const decision = decideReleaseProjection(facts, observedAt);
    await applyReleaseProjection(store, decision);
    await ledger.markProcessed(deliveryId);
    logger.log('info', 'github_release_webhook.processed', {
      deliveryId,
      action: facts.action,
      projection: decision.kind,
    });
    return emptyResponse(204);
  } catch (error) {
    logger.log('error', 'github_release_webhook.processing_failed', {
      deliveryId,
      error: error instanceof Error ? error.name : 'unknown',
    });
    try {
      const failure = await ledger.markFailed(deliveryId);
      if (failure.quarantined) {
        return emptyResponse(204);
      }
    } catch (markFailedError) {
      logger.log('error', 'github_release_webhook.mark_failed_unavailable', {
        deliveryId,
        error:
          markFailedError instanceof Error ? markFailedError.name : 'unknown',
      });
    }
    return jsonResponse(500, { error: 'processing_failed' });
  }
}
