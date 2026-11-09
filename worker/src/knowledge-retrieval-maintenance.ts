import { resolveAccess } from '@pegma/authorization-core';
import {
  createKnowledgeBaseApplication,
  type KnowledgeBaseApplication,
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
  /** Only the actual request application, including its trusted source ports. */
  readonly application?: Pick<KnowledgeBaseApplication, 'repairArticleIndex'>;
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
const PAGE_LIMIT = 10;
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

function bookmark(value: BookmarkRecord | null): Bookmark {
  if (value === null) return { cursor: null, generation: 0 };
  if (
    value.partition !== KEY.partition ||
    value.id !== KEY.id ||
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

/** No scheduler, identity, email, grant, or report-factory construction here. */
export function createKnowledgeRetrievalMaintenance(
  options: KnowledgeRetrievalMaintenanceOptions,
) {
  function diagnostic(
    level: 'info' | 'warn' | 'error',
    message: string,
    fields: Readonly<Record<string, unknown>>,
  ): void {
    try {
      options.logger.log(level, message, fields);
    } catch {
      // A generic injected Logger must not turn best-effort repair into an
      // article acknowledgement failure or invalidate a committed checkpoint.
    }
  }

  function current() {
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

  return Object.freeze({
    /** One physical scan page; projection reads/writes have their own SDK bounds. */
    async runPage(): Promise<void> {
      let stage = 'configuration';
      try {
        if (!current()) return;
        const collection = options.store.collection(checkpoints);
        stage = 'checkpoint_read';
        const prior = bookmark(await collection.get(KEY));
        if (!current()) return;
        if (prior.generation === Number.MAX_SAFE_INTEGER)
          throw new RangeError('Knowledge retrieval generation is exhausted.');
        // Current phase 01 has no private-source authoring. Retained nonempty
        // source snapshots fail closed without their real eligibility ports.
        const application = createKnowledgeBaseApplication({
          store: options.store,
          clock: options.clock,
        });
        stage = 'repair';
        const result = await application.repairRetrievalPage(access, {
          limit: PAGE_LIMIT,
          ...(prior.cursor === null ? {} : { cursor: prior.cursor }),
        });
        if (!validPage(result))
          throw new TypeError('Invalid knowledge retrieval page.');
        if (!current()) return;
        stage = 'checkpoint_write';
        const saved = await collection.update(KEY, (value) => {
          const actual = bookmark(value);
          if (
            !current() ||
            actual.generation !== prior.generation ||
            actual.cursor !== prior.cursor
          )
            return { action: 'keep' };
          // Even null -> null advances, fencing delayed completion of a cycle.
          return {
            action: 'write',
            value: {
              ...KEY,
              cursor: result.nextCursor,
              generation: prior.generation + 1,
            },
          };
        });
        diagnostic('info', 'knowledge.retrieval_maintenance.page', {
          physicalRows: result.physicalRows,
          candidates: result.candidates,
          repaired: result.repaired,
          pending: result.pending,
          blocked: result.blocked,
          cursorSaved: saved.written,
        });
      } catch {
        // A partial repair may have committed; the prior cursor is retried.
        diagnostic('error', 'knowledge.retrieval_maintenance.failed', {
          stage,
        });
      }
    },

    /** Never changes a committed article command's acknowledgement on failure. */
    async repairArticleBestEffort(articleId: string): Promise<void> {
      try {
        if (!current()) return;
        const application =
          options.application ??
          createKnowledgeBaseApplication({
            store: options.store,
            clock: options.clock,
          });
        const result = await application.repairArticleIndex(access, {
          articleId,
        });
        if (!current()) return;
        diagnostic('info', 'knowledge.retrieval_maintenance.keyed', {
          status: result.status,
          indexed: result.indexed,
        });
      } catch {
        diagnostic('warn', 'knowledge.retrieval_maintenance.failed', {
          stage: 'keyed',
        });
      }
    },
  });
}
