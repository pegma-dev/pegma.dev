import { createDurableLimiter as createLegacyLimiter } from '@pegma/rate-limit';
import { createDurableLimiter } from '@pegma/rate-limit-paged';
import type { Clock, Logger } from '@pegma/spine';
import {
  createMemoryStore,
  defineCollection,
  type CollectionDefinition,
  type CollectionStore,
  type ScanOptions,
  type Store,
  type StoredRecord,
} from '@pegma/storage-core';
import { describe, expect, it, vi } from 'vitest';
import { runKnowledgeMaintenance } from './knowledge-maintenance';
import { RATE_LIMIT_CRON, rateKnowledgeLaneAt } from './maintenance-schedule';

const START = '2026-11-08T00:00:00.000Z';
const EXPIRED = '2026-11-08T00:02:00.000Z';
const KEY = { partition: 'knowledge', id: 'rate-limits' } as const;
const checkpoints = defineCollection<StoredRecord>({
  name: 'pegma-dev-maintenance',
  key: (value) => ({
    partition: String(value.partition),
    id: String(value.id),
  }),
  codec: {
    encode: (value) => ({ ...value }),
    decode: (value) => ({ ...value }),
  },
});

function barrier() {
  let release = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}

interface Hooks {
  readonly fail?: 'bookmark_read' | 'scan' | 'delete' | 'bookmark_write';
  readonly afterScan?: () => Promise<void>;
  readonly afterDecision?: (decision: number) => Promise<void>;
}

/** Delegates persistence, scans and OCC to the actual Memory Store. */
function observe(backing: Store, hooks: Hooks = {}) {
  const scans: ScanOptions[] = [];
  let decisions = 0;
  let deleted = 0;
  const store: Store = {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      const target = backing.collection(definition);
      if (definition.name === checkpoints.name)
        return {
          ...target,
          async get(key) {
            if (hooks.fail === 'bookmark_read')
              throw new Error('bookmark unavailable');
            return target.get(key);
          },
          async update(key, decide, options) {
            if (hooks.fail === 'bookmark_write')
              throw new Error('bookmark unavailable');
            return target.update(
              key,
              async (current) => {
                const result = await decide(current);
                decisions += 1;
                await hooks.afterDecision?.(decisions);
                return result;
              },
              options,
            );
          },
        };
      return {
        ...target,
        async scan(options) {
          scans.push({ ...options });
          if (hooks.fail === 'scan') throw new Error('scan unavailable');
          const page = await target.scan(options);
          await hooks.afterScan?.();
          return page;
        },
        async deleteIfUnchanged(key, version) {
          if (hooks.fail === 'delete') throw new Error('delete unavailable');
          const removed = await target.deleteIfUnchanged(key, version);
          if (removed) deleted += 1;
          return removed;
        },
        async list() {
          throw new Error('Maintenance must use a physical page.');
        },
        async listVersioned() {
          throw new Error('Maintenance must use a physical page.');
        },
      };
    },
  };
  return { store, scans, decisions: () => decisions, deleted: () => deleted };
}

function fixture() {
  const backing = createMemoryStore();
  let at = START;
  const clock: Clock = { now: () => at };
  const logger: Logger = { log: vi.fn() };
  return {
    backing,
    clock,
    logger,
    setTime: (next: string) => {
      at = next;
    },
    checkpoint: () => backing.collection(checkpoints).get(KEY),
  };
}

async function seed(store: Store, count: number) {
  const limiter = createDurableLimiter(
    {
      name: 'pegma.test.knowledge.maintenance',
      limit: 1,
      windowMs: 60_000,
    },
    store,
  );
  for (let index = 0; index < count; index++) {
    expect(await limiter.allow(`subject-${index}`, START)).toEqual({
      allowed: true,
    });
  }
  return limiter;
}

