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
  return (await Promise.all(keys.map((key) => collection.get(key)))).flatMap(
    (value) =>
      value === null
        ? []
        : [
            value,
            ...(value.nextTarget === undefined
              ? []
              : [
                  {
                    ...value.nextTarget,
                    partition: value.partition,
                    id: value.id,
                  },
                ]),
          ].map((target) => ({
            partition: target.partition,
            id: target.id,
            createdAt: target.createdAt,
            ticketId: target.ticketId,
            triggerMessageId: target.triggerMessageId,
          })),
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
      expect(callback).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          ticketId: packet.command.ticketId,
          triggerMessageId: packet.command.messageId,
          visiblePosition: 0,
          ticketNumber: expect.any(Number),
        }),
      );
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
      expect(hint).toMatchObject({
        ticketId,
        triggerMessageId: command.messageId,
        visiblePosition: 1,
        ticketNumber: expect.any(Number),
      });
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

describe('exact accepted retries preserve a newer accepted message target', () => {
  it.each(['create', 'reply'] as const)(
    'does not replace the latest hint when an older %s ACK is recovered',
    async (mode) => {
      const f = await supportAnsweringFixture();
      const packet = f.packet();
      expect((await f.ingress()(f.request(packet))).status).toBe(201);
      const {
        ticketId,
        expectedRequesterEmail: _,
        ...envelope
      } = packet.command;
      const principal = envelope.expectedAccountId;
      const api = createSupportApi({
        ...f.runtime,
        logger: f.logger,
        onCustomerMessageAccepted: f.answering().hintAccepted,
      });
      const first = {
        ...envelope,
        commandId: principal + '~' + crypto.randomUUID(),
        messageId: principal + '~' + crypto.randomUUID(),
      };
      const latest = {
        ...envelope,
        commandId: principal + '~' + crypto.randomUUID(),
        messageId: principal + '~' + crypto.randomUUID(),
      };
      const request = (command: typeof first) =>
        new Request(
          'https://pegma.dev/api/support/tickets/' + ticketId + '/replies',
          {
            method: 'POST',
            headers: f.request(packet).headers,
            body: JSON.stringify({
              command,
              body: 'Fictional latest reply intent',
            }),
          },
        );
      if (mode === 'reply')
        expect((await api(request(first)))?.status).toBe(201);
      expect((await api(request(latest)))?.status).toBe(201);
      const before = await hints(f.runtime.store);
      expect(before).toMatchObject([
        { ticketId, triggerMessageId: latest.messageId },
      ]);
      const rows = await f.runtime.store
        .collection(supportRecords)
        .list(ticketId);
      const recovered =
        mode === 'create'
          ? await f.ingress()(f.request(packet))
          : await api(request(first));
      expect(recovered?.status).toBe(201);
      const view = await recovered!.json();
      if (
        view === null ||
        typeof view !== 'object' ||
        !('messages' in view) ||
        !Array.isArray(view.messages)
      )
        throw new Error('Expected the actual recovered SDK customer view.');
      expect(view.messages.at(-1)).toMatchObject({ id: latest.messageId });
      expect(await hints(f.runtime.store)).toEqual(before);
      expect(
        await f.runtime.store.collection(supportRecords).list(ticketId),
      ).toEqual(rows);
    },
  );
});

