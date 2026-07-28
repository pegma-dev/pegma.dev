import { describe, expect, it, vi } from 'vitest';
import {
  AzureAcsMailError,
  classifyAzureAcsFailure,
  createAzureAcsMailPorts,
  parseAzureAcsDeliveryEvent,
} from './azure-acs-mail';

const now = new Date('2026-07-28T16:00:00.000Z');
const accessKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));

function options(fetch: typeof globalThis.fetch) {
  return {
    endpoint: 'https://pegma.unitedstates.communication.azure.com',
    accessKey,
    senderAddress: 'identity@pegma.azurecomm.net',
    firstSentAt: vi.fn(async () => now),
    fetch,
    now: () => new Date(now),
  };
}

describe('Azure Communication Services Email Mail adapter', () => {
  it('uses one deterministic operation and repeatability ID per Mail key', async () => {
    const request = vi.fn<typeof fetch>();
    request.mockImplementation(async (_url, init) => {
      const id = new Headers(init?.headers).get('Operation-Id')!;
      return Response.json({ id, status: 'Running' }, { status: 202 });
    });
    const ports = createAzureAcsMailPorts(options(request));
    const input = {
      idempotencyKey: 'pegma-mail:v1:partition:job:1',
      mail: {
        recipient: 'person@example.test',
        subject: 'Verify',
        text: 'Code 12345678',
      },
    };

    const first = await ports.provider.send(input);
    const second = await ports.provider.send(input);

    expect(second).toEqual(first);
    const headers = new Headers(request.mock.calls[0]![1]?.headers);
    expect(headers.get('Operation-Id')).toBe(first.providerMessageRef);
    expect(headers.get('Repeatability-Request-ID')).toBe(
      first.providerMessageRef,
    );
    expect(headers.get('Repeatability-First-Sent')).toBe(now.toUTCString());
    expect(headers.get('Authorization')).toMatch(
      /^HMAC-SHA256 SignedHeaders=/u,
    );
  });

  it('fails closed after the ACS five-minute repeatability window', async () => {
    const ports = createAzureAcsMailPorts({
      ...options(vi.fn<typeof fetch>()),
      firstSentAt: async () => new Date(now.getTime() - 5 * 60_000 - 1),
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
    ).rejects.toMatchObject({ category: 'provider_idempotency_expired' });
  });

  it('normalizes Event Grid delivery reports for a host receipt store', () => {
    expect(
      parseAzureAcsDeliveryEvent({
        eventType: 'Microsoft.Communication.EmailDeliveryReportReceived',
        eventTime: '2026-07-28T16:00:01.000Z',
        data: {
          messageId: '8540c0de-899f-5cce-acb5-3ec493af3800',
          status: 'Bounced',
          deliveryAttemptTimeStamp: '2026-07-28T16:00:00.2855749Z',
        },
      }),
    ).toEqual({
      providerMessageRef: '8540c0de-899f-5cce-acb5-3ec493af3800',
      status: 'Bounced',
      occurredAt: '2026-07-28T16:00:00.285Z',
      failureCategory: 'azure_bounced',
    });
  });

  it('does not invoke accessors in untrusted Event Grid reports', () => {
    const getter = vi.fn(() => 'Delivered');
    const data = {
      messageId: '8540c0de-899f-5cce-acb5-3ec493af3800',
      deliveryAttemptTimeStamp: '2026-07-28T16:00:00.000Z',
    };
    Object.defineProperty(data, 'status', { get: getter });

    expect(
      parseAzureAcsDeliveryEvent({
        eventType: 'Microsoft.Communication.EmailDeliveryReportReceived',
        data,
      }),
    ).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    ['Delivered', 'delivered'],
    ['Bounced', 'failed'],
    ['Suppressed', 'failed'],
    ['FilteredSpam', 'failed'],
  ] as const)('reconciles Event Grid %s as %s', async (status, expected) => {
    const request = vi.fn<typeof fetch>(async (url, init) => {
      const id =
        new Headers(init?.headers).get('Operation-Id') ??
        new URL(String(url)).pathname.split('/').at(-1)!;
      return Response.json(
        { id, status: init?.method === 'POST' ? 'Running' : 'Succeeded' },
        { status: init?.method === 'POST' ? 202 : 200 },
      );
    });
    const ports = createAzureAcsMailPorts({
      ...options(request),
      deliveryStatus: vi.fn(async () => ({ status })),
    });
    const sent = await ports.provider.send({
      idempotencyKey: 'pegma-mail:v1:partition:job:1',
      mail: {
        recipient: 'person@example.test',
        subject: 'Verify',
        text: 'Code 12345678',
      },
    });

    await expect(
      ports.reconciliation.reconcile({
        idempotencyKey: 'pegma-mail:v1:partition:job:1',
        providerMessageRef: sent.providerMessageRef,
      }),
    ).resolves.toMatchObject({ status: expected });
  });

  it('does not misreport a successful send operation as recipient delivery', async () => {
    const request = vi.fn<typeof fetch>(async (url, init) => {
      const id =
        new Headers(init?.headers).get('Operation-Id') ??
        new URL(String(url)).pathname.split('/').at(-1)!;
      return Response.json(
        { id, status: init?.method === 'POST' ? 'Running' : 'Succeeded' },
        { status: init?.method === 'POST' ? 202 : 200 },
      );
    });
    const ports = createAzureAcsMailPorts(options(request));
    const sent = await ports.provider.send({
      idempotencyKey: 'pegma-mail:v1:partition:job:1',
      mail: {
        recipient: 'person@example.test',
        subject: 'Verify',
        text: 'Code 12345678',
      },
    });

    await expect(
      ports.reconciliation.reconcile({
        idempotencyKey: 'pegma-mail:v1:partition:job:1',
        providerMessageRef: sent.providerMessageRef,
      }),
    ).resolves.toEqual({ status: 'unknown' });
  });

  it('classifies only adapter-owned failures', () => {
    expect(
      classifyAzureAcsFailure(new AzureAcsMailError('provider_retryable')),
    ).toBe('provider_retryable');
    expect(classifyAzureAcsFailure(new Error('secret'))).toBe(
      'provider_unavailable',
    );
  });
});
