import { describe, expect, it, vi } from 'vitest';
import {
  classifyResendFailure,
  createIdentityMailRenderer,
  createResendMailPorts,
  ResendMailError,
} from './resend-mail';

const providerId = '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794';

function response(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

describe('Resend Mail adapter', () => {
  it('sends the prepared message with the durable idempotency key', async () => {
    const request = vi.fn<typeof fetch>(async () =>
      response({ id: providerId }),
    );
    const ports = createResendMailPorts({
      apiKey: 're_test_secret',
      from: 'Pegma <identity@pegma.dev>',
      fetch: request,
    });

    await expect(
      ports.provider.send({
        idempotencyKey: 'pegma-mail:v1:partition:job:1',
        mail: {
          recipient: 'person@example.test',
          subject: 'Verify',
          text: 'Code 12345678',
        },
      }),
    ).resolves.toEqual({ providerMessageRef: providerId });

    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('Idempotency-Key')).toBe(
      'pegma-mail:v1:partition:job:1',
    );
    expect(headers.get('Authorization')).toBe('Bearer re_test_secret');
    expect(JSON.parse(String(init?.body))).toEqual({
      from: 'Pegma <identity@pegma.dev>',
      to: ['person@example.test'],
      subject: 'Verify',
      text: 'Code 12345678',
    });
  });

  it.each([
    ['delivered', 'delivered'],
    ['opened', 'delivered'],
    ['bounced', 'failed'],
    ['failed', 'failed'],
    ['sent', 'unknown'],
    ['delivery_delayed', 'unknown'],
  ] as const)('reconciles %s as %s', async (lastEvent, expected) => {
    const ports = createResendMailPorts({
      apiKey: 're_test_secret',
      from: 'identity@pegma.dev',
      fetch: vi.fn<typeof fetch>(async () =>
        response({ id: providerId, last_event: lastEvent }),
      ),
    });

    const result = await ports.reconciliation.reconcile({
      idempotencyKey: 'pegma-mail:v1:partition:job:1',
      providerMessageRef: providerId,
    });

    expect(result.status).toBe(expected);
  });

  it('fails closed on oversized or malformed provider responses', async () => {
    const ports = createResendMailPorts({
      apiKey: 're_test_secret',
      from: 'identity@pegma.dev',
      fetch: vi.fn<typeof fetch>(
        async () =>
          new Response('x', {
            headers: { 'Content-Length': String(33 * 1024) },
          }),
      ),
    });

    await expect(
      ports.provider.send({
        idempotencyKey: 'pegma-mail:v1:partition:job:1',
        mail: {
          recipient: 'person@example.test',
          subject: 'Verify',
          text: 'Code 12345678',
        },
      }),
    ).rejects.toMatchObject({ category: 'provider_response_invalid' });
  });

  it('renders an eight-digit code without accepting expired content', async () => {
    const renderer = createIdentityMailRenderer();
    await expect(
      renderer.render({
        purpose: 'account_creation',
        code: '12345678',
        expiresAt: '2026-07-28T00:05:00.000Z',
        expired: false,
      }),
    ).resolves.toMatchObject({
      subject: 'Your pegma.dev verification code: 12345678',
    });
    await expect(
      renderer.render({
        purpose: 'email_sign_in',
        expired: true,
      }),
    ).rejects.toMatchObject({ category: 'identity_code_expired' });
  });

  it('classifies only adapter-owned failures', () => {
    expect(
      classifyResendFailure(new ResendMailError('provider_retryable')),
    ).toBe('provider_retryable');
    expect(classifyResendFailure(new Error('secret'))).toBe(
      'provider_unavailable',
    );
  });
});