describe('atomic bounded advisory head publication', () => {
  it('retains two concurrent colliding tickets, ignores exact duplicates and uses a defined latest-two overflow', async () => {
    const store = createMemoryStore();
    const clock = { now: () => '2026-11-12T05:00:00.000Z' };
    const first = {
      ticketId: 'fictional-collision-a',
      triggerMessageId: 'fictional-a',
    };
    const second = {
      ticketId: 'fictional-collision-b',
      triggerMessageId: 'fictional-c',
    };
    await Promise.all(
      [first, second].map((hint) =>
        enqueueSupportAssistantTargetHint(store, clock, hint),
      ),
    );
    expect((await hints(store)).map(({ ticketId }) => ticketId).sort()).toEqual(
      [first.ticketId, second.ticketId],
    );
    const head = store.collection(supportAssistantReadyTargets);
    const before = await head.getVersioned(keys[0]!);
    await enqueueSupportAssistantTargetHint(store, clock, second);
    expect(await head.getVersioned(keys[0]!)).toEqual(before);
    const third = {
      ticketId: 'fictional-collision-c',
      triggerMessageId: 'fictional-e',
    };
    await enqueueSupportAssistantTargetHint(store, clock, third);
    expect((await hints(store)).map(({ ticketId }) => ticketId)).toEqual([
      second.ticketId,
      third.ticketId,
    ]);
    await enqueueSupportAssistantTargetHint(store, clock, {
      ...second,
      triggerMessageId: 'fictional-new-c',
    });
    expect(
      (await hints(store)).map(({ ticketId, triggerMessageId }) => ({
        ticketId,
        triggerMessageId,
      })),
    ).toEqual([third, { ...second, triggerMessageId: 'fictional-new-c' }]);
  });
});

it('does not replace a newer hint when an older real receipt pauses after reading its SDK view', async () => {
  const f = await supportAnsweringFixture();
  const packet = f.packet();
  expect((await f.ingress()(f.request(packet))).status).toBe(201);
  let enter = () => {};
  let release = () => {};
  let finish = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const actualHint = f.answering().hintAccepted;
  const retry = createSupportAnsweringIngress(f.runtime, f.logger, {
    ...f.answering(),
    async hintAccepted(hint) {
      enter();
      await gate;
      try {
        await actualHint?.(hint);
      } finally {
        finish();
      }
    },
  });
  const pending = retry(f.request(packet));
  await entered;
  const { ticketId, expectedRequesterEmail: _, ...envelope } = packet.command;
  const principal = envelope.expectedAccountId;
  const command = {
    ...envelope,
    commandId: principal + '~' + crypto.randomUUID(),
    messageId: principal + '~' + crypto.randomUUID(),
  };
  const api = createSupportApi({
    ...f.runtime,
    logger: f.logger,
    onCustomerMessageAccepted: actualHint,
  });
  const response = await api(
    new Request(
      'https://pegma.dev/api/support/tickets/' + ticketId + '/replies',
      {
        method: 'POST',
        headers: f.request(packet).headers,
        body: JSON.stringify({
          command,
          body: 'Fictional concurrent latest reply',
        }),
      },
    ),
  );
  expect(response?.status).toBe(201);
  const before = await hints(f.runtime.store);
  expect(before).toMatchObject([
    { ticketId, triggerMessageId: command.messageId },
  ]);
  release();
  expect((await pending).status).toBe(201);
  await finished;
  expect(await hints(f.runtime.store)).toEqual(before);
});

it('keeps known message order against legacy/older/conflicting publication and resets only for a newer SDK ticket number', async () => {
  const store = createMemoryStore();
  const clock = { now: () => '2026-11-12T05:00:00.000Z' };
  const known = {
    ticketId: 'fictional-recreated-ticket',
    triggerMessageId: 'fictional-current-message',
    ticketNumber: 8,
    visiblePosition: 2,
  };
  await enqueueSupportAssistantTargetHint(store, clock, known);
  const collection = store.collection(supportAssistantReadyTargets);
  const before = await collection.getVersioned(keys[0]!);
  for (const stale of [
    { ticketId: known.ticketId, triggerMessageId: 'fictional-legacy-message' },
    {
      ...known,
      triggerMessageId: 'fictional-older-message',
      visiblePosition: 1,
    },
    { ...known, triggerMessageId: 'fictional-conflicting-message' },
    { ...known, ticketNumber: 7, visiblePosition: 99 },
  ]) {
    await enqueueSupportAssistantTargetHint(store, clock, stale);
    expect(await collection.getVersioned(keys[0]!)).toEqual(before);
  }
  await enqueueSupportAssistantTargetHint(store, clock, {
    ...known,
    ticketNumber: 9,
    visiblePosition: 0,
  });
  expect(await collection.get(keys[0]!)).toMatchObject({
    ticketNumber: 9,
    visiblePosition: 0,
  });
});
