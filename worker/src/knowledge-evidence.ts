import type { AccessContext } from '@pegma/authorization-core';
import {
  createKnowledgeEvidenceReports,
  KnowledgeEvidenceReportsError,
  KnowledgeEvidenceReportsUnavailableError,
  type KnowledgeEvidenceReports,
  type KnowledgeEvidenceReportsOptions,
} from '@pegma/knowledge-base-application';
import { ApiError, isPlainObject } from './api-auth';
import { KNOWLEDGE_EVIDENCE_CONFIRM_PERMISSION } from './support-access';

export type {
  KnowledgeEvidenceContext,
  KnowledgeReportAcknowledgement,
  KnowledgeReportLedgerState,
  KnowledgeReportSummary,
  KnowledgeReportView,
  KnowledgeTestReport,
} from '@pegma/knowledge-base-application';

export type KnowledgeEvidenceOptions = Omit<
  KnowledgeEvidenceReportsOptions,
  'collectionName' | 'storageLayout' | 'confirmationPermission'
>;

type BrowserOperation<Method> = Method extends (
  ...args: infer Arguments
) => infer Result
  ? Arguments extends [AccessContext, unknown, ...infer Rest]
    ? (access: AccessContext, input: unknown, ...rest: Rest) => Result
    : never
  : never;

/** The public factory validates the browser's untrusted JSON inputs. */
export type KnowledgeEvidenceService = {
  readonly [Name in keyof KnowledgeEvidenceReports]: Name extends 'verifier'
    ? KnowledgeEvidenceReports[Name]
    : BrowserOperation<KnowledgeEvidenceReports[Name]>;
} & {
  /** Native component errors remain recognizable to the actual MCP dispatcher. */
  readonly agentReports: Pick<
    KnowledgeEvidenceReports,
    'report' | 'ledger' | 'status' | 'query'
  >;
};

/** Safe host diagnostic; private records and underlying errors are never exposed. */
export class KnowledgeLedgerError extends Error {
  readonly name = 'KnowledgeLedgerError';
  constructor(readonly stage: string) {
    super('Knowledge report ledger is unavailable.');
  }
}

/** Carry only an already-controlled host refusal through the shared context port. */
class HostContextError extends KnowledgeEvidenceReportsError {
  constructor(readonly failure: ApiError) {
    super('report_changed');
  }
}

function hostError(error: unknown): Error {
  if (error instanceof HostContextError) return error.failure;
  if (error instanceof KnowledgeEvidenceReportsUnavailableError)
    return new KnowledgeLedgerError(error.stage);
  if (error instanceof KnowledgeEvidenceReportsError) {
    switch (error.code) {
      case 'invalid_request':
        return new ApiError(400, error.code);
      case 'report_too_large':
        return new ApiError(413, error.code);
      case 'forbidden':
        return new ApiError(403, error.code);
      case 'report_not_found':
        return new ApiError(404, error.code);
      case 'report_target_unavailable':
        return new ApiError(404, 'not_found');
      case 'command_conflict':
      case 'report_capacity':
      case 'report_changed':
      case 'report_not_verifiable':
      case 'ledger_epoch_changed':
      case 'ledger_resetting':
      case 'ledger_changed':
      case 'ledger_epoch_exhausted':
        return new ApiError(409, error.code);
      case 'invalid_configuration':
        return new KnowledgeLedgerError('configuration');
    }
  }
  return new KnowledgeLedgerError('operation');
}

async function hostOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw hostError(error);
  }
}

/** Preserve this host's existing D1 namespace, raw keys, payloads and receipts. */
export function createKnowledgeEvidenceService(
  options: KnowledgeEvidenceOptions,
): KnowledgeEvidenceService {
  let reports: KnowledgeEvidenceReports;
  try {
    reports = createKnowledgeEvidenceReports({
      ...options,
      collectionName: 'pegma-dev.knowledge-evidence.v1',
      storageLayout: 'legacy-raw-v1',
      confirmationPermission: KNOWLEDGE_EVIDENCE_CONFIRM_PERMISSION,
      async readContext(access, articleId) {
        try {
          return await options.readContext(access, articleId);
        } catch (error) {
          if (error instanceof ApiError) throw new HostContextError(error);
          throw error;
        }
      },
    });
  } catch (error) {
    throw hostError(error);
  }
  // These assertions cross the untrusted JSON/type boundary only. The public
  // factory performs all input validation, authorization and durable operations.
  return Object.freeze<KnowledgeEvidenceService>({
    verifier: reports.verifier,
    agentReports: Object.freeze({
      report: reports.report,
      ledger: reports.ledger,
      status: reports.status,
      query: reports.query,
    }),
    query: (access, input) =>
      hostOperation(() =>
        reports.query(
          access,
          input as Parameters<KnowledgeEvidenceReports['query']>[1],
        ),
      ),
    report: (access, input) =>
      hostOperation(() =>
        reports.report(
          access,
          input as Parameters<KnowledgeEvidenceReports['report']>[1],
        ),
      ),
    status: (access, input) =>
      hostOperation(() =>
        reports.status(
          access,
          input as Parameters<KnowledgeEvidenceReports['status']>[1],
        ),
      ),
    read: (access, input) =>
      hostOperation(() =>
        reports.read(
          access,
          input as Parameters<KnowledgeEvidenceReports['read']>[1],
        ),
      ),
    list: (access, input) =>
      hostOperation(() =>
        reports.list(
          access,
          input as Parameters<KnowledgeEvidenceReports['list']>[1],
        ),
      ),
    ledger: (access, input) =>
      hostOperation(() =>
        reports.ledger(
          access,
          input as Parameters<KnowledgeEvidenceReports['ledger']>[1],
        ),
      ),
    decide: (access, input, decision) =>
      hostOperation(() =>
        reports.decide(
          access,
          input as Parameters<KnowledgeEvidenceReports['decide']>[1],
          decision,
        ),
      ),
    reset: (access, input) =>
      hostOperation(() =>
        reports.reset(
          access,
          input as Parameters<KnowledgeEvidenceReports['reset']>[1],
        ),
      ),
    drain: (access, input) =>
      hostOperation(() =>
        reports.drain(
          access,
          input as Parameters<KnowledgeEvidenceReports['drain']>[1],
        ),
      ),
  });
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

/** Shared host fingerprinting, independent of the report service's storage. */
export async function knowledgeDigest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical(value)),
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
