import type { Clock } from '@pegma/spine';
import { defineCollection, type Store } from '@pegma/storage-core';
import type {
  EngineeringDispatchProofBinding,
  EngineeringIssueAcknowledgement,
  EngineeringSourceFence,
} from '@pegma/support-desk-application';
import { canonical } from './support-openrouter-model';

export type EngineeringCreationBinding = Pick<
  EngineeringDispatchProofBinding,
  | 'repositoryId'
  | 'dispatchId'
  | 'requestHash'
  | 'repositoryMetadataHash'
  | 'exportMarker'
> & {
  readonly sourceFence: EngineeringSourceFence;
  readonly appId: string;
  readonly installationId: string;
  readonly installationBinding: string;
};
export interface EngineeringCreationAcceptance {
  readonly binding: EngineeringCreationBinding;
  readonly acknowledgement: EngineeringIssueAcknowledgement & {
    readonly url: string;
  };
  readonly payloadHash: string;
  readonly recordedAt: string;
}
export interface EngineeringCreationReceipt extends EngineeringCreationAcceptance {
  readonly proof: string;
}
export interface EngineeringCreationReceiptPort {
  prepare(
    binding: EngineeringCreationBinding,
    signal: AbortSignal,
  ): Promise<boolean>;
  record(
    receipt: EngineeringCreationAcceptance,
    signal: AbortSignal,
  ): Promise<boolean>;
  read(
    binding: EngineeringCreationBinding,
    signal: AbortSignal,
  ): Promise<EngineeringCreationReceipt | null>;
}
interface CreationRecord {
  readonly intentId: string;
  readonly binding: EngineeringCreationBinding;
  readonly createdAt: string;
  readonly acceptance: EngineeringCreationAcceptance | null;
}

const COLLECTION = 'pegma.support-engineering-creation.v1';
const PARTITION = 'creation';
const MAX_BYTES = 8_192;
const encoder = new TextEncoder();
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Invalid engineering creation record');
  const prototype = Object.getPrototypeOf(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some(
      (descriptor) => !('value' in descriptor) || !descriptor.enumerable,
    )
  )
    throw new TypeError('Invalid engineering creation data');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, fields: readonly string[]): void {
  if (
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field))
  )
    throw new TypeError('Invalid engineering creation fields');
}
function text(value: unknown, maximum = 200): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  )
    throw new TypeError('Invalid engineering creation reference');
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value))
    throw new TypeError('Invalid engineering creation hash');
  return value;
}
function id(value: unknown): string {
  const result = text(value);
  if (!/^[1-9][0-9]{0,19}$/u.test(result))
    throw new TypeError('Invalid engineering creation identity');
  return result;
}
function timestamp(value: unknown): string {
  const result = text(value, 24);
  const parsed = Date.parse(result);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== result)
    throw new TypeError('Invalid engineering creation time');
  return result;
}
function bindingSnapshot(value: unknown): EngineeringCreationBinding {
  const row = object(value);
  keys(row, [
    'repositoryId',
    'dispatchId',
    'requestHash',
    'repositoryMetadataHash',
    'exportMarker',
    'sourceFence',
    'appId',
    'installationId',
    'installationBinding',
  ]);
  const source = object(row.sourceFence);
  keys(source, ['ticketId', 'sourceGeneration', 'sourceBindingHash']);
  if (
    typeof source.sourceGeneration !== 'number' ||
    !Number.isSafeInteger(source.sourceGeneration) ||
    source.sourceGeneration < 1
  )
    throw new TypeError('Invalid engineering creation generation');
  const exportMarker = text(row.exportMarker);
  if (!/^pegma-engineering:[a-f0-9]{48}$/u.test(exportMarker))
    throw new TypeError('Invalid engineering creation marker');
  return {
    repositoryId: id(row.repositoryId),
    dispatchId: text(row.dispatchId),
    requestHash: hash(row.requestHash),
    repositoryMetadataHash: hash(row.repositoryMetadataHash),
    exportMarker,
    sourceFence: {
      ticketId: text(source.ticketId),
      sourceGeneration: source.sourceGeneration,
      sourceBindingHash: hash(source.sourceBindingHash),
    },
    appId: id(row.appId),
    installationId: id(row.installationId),
    installationBinding: text(row.installationBinding),
  };
}
function acceptanceSnapshot(value: unknown): EngineeringCreationAcceptance {
  const row = object(value);
  keys(row, ['binding', 'acknowledgement', 'payloadHash', 'recordedAt']);
  const binding = bindingSnapshot(row.binding);
  const ack = object(row.acknowledgement);
  keys(ack, ['repositoryId', 'issueId', 'issueNumber', 'url']);
  if (
    typeof ack.issueNumber !== 'number' ||
    !Number.isSafeInteger(ack.issueNumber) ||
    ack.issueNumber < 1 ||
    ack.repositoryId !== binding.repositoryId
  )
    throw new TypeError('Invalid engineering creation acknowledgement');
  const url = text(ack.url, 2_048);
  const parsed = new URL(url);
  if (
    parsed.origin !== 'https://github.com' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.href !== url ||
    !new RegExp('^/[^/]+/[^/]+/issues/' + ack.issueNumber + '$', 'u').test(
      parsed.pathname,
    )
  )
    throw new TypeError('Invalid engineering creation URL');
  return {
    binding,
    acknowledgement: {
      repositoryId: binding.repositoryId,
      issueId: id(ack.issueId),
      issueNumber: ack.issueNumber,
      url,
    },
    payloadHash: hash(row.payloadHash),
    recordedAt: timestamp(row.recordedAt),
  };
}
function recordSnapshot(value: unknown): Omit<CreationRecord, 'intentId'> {
  const row = object(value);
  keys(row, ['binding', 'createdAt', 'acceptance']);
  const binding = bindingSnapshot(row.binding);
  const createdAt = timestamp(row.createdAt);
  const acceptance =
    row.acceptance === null ? null : acceptanceSnapshot(row.acceptance);
  if (
    acceptance !== null &&
    (!same(binding, acceptance.binding) || acceptance.recordedAt < createdAt)
  )
    throw new TypeError('Invalid engineering creation history');
  return { binding, createdAt, acceptance };
}
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(canonical(value)),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
/** A dispatch cannot acquire another intent by changing any of its binding. */
const intentId = (binding: EngineeringCreationBinding) =>
  digest(['pegma.engineering-creation-intent.v1', binding.dispatchId]);
