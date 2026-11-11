import { hasPermission, resolveAccess, type AccessContext } from '@pegma/authorization-core';
import type { PolicyDocumentV1 } from '@pegma/authorization-policy';
import type { KnowledgeRetrievalApplication } from '@pegma/knowledge-base-application';
import { knowledgePermissions, type Applicability } from '@pegma/knowledge-base-contracts';
import { defineCollection, type Store } from '@pegma/storage-core';
import type { Clock, PrincipalId } from '@pegma/spine';
import {
  createSupportDeskAssistant,
  type AssistantConfigurationPort,
  type AssistantCustomerAuthority,
  type AssistantCustomerAuthorityPort,
  type AssistantModelPort,
  type AssistantProcessResult,
  type AssistantTokenCounter,
  type AssistantUsagePort,
} from '@pegma/support-desk-ai';
import {
  supportPermissions,
  type AssistantTurnApplication,
  type AssistantTurnScanResult,
} from '@pegma/support-desk-application';
import { createAgentPrincipalResolver, type AgentAuthorityOptions } from './agent-authority';
import { PEGMA_ACCESS_POLICY } from './support-access';

export const SUPPORT_ASSISTANT_WORKER_ID = 'pegma.dev-support-answer-worker';
export const SUPPORT_ASSISTANT_SCAN_LIMIT = 1;
const MAX_CURSOR = 16_384;
const MAX_TICK_MILLISECONDS = 25_000;
const COMMIT_RESERVE_MILLISECONDS = 1_000;
const CHECKPOINT_KEY = { partition: 'support-answering', id: 'scan' } as const;

interface Checkpoint {
  readonly partition: string;
  readonly id: string;
  readonly cursor: string | null;
  readonly generation: number;
  /** A scheduling hint only. Every resumed turn still uses current SDK guards. */
  readonly notBefore?: string;
}

function bounded(value: unknown, maximum = 200): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u001F\u007F]/u.test(value)
  );
}
function validCursor(value: unknown): value is string | null {
  return value === null || bounded(value, MAX_CURSOR);
}
function checkpoint(value: Checkpoint | null): Checkpoint {
  if (value === null) return { ...CHECKPOINT_KEY, cursor: null, generation: 0 };
  if (
    value.partition !== CHECKPOINT_KEY.partition ||
    value.id !== CHECKPOINT_KEY.id ||
    !validCursor(value.cursor) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    (value.notBefore !== undefined &&
      (!bounded(value.notBefore, 40) ||
        !Number.isFinite(Date.parse(value.notBefore)) ||
        new Date(value.notBefore).toISOString() !== value.notBefore))
  )
    throw new TypeError('Invalid Support assistant checkpoint.');
  return value;
}

/** Independent host progress only. Opaque SDK continuations are never decoded. */
export const supportAssistantCheckpoints = defineCollection<Checkpoint>({
  name: 'pegma-dev-support-assistant-checkpoints',
  key: (value) => ({ partition: value.partition, id: value.id }),
  codec: {
    encode(value) {
      checkpoint(value);
      return {
        ...value,
        cursor: value.cursor === null ? 'end' : 'next:' + value.cursor,
      };
    },
    decode(value) {
      if (
        Object.keys(value).some(
          (key) => !['partition', 'id', 'cursor', 'generation', 'notBefore'].includes(key),
        ) ||
        !['partition', 'id', 'cursor', 'generation'].every((key) => Object.hasOwn(value, key)) ||
        typeof value.partition !== 'string' ||
        typeof value.id !== 'string' ||
        typeof value.cursor !== 'string' ||
        typeof value.generation !== 'number' ||
        (Object.hasOwn(value, 'notBefore') && typeof value.notBefore !== 'string')
      )
        throw new TypeError('Invalid Support assistant checkpoint fields.');
      const cursor =
        value.cursor === 'end'
          ? null
          : value.cursor.startsWith('next:')
            ? value.cursor.slice(5)
            : undefined;
      if (!validCursor(cursor)) throw new TypeError('Invalid Support assistant continuation.');
      return checkpoint({
        partition: value.partition,
        id: value.id,
        cursor,
        generation: value.generation,
        ...(typeof value.notBefore === 'string' ? { notBefore: value.notBefore } : {}),
      });
    },
  },
});

/** Trusted host selection after current Identity and audited roles resolution. */
export type SupportAssistantAudience = Pick<
  AssistantCustomerAuthority,
  'audienceVersion' | 'usageScopeRef' | 'collectionIds' | 'applicability'
>;

