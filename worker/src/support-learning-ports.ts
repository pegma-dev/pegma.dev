import type { AccessContext } from '@pegma/authorization-core';
import {
  KnowledgeBaseNotFoundError,
  RepositoryConflictError,
  type KnowledgeBaseApplication,
} from '@pegma/knowledge-base-application';
import {
  KnowledgeBaseNotFoundError as LearningKnowledgeNotFoundError,
  RepositoryConflictError as LearningRepositoryConflictError,
} from '@pegma/knowledge-base-ai-compat';
import type {
  LearningKnowledgeApplication,
  SupportDeskLearningOptions,
} from '@pegma/support-desk-ai';

/** A host resolver must read current facts and honor cancellation. */
export interface SupportLearningStaffAccess {
  resolve(
    principalId: string,
    signal: AbortSignal,
  ): Promise<AccessContext | null>;
}

/** These are trusted server ports, never a browser or model response envelope. */
export type SupportLearningProcessingPorts = Pick<
  SupportDeskLearningOptions,
  | 'serviceAccess'
  | 'knowledgeAccess'
  | 'retirementAccess'
  | 'configuration'
  | 'checks'
  | 'model'
  | 'usage'
  | 'targets'
  | 'tokenCounter'
>;

export type DirectLearningKnowledge = Pick<
  KnowledgeBaseApplication,
  keyof LearningKnowledgeApplication
>;

/**
 * AI 0.2.1 recognizes its exact KB 0.1.2 error constructors. The alias is a
 * public registry dependency, not another application, Store or policy model.
 * Translate only the two recognized direct-KB errors; never disclose a private
 * resource name, message or cause through the compatibility boundary.
 */
export function createSupportLearningKnowledgePort(
  application: DirectLearningKnowledge,
): LearningKnowledgeApplication {
  async function call<Result>(operation: () => Promise<Result>): Promise<Result> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof KnowledgeBaseNotFoundError)
        throw new LearningKnowledgeNotFoundError('knowledge_resource');
      if (error instanceof RepositoryConflictError)
        throw new LearningRepositoryConflictError();
      throw error;
    }
  }
  return Object.freeze<LearningKnowledgeApplication>({
    searchPublishedArticles: (access, input) =>
      call(() => application.searchPublishedArticles(access, input)),
    getPublishedArticle: (access, input) =>
      call(() => application.getPublishedArticle(access, input)),
    getDraft: (access, input) => call(() => application.getDraft(access, input)),
    getProvenance: (access, input) =>
      call(() => application.getProvenance(access, input)),
    getValidationRequirements: (access, input) =>
      call(() => application.getValidationRequirements(access, input)),
    createDraft: (access, input) =>
      call(() => application.createDraft(access, input)),
    updateDraft: (access, input) =>
      call(() => application.updateDraft(access, input)),
    retireArticle: (access, input) =>
      call(() => application.retireArticle(access, input)),
  });
}

export type SupportLearningStaffOperation =
  | 'enroll'
  | 'verified_fix'
  | 'review'
  | 'invalidate'
  | 'withdraw';

function identifier(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new TypeError('Invalid learning command identity');
  return value;
}

/**
 * Retain the exact client identifier. Only the server correlation identity is
 * derived. Its domain includes the authenticated actor, operation and ticket;
 * a new HTTP attempt cannot accidentally change the SDK command fingerprint.
 * This digest is an operation identity, never authentication or a credential.
 */
export async function supportLearningCommandIdentity(input: {
  readonly principalId: string;
  readonly ticketId: string;
  readonly operation: SupportLearningStaffOperation;
  readonly clientCommandId: string;
}): Promise<{
  readonly commandId: string;
  readonly correlationId: string;
}> {
  const actor = identifier(input.principalId);
  const ticket = identifier(input.ticketId);
  const commandId = identifier(input.clientCommandId);
  const operation = input.operation;
  if (
    !['enroll', 'verified_fix', 'review', 'invalidate', 'withdraw'].includes(
      operation,
    )
  )
    throw new TypeError('Invalid learning operation');
  const bytes = new TextEncoder().encode(
    JSON.stringify(['pegma.support-learning.command.v1', actor, ticket, operation, commandId]),
  );
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hash = Array.from(digest, (part) => part.toString(16).padStart(2, '0')).join('');
  return Object.freeze({ commandId, correlationId: `learning:${hash}` });
}
