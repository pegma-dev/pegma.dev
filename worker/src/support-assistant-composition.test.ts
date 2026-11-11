import { describe, expect, it } from 'vitest';
import {
  completeAnsweringComposition,
  supportAnsweringFixture,
} from './support-answering-fixtures';
import { resolveAccess } from '@pegma/authorization-core';
import { supportPermissions } from '@pegma/support-desk-application';
import type { SupportAssistantTick } from './support-assistant';

describe('normal shared public answering composition', () => {
  it('prepares and completes in separate fresh factories using real host-confirmed KB evidence and one locked provider call', async () => {
    const f = await supportAnsweringFixture();
    const { packet, wires } = await completeAnsweringComposition(f);
    const results: SupportAssistantTick[] = [];
    for (let tick = 0; tick < 128; ++tick) {
      const result = await f.answering().runTick();
      results.push(result);
      if (result.outcome === 'prepared' || result.outcome === 'deferred') {
        expect(f.state.calls).toBe(0);
        f.advance(
          Math.max(0, Date.parse(result.nextAttemptAt) - Date.parse(f.runtime.clock.now())),
        );
      }
      if (result.outcome === 'scanned' && result.turn === 'completed') break;
      expect(result.outcome).not.toBe('unavailable');
    }
    expect(
      results.some((result) => result.outcome === 'prepared'),
      JSON.stringify(results),
    ).toBe(true);
    expect(results.at(-1)).toMatchObject({ outcome: 'scanned', turn: 'completed' });
    expect(f.state.calls).toBe(1);
    expect(f.state.keys).toBe(1);
    const view = await f.runtime.application.readCustomerTicket(
      resolveAccess(
        { principalId: f.human.principals.owner },
        { version: 'fixture', defaults: [supportPermissions.readOwn] },
      ),
      packet.command.ticketId,
    );
    expect(view.messages.filter((message) => message.authorKind === 'assistant')).toHaveLength(1);
    expect(JSON.parse(wires[0]!).provider).toEqual({
      only: ['fictional/region-one'],
      allow_fallbacks: false,
      data_collection: 'deny',
      zdr: true,
      require_parameters: true,
    });
    expect(wires[0]).not.toContain('fictional-credential');
  });
});
