import type { Clock, Logger } from '@pegma/spine';
import type { SupportEngineeringDriverResult } from './support-engineering-driver';
import type { SupportLearningDriverResult } from './support-learning-driver';
import type { SupportReleaseFollowupDriverResult } from './support-release-followup-driver';

export const SUPPORT_ENGINEERING_QUEUE = 'pegma-dev-support-engineering';
export interface SupportEngineeringWake {
  readonly version: 1;
  readonly kind: 'support-engineering-wake';
}
export interface SupportLearningWake {
  readonly version: 1;
  readonly kind: 'support-learning-wake';
}
export interface SupportReleaseFollowupWake {
  readonly version: 1;
  readonly kind: 'support-release-followup-wake';
}
interface WakeOptions<Wake, Result> {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly enabled: () => boolean;
  /** Lazy platform producer; OFF never reads a binding. */
  readonly producer?: () => Pick<Queue<Wake>, 'send'> | undefined;
  /** Creation stays lazy until a current, bounded delivery is accepted. */
  readonly create?: () => { runTick(): Promise<Result> } | undefined;
}
export interface SupportEngineeringQueueOptions extends WakeOptions<
  SupportEngineeringWake,
  SupportEngineeringDriverResult
> {}
export interface SupportLearningQueueOptions extends WakeOptions<
  SupportLearningWake,
  SupportLearningDriverResult
> {}
export interface SupportReleaseFollowupQueueOptions extends WakeOptions<
  SupportReleaseFollowupWake,
  SupportReleaseFollowupDriverResult
> {}
const wake: SupportEngineeringWake = Object.freeze({
  version: 1,
  kind: 'support-engineering-wake',
});
const learningWake: SupportLearningWake = Object.freeze({
  version: 1,
  kind: 'support-learning-wake',
});
const followupWake: SupportReleaseFollowupWake = Object.freeze({
  version: 1,
  kind: 'support-release-followup-wake',
});
type Controls = Pick<WakeOptions<never, never>, 'clock' | 'logger' | 'enabled'>;
type Event =
  | 'support.engineering.queue_unavailable'
  | 'support.learning.queue_unavailable'
  | 'support.release_followup.queue_unavailable';
