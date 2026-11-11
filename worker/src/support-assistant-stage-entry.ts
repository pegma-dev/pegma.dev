import { createCloudflareD1Store } from '@pegma/storage-cloudflare-d1';
import { systemClock } from '@pegma/spine';
import { createSupportAssistantStageDatabase } from './support-assistant-stage-budget';
import {
  createSupportAssistantStageQueue,
  type SupportAssistantStageEnvironment,
} from './support-assistant-stage-queue';
import {
  createSupportAssistantStageRuntime,
  readSupportAssistantStageScenario,
  stageScenarioCurrent,
} from './support-assistant-stage-scenario';

export interface SupportAssistantIsolatedStageEnvironment extends SupportAssistantStageEnvironment {
  readonly ASSISTANT_STAGE_DB: D1Database;
  readonly PEGMA_SUPPORT_ASSISTANT_STAGE_SCENARIO_JSON?: string;
}

/** Coarse diagnostics cannot change a durable result or its queue disposition. */
function observe(fields: Record<string, unknown>) {
  try {
    console.info('pegma.synthetic-answer-stage', fields);
  } catch {
    /* Best effort. */
  }
}

export default {
  async queue(batch: MessageBatch, env: SupportAssistantIsolatedStageEnvironment) {
    // A closure per physical delivery retains the cap through awaited work.
    let measured: ReturnType<typeof createSupportAssistantStageDatabase> | undefined;
    const activity = { modelCalls: 0, reservationCalls: 0, reconciliationCalls: 0 };
    const started = performance.now();
    let outcome = 'none';
    let disposition = 'none';
    let retrySeconds: number | null = null;
    let threw = false;
    const worker = createSupportAssistantStageQueue<SupportAssistantIsolatedStageEnvironment>(
      systemClock,
      (currentEnv, isEnabled) => {
        let scenario;
        try {
          const json = currentEnv.PEGMA_SUPPORT_ASSISTANT_STAGE_SCENARIO_JSON;
          if (typeof json !== 'string' || json.length > 1024) return null;
          scenario = readSupportAssistantStageScenario(JSON.parse(json));
        } catch {
          return null;
        }
        if (!stageScenarioCurrent(scenario, systemClock)) return null;
        measured = createSupportAssistantStageDatabase(currentEnv.ASSISTANT_STAGE_DB);
        const runtime = createSupportAssistantStageRuntime({
          store: createCloudflareD1Store({
            database: measured.database,
            createSchemaIfMissing: false,
            readBatchSize: 512,
          }),
          clock: systemClock,
          scenario,
          isEnabled,
          activity,
        });
        return {
          async runTick() {
            const result = await runtime.runTick();
            outcome = result.outcome;
            return result;
          },
        };
      },
    );
    try {
      if (batch.messages.length > 1) throw new Error('Unexpected isolated stage queue delivery.');
      const messages: Message[] = batch.messages.map((message) => ({
        id: message.id,
        timestamp: message.timestamp,
        attempts: message.attempts,
        body: message.body,
        ack() {
          message.ack();
          disposition = 'ack';
        },
        retry(options) {
          message.retry(options);
          disposition = 'retry';
          retrySeconds = options?.delaySeconds ?? null;
        },
      }));
      await worker.queue({ queue: batch.queue, messages }, env);
    } catch (error) {
      threw = true;
      throw error;
    } finally {
      observe({
        schemaVersion: 1,
        outcome,
        disposition,
        retrySeconds,
        threw,
        ...activity,
        ...(measured?.snapshot() ?? {
          physicalQueries: 0,
          statements: 0,
          batches: 0,
          maximumBatchStatements: 0,
          maximumParameters: 0,
          blockedQueries: 0,
          blockedParameters: 0,
        }),
        elapsedMilliseconds: performance.now() - started,
      });
    }
  },
} satisfies ExportedHandler<SupportAssistantIsolatedStageEnvironment>;
