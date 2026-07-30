import { createMemoryStore } from '@pegma/storage-core';
import { describe, expect, it } from 'vitest';
import {
  bindSignedWebhookBody,
  hashSignedWebhookBody,
} from './github-webhook-body-binding';

const FIRST_DELIVERY = '11111111-1111-4111-8111-111111111111';
const SECOND_DELIVERY = '22222222-2222-4222-8222-222222222222';
const AT = '2026-07-28T18:00:00.000Z';

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('hashSignedWebhookBody', () => {
  it('is the SHA-256 hex of the exact bytes', async () => {
    // Published SHA-256 of the empty input and of "abc".
    expect(await hashSignedWebhookBody(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(await hashSignedWebhookBody(bytes('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('separates bodies that differ by one byte', async () => {
    expect(await hashSignedWebhookBody(bytes('{"a":1}'))).not.toBe(
      await hashSignedWebhookBody(bytes('{"a":2}')),
    );
  });
});

describe('bindSignedWebhookBody', () => {
  it('binds a body once and reports a replay under another delivery id', async () => {
    const store = createMemoryStore();
    const bodyHash = await hashSignedWebhookBody(bytes('{"action":"published"}'));

    expect(
      await bindSignedWebhookBody(store, {
        bodyHash,
        deliveryId: FIRST_DELIVERY,
        firstSeenAt: AT,
      }),
    ).toEqual({ status: 'bound' });

    // Same delivery id: a retry of the same event, not a replay.
    expect(
      await bindSignedWebhookBody(store, {
        bodyHash,
        deliveryId: FIRST_DELIVERY,
        firstSeenAt: '2026-07-28T19:00:00.000Z',
      }),
    ).toEqual({ status: 'bound' });

    expect(
      await bindSignedWebhookBody(store, {
        bodyHash,
        deliveryId: SECOND_DELIVERY,
        firstSeenAt: AT,
      }),
    ).toEqual({ status: 'replayed', boundDeliveryId: FIRST_DELIVERY });
  });

  it('binds different bodies independently', async () => {
    const store = createMemoryStore();
    await bindSignedWebhookBody(store, {
      bodyHash: await hashSignedWebhookBody(bytes('first')),
      deliveryId: FIRST_DELIVERY,
      firstSeenAt: AT,
    });

    expect(
      await bindSignedWebhookBody(store, {
        bodyHash: await hashSignedWebhookBody(bytes('second')),
        deliveryId: SECOND_DELIVERY,
        firstSeenAt: AT,
      }),
    ).toEqual({ status: 'bound' });
  });

  it('keeps the first delivery id, so a claim never transfers', async () => {
    const store = createMemoryStore();
    const bodyHash = await hashSignedWebhookBody(bytes('{"action":"edited"}'));
    await bindSignedWebhookBody(store, {
      bodyHash,
      deliveryId: FIRST_DELIVERY,
      firstSeenAt: AT,
    });

    // Repeated replay attempts keep naming the original owner rather than
    // rewriting the record to the most recent caller.
    for (const attempt of [1, 2, 3]) {
      expect(
        await bindSignedWebhookBody(store, {
          bodyHash,
          deliveryId: SECOND_DELIVERY,
          firstSeenAt: `2026-07-28T2${attempt}:00:00.000Z`,
        }),
      ).toEqual({ status: 'replayed', boundDeliveryId: FIRST_DELIVERY });
    }

    expect(
      await bindSignedWebhookBody(store, {
        bodyHash,
        deliveryId: FIRST_DELIVERY,
        firstSeenAt: AT,
      }),
    ).toEqual({ status: 'bound' });
  });
});
