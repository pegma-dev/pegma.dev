import { type Store } from '@pegma/storage-core';
import { supportAssistantReadyTargets } from './support-assistant';
import { supportRecords } from '@pegma/support-desk-application';
import { createMemoryStore } from '@pegma/storage-core';
import { describe, expect, it } from 'vitest';
import { supportAssistantFixture } from './support-assistant-fixtures';
import { enqueueSupportAssistantTargetHint } from './support-assistant';

describe('retained physical history and immutable answering deadlines', () => {
  it('prioritizes a real newly admitted turn ahead of32 resolved historical tickets', async () => {
    const f = await supportAssistantFixture(
      { store: createMemoryStore() },
      { retainedHumanTickets: 32 },
    );
    const job = (await f.rows()).find((row) => row.kind === 'assistant_turn');
    if (job?.kind !== 'assistant_turn')
      throw new Error('Missing genuine admitted SDK turn.');
    expect(Date.parse(job.turnDeadline) - Date.parse(job.createdAt)).toBe(
      300_000,
    );
    const cursor = await f.checkpoint();
    await enqueueSupportAssistantTargetHint(f.store, f.clock, {
      ticketId: job.ticketId,
      triggerMessageId: job.triggerMessageId,
    });
    f.advance(60_000);
    const prepared = await f.tick();
    expect(prepared).toMatchObject({ outcome: 'prepared', physicalRows: 0 });
    expect(f.modelCalls).toEqual([]);
    expect(f.usageReservations).toEqual([]);
    expect(f.scanned).toEqual([]);
    f.advance(60_000);
    expect(await f.tick()).toMatchObject({
      outcome: 'scanned',
      turn: 'completed',
      physicalRows: 0,
    });
    expect(f.modelCalls).toHaveLength(1);
    expect(f.usageReservations).toHaveLength(1);
    expect(
      (await f.messages()).filter((m) => m.authorKind === 'assistant'),
    ).toHaveLength(1);
    expect(Date.parse(f.clock.now())).toBeLessThan(
      Date.parse(job.turnDeadline),
    );
    expect(
      (await f.rows()).find((row) => row.kind === 'assistant_turn'),
    ).toMatchObject({ turnDeadline: job.turnDeadline, status: 'completed' });
    expect((await f.checkpoint())?.cursor).toBe(cursor?.cursor ?? null);
    // No hint/SDK object survives into this later runtime; terminal cleanup cannot pay.
    await f.tick();
    expect(f.modelCalls).toHaveLength(1);
  });
});

describe('existing capacity expiry remains a current human handoff', () => {
  it('keeps the original deadline and performs no paid call when a bounded fallback scan reaches expired real turns', async () => {
    const f = await supportAssistantFixture(
      { store: createMemoryStore() },
      { retainedHumanTickets: 32 },
    );
    const second = await f.createTicket(
      'fictional-second-expired-history-turn',
    );
    const ids = ['fictional-answer-ticket', second];
    const original = await Promise.all(
      ids.map(async (id) => {
        const row = (await f.rows(id)).find((r) => r.kind === 'assistant_turn');
        if (row?.kind !== 'assistant_turn')
          throw new Error('Expected actual SDK pending turn.');
        expect(Date.parse(row.turnDeadline) - Date.parse(row.createdAt)).toBe(
          300_000,
        );
        return { id, deadline: row.turnDeadline };
      }),
    );
    const accessValue = await f.access('fictional-answer-customer');
    let bothHuman = false;
    for (let minute = 1; minute <= 20; ++minute) {
      f.advance(60_000);
      await f.tick();
      const views = await Promise.all(
        ids.map((id) => f.support.readCustomerTicket(accessValue, id)),
      );
      if (views.every((v) => v.ticket.handling === 'human-pending')) {
        bothHuman = true;
        break;
      }
    }
    expect(bothHuman).toBe(true);
    expect(f.modelCalls).toEqual([]);
    expect(f.usageReservations).toEqual([]);
    for (const item of original) {
      const row = (await f.rows(item.id)).find(
        (r) => r.kind === 'assistant_turn',
      );
      expect(row).toMatchObject({ turnDeadline: item.deadline });
    }
    expect(
      f.scanned.every((page) => page.physicalRows <= 32 && page.pages === 1),
    ).toBe(true);
  });
});

