import { sweepDurableWindowsPage } from '@pegma/rate-limit-paged';
import type { Clock, Logger } from '@pegma/spine';
import {
  defineCollection,
  type Store,
  type StoredValue,
} from '@pegma/storage-core';

export interface KnowledgeMaintenanceRuntime {
  readonly store: Store;
  readonly clock: Clock;
}

export type KnowledgeMaintenanceTask = 'rate_limits';

export interface KnowledgeMaintenanceOptions {
  readonly tasks?: readonly KnowledgeMaintenanceTask[];
}

interface MaintenanceRecord {
  readonly partition: StoredValue;
  readonly id: StoredValue;
  readonly cursor: StoredValue;
  readonly generation: StoredValue;
}

interface Bookmark {
  readonly cursor: string | null;
  readonly generation: number;
}

const KEY = { partition: 'knowledge', id: 'rate-limits' } as const;
// Isolated cron budget: at most 20 descriptor reads and 20 conditional deletes,
// plus the scan and bookmark reads/write, within Workers Free's 50 D1 calls.
const PAGE_LIMIT = 20;
const MAX_CURSOR_LENGTH = 8_192;
const maintenance = defineCollection<MaintenanceRecord>({
  name: 'pegma-dev-maintenance',
  key: (value) => ({
    partition: String(value.partition),
    id: String(value.id),
  }),
  codec: {
    encode: (value) => ({ ...value }),
    decode: (record) => ({
      partition: record.partition ?? null,
      id: record.id ?? null,
      cursor: record.cursor ?? null,
      generation: record.generation ?? null,
    }),
  },
});

function validCursor(value: StoredValue): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' &&
      value.length > 0 &&
      value.length <= MAX_CURSOR_LENGTH)
  );
}

function bookmark(value: MaintenanceRecord | null): Bookmark {
  if (value === null) return { cursor: null, generation: 0 };
  if (
    value.partition !== KEY.partition ||
    value.id !== KEY.id ||
    !validCursor(value.cursor) ||
    typeof value.generation !== 'number' ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0
  ) {
    throw new TypeError('Invalid knowledge maintenance bookmark.');
  }
  return { cursor: value.cursor, generation: value.generation };
}

function report(
  logger: Logger,
  level: 'info' | 'error',
  event: string,
  fields: Readonly<Record<string, unknown>>,
): void {
  try {
    logger.log(level, event, fields);
  } catch {
    // Diagnostics must not turn completed cleanup into a failed invocation.
  }
}

/**
 * One bounded global cleanup page, independently of knowledge enablement or
 * OAuth client registration. The package owns all limiter record validation.
 */
export async function runKnowledgeMaintenance(
  runtime: KnowledgeMaintenanceRuntime,
  logger: Logger,
  options: KnowledgeMaintenanceOptions = {},
): Promise<void> {
  if (!(options.tasks ?? ['rate_limits']).includes('rate_limits')) return;
  try {
    const collection = runtime.store.collection(maintenance);
    const prior = bookmark(await collection.get(KEY));
    if (prior.generation === Number.MAX_SAFE_INTEGER) {
      throw new RangeError('Knowledge maintenance generation is exhausted.');
    }
    const result = await sweepDurableWindowsPage(runtime.store, {
      limit: PAGE_LIMIT,
      clock: runtime.clock,
      ...(prior.cursor === null ? {} : { cursor: prior.cursor }),
    });
    if (!validCursor(result.nextCursor)) {
      throw new TypeError('Invalid knowledge maintenance continuation.');
    }
    // Capture the result before awaiting OCC. A successful null-to-null cycle
    // must still advance the generation so an older invocation cannot win ABA.
    const nextCursor = result.nextCursor;
    await collection.update(KEY, (current) => {
      const actual = bookmark(current);
      if (
        actual.generation !== prior.generation ||
        actual.cursor !== prior.cursor
      )
        return { action: 'keep' };
      return {
        action: 'write',
        value: {
          ...KEY,
          cursor: nextCursor,
          generation: prior.generation + 1,
        },
      };
    });
    report(logger, 'info', 'knowledge.maintenance_page', {
      task: 'rate_limits',
      scanned: result.scanned,
      deleted: result.deleted,
      hasNext: nextCursor !== null,
    });
  } catch (error) {
    report(logger, 'error', 'knowledge.maintenance_failed', {
      task: 'rate_limits',
      error: error instanceof Error ? error.name : 'unknown',
    });
  }
}