describe('knowledge maintenance', () => {
  it('resumes one physical page of 20 across cold invocations and increments completed cycles', async () => {
    const f = fixture();
    await seed(f.backing, 45);
    const observed = observe(f.backing);
    const runtime = { store: observed.store, clock: f.clock };
    await runKnowledgeMaintenance(runtime, f.logger);
    const first = await f.checkpoint();
    expect(first).toMatchObject({
      ...KEY,
      generation: 1,
      cursor: expect.any(String),
    });
    await runKnowledgeMaintenance({ ...runtime }, f.logger);
    const second = await f.checkpoint();
    expect(second).toMatchObject({ generation: 2, cursor: expect.any(String) });
    expect(second?.cursor).not.toBe(first?.cursor);
    await runKnowledgeMaintenance({ ...runtime }, f.logger);
    expect(await f.checkpoint()).toEqual({
      ...KEY,
      generation: 3,
      cursor: null,
    });
    await runKnowledgeMaintenance({ ...runtime }, f.logger);
    expect(await f.checkpoint()).toMatchObject({
      generation: 4,
      cursor: first?.cursor,
    });
    expect(observed.scans).toEqual([
      { limit: 20 },
      { limit: 20, cursor: first?.cursor },
      { limit: 20, cursor: second?.cursor },
      { limit: 20 },
    ]);
    expect(vi.mocked(f.logger.log).mock.calls).toEqual([
      [
        'info',
        'knowledge.maintenance_page',
        { task: 'rate_limits', scanned: 20, deleted: 0, hasNext: true },
      ],
      [
        'info',
        'knowledge.maintenance_page',
        { task: 'rate_limits', scanned: 20, deleted: 0, hasNext: true },
      ],
      [
        'info',
        'knowledge.maintenance_page',
        { task: 'rate_limits', scanned: 6, deleted: 0, hasNext: false },
      ],
      [
        'info',
        'knowledge.maintenance_page',
        { task: 'rate_limits', scanned: 20, deleted: 0, hasNext: true },
      ],
    ]);
  });

  it('deletes an actual expired new window while preserving active and legacy limiter counters', async () => {
    const f = fixture();
    const old = createDurableLimiter(
      { name: 'new-expired', limit: 1, windowMs: 60_000 },
      f.backing,
    );
    const active = createDurableLimiter(
      { name: 'new-active', limit: 1, windowMs: 60_000 },
      f.backing,
    );
    const legacy = createLegacyLimiter(
      { name: 'old-library', limit: 1, windowMs: 60_000 },
      f.backing,
    );
    expect(await old.allow('same', START)).toEqual({ allowed: true });
    expect(await active.allow('same', EXPIRED)).toEqual({ allowed: true });
    expect(await legacy.allow('same', START)).toEqual({ allowed: true });
    f.setTime(EXPIRED);
    const observed = observe(f.backing);
    // This runtime has no feature flag, identity or OAuth registration dependency.
    await runKnowledgeMaintenance(
      { store: observed.store, clock: f.clock },
      f.logger,
    );
    expect(observed.scans).toEqual([{ limit: 20 }]);
    expect(observed.deleted()).toBe(1);
    expect(await old.allow('same', START)).toEqual({ allowed: true });
    expect((await active.allow('same', EXPIRED)).allowed).toBe(false);
    expect((await legacy.allow('same', START)).allowed).toBe(false);
    expect(await f.checkpoint()).toEqual({
      ...KEY,
      cursor: null,
      generation: 1,
    });
    expect(f.logger.log).toHaveBeenCalledExactlyOnceWith(
      'info',
      'knowledge.maintenance_page',
      { task: 'rate_limits', scanned: 5, deleted: 1, hasNext: false },
    );
  });

  it.each(['bookmark_read', 'scan', 'bookmark_write'] as const)(
    'preserves the durable bookmark after %s failure and resumes from it',
    async (fail) => {
      const f = fixture();
      await seed(f.backing, 45);
      await runKnowledgeMaintenance(
        { store: f.backing, clock: f.clock },
        f.logger,
      );
      const before = await f.checkpoint();
      vi.mocked(f.logger.log).mockClear();
      const failed = observe(f.backing, { fail });
      await runKnowledgeMaintenance(
        { store: failed.store, clock: f.clock },
        f.logger,
      );
      expect(await f.checkpoint()).toEqual(before);
      expect(f.logger.log).toHaveBeenCalledExactlyOnceWith(
        'error',
        'knowledge.maintenance_failed',
        { task: 'rate_limits', error: 'Error' },
      );
      const resumed = observe(f.backing);
      await runKnowledgeMaintenance(
        { store: resumed.store, clock: f.clock },
        f.logger,
      );
      expect(resumed.scans).toEqual([{ limit: 20, cursor: before?.cursor }]);
      expect(await f.checkpoint()).toMatchObject({ generation: 2 });
    },
  );

  it('preserves the completed-cycle bookmark when a real expired-window delete fails', async () => {
    const f = fixture();
    await seed(f.backing, 1);
    await runKnowledgeMaintenance(
      { store: f.backing, clock: f.clock },
      f.logger,
    );
    const before = await f.checkpoint();
    vi.mocked(f.logger.log).mockClear();
    f.setTime(EXPIRED);
    const failed = observe(f.backing, { fail: 'delete' });
    await runKnowledgeMaintenance(
      { store: failed.store, clock: f.clock },
      f.logger,
    );
    expect(await f.checkpoint()).toEqual(before);
    expect(f.logger.log).toHaveBeenCalledExactlyOnceWith(
      'error',
      'knowledge.maintenance_failed',
      { task: 'rate_limits', error: 'Error' },
    );
    const resumed = observe(f.backing);
    await runKnowledgeMaintenance(
      { store: resumed.store, clock: f.clock },
      f.logger,
    );
    expect(resumed.deleted()).toBe(1);
    expect(await f.checkpoint()).toEqual({
      ...KEY,
      cursor: null,
      generation: 2,
    });
    expect(f.logger.log).toHaveBeenLastCalledWith(
      'info',
      'knowledge.maintenance_page',
      { task: 'rate_limits', scanned: 2, deleted: 1, hasNext: false },
    );
  });

  it('rechecks the generation inside actual OCC retries even when both continuations are null', async () => {
    const f = fixture();
    const entered = barrier();
    const release = barrier();
    const delayed = observe(f.backing, {
      afterDecision: async (decision) => {
        if (decision === 1) {
          entered.release();
          await release.ready;
        }
      },
    });
    const first = runKnowledgeMaintenance(
      { store: delayed.store, clock: f.clock },
      f.logger,
    );
    await entered.ready;
    await runKnowledgeMaintenance(
      { store: f.backing, clock: f.clock },
      f.logger,
    );
    expect(await f.checkpoint()).toEqual({
      ...KEY,
      cursor: null,
      generation: 1,
    });
    release.release();
    await first;
    expect(delayed.decisions()).toBe(2);
    expect(await f.checkpoint()).toEqual({
      ...KEY,
      cursor: null,
      generation: 1,
    });
    expect(delayed.scans).toHaveLength(1);
    expect(f.logger.log).toHaveBeenCalledTimes(2);
    expect(f.logger.log).toHaveBeenLastCalledWith(
      'info',
      'knowledge.maintenance_page',
      { task: 'rate_limits', scanned: 0, deleted: 0, hasNext: false },
    );
  });

  it('rejects a stale earlier cycle after newer invocations return the cursor to null', async () => {
    const f = fixture();
    await seed(f.backing, 45);
    const entered = barrier();
    const release = barrier();
    const delayed = observe(f.backing, {
      afterScan: async () => {
        entered.release();
        await release.ready;
      },
    });
    const first = runKnowledgeMaintenance(
      { store: delayed.store, clock: f.clock },
      f.logger,
    );
    await entered.ready;
    for (let page = 0; page < 3; page++) {
      await runKnowledgeMaintenance(
        { store: f.backing, clock: f.clock },
        f.logger,
      );
    }
    expect(await f.checkpoint()).toEqual({
      ...KEY,
      cursor: null,
      generation: 3,
    });
    release.release();
    await first;
    expect(await f.checkpoint()).toEqual({
      ...KEY,
      cursor: null,
      generation: 3,
    });
    expect(delayed.scans).toEqual([{ limit: 20 }]);
    expect(f.logger.log).toHaveBeenCalledTimes(4);
    expect(f.logger.log).not.toHaveBeenCalledWith(
      'error',
      expect.anything(),
      expect.anything(),
    );
  });

  it.each([
    { cursor: '', generation: 1 },
    { cursor: 'x'.repeat(8_193), generation: 1 },
    { cursor: null, generation: -1 },
    { cursor: null, generation: 1.5 },
    { cursor: null, generation: Number.MAX_SAFE_INTEGER },
  ])(
    'fails closed on an invalid or exhausted bookmark without scanning',
    async (state) => {
      const f = fixture();
      await f.backing.collection(checkpoints).put({ ...KEY, ...state });
      const observed = observe(f.backing);
      await runKnowledgeMaintenance(
        { store: observed.store, clock: f.clock },
        f.logger,
      );
      expect(observed.scans).toEqual([]);
      expect(await f.checkpoint()).toEqual({ ...KEY, ...state });
      expect(f.logger.log).toHaveBeenCalledOnce();
    },
  );

  it('honors explicit task omission and does not multiply work for duplicate selections', async () => {
    const f = fixture();
    const observed = observe(f.backing);
    await runKnowledgeMaintenance(
      { store: observed.store, clock: f.clock },
      f.logger,
      { tasks: [] },
    );
    expect(await f.checkpoint()).toBeNull();
    await runKnowledgeMaintenance(
      { store: observed.store, clock: f.clock },
      f.logger,
      {
        tasks: ['rate_limits', 'rate_limits'],
      },
    );
    expect(observed.scans).toEqual([{ limit: 20 }]);
    expect(await f.checkpoint()).toEqual({
      ...KEY,
      cursor: null,
      generation: 1,
    });
  });

  it.each(['success', 'failure'] as const)(
    'does not throw when the %s diagnostic logger fails',
    async (outcome) => {
      const f = fixture();
      const observed = observe(
        f.backing,
        outcome === 'failure' ? { fail: 'scan' } : {},
      );
      const logger: Logger = {
        log: vi.fn(() => {
          throw new Error('Synthetic logger outage.');
        }),
      };
      await expect(
        runKnowledgeMaintenance(
          { store: observed.store, clock: f.clock },
          logger,
        ),
      ).resolves.toBeUndefined();
      expect(await f.checkpoint()).toEqual(
        outcome === 'failure' ? null : { ...KEY, cursor: null, generation: 1 },
      );
      expect(logger.log).toHaveBeenCalledOnce();
    },
  );

  it('keeps expired backlog and age bounded during four hours of 672 counters per hour, then drains', async () => {
    // Synthetic capacity evidence, not a production traffic forecast or SLA.
    // Fifty browser subjects plus one subject in each of six Agent Access
    // policy shapes create 56 counters per five-minute cohort. All seven
    // persistent descriptors and live windows consume real scan positions.
    const f = fixture();
    const observed = observe(f.backing);
    const policies = [
      { name: 'browser', limit: 120, subjects: 50 },
      { name: 'authorize', limit: 60, subjects: 1 },
      { name: 'device', limit: 60, subjects: 1 },
      { name: 'token', limit: 300, subjects: 1 },
      { name: 'revoke', limit: 120, subjects: 1 },
      { name: 'agent-browser', limit: 120, subjects: 1 },
      { name: 'resource', limit: 300, subjects: 1 },
    ];
    const limiters = policies.map((policy) => ({
      subjects: policy.subjects,
      limiter: createDurableLimiter(
        {
          name: `pegma.test.capacity.${policy.name}`,
          limit: policy.limit,
          windowMs: 300_000,
        },
        f.backing,
        { clock: f.clock },
      ),
    }));
    // Read-only diagnostics over rows created by public limiter.allow calls;
    // no copied record encoder or raw counter seeding is used.
    const records = f.backing.collection(
      defineCollection<StoredRecord>({
        name: 'rate-limit-windows',
        key: (value) => ({
          partition: String(value.partition),
          id: String(value.id),
        }),
        codec: { encode: (value) => value, decode: (value) => value },
      }),
    );
    async function readRows() {
      const rows: StoredRecord[] = [];
      let cursor: string | undefined;
      do {
        const page = await records.scan({
          limit: 1_000,
          ...(cursor === undefined ? {} : { cursor }),
        });
        rows.push(...page.records.map((row) => row.value));
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      return rows;
    }
    const range = /^(\d+)-(\d+) \* \* \* \*$/.exec(RATE_LIMIT_CRON);
    expect(range).not.toBeNull();
    const hourly: { expired: number; oldestExpiredAgeMs: number }[] = [];
    const skippedMinutes: number[] = [];
    let completedTrafficCycles = 0;
    const start = Date.parse('2026-11-08T00:45:00.000Z');
    // Four continuing hours cross the real 58/59 gaps, followed by two hours
    // at the same cadence after arrivals stop. A one-shot eventual drain would
    // not expose a service rate below the continuing counter creation rate.
    for (let minute = 0; minute < 360; minute++) {
      const at = new Date(start + minute * 60_000).toISOString();
      f.setTime(at);
      if (minute < 240 && minute % 5 === 0) {
        for (const { limiter, subjects } of limiters) {
          for (let ip = 1; ip <= subjects; ip++) {
            expect(await limiter.allow(`192.0.2.${ip}`)).toEqual({
              allowed: true,
            });
          }
        }
      }
      const before = observed.scans.length;
      const utcMinute = new Date(at).getUTCMinutes();
      const cronEligible =
        utcMinute >= Number(range![1]) && utcMinute <= Number(range![2]);
      const eligible =
        cronEligible && rateKnowledgeLaneAt(Date.parse(at)) === 'rate_limits';
      if (eligible) {
        // Reconstruct invocation state; only the actual persisted bookmark
        // carries continuation across these calls.
        await runKnowledgeMaintenance(
          { store: observed.store, clock: f.clock },
          f.logger,
        );
        const checkpoint = await f.checkpoint();
        expect(checkpoint?.generation).toBe(observed.scans.length);
        if (minute < 240 && checkpoint?.cursor === null)
          completedTrafficCycles += 1;
      } else if (!cronEligible) skippedMinutes.push(utcMinute);
      expect(observed.scans.length - before).toBe(eligible ? 1 : 0);
      if (minute < 240 && minute % 60 === 59) {
        // At this cohort phase all but the newest window have also passed
        // the published helper's one-minute clock-skew grace.
        const expired = Math.floor(minute / 5) * 56 - observed.deleted();
        const now = Date.parse(at);
        const expiredRows = (await readRows()).filter(
          (row) =>
            row.kind === 'window' &&
            typeof row.windowStartMs === 'number' &&
            typeof row.windowMs === 'number' &&
            row.windowStartMs + row.windowMs + 60_000 <= now,
        );
        expect(expiredRows).toHaveLength(expired);
        expect(expired).toBeGreaterThanOrEqual(0);
        hourly.push({
          expired,
          oldestExpiredAgeMs: Math.max(
            0,
            ...expiredRows.map(
              (row) =>
                now - Number(row.windowStartMs) - Number(row.windowMs) - 60_000,
            ),
          ),
        });
      }
    }
    expect(hourly).toHaveLength(4);
    // Compare the same workload phase after warmup, allowing one discrete
    // arrival cohort of scan/cursor oscillation, not another two-hour backlog.
    // The old 580-row/h ceiling falls at least 184 counters behind 672/h over
    // these two continuing hours, even before retained/live-row overhead.
    expect(hourly[3]!.expired).toBeLessThanOrEqual(hourly[1]!.expired + 56);
    expect(hourly[3]!.oldestExpiredAgeMs).toBeLessThanOrEqual(
      hourly[1]!.oldestExpiredAgeMs + 300_000,
    );
    expect(completedTrafficCycles).toBeGreaterThan(0);
    expect(skippedMinutes).toEqual(
      Array.from({ length: 6 }, () => [58, 59]).flat(),
    );
    expect(observed.deleted()).toBe(48 * 56);
    const remaining = await readRows();
    expect(remaining).toHaveLength(7);
    expect(remaining.every((row) => row.kind === 'policy')).toBe(true);
    expect(observed.scans).toHaveLength(6 * 39);
    expect(observed.scans.every((page) => page.limit === 20)).toBe(true);
    expect(f.logger.log).toHaveBeenCalledTimes(6 * 39);
    expect(f.logger.log).toHaveBeenLastCalledWith(
      'info',
      'knowledge.maintenance_page',
      { task: 'rate_limits', scanned: 7, deleted: 0, hasNext: false },
    );
    expect(f.logger.log).not.toHaveBeenCalledWith(
      'error',
      expect.anything(),
      expect.anything(),
    );
  });
});
