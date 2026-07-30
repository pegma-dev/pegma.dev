import {
  defineCollection,
  type EntityKey,
  type Store,
  type StoredRecord,
} from '@pegma/storage-core';

const BODY_BINDING_PARTITION = 'github-webhook-body';

/** One signed webhook body bound to the delivery id that first carried it. */
export interface WebhookBodyBinding {
  /** SHA-256 hex of the exact bytes `X-Hub-Signature-256` covered. */
  readonly bodyHash: string;
  readonly deliveryId: string;
  readonly firstSeenAt: string;
}

/**
 * Outcome of claiming a signed body.
 *
 * `bound` means this delivery owns the body — either it is new or the same
 * delivery is being retried. `replayed` means the identical signed bytes were
 * already claimed by a different delivery id.
 */
export type WebhookBodyBindingResult =
  | { readonly status: 'bound' }
  | { readonly status: 'replayed'; readonly boundDeliveryId: string };

export function webhookBodyBindingKey(bodyHash: string): EntityKey {
  return { partition: BODY_BINDING_PARTITION, id: bodyHash };
}

function encode(value: WebhookBodyBinding): StoredRecord {
  return {
    bodyHash: value.bodyHash,
    deliveryId: value.deliveryId,
    firstSeenAt: value.firstSeenAt,
  };
}

function decode(record: StoredRecord): WebhookBodyBinding {
  return {
    bodyHash: typeof record['bodyHash'] === 'string' ? record['bodyHash'] : '',
    deliveryId:
      typeof record['deliveryId'] === 'string' ? record['deliveryId'] : '',
    firstSeenAt:
      typeof record['firstSeenAt'] === 'string' ? record['firstSeenAt'] : '',
  };
}

export function webhookBodyBindingCollection() {
  return defineCollection<WebhookBodyBinding>({
    name: 'githubWebhookBodyBinding',
    key: (value) => webhookBodyBindingKey(value.bodyHash),
    codec: { encode, decode },
  });
}

/** SHA-256 hex of the exact bytes the signature covered. */
export async function hashSignedWebhookBody(
  body: Uint8Array,
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', body as BufferSource),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Claim one signed body for `deliveryId`, reporting a replay under another id.
 *
 * GitHub's HMAC covers the body only, so `X-GitHub-Delivery` — the
 * `@pegma/webhooks` ledger dedup key — is unauthenticated input: anyone holding
 * a previously valid signed body could re-present it under a fresh delivery id
 * and slip past dedup. Binding the signed bytes to the first delivery id that
 * carried them moves dedup onto data the signature actually covers. The claim
 * is an `insertIfAbsent`, so concurrent deliveries cannot both win it.
 */
export async function bindSignedWebhookBody(
  store: Store,
  binding: WebhookBodyBinding,
): Promise<WebhookBodyBindingResult> {
  const result = await store
    .collection(webhookBodyBindingCollection())
    .insertIfAbsent(binding);
  if (result.inserted || result.value.deliveryId === binding.deliveryId) {
    return { status: 'bound' };
  }
  return { status: 'replayed', boundDeliveryId: result.value.deliveryId };
}

/**
 * Drop a claim so a delivery that failed stays retryable.
 *
 * The binding exists to stop a replay of an already-applied body, not to make
 * one failed attempt final: GitHub does not auto-retry, so an operator
 * redelivery must still be able to run.
 */
export async function releaseSignedWebhookBody(
  store: Store,
  bodyHash: string,
): Promise<void> {
  await store
    .collection(webhookBodyBindingCollection())
    .delete(webhookBodyBindingKey(bodyHash));
}
