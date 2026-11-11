import { createMemoryStore } from '@pegma/storage-core';
import { describe, expect, it } from 'vitest';
import type { SupportAssistantOptions, SupportAssistantTick } from './support-assistant';
import { supportAssistantFixture } from './support-assistant-fixtures';
import { registerStagedSupportAssistantCases } from './support-assistant-staged-cases';

registerStagedSupportAssistantCases('SDK025 real MemoryStore consumer', async () => ({
  store: createMemoryStore(),
}));

describe('SDK025 host scheduling boundaries', () => {
  it('stays inert without the trusted enable callback before any runtime Store read', async () => {
    const f = await supportAssistantFixture({ store: createMemoryStore() });
    const before = f.storeCalls.length;
    expect(await f.runtime({ isEnabled: undefined }).runTick()).toEqual({
      outcome: 'disabled',
      checkpointSaved: false,
    });
    expect(f.storeCalls.slice(before)).toEqual([]);
    expect(f.scanned).toEqual([]);
    expect(f.modelCalls).toEqual([]);
    expect(f.usageReservations).toEqual([]);
  });

  it('honors the durable due hint in a fresh factory without claiming or paying early', async () => {
    const f = await supportAssistantFixture({ store: createMemoryStore() });
    let prepared: Extract<SupportAssistantTick, { readonly outcome: 'prepared' }> | undefined;
    let acknowledgedDue: string | undefined;
    const application: SupportAssistantOptions['application'] = {
      ...f.support,
      async finishAssistantTurnAttempt(access, command) {
        // The default SDK retry is allowed to be due immediately. This case
        // explicitly schedules a future retry through its real public command.
        const result = await f.support.finishAssistantTurnAttempt(
          access,
          command.disposition === 'retry' && command.accounting === 'not_called'
            ? { ...command, retryAt: new Date(Date.parse(f.clock.now()) + 1000).toISOString() }
            : command,
        );
        if (result.outcome === 'retry_scheduled') acknowledgedDue = result.nextAttemptAt;
        return result;
      },
    };
    for (let physicalTick = 0; physicalTick < 128; ++physicalTick) {
      const result = await f.tick({ application });
      if (result.outcome === 'prepared') {
        prepared = result;
        break;
      }
      expect(result).toMatchObject({ outcome: 'scanned', turn: 'none' });
    }
    if (prepared === undefined) throw new Error('Real SDK preparation was not reached.');
    expect(acknowledgedDue).toBe(prepared.nextAttemptAt);
    expect(Date.parse(prepared.nextAttemptAt)).toBeGreaterThan(Date.parse(f.clock.now()));
    const checkpoint = await f.checkpoint();
    const rows = await f.rows();
    const scans = f.scanned.length;
    expect(await f.tick()).toEqual({
      outcome: 'deferred',
      nextAttemptAt: prepared.nextAttemptAt,
      checkpointSaved: false,
    });
    expect(await f.checkpoint()).toEqual(checkpoint);
    expect(await f.rows()).toEqual(rows);
    expect(f.scanned).toHaveLength(scans);
    expect(f.modelCalls).toEqual([]);
    expect(f.usageReservations).toEqual([]);
    f.advance(Date.parse(prepared.nextAttemptAt) - Date.parse(f.clock.now()));
    expect(await f.untilTurn()).toMatchObject({ outcome: 'scanned', turn: 'completed' });
    expect(f.modelCalls).toHaveLength(1);
    expect(f.usageReservations).toHaveLength(1);
    expect((await f.messages()).filter((message) => message.authorKind === 'assistant')).toHaveLength(1);
  });
});
