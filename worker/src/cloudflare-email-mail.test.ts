import { describe, expect, it, vi } from 'vitest';
import {
  classifyCloudflareEmailFailure,
  CloudflareEmailMailError,
  createCloudflareEmailMailPorts,
  parseCloudflareEmailDeliveryEvent,
} from './cloudflare-email-mail';

function binding(messageId = 'cf-message-123'): SendEmail {
  return {
    send: vi.fn(async () => ({ messageId })),
  } as unknown as SendEmail;
}

describe('Cloudflare Email Service Mail adapter', () => {
  it('requires an explicit acknowledgement of provider double-send risk', () => {
    expect(() =>
      createCloudflareEmailMailPorts({
        binding: binding(),
        from: 'identity@pegma.dev',
        acceptDoubleSendRisk: false as true,
      }),
    ).toThrow(/double-send risk/u);
  });

  it('sends through the native binding and retains the Mail key as correlation', async () => {
    const email = binding();
    const ports = createCloudflareEmailMailPorts({
      binding: email,
      from: 'Pegma <identity@pegma.dev>',
      acceptDoubleSendRisk: true,
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
    ).resolves.toEqual({ providerMessageRef: 'cf-message-123' });

    expect(email.send).toHaveBeenCalledWith({
      to: 'person@example.test',
      from: 'Pegma <identity@pegma.dev>',
      subject: 'Verify',
      text: 'Code 12345678',
      headers: {
        'x-pegma-idempotency-key': 'pegma-mail:v1:partition:job:1',
      },
    });
  });

  it('normalizes Queue lifecycle events for a host receipt store', () => {
    expect(
      parseCloudflareEmailDeliveryEvent({
        type: 'cf.email.sending.message.bounced',
        payload: { messageId: 'cf-message-123' },
        metadata: { eventTimestamp: '2026-07-28T16:00:00.000Z' },
      }),
    ).toEqual({
      providerMessageRef: 'cf-message-123',
      status: 'bounced',
      occurredAt: '2026-07-28T16:00:00.000Z',
      failureCategory: 'cloudflare_bounced',
    });
  });

  it('does not invoke accessors in untrusted Queue events', () => {
    const getter = vi.fn(() => 'cf-message-123');
    const payload = {};
    Object.defineProperty(payload, 'messageId', { get: getter });

    expect(
      parseCloudflareEmailDeliveryEvent({
        type: 'cf.email.sending.message.delivered',
        payload,
        metadata: { eventTimestamp: '2026-07-28T16:00:00.000Z' },
      }),
    ).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    ['delivered', 'delivered'],
    ['complained', 'delivered'],
    ['bounced', 'failed'],
    ['failed', 'failed'],
    ['rejected', 'failed'],
    ['deferred', 'unknown'],
  ] as const)('reconciles %s as %s', async (status, expected) => {
    const ports = createCloudflareEmailMailPorts({
      binding: binding(),
      from: 'identity@pegma.dev',
      acceptDoubleSendRisk: true,
      deliveryStatus: vi.fn(async () => ({ status })),
    });

    await expect(
      ports.reconciliation.reconcile({
        idempotencyKey: 'pegma-mail:v1:partition:job:1',
        providerMessageRef: 'cf-message-123',
      }),
    ).resolves.toMatchObject({ status: expected });
  });

  it('classifies only adapter-owned failures', () => {
    expect(
      classifyCloudflareEmailFailure(
        new CloudflareEmailMailError('provider_retryable'),
      ),
    ).toBe('provider_retryable');
    expect(classifyCloudflareEmailFailure(new Error('secret'))).toBe(
      'provider_unavailable',
    );
  });

  it.each([
    ['SMTP.RATE-LIMIT/Exceeded', 'cloudflare_smtp_rate_limit_exceeded'],
    ['---', 'provider_unavailable'],
  ])('normalizes provider code %s as %s', async (code, expected) => {
    const email = {
      send: vi.fn(async () => {
        throw { code };
      }),
    } as unknown as SendEmail;
    const ports = createCloudflareEmailMailPorts({
      binding: email,
      from: 'identity@pegma.dev',
      acceptDoubleSendRisk: true,
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
    ).rejects.toMatchObject({ category: expected });
  });
});
