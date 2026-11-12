import type {
  EngineeringAttemptContext,
  EngineeringUsageIdentity,
  EngineeringUsagePort,
} from '@pegma/support-desk-ai';
import {
  createSupportModelUsageLedger,
  usageInteger as integer,
  usageText as text,
  type SupportModelUsageOptions,
  type SupportModelUsagePolicy,
} from './support-model-usage-ledger';

export type SupportEngineeringUsagePolicy = SupportModelUsagePolicy;
export type SupportEngineeringUsageOptions = SupportModelUsageOptions;

/** A purpose-isolated immutable pool. No report, proposal or authority grant is stored. */
export function createSupportEngineeringUsage(
  options: SupportEngineeringUsageOptions,
): EngineeringUsagePort {
  return createSupportModelUsageLedger<
    EngineeringAttemptContext,
    EngineeringUsageIdentity
  >(options, {
    purpose: 'support_bug_assessment',
    collection: 'pegma.support-engineering-usage.v1',
    key: { partition: 'support_bug_assessment', id: 'budget' },
    identity(input) {
      if (input.purpose !== 'support_bug_assessment')
        throw new TypeError('Invalid engineering usage purpose');
      return input;
    },
    binding(context) {
      const budgets = context.budgets;
      return JSON.stringify([
        context.purpose,
        text(context.invocationId),
        integer(context.attempt, 1),
        text(context.inputManifestHash),
        text(context.configurationVersion),
        text(context.promptVersion),
        text(context.modelVersion),
        text(context.parserVersion),
        text(context.policyVersion),
        text(context.authorityVersion),
        text(context.usageScopeRef),
        context.deadline,
        integer(budgets.maxCostMicros, 1),
        budgets.currency,
        integer(budgets.maxMessages, 1),
        integer(budgets.maxInputBytes, 1),
        integer(budgets.maxInputTokens, 1),
        integer(budgets.maxContextTokens, 1),
        integer(budgets.maxOutputBytes, 1),
        integer(budgets.maxOutputTokens, 1),
        integer(budgets.maxCandidateBytes, 1),
        integer(budgets.maxDurationMilliseconds, 1),
        integer(budgets.maxAttempts, 1),
        integer(budgets.maxRepositories, 1),
        integer(budgets.maxRepositoryBytes, 1),
      ]);
    },
  });
}
