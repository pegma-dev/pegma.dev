import type {
  AssistantAttemptContext,
  AssistantUsageIdentity,
  AssistantUsagePort,
} from '@pegma/support-desk-ai';
import {
  createSupportModelUsageLedger,
  usageText as text,
  usageInteger as integer,
  type SupportModelUsageOptions,
  type SupportModelUsagePolicy,
} from './support-model-usage-ledger';

/** Immutable finite answering pool; no rotation or top-up is implicit. */
export type SupportAssistantUsagePolicy = SupportModelUsagePolicy;
export type SupportAssistantUsageOptions = SupportModelUsageOptions;

/** Preserve the original answering namespace, codec, policy hash and context binding. */
export function createSupportAssistantUsage(
  options: SupportAssistantUsageOptions,
): AssistantUsagePort {
  return createSupportModelUsageLedger<
    AssistantAttemptContext,
    AssistantUsageIdentity
  >(options, {
    purpose: 'support_answer',
    collection: 'pegma.support-assistant-usage.v1',
    key: { partition: 'support_answer', id: 'budget' },
    identity: (input) => input,
    binding(context) {
      const fence = context.fence;
      if (
        context.attemptId !== fence.attemptId ||
        context.attempt !== fence.attempt
      )
        return undefined;
      if (
        !Array.isArray(context.allSourceReferences) ||
        context.allSourceReferences.length > 5
      )
        return undefined;
      const references = context.allSourceReferences.map((reference) => [
        text(reference.articleId),
        text(reference.collectionId),
        text(reference.contentHash),
        integer(reference.collectionPolicyVersion, 1),
        integer(reference.articleRevision, 1),
        integer(reference.applicationGeneration, 1),
        integer(reference.governanceGeneration, 1),
        integer(reference.validationGeneration, 1),
      ]);
      const budgets = context.budgets;
      return JSON.stringify([
        context.purpose,
        integer(context.attempt, 1),
        text(context.configurationVersion),
        text(context.promptVersion),
        text(context.modelVersion),
        text(context.audienceVersion),
        text(context.policyVersion),
        text(context.usageScopeRef),
        context.deadline,
        integer(context.budgets.maxCostMicros, 1),
        context.budgets.currency,
        text(fence.commandId),
        text(fence.correlationId),
        text(fence.ticketId),
        text(fence.turnId),
        text(fence.workerId),
        text(fence.claimId),
        integer(fence.claimGeneration, 1),
        integer(fence.expectedRevision, 1),
        integer(fence.expectedHandlingGeneration),
        text(fence.triggerMessageId),
        integer(budgets.maxMessages, 1),
        integer(budgets.maxInputBytes, 1),
        integer(budgets.maxInputTokens, 1),
        integer(budgets.maxContextTokens, 1),
        integer(budgets.maxOutputBytes, 1),
        integer(budgets.maxOutputTokens, 1),
        integer(budgets.maxDurationMilliseconds, 1),
        integer(budgets.maxAttempts, 1),
        integer(budgets.maxAssistantTurns, 1),
        integer(budgets.maxMessageCharacters, 1),
        integer(budgets.maxAnswerTextCharacters, 1),
        text(context.applicability.productId),
        text(context.applicability.productVersion),
        context.applicability.buildId === undefined
          ? null
          : text(context.applicability.buildId),
        context.applicability.locale === undefined
          ? null
          : text(context.applicability.locale),
        references,
      ]);
    },
  });
}
