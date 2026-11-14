import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseConfigFileTextToJson } from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { independentCheckRoutePolicyHash } from './support-independent-checks-model';
import {
  CHECKER_CPU_BUDGETS,
  CHECKER_CPU_QUEUE,
  CHECKER_CPU_ROUTE,
  runCheckerCpuFixture,
} from './support-checker-cpu-stage';
import {
  CHECKER_CPU_FROZEN,
  type CheckerCpuCaseId,
} from './support-checker-cpu-inputs';
import entry, {
  CHECKER_CPU_DELIVERIES,
  createCheckerCpuStage,
  type CheckerCpuObservation,
} from './support-checker-cpu-stage-entry';

const clock = { now: () => '2026-11-14T00:00:00.000Z' };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
afterEach(() => vi.restoreAllMocks());
function message(body: unknown, attempts = 1): Message<unknown> {
  return {
    id: 'fictional-cpu-queue-message',
    timestamp: new Date(clock.now()),
    attempts,
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}
function batch(
  messages: Message<unknown>[],
  queue = CHECKER_CPU_QUEUE,
): MessageBatch<unknown> {
  return {
    queue,
    messages,
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  };
}
const noExternalFetch = () =>
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('External requests are forbidden in the CPU fixture');
  });

describe('isolated whole-checker CPU fixture', () => {
  it('retains exact fictional input/SYSTEM bytes and a real SDK-valid fictional policy hash', async () => {
    expect(Object.isFrozen(CHECKER_CPU_FROZEN.cases.normal)).toBe(true);
    expect(Object.isFrozen(CHECKER_CPU_FROZEN.cases.unsupported)).toBe(true);
    expect(hash(CHECKER_CPU_FROZEN.systemText)).toBe(
      CHECKER_CPU_FROZEN.systemSha256,
    );
    for (const caseId of ['normal', 'unsupported'] as const) {
      const f = CHECKER_CPU_FROZEN.cases[caseId];
      expect(hash(f.inputJson)).toBe(f.inputSha256);
      expect(JSON.stringify(JSON.parse(f.inputJson))).toBe(f.inputJson);
      expect(
        new TextEncoder().encode(f.inputJson).length +
          new TextEncoder().encode(CHECKER_CPU_FROZEN.systemText).length,
      ).toBe(f.expectedMessageBytes);
    }
    const { approval, ...unsigned } = CHECKER_CPU_ROUTE;
    expect(await independentCheckRoutePolicyHash(unsigned)).toBe(
      approval.requestPolicySha256,
    );
    expect(Object.isFrozen(CHECKER_CPU_ROUTE.approval)).toBe(true);
    expect(Object.isFrozen(CHECKER_CPU_ROUTE.configuration.budgets)).toBe(true);
  });

  it.each(['normal', 'unsupported'] as const)(
    'executes the entire actual %s checker path with unchanged wire and no network',
    async (caseId) => {
      const external = noExternalFetch();
      const { activity, wireBody } = await runCheckerCpuFixture(caseId, clock);
      const f = CHECKER_CPU_FROZEN.cases[caseId];
      expect(activity).toMatchObject({
        withinBudget: true,
        scriptedCompletion: true,
        providerCalls: 1,
        credentialReads: 1,
        physicalCallNotifications: 1,
      });
      expect(activity.counterCalls).toBeGreaterThanOrEqual(6);
      expect(activity.counterObservations).toHaveLength(activity.counterCalls);
      expect(activity.counterObservations).toContainEqual({
        codeUnits: f.inputJson.length,
        tokens: f.expectedUserTokens,
      });
      expect(activity.counterObservations).toContainEqual({
        codeUnits: CHECKER_CPU_FROZEN.systemText.length,
        tokens: f.expectedSystemTokens,
      });
      expect(hash(wireBody)).toBe(f.expectedWireSha256);
      const wire = JSON.parse(wireBody);
      expect(wire.messages[0].content).toBe(CHECKER_CPU_FROZEN.systemText);
      expect(wire.messages[1].content).toBe(f.inputJson);
      expect(wire.provider).toEqual({
        only: ['azure'],
        allow_fallbacks: false,
        zdr: true,
        data_collection: 'deny',
        require_parameters: true,
        max_price: { prompt: 2.75, completion: 16.5, request: 0 },
      });
      expect(external).not.toHaveBeenCalled();
    },
  );

  it('runs four single-message deliveries without eliding warm counts or pretending the second input is tokenizer-cold', async () => {
    const external = noExternalFetch(),
      observations: CheckerCpuObservation[] = [];
    const stage = createCheckerCpuStage({
      clock,
      observe: (x) => observations.push(x),
      createIsolateId: () => 'fictional-isolate',
    });
    const accepted: Message<unknown>[] = [];
    for (const selected of CHECKER_CPU_DELIVERIES) {
      const m = message(selected.body);
      accepted.push(m);
      await stage.queue(batch([m]));
    }
    const complete = observations.filter((x) => x.event === 'finish');
    expect(complete).toHaveLength(4);
    expect(complete.every((x) => x.outcome === 'fixture-complete')).toBe(true);
    expect(complete.map((x) => x.requestedPhase)).toEqual([
      'first-use',
      'warm',
      'first-use',
      'warm',
    ]);
    expect(complete.map((x) => x.counterEntryUse)).toEqual([
      'first-request-by-entry',
      'previous-request-by-entry',
      'previous-request-by-entry',
      'previous-request-by-entry',
    ]);
    for (const caseId of [
      'normal',
      'unsupported',
    ] satisfies CheckerCpuCaseId[]) {
      const pair = complete.filter((x) => x.caseId === caseId);
      expect(pair).toHaveLength(2);
      expect(pair[0]!.inputSha256).toBe(pair[1]!.inputSha256);
      expect(pair[0]!.counterCalls).toBe(pair[1]!.counterCalls);
      expect(pair[0]!.counterObservations).toEqual(
        pair[1]!.counterObservations,
      );
      expect(pair.every((x) => x.isolateId === 'fictional-isolate')).toBe(true);
    }
    for (const m of accepted) {
      expect(m.ack).toHaveBeenCalledOnce();
      expect(m.retry).not.toHaveBeenCalled();
    }
    expect(
      observations.some(
        (x) =>
          Object.hasOwn(x, 'elapsedMilliseconds') ||
          Object.hasOwn(x, 'cpuTimeMs'),
      ),
    ).toBe(false);
    expect(JSON.stringify(observations)).not.toContain(
      'FICTIONAL_CPU_ONLY_NEVER_EXTERNAL',
    );
    expect(JSON.stringify(observations)).not.toContain(
      CHECKER_CPU_FROZEN.trustedInstructions,
    );
    expect(external).not.toHaveBeenCalled();
  });

  it('acknowledges malformed, redelivered, warm-first and multi-message batches without model work or retry', async () => {
    const external = noExternalFetch(),
      observations: CheckerCpuObservation[] = [];
    const stage = createCheckerCpuStage({
      clock,
      observe: (x) => observations.push(x),
    });
    const groups = [
      batch([message({ arbitrary: 'never log this' })]),
      batch([message(CHECKER_CPU_DELIVERIES[0].body, 2)]),
      batch([message(CHECKER_CPU_DELIVERIES[1].body)]),
      batch([message(CHECKER_CPU_DELIVERIES[0].body)], 'unrelated-queue'),
      batch([
        message(CHECKER_CPU_DELIVERIES[0].body),
        message(CHECKER_CPU_DELIVERIES[2].body),
      ]),
    ];
    for (const group of groups) {
      await stage.queue(group);
      for (const m of group.messages) {
        expect(m.ack).toHaveBeenCalledOnce();
        expect(m.retry).not.toHaveBeenCalled();
      }
    }
    expect(observations.every((x) => x.event === 'refused')).toBe(true);
    expect(JSON.stringify(observations)).not.toContain('never log this');
    expect(external).not.toHaveBeenCalled();
  });

  it('holds expired fictional evidence and refuses a warm sample after an incomplete first sample', async () => {
    const observations: CheckerCpuObservation[] = [];
    const stage = createCheckerCpuStage({
      clock: { now: () => '2027-01-02T00:00:00.000Z' },
      observe: (x) => observations.push(x),
    });
    const first = message(CHECKER_CPU_DELIVERIES[0].body),
      warm = message(CHECKER_CPU_DELIVERIES[1].body);
    await stage.queue(batch([first]));
    await stage.queue(batch([warm]));
    expect(observations.some((x) => x.outcome === 'held')).toBe(true);
    expect(observations.at(-1)).toMatchObject({
      event: 'refused',
      reason: 'phase-or-duplicate',
    });
    expect(first.retry).not.toHaveBeenCalled();
    expect(warm.retry).not.toHaveBeenCalled();
  });

  it('exposes only a queue consumer and a separate binding-free private manifest', () => {
    expect(Object.keys(entry)).toEqual(['queue']);
    const parsed = parseConfigFileTextToJson(
      'wrangler.checker-cpu-stage.jsonc',
      readFileSync(
        new URL('../wrangler.checker-cpu-stage.jsonc', import.meta.url),
        'utf8',
      ),
    );
    expect(parsed.error).toBeUndefined();
    const config = parsed.config;
    expect(config.main).toBe('src/support-checker-cpu-stage-entry.ts');
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.routes).toEqual([]);
    expect(config.triggers.crons).toEqual([]);
    expect(config.queues.consumers).toEqual([
      {
        queue: CHECKER_CPU_QUEUE,
        max_batch_size: 1,
        max_batch_timeout: 0,
        max_concurrency: 1,
        max_retries: 0,
      },
    ]);
    for (const key of [
      'd1_databases',
      'kv_namespaces',
      'r2_buckets',
      'durable_objects',
      'vars',
      'services',
      'limits',
    ])
      expect(config).not.toHaveProperty(key);
    expect(config.queues).not.toHaveProperty('producers');
    expect(config.observability.logs.invocation_logs).toBe(true);
    expect(CHECKER_CPU_BUDGETS.maxAttempts).toBe(1);
  });
});
