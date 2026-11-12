import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStore } from '@pegma/storage-core';
import { runSupportAssistantTimer } from './support-assistant-timer';
import { assistantGate, supportAssistantFixture } from './support-assistant-fixtures';

afterEach(() => vi.useRealTimers());
describe('one public answering timer deadline', () => {
  it('keeps OFF inert before qualification and creation', async () => {
    const load = vi.fn(async () => undefined);
    const create = vi.fn(() => undefined);
    expect(
      await runSupportAssistantTimer({
        isEnabled: () => false,
        load,
        create,
        logger: { log() {} },
      }),
    ).toEqual({ outcome: 'disabled', checkpointSaved: false });
    expect(load).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
  it('reports finite qualification failure without raw exceptions', async () => {
    const lines: unknown[] = [];
    const result = await runSupportAssistantTimer({
      isEnabled: () => true,
      load: async () => {
        throw new Error('FICTIONAL_PRIVATE_CREDENTIAL_CONTEXT');
      },
      create: () => undefined,
      logger: {
        log: (...args) => {
          lines.push(args);
        },
      },
    });
    expect(result).toEqual({ outcome: 'unavailable', checkpointSaved: false });
    expect(JSON.stringify(lines)).toContain('qualification');
    expect(JSON.stringify(lines)).not.toContain('FICTIONAL_PRIVATE_CREDENTIAL_CONTEXT');
  });
  it('bounds nonsettling qualification and prevents its late result from creating a worker', async () => {
    const f = await supportAssistantFixture({ store: createMemoryStore() });
    const entered = assistantGate();
    const release = assistantGate();
    const create = vi.fn(() => f.runtime());
    let signal: AbortSignal | undefined;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const running = runSupportAssistantTimer({
      isEnabled: () => true,
      logger: { log() {} },
      create,
      async load(current) {
        signal = current;
        entered.release();
        await release.ready;
        return { enabled: () => true };
      },
    });
    await entered.ready;
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await running).toEqual({ outcome: 'unavailable', checkpointSaved: false });
    expect(signal?.aborted).toBe(true);
    release.release();
    await vi.advanceTimersByTimeAsync(1);
    expect(create).not.toHaveBeenCalled();
    expect(f.modelCalls).toEqual([]);
  });
  it('passes only remaining qualification time into the actual runtime', async () => {
    const f = await supportAssistantFixture({ store: createMemoryStore() });
    const entered = assistantGate();
    const release = assistantGate();
    const actual = f.runtime({
      configuration: {
        async resolve() {
          entered.release();
          await release.ready;
          return { outcome: 'disabled' };
        },
      },
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const running = runSupportAssistantTimer({
      isEnabled: () => true,
      logger: { log() {} },
      async load() {
        await new Promise((resolve) => setTimeout(resolve, 20_000));
        return { enabled: () => true };
      },
      create: () => actual,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await entered.ready;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await running).toEqual({ outcome: 'unavailable', checkpointSaved: false });
    release.release();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.modelCalls).toEqual([]);
    expect(f.scanned).toEqual([]);
  });
  it('bounds a genuine SDK scan handoff to four seconds before any claim', async () => {
    const f = await supportAssistantFixture({ store: createMemoryStore() });
    const entered = assistantGate();
    const release = assistantGate();
    const application = {
      ...f.support,
      async scanAssistantTurnCandidates(
        ...args: Parameters<typeof f.support.scanAssistantTurnCandidates>
      ) {
        const result = await f.support.scanAssistantTurnCandidates(...args);
        entered.release();
        await release.ready;
        return result;
      },
    };
    const before = await f.checkpoint();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const running = f.runtime({ application }).runTick();
    await entered.ready;
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await running).toEqual({ outcome: 'unavailable', checkpointSaved: false });
    release.release();
    await vi.advanceTimersByTimeAsync(1);
    expect(await f.checkpoint()).toEqual(before);
    expect(f.modelCalls).toEqual([]);
    expect((await f.rows()).find((row) => row.kind === 'assistant_turn')).toMatchObject({
      status: 'pending',
      attempt: 0,
    });
  });
  it.each(['rows', 'bytes'] as const)(
    'refuses an invalid scan %s bound before any real claim',
    async (fault) => {
      const f = await supportAssistantFixture({ store: createMemoryStore() });
      const application = {
        ...f.support,
        async scanAssistantTurnCandidates(
          ...args: Parameters<typeof f.support.scanAssistantTurnCandidates>
        ) {
          const page = await f.support.scanAssistantTurnCandidates(...args);
          return fault === 'rows'
            ? { ...page, physicalRows: 33 }
            : { ...page, unexpected: 'x'.repeat(98_304) };
        },
      };
      const before = await f.checkpoint();
      expect(await f.runtime({ application }).runTick()).toEqual({
        outcome: 'unavailable',
        checkpointSaved: false,
      });
      expect(await f.checkpoint()).toEqual(before);
      expect(f.modelCalls).toEqual([]);
      expect((await f.rows()).find((row) => row.kind === 'assistant_turn')).toMatchObject({
        status: 'pending',
        attempt: 0,
      });
    },
  );
});