describe('priority hints retain current SDK authority and opaque cleanup fencing', () => {
  it('does not grant a current audience after its real role is revoked', async () => {
    const f = await supportAssistantFixture({ store: createMemoryStore() });
    const job = (await f.rows()).find((row) => row.kind === 'assistant_turn');
    if (job?.kind !== 'assistant_turn') throw new Error('Missing real target.');
    await enqueueSupportAssistantTargetHint(f.store, f.clock, {
      ticketId: job.ticketId,
      triggerMessageId: job.triggerMessageId,
    });
    expect((await f.tick()).outcome).toBe('prepared');
    await f.revokeAudienceRole();
    await f.tick();
    expect(f.modelCalls).toEqual([]);
    expect(f.usageReservations).toEqual([]);
  });
  it('keeps a new accepted target when terminal cleanup races a replacement in the same slot', async () => {
    const f = await supportAssistantFixture({ store: createMemoryStore() });
    await f.untilTurn();
    const old = (await f.rows()).find((row) => row.kind === 'assistant_turn');
    if (old?.kind !== 'assistant_turn')
      throw new Error('Missing completed SDK turn.');
    await enqueueSupportAssistantTargetHint(f.store, f.clock, {
      ticketId: old.ticketId,
      triggerMessageId: old.triggerMessageId,
    });
    const parity =
      old.triggerMessageId.charCodeAt(old.triggerMessageId.length - 1) % 2;
    const messageId = 'fictional-racing-message-' + (parity === 1 ? 'a' : 'b');
    const ticketId = await f.createTicket(
      'fictional-racing-priority-ticket',
      true,
      messageId,
    );
    let raced = false;
    const store: Store = {
      collection(definition) {
        const actual = f.store.collection(definition);
        return {
          ...actual,
          async deleteIfUnchanged(key, version) {
            if (
              !raced &&
              definition.name === supportAssistantReadyTargets.name &&
              key.id === 'ready:0'
            ) {
              raced = true;
              await enqueueSupportAssistantTargetHint(f.store, f.clock, {
                ticketId,
                triggerMessageId: messageId,
              });
            }
            return actual.deleteIfUnchanged(key, version);
          },
        };
      },
    };
    expect(await f.tick({ store })).toMatchObject({ outcome: 'unavailable' });
    expect(raced).toBe(true);
    expect(
      await f.store
        .collection(supportAssistantReadyTargets)
        .get({ partition: 'support-answering', id: 'ready:0' }),
    ).toMatchObject({ nextTarget: { ticketId, triggerMessageId: messageId } });
    expect((await f.tick()).outcome).toBe('prepared');
    expect(await f.untilTurn()).toMatchObject({ turn: 'completed' });
    expect(f.modelCalls).toHaveLength(2);
    expect(
      (await f.messages(ticketId)).filter((m) => m.authorKind === 'assistant'),
    ).toHaveLength(1);
  });
});

describe('two normal turns preserve cadence even when advisory slots collide', () => {
  it('keeps the existing zero-one-one-two paid-call chronology without a cleanup-only minute', async () => {
    const f = await supportAssistantFixture({ store: createMemoryStore() });
    const first = (await f.rows()).find((row) => row.kind === 'assistant_turn');
    if (first?.kind !== 'assistant_turn')
      throw new Error('Missing actual first turn.');
    const parity =
      first.triggerMessageId.charCodeAt(first.triggerMessageId.length - 1) % 2;
    const messageId =
      'fictional-collision-message-' + (parity === 1 ? 'a' : 'b');
    const secondId = await f.createTicket(
      'fictional-normal-second-ticket',
      true,
      messageId,
    );
    await enqueueSupportAssistantTargetHint(f.store, f.clock, {
      ticketId: first.ticketId,
      triggerMessageId: first.triggerMessageId,
    });
    await enqueueSupportAssistantTargetHint(f.store, f.clock, {
      ticketId: secondId,
      triggerMessageId: messageId,
    });
    const calls = [];
    for (let minute = 0; minute < 4; ++minute) {
      f.advance(60_000);
      await f.tick();
      calls.push(f.modelCalls.length);
    }
    expect(calls).toEqual([0, 1, 1, 2]);
    for (const id of [first.ticketId, secondId])
      expect(
        (await f.messages(id)).filter((m) => m.authorKind === 'assistant'),
      ).toHaveLength(1);
  });
});

