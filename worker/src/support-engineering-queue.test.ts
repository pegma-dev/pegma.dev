import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SUPPORT_ENGINEERING_QUEUE,
  consumeSupportEngineeringWake,
  seedSupportEngineeringWake,
  type SupportEngineeringQueueOptions,
} from './support-engineering-queue';

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
