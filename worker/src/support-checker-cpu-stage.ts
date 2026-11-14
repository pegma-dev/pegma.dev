import { systemClock, type Clock } from '@pegma/spine';
import {
  createSupportIndependentCheckModel,
  INDEPENDENT_CHECK_ENDPOINT,
  INDEPENDENT_CHECK_WIRE,
  type IndependentCheckInput,
  type IndependentCheckRoute,
} from './support-independent-checks-model';
import {
  CHECKER_CPU_FIXTURE_VERSION,
  CHECKER_CPU_FROZEN,
  type CheckerCpuCaseId,
} from './support-checker-cpu-inputs';

export const CHECKER_CPU_QUEUE = 'pegma-support-checker-cpu-stage-wakeup';
export type CheckerCpuHeldReason =
  | 'input-unavailable'
  | 'input-changed'
  | 'counter-sequence'
  | 'transport-refused'
  | 'wire-changed'
  | 'configuration-unavailable'
  | 'budget-refused';
export class CheckerCpuFixtureError extends Error {
  constructor(readonly reason: CheckerCpuHeldReason) {
    super('Checker CPU fixture held');
  }
}
export type CheckerCpuProgress = 'counter-module-request' | 'counter-call';
export const CHECKER_CPU_BUDGETS = Object.freeze({
  maxMessages: 20,
  maxInputBytes: 32_768,
  maxInputTokens: 8_192,
  maxContextTokens: 16_384,
  maxOutputBytes: 8_192,
  maxOutputTokens: 768,
  maxDurationMilliseconds: 15_000,
  maxCostMicros: 35_200,
  currency: 'USD' as const,
  maxAttempts: 1 as const,
});
const START = '2026-01-01T00:00:00.000Z';
const END = '2027-01-01T00:00:00.000Z';
const MODEL_VERSION = 'fictional-cpu-gpt54-v1';
const TOKENIZER_REF = 'fictional-cpu-static-gpt54-tokenizer';
// Entirely fictional local approval; no operator route, authority or secret.
const configuration: IndependentCheckRoute['configuration'] = {
  purpose: 'support_independent_check',
  version: 'fictional-cpu-configuration-v1',
  promptVersion: 'fictional-cpu-host-policy-v3',
  modelVersion: MODEL_VERSION,
  parserVersion: 'fictional-cpu-parser-v1',
  policyVersion: 'fictional-cpu-policy-v3',
  policyBinding: 'fictional-cpu-policy-binding-v3',
  rubricVersion: 'fictional-cpu-rubric-v1',
  provider: 'Azure',
  model: 'openai/gpt-5.4',
  pricingRef: 'fictional-cpu-price-filter',
  trustedInstructions: CHECKER_CPU_FROZEN.trustedInstructions,
  framingTokens: 1_024,
  budgets: CHECKER_CPU_BUDGETS,
  dataControls: {
    status: 'verified',
    purpose: 'support_independent_check',
    configurationBinding: 'fictional-cpu-configuration-v1',
    accountRef: 'fictional-cpu-account',
    projectRef: 'fictional-cpu-project',
    endpointRef: 'fictional-cpu-in-process-endpoint',
    modelRef: 'fictional-cpu-model',
    featuresRef: 'fictional-cpu-features',
    exceptionsRef: 'fictional-cpu-no-upstream',
    intermediaryRefs: ['fictional-cpu-in-process-provider'],
    verifiedAt: START,
    validUntil: END,
  },
};
const route: IndependentCheckRoute = {
  host: 'pegma.dev',
  purpose: 'support_independent_check',
  endpoint: INDEPENDENT_CHECK_ENDPOINT,
  endpointTag: 'azure',
  outputTokenParameter: 'max_completion_tokens',
  providerSelectionScope: 'provider_group',
  providerMaxPrice: { prompt: 2.75, completion: 16.5, request: 0 },
  credentialRef: 'fictional-cpu-credential',
  usageScopeRef: 'fictional-cpu-no-funding',
  configuration,
  approval: {
    configurationVersion: configuration.version,
    wireVersion: INDEPENDENT_CHECK_WIRE,
    requestPolicySha256:
      'fcca7e57b6ce879ac926c17a3d06c9b1cc64a339bca33ce3fd3a5e18d316a19f',
    evidenceRef: 'fictional-cpu-no-operator-approval',
    effectivePolicyRef: 'fictional-cpu-scripted-policy',
    evaluationRef: 'fictional-cpu-not-quality-evidence',
    responseIdentityRef: 'fictional-cpu-scripted-response',
    tokenizerRef: TOKENIZER_REF,
    nativeCostCurrency: 'USD',
    nativeCostUnit: 'openrouter_credits_usd',
    rounding: 'ceil_micro',
    zdr: true,
    safetyRetention: false,
    inputOutputLogging: false,
    inputOutputUse: false,
    broadcast: false,
    responseCache: false,
    unreviewedFeatures: false,
    implicitCache: 'absent',
    providerSelectionScope: 'provider_group',
    verifiedAt: START,
    validUntil: END,
  },
};
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export const CHECKER_CPU_ROUTE = freeze(route);
const qualification = Object.freeze({
  model: configuration.model,
  modelVersion: MODEL_VERSION,
  wireVersion: INDEPENDENT_CHECK_WIRE,
  framingTokens: configuration.framingTokens,
  evidenceRef: TOKENIZER_REF,
  verifiedAt: START,
  validUntil: END,
});
const allowed = Object.freeze([
  Object.freeze({
    model: 'openai/gpt-5.4',
    provider: 'Azure',
    endpointTag: 'azure',
    outputTokenParameter: 'max_completion_tokens' as const,
    providerSelectionScope: 'provider_group' as const,
  }),
]);
// This output only completes the real parser/transport path; no semantic oracle.
const scriptedVerdict = Object.freeze({
  privacy: 'uncertain',
  factual: 'uncertain',
  security: 'uncertain',
  applicability: 'uncertain',
  duplication: 'uncertain',
  publicReproduction: 'not_applicable',
  findings: [],
});
function object(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
function inputFor(caseId: CheckerCpuCaseId): IndependentCheckInput {
  const frozen = CHECKER_CPU_FROZEN.cases[caseId];
  const parsed: unknown = JSON.parse(frozen.inputJson);
  if (
    !object(parsed) ||
    parsed.kind !== 'learning' ||
    parsed.trustedInstructions !== CHECKER_CPU_FROZEN.trustedInstructions
  )
    throw new CheckerCpuFixtureError('input-unavailable');
  const input = {
    trustedInstructions: CHECKER_CPU_FROZEN.trustedInstructions,
    kind: 'learning' as const,
    facts: parsed.facts,
    candidate: parsed.candidate,
    outbound: parsed.outbound,
    comparison: parsed.comparison,
  };
  if (JSON.stringify(input) !== frozen.inputJson)
    throw new CheckerCpuFixtureError('input-changed');
  return input;
}
export interface CheckerCpuActivity {
  readonly fixtureVersion: string;
  readonly caseId: CheckerCpuCaseId;
  readonly inputSha256: string;
  readonly systemSha256: string;
  readonly expectedFullInputTokens: number;
  counterCalls: number;
  counterObservations: { codeUnits: number; tokens: number }[];
  providerCalls: number;
  credentialReads: number;
  physicalCallNotifications: number;
  withinBudget: boolean;
  scriptedCompletion: boolean;
}
/** Whole real checker invocation. The only provider is this in-process function.
 * No memoized counts, store, paid configuration, environment keys or real fetch. */
export async function runCheckerCpuFixture(
  caseId: CheckerCpuCaseId,
  clock: Clock = systemClock,
  onProgress?: (phase: CheckerCpuProgress) => void,
) {
  const frozen = CHECKER_CPU_FROZEN.cases[caseId];
  const activity: CheckerCpuActivity = {
    fixtureVersion: CHECKER_CPU_FIXTURE_VERSION,
    caseId,
    inputSha256: frozen.inputSha256,
    systemSha256: CHECKER_CPU_FROZEN.systemSha256,
    expectedFullInputTokens: frozen.expectedFullInputTokens,
    counterCalls: 0,
    counterObservations: [],
    providerCalls: 0,
    credentialReads: 0,
    physicalCallNotifications: 0,
    withinBudget: false,
    scriptedCompletion: false,
  };
  onProgress?.('counter-module-request');
  const { createSupportIndependentCheckTokenCounter } =
    await import('./support-independent-checks-token-counter');
  const actual = createSupportIndependentCheckTokenCounter(qualification);
  const input = inputFor(caseId);
  let wireBody = '';
  const model = createSupportIndependentCheckModel({
    clock,
    enabled: () => true,
    readRoute: () => CHECKER_CPU_ROUTE,
    allowlist: allowed,
    counter: {
      qualification: actual.qualification,
      count(text) {
        const tokens = actual.count(text);
        activity.counterCalls++;
        onProgress?.('counter-call');
        if (activity.counterCalls > 64)
          throw new CheckerCpuFixtureError('counter-sequence');
        activity.counterObservations.push({ codeUnits: text.length, tokens });
        return tokens;
      },
    },
    readApiKey(reference) {
      if (reference !== 'fictional-cpu-credential') return undefined;
      activity.credentialReads++;
      return 'FICTIONAL_CPU_ONLY_NEVER_EXTERNAL';
    },
    async fetch(url, init) {
      activity.providerCalls++;
      if (
        activity.providerCalls !== 1 ||
        url !== INDEPENDENT_CHECK_ENDPOINT ||
        init.method !== 'POST'
      )
        throw new CheckerCpuFixtureError('transport-refused');
      wireBody = String(init.body);
      const body = JSON.parse(wireBody);
      if (
        body.messages?.length !== 2 ||
        body.messages[0].role !== 'system' ||
        body.messages[0].content !== CHECKER_CPU_FROZEN.systemText ||
        body.messages[1].role !== 'user' ||
        body.messages[1].content !== frozen.inputJson ||
        new TextEncoder().encode(wireBody).length !== frozen.expectedWireBytes
      )
        throw new CheckerCpuFixtureError('wire-changed');
      return new Response(
        JSON.stringify({
          id: 'fictional-cpu-no-native-provider',
          object: 'chat.completion',
          created: 1,
          model: configuration.model,
          provider: configuration.provider,
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: JSON.stringify(scriptedVerdict),
              },
            },
          ],
          usage: {
            prompt_tokens: frozen.expectedFullInputTokens,
            completion_tokens: 64,
            total_tokens: frozen.expectedFullInputTokens + 64,
            cost: 0.001,
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
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const resolved = await model.resolve(undefined, new AbortController().signal);
  if (!resolved) throw new CheckerCpuFixtureError('configuration-unavailable');
  activity.withinBudget = model.withinBudget(input, resolved.configuration);
  if (!activity.withinBudget)
    throw new CheckerCpuFixtureError('budget-refused');
  const response = await model.generate(
    input,
    {
      purpose: 'support_independent_check',
      configurationVersion: configuration.version,
      promptVersion: configuration.promptVersion,
      modelVersion: MODEL_VERSION,
      usageScopeRef: CHECKER_CPU_ROUTE.usageScopeRef,
      operationId: 'fictional-cpu-operation',
      attemptId: 'fictional-cpu-attempt',
      inputFingerprint: frozen.inputSha256,
      usageReservationId: 'fictional-cpu-no-reservation',
      signal: new AbortController().signal,
      deadline: new Date(
        Date.parse(clock.now()) + CHECKER_CPU_BUDGETS.maxDurationMilliseconds,
      ).toISOString(),
      budgets: CHECKER_CPU_BUDGETS,
      onPhysicalCall() {
        activity.physicalCallNotifications++;
      },
    },
    resolved.configuration,
  );
  model.parseVerdict(response.outputJson);
  activity.scriptedCompletion = true;
  return { activity, wireBody };
}
