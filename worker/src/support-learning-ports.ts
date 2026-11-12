import type { AccessContext } from "@pegma/authorization-core";
import type { KnowledgeBaseApplication } from "@pegma/knowledge-base-application";
import type {
  LearningKnowledgeApplication,
  SupportDeskLearningOptions,
} from "@pegma/support-desk-ai";

/** A host resolver must read current facts and honor cancellation. */
export interface SupportLearningStaffAccess {
  resolve(
    principalId: string,
    signal: AbortSignal,
  ): Promise<AccessContext | null>;
}

/** Durable review admission is explicitly opt-in and independent of model generation. */
export interface SupportLearningStagedReviewOptions {
  readonly enabled: () => boolean;
  /** Best-effort acceleration after durable SDK admission; never review authority. */
  readonly enqueue: (key: {
    readonly ticketId: string;
    readonly commandId: string;
  }) => Promise<void>;
}

/** These are trusted server ports, never a browser or model response envelope. */
export type SupportLearningProcessingPorts = Pick<
  SupportDeskLearningOptions,
  | "serviceAccess"
  | "knowledgeAccess"
  | "retirementAccess"
  | "configuration"
  | "checks"
  | "model"
  | "usage"
  | "targets"
  | "tokenCounter"
>;

export type DirectLearningKnowledge = Pick<
  KnowledgeBaseApplication,
  keyof LearningKnowledgeApplication
>;

/**
 * Support 0.2.7 uses the same exact KB 0.1.6 public contracts as this host.
 * Forward the narrow capability surface and preserve actual error identity.
 */
export function createSupportLearningKnowledgePort(
  application: DirectLearningKnowledge,
): LearningKnowledgeApplication {
  async function call<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    return operation();
  }
  return Object.freeze<LearningKnowledgeApplication>({
    searchPublishedArticles: (access, input) =>
      call(() => application.searchPublishedArticles(access, input)),
    getPublishedArticle: (access, input) =>
      call(() => application.getPublishedArticle(access, input)),
    getDraft: (access, input) =>
      call(() => application.getDraft(access, input)),
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
  | "enroll"
  | "verified_fix"
  | "successful_test"
  | "review"
  | "invalidate"
  | "withdraw";

function identifier(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 200 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  )
    throw new TypeError("Invalid learning command identity");
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
    ![
      "enroll",
      "verified_fix",
      "successful_test",
      "review",
      "invalidate",
      "withdraw",
    ].includes(operation)
  )
    throw new TypeError("Invalid learning operation");
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      "pegma.support-learning.command.v1",
      actor,
      ticket,
      operation,
      commandId,
    ]),
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hash = Array.from(digest, (part) =>
    part.toString(16).padStart(2, "0"),
  ).join("");
  return Object.freeze({ commandId, correlationId: `learning:${hash}` });
}
