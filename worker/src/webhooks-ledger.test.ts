import { createWebhookLedger } from '@pegma/webhooks';
import { createMemoryStore } from '@pegma/storage-core';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@pegma/spine';

const logger: Logger = { log: vi.fn() };

describe('vendored @pegma/webhooks over createMemoryStore', () => {
  it('records begin, markProcessed, and duplicate begin outcomes', async () => {
    const store = createMemoryStore();
    const ledger = createWebhookLedger({
      store,
      source: 'github',
      logger,
    });

    const first = await ledger.begin(
      '11111111-1111-4111-8111-111111111111',
      'github.release.published',
    );
    expect(first).toEqual({ status: 'new', attempts: 0 });

    await ledger.markProcessed('11111111-1111-4111-8111-111111111111');

    const duplicate = await ledger.begin(
      '11111111-1111-4111-8111-111111111111',
      'github.release.published',
    );
    expect(duplicate).toEqual({ status: 'processed', attempts: 0 });
  });
});
