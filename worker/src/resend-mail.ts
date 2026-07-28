import type {
  IdentityMailContent,
  IdentityMailRenderer,
  MailProvider,
  MailReconciliationPort,
} from '@pegma/identity';
import type { MailReconciliationRequest, MailSendRequest } from '@pegma/mail';

const RESEND_API = 'https://api.resend.com';
const RESPONSE_LIMIT = 32 * 1024;
const PROVIDER_TIMEOUT_MS = 10_000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class ResendMailError extends Error {
  constructor(readonly category: string) {
    super(category);
    this.name = 'ResendMailError';
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
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get('Content-Length');
  if (
    declared !== null &&
    (!/^\d+$/u.test(declared) || Number(declared) > RESPONSE_LIMIT)
  ) {
    throw new ResendMailError('provider_response_invalid');
  }
  if (response.body === null) {
    throw new ResendMailError('provider_response_invalid');
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
        throw new ResendMailError('provider_response_invalid');
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
    throw new ResendMailError('provider_response_invalid');
  }
}

function providerFailure(status: number, body: unknown): ResendMailError {
  const type =
    isObject(body) &&
    typeof body.type === 'string' &&
    /^[a-z][a-z0-9_]{0,63}$/u.test(body.type)
      ? body.type
      : null;
  if (status === 409 && type === 'concurrent_idempotent_requests') {
    return new ResendMailError('provider_concurrent');
  }
  if (status === 429 || status >= 500) {
    return new ResendMailError('provider_retryable');
  }
  return new ResendMailError(
    type === null ? 'provider_rejected' : `resend_${type}`.slice(0, 64),
  );
}

function htmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    return new Date(value).toISOString() === value ? value : null;
  } catch {
    return null;
  }
}

export function createIdentityMailRenderer(): IdentityMailRenderer {
  return Object.freeze({
    async render(content: IdentityMailContent) {
      if (content.expired) {
        throw new ResendMailError('identity_code_expired');
      }
      if (content.purpose === 'email_changed') {
        const newEmail = requireText(content.newEmail, 'new email', 320);
        return {
          subject: 'Your Pegma account email changed',
          text: `The email address for your pegma.dev account changed to ${newEmail}. If you did not make this change, contact the site operator.`,
          html: `<p>The email address for your pegma.dev account changed to <strong>${htmlEscape(newEmail)}</strong>.</p><p>If you did not make this change, contact the site operator.</p>`,
        };
      }

      const code =
        typeof content.code === 'string' && /^\d{8}$/u.test(content.code)
          ? content.code
          : null;
      const expiresAt = canonicalTimestamp(content.expiresAt);
      if (code === null || expiresAt === null) {
        throw new ResendMailError('identity_content_invalid');
      }
      const action =
        content.purpose === 'account_creation'
          ? 'create your account'
          : content.purpose === 'email_change'
            ? 'change your email address'
            : content.purpose === 'recovery'
              ? 'recover your account'
              : 'sign in';
      return {
        subject: `Your pegma.dev verification code: ${code}`,
        text: `Use ${code} to ${action} on pegma.dev. It expires at ${expiresAt}. If you did not request this code, you can ignore this email.`,
        html: `<p>Use <strong>${code}</strong> to ${htmlEscape(action)} on pegma.dev.</p><p>It expires at ${htmlEscape(expiresAt)}. If you did not request this code, you can ignore this email.</p>`,
      };
    },
  });
}

export function createResendMailPorts(options: {
  readonly apiKey: string;
  readonly from: string;
  readonly fetch?: typeof fetch;
}): {
  readonly provider: MailProvider;
  readonly reconciliation: MailReconciliationPort;
} {
  const apiKey = requireText(options.apiKey, 'Resend API key', 1_024);
  const from = requireText(options.from, 'Resend sender', 512);
  const request = options.fetch ?? fetch;

  async function call(
    path: string,
    init: RequestInit,
  ): Promise<{ readonly response: Response; readonly body: unknown }> {
    let response: Response;
    try {
      response = await request(`${RESEND_API}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...init.headers,
        },
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
    } catch {
      throw new ResendMailError('provider_timeout');
    }
    const body = await boundedJson(response);
    if (!response.ok) {
      throw providerFailure(response.status, body);
    }
    return { response, body };
  }

  const provider: MailProvider = Object.freeze({
    async send(input: MailSendRequest) {
      const { body } = await call('/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': input.idempotencyKey,
        },
        body: JSON.stringify({
          from,
          to: [input.mail.recipient],
          subject: input.mail.subject,
          text: input.mail.text,
          ...(input.mail.html === undefined ? {} : { html: input.mail.html }),
        }),
      });
      const id =
        isObject(body) && typeof body.id === 'string' && UUID.test(body.id)
          ? body.id
          : null;
      if (id === null) {
        throw new ResendMailError('provider_response_invalid');
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
      const { body } = await call(
        `/emails/${encodeURIComponent(input.providerMessageRef)}`,
        { method: 'GET' },
      );
      const event =
        isObject(body) && typeof body.last_event === 'string'
          ? body.last_event
          : null;
      if (
        event === 'delivered' ||
        event === 'opened' ||
        event === 'clicked' ||
        event === 'complained'
      ) {
        return { status: 'delivered' as const };
      }
      if (
        event === 'bounced' ||
        event === 'failed' ||
        event === 'suppressed' ||
        event === 'canceled'
      ) {
        return {
          status: 'failed' as const,
          failureCategory: `resend_${event}`,
        };
      }
      return { status: 'unknown' as const };
    },
  });
  return Object.freeze({ provider, reconciliation });
}

export function classifyResendFailure(error: unknown): string {
  return error instanceof ResendMailError
    ? error.category
    : 'provider_unavailable';
}
