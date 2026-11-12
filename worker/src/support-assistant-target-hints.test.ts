import { supportRecords } from '@pegma/support-desk-application';

import { createMemoryStore } from '@pegma/storage-core';
import { describe, expect, it, vi } from 'vitest';
import {
  enqueueSupportAssistantTargetHint,
  supportAssistantReadyTargets,
  supportAssistantCheckpoints,
} from './support-assistant';
import { supportAnsweringFixture } from './support-answering-fixtures';
import { createSupportAnsweringIngress } from './support-assistant-ingress';
import { createSupportApi } from './support-api';

const keys = [
  { partition: 'support-answering', id: 'ready:0' },
  { partition: 'support-answering', id: 'ready:1' },
];
async function hints(store: ReturnType<typeof createMemoryStore>) {
  const collection = store.collection(supportAssistantReadyTargets);
  return (await Promise.all(keys.map((key) => collection.get(key)))).filter(
    (value) => value !== null,
  );
}
describe('accepted-message advisory hints', () => {
  it('keeps at most2 body-free targets while retaining the original global cursor', async () => {
    const store = createMemoryStore();
    const clock = { now: () => '2026-11-12T05:00:00.000Z' };
    const checkpoints = store.collection(supportAssistantCheckpoints);
    const prior = {
      partition: 'support-answering',
      id: 'scan',
      cursor: 'opaque-fixture-cursor',
      generation: 4,
    };
    await checkpoints.put(prior);
    for (let index = 0; index < 16; ++index)
      await enqueueSupportAssistantTargetHint(store, clock, {
        ticketId: 'fictional-ticket-' + index,
        triggerMessageId: 'fictional-message-' + index,
      });
    const rows = await hints(store);
    expect(rows).toHaveLength(2);
    for (const row of rows)
      expect(Object.keys(row).sort()).toEqual([
        'createdAt',
        'id',
        'partition',
        'ticketId',
        'triggerMessageId',
      ]);
    expect(
      await checkpoints.get({ partition: 'support-answering', id: 'scan' }),
    ).toEqual(prior);
  });
  it.each(['throw', 'never-settle'] as const)(
    'keeps a known accepted201 after %s hint failure',
    async (mode) => {
      const f = await supportAnsweringFixture();
      const packet = f.packet();
      const callback = vi.fn(() =>
        mode === 'throw'
          ? Promise.reject(new Error('fictional hint failure'))
          : new Promise<void>(() => {}),
      );
      const ingress = createSupportAnsweringIngress(f.runtime, f.logger, {
        ...f.answering(),
        hintAccepted: callback,
      });
      expect((await ingress(f.request(packet))).status).toBe(201);
      expect(callback).toHaveBeenCalledExactlyOnceWith({
        ticketId: packet.command.ticketId,
        triggerMessageId: packet.command.messageId,
      });
      expect(f.state.calls).toBe(0);
      expect(f.state.keys).toBe(0);
    },
  );
  it('republishes the same body-free hint after exact accepted receipt recovery without mutable route readiness', async () => {
    const f = await supportAnsweringFixture();
    const packet = f.packet();
    const failed = createSupportAnsweringIngress(f.runtime, f.logger, {
      ...f.answering(),
      hintAccepted: async () => {
        throw new Error('lost hint');
      },
    });
    expect((await failed(f.request(packet))).status).toBe(201);
    expect(await hints(f.runtime.store)).toEqual([]);
    const before = await f.runtime.store
      .collection(supportRecords)
      .list(packet.command.ticketId);
    f.state.enabled = false;
    expect((await f.ingress()(f.request(packet))).status).toBe(201);
    expect(await hints(f.runtime.store)).toMatchObject([
      {
        ticketId: packet.command.ticketId,
        triggerMessageId: packet.command.messageId,
      },
    ]);
    expect(
      await f.runtime.store
        .collection(supportRecords)
        .list(packet.command.ticketId),
    ).toEqual(before);
    expect(f.state.calls).toBe(0);
  });
  it('hints an accepted ordinary V1 customer reply and its exact receipt, with no second message', async () => {
    const f = await supportAnsweringFixture();
    const packet = f.packet();
    expect((await f.ingress()(f.request(packet))).status).toBe(201);
    const { ticketId, expectedRequesterEmail: _, ...envelope } = packet.command;
    const principal = envelope.expectedAccountId;
    const command = {
      ...envelope,
      commandId: principal + '~' + crypto.randomUUID(),
      messageId: principal + '~' + crypto.randomUUID(),
    };
    const seen = vi.fn(f.answering().hintAccepted);
    const api = createSupportApi({
      ...f.runtime,
      logger: f.logger,
      onCustomerMessageAccepted: seen,
    });
    const request = () =>
      new Request(
        'https://pegma.dev/api/support/tickets/' + ticketId + '/replies',
        {
          method: 'POST',
          headers: f.request(packet).headers,
          body: JSON.stringify({ command, body: 'Fictional reply intent' }),
        },
      );
    expect((await api(request()))?.status).toBe(201);
    const before = await f.runtime.store
      .collection(supportRecords)
      .list(packet.command.ticketId);
    expect((await api(request()))?.status).toBe(201);
    expect(seen).toHaveBeenCalledTimes(2);
    for (const [hint] of seen.mock.calls)
      expect(hint).toEqual({ ticketId, triggerMessageId: command.messageId });
    expect(
      await f.runtime.store
        .collection(supportRecords)
        .list(packet.command.ticketId),
    ).toEqual(before);
    expect(
      (await hints(f.runtime.store)).some(
        (h) => h.triggerMessageId === command.messageId,
      ),
    ).toBe(true);
  });
});