const key = (id: string) => ({ partition: PARTITION, id });

const records = defineCollection<CreationRecord>({
  name: COLLECTION,
  key: (value) => key(hash(value.intentId)),
  codec: {
    encode(value) {
      const snapshot = recordSnapshot({
        binding: value.binding,
        createdAt: value.createdAt,
        acceptance: value.acceptance,
      });
      const payload = canonical(snapshot);
      if (encoder.encode(payload).byteLength > MAX_BYTES)
        throw new TypeError('Engineering creation record capacity exceeded');
      return { ...key(hash(value.intentId)), format: 1, payload };
    },
    decode(value) {
      keys(value, ['partition', 'id', 'format', 'payload']);
      if (
        value.partition !== PARTITION ||
        value.format !== 1 ||
        typeof value.payload !== 'string' ||
        encoder.encode(value.payload).byteLength > MAX_BYTES
      )
        throw new TypeError('Invalid engineering creation envelope');
      const snapshot = recordSnapshot(JSON.parse(value.payload));
      return { intentId: hash(value.id), ...snapshot };
    },
  },
});

/**
 * Trusted composition supplies the isolated Support Store. This port records a
 * validated provider acknowledgement, never an inference from an editable marker.
 * Intents and receipts have no TTL. Losing an insert ACK sacrifices the one-shot
 * permit and leaves the durable intent in place for human reconciliation.
 */
export function createSupportEngineeringCreationReceipts(options: {
  readonly store: Store;
  readonly clock: Clock;
}): EngineeringCreationReceiptPort {
  const collection = options.store.collection(records);
  const now = () => timestamp(options.clock.now());
  return {
    async prepare(input, signal) {
      try {
        if (signal.aborted) return false;
        const binding = bindingSnapshot(input);
        const id = await intentId(binding);
        const createdAt = now();
        if (signal.aborted) return false;
        const result = await collection.insertIfAbsent({
          intentId: id,
          binding,
          createdAt,
          acceptance: null,
        });
        return (
          !signal.aborted &&
          result.inserted &&
          result.value.intentId === id &&
          same(result.value.binding, binding)
        );
      } catch {
        return false;
      }
    },
    async record(input, signal) {
      try {
        if (signal.aborted) return false;
        const acceptance = acceptanceSnapshot(input);
        const id = await intentId(acceptance.binding);
        if (signal.aborted) return false;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const current = await collection.getVersioned(key(id));
          if (
            signal.aborted ||
            current === null ||
            current.value.intentId !== id ||
            !same(current.value.binding, acceptance.binding)
          )
            return false;
          const at = now();
          if (
            at < current.value.createdAt ||
            acceptance.recordedAt > at ||
            acceptance.recordedAt < current.value.createdAt
          )
            return false;
          const known = current.value.acceptance;
          if (known !== null)
            return (
              same(known.acknowledgement, acceptance.acknowledgement) &&
              known.payloadHash === acceptance.payloadHash
            );
          if (signal.aborted) return false;
          const committed = await collection.putIfUnchanged(
            { ...current.value, acceptance },
            current.version,
          );
          if (committed) return !signal.aborted;
        }
        return false;
      } catch {
        return false;
      }
    },
    async read(input, signal) {
      try {
        if (signal.aborted) return null;
        const binding = bindingSnapshot(input);
        const id = await intentId(binding);
        if (signal.aborted) return null;
        const current = await collection.get(key(id));
        if (
          signal.aborted ||
          current === null ||
          current.intentId !== id ||
          !same(current.binding, binding) ||
          current.acceptance === null
        )
          return null;
        const acceptance = current.acceptance;
        // This hash identifies Store-owned history. It grants no authority without
        // this exact lookup and the adapter's fresh remote identity checks.
        const proof =
          'engineering-create:' +
          (await digest([
            'pegma.engineering-creation-acceptance.v1',
            acceptance,
          ]));
        return signal.aborted || acceptance.recordedAt > now()
          ? null
          : { ...acceptance, proof };
      } catch {
        return null;
      }
    },
  };
}