export interface SupportAssistantOptions extends AgentAuthorityOptions {
  readonly store: Store;
  readonly clock: Clock;
  readonly application: AssistantTurnApplication;
  /** Both methods delegate to the same direct, released KB application. */
  readonly knowledge: Pick<
    KnowledgeRetrievalApplication,
    'retrieveAnswerSources' | 'confirmAnswerSources'
  >;
  readonly configuration: AssistantConfigurationPort;
  readonly model: AssistantModelPort;
  readonly tokenCounter: AssistantTokenCounter;
  readonly usage: AssistantUsagePort;
  /** Exact reviewed customer policy. Omission retains the current host policy. */
  readonly customerPolicy?: PolicyDocumentV1;
  /** Server configuration only. Missing or false keeps every tick inert. */
  readonly isEnabled?: () => boolean;
  /** Synchronous, bounded, server-owned mapping; no request supplies this. */
  readonly selectAudience?: (access: AccessContext) => SupportAssistantAudience | null;
}

function audience(value: SupportAssistantAudience): SupportAssistantAudience {
  const applicability = value.applicability;
  if (
    !bounded(value.audienceVersion) ||
    !bounded(value.usageScopeRef) ||
    !Array.isArray(value.collectionIds) ||
    value.collectionIds.length < 1 ||
    value.collectionIds.length > 4 ||
    new Set(value.collectionIds).size !== value.collectionIds.length ||
    !value.collectionIds.every((id) => bounded(id)) ||
    applicability === null ||
    typeof applicability !== 'object' ||
    !bounded(applicability.productId) ||
    !bounded(applicability.productVersion) ||
    Object.keys(applicability).some(
      (key) => !['productId', 'productVersion', 'buildId', 'locale'].includes(key),
    ) ||
    (applicability.buildId !== undefined && !bounded(applicability.buildId)) ||
    (applicability.locale !== undefined && !bounded(applicability.locale))
  )
    throw new TypeError('Support assistant customer mapping is not configured.');
  const selected: Applicability = Object.freeze({ ...applicability });
  return Object.freeze({
    audienceVersion: value.audienceVersion,
    usageScopeRef: value.usageScopeRef,
    collectionIds: Object.freeze([...value.collectionIds]),
    applicability: selected,
  });
}

export function createSupportAssistantCustomerAuthority(
  options: Pick<
    SupportAssistantOptions,
    | 'identity'
    | 'identityLinkFromClaims'
    | 'roleStore'
    | 'isEnabled'
    | 'selectAudience'
    | 'customerPolicy'
  >,
): AssistantCustomerAuthorityPort {
  const resolve = createAgentPrincipalResolver(options);
  return Object.freeze({
    async resolve(principalId: PrincipalId): ReturnType<AssistantCustomerAuthorityPort['resolve']> {
      try {
        if (options.isEnabled?.() !== true || options.selectAudience === undefined)
          return { outcome: 'unavailable' };
        const current = await resolve(principalId);
        if (options.isEnabled?.() !== true) return { outcome: 'unavailable' };
        if (current === null) return { outcome: 'inactive' };
        // Reuse only actual current roles/identity, resolving the exact supplied
        // policy through Auth Core. Neither mapping nor service grants add access.
        const access = resolveAccess(
          { principalId, roles: current.roles },
          options.customerPolicy ?? PEGMA_ACCESS_POLICY,
        );
        if (
          !hasPermission(access, knowledgePermissions.articleRead) ||
          !hasPermission(access, knowledgePermissions.botRead)
        )
          return { outcome: 'inactive' };
        const selected = options.selectAudience(access);
        if (selected === null) return { outcome: 'inactive' };
        const mapping = audience(selected);
        if (options.isEnabled?.() !== true) return { outcome: 'unavailable' };
        return {
          outcome: 'ready',
          authority: Object.freeze({
            ...mapping,
            access: Object.freeze({
              ...access,
              roles: Object.freeze([...access.roles]),
              permissions: Object.freeze([...access.permissions]),
              entitlements: Object.freeze([...access.entitlements]),
            }),
            policyVersion: access.policyVersion,
          }),
        };
      } catch {
        return { outcome: 'unavailable' };
      }
    },
  });
}

export type SupportAssistantTick =
  | {
      readonly outcome: 'deferred';
      readonly nextAttemptAt: string;
      readonly checkpointSaved: false;
    }
  | (Extract<AssistantProcessResult, { readonly outcome: 'prepared' }> & {
      readonly physicalRows: number;
      readonly candidates: number;
      readonly checkpointSaved: false;
    })
  | {
      readonly outcome: 'disabled' | 'unavailable';
      readonly checkpointSaved: false;
    }
  | {
      readonly outcome: 'scanned';
      readonly physicalRows: number;
      readonly candidates: number;
      readonly turn: AssistantProcessResult['outcome'] | 'none';
      readonly checkpointSaved: boolean;
    };

