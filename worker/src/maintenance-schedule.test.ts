import { readFileSync } from 'node:fs';
import { createCloudflareD1Store } from '@pegma/storage-cloudflare-d1';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  MAIL_CRON,
  MAIL_RECONCILE_CRON,
  CLEANUP_CRON,
  RATE_LIMIT_CRON,
  cleanupLaneAt,
  rateKnowledgeLaneAt,
} from './maintenance-schedule';
import {
  RELEASE_RECONCILIATION_CRON,
  runReleaseReconciliation,
} from './release-reconciliation';
import { runIdentityMaintenance } from './identity-maintenance';
import { runKnowledgeMaintenance } from './knowledge-maintenance';
import { createKnowledgeRetrievalMaintenance } from './knowledge-retrieval-maintenance';
import { createKnowledgeRetrievalReady } from './knowledge-retrieval-ready';
import { runSupportMaintenance } from './support-maintenance';
import worker from './index';

vi.mock('./identity-maintenance', () => ({ runIdentityMaintenance: vi.fn() }));
vi.mock('./knowledge-maintenance', () => ({
  runKnowledgeMaintenance: vi.fn(),
}));
vi.mock('./knowledge-retrieval-maintenance', () => ({
  createKnowledgeRetrievalMaintenance: vi.fn(() => ({
    runPage: vi.fn(async () => {}),
  })),
}));
vi.mock('./knowledge-retrieval-ready', () => ({
  createKnowledgeRetrievalReady: vi.fn(() => ({
    runPage: vi.fn(async () => {}),
    enqueue: vi.fn(async () => {}),
  })),
}));
vi.mock('@pegma/storage-cloudflare-d1', () => ({
  createCloudflareD1Store: vi.fn(() => ({})),
}));
vi.mock('./support-maintenance', () => ({ runSupportMaintenance: vi.fn() }));
vi.mock('./logger', () => ({ createAppLogger: () => ({ log: vi.fn() }) }));
vi.mock('./identity-runtime', () => ({
  createProductionIdentityRuntime: () => ({ sessions: {}, identity: {} }),
}));
vi.mock('./support-desk', () => ({
  createProductionSupportMaintenanceRuntime: () => ({
    store: {},
    clock: {},
    limiters: [{}, {}, {}, {}],
    terminalRetentionMilliseconds: 1,
  }),
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

async function scheduled(
  cron: string,
  time: number,
  environment: Record<string, string> = {},
) {
  const pending: Promise<unknown>[] = [];
  // This tests routing with mocked runtime builders. Storage is deliberately
  // unavailable; a routing regression must not silently reach a fake database.
  const unavailable = (): never => {
    throw new Error('Scheduler routing fixture cannot access D1.');
  };
  const identityDatabase: D1Database = {
    prepare: unavailable,
    batch: unavailable,
    exec: unavailable,
    withSession: unavailable,
    dump: unavailable,
  };
  const routingEnvironment = {
    ...environment,
    IDENTITY_DB: identityDatabase,
  };
  worker.scheduled(
    { cron, scheduledTime: time, noRetry() {} },
    routingEnvironment as Parameters<typeof worker.scheduled>[1],
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
  return pending.length;
}

function knowledgeCleanupTime(): number {
  const start = Date.parse('2026-10-15T00:00:00Z');
  for (let minute = 0; minute < 60; minute++) {
    const time = start + minute * 60_000;
    if (
      new Date(time).getUTCMinutes() !== 59 &&
      cleanupLaneAt(time).kind === 'knowledge'
    )
      return time;
  }
  throw new Error('Expected one knowledge cleanup lane.');
}

describe('maintenance dispatch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns a lane at minute zero and for timestamps around the Unix epoch', () => {
    for (const time of [
      -60_000,
      0,
      60_000,
      Date.parse('2026-10-15T12:00:00Z'),
    ]) {
      expect(cleanupLaneAt(time)).toEqual(
        expect.objectContaining({
          kind: expect.stringMatching(/^(identity|support|knowledge)$/),
        }),
      );
    }
    expect(cleanupLaneAt(Date.parse('2026-10-15T11:59:00Z'))).toEqual(
      cleanupLaneAt(Date.parse('2026-10-15T11:58:00Z')),
    );
  });

  it('keeps the deployed cron expressions aligned with the dispatcher', () => {
    const config = readFileSync(
      new URL('../wrangler.jsonc', import.meta.url),
      'utf8',
    );
    const crons = JSON.parse(
      config.match(/"crons":\s*(\[[^\]]*\])/)![1]!.replace(/,\s*\]$/u, ']'),
    );
    expect(crons).toEqual([
      MAIL_CRON,
      MAIL_RECONCILE_CRON,
      CLEANUP_CRON,
      RATE_LIMIT_CRON,
      RELEASE_RECONCILIATION_CRON,
    ]);
    expect(new Set(crons).size).toBe(5);
  });

  it('advances each cleanup lane exactly once per eligible tick in the configured cron', () => {
    // Read eligibility from the actual cron, rather than hard-coding the
    // skipped minute independently of the configuration under test.
    const match = /^(\d+)-(\d+) \* \* \* \*$/.exec(CLEANUP_CRON);
    expect(match).not.toBeNull();
    const first = Number(match![1]);
    const last = Number(match![2]);
    const start = Date.parse('2026-10-15T00:00:00Z');
    const observed: string[] = [];
    for (let minute = 0; minute < 2 * 24 * 60; minute++) {
      const time = start + minute * 60_000;
      const utcMinute = new Date(time).getUTCMinutes();
      if (utcMinute >= first && utcMinute <= last) {
        observed.push(JSON.stringify(cleanupLaneAt(time)));
      }
    }
    const cycle = observed.slice(0, 15);
    expect(new Set(cycle).size).toBe(15);
    for (let index = 0; index < observed.length; index++) {
      expect(observed[index]).toBe(cycle[index % cycle.length]);
    }
  });

  it('keeps mail minute-by-minute without running cleanup or releases', async () => {
    await scheduled(MAIL_CRON, Date.parse('2026-10-15T12:00:00Z'));
    expect(runIdentityMaintenance).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.anything(),
      { tasks: ['mail_send'] },
    );
    expect(runSupportMaintenance).not.toHaveBeenCalled();
    expect(runKnowledgeMaintenance).not.toHaveBeenCalled();
    expect(createKnowledgeRetrievalMaintenance).not.toHaveBeenCalled();
    expect(runReleaseReconciliation).not.toHaveBeenCalled();
  });

  it('reconciles mail in its own invocation every minute', async () => {
    await scheduled(MAIL_RECONCILE_CRON, Date.parse('2026-10-15T12:01:00Z'));
    expect(runIdentityMaintenance).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.anything(),
      { tasks: ['mail_reconcile'] },
    );
    expect(runSupportMaintenance).not.toHaveBeenCalled();
    expect(runKnowledgeMaintenance).not.toHaveBeenCalled();
    expect(createKnowledgeRetrievalMaintenance).not.toHaveBeenCalled();
    expect(runReleaseReconciliation).not.toHaveBeenCalled();
  });

  it('preserves all 15 cleanup lanes across a UTC day boundary without sharing the global rate job', async () => {
    const lanes = [];
    const start = Date.parse('2026-10-15T23:53:00Z');
    for (let minute = 0; minute < 16; minute++) {
      const time = start + minute * 60_000;
      if (new Date(time).getUTCMinutes() === 59) continue;
      const lane = cleanupLaneAt(time);
      lanes.push(JSON.stringify(lane));
      vi.clearAllMocks();
      await scheduled(CLEANUP_CRON, time);
      expect(runKnowledgeMaintenance).not.toHaveBeenCalled();
      const maintenance = {
        identity: runIdentityMaintenance,
        support: runSupportMaintenance,
      };
      if (lane.kind !== 'knowledge') {
        expect(maintenance[lane.kind]).toHaveBeenCalledExactlyOnceWith(
          expect.anything(),
          expect.anything(),
          {
            tasks: [lane.task],
            ...(lane.limiterIndex === undefined
              ? {}
              : { limiterIndex: lane.limiterIndex }),
          },
        );
      }
      for (const [kind, other] of Object.entries(maintenance)) {
        if (kind !== lane.kind) expect(other).not.toHaveBeenCalled();
      }
      expect(runReleaseReconciliation).not.toHaveBeenCalled();
    }
    expect(new Set(lanes).size).toBe(15);
    expect(
      lanes.filter(
        (lane) =>
          lane ===
          JSON.stringify({
            kind: 'knowledge',
            task: 'rate_limits',
          }),
      ),
    ).toHaveLength(1);
    for (const kind of ['identity', 'support']) {
      for (let limiterIndex = 0; limiterIndex < 4; limiterIndex++) {
        expect(lanes).toContain(
          JSON.stringify({ kind, task: 'rate_limits', limiterIndex }),
        );
      }
    }
  });

  it('isolates 39 rate pages and 19 ready pages per hour across a UTC day boundary', async () => {
    const range = /^(\d+)-(\d+) \* \* \* \*$/.exec(RATE_LIMIT_CRON);
    expect(range).not.toBeNull();
    const start = Date.parse('2026-10-15T23:00:00Z');
    let pages = 0;
    let readyPages = 0;
    for (let minute = 0; minute < 120; minute++) {
      const time = start + minute * 60_000;
      const utcMinute = new Date(time).getUTCMinutes();
      if (utcMinute < Number(range![1]) || utcMinute > Number(range![2]))
        continue;
      vi.clearAllMocks();
      expect(
        await scheduled(RATE_LIMIT_CRON, time, {
          PEGMA_KNOWLEDGE_ENABLED: 'true',
        }),
      ).toBe(1);
      if (rateKnowledgeLaneAt(time) === 'rate_limits') {
        expect(runKnowledgeMaintenance).toHaveBeenCalledExactlyOnceWith(
          expect.anything(),
          expect.anything(),
          { tasks: ['rate_limits'] },
        );
        expect(createKnowledgeRetrievalReady).not.toHaveBeenCalled();
      } else {
        expect(runKnowledgeMaintenance).not.toHaveBeenCalled();
        expect(createKnowledgeRetrievalReady).toHaveBeenCalledTimes(1);
        const built = vi.mocked(createKnowledgeRetrievalReady).mock.results[0];
        if (built?.type !== 'return')
          throw new Error('Expected ready composition.');
        expect(built.value.runPage).toHaveBeenCalledTimes(1);
        readyPages += 1;
      }
      pages += vi.mocked(runKnowledgeMaintenance).mock.calls.length;
      expect(createKnowledgeRetrievalMaintenance).not.toHaveBeenCalled();
      expect(runIdentityMaintenance).not.toHaveBeenCalled();
      expect(runSupportMaintenance).not.toHaveBeenCalled();
      expect(runReleaseReconciliation).not.toHaveBeenCalled();
      if (utcMinute === Number(range![2])) {
        const hours = Math.floor(minute / 60) + 1;
        expect(pages).toBe(hours * 39);
        expect(readyPages).toBe(hours * 19);
      }
    }
  });

  it('isolates a failed rate invocation from later identity and support cleanup invocations', async () => {
    const start = Date.parse('2026-10-15T00:00:00Z');
    for (const kind of ['identity', 'support'] as const) {
      const offset = Array.from({ length: 15 }, (_, minute) => minute).find(
        (minute) => cleanupLaneAt(start + minute * 60_000).kind === kind,
      );
      if (offset === undefined)
        throw new Error('Expected a rotating cleanup lane.');
      vi.clearAllMocks();
      vi.mocked(runKnowledgeMaintenance).mockRejectedValueOnce(
        new Error('Synthetic limiter failure.'),
      );
      const time = start + offset * 60_000;
      expect(await scheduled(RATE_LIMIT_CRON, start)).toBe(1);
      expect(runKnowledgeMaintenance).toHaveBeenCalledTimes(1);
      expect(runIdentityMaintenance).not.toHaveBeenCalled();
      expect(runSupportMaintenance).not.toHaveBeenCalled();
      expect(createKnowledgeRetrievalMaintenance).not.toHaveBeenCalled();
      vi.clearAllMocks();
      await scheduled(CLEANUP_CRON, time);
      expect(runKnowledgeMaintenance).not.toHaveBeenCalled();
      expect(
        kind === 'identity' ? runIdentityMaintenance : runSupportMaintenance,
      ).toHaveBeenCalledTimes(1);
      expect(createKnowledgeRetrievalMaintenance).not.toHaveBeenCalled();
    }
  });

  it('runs the isolated rate job while knowledge is disabled and client configuration is invalid', async () => {
    await scheduled(RATE_LIMIT_CRON, Date.parse('2026-10-15T00:00:00Z'), {
      PEGMA_KNOWLEDGE_ENABLED: 'false',
      PEGMA_AGENT_CLIENTS_JSON: 'not-json',
    });
    expect(runKnowledgeMaintenance).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        store: expect.anything(),
        clock: expect.anything(),
      }),
      expect.anything(),
      { tasks: ['rate_limits'] },
    );
    expect(runIdentityMaintenance).not.toHaveBeenCalled();
    expect(runSupportMaintenance).not.toHaveBeenCalled();
    expect(runReleaseReconciliation).not.toHaveBeenCalled();
    expect(createKnowledgeRetrievalMaintenance).not.toHaveBeenCalled();
  });

  it('does not construct a projection Store on a disabled ready tick, even with malformed OAuth configuration', async () => {
    await scheduled(RATE_LIMIT_CRON, Date.parse('2026-10-15T00:02:00Z'), {
      PEGMA_KNOWLEDGE_ENABLED: 'false',
      PEGMA_AGENT_CLIENTS_JSON: 'not-json',
    });
    expect(createCloudflareD1Store).not.toHaveBeenCalled();
    expect(createKnowledgeRetrievalReady).not.toHaveBeenCalled();
    expect(createKnowledgeRetrievalMaintenance).not.toHaveBeenCalled();
    expect(runKnowledgeMaintenance).not.toHaveBeenCalled();
    expect(runIdentityMaintenance).not.toHaveBeenCalled();
    expect(runSupportMaintenance).not.toHaveBeenCalled();
  });

  it('runs one enabled KB page on the existing knowledge tick without running the global rate job', async () => {
    await scheduled(CLEANUP_CRON, knowledgeCleanupTime(), {
      PEGMA_KNOWLEDGE_ENABLED: 'true',
      PEGMA_AGENT_CLIENTS_JSON: 'not-json',
    });
    expect(runKnowledgeMaintenance).not.toHaveBeenCalled();
    expect(createKnowledgeRetrievalMaintenance).toHaveBeenCalledTimes(1);
    const invocation = vi.mocked(createKnowledgeRetrievalMaintenance).mock
      .results[0];
    if (invocation?.type !== 'return')
      throw new Error('Expected the actual scheduler repair composition.');
    expect(invocation.value.runPage).toHaveBeenCalledTimes(1);
    const options = vi.mocked(createKnowledgeRetrievalMaintenance).mock
      .calls[0]?.[0];
    expect(options?.isEnabled()).toBe(true);
    expect(runIdentityMaintenance).not.toHaveBeenCalled();
    expect(runSupportMaintenance).not.toHaveBeenCalled();
    expect(runReleaseReconciliation).not.toHaveBeenCalled();
  });

  it('keeps the isolated rate job available after enabled KB composition fails', async () => {
    vi.mocked(createKnowledgeRetrievalMaintenance).mockImplementationOnce(
      () => {
        throw new Error('Synthetic repair composition failure.');
      },
    );
    await scheduled(CLEANUP_CRON, knowledgeCleanupTime(), {
      PEGMA_KNOWLEDGE_ENABLED: 'true',
    });
    expect(runKnowledgeMaintenance).not.toHaveBeenCalled();
    expect(createKnowledgeRetrievalMaintenance).toHaveBeenCalledTimes(1);
    await scheduled(RATE_LIMIT_CRON, Date.parse('2026-10-15T00:00:00Z'));
    expect(runKnowledgeMaintenance).toHaveBeenCalledTimes(1);
    expect(createKnowledgeRetrievalMaintenance).toHaveBeenCalledTimes(1);
  });

  it('runs only release reconciliation on its own cron and ignores unknown crons', async () => {
    await scheduled(
      RELEASE_RECONCILIATION_CRON,
      Date.parse('2026-10-15T12:00:00Z'),
    );
    await scheduled('unknown', Date.parse('2026-10-15T12:00:00Z'));
    expect(runReleaseReconciliation).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        scheduledTime: Date.parse('2026-10-15T12:00:00Z'),
      }),
    );
    expect(runIdentityMaintenance).not.toHaveBeenCalled();
    expect(runSupportMaintenance).not.toHaveBeenCalled();
    expect(runKnowledgeMaintenance).not.toHaveBeenCalled();
    expect(createKnowledgeRetrievalMaintenance).not.toHaveBeenCalled();
  });
});
