import { createMemoryStore } from '@pegma/storage-core';
import { createDurableLimiter, defineRateLimitPolicy } from '@pegma/rate-limit';
import { createSessionStore } from '@pegma/sessions';
import type { Identity, MailWorker } from '@pegma/identity';
import type { MailJob } from '@pegma/mail';
import type { Logger } from '@pegma/spine';
import { describe, expect, it, vi } from 'vitest';
import {
  runIdentityMaintenance,
  type IdentityMaintenanceRuntime,
} from './identity-maintenance';

function fixture() {
  const store = createMemoryStore();
  const challengeSweep = vi
    .fn<Identity['sweepChallenges']>()
    .mockResolvedValueOnce({
      inspected: 1,
      pulled: 0,
      deleted: 0,
      rejected: 0,
      cursor: 'challenge-next',
      hasMore: true,
    })
    .mockResolvedValue({
      inspected: 0,
      pulled: 0,
      deleted: 0,
      rejected: 0,
      cursor: null,
      hasMore: false,
    });
  const operationSweep = vi
    .fn<Identity['sweepEmailOperations']>()
    .mockResolvedValueOnce({
      inspected: 1,
      repaired: 0,
      failed: 0,
      rejected: 0,
      deleted: 0,
      cursor: 'operation-next',
      hasMore: true,
    })
    .mockResolvedValue({
      inspected: 0,
      repaired: 0,
      failed: 0,
      rejected: 0,
      deleted: 0,
      cursor: null,
      hasMore: false,
    });
  const mailSweep = vi.fn<Identity['sweepMail']>(async () => ({
    examined: 0,
    deleted: 0,
    nextCursor: null,
    more: false,
  }));
  const mailJob: MailJob = {
    partition: 'operation',
    id: 'verification-mail',
    submissionGeneration: 1,
    idempotencyKey: 'pegma-mail:v1:operation:verification-mail:1',
    recipientRef: 'recipient',
    contentRef: 'content',
    status: 'dead_letter',
    attemptCount: 1,
    maxAttempts: 1,
    availableAt: '2026-07-28T00:00:00.000Z',
    createdAt: '2026-07-28T00:00:00.000Z',
    terminalAt: '2026-07-28T00:00:00.000Z',
  };
  const sendPage = vi.fn<MailWorker['runSendPage']>(async () => ({
    examined: 1,
    results: [{ status: 'dead_letter' as const, job: mailJob }],
    nextCursor: 'send-next',
  }));
  const reconciliationPage = vi.fn<MailWorker['runReconciliationPage']>(
    async () => ({
      examined: 1,
      results: [
        {
          status: 'terminal_unknown' as const,
          job: { ...mailJob, status: 'terminal_unknown' as const },
        },
      ],
      nextCursor: null,
    }),
  );
  const limiter = createDurableLimiter(
    defineRateLimitPolicy({ name: 'test', limit: 1, windowMs: 60_000 }),
    store,
  );
  const limiterSweep = vi.spyOn(limiter, 'sweep');
  const sessions = createSessionStore(store);
  const purgeExpired = vi.spyOn(sessions, 'purgeExpired');
  const logger: Logger = { log: vi.fn() };
  const runtime = {
    store,
    identity: {
      sweepChallenges: challengeSweep,
      sweepEmailOperations: operationSweep,
      sweepMail: mailSweep,
    },
    mailWorker: {
      send: vi.fn(),
      reconcile: vi.fn(),
      runSendPage: sendPage,
      runReconciliationPage: reconciliationPage,
    },
    limiters: [limiter],
    sessions,
  } satisfies IdentityMaintenanceRuntime;
  return {
    runtime,
    logger,
    challengeSweep,
    operationSweep,
    mailSweep,
    sendPage,
    reconciliationPage,
    limiterSweep,
    purgeExpired,
  };
}

describe('Identity maintenance', () => {
  it('persists independent cursors and runs every hygiene lane', async () => {
    const value = fixture();

    await runIdentityMaintenance(value.runtime, value.logger);
    await runIdentityMaintenance(value.runtime, value.logger);

    expect(value.challengeSweep).toHaveBeenNthCalledWith(
      2,
      100,
      'challenge-next',
    );
    expect(value.operationSweep).toHaveBeenNthCalledWith(
      2,
      100,
      'operation-next',
    );
    expect(value.sendPage).toHaveBeenNthCalledWith(2, {
      limit: 5,
      cursor: 'send-next',
    });
    expect(value.reconciliationPage).toHaveBeenNthCalledWith(2, {
      limit: 5,
    });
    expect(value.mailSweep).toHaveBeenCalledTimes(2);
    expect(value.limiterSweep).toHaveBeenCalledTimes(2);
    expect(value.purgeExpired).toHaveBeenCalledTimes(2);
    expect(value.logger.log).toHaveBeenCalledWith(
      'error',
      'identity.mail_terminal',
      { lane: 'send', count: 1 },
    );
    expect(value.logger.log).toHaveBeenCalledWith(
      'error',
      'identity.mail_terminal',
      { lane: 'reconcile', count: 1 },
    );
  });

  it('isolates a failed lane so session and limiter hygiene still run', async () => {
    const value = fixture();
    value.challengeSweep.mockReset();
    value.challengeSweep.mockRejectedValue(new Error('storage unavailable'));

    await expect(
      runIdentityMaintenance(value.runtime, value.logger),
    ).resolves.toBeUndefined();

    expect(value.limiterSweep).toHaveBeenCalledTimes(1);
    expect(value.purgeExpired).toHaveBeenCalledTimes(1);
    expect(value.logger.log).toHaveBeenCalledWith(
      'error',
      'identity.maintenance_failed',
      { task: 'challenges', error: 'Error' },
    );
  });
});
