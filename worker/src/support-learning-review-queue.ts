import type { Clock, Logger } from '@pegma/spine';
import { defineCollection, type Store } from '@pegma/storage-core';

interface ReviewKey {
  readonly ticketId: string;
  readonly commandId: string;
}

/** Transport-facing projection of the SDK worker. It grants no review authority. */
export interface SupportLearningReviewDispatch {
  scanPending(input: { readonly limit: 1; readonly cursor?: string }): Promise<{
    readonly candidates: readonly (ReviewKey & { readonly held: boolean })[];
    readonly physicalRows: number;
    readonly pages: 1;
    readonly nextCursor: string | null;
  }>;
  /** One freshly claimed SDK phase; never run a second phase in this invocation. */
  process(input: ReviewKey & {
    readonly workerId: string;
    readonly leaseMilliseconds: number;
  }): Promise<'pending' | 'settled'>;
}

export interface SupportLearningReviewQueueMessage {
  readonly version: 1;
  readonly key: string;
}

export interface SupportLearningReviewQueueOptions {
  readonly enabled?: () => boolean;
  readonly store: () => Store;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly runtime: () => SupportLearningReviewDispatch;
  readonly sender: {
    send(message: SupportLearningReviewQueueMessage): Promise<void>;
  };
  readonly newId?: () => string;
}

interface Hint extends ReviewKey {
  readonly id: string;
  readonly version: 1;
}
interface Checkpoint {
  readonly id: 'cursor';
  readonly sdkCursor: string;
  readonly hintCursor: string;
  readonly next: 'sdk' | 'hints';
  readonly generation: number;
}
const PARTITION = 'reviews';
const MAX_CURSOR = 16_384;
const RETRY_SECONDS = 30;

function scalar(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}
function cursor(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length > 0 && value.length <= MAX_CURSOR);
}
function canonicalTime(clock: Clock): void {
  const value = clock.now();
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value) throw new TypeError('Invalid review dispatcher clock');
}
function checkedHint(value: Hint): Hint {
  if (Object.keys(value).length !== 4 || !/^[a-f0-9]{64}$/u.test(value.id) ||
    value.version !== 1 || !scalar(value.ticketId) || !scalar(value.commandId))
    throw new TypeError('Invalid review dispatch hint');
  return value;
}
const hints = defineCollection<Hint>({
  name: 'pegma-dev.support-learning-review-hints.v1',
  key: (value) => ({ partition: PARTITION, id: value.id }),
  codec: {
    encode: (value) => ({ ...checkedHint(value) }),
    decode(value) {
      if (Object.keys(value).length !== 4 || typeof value.id !== 'string' ||
        typeof value.ticketId !== 'string' || typeof value.commandId !== 'string' || value.version !== 1)
        throw new TypeError('Invalid review dispatch hint');
      return checkedHint({ id: value.id, ticketId: value.ticketId, commandId: value.commandId, version: 1 });
    },
  },
});
function checkedCheckpoint(value: Checkpoint): Checkpoint {
  const physicalCursor = (value: string) => value === 'end' || (value.startsWith('next:') && cursor(value.slice(5)));
  if (Object.keys(value).length !== 5 || value.id !== 'cursor' ||
    !Number.isSafeInteger(value.generation) || value.generation < 1 ||
    !['sdk', 'hints'].includes(value.next) || !physicalCursor(value.sdkCursor) || !physicalCursor(value.hintCursor))
    throw new TypeError('Invalid review dispatch checkpoint');
  return value;
}
const checkpoints = defineCollection<Checkpoint>({
  name: 'pegma-dev.support-learning-review-dispatch.v1',
  key: () => ({ partition: PARTITION, id: 'cursor' }),
  codec: {
    encode: (value) => ({ ...checkedCheckpoint(value) }),
    decode(value) {
      if (Object.keys(value).length !== 5 || value.id !== 'cursor' ||
        typeof value.sdkCursor !== 'string' || typeof value.hintCursor !== 'string' ||
        (value.next !== 'sdk' && value.next !== 'hints') || typeof value.generation !== 'number')
        throw new TypeError('Invalid review dispatch checkpoint');
      return checkedCheckpoint({ id: 'cursor', sdkCursor: value.sdkCursor, hintCursor: value.hintCursor,
        next: value.next, generation: value.generation });
    },
  },
});

async function opaqueKey(input: ReviewKey): Promise<string> {
  if (!scalar(input.ticketId) || !scalar(input.commandId)) throw new TypeError('Invalid review dispatch key');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
    JSON.stringify(['pegma.support-learning.review-hint.v1', input.ticketId, input.commandId]),
  ));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
function message(value: unknown): value is SupportLearningReviewQueueMessage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value).length === 2 && 'version' in value && value.version === 1 &&
    'key' in value && typeof value.key === 'string' && /^[a-f0-9]{64}$/u.test(value.key);
}

