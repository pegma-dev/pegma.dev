/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { createCloudflareD1Store } from '@pegma/storage-cloudflare-d1';
import { defineCollection } from '@pegma/storage-core';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from './index';
import { productionAnsweringFixture } from './support-assistant-production-fixtures';
import {
  createSupportAssistantStageDatabase,
  type SupportAssistantStageBudget,
} from './support-assistant-stage-budget';
import { RATE_LIMIT_CRON } from './maintenance-schedule';
import { humanSecret } from './support-human-control-fixtures';

const profiles: { phase: string; budget: SupportAssistantStageBudget }[] = [];
beforeAll(async () => {
  for (const statement of [
    'CREATE TABLE IF NOT EXISTS RECORDS (partition_key TEXT NOT NULL, row_key TEXT NOT NULL, record_json TEXT, version INTEGER NOT NULL, deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)), PRIMARY KEY (partition_key, row_key)) STRICT',
    'CREATE TABLE IF NOT EXISTS PEGMA_STORAGE_D1_TX_GUARD (reason TEXT NOT NULL) STRICT',
    ...(['exists', 'missing', 'changed'] as const).map(
      (reason) =>
        `CREATE TRIGGER IF NOT EXISTS PEGMA_STORAGE_D1_TX_ABORT_${reason.toUpperCase()} BEFORE INSERT ON PEGMA_STORAGE_D1_TX_GUARD WHEN NEW.reason = '${reason}' BEGIN SELECT RAISE(ABORT, 'PEGMA_STORAGE_D1_TX_${reason.toUpperCase()}'); END`,
    ),
  ])
    await env.IDENTITY_DB.prepare(statement).run();
});
beforeEach(async () => {
  await env.IDENTITY_DB.prepare('DELETE FROM RECORDS').run();
  await env.IDENTITY_DB.prepare('DELETE FROM PEGMA_STORAGE_D1_TX_GUARD').run();
  profiles.length = 0;
});
afterEach(({ task }) => {
  Object.assign(task.meta, { supportAnsweringProductionRootBudget: structuredClone(profiles) });
  vi.unstubAllGlobals();
});

function physical(f: Awaited<ReturnType<typeof productionAnsweringFixture>>, phase: string) {
  const measured = createSupportAssistantStageDatabase(env.IDENTITY_DB);
  const environment: Parameters<typeof worker.fetch>[1] = {
    ...env,
    ...f.environment,
    IDENTITY_DB: measured.database,
    IDENTITY_EMAIL_CODE_SECRET_BASE64: humanSecret,
  };
  return {
    environment,
    close() {
      const budget = measured.snapshot();
      profiles.push({ phase, budget });
      expect(budget.blockedQueries).toBe(0);
      expect(budget.physicalQueries).toBeLessThanOrEqual(50);
      expect(budget.maximumParameters).toBeLessThanOrEqual(100);
      expect(budget.blockedParameters).toBe(0);
    },
  };
}
async function invoke(
  f: Awaited<ReturnType<typeof productionAnsweringFixture>>,
  phase: string,
  request?: Request,
  scheduledTime = Date.now(),
) {
  const measured = physical(f, phase);
  const ctx = createExecutionContext();
  const response =
    request === undefined
      ? await worker.scheduled(
          { cron: RATE_LIMIT_CRON, scheduledTime, noRetry() {} },
          measured.environment,
          ctx,
        )
      : await worker.fetch(request, measured.environment, ctx);
  await waitOnExecutionContext(ctx);
  measured.close();
  return response;
}

