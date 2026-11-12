import type { Clock, Logger } from '@pegma/spine';
import type { SupportEngineeringDriverResult } from './support-engineering-driver';

export const SUPPORT_ENGINEERING_QUEUE = 'pegma-dev-support-engineering';
export interface SupportEngineeringWake {
  readonly version: 1;
  readonly kind: 'support-engineering-wake';
}
export interface SupportEngineeringQueueOptions {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly enabled: () => boolean;
  /** Lazy platform producer; OFF never reads a binding. */
  readonly producer?: () =>
    Pick<Queue<SupportEngineeringWake>, 'send'> | undefined;
  /** Creation stays lazy until a current, bounded delivery is accepted. */
  readonly create?: () =>
    { runTick(): Promise<SupportEngineeringDriverResult> } | undefined;
}
const wake: SupportEngineeringWake = Object.freeze({
  version: 1,
  kind: 'support-engineering-wake',
});
const MAX_DELIVERIES = 8; // Cloudflare Message.attempts starts at 1, including the first delivery.
const MAX_AGE = 240_000;
const RETRY_SECONDS = 1;
function enabled(options: SupportEngineeringQueueOptions): boolean {
  try {
    return options.enabled() === true;
  } catch {
    return false;
  }
}
function diagnostic(
  options: SupportEngineeringQueueOptions,
  stage: 'seed' | 'consume' | 'ack' | 'retry' | 'envelope',
): void {
  try {
    options.logger.log('warn', 'support.engineering.queue_unavailable', {
      stage,
    });
  } catch {
    /* Preserve domain outcome. */
  }
}
function ack(message: Message, options: SupportEngineeringQueueOptions): void {
  try {
    message.ack();
  } catch {
    diagnostic(options, 'ack');
  }
}
function validBody(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return (
    Reflect.ownKeys(value).length === 2 &&
    descriptors.version?.value === 1 &&
    descriptors.kind?.value === 'support-engineering-wake'
  );
}
function currentMessage(
  message: Message,
  options: SupportEngineeringQueueOptions,
): boolean {
  const now = Date.parse(options.clock.now());
  const sent = Date.prototype.getTime.call(message.timestamp);
  return (
    Number.isFinite(now) &&
    Number.isFinite(sent) &&
    sent <= now &&
    now - sent < MAX_AGE &&
    Number.isSafeInteger(message.attempts) &&
    message.attempts >= 1 &&
    message.attempts <= MAX_DELIVERIES
  );
}
function continuation(result: SupportEngineeringDriverResult): boolean {
  return result.outcome === 'scanned'
    ? result.selected
    : result.outcome === 'checks'
      ? result.remainingTargets > 0
      : (result.outcome === 'work' || result.outcome === 'reconciliation') &&
        (result.remainingTargets > 0 ||
          (result.outcome === 'work' && result.result.outcome === 'candidate'));
}

/** Advisory send only, separate from any SDK/paid stage. A late queue failure
 * cannot rewrite an accepted domain operation; the next cron can seed again. */
export async function seedSupportEngineeringWake(
  options: SupportEngineeringQueueOptions,
): Promise<void> {
  if (!enabled(options)) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const producer = options.producer?.();
    if (producer === undefined || !enabled(options)) return;
    const sent = Promise.resolve().then(() => {
      if (!enabled(options)) return;
      return producer.send(wake, { contentType: 'json' });
    });
    await Promise.race([
      sent,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Engineering wake unavailable')),
          1_000,
        );
      }),
    ]);
  } catch {
    diagnostic(options, 'seed');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** One real driver tick per physical delivery. Queue hints never grant access,
 * extend SDK deadlines, or turn a new send into part of a known paid outcome. */
export async function consumeSupportEngineeringWake(
  batch: MessageBatch,
  options: SupportEngineeringQueueOptions,
): Promise<void> {
  if (batch.queue !== SUPPORT_ENGINEERING_QUEUE) return;
  if (batch.messages.length !== 1) {
    diagnostic(options, 'envelope');
    try {
      batch.ackAll();
    } catch {
      diagnostic(options, 'ack');
    }
    return;
  }
  const message = batch.messages[0]!;
  try {
    if (!enabled(options)) {
      ack(message, options);
      return;
    }
    if (!validBody(message.body) || !currentMessage(message, options)) {
      diagnostic(options, 'envelope');
      ack(message, options);
      return;
    }
    const runtime = options.create?.();
    if (runtime === undefined || !enabled(options)) {
      ack(message, options);
      return;
    }
    const result = await runtime.runTick();
    // No producer send after the SDK stage. Retries use the same bounded
    // platform envelope in a distinct invocation; SDK claims/usage still decide.
    if (
      enabled(options) &&
      currentMessage(message, options) &&
      message.attempts < MAX_DELIVERIES &&
      continuation(result)
    ) {
      try {
        message.retry({ delaySeconds: RETRY_SECONDS });
      } catch {
        diagnostic(options, 'retry');
        ack(message, options);
      }
      return;
    }
    ack(message, options);
  } catch {
    diagnostic(options, 'consume');
    ack(message, options);
  }
}
