import {
  hasPermission,
  serializeAccessContext,
  type AccessContext,
} from '@pegma/authorization-core';
import {
  auditRecordId,
  defineAudit,
  encodeAuditEvent,
  decodeAuditEvent,
  type AuditEvent,
} from '@pegma/audit';
import {
  defineCollection,
  type Store,
  type StoredRecord,
} from '@pegma/storage-core';
import type { Clock } from '@pegma/spine';
import { knowledgeDigest as evidenceDigest } from '@pegma/knowledge-base-core';
import { knowledgePermissions } from '@pegma/knowledge-base-contracts';
import type {
  GovernanceConfigurationDto,
  KnowledgeBaseApplication,
  KnowledgeEvidenceReports,
} from '@pegma/knowledge-base-application';
import {
  KnowledgeEvidenceReportsError,
  KnowledgeEvidenceReportsUnavailableError,
} from '@pegma/knowledge-base-application';
import {
  engineeringFollowupRetestProductBinding,
  engineeringFollowupRetestRequestHash,
  supportPermissions,
  type EngineeringFollowupRetestBinding,
  type EngineeringFollowupRetestPort,
  type SupportDeskApplication,
} from '@pegma/support-desk-application';
import { z } from 'zod';
import { ApiError } from './api-auth';
import { SUPPORT_ROLE } from './support-access';
import { canonical } from './support-openrouter-model';
import { knowledgeDigest } from './knowledge-evidence';
import type { SupportReleaseFollowupContext } from './support-release-followup';

const scalar = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\u0000-\u001f\u007f-\u009f]+$/u)
  .refine((value) => value.trim() === value);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const commandId = z.string().uuid({ version: 'v4' });
export const prepareSupportFollowupRetestInput = z
  .object({
    commandId,
    expectedPrincipalId: scalar,
    workId: scalar,
    expectedWorkGeneration: positive,
    expectedTicketRevision: positive,
    retestRequestId: scalar,
    report: z
      .object({
        articleId: scalar,
        ledgerEpoch: positive,
        reportId: scalar,
        expectedReportGeneration: positive,
        reviewBindingHash: z.string().regex(/^[a-f0-9]{64}$/u),
        receipt: scalar,
      })
      .strict(),
  })
  .strict();
export type PrepareSupportFollowupRetestInput = z.infer<
  typeof prepareSupportFollowupRetestInput
>;
type Binding = EngineeringFollowupRetestBinding;
const binding = z
  .object({
    ticketId: scalar,
    workId: scalar,
    workBindingHash: scalar,
    requestId: scalar,
    requestHash: scalar,
    bundleHash: scalar,
    productBinding: scalar,
  })
  .strict();
const reportContext = z
  .object({
    product: z
      .object({ productId: scalar, version: scalar, buildId: scalar })
      .strict(),
    validationRequirementIds: z.array(scalar).max(32),
  })
  .strict();
const saved = z
  .object({
    kind: z.literal('receipt'),
    ticketId: scalar,
    id: scalar,
    actorId: scalar,
    commandHash: scalar,
    inputHash: scalar,
    packet: prepareSupportFollowupRetestInput,
    binding,
    workFingerprint: scalar,
    reportFingerprint: scalar,
    reportContext,
    result: z.enum(['passed', 'failed']),
    executionId: scalar,
    runnerId: scalar,
    verifiedAt: z.string().datetime({ precision: 3 }),
    validUntil: z.string().datetime({ precision: 3 }),
  })
  .strict();
type Saved = z.infer<typeof saved>;
const intent = z
  .object({
    kind: z.literal('intent'),
    ticketId: scalar,
    id: scalar,
    actorId: scalar,
    commandHash: scalar,
    inputHash: scalar,
    packet: prepareSupportFollowupRetestInput,
    binding,
    workFingerprint: scalar,
    reportContext,
    workGeneration: positive,
  })
  .strict();
type Intent = z.infer<typeof intent>;
type Row =
  | Saved
  | Intent
  | {
      readonly kind: 'audit';
      readonly ticketId: string;
      readonly id: string;
      readonly event: AuditEvent;
    };
