import type { Clock } from '@pegma/spine';
import type { SupportAssistantTick, createSupportAssistantRuntime } from './support-assistant';

export interface SupportAssistantStageEnvironment {
  readonly PEGMA_SUPPORT_ASSISTANT_STAGE_TARGET?: string;
  readonly PEGMA_SUPPORT_ASSISTANT_STAGE_ENABLED?: string;
}

function supportAssistantStageEnabled(env: SupportAssistantStageEnvironment): boolean {
  return (
    env.PEGMA_SUPPORT_ASSISTANT_STAGE_TARGET === 'isolated-stage' &&
    env.PEGMA_SUPPORT_ASSISTANT_STAGE_ENABLED === 'true'
  );
}

export const SUPPORT_ASSISTANT_STAGE_QUEUE = 'pegma-support-assistant-stage-wakeup';
export const SUPPORT_ASSISTANT_WAKE_MARKER = 'wake-v1';
export const SUPPORT_ASSISTANT_WAKE_DELIVERIES = 8;
export const SUPPORT_ASSISTANT_WAKE_AGE_MILLISECONDS = 15 * 60_000;
const SCAN_RETRY_SECONDS = 5;
const MAX_PREPARED_DELAY_SECONDS = 60;

type StageRuntime = Pick<ReturnType<typeof createSupportAssistantRuntime>, 'runTick'>;

function retryDelay(result: SupportAssistantTick, now: number): number | null {
  if (result.outcome === 'prepared') {
    const due = Date.parse(result.nextAttemptAt);
    const seconds = Math.max(1, Math.ceil((due - now) / 1000));
    return Number.isSafeInteger(seconds) && seconds <= MAX_PREPARED_DELAY_SECONDS ? seconds : null;
  }
  // Let one opaque message advance a bounded number of physical scan pages.
  // Pending/ambiguous work deliberately stops for a manual stage redrive.
  return result.outcome === 'scanned' &&
    result.turn === 'none' &&
    result.physicalRows === 1 &&
    result.checkpointSaved
    ? SCAN_RETRY_SECONDS
    : null;
}

/** Queue-only stage. The callback composes the verified isolated runtime. */
export function createSupportAssistantStageQueue<
  Environment extends SupportAssistantStageEnvironment,
>(
  clock: Clock,
  buildRuntime: (
    env: Environment,
    isEnabled: () => boolean,
  ) => StageRuntime | null | Promise<StageRuntime | null>,
) {
  return Object.freeze({
    async queue(batch: Pick<MessageBatch, 'queue' | 'messages'>, env: Environment): Promise<void> {
      if (batch.queue !== SUPPORT_ASSISTANT_STAGE_QUEUE || batch.messages.length > 1)
        throw new Error('Unexpected isolated stage queue delivery.');
      const message = batch.messages[0];
      if (message === undefined) return;
      const isEnabled = () => supportAssistantStageEnabled(env);
      const sentAt = message.timestamp.getTime();
      const attempts = message.attempts;
      const expiresAt = sentAt + SUPPORT_ASSISTANT_WAKE_AGE_MILLISECONDS;
      const now = () => Date.parse(clock.now());
      const admittedAt = now();
      if (
        !isEnabled() ||
        message.body !== SUPPORT_ASSISTANT_WAKE_MARKER ||
        !Number.isSafeInteger(attempts) ||
        attempts < 1 ||
        attempts > SUPPORT_ASSISTANT_WAKE_DELIVERIES ||
        !(sentAt <= admittedAt && admittedAt < expiresAt)
      ) {
        message.ack();
        return;
      }

      let result: SupportAssistantTick | null;
      try {
        const runtime = await buildRuntime(env, isEnabled);
        result = runtime === null || !isEnabled() ? null : await runtime.runTick();
      } catch {
        // No successful return or explicit ACK after an interrupted tick.
        // The broker may redeliver this same message within its retry policy.
        throw new Error('Isolated stage answering wakeup failed.');
      }

      const at = now();
      const delay = result === null ? null : retryDelay(result, at);
      if (
        isEnabled() &&
        attempts < SUPPORT_ASSISTANT_WAKE_DELIVERIES &&
        delay !== null &&
        sentAt <= at &&
        at + delay * 1000 < expiresAt
      ) {
        // The delay carries no target identity or payload. The next invocation
        // must rediscover the actual current SDK job in the isolated Store.
        message.retry({ delaySeconds: delay });
        return;
      }
      message.ack();
    },
  });
}
