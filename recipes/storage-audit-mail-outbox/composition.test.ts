import type { PrincipalId } from '@pegma/spine';
import { createMemoryStore } from '@pegma/storage-core';
import { describe, expect, it } from 'vitest';
import {
  checkoutEquipment,
  createYardLoanComposition,
  yardLoanPartition,
} from './composition';

const DESK = 'desk_main';
const PARTITION = yardLoanPartition(DESK);
const WHEN = '2026-07-29T15:00:00.000Z';

/** Explicit memory store for tests — production injects a durable adapter. */
function makeComposition() {
  return createYardLoanComposition(DESK, createMemoryStore());
}

describe('storage-audit-mail-outbox (Yard Loan)', () => {
  it('commits loan, audit, and mail job in one single-partition transaction', async () => {
    const composition = makeComposition();

    const result = await checkoutEquipment(composition, {
      itemId: 'ladder-12ft',
      borrowerPrincipalId: 'prn_borrower' as PrincipalId,
      actorPrincipalId: 'prn_clerk' as PrincipalId,
      auditEventId: 'evt_checkout_1',
      mailJobId: 'mail_checkout_1',
      occurredAt: WHEN,
    });

    expect(result.committed).toBe(true);

    const loan = await composition.records.get({
      partition: PARTITION,
      id: 'loan|ladder-12ft',
    });
    expect(loan).toMatchObject({
      kind: 'loan',
      status: 'checked_out',
      borrowerPrincipalId: 'prn_borrower',
    });

    const history = await composition.audit.history(
      composition.records,
      PARTITION,
      { subject: 'ladder-12ft' },
    );
    expect(history).toHaveLength(1);
    expect(history[0]?.action).toBe('yard_loan.item.checked_out');

    const mailRow = await composition.records.get({
      partition: PARTITION,
      id: 'mail|mail_checkout_1',
    });
    expect(mailRow?.kind).toBe('mail');
    if (mailRow?.kind === 'mail') {
      expect(mailRow.job.status).toBe('pending');
      expect(mailRow.job.recipientRef).toBe('prn_borrower');
      expect(mailRow.callerMetadata).toBe('yard-loan-checkout-notice');
    }
  });

  it('leaves no orphan audit or mail when the transaction rolls back', async () => {
    const composition = makeComposition();

    // Seed an existing loan so a second insert of the same item is refused.
    await composition.records.put({
      kind: 'loan',
      deskId: DESK,
      itemId: 'drill-set',
      borrowerPrincipalId: 'prn_existing' as PrincipalId,
      status: 'checked_out',
    });

    const result = await checkoutEquipment(composition, {
      itemId: 'drill-set',
      borrowerPrincipalId: 'prn_other' as PrincipalId,
      actorPrincipalId: 'prn_clerk' as PrincipalId,
      auditEventId: 'evt_orphan',
      mailJobId: 'mail_orphan',
      occurredAt: WHEN,
    });

    expect(result.committed).toBe(false);
    expect(result.reason).toBe('exists');

    expect(
      await composition.audit.history(composition.records, PARTITION),
    ).toEqual([]);
    expect(
      await composition.records.get({
        partition: PARTITION,
        id: 'mail|mail_orphan',
      }),
    ).toBeNull();
  });
});