describe('normal default root with the production bundle and actual tokenizer', () => {
  it('refuses real D1 dispatch51 across reconstructed Stores and permits a fresh physical invocation', async () => {
    const backing = createSupportAssistantStageDatabase(env.IDENTITY_DB);
    const guarded = createSupportAssistantStageDatabase(backing.database);
    const definition = defineCollection<{ partition: string; id: string }>({
      name: 'fictional-answering-budget-test',
      key: (value) => value,
      codec: {
        encode: (value) => value,
        decode: (value) => ({ partition: String(value.partition), id: String(value.id) }),
      },
    });
    for (let call = 0; call < 50; ++call) {
      // Reconstructing a Store does not create a second physical allowance.
      const store = createCloudflareD1Store({
        database: guarded.database,
        createSchemaIfMissing: false,
      });
      expect(
        await store.collection(definition).get({ partition: 'fictional-budget', id: String(call) }),
      ).toBeNull();
    }
    const store = createCloudflareD1Store({
      database: guarded.database,
      createSchemaIfMissing: false,
    });
    await expect(
      store.collection(definition).get({ partition: 'fictional-budget', id: '51' }),
    ).rejects.toThrow('D1 query 51');
    expect(backing.snapshot().physicalQueries).toBe(50);
    expect(backing.snapshot().blockedQueries).toBe(0);
    expect(guarded.snapshot().blockedQueries).toBe(1);
    const next = createSupportAssistantStageDatabase(env.IDENTITY_DB);
    expect(
      await createCloudflareD1Store({ database: next.database, createSchemaIfMissing: false })
        .collection(definition)
        .get({ partition: 'fictional-budget', id: 'next' }),
    ).toBeNull();
    expect(next.snapshot().physicalQueries).toBe(1);
    profiles.push({ phase: 'deliberate-query51-refusal', budget: guarded.snapshot() });
  });

  it('executes parameter100 and rejects parameter101 before binding or dispatch', async () => {
    const backing = createSupportAssistantStageDatabase(env.IDENTITY_DB);
    const guarded = createSupportAssistantStageDatabase(backing.database);
    const hundred =
      'SELECT ' + Array.from({ length: 100 }, (_, index) => '? AS v' + index).join(',');
    expect(
      await guarded.database
        .prepare(hundred)
        .bind(...Array<number>(100).fill(0))
        .first<number>('v0'),
    ).toBe(0);
    expect(() =>
      guarded.database.prepare(hundred + ', ? AS extra').bind(...Array<number>(101).fill(0)),
    ).toThrow('parameter 101');
    expect(backing.snapshot().physicalQueries).toBe(1);
    expect(backing.snapshot().maximumParameters).toBe(100);
    expect(guarded.snapshot().blockedParameters).toBe(1);
    profiles.push({ phase: 'deliberate-parameter101-refusal', budget: guarded.snapshot() });
  });

  it('keeps newly eligible minute58 inert when processing is OFF', async () => {
    const f = await productionAnsweringFixture(
      createCloudflareD1Store({
        database: env.IDENTITY_DB,
        createSchemaIfMissing: false,
        readBatchSize: 512,
      }),
    );
    f.environment.PEGMA_SUPPORT_ASSISTANT_ENABLED = 'false';
    f.environment.PEGMA_SUPPORT_ASSISTANT_CONFIGURATION_JSON = '';
    const time = new Date();
    time.setUTCMinutes(58, 0, 0);
    await invoke(f, 'processing-off', undefined, time.valueOf());
    expect(profiles.at(-1)?.budget.physicalQueries).toBe(0);
    expect(f.wires).toHaveLength(0);
  });

  it('keeps customer admission OFF and reconstructs separate bounded preparation and paid invocations', async () => {
    const f = await productionAnsweringFixture(
      createCloudflareD1Store({
        database: env.IDENTITY_DB,
        createSchemaIfMissing: false,
        readBatchSize: 512,
      }),
    );
    const { command } = await f.seed();
    vi.stubGlobal('fetch', vi.fn(f.provider));
    const capability = await invoke(f, 'customer-capability-off', f.request());
    expect(capability).toBeInstanceOf(Response);
    if (!(capability instanceof Response)) throw new Error('Missing capability response.');
    expect(await capability.json()).toMatchObject({ enabled: false });
    expect(profiles.at(-1)?.budget.physicalQueries).toBe(0);
    for (let turn = 0; turn < 12 && f.wires.length === 0; ++turn)
      await invoke(f, 'scheduled-' + turn);
    expect(f.wires).toHaveLength(1);
    const scheduled = profiles.filter((row) => row.phase.startsWith('scheduled-'));
    expect(scheduled.length).toBeGreaterThanOrEqual(2);
    expect(scheduled[0]!.budget.physicalQueries).toBeGreaterThan(1);
    const view = await f.f.runtime.application.readCustomerTicket(
      await f.access(),
      command.command.ticketId,
    );
    expect(view.messages.filter((message) => message.authorKind === 'assistant')).toHaveLength(1);
    for (const preference of ['human', 'assistant_if_available'] as const) {
      const refused = await invoke(
        f,
        'new-admission-off-' + preference,
        f.request(f.packet(preference)),
      );
      expect(refused).toBeInstanceOf(Response);
      expect((refused as Response).status).toBe(409);
    }
    expect(f.wires).toHaveLength(1);
  });

  it('recovers the actual original accepted receipt through the default root after JSON removal without key/provider replay', async () => {
    const f = await productionAnsweringFixture(
      createCloudflareD1Store({
        database: env.IDENTITY_DB,
        createSchemaIfMissing: false,
        readBatchSize: 512,
      }),
    );
    f.environment.PEGMA_SUPPORT_ASSISTANT_CUSTOMER_ADMISSION_ENABLED = 'true';
    const command = f.packet();
    const accepted = await invoke(f, 'admitted-create', f.request(command));
    expect((accepted as Response).status).toBe(201);
    f.environment.PEGMA_SUPPORT_ASSISTANT_ENABLED = 'false';
    f.environment.PEGMA_SUPPORT_ASSISTANT_CONFIGURATION_JSON = '';
    f.environment.SUPPORT_ASSISTANT_OPENROUTER_API_KEY = '';
    const recovered = await invoke(f, 'accepted-config-removed', f.request(command));
    expect((recovered as Response).status).toBe(201);
    expect(await (recovered as Response).json()).toMatchObject({ initialMode: 'assistant' });
    const refused = await invoke(f, 'fresh-config-removed', f.request(f.packet()));
    expect((refused as Response).status).toBe(409);
    expect(f.wires).toHaveLength(0);
  });
});
