import type {
  MailProvider,
  MailReconciliationPort,
} from '@pegma/identity';
import type { MailReconciliationRequest, MailSendRequest } from '@pegma/mail';

const API_VERSION = '2025-09-01';
const RESPONSE_LIMIT = 32 * 1024;
const PROVIDER_TIMEOUT_MS = 10_000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type AzureAcsDeliveryStatus =
  | 'Delivered'
  | 'Suppressed'
  | 'Bounced'
  | 'Quarantined'
  | 'FilteredSpam'
  | 'Expanded'
  | 'Failed'
  | 'Unknown';

export interface AzureAcsDeliveryResult {
  readonly status: AzureAcsDeliveryStatus;
  readonly failureCategory?: string;
}

export interface AzureAcsDeliveryEvent extends AzureAcsDeliveryResult {
  readonly providerMessageRef: string;
  readonly occurredAt: string;
}

export class AzureAcsMailError extends Error {
  constructor(readonly category: string) {
    super(category);
    this.name = 'AzureAcsMailError';
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

function bytesToBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  if (
    value.length < 40 ||
    value.length > 512 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  ) {
    throw new TypeError('Azure ACS access key is invalid');
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new TypeError('Azure ACS access key is invalid');
  }
  if (btoa(binary) !== value || binary.length < 32) {
    throw new TypeError('Azure ACS access key is invalid');
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('Content-Length');
  if (
    declared !== null &&
    (!/^\d+$/u.test(declared) || Number(declared) > RESPONSE_LIMIT)
  ) {
    throw new AzureAcsMailError('provider_response_invalid');
  }
  if (response.body === null) {
    throw new AzureAcsMailError('provider_response_invalid');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > RESPONSE_LIMIT) {
        await reader.cancel();
        throw new AzureAcsMailError('provider_response_invalid');
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
    throw new AzureAcsMailError('provider_response_invalid');
  }
}

function providerCategory(body: unknown, fallback: string): string {
  const errorValue = dataProperty(body, 'error');
  const error = isObject(errorValue) ? errorValue : null;
  const errorCode = dataProperty(error, 'code');
  const code =
    error !== null &&
    typeof errorCode === 'string' &&
    /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(errorCode)
      ? errorCode.toLowerCase().replaceAll(/[^a-z0-9]+/gu, '_')
      : null;
  return code === null ? fallback : `azure_${code}`.slice(0, 64);
}

async function operationId(idempotencyKey: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(idempotencyKey),
    ),
  );
  digest[6] = (digest[6]! & 0x0f) | 0x40;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = [...digest.slice(0, 16)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function repeatabilityDate(value: Date | string, now: Date): string {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  const milliseconds = date.getTime();
  const distance = now.getTime() - milliseconds;
  if (
    !Number.isFinite(milliseconds) ||
    distance < -30_000 ||
    distance > 5 * 60_000
  ) {
    throw new AzureAcsMailError('provider_idempotency_expired');
  }
  return date.toUTCString();
}

function operationStatus(
  body: unknown,
  expectedId: string,
): 'NotStarted' | 'Running' | 'Succeeded' | 'Failed' | null {
  const id = dataProperty(body, 'id');
  if (
    !isObject(body) ||
    typeof id !== 'string' ||
    id.toLowerCase() !== expectedId.toLowerCase()
  ) {
    return null;
  }
  const status = dataProperty(body, 'status');
  return status === 'NotStarted' ||
    status === 'Running' ||
    status === 'Succeeded' ||
    status === 'Failed'
    ? status
    : null;
}

function deliveryFailure(
  result: AzureAcsDeliveryResult,
): string | undefined {
  if (
    typeof result.failureCategory === 'string' &&
    /^[a-z][a-z0-9_]{0,63}$/u.test(result.failureCategory)
  ) {
    return result.failureCategory;
  }
  return result.status === 'Unknown' ||
    result.status === 'Delivered' ||
    result.status === 'Expanded'
    ? undefined
    : `azure_${result.status.toLowerCase()}`;
}

export function parseAzureAcsDeliveryEvent(
  value: unknown,
): AzureAcsDeliveryEvent | null {
  const eventType = dataProperty(value, 'eventType');
  const data = dataProperty(value, 'data');
  if (
    eventType !== 'Microsoft.Communication.EmailDeliveryReportReceived' ||
    !isObject(data)
  ) {
    return null;
  }
  const messageId = dataProperty(data, 'messageId');
  const status = dataProperty(data, 'status');
  const deliveryTimestamp = dataProperty(data, 'deliveryAttemptTimeStamp');
  const timestamp =
    typeof deliveryTimestamp === 'string'
      ? deliveryTimestamp
      : dataProperty(value, 'eventTime');
  if (
    typeof messageId !== 'string' ||
    !UUID.test(messageId) ||
    (status !== 'Delivered' &&
      status !== 'Suppressed' &&
      status !== 'Bounced' &&
      status !== 'Quarantined' &&
      status !== 'FilteredSpam' &&
      status !== 'Expanded' &&
      status !== 'Failed') ||
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
  const failureCategory =
    status === 'Delivered' || status === 'Expanded'
      ? undefined
      : `azure_${status.toLowerCase()}`;
  return Object.freeze({
    providerMessageRef: messageId,
    status,
    occurredAt,
    ...(failureCategory === undefined ? {} : { failureCategory }),
  });
}

/**
 * REST adapter for Azure Communication Services Email.
 *
 * firstSentAt must return the same durable timestamp for every invocation of
 * one Mail idempotency key. ACS retains repeatability records for five
 * minutes; after that the adapter fails closed instead of risking a resend.
 * Authoritative recipient delivery still comes from Event Grid, supplied
 * through deliveryStatus.
 */
export function createAzureAcsMailPorts(options: {
  readonly endpoint: string;
  readonly accessKey: string;
  readonly senderAddress: string;
  readonly firstSentAt: (
    idempotencyKey: string,
  ) => Promise<Date | string> | Date | string;
  readonly deliveryStatus?: (
    providerMessageRef: string,
  ) => Promise<AzureAcsDeliveryResult>;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}): {
  readonly provider: MailProvider;
  readonly reconciliation: MailReconciliationPort;
} {
  const endpoint = new URL(options.endpoint);
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.pathname !== '/' ||
    endpoint.search !== '' ||
    endpoint.hash !== ''
  ) {
    throw new TypeError('Azure ACS endpoint is invalid');
  }
  const accessKey = base64ToBytes(options.accessKey);
  const hmacKeyBytes = new Uint8Array(accessKey.byteLength);
  hmacKeyBytes.set(accessKey);
  const senderAddress = requireText(
    options.senderAddress,
    'Azure ACS sender',
    320,
  );
  const request = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());

  function currentDate(): Date {
    const value = now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new AzureAcsMailError('provider_clock_invalid');
    }
    return value;
  }

