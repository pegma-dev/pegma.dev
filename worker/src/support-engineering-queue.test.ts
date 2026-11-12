import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SUPPORT_ENGINEERING_QUEUE,
  consumeSupportEngineeringWake,
  seedSupportEngineeringWake,
  seedSupportLearningWake,
  consumeSupportLearningWake,
  isSupportLearningWake,
  type SupportEngineeringQueueOptions,
  type SupportLearningQueueOptions,
} from './support-engineering-queue';
import { createMemoryStore } from '@pegma/storage-core';
import type { SupportLearningDriverResult } from './support-learning-driver';
import { createLearningDriverFixture } from './support-learning-driver-fixtures';

const now = '2026-11-12T12:00:00.000Z';
const body = { version: 1, kind: 'support-engineering-wake' };
function fixture() {
  const state = { enabled: true };
  const logger = { log: vi.fn() };
  const runTick = vi.fn(async () => ({
    outcome: 'scanned' as const,
    physicalRows: 1,
    selected: true,
    checkpointSaved: true as const,
  }));
  const create = vi.fn(() => ({ runTick }));
  const send = vi.fn(async () => ({
    metadata: { metrics: { backlogCount: 1, backlogBytes: 55 } },
  }));
  const producer = vi.fn(() => ({ send }));
  const options: SupportEngineeringQueueOptions = {
    clock: { now: () => now },
    logger,
    enabled: () => state.enabled,
    create,
    producer,
  };
  const message = {
    id: 'fictional-wake',
    timestamp: new Date(now),
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  };
  const batch: MessageBatch = {
    queue: SUPPORT_ENGINEERING_QUEUE,
    messages: [message],
    ackAll: vi.fn(),
    retryAll: vi.fn(),
    metadata: {} as MessageBatchMetadata,
  };
  return {
    state,
    logger,
    runTick,
    create,
    send,
    producer,
    options,
    message,
    batch,
  };
}
afterEach(() => vi.useRealTimers());
describe('bounded body-free engineering queue transport', () => {
  it.each(['checked', 'held', 'restricted', 'unknown'] as const)(
    'continues the saved Work resume after a %s checker result without a new send',
    async (outcome) => {
      const t = fixture();
      const options: SupportEngineeringQueueOptions = {
        ...t.options,
        create: () => ({
          runTick: async () => ({
            outcome: 'checks',
            result: { outcome },
            remainingTargets: 1,
            checkpointSaved: true,
          }),
        }),
      };
      await consumeSupportEngineeringWake(t.batch, options);
      expect(t.message.retry).toHaveBeenCalledExactlyOnceWith({
        delaySeconds: 1,
      });
      expect(t.message.ack).not.toHaveBeenCalled();
      expect(t.send).not.toHaveBeenCalled();
    },
  );
  it('continues a durably queued nonpaid proposal through its saved checker reference', async () => {
    const t = fixture();
    const options: SupportEngineeringQueueOptions = {
      ...t.options,
      create: () => ({
        runTick: async () => ({
          outcome: 'work',
          remainingTargets: 1,
          checkpointSaved: true,
          result: {
            outcome: 'checks_pending',
            hint: {
              kind: 'checks',
              operationId: 'a'.repeat(64),
              ticketId: 'fictional-ticket',
              sourceGeneration: 1,
              expiresAt: '2026-11-12T12:04:00.000Z',
            },
          },
        }),
      }),
    };
    await consumeSupportEngineeringWake(t.batch, options);
    expect(t.message.retry).toHaveBeenCalledExactlyOnceWith({
      delaySeconds: 1,
    });
    expect(t.send).not.toHaveBeenCalled();
  });
  it('continues to another saved target when the first real phase is still pending', async () => {
    const t = fixture();
    const options: SupportEngineeringQueueOptions = {
      ...t.options,
      create: () => ({
        runTick: async () => ({
          outcome: 'reconciliation',
          result: { outcome: 'pending', processed: 0 },
          remainingTargets: 1,
          checkpointSaved: true,
        }),
      }),
    };
    await consumeSupportEngineeringWake(t.batch, options);
    expect(t.message.retry).toHaveBeenCalledExactlyOnceWith({
      delaySeconds: 1,
    });
    expect(t.message.ack).not.toHaveBeenCalled();
    expect(t.send).not.toHaveBeenCalled();
  });
  it('keeps OFF inert before producer/runtime work and acknowledges an already delivered wake', async () => {
    const t = fixture();
    t.state.enabled = false;
    await seedSupportEngineeringWake(t.options);
    await consumeSupportEngineeringWake(t.batch, t.options);
    expect(t.producer).not.toHaveBeenCalled();
    expect(t.send).not.toHaveBeenCalled();
    expect(t.create).not.toHaveBeenCalled();
    expect(t.message.ack).toHaveBeenCalledOnce();
  });
  it('sends one exact advisory envelope and contains its transport failure', async () => {
    const t = fixture();
    await seedSupportEngineeringWake(t.options);
    expect(t.send).toHaveBeenCalledExactlyOnceWith(body, {
      contentType: 'json',
    });
    t.send.mockRejectedValueOnce(
      new Error('FICTIONAL_PRIVATE_TRANSPORT_CONTEXT'),
    );
    await seedSupportEngineeringWake(t.options);
    expect(t.logger.log).toHaveBeenCalledWith(
      'warn',
      'support.engineering.queue_unavailable',
      { stage: 'seed' },
    );
    expect(JSON.stringify(t.logger.log.mock.calls)).not.toContain(
      'FICTIONAL_PRIVATE_TRANSPORT_CONTEXT',
    );
    expect(t.create).not.toHaveBeenCalled();
  });
  it('bounds a nonsettling advisory send while retaining late rejection handling', async () => {
    const t = fixture();
    let reject = (_: Error) => {};
    t.send.mockImplementation(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    vi.useFakeTimers();
    const running = seedSupportEngineeringWake(t.options);
    await vi.advanceTimersByTimeAsync(1_000);
    await running;
    reject(new Error('FICTIONAL_LATE_QUEUE_FAILURE'));
    await Promise.resolve();
    expect(t.send).toHaveBeenCalledOnce();
    expect(t.create).not.toHaveBeenCalled();
  });
  it.each([
    'body',
    'attempt-zero',
    'attempt-nine',
    'invalid-time',
    'future',
    'expired',
  ] as const)(
    'rejects %s before constructing any SDK runtime',
    async (fault) => {
      const t = fixture();
      if (fault === 'body')
        Reflect.set(t.message, 'body', {
          ...body,
          ticketId: 'untrusted-target',
        });
      if (fault === 'attempt-zero') t.message.attempts = 0;
      if (fault === 'attempt-nine') t.message.attempts = 9;
      if (fault === 'invalid-time') t.message.timestamp = new Date(NaN);
      if (fault === 'future')
        t.message.timestamp = new Date(Date.parse(now) + 1);
      if (fault === 'expired')
        t.message.timestamp = new Date(Date.parse(now) - 240_000);
      await consumeSupportEngineeringWake(t.batch, t.options);
      expect(t.create).not.toHaveBeenCalled();
      expect(t.message.ack).toHaveBeenCalledOnce();
      expect(t.message.retry).not.toHaveBeenCalled();
    },
  );
  it('uses first-delivery attempts1 and stops after the eighth physical delivery', async () => {
    const t = fixture();
    await consumeSupportEngineeringWake(t.batch, t.options);
    expect(t.runTick).toHaveBeenCalledOnce();
    expect(t.message.retry).toHaveBeenCalledExactlyOnceWith({
      delaySeconds: 1,
    });
    t.message.attempts = 8;
    t.message.retry.mockClear();
    await consumeSupportEngineeringWake(t.batch, t.options);
    expect(t.runTick).toHaveBeenCalledTimes(2);
    expect(t.message.retry).not.toHaveBeenCalled();
    expect(t.message.ack).toHaveBeenCalledOnce();
    expect(t.send).not.toHaveBeenCalled();
  });
  it('ends a nonselected history scan after one delivery even when it returned a physical row', async () => {
    const t = fixture();
    t.runTick.mockResolvedValueOnce({
      outcome: 'scanned',
      physicalRows: 1,
      selected: false,
      checkpointSaved: true,
    });
    await consumeSupportEngineeringWake(t.batch, t.options);
    expect(t.runTick).toHaveBeenCalledOnce();
    expect(t.message.ack).toHaveBeenCalledOnce();
    expect(t.message.retry).not.toHaveBeenCalled();
  });
  it('keeps unrelated queues untouched and refuses an oversized batch', async () => {
    const t = fixture();
    await consumeSupportEngineeringWake(
      { ...t.batch, queue: 'some-other-queue' },
      t.options,
    );
    expect(t.message.ack).not.toHaveBeenCalled();
    await consumeSupportEngineeringWake(
      { ...t.batch, messages: [t.message, t.message] },
      t.options,
    );
    expect(t.batch.ackAll).toHaveBeenCalledOnce();
    expect(t.create).not.toHaveBeenCalled();
  });
  it('contains ACK/retry callback failures without sending or rerunning the completed tick', async () => {
    const t = fixture();
    t.message.retry.mockImplementation(() => {
      throw new Error('FICTIONAL_PRIVATE_RETRY');
    });
    t.message.ack.mockImplementation(() => {
      throw new Error('FICTIONAL_PRIVATE_ACK');
    });
    await consumeSupportEngineeringWake(t.batch, t.options);
    expect(t.runTick).toHaveBeenCalledOnce();
    expect(t.send).not.toHaveBeenCalled();
    expect(JSON.stringify(t.logger.log.mock.calls)).not.toContain(
      'FICTIONAL_PRIVATE',
    );
  });
});

function learningFixture() {
  const t = fixture();
  t.message.body = { version: 1, kind: 'support-learning-wake' };
  const options: SupportLearningQueueOptions = {
    ...t.options,
    producer: t.producer,
    create: t.create,
  };
  return { ...t, options };
}
describe('strict learning domain on the existing physical queue', () => {
  it('sends the exact body-free learning envelope on the same resource', async () => {
    const t = learningFixture();
    await seedSupportLearningWake(t.options);
    expect(t.send).toHaveBeenCalledExactlyOnceWith(
      { version: 1, kind: 'support-learning-wake' },
      { contentType: 'json' },
    );
    expect(t.batch.queue).toBe(SUPPORT_ENGINEERING_QUEUE);
    expect(t.create).not.toHaveBeenCalled();
  });
  it('routes only two exact own data fields without evaluating getters or accepting hidden targets', () => {
    expect(
      isSupportLearningWake({ version: 1, kind: 'support-learning-wake' }),
    ).toBe(true);
    const getter = vi.fn(() => 'support-learning-wake');
    const accessor = Object.defineProperties(
      {},
      { version: { value: 1 }, kind: { get: getter } },
    );
    for (const body of [
      null,
      [],
      {},
      { version: 2, kind: 'support-learning-wake' },
      { version: 1, kind: 'support-engineering-wake' },
      { version: 1, kind: 'support-learning-wake', ticketId: 'PRIVATE_TARGET' },
      { version: 1, kind: 'support-learning-wake', [Symbol('private')]: true },
      Object.create({ version: 1, kind: 'support-learning-wake' }),
      accessor,
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error('PRIVATE_PROXY_DETAIL');
          },
        },
      ),
    ])
      expect(isSupportLearningWake(body)).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });
  it('keeps OFF before producer, clock, runtime, Store or key work', async () => {
    const t = learningFixture();
    t.state.enabled = false;
    const now = vi.fn(() => {
      throw new Error('No OFF clock read');
    });
    const options: SupportLearningQueueOptions = {
      ...t.options,
      clock: { now },
    };
    await seedSupportLearningWake(options);
    await consumeSupportLearningWake(t.batch, options);
    expect(t.producer).not.toHaveBeenCalled();
    expect(t.create).not.toHaveBeenCalled();
    expect(t.runTick).not.toHaveBeenCalled();
    expect(t.send).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
    expect(t.message.ack).toHaveBeenCalledOnce();
  });
  it.each([
    'wrong-domain',
    'extra-body',
    'fractional-attempt',
    'attempt-nine',
    'future',
    'expired',
    'invalid-date',
  ] as const)(
    'rejects %s before lazy construction or any producer access',
    async (fault) => {
      const t = learningFixture();
      if (fault === 'wrong-domain') t.message.body = body;
      if (fault === 'extra-body')
        Reflect.set(t.message, 'body', {
          ...t.message.body,
          private: 'PRIVATE_ENVELOPE',
        });
      if (fault === 'fractional-attempt') t.message.attempts = 1.5;
      if (fault === 'attempt-nine') t.message.attempts = 9;
      if (fault === 'future')
        t.message.timestamp = new Date(Date.parse(now) + 1);
      if (fault === 'expired')
        t.message.timestamp = new Date(Date.parse(now) - 240_000);
      if (fault === 'invalid-date') t.message.timestamp = new Date(NaN);
      await consumeSupportLearningWake(t.batch, t.options);
      expect(t.create).not.toHaveBeenCalled();
      expect(t.producer).not.toHaveBeenCalled();
      expect(t.message.retry).not.toHaveBeenCalled();
      expect(t.message.ack).toHaveBeenCalledOnce();
      expect(JSON.stringify(t.logger.log.mock.calls)).not.toContain(
        'PRIVATE_ENVELOPE',
      );
    },
  );
  it('never runs the opposite domain when called with an engineering envelope', async () => {
    const t = fixture();
    const options: SupportLearningQueueOptions = {
      ...t.options,
      producer: t.producer,
      create: t.create,
    };
    await consumeSupportLearningWake(t.batch, options);
    expect(t.create).not.toHaveBeenCalled();
    expect(t.message.ack).toHaveBeenCalledOnce();
    const learning = learningFixture();
    await consumeSupportEngineeringWake(learning.batch, {
      ...learning.options,
      producer: learning.producer,
      create: learning.create,
    });
    expect(learning.create).not.toHaveBeenCalled();
    expect(learning.message.ack).toHaveBeenCalledOnce();
  });
  it.each([true, false])(
    'continues only a selected durable scan (selected=%s)',
    async (selected) => {
      const t = learningFixture();
      t.runTick.mockResolvedValueOnce({
        outcome: 'scanned',
        physicalRows: 32,
        selected,
        checkpointSaved: true,
      });
      await consumeSupportLearningWake(t.batch, t.options);
      expect(t.message.retry).toHaveBeenCalledTimes(selected ? 1 : 0);
      expect(t.message.ack).toHaveBeenCalledTimes(selected ? 0 : 1);
      expect(t.send).not.toHaveBeenCalled();
    },
  );
  it.each(['pending', 'held', 'unknown'] as const)(
    'advances another durable reference after a %s stage without resending a wake',
    async (outcome) => {
      const t = learningFixture();
      const result: SupportLearningDriverResult =
        outcome === 'unknown'
          ? {
              outcome: 'checks',
              result: { outcome: 'unknown' },
              remainingTargets: 1,
              checkpointSaved: true,
            }
          : {
              outcome: 'work',
              result:
                outcome === 'pending'
                  ? { outcome: 'pending', stage: 'delivery' }
                  : { outcome: 'held', reason: 'fictional_hold' },
              remainingTargets: 1,
              checkpointSaved: true,
            };
      const runTick = vi.fn(async () => result);
      await consumeSupportLearningWake(t.batch, {
        ...t.options,
        create: () => ({ runTick }),
      });
      expect(runTick).toHaveBeenCalledOnce();
      expect(t.message.retry).toHaveBeenCalledExactlyOnceWith({
        delaySeconds: 1,
      });
      expect(t.send).not.toHaveBeenCalled();
      expect(t.producer).not.toHaveBeenCalled();
    },
  );
  it('does not blindly retry a legacy unknown delivery when no durable continuation remains', async () => {
    const t = learningFixture();
    const options: SupportLearningQueueOptions = {
      ...t.options,
      create: () => ({
        runTick: async () => ({
          outcome: 'work',
          result: { outcome: 'pending', stage: 'delivery' },
          remainingTargets: 0,
          checkpointSaved: true,
        }),
      }),
    };
    await consumeSupportLearningWake(t.batch, options);
    expect(t.message.ack).toHaveBeenCalledOnce();
    expect(t.message.retry).not.toHaveBeenCalled();
    expect(t.send).not.toHaveBeenCalled();
  });
  it.each(['prepared', 'acknowledged'] as const)(
    'continues an exact saved Work resume after a confirmed %s delivery checkpoint',
    async (checkpoint) => {
      const t = learningFixture();
      const options: SupportLearningQueueOptions = {
        ...t.options,
        create: () => ({
          runTick: async () => ({
            outcome: 'work',
            result: { outcome: 'pending', stage: 'delivery', checkpoint },
            remainingTargets: 1,
            checkpointSaved: true,
          }),
        }),
      };
      await consumeSupportLearningWake(t.batch, options);
      expect(t.message.retry).toHaveBeenCalledExactlyOnceWith({
        delaySeconds: 1,
      });
      expect(t.send).not.toHaveBeenCalled();
    },
  );
  it('ends a known checkpoint chain when no advisory resume was acknowledged instead of blindly rescanning', async () => {
    const t = learningFixture();
    const options: SupportLearningQueueOptions = {
      ...t.options,
      create: () => ({
        runTick: async () => ({
          outcome: 'work',
          result: {
            outcome: 'pending',
            stage: 'delivery',
            checkpoint: 'acknowledged',
          },
          remainingTargets: 0,
          checkpointSaved: true,
        }),
      }),
    };
    await consumeSupportLearningWake(t.batch, options);
    expect(t.message.ack).toHaveBeenCalledOnce();
    expect(t.message.retry).not.toHaveBeenCalled();
  });
  it('does not retry unavailable work merely because an earlier hint CAS was saved', async () => {
    const t = learningFixture();
    await consumeSupportLearningWake(t.batch, {
      ...t.options,
      create: () => ({
        runTick: async () => ({
          outcome: 'unavailable',
          checkpointSaved: true,
        }),
      }),
    });
    expect(t.message.ack).toHaveBeenCalledOnce();
    expect(t.message.retry).not.toHaveBeenCalled();
  });
  it('contains learning ACK/retry/diagnostic failures with fixed fields and no paid-stage producer reads', async () => {
    const t = learningFixture();
    t.message.retry.mockImplementation(() => {
      throw new Error('PRIVATE_RETRY_CONTEXT');
    });
    t.message.ack.mockImplementation(() => {
      throw new Error('PRIVATE_ACK_CONTEXT');
    });
    t.logger.log.mockImplementation(() => {
      throw new Error('PRIVATE_LOG_CONTEXT');
    });
    const readProducer = vi.fn(() => {
      throw new Error('No post-paid producer read');
    });
    Object.defineProperty(t.options, 'producer', { get: readProducer });
    await consumeSupportLearningWake(t.batch, t.options);
    expect(t.runTick).toHaveBeenCalledOnce();
    expect(readProducer).not.toHaveBeenCalled();
    expect(t.logger.log.mock.calls).toEqual([
      ['warn', 'support.learning.queue_unavailable', { stage: 'retry' }],
      ['warn', 'support.learning.queue_unavailable', { stage: 'ack' }],
    ]);
  });
  it('honors the same8 delivery and240s envelope stop after a real tick', async () => {
    const t = learningFixture();
    t.message.attempts = 8;
    await consumeSupportLearningWake(t.batch, t.options);
    expect(t.runTick).toHaveBeenCalledOnce();
    expect(t.message.retry).not.toHaveBeenCalled();
    expect(t.message.ack).toHaveBeenCalledOnce();
    t.message.ack.mockClear();
    t.message.attempts = 1;
    let at = now;
    await consumeSupportLearningWake(t.batch, {
      ...t.options,
      clock: { now: () => at },
      create: () => ({
        runTick: async () => {
          at = '2026-11-12T12:04:00.000Z';
          return {
            outcome: 'scanned',
            physicalRows: 1,
            selected: true,
            checkpointSaved: true,
          };
        },
      }),
    });
    expect(t.message.ack).toHaveBeenCalledOnce();
    expect(t.message.retry).not.toHaveBeenCalled();
  });
  it('advances the real learning driver/checker across bounded physical deliveries to one private draft', async () => {
    const t = await createLearningDriverFixture(createMemoryStore(), {
      deferredChecks: true,
      modelAttempts: 1,
    });
    const logger = { log: vi.fn() };
    const producer = vi.fn();
    const sentAt = t.f.clock.now();
    let delivered = false;
    for (let attempts = 1; attempts <= 8; attempts++) {
      const transport = learningFixture();
      transport.message.attempts = attempts;
      transport.message.timestamp = new Date(sentAt);
      await consumeSupportLearningWake(transport.batch, {
        clock: t.f.clock,
        logger,
        enabled: () => t.faults.enabled,
        create: () => t.driver(),
        producer,
      });
      const work = await t.work();
      if (work.target !== undefined) {
        delivered = true;
        expect(transport.message.ack).toHaveBeenCalledOnce();
        break;
      }
      expect(transport.message.retry).toHaveBeenCalledExactlyOnceWith({
        delaySeconds: 1,
      });
      t.f.advance(1_000);
    }
    expect(delivered).toBe(true);
    expect(t.f.state.modelCalls).toBe(1);
    expect(t.checker?.state.calls).toBe(1);
    expect(t.faults.createCalls).toBe(1);
    expect(producer).not.toHaveBeenCalled();
    const target = (await t.work()).target;
    if (!target) throw new Error('Actual private target required');
    expect(
      (
        await t.f.knowledge.getDraft(t.f.actors.staff, {
          articleId: target.articleId,
        })
      ).state,
    ).toBe('draft');
    await expect(
      t.f.knowledge.getPublishedArticle(t.f.actors.customer, {
        articleId: target.articleId,
      }),
    ).rejects.toThrow();
  });
});