export const supportFollowupRetestReceipts = defineCollection<Row>({
  name: 'pegma.support-followup-retest-receipts.v1',
  key: (value) => ({ partition: value.ticketId, id: value.id }),
  codec: {
    encode(value): StoredRecord {
      if (value.kind === 'audit')
        return {
          kind: value.kind,
          ticketId: value.ticketId,
          id: value.id,
          ...encodeAuditEvent(value.event),
        };
      const checked =
        value.kind === 'intent' ? intent.parse(value) : saved.parse(value);
      const payload = JSON.stringify(checked);
      if (new TextEncoder().encode(payload).length > 16000)
        throw new TypeError('Retest receipt exceeded');
      return {
        kind: checked.kind,
        ticketId: checked.ticketId,
        id: checked.id,
        payload,
      };
    },
    decode(row) {
      if (row.kind === 'audit') {
        const event = decodeAuditEvent(row);
        if (
          event.subject !== row.ticketId ||
          auditRecordId(event.id) !== row.id
        )
          throw new TypeError('Invalid retest audit');
        return {
          kind: 'audit',
          ticketId: String(row.ticketId),
          id: String(row.id),
          event,
        };
      }
      if (
        typeof row.payload !== 'string' ||
        new TextEncoder().encode(row.payload).length > 16000
      )
        throw new TypeError('Invalid retest receipt');
      const value =
        row.kind === 'intent'
          ? intent.parse(JSON.parse(row.payload))
          : saved.parse(JSON.parse(row.payload));
      if (
        value.kind !== row.kind ||
        value.ticketId !== row.ticketId ||
        value.id !== row.id
      )
        throw new TypeError('Invalid retest identity');
      return value;
    },
  },
});
const audit = defineAudit<Row>({
  collection: supportFollowupRetestReceipts,
  toRecord: (event) => ({
    kind: 'audit',
    ticketId: event.subject,
    id: auditRecordId(event.id),
    event,
  }),
  toEvent: (row) => (row.kind === 'audit' ? row.event : null),
});
export interface SupportFollowupRetestOptions {
  /** Workers capture a body-free Work intent in a separate invocation. */
  readonly stagedPreparation?: boolean;
  readonly store: Store;
  readonly clock: Clock;
  readonly enabled: () => boolean;
  readonly application: () => SupportDeskApplication;
  readonly knowledge: () =>
    | Pick<
        KnowledgeBaseApplication,
        'getAuthoringContext' | 'confirmAuthoringContext'
      >
    | undefined;
  readonly reports: () => KnowledgeEvidenceReports | undefined;
  readonly resolvePrincipal: (
    id: string,
    signal: AbortSignal,
  ) => Promise<AccessContext | null>;
  readonly readGovernance: (
    collectionId: string,
    signal: AbortSignal,
  ) => Promise<GovernanceConfigurationDto | null>;
}

/** Purpose-bound association of a real, staff-confirmed KB test report. This
 * never confirms reports, accepts KB evidence, or turns a learning token into a retest. */
