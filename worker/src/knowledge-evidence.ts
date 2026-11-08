import { hasPermission, type AccessContext } from '@pegma/authorization-core';
import { auditEvent } from '@pegma/audit';
import type { EvidenceSubmission } from '@pegma/knowledge-base-core';
import {
  knowledgePermissions,
  type Applicability,
  type ArticleRevision,
  type Clock,
  type PrincipalId,
} from '@pegma/knowledge-base-contracts';
import type {
  DraftArticleDto,
  EvidenceDto,
  EvidenceVerifier,
  ValidationRequirementsDto,
} from '@pegma/knowledge-base-application';
import { defineCollection, type Store } from '@pegma/storage-core';
import {
  ApiError,
  boundedString,
  exactObject,
  isPlainObject,
  optionalKeysObject,
} from './api-auth';
import { KNOWLEDGE_EVIDENCE_CONFIRM_PERMISSION } from './support-access';

const MAX_REPORTS = 16;
const MAX_ROWS = 160;
const MAX_RECORD_BYTES = 60_000;

/** Only host confirmation data lives here; articles remain in the released KB. */
interface LedgerRow {
  readonly articleId: string;
  readonly id: string;
  readonly payload: string;
}
export const knowledgeEvidenceRecords = defineCollection<LedgerRow>({
  name: 'pegma-dev.knowledge-evidence.v1',
  key: (row) => ({ partition: row.articleId, id: row.id }),
  codec: {
    encode: (row) => ({
      articleId: row.articleId,
      id: row.id,
      payload: row.payload,
    }),
    decode: (row) => ({
      articleId: scalar(row.articleId),
      id: scalar(row.id),
      payload: boundedString(row.payload, 1, MAX_RECORD_BYTES, {
        allowMultiline: true,
      }),
    }),
  },
});

export interface KnowledgeTestReport {
  readonly summary: string;
  readonly details: string;
}
export interface KnowledgeReportAcknowledgement {
  readonly reportId: string;
  readonly receipt: string;
  readonly reportGeneration: number;
}
export interface KnowledgeReportSummary {
  readonly reportId: string;
  readonly articleId: string;
  readonly reportGeneration: number;
  readonly status: 'pending' | 'confirmed' | 'rejected';
  readonly submittedBy: PrincipalId;
  readonly submittedAt: string;
  readonly summary: string;
}
interface Confirmation {
  readonly reviewerId: PrincipalId;
  readonly confirmedAt: string;
}
interface ReportRecord extends Omit<KnowledgeReportSummary, 'summary'> {
  readonly evidence: EvidenceSubmission;
  readonly report: KnowledgeTestReport;
  readonly submissionHash: string;
  readonly reportHash: string;
  readonly articleHash: string;
  readonly governanceHash: string;
  readonly confirmation: Confirmation | null;
}
export interface KnowledgeEvidenceContext {
  readonly draft: DraftArticleDto;
  readonly requirements: ValidationRequirementsDto;
  readonly evidence?: EvidenceDto;
}
export interface KnowledgeReportView extends KnowledgeReportSummary {
  readonly evidence: EvidenceSubmission;
  readonly report: KnowledgeTestReport;
  readonly reportHash: string;
  readonly submissionHash: string;
  readonly governanceHash: string;
  readonly draft: DraftArticleDto;
  readonly requirements: ValidationRequirementsDto;
  readonly reviewBindingHash: string;
  readonly expectedReportGeneration: number;
  readonly confirmation: Confirmation | null;
}
export interface KnowledgeEvidenceOptions {
  readonly store: Store;
  readonly clock: Clock;
  readonly resolvePrincipal: (id: PrincipalId) => Promise<AccessContext | null>;
  /** A read-only, current view of actual released KB records. */
  readonly readContext: (
    access: AccessContext,
    articleId: string,
  ) => Promise<KnowledgeEvidenceContext>;
}
export interface KnowledgeEvidenceService {
  readonly verifier: EvidenceVerifier;
  report(
    access: AccessContext,
    input: unknown,
  ): Promise<KnowledgeReportAcknowledgement>;
  status(
    access: AccessContext,
    input: unknown,
  ): Promise<
    KnowledgeReportAcknowledgement & {
      readonly status: KnowledgeReportSummary['status'];
    }
  >;
  list(
    access: AccessContext,
    input: unknown,
  ): Promise<{ readonly reports: readonly KnowledgeReportSummary[] }>;
  read(access: AccessContext, input: unknown): Promise<KnowledgeReportView>;
  decide(
    access: AccessContext,
    input: unknown,
    decision: 'confirmed' | 'rejected',
  ): Promise<KnowledgeReportAcknowledgement>;
}

