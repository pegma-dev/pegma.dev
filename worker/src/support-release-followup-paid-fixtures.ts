import {
  supportReleaseFollowupRoutePolicySha256,
  type ApprovedSupportReleaseFollowupRoute,
} from '@pegma/support-desk-ai/openrouter';
import { independentCheckRoutePolicyHash } from './support-independent-checks-model';
import {
  paidBootstrapFixture,
  PAID_START,
  PAID_END,
} from './support-paid-bootstrap-fixtures';

/** Fictional operator evidence and intercepted transport only. Nothing here is
 * provider approval, production configuration, or a model quality result. */
export async function supportFollowupPaidFixture() {
  const base = await paidBootstrapFixture();
  const source = {
    ...base.source,
    testEvidence: { retentionMilliseconds: 300000 },
  };
  const checkBase = {
    ...base.profile.checks.route,
    releaseFollowup: {
      purpose: 'support_release_followup' as const,
      wireVersion: 'openrouter-support-release-followup-check-v1' as const,
      evidenceRef: 'fictional-followup-check-qualification',
      verifiedAt: PAID_START,
      validUntil: PAID_END,
    },
  };
  const { approval: checkApproval, ...unsignedChecks } = checkBase;
  const checks = {
    ...base.profile.checks,
    route: {
      ...unsignedChecks,
      approval: {
        ...checkApproval,
        requestPolicySha256:
          await independentCheckRoutePolicyHash(unsignedChecks),
      },
    },
  };
  const original = base.profile.learning.route.configuration;
  const configuration: ApprovedSupportReleaseFollowupRoute['configuration'] = {
    ...original,
    purpose: 'support_release_followup',
    version: 'fictional-followup-configuration',
    parserVersion: 'fictional-followup-parser',
    evaluationVersion: 'fictional-followup-evaluation-v1',
    dataControls: {
      ...original.dataControls,
      purpose: 'support_release_followup',
      configurationBinding: 'fictional-followup-configuration',
    },
  };
  const unsigned: Omit<ApprovedSupportReleaseFollowupRoute, 'approval'> = {
    ...unsignedChecks,
    purpose: 'support_release_followup',
    usageScopeRef: 'fictional-followup-generation-pool',
    configuration,
    evaluation: {
      version: configuration.evaluationVersion,
      artifactRef: 'fictional-followup-evaluation',
      modelVersion: configuration.modelVersion,
      promptVersion: configuration.promptVersion,
      parserVersion: configuration.parserVersion,
      verifiedAt: PAID_START,
      validUntil: PAID_END,
    },
  };
  // The check-only qualifier is not a field of a generator route.
  Reflect.deleteProperty(unsigned, 'releaseFollowup');
  const route: ApprovedSupportReleaseFollowupRoute = {
    ...unsigned,
    approval: {
      ...base.profile.learning.route.approval,
      wireVersion: 'openrouter-support-release-followup-v1',
      configurationVersion: configuration.version,
      evaluationRef: unsigned.evaluation.artifactRef,
      requestPolicySha256:
        await supportReleaseFollowupRoutePolicySha256(unsigned),
    },
  };
  const releaseFollowup = {
    route,
    qualification: {
      ...base.profile.learning.qualification,
      wireVersion: 'openrouter-support-release-followup-v1',
    },
    usagePolicy: {
      ...base.profile.learning.usagePolicy,
      scopeRef: route.usageScopeRef,
      version: 'fictional-followup-generation-pool-v1',
      configurationVersion: configuration.version,
    },
    target: { kind: 'none' as const },
  };
  const { learning: _learning, ...rest } = base.profile;
  const profile = { ...rest, checks, releaseFollowup };
  const env = {
    ...base.env,
    SUPPORT_PAID_CONFIGURATION_JSON: JSON.stringify(profile),
    SUPPORT_LEARNING_SOURCE_CONFIGURATION_JSON: JSON.stringify(source),
    PEGMA_SUPPORT_LEARNING_INTAKE_ENABLED: 'false',
    PEGMA_SUPPORT_LEARNING_WORKER_ENABLED: 'false',
    PEGMA_SUPPORT_RELEASE_FOLLOWUP_ENABLED: 'true',
    PEGMA_SUPPORT_RELEASE_FOLLOWUP_PROCESSING_ENABLED: 'true',
  };
  return { ...base, source, profile, env };
}

export function followupProviderResponse(output: unknown) {
  return Response.json({
    id: 'gen-fictional-followup',
    object: 'chat.completion',
    created: 1,
    model: 'openai/gpt-4.1-mini',
    provider: 'Azure',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: JSON.stringify(output) },
      },
    ],
    usage: {
      prompt_tokens: 200,
      completion_tokens: 100,
      total_tokens: 300,
      cost: 0.0001,
      currency: 'USD',
      is_byok: false,
      prompt_tokens_details: {
        cached_tokens: 0,
        audio_tokens: 0,
        video_tokens: 0,
      },
      completion_tokens_details: {
        reasoning_tokens: 0,
        image_tokens: 0,
        audio_tokens: 0,
      },
    },
  });
}
