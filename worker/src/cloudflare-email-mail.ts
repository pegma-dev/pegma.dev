import type {
  MailProvider,
  MailReconciliationPort,
} from '@pegma/identity';
import type { MailReconciliationRequest, MailSendRequest } from '@pegma/mail';

const MESSAGE_REFERENCE = /^[A-Za-z0-9._:@+-]{1,512}$/u;

export type CloudflareEmailDeliveryStatus =
  | 'delivered'
  | 'deferred'
  | 'bounced'
  | 'failed'
  | 'rejected'
  | 'complained'
  | 'unknown';

export interface CloudflareEmailDeliveryResult {
  readonly status: CloudflareEmailDeliveryStatus;
  readonly failureCategory?: string;
}

export interface CloudflareEmailDeliveryEvent
  extends CloudflareEmailDeliveryResult {
  readonly providerMessageRef: string;
  readonly occurredAt: string;
}

export class CloudflareEmailMailError extends Error {
  constructor(readonly category: string) {
    super(category);
    this.name = 'CloudflareEmailMailError';
  }
}

function requireText(value: unknown, name: string, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > maximum ||
    /[\u0000-\u001F\u007F-\u009F]/u.test(value)
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function failureCategory(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/u.test(value)
    ? value
    : fallback;
}

function providerCodeCategory(code: string): string {
  const normalized = code
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
  return normalized === ''
    ? 'provider_unavailable'
    : `cloudflare_${normalized}`.slice(0, 64);
}

function isObject(value: unknown): value is Record<string, unknown> {
  try {
    return (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype
    );
  } catch {
    return false;
  }
}

function dataProperty(value: unknown, name: string): unknown {
  if (
    (typeof value !== 'object' && typeof value !== 'function') ||
    value === null
  ) {
    return undefined;
  }
  try {
    const property = Object.getOwnPropertyDescriptor(value, name);
    return property !== undefined && Object.hasOwn(property, 'value')
      ? property.value
      : undefined;
  } catch {
    return undefined;
  }
}

export function parseCloudflareEmailDeliveryEvent(
  value: unknown,
): CloudflareEmailDeliveryEvent | null {
  const payload = dataProperty(value, 'payload');
  const metadata = dataProperty(value, 'metadata');
  if (!isObject(payload) || !isObject(metadata)) {
    return null;
  }
  const type = dataProperty(value, 'type');
  const prefix = 'cf.email.sending.message.';
  const status =
    typeof type === 'string' && type.startsWith(prefix)
      ? type.slice(prefix.length)
      : '';
  if (
    status !== 'delivered' &&
    status !== 'deferred' &&
    status !== 'bounced' &&
    status !== 'failed' &&
    status !== 'rejected' &&
    status !== 'complained'
  ) {
    return null;
  }
  const messageId = dataProperty(payload, 'messageId');
  const timestamp = dataProperty(metadata, 'eventTimestamp');
  if (
    typeof messageId !== 'string' ||
    !MESSAGE_REFERENCE.test(messageId) ||
    typeof timestamp !== 'string'
  ) {
    return null;
  }
  let occurredAt: string;
  try {
    occurredAt = new Date(timestamp).toISOString();
  } catch {
    return null;
  }
  return Object.freeze({
    providerMessageRef: messageId,
    status,
    occurredAt,
    ...(status === 'bounced' ||
    status === 'failed' ||
    status === 'rejected'
      ? { failureCategory: `cloudflare_${status}` }
      : {}),
  });
}

/**
 * Cloudflare Email Sending currently has no documented submission
 * idempotency contract. The explicit opt-in keeps that double-send risk
 * visible at every composition root that chooses this adapter.
 */
export function createCloudflareEmailMailPorts(options: {
  readonly binding: SendEmail;
  readonly from: string;
  readonly acceptDoubleSendRisk: true;
  readonly deliveryStatus?: (
    providerMessageRef: string,
  ) => Promise<CloudflareEmailDeliveryResult>;
}): {
  readonly provider: MailProvider;
  readonly reconciliation: MailReconciliationPort;
} {
  if (options.acceptDoubleSendRisk !== true) {
    throw new TypeError('Cloudflare Email double-send risk must be accepted');
  }
  const from = requireText(options.from, 'Cloudflare Email sender', 512);

  const provider: MailProvider = Object.freeze({
    async send(input: MailSendRequest) {
      try {
        const result = await options.binding.send({
          to: input.mail.recipient,
          from,
          subject: input.mail.subject,
          text: input.mail.text,
          ...(input.mail.html === undefined ? {} : { html: input.mail.html }),
          headers: {
            ...input.mail.headers,
            'x-pegma-idempotency-key': input.idempotencyKey,
          },
        });
        const resultMessageId = dataProperty(result, 'messageId');
        const messageId =
          typeof resultMessageId === 'string' &&
          MESSAGE_REFERENCE.test(resultMessageId)
            ? resultMessageId
            : null;
        if (messageId === null) {
          throw new CloudflareEmailMailError('provider_response_invalid');
        }
        return { providerMessageRef: messageId };
      } catch (error) {
        if (error instanceof CloudflareEmailMailError) throw error;
        const errorCode = dataProperty(error, 'code');
        const code = typeof errorCode === 'string' ? errorCode : '';
        if (
          code === 'E_RATE_LIMIT_EXCEEDED' ||
          code === 'E_DAILY_LIMIT_EXCEEDED' ||
          code === 'E_INTERNAL_SERVER_ERROR'
        ) {
          throw new CloudflareEmailMailError('provider_retryable');
        }
        throw new CloudflareEmailMailError(
          providerCodeCategory(code),
        );
      }
    },
  });

  const reconciliation: MailReconciliationPort = Object.freeze({
    async reconcile(input: MailReconciliationRequest) {
      if (!MESSAGE_REFERENCE.test(input.providerMessageRef)) {
        return {
          status: 'failed' as const,
          failureCategory: 'provider_reference_invalid',
        };
      }
      if (options.deliveryStatus === undefined) {
        return { status: 'unknown' as const };
      }
      const result = await options.deliveryStatus(input.providerMessageRef);
      if (
        result.status === 'delivered' ||
        result.status === 'complained'
      ) {
        return { status: 'delivered' as const };
      }
      if (
        result.status === 'bounced' ||
        result.status === 'failed' ||
        result.status === 'rejected'
      ) {
        return {
          status: 'failed' as const,
          failureCategory: failureCategory(
            result.failureCategory,
            `cloudflare_${result.status}`,
          ),
        };
      }
      return { status: 'unknown' as const };
    },
  });

  return Object.freeze({ provider, reconciliation });
}

export function classifyCloudflareEmailFailure(error: unknown): string {
  return error instanceof CloudflareEmailMailError
    ? error.category
    : 'provider_unavailable';
}
