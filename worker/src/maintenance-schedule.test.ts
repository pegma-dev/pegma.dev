import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MAIL_CRON, CLEANUP_CRON, cleanupLaneAt } from './maintenance-schedule';
import {
  RELEASE_RECONCILIATION_CRON,
  runReleaseReconciliation,
} from './release-reconciliation';
import { runIdentityMaintenance } from './identity-maintenance';
import { runSupportMaintenance } from './support-maintenance';
import worker from './index';

vi.mock('./identity-maintenance', () => ({ runIdentityMaintenance: vi.fn() }));
vi.mock('./support-maintenance', () => ({ runSupportMaintenance: vi.fn() }));
vi.mock('./logger', () => ({ createAppLogger: () => ({ log: vi.fn() }) }));
vi.mock('./identity-runtime', () => ({
  createProductionIdentityRuntime: () => ({ sessions: {}, identity: {} }),
}));
vi.mock('./support-desk', () => ({
  createProductionSupportRuntime: () => ({
    store: {},
    clock: {},
    limiters: [{}, {}],
    terminalRetentionMilliseconds: 1,
  }),
  createAdminMutationLimiter: () => ({}),
  createAdminLookupLimiter: () => ({}),
}));
vi.mock('./github-release-webhook', () => ({
  createProductionStore: () => ({}),
}));
vi.mock('./releases-api', () => ({ readReleasesConfig: () => ({}) }));
vi.mock('./release-reconciliation', async (original) => ({
  ...(await original<typeof import('./release-reconciliation')>()),
  runReleaseReconciliation: vi.fn(),
}));

async function scheduled(cron: string, time: number) {
  const pending: Promise<unknown>[] = [];
  worker.scheduled(
    { cron, scheduledTime: time, noRetry() {} },
    {} as Parameters<typeof worker.scheduled>[1],
    {
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
      passThroughOnException() {},
      props: {},
      exports: {},
    } as ExecutionContext,
  );
  await Promise.all(pending);
}

describe('maintenance dispatch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps the deployed cron expressions aligned with the dispatcher', () => {
    const config = readFileSync(
      new URL('../wrangler.jsonc', import.meta.url),
      'utf8',
    );
    const crons = JSON.parse(config.match(/"crons":\s*(\[[^\]]*\])/)![1]!);
    expect(crons).toEqual([
      MAIL_CRON,
      CLEANUP_CRON,
      RELEASE_RECONCILIATION_CRON,
    ]);
  });

  it('keeps mail minute-by-minute without running cleanup or releases', async () => {
    await scheduled(MAIL_CRON, Date.parse('2026-10-15T12:00:00Z'));
    expect(runIdentityMaintenance).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.anything(),
      { tasks: ['mail_send', 'mail_reconcile'] },
    );
    expect(runSupportMaintenance).not.toHaveBeenCalled();
    expect(runReleaseReconciliation).not.toHaveBeenCalled();
  });

  it('covers all 14 cleanup lanes once across a UTC day boundary', async () => {
    const lanes = [];
    const start = Date.parse('2026-10-15T23:53:00Z');
    for (let minute = 0; minute < 15; minute++) {
      const time = start + minute * 60_000;
      if (new Date(time).getUTCMinutes() === 0) continue;
      const lane = cleanupLaneAt(time);
      lanes.push(JSON.stringify(lane));
      vi.clearAllMocks();
      await scheduled(CLEANUP_CRON, time);
      const selected =
        lane.kind === 'identity'
          ? runIdentityMaintenance
          : runSupportMaintenance;
      const other =
        lane.kind === 'identity'
          ? runSupportMaintenance
          : runIdentityMaintenance;
      expect(selected).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        expect.anything(),
        {
          tasks: [lane.task],
          ...(lane.limiterIndex === undefined
            ? {}
            : { limiterIndex: lane.limiterIndex }),
        },
      );
      expect(other).not.toHaveBeenCalled();
      expect(runReleaseReconciliation).not.toHaveBeenCalled();
    }
    expect(new Set(lanes).size).toBe(14);
    for (const kind of ['identity', 'support']) {
      for (let limiterIndex = 0; limiterIndex < 4; limiterIndex++) {
        expect(lanes).toContain(
          JSON.stringify({ kind, task: 'rate_limits', limiterIndex }),
        );
      }
    }
  });

  it('runs only release reconciliation on its own cron and ignores unknown crons', async () => {
    await scheduled(
      RELEASE_RECONCILIATION_CRON,
      Date.parse('2026-10-15T12:00:00Z'),
    );
    await scheduled('unknown', Date.parse('2026-10-15T12:00:00Z'));
    expect(runReleaseReconciliation).toHaveBeenCalledTimes(1);
    expect(runIdentityMaintenance).not.toHaveBeenCalled();
    expect(runSupportMaintenance).not.toHaveBeenCalled();
  });
});
