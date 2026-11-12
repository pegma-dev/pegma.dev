import type {
  ReleaseFollowupAttemptContext,
  ReleaseFollowupUsageIdentity,
  ReleaseFollowupUsagePort,
} from '@pegma/support-desk-ai';
import {
  createSupportModelUsageLedger,
  usageInteger,
  usageText,
  type SupportModelUsageOptions,
} from './support-model-usage-ledger';

/** Separate durable purpose/pool; unknown usage stays reserved by the shared ledger. */
export function createSupportReleaseFollowupUsage(
  options: SupportModelUsageOptions,
): ReleaseFollowupUsagePort {
  return createSupportModelUsageLedger<
    ReleaseFollowupAttemptContext,
    ReleaseFollowupUsageIdentity
  >(options, {
    purpose: 'support_release_followup',
    collection: 'pegma.support-release-followup-usage.v1',
    key: { partition: 'support_release_followup', id: 'budget' },
    identity(value) {
      if (value.purpose !== 'support_release_followup')
        throw new TypeError('Invalid follow-up usage purpose');
      return value;
    },
    binding(context) {
      return JSON.stringify([
        context.purpose,
        usageText(context.invocationId),
        usageInteger(context.attempt, 1),
        usageText(context.inputManifestHash),
        usageText(context.configurationVersion),
        usageText(context.promptVersion),
        usageText(context.modelVersion),
        usageText(context.parserVersion),
        usageText(context.evaluationVersion),
        usageText(context.checkPolicyVersion),
        usageText(context.authorityVersion),
        usageText(context.usageScopeRef),
        context.deadline,
        context.budgets,
      ]);
    },
  });
}