const engineeringEvent: Event = 'support.engineering.queue_unavailable';
const learningEvent: Event = 'support.learning.queue_unavailable';
const followupEvent: Event = 'support.release_followup.queue_unavailable';
const MAX_DELIVERIES = 8; // Cloudflare Message.attempts starts at 1, including the first delivery.
const MAX_AGE = 240_000;
const RETRY_SECONDS = 1;
function enabled(options: Controls): boolean {
  try {
    return options.enabled() === true;
  } catch {
    return false;
  }
}
function diagnostic(
  options: Controls,
  event: Event,
  stage: 'seed' | 'consume' | 'ack' | 'retry' | 'envelope',
): void {
  try {
    options.logger.log('warn', event, {
      stage,
    });
  } catch {
    /* Preserve domain outcome. */
  }
}
function ack(message: Message, options: Controls, event: Event): void {
  try {
    message.ack();
  } catch {
    diagnostic(options, event, 'ack');
  }
}
function validBody(
  value: unknown,
  kind: SupportEngineeringWake['kind'] | SupportLearningWake['kind'] | SupportReleaseFollowupWake['kind'],
): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return (
      Reflect.ownKeys(value).length === 2 &&
      descriptors.version?.value === 1 &&
      descriptors.kind?.value === kind
    );
  } catch {
    return false;
  }
}
/** Pure routing only; the exact body is never an authority or target hint. */
export function isSupportLearningWake(
  value: unknown,
): value is SupportLearningWake {
  return validBody(value, 'support-learning-wake');
}
export function isSupportReleaseFollowupWake(value: unknown): value is SupportReleaseFollowupWake {
  return validBody(value, 'support-release-followup-wake');
}
function currentMessage(message: Message, options: Controls): boolean {
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
function continuation(
  result: SupportEngineeringDriverResult | SupportLearningDriverResult,
): boolean {
  if (result.checkpointSaved !== true) return false;
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
async function seedWake<Wake, Result>(
  options: WakeOptions<Wake, Result>,
  body: Wake,
  event: Event,
): Promise<void> {
  if (!enabled(options)) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const producer = options.producer?.();
    if (producer === undefined || !enabled(options)) return;
    const sent = Promise.resolve().then(() => {
      if (!enabled(options)) return;
      return producer.send(body, { contentType: 'json' });
    });
    await Promise.race([
      sent,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Support wake unavailable')),
          1_000,
        );
      }),
    ]);
  } catch {
    diagnostic(options, event, 'seed');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** One real driver tick per physical delivery. Queue hints never grant access,
 * extend SDK deadlines, or turn a new send into part of a known paid outcome. */
async function consumeWake<Wake, Result>(
  batch: MessageBatch,
  options: WakeOptions<Wake, Result>,
  accepts: (value: unknown) => boolean,
  continues: (value: Result) => boolean,
  event: Event,
): Promise<void> {
  if (batch.queue !== SUPPORT_ENGINEERING_QUEUE) return;
  if (batch.messages.length !== 1) {
    diagnostic(options, event, 'envelope');
    try {
      batch.ackAll();
    } catch {
      diagnostic(options, event, 'ack');
    }
    return;
  }
  const message = batch.messages[0]!;
  try {
    if (!enabled(options)) {
      ack(message, options, event);
      return;
    }
    if (!accepts(message.body) || !currentMessage(message, options)) {
      diagnostic(options, event, 'envelope');
      ack(message, options, event);
      return;
    }
    const runtime = options.create?.();
    if (runtime === undefined || !enabled(options)) {
      ack(message, options, event);
      return;
    }
    const result = await runtime.runTick();
    // No producer send after the SDK stage. Retries use the same bounded
    // platform envelope in a distinct invocation; SDK claims/usage still decide.
    if (
      enabled(options) &&
      currentMessage(message, options) &&
      message.attempts < MAX_DELIVERIES &&
      continues(result)
    ) {
      try {
        message.retry({ delaySeconds: RETRY_SECONDS });
      } catch {
        diagnostic(options, event, 'retry');
        ack(message, options, event);
      }
      return;
    }
    ack(message, options, event);
  } catch {
    diagnostic(options, event, 'consume');
    ack(message, options, event);
  }
}

export function seedSupportEngineeringWake(
  options: SupportEngineeringQueueOptions,
): Promise<void> {
  return seedWake(options, wake, engineeringEvent);
}
export function consumeSupportEngineeringWake(
  batch: MessageBatch,
  options: SupportEngineeringQueueOptions,
): Promise<void> {
  return consumeWake(
    batch,
    options,
    (value) => validBody(value, 'support-engineering-wake'),
    continuation,
    engineeringEvent,
  );
}
/** Same physical queue and retry bounds. Two enabled idle minute domains cost
 * up to 1440*2*3=8640 operations/day before retries and all other account traffic. */
export function seedSupportLearningWake(
  options: SupportLearningQueueOptions,
): Promise<void> {
  return seedWake(options, learningWake, learningEvent);
}
export function consumeSupportLearningWake(
  batch: MessageBatch,
  options: SupportLearningQueueOptions,
): Promise<void> {
  return consumeWake(
    batch,
    options,
    isSupportLearningWake,
    continuation,
    learningEvent,
  );
}

/** Reuses the registered engineering queue; no target or authority is carried. */
export function seedSupportReleaseFollowupWake(
  options: SupportReleaseFollowupQueueOptions,
): Promise<void> {
  return seedWake(options, followupWake, followupEvent);
}
export function consumeSupportReleaseFollowupWake(
  batch: MessageBatch,
  options: SupportReleaseFollowupQueueOptions,
): Promise<void> {
  return consumeWake(
    batch,
    options,
    isSupportReleaseFollowupWake,
    (result) => {
      if (!result.checkpointSaved) return false;
      if (result.outcome === 'scanned') return result.selected;
      return result.outcome === 'work' && (
        result.remainingTargets > 0 ||
        result.result.outcome === 'candidate' ||
        result.result.outcome === 'pending'
      );
    },
    followupEvent,
  );
}
