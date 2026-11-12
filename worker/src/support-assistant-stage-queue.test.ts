import { createMemoryStore } from '@pegma/storage-core';
import { describe, expect, it, vi } from 'vitest';
import { supportAssistantFixture } from './support-assistant-fixtures';
import {
  createSupportAssistantStageQueue,
  SUPPORT_ASSISTANT_STAGE_QUEUE,
  SUPPORT_ASSISTANT_WAKE_MARKER,
} from './support-assistant-stage-queue';

// Scripted broker acknowledgements; actual SDK/Store/host runtime owns all work.
describe('bounded multirow isolated stage continuation', () => {
  it('keeps the same wakeup after a real filtered32-row page, then prepares and pays once in later factories', async () => {
    const f = await supportAssistantFixture(
      { store: createMemoryStore() },
      { retainedHumanTickets: 4 },
    );
    const clock = f.clock;
    const queue = createSupportAssistantStageQueue(clock, () => f.runtime());
    const env = {
      PEGMA_SUPPORT_ASSISTANT_STAGE_TARGET: 'isolated-stage',
      PEGMA_SUPPORT_ASSISTANT_STAGE_ENABLED: 'true',
    };
    const timestamp = new Date(clock.now());
    const retries: number[] = [];
    let acks = 0;
    const message = (attempts: number) => ({
      id: 'fictional-original-wake',
      timestamp,
      attempts,
      body: SUPPORT_ASSISTANT_WAKE_MARKER,
      ack() {
        ++acks;
      },
      retry(options?: QueueRetryOptions) {
        if (!Number.isSafeInteger(options?.delaySeconds))
          throw new Error('Missing actual bounded retry delay.');
        retries.push(options!.delaySeconds!);
      },
    });
    await queue.queue(
      { queue: SUPPORT_ASSISTANT_STAGE_QUEUE, messages: [message(1)] },
      env,
    );
    expect(f.scanned[0]).toMatchObject({ physicalRows: 32, pages: 1 });
    expect(retries).toEqual([5]);
    expect(acks).toBe(0);
    expect(f.modelCalls).toEqual([]);
    expect(f.usageReservations).toEqual([]);
    for (
      let attempts = 2;
      attempts <= 8 && f.modelCalls.length === 0;
      ++attempts
    ) {
      const delay = retries.at(-1);
      if (delay === undefined)
        throw new Error('The original wake was incorrectly retired.');
      f.advance(delay * 1000);
      await queue.queue(
        { queue: SUPPORT_ASSISTANT_STAGE_QUEUE, messages: [message(attempts)] },
        env,
      );
    }
    expect(f.modelCalls).toHaveLength(1);
    expect(f.usageReservations).toHaveLength(1);
    expect(
      (await f.messages()).filter((m) => m.authorKind === 'assistant'),
    ).toHaveLength(1);
    expect(
      f.scanned.every((page) => page.physicalRows <= 32 && page.pages === 1),
    ).toBe(true);
  });
  it('acknowledges a genuinely empty committed page without another retry', async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const queue = createSupportAssistantStageQueue(
      { now: () => '2026-11-12T05:00:00.000Z' },
      () => ({
        runTick: async () => ({
          outcome: 'scanned',
          physicalRows: 0,
          candidates: 0,
          turn: 'none',
          checkpointSaved: true,
        }),
      }),
    );
    await queue.queue(
      {
        queue: SUPPORT_ASSISTANT_STAGE_QUEUE,
        messages: [
          {
            id: 'fictional-empty-wake',
            timestamp: new Date('2026-11-12T05:00:00.000Z'),
            attempts: 1,
            body: SUPPORT_ASSISTANT_WAKE_MARKER,
            ack,
            retry,
          },
        ],
      },
      {
        PEGMA_SUPPORT_ASSISTANT_STAGE_TARGET: 'isolated-stage',
        PEGMA_SUPPORT_ASSISTANT_STAGE_ENABLED: 'true',
      },
    );
    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
  });
  it.each([2, 32])(
    'retries a committed filtered%i-row page, bounded by the existing delivery policy',
    async (physicalRows) => {
      const ack = vi.fn();
      const retry = vi.fn();
      const runTick = vi.fn(async () => ({
        outcome: 'scanned' as const,
        physicalRows,
        candidates: 0,
        turn: 'none' as const,
        checkpointSaved: true,
      }));
      const clock = { now: () => '2026-11-12T05:00:00.000Z' };
      const queue = createSupportAssistantStageQueue(clock, () => ({
        runTick,
      }));
      const message = {
        id: 'fictional-boundary-wake',
        timestamp: new Date(clock.now()),
        body: SUPPORT_ASSISTANT_WAKE_MARKER,
        attempts: 1,
        ack,
        retry,
      };
      const env = {
        PEGMA_SUPPORT_ASSISTANT_STAGE_TARGET: 'isolated-stage',
        PEGMA_SUPPORT_ASSISTANT_STAGE_ENABLED: 'true',
      };
      await queue.queue(
        { queue: SUPPORT_ASSISTANT_STAGE_QUEUE, messages: [message] },
        env,
      );
      expect(retry).toHaveBeenCalledExactlyOnceWith({ delaySeconds: 5 });
      expect(ack).not.toHaveBeenCalled();
      await queue.queue(
        {
          queue: SUPPORT_ASSISTANT_STAGE_QUEUE,
          messages: [{ ...message, attempts: 8 }],
        },
        env,
      );
      expect(runTick).toHaveBeenCalledTimes(2);
      expect(ack).toHaveBeenCalledTimes(1);
      expect(retry).toHaveBeenCalledTimes(1);
    },
  );
});