describe('acknowledged preparation resumes without another physical scan', () => {
  it('retains only the actual SDK key across a cold runtime and still completes once', async () => {
    const f = await supportAssistantFixture({ store: createMemoryStore() });
    const preparation = await f.tick();
    if (preparation.outcome !== 'prepared')
      throw new Error('Expected a genuine acknowledged SDK preparation.');
    expect((await f.checkpoint())?.preparedTarget).toEqual({
      ticketId: preparation.ticketId,
      turnId: preparation.turnId,
    });
    expect(f.scanned).toHaveLength(1);
    expect(f.modelCalls).toEqual([]);
    expect(f.usageReservations).toEqual([]);
    f.advance(
      Date.parse(preparation.nextAttemptAt) - Date.parse(f.clock.now()),
    );
    // tick reconstructs the host runtime and all SDK/application adapters.
    expect(await f.tick()).toMatchObject({ turn: 'completed' });
    expect(f.scanned).toHaveLength(1);
    expect((await f.checkpoint())?.preparedTarget).toBeUndefined();
    expect(f.modelCalls).toHaveLength(1);
    expect(f.usageReservations).toHaveLength(1);
    await f.tick();
    expect(f.modelCalls).toHaveLength(1);
  });

  it('defers advisory cursor cleanup after a current-source denial while the SDK hands off safely', async () => {
    const f = await supportAssistantFixture({ store: createMemoryStore() });
    const preparation = await f.tick();
    if (preparation.outcome !== 'prepared')
      throw new Error('Expected a genuine acknowledged SDK preparation.');
    const before = await f.checkpoint();
    f.setModel(async (_input, context) => {
      f.state.sourceCurrent = false;
      return f.answer(context);
    });
    f.advance(
      Date.parse(preparation.nextAttemptAt) - Date.parse(f.clock.now()),
    );
    expect(await f.tick()).toMatchObject({
      turn: 'finished',
      checkpointSaved: false,
    });
    const held = await f.checkpoint();
    expect(held?.generation).toBe((before?.generation ?? 0) + 1);
    expect(held?.cursor).toBe(before?.cursor);
    expect(held?.preparedTarget).toBeUndefined();
    expect(held?.notBefore).toBeDefined();
    expect(f.modelCalls).toHaveLength(1);
    expect(
      (
        await f.support.readCustomerTicket(
          await f.access('fictional-answer-customer'),
          preparation.ticketId,
        )
      ).ticket.handling,
    ).toBe('human-pending');
    expect(
      (await f.messages()).filter((m) => m.authorKind === 'assistant'),
    ).toEqual([]);
    f.advance(60_000);
    expect(await f.tick()).toMatchObject({
      turn: 'none',
      checkpointSaved: true,
    });
    expect(f.modelCalls).toHaveLength(1);
  });

  it('uses a current disabled route as an early refusal and leaves the paid result to the SDK human handoff', async () => {
    const f = await supportAssistantFixture({ store: createMemoryStore() });
    f.setModel(async (_input, context) => {
      f.state.configurationCurrent = false;
      return f.answer(context);
    });
    expect(await f.untilTurn()).toMatchObject({ outcome: 'unavailable' });
    expect(f.modelCalls).toHaveLength(1);
    expect(f.usageObservations.at(-1)?.state).toBe('known');
    expect(
      (await f.messages()).filter((m) => m.authorKind === 'assistant'),
    ).toEqual([]);
    expect(
      (
        await f.support.readCustomerTicket(
          await f.access('fictional-answer-customer'),
          'fictional-answer-ticket',
        )
      ).ticket.handling,
    ).toBe('human-pending');
    f.state.configurationCurrent = true;
    f.advance(60_000);
    await f.tick();
    expect(f.modelCalls).toHaveLength(1);
  });
});

describe('priority discovery is a bounded point lookup before current SDK authority', () => {
  it('does not enumerate extensive retained history in the target ticket', async () => {
    const f = await supportAssistantFixture({ store: createMemoryStore() });
    for (let index = 0; index < 35; ++index)
      await f.support.addNote(await f.access('fictional-support-operator'), {
        commandId: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        ticketId: 'fictional-answer-ticket',
        messageId: crypto.randomUUID(),
        body: 'Fictional retained private staff note ' + index,
      });
    expect((await f.rows()).length).toBeGreaterThan(100);
    const job = (await f.rows()).find((row) => row.kind === 'assistant_turn');
    if (job?.kind !== 'assistant_turn')
      throw new Error('Expected actual admitted turn.');
    await enqueueSupportAssistantTargetHint(f.store, f.clock, {
      ticketId: job.ticketId,
      triggerMessageId: job.triggerMessageId,
    });
    const lookups: { partition: string; id: string }[] = [];
    const store: Store = {
      collection(definition) {
        const actual = f.store.collection(definition);
        return {
          ...actual,
          async get(key) {
            if (definition.name === supportRecords.name)
              lookups.push({ ...key });
            return actual.get(key);
          },
          async list(partition) {
            if (definition.name === supportRecords.name)
              throw new Error(
                'Priority discovery must not enumerate the target partition.',
              );
            return actual.list(partition);
          },
        };
      },
    };
    f.advance(60_000);
    expect(await f.tick({ store })).toMatchObject({ outcome: 'prepared' });
    expect(lookups).toEqual([{ partition: job.ticketId, id: job.id }]);
    expect(f.scanned).toEqual([]);
    f.advance(60_000);
    expect(await f.tick({ store })).toMatchObject({ turn: 'completed' });
    expect(f.modelCalls).toHaveLength(1);
    expect(f.usageReservations).toHaveLength(1);
    expect(Date.parse(f.clock.now())).toBeLessThan(
      Date.parse(job.turnDeadline),
    );
  });
});
