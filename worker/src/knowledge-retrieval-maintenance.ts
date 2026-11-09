import { resolveAccess } from '@pegma/authorization-core';
import {
  createKnowledgeBaseApplication,
  type RepairRetrievalPageResult,
} from '@pegma/knowledge-base-application';
import { knowledgePermissions } from '@pegma/knowledge-base-contracts';
import type { Clock, Logger } from '@pegma/spine';
import {
  defineCollection,
  type Store,
  type StoredValue,
} from '@pegma/storage-core';

export interface KnowledgeRetrievalMaintenanceOptions {
  readonly store: Store;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly isEnabled: () => boolean;
}

interface BookmarkRecord {
  readonly partition: StoredValue;
  readonly id: StoredValue;
  readonly cursor: StoredValue;
  readonly generation: StoredValue;
}
interface Bookmark {
  readonly cursor: string | null;
  readonly generation: number;
}

const KEY = { partition: 'knowledge', id: 'retrieval' } as const;
const PAGE_LIMIT = 1;
const MAX_CURSOR_LENGTH = 16_384;
const checkpoints = defineCollection<BookmarkRecord>({
  name: 'pegma-dev-maintenance',
  key: (value) => ({
    partition: String(value.partition),
    id: String(value.id),
  }),
  codec: {
    encode: (value) => ({ ...value }),
    decode(value) {
      if (
        Object.keys(value).length !== 4 ||
        !['partition', 'id', 'cursor', 'generation'].every((field) =>
          Object.hasOwn(value, field),
        )
      )
        throw new TypeError('Invalid knowledge retrieval checkpoint fields.');
      return {
        partition: value.partition ?? null,
        id: value.id ?? null,
        cursor: value.cursor ?? null,
        generation: value.generation ?? null,
      };
    },
  },
});

// This principal is server-owned and never resolved through human or agent
// roles. Indexing derives hints; every reader still confirms current authority.
const access = resolveAccess(
  { principalId: 'pegma.dev-knowledge-index-maintenance' },
  {
    version: 'pegma.dev-knowledge-index-maintenance-1',
    defaults: [knowledgePermissions.indexManage],
  },
);

function validCursor(value: StoredValue): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' &&
      value.length > 0 &&
      value.length <= MAX_CURSOR_LENGTH)
  );
}

function bookmark(value: BookmarkRecord | null, id: string): Bookmark {
  if (value === null) return { cursor: null, generation: 0 };
  if (
    value.partition !== KEY.partition ||
    value.id !== id ||
    !validCursor(value.cursor) ||
    typeof value.generation !== 'number' ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1
  )
    throw new TypeError('Invalid knowledge retrieval checkpoint.');
  return { cursor: value.cursor, generation: value.generation };
}

function validPage(result: RepairRetrievalPageResult): boolean {
  const counts = [
    result.physicalRows,
    result.candidates,
    result.repaired,
    result.pending,
    result.blocked,
  ];
  return (
    counts.every((count) => Number.isSafeInteger(count) && count >= 0) &&
    result.physicalRows <= PAGE_LIMIT &&
    result.candidates <= result.physicalRows &&
    result.repaired + result.pending + result.blocked === result.candidates &&
    validCursor(result.nextCursor)
  );
}

/** Server-owned projection authority; never a human or delegated principal. */
export const knowledgeIndexAccess = access;

/** Phase01 is source-free: private source snapshots fail closed in the SDK. */
export function createKnowledgeProjectionApplication(
  store: Store,
  clock: Clock,
) {
  return createKnowledgeBaseApplication({ store, clock });
}

export function knowledgeRetrievalCurrent(
  options: Pick<KnowledgeRetrievalMaintenanceOptions, 'clock' | 'isEnabled'>,
): boolean {
  if (!options.isEnabled()) return false;
  const now = options.clock.now();
  if (
    typeof now !== 'string' ||
    !Number.isFinite(Date.parse(now)) ||
    new Date(now).toISOString() !== now
  )
    throw new TypeError('Knowledge retrieval requires a canonical clock.');
  return true;
}

export function knowledgeRetrievalDiagnostic(
  logger: Logger,
  level: 'info' | 'warn' | 'error',
  message: string,
  fields: Readonly<Record<string, unknown>>,
): void {
  try {
    logger.log(level, message, fields);
  } catch {
    /* Best-effort diagnostics never change committed effects. */
  }
}

/** Independent cursor cycles use the same generation fence, including null ABA. */
export async function openKnowledgeRetrievalCheckpoint(
  store: Store,
  id: 'retrieval' | 'retrieval-ready',
) {
  const key = { ...KEY, id };
  const collection = store.collection(checkpoints);
  const prior = bookmark(await collection.get(key), id);
  if (prior.generation === Number.MAX_SAFE_INTEGER)
    throw new RangeError('Knowledge retrieval generation is exhausted.');
  return {
    cursor: prior.cursor,
    async advance(
      cursor: string | null,
      current: () => boolean,
    ): Promise<boolean> {
      if (!validCursor(cursor))
        throw new TypeError('Invalid retrieval continuation.');
      const saved = await collection.update(
        key,
        (value) => {
          const actual = bookmark(value, id);
          if (
            !current() ||
            actual.generation !== prior.generation ||
            actual.cursor !== prior.cursor
          )
            return { action: 'keep' };
          return {
            action: 'write',
            value: { ...key, cursor, generation: prior.generation + 1 },
          };
        },
        { maxAttempts: 1 },
      );
      return saved.written;
    },
  };
}

/** No scheduler, identity, email, grant, or report-factory construction here. */
export function createKnowledgeRetrievalMaintenance(
  options: KnowledgeRetrievalMaintenanceOptions,
) {
  const current = () => knowledgeRetrievalCurrent(options);
  return Object.freeze({
    /** One physical row and one attempted projection transaction per candidate. */
    async runPage(): Promise<void> {
      let stage = 'configuration';
      try {
        if (!current()) return;
        stage = 'checkpoint_read';
        const checkpoint = await openKnowledgeRetrievalCheckpoint(
          options.store,
          'retrieval',
        );
        if (!current()) return;
        const application = createKnowledgeProjectionApplication(
          options.store,
          options.clock,
        );
        stage = 'repair';
        const result = await application.repairRetrievalPage(access, {
          limit: PAGE_LIMIT,
          maxBatches: 1,
          ...(checkpoint.cursor === null ? {} : { cursor: checkpoint.cursor }),
        });
        if (!validPage(result))
          throw new TypeError('Invalid knowledge retrieval page.');
        if (!current()) return;
        stage = 'checkpoint_write';
        const saved = await checkpoint.advance(result.nextCursor, current);
        knowledgeRetrievalDiagnostic(
          options.logger,
          'info',
          'knowledge.retrieval_maintenance.page',
          {
            physicalRows: result.physicalRows,
            candidates: result.candidates,
            repaired: result.repaired,
            pending: result.pending,
            blocked: result.blocked,
            cursorSaved: saved,
          },
        );
      } catch {
        // Partial derived writes can remain; retry from the saved cursor.
        knowledgeRetrievalDiagnostic(
          options.logger,
          'error',
          'knowledge.retrieval_maintenance.failed',
          { stage },
        );
      }
    },
  });
}