/** Lossy acceleration only. SDK pending rows, claims and receipts are authoritative. */
export function createSupportLearningReviewQueue(options: SupportLearningReviewQueueOptions) {
  function enabled(): boolean {
    try { return options.enabled?.() === true; } catch { return false; }
  }
  function current(): void {
    if (!enabled()) throw new Error('Review dispatcher disabled');
    canonicalTime(options.clock);
  }
  function diagnostic(stage: string): void {
    try { options.logger.log('warn', 'support.learning_review_dispatch.unavailable', { stage }); }
    catch { /* Diagnostics cannot alter a durable review or its acknowledgement. */ }
  }
  async function send(input: ReviewKey): Promise<void> {
    current();
    const id = await opaqueKey(input);
    current();
    await options.store().collection(hints).put({ ...input, id, version: 1 });
    current();
    await options.sender.send({ version: 1, key: id });
    current();
  }
  return Object.freeze({
    /** Run only AFTER the SDK has durably admitted the exact review command. */
    async enqueue(input: ReviewKey): Promise<void> {
      if (!enabled()) return;
      try { await send(input); } catch { diagnostic('enqueue'); }
    },
    /** Alternate one SDK page and one hint page; never perform a review phase here. */
    async runPage(): Promise<void> {
      if (!enabled()) return;
      try {
        current();
        const collection = options.store().collection(checkpoints);
        const key = { partition: PARTITION, id: 'cursor' };
        const prior = await collection.get(key);
        current();
        const generation = prior?.generation ?? 0;
        if (generation === Number.MAX_SAFE_INTEGER) throw new RangeError('Review dispatch generation exhausted');
        const lane = prior?.next ?? 'sdk';
        const sdkCursor = prior?.sdkCursor ?? 'end';
        const hintCursor = prior?.hintCursor ?? 'end';
        const before = lane === 'sdk' ? sdkCursor : hintCursor;
        let nextCursor: string | null;
        if (lane === 'sdk') {
          const page = await options.runtime().scanPending({ limit: 1,
            ...(before === 'end' ? {} : { cursor: before.slice(5) }) });
          current();
          if (!Number.isSafeInteger(page.physicalRows) || page.physicalRows < 0 || page.physicalRows > 1 ||
            page.pages !== 1 || !Array.isArray(page.candidates) || page.candidates.length > page.physicalRows ||
            !cursor(page.nextCursor)) throw new TypeError('Invalid review dispatch page');
          for (const candidate of page.candidates) {
            if (!scalar(candidate.ticketId) || !scalar(candidate.commandId) || typeof candidate.held !== 'boolean')
              throw new TypeError('Invalid review dispatch candidate');
            if (!candidate.held) await send({ ticketId: candidate.ticketId, commandId: candidate.commandId });
          }
          nextCursor = page.nextCursor;
        } else {
          // Existing hints can outlive a terminal SDK request when a newer put
          // loses its send. Re-delivery confirms current SDK absence/receipt;
          // neither cursor nor transport age is itself a completion proof.
          const page = await options.store().collection(hints).scan({ limit: 1,
            ...(before === 'end' ? {} : { cursor: before.slice(5) }) });
          current();
          if (!Array.isArray(page.records) || page.records.length > 1 || !cursor(page.nextCursor))
            throw new TypeError('Invalid review hint page');
          for (const row of page.records) {
            if (row.key.partition !== PARTITION || row.key.id !== row.value.id ||
              await opaqueKey(row.value) !== row.value.id) throw new TypeError('Invalid review hint binding');
            current();
            await options.sender.send({ version: 1, key: row.value.id });
            current();
          }
          nextCursor = page.nextCursor;
        }
        current();
        const next = nextCursor === null ? 'end' : 'next:' + nextCursor;
        await collection.update(key, (actual) => {
          if (!enabled() || (actual?.generation ?? 0) !== generation || (actual?.sdkCursor ?? 'end') !== sdkCursor ||
            (actual?.hintCursor ?? 'end') !== hintCursor || (actual?.next ?? 'sdk') !== lane)
            return { action: 'keep' };
          return { action: 'write', value: { id: 'cursor', sdkCursor: lane === 'sdk' ? next : sdkCursor,
            hintCursor: lane === 'hints' ? next : hintCursor, next: lane === 'sdk' ? 'hints' : 'sdk', generation: generation + 1 } };
        }, { maxAttempts: 1 });
      } catch { diagnostic('scan'); }
    },
    /** One Queue delivery is one physical invocation and at most one SDK phase. */
    async consume(batch: MessageBatch<unknown>): Promise<void> {
      if (batch.messages.length !== 1) {
        for (const item of batch.messages) item.retry({ delaySeconds: RETRY_SECONDS });
        return;
      }
      const item = batch.messages[0];
      if (item === undefined) return;
      if (!enabled()) { item.retry({ delaySeconds: RETRY_SECONDS }); return; }
      // Refuse malformed transport data without touching persistence or the SDK.
      if (!message(item.body)) { item.ack(); return; }
      try {
        current();
        const collection = options.store().collection(hints);
        const key = { partition: PARTITION, id: item.body.key };
        const hint = await collection.getVersioned(key);
        current();
        if (hint === null) { item.ack(); return; }
        if (hint.value.id !== item.body.key || await opaqueKey(hint.value) !== item.body.key)
          throw new TypeError('Invalid review hint binding');
        current();
        const workerId = options.newId?.() ?? crypto.randomUUID();
        if (!scalar(workerId)) throw new TypeError('Invalid review worker identity');
        const outcome = await options.runtime().process({ ticketId: hint.value.ticketId,
          commandId: hint.value.commandId, workerId, leaseMilliseconds: 25_000 });
        current();
        if (outcome === 'settled') {
          const removed = await collection.deleteIfUnchanged(key, hint.version);
          current();
          if (removed) item.ack();
          else item.retry({ delaySeconds: RETRY_SECONDS });
        } else {
          if (outcome !== 'pending') throw new TypeError('Invalid review worker outcome');
          item.retry({ delaySeconds: RETRY_SECONDS });
        }
      } catch {
        diagnostic('process');
        item.retry({ delaySeconds: RETRY_SECONDS });
      }
    },
  });
}