function scalar(value: unknown, maximum = 200): string {
  return boundedString(value, 1, maximum);
}
function positive(value: unknown, minimum = 1): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum
  )
    throw new ApiError(400, 'invalid_request');
  return value;
}
function timestamp(value: unknown): string {
  const text = scalar(value, 32);
  if (
    !Number.isFinite(Date.parse(text)) ||
    new Date(text).toISOString() !== text
  )
    throw new ApiError(400, 'invalid_request');
  return text;
}
function hash(value: unknown): string {
  const text = scalar(value, 64);
  if (!/^[a-f0-9]{64}$/u.test(text)) throw new ApiError(400, 'invalid_request');
  return text;
}
function array(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new ApiError(400, 'invalid_request');
  return value;
}
function applicability(value: unknown): Applicability {
  const object = optionalKeysObject(
    value,
    ['productId', 'productVersion'],
    ['buildId', 'locale'],
  );
  return {
    productId: scalar(object.productId),
    productVersion: scalar(object.productVersion),
    ...(object.buildId === undefined
      ? {}
      : { buildId: scalar(object.buildId) }),
    ...(object.locale === undefined ? {} : { locale: scalar(object.locale) }),
  };
}
export function parseKnowledgeEvidence(value: unknown): EvidenceSubmission {
  const input = exactObject(value, [
    'id',
    'articleId',
    'articleRevision',
    'contentHash',
    'validationPolicy',
    'checkId',
    'testKind',
    'applicability',
    'stagingBuildId',
    'steps',
    'result',
    'executedAt',
    'runnerId',
    'artifacts',
  ]);
  const policy = exactObject(input.validationPolicy, ['id', 'version']);
  if (
    input.result !== 'passed' &&
    input.result !== 'failed' &&
    input.result !== 'inconclusive'
  )
    throw new ApiError(400, 'invalid_request');
  const steps = array(input.steps, 16).map((step) => scalar(step, 1000));
  if (steps.length === 0) throw new ApiError(400, 'invalid_request');
  return {
    id: scalar(input.id),
    articleId: scalar(input.articleId),
    articleRevision: positive(input.articleRevision),
    contentHash: hash(input.contentHash),
    validationPolicy: {
      id: scalar(policy.id),
      version: positive(policy.version),
    },
    checkId: scalar(input.checkId),
    testKind: scalar(input.testKind, 64),
    applicability: applicability(input.applicability),
    stagingBuildId: scalar(input.stagingBuildId),
    steps,
    result: input.result,
    executedAt: timestamp(input.executedAt),
    runnerId: scalar(input.runnerId),
    artifacts: array(input.artifacts, 8).map((item) => {
      const artifact = exactObject(item, ['id', 'hash']);
      return { id: scalar(artifact.id), hash: hash(artifact.hash) };
    }),
  };
}
function parseReport(value: unknown): KnowledgeTestReport {
  const report = exactObject(value, ['summary', 'details']);
  return {
    summary: scalar(report.summary, 1000),
    details: boundedString(report.details, 1, 16_000, { allowMultiline: true }),
  };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (isPlainObject(value))
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
        .join(',') +
      '}'
    );
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return JSON.stringify(value);
  throw new TypeError('Unsupported knowledge evidence value.');
}
export async function knowledgeDigest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical(value)),
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
function row(articleId: string, id: string, value: unknown): LedgerRow {
  const payload = canonical(value);
  if (new TextEncoder().encode(payload).byteLength > MAX_RECORD_BYTES)
    throw new ApiError(413, 'report_too_large');
  return { articleId, id, payload };
}
function decodeReport(payload: string): ReportRecord {
  const value: unknown = JSON.parse(payload);
  const item = exactObject(value, [
    'reportId',
    'articleId',
    'reportGeneration',
    'status',
    'submittedBy',
    'submittedAt',
    'evidence',
    'report',
    'submissionHash',
    'reportHash',
    'articleHash',
    'governanceHash',
    'confirmation',
  ]);
  if (
    item.status !== 'pending' &&
    item.status !== 'confirmed' &&
    item.status !== 'rejected'
  )
    throw new TypeError('Invalid evidence ledger.');
  let confirmation: Confirmation | null = null;
  if (item.confirmation !== null) {
    const proof = exactObject(item.confirmation, ['reviewerId', 'confirmedAt']);
    confirmation = {
      reviewerId: scalar(proof.reviewerId),
      confirmedAt: timestamp(proof.confirmedAt),
    };
  }
  if ((item.status === 'confirmed') !== (confirmation !== null))
    throw new TypeError('Invalid evidence ledger.');
  return {
    reportId: scalar(item.reportId),
    articleId: scalar(item.articleId),
    reportGeneration: positive(item.reportGeneration),
    status: item.status,
    submittedBy: scalar(item.submittedBy),
    submittedAt: timestamp(item.submittedAt),
    evidence: parseKnowledgeEvidence(item.evidence),
    report: parseReport(item.report),
    submissionHash: hash(item.submissionHash),
    reportHash: hash(item.reportHash),
    articleHash: hash(item.articleHash),
    governanceHash: hash(item.governanceHash),
    confirmation,
  };
}
function summary(report: ReportRecord): KnowledgeReportSummary {
  return {
    reportId: report.reportId,
    articleId: report.articleId,
    reportGeneration: report.reportGeneration,
    status: report.status,
    submittedBy: report.submittedBy,
    submittedAt: report.submittedAt,
    summary: report.report.summary,
  };
}
function acknowledgement(report: ReportRecord): KnowledgeReportAcknowledgement {
  return {
    reportId: report.reportId,
    receipt: report.reportId,
    reportGeneration: report.reportGeneration,
  };
}