export function createSupportFollowupRetests(
  options: SupportFollowupRetestOptions,
) {
  const records = options.store.collection(supportFollowupRetestReceipts);
  let bound:
    | {
        application: SupportDeskApplication;
        knowledge: ReturnType<SupportFollowupRetestOptions['knowledge']>;
        reports: KnowledgeEvidenceReports;
      }
    | undefined;
  function boundPorts() {
    if (!options.enabled())
      throw new ApiError(503, 'followup_retest_unavailable');
    const application = options.application();
    const knowledge = options.knowledge();
    const reports = options.reports();
    if (!knowledge || !reports?.observations)
      throw new ApiError(503, 'followup_retest_unavailable');
    if (
      bound &&
      (bound.application !== application ||
        bound.knowledge !== knowledge ||
        bound.reports !== reports)
    )
      throw new ApiError(503, 'followup_retest_unavailable');
    bound ??= { application, knowledge, reports };
    return {
      application,
      knowledge,
      reports,
      observations: reports.observations,
    };
  }
  function ports(signal: AbortSignal) {
    if (signal.aborted) throw new ApiError(503, 'followup_retest_unavailable');
    return boundPorts();
  }
  function permit(access: AccessContext) {
    if (
      !access.roles.includes(SUPPORT_ROLE) ||
      [
        supportPermissions.engineeringFollowupEvidenceSubmit,
        supportPermissions.engineeringFollowupRead,
        supportPermissions.queueRead,
        knowledgePermissions.draftRead,
        knowledgePermissions.evidenceRead,
      ].some((permission) => !hasPermission(access, permission))
    )
      throw new ApiError(403, 'forbidden');
  }
  const stamp = (access: AccessContext) =>
    canonical(serializeAccessContext(access));
  async function reportRead<Value>(read: () => Promise<Value>) {
    try {
      return await read();
    } catch (error) {
      if (error instanceof KnowledgeEvidenceReportsUnavailableError)
        throw new ApiError(503, 'followup_retest_unavailable');
      if (error instanceof KnowledgeEvidenceReportsError)
        throw new ApiError(
          error.code === 'forbidden' ? 403 : 409,
          'followup_retest_changed',
        );
      throw error;
    }
  }
  async function workFacts(
    access: AccessContext,
    ticketId: string,
    packet: PrepareSupportFollowupRetestInput,
    signal: AbortSignal,
  ) {
    permit(access);
    const actual = ports(signal);
    const key = { ticketId, workId: packet.workId };
    const [work, ticket] = await Promise.all([
      actual.application.readEngineeringFollowupWork(access, key),
      actual.application.readStaffTicket(access, ticketId),
    ]);
    const context = work.context;
    const bundle = work.preparedBundle?.bundle ?? work.handoff;
    const bundleHash =
      work.preparedBundle?.bundleHash ?? work.delivered?.bundleHash;
    const revision =
      work.delivered?.ticketRevision ?? work.acceptedTicketRevision;
    const request = bundle?.retestRequests.find(
      (value) => value.requestId === packet.retestRequestId,
    );
    if (
      work.withdrawn ||
      !context?.mapping ||
      !bundle ||
      !bundleHash ||
      !request ||
      context.issueHead.state !== 'closed' ||
      context.deploymentHead.state !== 'deployed' ||
      ticket.ticket.revision !== packet.expectedTicketRevision ||
      revision !== packet.expectedTicketRevision
    )
      throw new ApiError(409, 'followup_retest_changed');
    const productBinding =
      await engineeringFollowupRetestProductBinding(context);
    if (
      request.productBinding !== productBinding ||
      (bundle.kbProposal?.target.kind === 'article' &&
        bundle.kbProposal.target.articleId !== packet.report.articleId)
    )
      throw new ApiError(409, 'followup_retest_changed');
    const result: Binding = {
      ...key,
      workBindingHash: work.workBindingHash,
      requestId: request.requestId,
      requestHash: await engineeringFollowupRetestRequestHash(request),
      bundleHash,
      productBinding,
    };
    return {
      binding: result,
      workGeneration: work.workGeneration,
      product: context.mapping.fixedProduct,
      request,
      record: work,
      fingerprint: await knowledgeDigest({
        binding: result,
        context,
        association: work.association,
        revision,
        lastVisibleMessageId: work.lastVisibleMessageId,
        parentSourceGeneration: work.parentSourceGeneration,
        target: bundle.kbProposal?.target ?? null,
      }),
    };
  }
  async function reportFacts(
    access: AccessContext,
    packet: PrepareSupportFollowupRetestInput,
    work: {
      product: { productId: string; version: string; buildId: string };
      request: { validationRequirementIds: readonly string[] };
    },
    signal: AbortSignal,
    qualifyGovernance = true,
    deferConfirmation = false,
  ) {
    const actual = ports(signal);
    const key = {
      articleId: packet.report.articleId,
      ledgerEpoch: packet.report.ledgerEpoch,
      reportId: packet.report.reportId,
    };
    const observed = await reportRead(() =>
      actual.observations.observe(access, key),
    );
    const { view, context } = observed;
    const confirmation = view.confirmation;
    const submission = view.evidence;
    const draft = context.draft.revision;
    const requirements = context.requirements;
    const policy = qualifyGovernance
      ? await options.readGovernance(draft.collectionId, signal)
      : undefined;
    if (
      !confirmation ||
      (qualifyGovernance && !policy) ||
      view.status !== 'confirmed' ||
      view.receipt !== packet.report.receipt ||
      view.reportGeneration !== packet.report.expectedReportGeneration ||
      view.reviewBindingHash !== packet.report.reviewBindingHash ||
      !context.evidence ||
      canonical(view.draft) !== canonical(context.draft) ||
      canonical(view.requirements) !== canonical(requirements)
    )
      throw new ApiError(409, 'followup_retest_changed');
    const rule = requirements.checks.find(
      (value) =>
        value.id === submission.checkId &&
        value.testKind === submission.testKind,
    );
    const configuration = policy?.configuration;
    const now = Date.parse(options.clock.now());
    const executed = Date.parse(submission.executedAt);
    const confirmed = Date.parse(confirmation.confirmedAt);
    if (
      !rule ||
      !['passed', 'failed'].includes(submission.result) ||
      (configuration !== undefined &&
        !configuration.trustedAttesterIds.includes(confirmation.reviewerId)) ||
      submission.articleId !== draft.articleId ||
      submission.articleRevision !== draft.number ||
      submission.contentHash !== draft.contentHash ||
      canonical(submission.applicability) !== canonical(draft.applicability) ||
      canonical(submission.validationPolicy) !==
        canonical(requirements.validationPolicy) ||
      canonical(draft.validationPolicy) !==
        canonical(requirements.validationPolicy) ||
      (configuration !== undefined &&
        canonical(configuration.validationPolicy) !==
          canonical(requirements.validationPolicy)) ||
      (policy != null &&
        policy.generation !== requirements.governanceGeneration) ||
      (configuration !== undefined &&
        configuration.expectedStagingBuildId !==
          requirements.expectedStagingBuildId) ||
      submission.stagingBuildId !== requirements.expectedStagingBuildId ||
      submission.applicability.productId !== work.product.productId ||
      submission.applicability.productVersion !== work.product.version ||
      submission.stagingBuildId !== work.product.buildId ||
      (submission.applicability.buildId !== undefined &&
        submission.applicability.buildId !== work.product.buildId) ||
      executed < Date.parse(draft.createdAt) ||
      executed > confirmed ||
      confirmed > now ||
      now - executed > rule.maxAgeMilliseconds ||
      (await knowledgeDigest(submission)) !== view.submissionHash ||
      (await knowledgeDigest(requirements)) !== view.governanceHash ||
      (work.request.validationRequirementIds.length > 0 &&
        !work.request.validationRequirementIds.includes(submission.checkId))
    )
      throw new ApiError(409, 'followup_retest_changed');
    const attestation = {
      id: view.receipt,
      verifiedBy: confirmation.reviewerId,
      verifiedAt: confirmation.confirmedAt,
    };
    for (const revoked of context.evidence.revokedEvidence) {
      if (
        revoked.id === submission.id &&
        revoked.articleRevision === submission.articleRevision &&
        revoked.hash ===
          (await evidenceDigest({
            ...submission,
            version: revoked.version,
            attestation,
          }))
      )
        throw new ApiError(409, 'followup_retest_changed');
    }
    let consumed = false;
    async function confirm(currentSignal: AbortSignal) {
      if (consumed) throw new ApiError(409, 'followup_retest_changed');
      consumed = true;
      ports(currentSignal);
      const checked = await reportRead(() =>
        actual.observations.confirm(access, observed.observation),
      );
      // The actual pair closes the exact KB resources/report and current
      // actor/reviewer authority. Keep its handle inside this one operation.
      if (checked.receipt !== view.receipt)
        throw new ApiError(409, 'followup_retest_changed');
      ports(currentSignal);
    }
    if (!deferConfirmation) await confirm(signal);
    return {
      confirm,
      fingerprint: await knowledgeDigest({
        key,
        reportHash: view.reportHash,
        submissionHash: view.submissionHash,
        governanceHash: view.governanceHash,
        reportGeneration: view.reportGeneration,
        confirmation,
        draft: context.draft,
        requirements,
      }),
      result: submission.result as 'passed' | 'failed',
      executionId:
        'kb-retest:' +
        (await knowledgeDigest([key, submission.id, view.submissionHash])),
      runnerId: submission.runnerId,
      expiry: Math.min(executed + rule.maxAgeMilliseconds, now + 300000),
    };
  }
  function receipt(value: Saved) {
    return 'pgretest1.' + value.id.slice('receipt:'.length);
  }
  function acknowledgement(value: Saved) {
    return {
      actorId: value.actorId,
      ticketId: value.ticketId,
      commandId: value.packet.commandId,
      workId: value.packet.workId,
      retestRequestId: value.packet.retestRequestId,
      receipt: receipt(value),
      validUntil: value.validUntil,
    };
  }
  function pending(value: Intent) {
    return {
      actorId: value.actorId,
      ticketId: value.ticketId,
      commandId: value.packet.commandId,
      workId: value.packet.workId,
      retestRequestId: value.packet.retestRequestId,
      pending: 'report' as const,
    };
  }
  async function prepare(
    context: SupportReleaseFollowupContext,
    ticketId: string,
    input: PrepareSupportFollowupRetestInput,
  ) {
    const packet = prepareSupportFollowupRetestInput.parse(
      structuredClone(input),
    );
    const access = await context.current();
    permit(access);
    context.assertCurrent();
    if (access.principalId !== packet.expectedPrincipalId)
      throw new ApiError(403, 'forbidden');
    const commandHash = await knowledgeDigest([
      access.principalId,
      packet.commandId,
    ]);
    const inputHash = await knowledgeDigest({ ticketId, packet });
    const key = { partition: ticketId, id: 'receipt:' + commandHash };
    async function current() {
      const fresh = await context.current();
      permit(fresh);
      context.assertCurrent();
      if (stamp(fresh) !== stamp(access)) throw new ApiError(403, 'forbidden');
    }
    async function known() {
      const stored = await records.getVersioned(key);
      if (!stored) return undefined;
      const value = stored.value;
      if (
        value.kind === 'audit' ||
        value.inputHash !== inputHash ||
        value.actorId !== access.principalId ||
        value.commandHash !== commandHash
      )
        throw new ApiError(409, 'conflict');
      return { value, version: stored.version };
    }
    const previous = await known();
    if (previous?.value.kind === 'receipt') {
      await current();
      return acknowledgement(previous.value);
    }
    const captured =
      previous?.value.kind === 'intent' ? previous.value : undefined;
    if (options.stagedPreparation === true && captured === undefined) {
      const work = await workFacts(access, ticketId, packet, context.signal);
      if (work.workGeneration !== packet.expectedWorkGeneration)
        throw new ApiError(409, 'followup_retest_changed');
      await current();
      const value: Intent = {
        kind: 'intent',
        ticketId,
        id: key.id,
        actorId: access.principalId,
        commandHash,
        inputHash,
        packet,
        binding: work.binding,
        workFingerprint: work.fingerprint,
        workGeneration: work.workGeneration,
        reportContext: {
          product: work.product,
          validationRequirementIds: [...work.request.validationRequirementIds],
        },
      };
      let inserted = false;
      try {
        inserted = (
          await records.transact(ticketId, [
            { action: 'insert', value },
            audit.action({
              id: 'followup-retest-intent:' + commandHash,
              occurredAt: options.clock.now(),
              actor: { kind: 'principal', principalId: access.principalId },
              action: 'support.release_followup.retest.preparation_started',
              subject: ticketId,
              details: {
                workId: packet.workId,
                requestId: packet.retestRequestId,
              },
            }),
          ])
        ).committed;
      } catch {
        /* Only an exact durable intent can recover its unknown ACK. */
      }
      const durable = inserted ? value : (await known())?.value;
      if (!durable) throw new ApiError(503, 'followup_retest_unknown');
      await current();
      // This acknowledges retained coordinates only. No report pass or receipt
      // is claimed until a later invocation observes and confirms the real KB.
      return durable.kind === 'receipt'
        ? acknowledgement(durable)
        : pending(durable);
    }
    const work =
      captured === undefined
        ? await workFacts(access, ticketId, packet, context.signal)
        : {
            binding: captured.binding,
            workGeneration: captured.workGeneration,
            fingerprint: captured.workFingerprint,
            product: captured.reportContext.product,
            request: {
              validationRequirementIds:
                captured.reportContext.validationRequirementIds,
            },
          };
    if (work.workGeneration !== packet.expectedWorkGeneration)
      throw new ApiError(409, 'followup_retest_changed');
    const report = await reportFacts(access, packet, work, context.signal);
    // A staged intent retains only its admitted immutable Work binding. The
    // actual SDK consumption constructs and checks the CURRENT binding/release;
    // this report association is not a claim that SDK work was accepted.
    const closing =
      captured === undefined
        ? await workFacts(access, ticketId, packet, context.signal)
        : work;
    await current();
    if (
      closing.fingerprint !== work.fingerprint ||
      closing.workGeneration !== work.workGeneration
    )
      throw new ApiError(409, 'followup_retest_changed');
    const at = options.clock.now();
    if (Date.parse(at) >= report.expiry)
      throw new ApiError(409, 'followup_retest_changed');
    const value: Saved = {
      kind: 'receipt',
      ticketId,
      id: key.id,
      actorId: access.principalId,
      commandHash,
      inputHash,
      packet,
      binding: work.binding,
      workFingerprint: work.fingerprint,
      reportFingerprint: report.fingerprint,
      reportContext: {
        product: work.product,
        validationRequirementIds: [...work.request.validationRequirementIds],
      },
      result: report.result,
      executionId: report.executionId,
      runnerId: report.runnerId,
      verifiedAt: at,
      validUntil: new Date(report.expiry).toISOString(),
    };
    let accepted = false;
    try {
      accepted = (
        await records.transact(ticketId, [
          previous === undefined
            ? { action: 'insert', value }
            : { action: 'putIfUnchanged', value, version: previous.version },
          audit.action({
            id: 'followup-retest:' + commandHash,
            occurredAt: at,
            actor: { kind: 'principal', principalId: access.principalId },
            action: 'support.release_followup.retest.associated',
            subject: ticketId,
            details: {
              workId: packet.workId,
              requestId: packet.retestRequestId,
              articleId: packet.report.articleId,
              reportId: packet.report.reportId,
              result: report.result,
            },
          }),
        ])
      ).committed;
    } catch {
      /* Only an exact immutable receipt can recover an unknown ACK. */
    }
    const recorded = accepted ? value : (await known())?.value;
    if (recorded?.kind !== 'receipt')
      throw new ApiError(503, 'followup_retest_unknown');
    await current();
    return acknowledgement(recorded);
  }
  async function openVerification(
    reference: Parameters<EngineeringFollowupRetestPort['verify']>[0],
    expected: Parameters<EngineeringFollowupRetestPort['verify']>[1],
    signal: AbortSignal,
    deferred: boolean,
  ) {
    try {
      if (!/^pgretest1\.[a-f0-9]{64}$/u.test(reference)) return null;
      const value = await records.get({
        partition: expected.ticketId,
        id: 'receipt:' + reference.slice(10),
      });
      if (
        value?.kind !== 'receipt' ||
        canonical(value.binding) !== canonical(expected) ||
        Date.parse(value.validUntil) <= Date.parse(options.clock.now())
      )
        return null;
      const access = await options.resolvePrincipal(value.actorId, signal);
      if (!access) return null;
      permit(access);
      // The App owns current Work/accepted-association binding. The host reads
      // only its own receipt and the real KB report under the original actor.
      const report = await reportFacts(
        access,
        value.packet,
        {
          product: value.reportContext.product,
          request: {
            validationRequirementIds:
              value.reportContext.validationRequirementIds,
          },
        },
        signal,
        false,
        deferred,
      );
      ports(signal);
      if (
        report.fingerprint !== value.reportFingerprint ||
        report.result !== value.result
      )
        return null;
      const expiry = Math.min(Date.parse(value.validUntil), report.expiry);
      const assertCurrent = (): true => {
        boundPorts();
        const at = Date.parse(options.clock.now());
        if (!Number.isFinite(at) || at >= expiry)
          throw new ApiError(409, 'followup_retest_changed');
        return true;
      };
      assertCurrent();
      return Object.freeze({
        verified: {
          binding: expected,
          result: value.result,
          executionId: value.executionId,
          runnerId: value.runnerId,
          verifierReceiptId: reference,
          verifierVersion: 'pg-followup-kb-report-v1',
          verifiedAt: value.verifiedAt,
          validUntil: value.validUntil,
        },
        async confirm(currentSignal: AbortSignal) {
          await report.confirm(currentSignal);
          assertCurrent();
          // The SDK owns original cancellation and the late browser guard.
          // This assertion remains valid after its bounded inner read ends.
          return assertCurrent;
        },
      });
    } catch {
      return null;
    }
  }
  const verifier: EngineeringFollowupRetestPort = {
    async verify(reference, expected, signal) {
      const observed = await openVerification(
        reference,
        expected,
        signal,
        false,
      );
      return observed?.verified ?? null;
    },
    observe(reference, expected, signal) {
      return openVerification(reference, expected, signal, true);
    },
  };
  return Object.freeze({ prepare, verifier });
}
export type SupportFollowupRetests = ReturnType<
  typeof createSupportFollowupRetests
>;