  async function signedCall(
    method: 'GET' | 'POST',
    pathAndQuery: string,
    body: string,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<{ readonly response: Response; readonly body: unknown }> {
    const requestUrl = new URL(pathAndQuery, endpoint);
    const requestDate = currentDate().toUTCString();
    const contentHash = bytesToBase64(
      new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          new TextEncoder().encode(body),
        ),
      ),
    );
    const stringToSign = `${method}\n${requestUrl.pathname}${requestUrl.search}\n${requestDate};${requestUrl.host};${contentHash}`;
    const key = await crypto.subtle.importKey(
      'raw',
      hmacKeyBytes.buffer,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = bytesToBase64(
      new Uint8Array(
        await crypto.subtle.sign(
          'HMAC',
          key,
          new TextEncoder().encode(stringToSign),
        ),
      ),
    );

    let response: Response;
    try {
      response = await request(requestUrl, {
        method,
        headers: {
          Authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`,
          'x-ms-date': requestDate,
          'x-ms-content-sha256': contentHash,
          ...headers,
        },
        ...(method === 'POST' ? { body } : {}),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
    } catch {
      throw new AzureAcsMailError('provider_timeout');
    }
    const parsed = await boundedJson(response);
    return { response, body: parsed };
  }

  async function getOperation(id: string): Promise<{
    readonly status: 'NotStarted' | 'Running' | 'Succeeded' | 'Failed';
    readonly body: unknown;
  }> {
    const result = await signedCall(
      'GET',
      `/emails/operations/${encodeURIComponent(id)}?api-version=${API_VERSION}`,
      '',
    );
    if (!result.response.ok) {
      throw new AzureAcsMailError(
        result.response.status === 429 || result.response.status >= 500
          ? 'provider_retryable'
          : providerCategory(result.body, 'provider_rejected'),
      );
    }
    const status = operationStatus(result.body, id);
    if (status === null) {
      throw new AzureAcsMailError('provider_response_invalid');
    }
    return { status, body: result.body };
  }

  const provider: MailProvider = Object.freeze({
    async send(input: MailSendRequest) {
      const id = await operationId(input.idempotencyKey);
      const firstSent = repeatabilityDate(
        await options.firstSentAt(input.idempotencyKey),
        currentDate(),
      );
      const body = JSON.stringify({
        senderAddress,
        recipients: { to: [{ address: input.mail.recipient }] },
        content: {
          subject: input.mail.subject,
          plainText: input.mail.text,
          ...(input.mail.html === undefined
            ? {}
            : { html: input.mail.html }),
        },
        ...(input.mail.headers === undefined
          ? {}
          : { headers: input.mail.headers }),
      });
      const result = await signedCall(
        'POST',
        `/emails:send?api-version=${API_VERSION}`,
        body,
        {
          'Content-Type': 'application/json',
          'Operation-Id': id,
          'Repeatability-Request-ID': id,
          'Repeatability-First-Sent': firstSent,
        },
      );

      if (result.response.status === 409) {
        await getOperation(id);
        return { providerMessageRef: id };
      }
      if (!result.response.ok) {
        throw new AzureAcsMailError(
          result.response.status === 412
            ? 'provider_idempotency_expired'
            : result.response.status === 429 || result.response.status >= 500
              ? 'provider_retryable'
              : providerCategory(result.body, 'provider_rejected'),
        );
      }
      if (operationStatus(result.body, id) === null) {
        throw new AzureAcsMailError('provider_response_invalid');
      }
      return { providerMessageRef: id };
    },
  });

  const reconciliation: MailReconciliationPort = Object.freeze({
    async reconcile(input: MailReconciliationRequest) {
      if (!UUID.test(input.providerMessageRef)) {
        return {
          status: 'failed' as const,
          failureCategory: 'provider_reference_invalid',
        };
      }
      if (options.deliveryStatus !== undefined) {
        const delivery = await options.deliveryStatus(
          input.providerMessageRef,
        );
        if (delivery.status === 'Delivered') {
          return { status: 'delivered' as const };
        }
        const failed = deliveryFailure(delivery);
        if (failed !== undefined) {
          return {
            status: 'failed' as const,
            failureCategory: failed,
          };
        }
      }

      const operation = await getOperation(input.providerMessageRef);
      if (operation.status === 'Failed') {
        return {
          status: 'failed' as const,
          failureCategory: providerCategory(
            operation.body,
            'azure_send_failed',
          ),
        };
      }
      // Succeeded means ACS processed the send operation, not that the
      // recipient MTA accepted it. Event Grid remains authoritative.
      return { status: 'unknown' as const };
    },
  });

  return Object.freeze({ provider, reconciliation });
}

export function classifyAzureAcsFailure(error: unknown): string {
  return error instanceof AzureAcsMailError
    ? error.category
    : 'provider_unavailable';
}
