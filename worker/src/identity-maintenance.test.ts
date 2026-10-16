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
  it('does no bookmark I/O or failure logging when only disabled mail tasks are selected', async () => {
    const value = fixture();
    const collection = vi.spyOn(value.runtime.store, 'collection');
    await runIdentityMaintenance(
      { ...value.runtime, mailWorker: null },
      value.logger,
      {
        tasks: ['mail_send', 'mail_reconcile', 'mail_retention'],
      },
    );
    expect(collection).not.toHaveBeenCalled();
    expect(value.logger.log).not.toHaveBeenCalled();
    expect(value.sendPage).not.toHaveBeenCalled();
    expect(value.reconciliationPage).not.toHaveBeenCalled();
    expect(value.mailSweep).not.toHaveBeenCalled();
  });

  it('logs an invalid limiter selection instead of silently skipping cleanup', async () => {
    const value = fixture();
    await runIdentityMaintenance(value.runtime, value.logger, {
      tasks: ['rate_limits'],
      limiterIndex: 1,
    });
    expect(value.limiterSweep).not.toHaveBeenCalled();
    expect(value.logger.log).toHaveBeenCalledExactlyOnceWith(
      'error',
      'identity.maintenance_failed',
      { task: 'rate_limits', error: 'RangeError' },
    );
  });

  it('identifies cursor-save failures and replays from the prior durable bookmark', async () => {
    const value = fixture();
    const collection = value.runtime.store.collection;
    let fail = true;
    vi.spyOn(value.runtime.store, 'collection').mockImplementation(
      (definition) => {
        const target = collection(definition);
        return {
          ...target,
          update: (...args) => {
            if (fail)
              return Promise.reject(new Error('cursor write unavailable'));
            return target.update(...args);
          },
        };
      },
    );
    await runIdentityMaintenance(value.runtime, value.logger, {
      tasks: ['mail_send'],
    });
    expect(value.logger.log).toHaveBeenCalledWith(
      'error',
      'identity.maintenance_failed',
      { task: 'cursors', error: 'Error' },
    );
    fail = false;
    await runIdentityMaintenance(value.runtime, value.logger, {
      tasks: ['mail_send'],
    });
    expect(value.sendPage).toHaveBeenNthCalledWith(2, { limit: 1 });
    await runIdentityMaintenance(value.runtime, value.logger, {
      tasks: ['mail_send'],
    });
    expect(value.sendPage).toHaveBeenNthCalledWith(3, {
      limit: 1,
      cursor: 'send-next',
    });
  });

  it('still runs cursor-independent hygiene if the bookmark read fails', async () => {
    const value = fixture();
    const collection = value.runtime.store.collection;
    vi.spyOn(value.runtime.store, 'collection').mockImplementation(
      (definition) => {
        const target = collection(definition);
        return definition.name === 'pegma-dev-maintenance'
          ? {
              ...target,
              get: async () => {
                throw new Error('bookmark unavailable');
              },
            }
          : target;
      },
    );
    await runIdentityMaintenance(value.runtime, value.logger);
    expect(value.limiterSweep).toHaveBeenCalledTimes(1);
    expect(value.purgeExpired).toHaveBeenCalledTimes(1);
    expect(value.challengeSweep).not.toHaveBeenCalled();
    expect(value.logger.log).toHaveBeenCalledWith(
      'error',
      'identity.maintenance_failed',
      { task: 'challenges', error: 'Error' },
    );
  });

  it('runs only mail on the minute path and does not write idle cursors', async () => {
    const value = fixture();
    value.sendPage.mockResolvedValue({
      examined: 0,
      results: [],
      nextCursor: null,
    });
    value.reconciliationPage.mockResolvedValue({
      examined: 0,
      results: [],
      nextCursor: null,
    });
    const collection = value.runtime.store.collection;
    const writes = vi.fn();
    const reads = vi.fn();
    vi.spyOn(value.runtime.store, 'collection').mockImplementation(
      (definition) => {
        const target = collection(definition);
        return {
          ...target,
          get: (...args) => {
            reads();
            return target.get(...args);
          },
          update: (...args) => {
            writes();
            return target.update(...args);
          },
        };
      },
    );

    await runIdentityMaintenance(value.runtime, value.logger, {
      tasks: ['mail_send', 'mail_reconcile'],
    });

    expect(reads).toHaveBeenCalledTimes(1);
    expect(writes).not.toHaveBeenCalled();
    expect(value.sendPage).toHaveBeenCalledTimes(1);
    expect(value.reconciliationPage).toHaveBeenCalledTimes(1);
    expect(value.challengeSweep).not.toHaveBeenCalled();
    expect(value.operationSweep).not.toHaveBeenCalled();
    expect(value.mailSweep).not.toHaveBeenCalled();
    expect(value.limiterSweep).not.toHaveBeenCalled();
    expect(value.purgeExpired).not.toHaveBeenCalled();
    expect(value.logger.log).not.toHaveBeenCalled();
  });

  it('sweeps just the selected rate-limit policy', async () => {
    const value = fixture();
    const other = {
      ...value.runtime.limiters[0]!,
      sweep: vi.fn(async () => ({ scanned: 0, deleted: 0 })),
    };
    await runIdentityMaintenance(
      { ...value.runtime, limiters: [...value.runtime.limiters, other] },
      value.logger,
      { tasks: ['rate_limits'], limiterIndex: 1 },
    );
    expect(value.limiterSweep).not.toHaveBeenCalled();
    expect(other.sweep).toHaveBeenCalledTimes(1);
  });

  it('persists independent cursors and runs every hygiene lane', async () => {
    const value = fixture();

    await runIdentityMaintenance(value.runtime, value.logger);
    await runIdentityMaintenance(value.runtime, value.logger);

    expect(value.challengeSweep).toHaveBeenNthCalledWith(
      2,
      1,
      'challenge-next',
    );
    expect(value.operationSweep).toHaveBeenNthCalledWith(
      2,
      1,
      'operation-next',
    );
    expect(value.sendPage).toHaveBeenNthCalledWith(2, {
      limit: 1,
      cursor: 'send-next',
    });
    expect(value.reconciliationPage).toHaveBeenNthCalledWith(2, {
      limit: 1,
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