function validPage(page: AssistantTurnScanResult): boolean {
  return (
    page.pages === 1 &&
    Number.isSafeInteger(page.physicalRows) &&
    page.physicalRows >= 0 &&
    page.physicalRows <= SUPPORT_ASSISTANT_SCAN_LIMIT &&
    Array.isArray(page.candidates) &&
    page.candidates.length <= page.physicalRows &&
    page.candidates.every(
      (candidate) => bounded(candidate.ticketId) && bounded(candidate.turnId),
    ) &&
    validCursor(page.nextCursor)
  );
}

/** Explicit answer-only composition. No timer, request handler or activation. */
export function createSupportAssistantRuntime(options: SupportAssistantOptions) {
  const enabled = () => {
    try {
      return options.isEnabled?.() === true;
    } catch {
      return false;
    }
  };
  const customerAuthority = createSupportAssistantCustomerAuthority(options);
  function serviceAccess() {
    if (!enabled()) throw new Error('Support assistant is disabled.');
    return Promise.resolve(
      resolveAccess(
        { principalId: SUPPORT_ASSISTANT_WORKER_ID },
        {
          version: 'pegma.dev-support-answer-service-1',
          defaults: [
            supportPermissions.assistantRead,
            supportPermissions.assistantReply,
            supportPermissions.assistantEscalate,
          ],
        },
      ),
    );
  }
  return Object.freeze({
    async runTick(run: { readonly signal?: AbortSignal } = {}): Promise<SupportAssistantTick> {
      if (!enabled()) return { outcome: 'disabled', checkpointSaved: false };
      if (options.selectAudience === undefined)
        return { outcome: 'unavailable', checkpointSaved: false };
      if (run.signal?.aborted) return { outcome: 'unavailable', checkpointSaved: false };
      const started = performance.now();
      const controller = new AbortController();
      const abort = () => controller.abort();
      const remaining = () => MAX_TICK_MILLISECONDS - (performance.now() - started);
      let rejectDeadline: (reason: Error) => void = () => {};
      const boundary = new Promise<never>((_, reject) => {
        rejectDeadline = reject;
      });
      // Handle a deadline even while a non-cancellable Store read is pending.
      const timer = setTimeout(() => {
        abort();
        rejectDeadline(new Error('Support assistant tick expired.'));
      }, MAX_TICK_MILLISECONDS);
      const cancel = () => {
        abort();
        rejectDeadline(new Error('Support assistant tick cancelled.'));
      };
      if (run.signal?.aborted) cancel();
      else run.signal?.addEventListener('abort', cancel, { once: true });
      function current() {
        return enabled() && !controller.signal.aborted && remaining() > 0;
      }
      async function within<T>(operation: () => Promise<T>): Promise<T> {
        if (!current()) throw new Error('Support assistant tick is not current.');
        const value = await Promise.race([Promise.resolve().then(operation), boundary]);
        if (!current()) throw new Error('Support assistant tick is not current.');
        return value;
      }
      try {
        const configuration = await within(() => options.configuration.resolve());
        if (configuration.outcome !== 'ready')
          return {
            outcome: configuration.outcome === 'disabled' ? 'disabled' : 'unavailable',
            checkpointSaved: false,
          };
        const version = configuration.configuration.version;
        const collection = options.store.collection(supportAssistantCheckpoints);
        const priorVersion = await within(() => collection.getVersioned(CHECKPOINT_KEY));
        const prior = checkpoint(priorVersion?.value ?? null);
        if (prior.generation === Number.MAX_SAFE_INTEGER)
          return { outcome: 'unavailable', checkpointSaved: false };
        if (
          prior.notBefore !== undefined &&
          Date.parse(prior.notBefore) > Date.parse(options.clock.now())
        )
          return {
            outcome: 'deferred',
            nextAttemptAt: prior.notBefore,
            checkpointSaved: false,
          };
        let owned: Checkpoint | undefined;
        async function saveProgress(cursor: string | null, notBefore?: string): Promise<boolean> {
          const owner = owned;
          const next: Checkpoint = {
            ...CHECKPOINT_KEY,
            generation: (owner ?? prior).generation + 1,
            cursor,
            ...(notBefore === undefined ? {} : { notBefore }),
          };
          if (!current()) return false;
          if (owner === undefined) {
            if (priorVersion === null) return (await collection.insertIfAbsent(next)).inserted;
            return collection.putIfUnchanged(next, priorVersion.version);
          }
          const saved = await collection.update(
            CHECKPOINT_KEY,
            (value) => {
              const actual = checkpoint(value);
              return current() &&
                actual.generation === owner.generation &&
                actual.cursor === owner.cursor &&
                actual.notBefore === owner.notBefore
                ? { action: 'write', value: next }
                : { action: 'keep' };
            },
            { maxAttempts: 1 },
          );
          return saved.written;
        }
        const assistant = createSupportDeskAssistant({
          application: options.application,
          knowledge: {
            retrieveAnswerSources: (access, input) =>
              options.knowledge.retrieveAnswerSources(access, input),
            confirmAnswerSources: (access, input) =>
              options.knowledge.confirmAnswerSources(access, input),
          },
          serviceAccess,
          customerAuthority,
          configuration: options.configuration,
          usage: options.usage,
          model: options.model,
          tokenCounter: options.tokenCounter,
          clock: options.clock,
          maxOperationMilliseconds: Math.max(
            COMMIT_RESERVE_MILLISECONDS + 1,
            Math.floor(remaining()),
          ),
          commitReserveMilliseconds: COMMIT_RESERVE_MILLISECONDS,
          // Bound storage work in this invocation. An unknown ACK remains
          // durable pending work for a later tick, never a paid-call retry.
          storageCommandAttempts: 1,
          // Pegma requires a physical handoff between retrieval and paid work.
          stagedRetrieval: true,
        });
        const page = await within(() =>
          assistant.scanCandidates({
            limit: SUPPORT_ASSISTANT_SCAN_LIMIT,
            ...(prior.cursor === null ? {} : { cursor: prior.cursor }),
          }),
        );
        if (!validPage(page)) throw new TypeError('Invalid Support assistant scan page.');
        const ready = await within(() => options.configuration.resolve(version));
        if (ready.outcome !== 'ready' || ready.configuration.version !== version)
          return { outcome: 'unavailable', checkpointSaved: false };
        let turn: AssistantProcessResult['outcome'] | 'none' = 'none';
        let preparation:
          Extract<AssistantProcessResult, { readonly outcome: 'prepared' }> | undefined;
        const candidate = page.candidates[0];
        if (candidate !== undefined) {
          if (
            remaining() <= COMMIT_RESERVE_MILLISECONDS ||
            prior.generation >= Number.MAX_SAFE_INTEGER - 1
          )
            return { outcome: 'unavailable', checkpointSaved: false };
          const leaseMilliseconds = 30_000;
          // A claim can begin anywhere inside this tick. Cover its entire SDK
          // lease if the invocation stops before the prepared due hint is saved.
          const notBefore = new Date(
            Date.parse(options.clock.now()) + MAX_TICK_MILLISECONDS + leaseMilliseconds,
          ).toISOString();
          if (!(await within(() => saveProgress(prior.cursor, notBefore))))
            return { outcome: 'unavailable', checkpointSaved: false };
          owned = {
            ...CHECKPOINT_KEY,
            cursor: prior.cursor,
            generation: prior.generation + 1,
            notBefore,
          };
          const result = await within(() =>
            assistant.processTurn(
              {
                ...candidate,
                workerId: SUPPORT_ASSISTANT_WORKER_ID,
                leaseMilliseconds,
              },
              { signal: controller.signal },
            ),
          );
          turn = result.outcome;
          if (result.outcome === 'prepared') preparation = result;
          if (turn === 'not_claimed')
            return {
              outcome: 'deferred',
              nextAttemptAt: notBefore,
              checkpointSaved: false,
            };
          if (turn === 'pending')
            return {
              outcome: 'scanned',
              physicalRows: page.physicalRows,
              candidates: page.candidates.length,
              turn,
              checkpointSaved: false,
            };
        }
        const final = await within(() => options.configuration.resolve(version));
        if (final.outcome !== 'ready' || final.configuration.version !== version)
          return { outcome: 'unavailable', checkpointSaved: false };
        // Keep the original cursor after the final current-route fence. A later
        // physical tick revisits this work at/after the SDK's nextAttemptAt.
        // Never call processTurn again here or resume with waitUntil.
        if (preparation !== undefined) {
          if (!(await within(() => saveProgress(prior.cursor, preparation.nextAttemptAt))))
            return { outcome: 'unavailable', checkpointSaved: false };
          return {
            ...preparation,
            physicalRows: page.physicalRows,
            candidates: page.candidates.length,
            checkpointSaved: false,
          };
        }
        const saved = await within(() => saveProgress(page.nextCursor));
        return {
          outcome: 'scanned',
          physicalRows: page.physicalRows,
          candidates: page.candidates.length,
          turn,
          checkpointSaved: saved,
        };
      } catch {
        return { outcome: 'unavailable', checkpointSaved: false };
      } finally {
        clearTimeout(timer);
        run.signal?.removeEventListener('abort', cancel);
      }
    },
  });
}
