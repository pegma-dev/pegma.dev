import type { EngineeringWorkRecord, ReviewEngineeringProposalCommand } from '@pegma/support-desk-application';
import { ApiError, boundedString, exactObject, optionalKeysObject } from './api-auth';
import { supportEngineeringCommandIdentity } from './support-engineering-ports';

/** A complete retained SDK command. Its actor binding is identity, never authority. */
export interface EngineeringReviewIntent {
  readonly actorId: string;
  readonly command: ReviewEngineeringProposalCommand;
}
const projectionBytes = 65_536;

/** Allowlist only the already checked outbound request, never full private Work. */
export async function engineeringProposalView(work: EngineeringWorkRecord, actorId: string) {
  const proposal = work.proposal;
  if (proposal === undefined || work.security !== 'ordinary')
    throw new ApiError(409, 'engineering_proposal_unavailable');
  const request = proposal.request;
  const repository = request.repository;
  const bundle = request.bundle;
  const identity = await supportEngineeringCommandIdentity({ principalId: actorId,
    ticketId: work.ticketId, operation: 'review', clientCommandId: crypto.randomUUID() });
  const intent: EngineeringReviewIntent = { actorId, command: { ...identity,
    ticketId: work.ticketId, sourceGeneration: work.sourceGeneration,
    expectedWorkGeneration: work.workGeneration, proposalHash: proposal.proposalHash, decision: 'approve' } };
  const value = {
    ticketId: work.ticketId, sourceGeneration: work.sourceGeneration, workGeneration: work.workGeneration,
    status: work.status, proposalHash: proposal.proposalHash,
    approvable: work.status === 'prepared' && work.dispatch === undefined && work.approval === undefined &&
      work.proposalNeedsRebuild !== true,
    rejectionAvailable: work.status === 'prepared' && work.dispatch === undefined && work.approval === undefined &&
      work.proposalNeedsRebuild !== true,
    request: {
      operation: request.operation,
      repository: { repositoryId: repository.repositoryId, owner: repository.owner,
        name: repository.name, visibility: repository.visibility },
      bundle: { title: bundle.title, body: bundle.body, labels: [...bundle.labels],
        ...(bundle.templateId === undefined ? {} : { templateId: bundle.templateId }),
        // These are the checked outbound references, not source evidence/receipts.
        evidenceReferences: [...bundle.evidenceReferences], exportMarker: bundle.exportMarker },
      ...(request.operation === 'link_existing_issue' ? { issueId: request.issueId, issueNumber: request.issueNumber } : {}),
    },
    intent,
  };
  // Refuse oversized views; never silently truncate what a human approves.
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > projectionBytes)
    throw new ApiError(503, 'engineering_proposal_unavailable');
  return value;
}

function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new ApiError(400, 'invalid_request');
  return value;
}

/** Only immutable command validation occurs before the SDK receipt lookup. */
export function engineeringReviewIntent(raw: unknown, ticketId: string): EngineeringReviewIntent {
  const value = exactObject(raw, ['actorId', 'command']);
  const command = optionalKeysObject(value.command,
    ['ticketId', 'sourceGeneration', 'commandId', 'correlationId', 'expectedWorkGeneration', 'proposalHash', 'decision'], ['reason']);
  if (command.ticketId !== ticketId || (command.decision !== 'approve' && command.decision !== 'reject'))
    throw new ApiError(400, 'invalid_request');
  const proposalHash = boundedString(command.proposalHash, 64, 64);
  if (!/^[a-f0-9]{64}$/u.test(proposalHash)) throw new ApiError(400, 'invalid_request');
  return { actorId: boundedString(value.actorId, 1, 200), command: {
    ticketId, sourceGeneration: positive(command.sourceGeneration),
    commandId: boundedString(command.commandId, 1, 200), correlationId: boundedString(command.correlationId, 1, 200),
    expectedWorkGeneration: positive(command.expectedWorkGeneration), proposalHash, decision: command.decision,
    ...(command.reason === undefined ? {} : { reason: boundedString(command.reason, 1, 200) }),
  } };
}
