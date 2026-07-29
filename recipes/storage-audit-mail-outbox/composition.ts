/**
 * Recipe: storage-audit-mail-outbox
 *
 * Synthetic host: Yard Loan — a fictional equipment checkout desk.
 * Teaches the pattern every durable notification and audit trail needs:
 *
 *   state change + audit row + mail outbox job
 *   commit together in one storage-core single-partition `transact`
 *
 * Audit and Mail own no store. The host collection holds inventory rows,
 * audit events, and mail jobs in one partition so atomicity is real.
 *
 * Tests use the memory store. Production hosts pick a durable adapter
 * (Cloudflare D1 or Azure Tables) for the same collection shape.
 */

import {
  auditRecordId,
  decodeAuditEvent,
  defineAudit,
  encodeAuditEvent,
  type AuditEvent,
  type AuditLog,
} from '@pegma/audit';
import {
  defineMail,
  type Mail,
  type MailJob,
} from '@pegma/mail';
import type { IsoTimestamp, PrincipalId } from '@pegma/spine';
import {
  createMemoryStore,
  defineCollection,
  type CollectionStore,
  type Store,
  type StoredRecord,
} from '@pegma/storage-core';

/** One collection, one partition per loan — the only atomic scope. */
export type YardLoanRecord =
  | {
      readonly kind: 'loan';
      readonly deskId: string;
      readonly itemId: string;
      readonly borrowerPrincipalId: PrincipalId;
      readonly status: 'checked_out' | 'returned';
    }
  | {
      readonly kind: 'audit';
      readonly deskId: string;
      readonly event: AuditEvent;
    }
  | {
      readonly kind: 'mail';
      readonly deskId: string;
      readonly job: MailJob;
      /** Host-owned metadata preserved across mail worker transitions. */
      readonly callerMetadata: string;
    };

export const yardLoanPartition = (deskId: string): string => `desk|${deskId}`;

export const yardLoanRecords = defineCollection<YardLoanRecord>({
  name: 'yard_loan_records',
  key: (record) => ({
    partition: yardLoanPartition(record.deskId),
    id:
      record.kind === 'loan'
        ? `loan|${record.itemId}`
        : record.kind === 'audit'
          ? auditRecordId(record.event.id)
          : `mail|${record.job.id}`,
  }),
  codec: {
    encode: (record): StoredRecord => {
      if (record.kind === 'loan') {
        return {
          kind: 'loan',
          deskId: record.deskId,
          itemId: record.itemId,
          borrowerPrincipalId: record.borrowerPrincipalId,
          status: record.status,
        };
      }
      if (record.kind === 'audit') {
        return {
          kind: 'audit',
          deskId: record.deskId,
          ...encodeAuditEvent(record.event),
        };
      }
      return {
        kind: 'mail',
        deskId: record.deskId,
        jobId: record.job.id,
        callerMetadata: record.callerMetadata,
        job: JSON.stringify(record.job),
      };
    },
    decode: (raw): YardLoanRecord => {
      const kind = String(raw['kind'] ?? '');
      if (kind === 'loan') {
        return {
          kind: 'loan',
          deskId: String(raw['deskId']),
          itemId: String(raw['itemId']),
          borrowerPrincipalId: String(raw['borrowerPrincipalId']) as PrincipalId,
          status: String(raw['status']) as 'checked_out' | 'returned',
        };
      }
      if (kind === 'audit') {
        return {
          kind: 'audit',
          deskId: String(raw['deskId']),
          event: decodeAuditEvent(raw),
        };
      }
      if (kind === 'mail') {
        const jobJson = raw['job'];
        if (typeof jobJson !== 'string') {
          throw new TypeError('yard loan mail row missing job payload');
        }
        return {
          kind: 'mail',
          deskId: String(raw['deskId']),
          job: JSON.parse(jobJson) as MailJob,
          callerMetadata: String(raw['callerMetadata'] ?? ''),
        };
      }
      throw new TypeError(`unknown yard loan record kind: ${kind}`);
    },
  },
});

export interface YardLoanComposition {
  readonly store: Store;
  readonly records: CollectionStore<YardLoanRecord>;
  readonly audit: AuditLog<YardLoanRecord>;
  readonly mail: Mail<YardLoanRecord>;
  readonly deskId: string;
  readonly partition: string;
}

export interface CheckoutInput {
  readonly itemId: string;
  readonly borrowerPrincipalId: PrincipalId;
  readonly actorPrincipalId: PrincipalId;
  readonly auditEventId: string;
  readonly mailJobId: string;
  readonly occurredAt: IsoTimestamp;
}

/**
 * Explicit composition root for one Yard Loan desk partition.
 */
export function createYardLoanComposition(
  deskId: string,
  store: Store = createMemoryStore(),
): YardLoanComposition {
  const partition = yardLoanPartition(deskId);
  const records = store.collection(yardLoanRecords);

  const audit = defineAudit<YardLoanRecord>({
    collection: yardLoanRecords,
    toRecord: (event) => ({ kind: 'audit', deskId, event }),
    toEvent: (record) => (record.kind === 'audit' ? record.event : null),
  });

  const mail = defineMail<YardLoanRecord>({
    collection: yardLoanRecords,
    key: ({ partition: p, jobId }) => ({
      partition: p,
      id: `mail|${jobId}`,
    }),
    toRecord: (job, previous) =>
      previous?.kind === 'mail'
        ? { ...previous, job }
        : {
            kind: 'mail',
            deskId,
            job,
            callerMetadata: 'yard-loan-checkout-notice',
          },
    toJob: (record) => (record.kind === 'mail' ? record.job : null),
  });

  return Object.freeze({
    store,
    records,
    audit,
    mail,
    deskId,
    partition,
  });
}

export interface CheckoutResult {
  readonly committed: boolean;
  readonly reason?: string;
}

/**
 * Checkout: inventory row + audit event + mail outbox job in one transact.
 * If the transaction refuses, there is no orphan audit or pending mail.
 */
export async function checkoutEquipment(
  composition: YardLoanComposition,
  input: CheckoutInput,
): Promise<CheckoutResult> {
  const { deskId, partition, records, audit, mail } = composition;

  const outcome = await records.transact(partition, [
    {
      action: 'insert',
      value: {
        kind: 'loan',
        deskId,
        itemId: input.itemId,
        borrowerPrincipalId: input.borrowerPrincipalId,
        status: 'checked_out',
      },
    },
    audit.action({
      id: input.auditEventId,
      occurredAt: input.occurredAt,
      actor: {
        kind: 'principal',
        principalId: input.actorPrincipalId,
      },
      action: 'yard_loan.item.checked_out',
      subject: input.itemId,
      details: {
        borrower: input.borrowerPrincipalId,
      },
    }),
    mail.action({
      partition,
      id: input.mailJobId,
      recipientRef: input.borrowerPrincipalId,
      contentRef: `yard_loan.checkout:${input.itemId}`,
      createdAt: input.occurredAt,
    }),
  ]);

  if (!outcome.committed) {
    return { committed: false, reason: outcome.reason };
  }
  return { committed: true };
}
