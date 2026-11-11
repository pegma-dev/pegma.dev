/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { createCloudflareD1Store } from '@pegma/storage-cloudflare-d1';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveAccess } from '@pegma/authorization-core';
import { supportPermissions } from '@pegma/support-desk-application';
import { createSupportRequestHandler, createWorker } from './index';
import {
  completeAnsweringComposition,
  changeAnsweringContact,
  supportAnsweringFixture,
} from './support-answering-fixtures';
import {
  createSupportAssistantStageDatabase,
  type SupportAssistantStageBudget,
} from './support-assistant-stage-budget';
import { CLEANUP_CRON, CLEANUP_LANE_COUNT, cleanupLaneAt } from './maintenance-schedule';
import { controlledHumanBody, humanSecret } from './support-human-control-fixtures';

const profiles: { phase: string; budget: SupportAssistantStageBudget }[] = [];
beforeAll(async () => {
  // The same two-table/three-trigger adapter schema used by the existing Native suites.
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
  Object.assign(task.meta, { supportAnsweringNormalEntryBudget: structuredClone(profiles) });
});

function physical(phase: string) {
  const measured = createSupportAssistantStageDatabase(env.IDENTITY_DB);
  const environment: Parameters<typeof createSupportRequestHandler>[0] = {
    ...env,
    IDENTITY_DB: measured.database,
    IDENTITY_EMAIL_CODE_SECRET_BASE64: humanSecret,
    PEGMA_SUPPORT_ASSISTANT_ENABLED: 'true',
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
function answeringLane() {
  const start = Math.floor(Date.now() / 60_000) * 60_000;
  for (let step = 0; step < 128; ++step) {
    const time = start + step * 60_000;
    if (
      new Date(time).getUTCMinutes() !== 59 &&
      cleanupLaneAt(time).kind === 'learning_reviews' &&
      Math.floor(
        (Math.floor(time / 60_000) - Math.floor((Math.floor(time / 60_000) + 1) / 60)) /
          CLEANUP_LANE_COUNT,
      ) %
        2 ===
        0
    )
      return time;
  }
  throw new Error('No separate answering maintenance lane found.');
}

describe('normal public025+D1047 answering physical invocation budget', () => {
  it('includes genuine HTTP admission and accepted recovery in the hard50 meter', async () => {
    const f = await supportAnsweringFixture(
      createCloudflareD1Store({
        database: env.IDENTITY_DB,
        createSchemaIfMissing: false,
        readBatchSize: 512,
      }),
    );
    const packet = f.packet();
    const logger = { log() {} };
    const first = physical('normal-customer-admission');
    const response = await createSupportRequestHandler(
      first.environment,
      logger,
      {},
      f.composition,
    )(f.request(packet));
    first.close();
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ initialMode: 'assistant' });
    f.state.enabled = false;
    const retry = physical('disabled-accepted-receipt');
    const recovered = await createSupportRequestHandler(
      retry.environment,
      logger,
      {},
      f.composition,
    )(f.request(packet));
    retry.close();
    expect(recovered.status).toBe(201);
    expect(await recovered.json()).toMatchObject({ initialMode: 'assistant' });
    f.state.enabled = true;
    const reduced = {
      ...f.composition,
      configuration: { ...f.composition.configuration!, turns: { maxAttempts: 1 } },
    };
    const capped = physical('cap1-accepted-receipt');
    const capReplay = await createSupportRequestHandler(
      capped.environment,
      logger,
      {},
      reduced,
    )(f.request(packet));
    capped.close();
    expect(capReplay.status).toBe(201);
    expect(await capReplay.json()).toMatchObject({ initialMode: 'assistant' });
    const disabled = physical('cap1-disabled-capability');
    const hint = await createSupportRequestHandler(
      disabled.environment,
      logger,
      {},
      reduced,
    )(f.request());
    disabled.close();
    expect(await hint.json()).toEqual({ enabled: false });
    expect(profiles.at(-1)!.budget.physicalQueries).toBe(0);
    const committed = await f.human.rows(packet.command.ticketId);
    // This real Identity change is another physical operation, outside the
    // measured original create/replay invocation and with only scripted mail.
    await changeAnsweringContact(f, 'changed-answering-owner@example.test');
    const contactReplay = physical('verified-contact-accepted-receipt');
    const afterContact = await createSupportRequestHandler(
      contactReplay.environment,
      logger,
      {},
      f.composition,
    )(f.request(packet));
    contactReplay.close();
    expect(afterContact.status).toBe(201);
    expect(await afterContact.json()).toMatchObject({ initialMode: 'assistant' });
    expect(await f.human.rows(packet.command.ticketId)).toEqual(committed);
    expect(f.state.calls).toBe(0);
    expect(f.state.keys).toBe(0);
  });

  it.each(['human', 'assistant_if_available'] as const)(
    'rejects the whole %s create after another real physical Identity operation changes its contact during the held body',
    async (preference) => {
      const f = await supportAnsweringFixture(
        createCloudflareD1Store({
          database: env.IDENTITY_DB,
          createSchemaIfMissing: false,
          readBatchSize: 512,
        }),
      );
      const packet = f.packet(preference);
      const body = await controlledHumanBody(f.request(packet));
      const measured = physical('held-body-contact-change-' + preference);
      const pending = createSupportRequestHandler(
        measured.environment,
        { log() {} },
        {},
        f.composition,
      )(body.request);
      await body.waitFor(pending);
      // Independent physical contact-change work uses the genuine unwrapped
      // fixture binding, never resets or borrows this request's hard50 allowance.
      await changeAnsweringContact(f, 'changed-answering-owner@example.test');
      body.complete();
      const response = await pending;
      measured.close();
      expect(response.status).toBe(409);
      expect(await f.human.rows(packet.command.ticketId)).toEqual([]);
      expect(f.state.calls).toBe(0);
      expect(f.state.keys).toBe(0);
    },
  );

  it('runs each normal scheduled scan/preparation/paid phase exclusively under hard50 and commits one answer', async () => {
    const f = await supportAnsweringFixture(
      createCloudflareD1Store({
        database: env.IDENTITY_DB,
        createSchemaIfMissing: false,
        readBatchSize: 512,
      }),
    );
    const { packet } = await completeAnsweringComposition(f);
    const worker = createWorker({ answering: f.composition });
    const at = answeringLane();
    const access = resolveAccess(
      { principalId: f.human.principals.owner },
      { version: 'fixture', defaults: [supportPermissions.readOwn] },
    );
    let completed = false;
    for (let invocation = 0; invocation < 128; ++invocation) {
      const measured = physical('scheduled-' + invocation);
      const context = createExecutionContext();
      await worker.scheduled(
        { cron: CLEANUP_CRON, scheduledTime: at, noRetry() {} },
        measured.environment,
        context,
      );
      await waitOnExecutionContext(context);
      measured.close();
      const view = await f.runtime.application.readCustomerTicket(access, packet.command.ticketId);
      if (view.messages.some((message) => message.authorKind === 'assistant')) {
        completed = true;
        break;
      }
    }
    expect(completed).toBe(true);
    expect(f.state.calls).toBe(1);
    expect(f.state.keys).toBe(1);
    expect(profiles.length).toBeGreaterThanOrEqual(2);
    expect(profiles.every((profile) => profile.budget.physicalQueries <= 50)).toBe(true);
  });
});
