import type { ArticleIndexStatusDto, PrivateSourcesVerifier } from '@pegma/knowledge-base-application';
import type { Clock, Logger } from '@pegma/spine';
import { defineCollection, type Store } from '@pegma/storage-core';
import {
  createKnowledgeProjectionApplication,
  knowledgeIndexAccess,
  knowledgeRetrievalCurrent,
  knowledgeRetrievalDiagnostic,
  openKnowledgeRetrievalCheckpoint,
} from './knowledge-retrieval-maintenance';

export interface KnowledgeRetrievalReadyOptions {
  readonly store: Store;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly isEnabled: () => boolean;
  readonly privateSources?: PrivateSourcesVerifier;
}
interface ReadyHint {
  readonly id: string;
  readonly articleId: string;
  readonly format: 1;
  readonly requestedAt: string;
}
const PARTITION = 'knowledge';
const hints = defineCollection<ReadyHint>({
  name: 'pegma-dev.knowledge-retrieval-ready.v1',
  key: (value) => ({ partition: PARTITION, id: value.id }),
  codec: {
    encode: (value) => ({ ...value }),
    decode(value) {
      if (
        Object.keys(value).length !== 4 ||
        typeof value.id !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.id) ||
        typeof value.articleId !== 'string' ||
        value.articleId.length < 1 ||
        value.articleId.length > 200 ||
        value.format !== 1 ||
        typeof value.requestedAt !== 'string' ||
        !Number.isFinite(Date.parse(value.requestedAt)) ||
        new Date(value.requestedAt).toISOString() !== value.requestedAt
      )
        throw new TypeError('Invalid knowledge retrieval hint.');
      return {
        id: value.id,
        articleId: value.articleId,
        format: 1,
        requestedAt: value.requestedAt,
      };
    },
  },
});
async function hintId(articleId: string): Promise<string> {
  if (
    typeof articleId !== 'string' ||
    articleId.length < 1 ||
    articleId.length > 200
  )
    throw new TypeError('Invalid knowledge article identity.');
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(articleId)),
  );
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}
function validStatus(
  result: ArticleIndexStatusDto,
  articleId: string,
): boolean {
  return (
    result.articleId === articleId &&
    ['ready', 'pending', 'blocked'].includes(result.status) &&
    typeof result.indexed === 'boolean' &&
    [result.articleGeneration, result.projectionGeneration].every(
      (value) => value === null || (Number.isSafeInteger(value) && value >= 0),
    )
  );
}

/** A lossy acceleration hint; atomic SDK jobs and full physical cycles recover loss. */
export function createKnowledgeRetrievalReady(
  options: KnowledgeRetrievalReadyOptions,
) {
  const current = () => knowledgeRetrievalCurrent(options);
  const diagnostic = (
    level: 'info' | 'warn' | 'error',
    message: string,
    fields: Readonly<Record<string, unknown>>,
  ) => knowledgeRetrievalDiagnostic(options.logger, level, message, fields);
  return Object.freeze({
    /** One body-free overwrite; the adapter's opaque version fences old workers. */
    async enqueue(articleId: string): Promise<void> {
      try {
        if (!current()) return;
        const id = await hintId(articleId);
        if (!current()) return;
        const requestedAt = options.clock.now();
        if (
          !Number.isFinite(Date.parse(requestedAt)) ||
          new Date(requestedAt).toISOString() !== requestedAt
        )
          throw new TypeError(
            'Knowledge retrieval requires a canonical clock.',
          );
        await options.store
          .collection(hints)
          .put({ id, articleId, format: 1, requestedAt });
      } catch {
        diagnostic('warn', 'knowledge.retrieval_ready.failed', {
          stage: 'enqueue',
        });
      }
    },
    /** One physical queue row and at most one attempted SDK projection transaction. */
    async runPage(): Promise<void> {
      let stage = 'configuration';
      try {
        if (!current()) return;
        stage = 'checkpoint_read';
        const checkpoint = await openKnowledgeRetrievalCheckpoint(
          options.store,
          'retrieval-ready',
        );
        if (!current()) return;
        stage = 'scan';
        const collection = options.store.collection(hints);
        const page = await collection.scan({
          limit: 1,
          ...(checkpoint.cursor === null ? {} : { cursor: checkpoint.cursor }),
        });
        if (
          !Array.isArray(page.records) ||
          page.records.length > 1 ||
          !(
            page.nextCursor === null ||
            (typeof page.nextCursor === 'string' &&
              page.nextCursor.length > 0 &&
              page.nextCursor.length <= 16_384)
          )
        )
          throw new TypeError('Invalid knowledge ready page.');
        if (!current()) return;
        let complete = false;
        const row = page.records[0];
        if (row !== undefined) {
          stage = 'identity';
          if (
            row.key.partition !== PARTITION ||
            row.key.id !== row.value.id ||
            typeof row.version !== 'string' ||
            row.version.length === 0 ||
            (await hintId(row.value.articleId)) !== row.key.id
          )
            throw new TypeError('Invalid knowledge hint identity.');
          if (!current()) return;
          stage = 'repair';
          try {
            const result = await createKnowledgeProjectionApplication(
              options.store,
              options.clock,
              options.privateSources,
            ).repairArticleIndex(knowledgeIndexAccess, {
              articleId: row.value.articleId,
              maxBatches: 1,
            });
            if (!validStatus(result, row.value.articleId))
              throw new TypeError('Invalid knowledge repair result.');
            if (!current()) return;
            if (result.status === 'ready') {
              stage = 'delete';
              complete = await collection.deleteIfUnchanged(
                row.key,
                row.version,
              );
            }
          } catch {
            // Rotate past failed work but retain its exact hint for the next cycle.
            // The scan succeeded; no projection or deletion success is inferred.
            diagnostic('error', 'knowledge.retrieval_ready.failed', { stage });
          }
        }
        if (!current()) return;
        stage = 'checkpoint_write';
        const cursorSaved = await checkpoint.advance(page.nextCursor, current);
        diagnostic('info', 'knowledge.retrieval_ready.page', {
          physicalRows: page.records.length,
          complete,
          cursorSaved,
        });
      } catch {
        diagnostic('error', 'knowledge.retrieval_ready.failed', { stage });
      }
    },
  });
}