/** Stored human review is the trust root; a bearer token alone never confirms. */
export function createKnowledgeEvidenceService(
  options: KnowledgeEvidenceOptions,
): KnowledgeEvidenceService {
  const records = options.store.collection(knowledgeEvidenceRecords);
  async function current(
    access: AccessContext,
    permission: string,
  ): Promise<AccessContext> {
    const resolved = await options.resolvePrincipal(access.principalId);
    if (
      resolved === null ||
      resolved.principalId !== access.principalId ||
      !hasPermission(access, permission) ||
      !hasPermission(resolved, permission) ||
      access.permissions.some((grant) => !hasPermission(resolved, grant))
    )
      throw new ApiError(403, 'forbidden');
    return access;
  }
  async function staff(access: AccessContext): Promise<AccessContext> {
    const fresh = await current(access, KNOWLEDGE_EVIDENCE_CONFIRM_PERMISSION);
    for (const permission of [
      knowledgePermissions.draftRead,
      knowledgePermissions.evidenceRead,
    ])
      if (!hasPermission(fresh, permission))
        throw new ApiError(403, 'forbidden');
    return fresh;
  }
  async function load(
    articleId: string,
    reportId: string,
  ): Promise<ReportRecord> {
    const stored = await records.get({
      partition: articleId,
      id: 'report:' + reportId,
    });
    if (stored === null) throw new ApiError(404, 'report_not_found');
    const report = decodeReport(stored.payload);
    if (report.articleId !== articleId || report.reportId !== reportId)
      throw new TypeError('Invalid evidence ledger identity.');
    return report;
  }
  async function contextHashes(
    context: KnowledgeEvidenceContext,
  ): Promise<{ articleHash: string; governanceHash: string }> {
    return {
      articleHash: await knowledgeDigest(context.draft.revision),
      governanceHash: await knowledgeDigest(context.requirements),
    };
  }
  async function valid(
    report: ReportRecord,
    article: ArticleRevision,
    context: KnowledgeEvidenceContext,
    reviewer: AccessContext,
    at: string,
  ): Promise<boolean> {
    if (!hasPermission(reviewer, KNOWLEDGE_EVIDENCE_CONFIRM_PERMISSION))
      return false;
    if (
      report.reportHash !==
        (await knowledgeDigest({
          reportId: report.reportId,
          articleId: report.articleId,
          evidence: report.evidence,
          report: report.report,
          submittedBy: report.submittedBy,
          articleHash: report.articleHash,
          governanceHash: report.governanceHash,
        })) ||
      report.articleHash !== (await knowledgeDigest(article)) ||
      report.governanceHash !== (await contextHashes(context)).governanceHash ||
      report.submissionHash !== (await knowledgeDigest(report.evidence)) ||
      context.evidence?.revokedEvidence.some(
        (item) =>
          item.id === report.evidence.id &&
          item.articleRevision === report.evidence.articleRevision,
      )
    )
      return false;
    const submission = report.evidence;
    const requirement = context.requirements.checks.find(
      (item) =>
        item.id === submission.checkId && item.testKind === submission.testKind,
    );
    const executed = Date.parse(submission.executedAt);
    const now = Date.parse(at);
    return (
      submission.articleId === article.articleId &&
      submission.articleRevision === article.number &&
      submission.contentHash === article.contentHash &&
      (await knowledgeDigest(submission.applicability)) ===
        (await knowledgeDigest(article.applicability)) &&
      (await knowledgeDigest(submission.validationPolicy)) ===
        (await knowledgeDigest(context.requirements.validationPolicy)) &&
      (await knowledgeDigest(article.validationPolicy)) ===
        (await knowledgeDigest(context.requirements.validationPolicy)) &&
      submission.stagingBuildId ===
        context.requirements.expectedStagingBuildId &&
      (article.applicability.buildId === undefined ||
        submission.stagingBuildId === article.applicability.buildId) &&
      requirement !== undefined &&
      executed >= Date.parse(article.createdAt) &&
      executed <= now &&
      now - executed <= requirement.maxAgeMilliseconds &&
      (report.confirmation === null ||
        (Date.parse(report.confirmation.confirmedAt) >= executed &&
          Date.parse(report.confirmation.confirmedAt) <= now))
    );
  }
  async function replay(
    articleId: string,
    commandId: string,
    fingerprint: string,
  ): Promise<KnowledgeReportAcknowledgement | null> {
    const stored = await records.get({
      partition: articleId,
      id: 'command:' + (await knowledgeDigest(commandId)),
    });
    if (stored === null) return null;
    const receipt = exactObject(JSON.parse(stored.payload), [
      'fingerprint',
      'result',
    ]);
    if (receipt.fingerprint !== fingerprint)
      throw new ApiError(409, 'command_conflict');
    const result = exactObject(receipt.result, [
      'reportId',
      'receipt',
      'reportGeneration',
    ]);
    return {
      reportId: scalar(result.reportId),
      receipt: scalar(result.receipt),
      reportGeneration: positive(result.reportGeneration),
    };
  }
  async function write(
    access: AccessContext,
    commandId: string,
    fingerprint: string,
    report: ReportRecord,
    previousVersion?: string,
  ): Promise<KnowledgeReportAcknowledgement> {
    const head = await records.getVersioned({
      partition: report.articleId,
      id: 'head',
    });
    const state =
      head === null
        ? { reports: 0, rows: 1 }
        : exactObject(JSON.parse(head.value.payload), ['reports', 'rows']);
    const reports =
      positive(state.reports, 0) + (previousVersion === undefined ? 1 : 0);
    const rows =
      positive(state.rows, 1) + (previousVersion === undefined ? 3 : 2);
    if (reports > MAX_REPORTS || rows > MAX_ROWS)
      throw new ApiError(409, 'report_capacity');
    const commandKey = 'command:' + (await knowledgeDigest(commandId));
    const result = acknowledgement(report);
    const event = auditEvent({
      id: commandKey,
      occurredAt: options.clock.now(),
      actor: { kind: 'principal', principalId: access.principalId },
      action: 'knowledge.report.' + report.status,
      subject: report.articleId,
      details: {
        reportId: report.reportId,
        reportHash: report.reportHash,
        generation: report.reportGeneration,
      },
    });
    const fresh = await current(
      access,
      previousVersion === undefined
        ? knowledgePermissions.evidenceSubmit
        : KNOWLEDGE_EVIDENCE_CONFIRM_PERMISSION,
    );
    if (fresh.principalId !== access.principalId)
      throw new ApiError(403, 'forbidden');
    const headRow = row(report.articleId, 'head', { reports, rows });
    const reportRow = row(
      report.articleId,
      'report:' + report.reportId,
      report,
    );
    const outcome = await records.transact(report.articleId, [
      head === null
        ? { action: 'insert', value: headRow }
        : { action: 'putIfUnchanged', value: headRow, version: head.version },
      previousVersion === undefined
        ? { action: 'insert', value: reportRow }
        : {
            action: 'putIfUnchanged',
            value: reportRow,
            version: previousVersion,
          },
      {
        action: 'insert',
        value: row(report.articleId, commandKey, { fingerprint, result }),
      },
      {
        action: 'insert',
        value: row(report.articleId, 'audit:' + commandKey, event),
      },
    ]);
    if (!outcome.committed) {
      const accepted = await replay(report.articleId, commandId, fingerprint);
      if (accepted !== null) return accepted;
      throw new ApiError(409, 'report_changed');
    }
    return result;
  }
  async function verified(
    report: ReportRecord,
    article: ArticleRevision,
  ): Promise<boolean> {
    if (report.status !== 'confirmed' || report.confirmation === null)
      return false;
    const reviewer = await options.resolvePrincipal(
      report.confirmation.reviewerId,
    );
    if (
      reviewer === null ||
      !hasPermission(reviewer, KNOWLEDGE_EVIDENCE_CONFIRM_PERMISSION)
    )
      return false;
    const context = await options.readContext(reviewer, report.articleId);
    if (!(await valid(report, article, context, reviewer, options.clock.now())))
      return false;
    const latest = await load(report.articleId, report.reportId);
    await staff(reviewer);
    return (await knowledgeDigest(latest)) === (await knowledgeDigest(report));
  }
  const verifier: EvidenceVerifier = {
    async verify(request) {
      try {
        const report = await load(
          request.article.articleId,
          scalar(request.receipt),
        );
        if (
          request.access.principalId !== report.submittedBy ||
          (await knowledgeDigest(request.submission)) !==
            report.submissionHash ||
          !(await verified(report, request.article)) ||
          report.confirmation === null
        )
          return null;
        const reviewer = await options.resolvePrincipal(
          report.confirmation.reviewerId,
        );
        if (reviewer === null) return null;
        if (
          !request.configuration.trustedAttesterIds.includes(
            report.confirmation.reviewerId,
          )
        )
          return null;
        const context = await options.readContext(reviewer, report.articleId);
        if (
          request.configuration.expectedStagingBuildId !==
            context.requirements.expectedStagingBuildId ||
          (await knowledgeDigest(request.configuration.validationPolicy)) !==
            (await knowledgeDigest(context.requirements.validationPolicy))
        )
          return null;
        if (
          !hasPermission(
            await current(request.access, knowledgePermissions.evidenceSubmit),
            knowledgePermissions.evidenceSubmit,
          )
        )
          return null;
        await staff(reviewer);
        return {
          id: report.reportId,
          verifiedBy: report.confirmation.reviewerId,
          verifiedAt: report.confirmation.confirmedAt,
        };
      } catch {
        return null;
      }
    },
  };
  return Object.freeze({
    verifier,
    async report(access, value) {
      access = await current(access, knowledgePermissions.evidenceSubmit);
      const input = exactObject(value, [
        'commandId',
        'articleId',
        'evidence',
        'report',
      ]);
      const commandId = scalar(input.commandId);
      const articleId = scalar(input.articleId);
      const evidence = parseKnowledgeEvidence(input.evidence);
      const report = parseReport(input.report);
      if (evidence.articleId !== articleId)
        throw new ApiError(400, 'invalid_request');
      const fingerprint = await knowledgeDigest({
        actor: access.principalId,
        operation: 'report',
        commandId,
        articleId,
        evidence,
        report,
      });
      const accepted = await replay(articleId, commandId, fingerprint);
      if (accepted !== null) {
        await current(access, knowledgePermissions.evidenceSubmit);
        return accepted;
      }
      const context = await options.readContext(access, articleId);
      const hashes = await contextHashes(context);
      const reportId = crypto.randomUUID();
      const stored: ReportRecord = {
        reportId,
        articleId,
        reportGeneration: 1,
        status: 'pending',
        submittedBy: access.principalId,
        submittedAt: timestamp(options.clock.now()),
        evidence,
        report,
        submissionHash: await knowledgeDigest(evidence),
        reportHash: await knowledgeDigest({
          reportId,
          articleId,
          evidence,
          report,
          submittedBy: access.principalId,
          ...hashes,
        }),
        ...hashes,
        confirmation: null,
      };
      return write(access, commandId, fingerprint, stored);
    },
    async status(access, value) {
      access = await current(access, knowledgePermissions.evidenceSubmit);
      const input = exactObject(value, ['articleId', 'reportId']);
      const report = await load(
        scalar(input.articleId),
        scalar(input.reportId),
      );
      if (report.submittedBy !== access.principalId)
        throw new ApiError(404, 'report_not_found');
      await current(access, knowledgePermissions.evidenceSubmit);
      return { ...acknowledgement(report), status: report.status };
    },
    async list(access, value) {
      access = await staff(access);
      const input = exactObject(value, ['articleId']);
      const articleId = scalar(input.articleId);
      const rows = await records.list(articleId);
      if (rows.length > MAX_ROWS) throw new ApiError(409, 'report_capacity');
      const reports = rows
        .filter((item) => item.id.startsWith('report:'))
        .map((item) => summary(decodeReport(item.payload)));
      await staff(access);
      return { reports };
    },
    async read(access, value) {
      access = await staff(access);
      const input = exactObject(value, ['articleId', 'reportId']);
      const report = await load(
        scalar(input.articleId),
        scalar(input.reportId),
      );
      const context = await options.readContext(access, report.articleId);
      const reviewBindingHash = await knowledgeDigest({ report, context });
      await staff(access);
      return {
        ...summary(report),
        evidence: report.evidence,
        report: report.report,
        draft: context.draft,
        reportHash: report.reportHash,
        submissionHash: report.submissionHash,
        governanceHash: report.governanceHash,
        requirements: context.requirements,
        reviewBindingHash,
        expectedReportGeneration: report.reportGeneration,
        confirmation: report.confirmation,
      };
    },
    async decide(access, value, decision) {
      access = await staff(access);
      const input = exactObject(value, [
        'commandId',
        'articleId',
        'reportId',
        'expectedReportGeneration',
        'reviewBindingHash',
      ]);
      const commandId = scalar(input.commandId);
      const articleId = scalar(input.articleId);
      const reportId = scalar(input.reportId);
      const expected = positive(input.expectedReportGeneration);
      const binding = hash(input.reviewBindingHash);
      const fingerprint = await knowledgeDigest({
        actor: access.principalId,
        operation: decision,
        commandId,
        articleId,
        reportId,
        expected,
        binding,
      });
      const accepted = await replay(articleId, commandId, fingerprint);
      if (accepted !== null) {
        await staff(access);
        return accepted;
      }
      const saved = await records.getVersioned({
        partition: articleId,
        id: 'report:' + reportId,
      });
      if (saved === null) throw new ApiError(404, 'report_not_found');
      const report = decodeReport(saved.value.payload);
      if (report.status !== 'pending' || report.reportGeneration !== expected)
        throw new ApiError(409, 'report_changed');
      const context = await options.readContext(access, articleId);
      if ((await knowledgeDigest({ report, context })) !== binding)
        throw new ApiError(409, 'report_changed');
      const at = timestamp(options.clock.now());
      if (
        decision === 'confirmed' &&
        !(await valid(report, context.draft.revision, context, access, at))
      )
        throw new ApiError(409, 'report_not_verifiable');
      const latestContext = await options.readContext(
        await staff(access),
        articleId,
      );
      if (
        (await knowledgeDigest(context)) !==
        (await knowledgeDigest(latestContext))
      )
        throw new ApiError(409, 'report_changed');
      return write(
        access,
        commandId,
        fingerprint,
        {
          ...report,
          reportGeneration: report.reportGeneration + 1,
          status: decision,
          confirmation:
            decision === 'confirmed'
              ? { reviewerId: access.principalId, confirmedAt: at }
              : null,
        },
        saved.version,
      );
    },
  } satisfies KnowledgeEvidenceService);
}
