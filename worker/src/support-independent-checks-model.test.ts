import { encode } from 'gpt-tokenizer';
import { describe, expect, it } from 'vitest';
import {
  createSupportIndependentCheckModel,
  independentCheckRoutePolicyHash,
  INDEPENDENT_CHECK_ENDPOINT,
  INDEPENDENT_CHECK_PURPOSE,
  INDEPENDENT_CHECK_WIRE,
  type IndependentCheckRoute,
  type IndependentCheckContext,
  type IndependentCheckCounter,
} from './support-independent-checks-model';

const START = '2026-11-10T12:00:00.000Z';
const END = '2026-11-10T13:00:00.000Z';
const verdict = {
  privacy: 'passed',
  factual: 'passed',
  security: 'clear',
  applicability: 'passed',
  duplication: 'passed',
  publicReproduction: 'not_applicable',
  findings: [],
};
/** All approvals/prices/qualification references here are fictional test evidence. */
async function fixture() {
  const c: IndependentCheckRoute['configuration'] = {
    purpose: INDEPENDENT_CHECK_PURPOSE,
    version: 'fictional-check-config',
    promptVersion: 'fictional-check-prompt',
    modelVersion: 'fictional-check-model',
    parserVersion: 'fictional-check-parser',
    policyVersion: 'fictional-check-policy',
    policyBinding: 'fictional-check-policy-binding',
    rubricVersion: 'fictional-check-rubric',
    model: 'fictional/checker',
    provider: 'Fictional Provider',
    pricingRef: 'fictional-check-price',
    trustedInstructions: 'Compare only supplied fictional facts.',
    framingTokens: 512,
    budgets: {
      maxMessages: 20,
      maxInputBytes: 65_536,
      maxInputTokens: 16_000,
      maxContextTokens: 20_000,
      maxOutputBytes: 4_000,
      maxOutputTokens: 1_000,
      maxDurationMilliseconds: 2_000,
      maxCostMicros: 1_000,
      currency: 'USD',
      maxAttempts: 1,
    },
    dataControls: {
      status: 'verified',
      purpose: INDEPENDENT_CHECK_PURPOSE,
      configurationBinding: 'fictional-check-config',
      accountRef: 'fictional-account',
      projectRef: 'fictional-project',
      endpointRef: 'fictional-endpoint',
      modelRef: 'fictional-model',
      featuresRef: 'fictional-features',
      exceptionsRef: 'fictional-exceptions',
      intermediaryRefs: ['fictional-intermediary'],
      verifiedAt: START,
      validUntil: END,
    },
  };
  const base: Omit<IndependentCheckRoute, 'approval'> = {
    host: 'pegma.dev',
    purpose: INDEPENDENT_CHECK_PURPOSE,
    endpoint: INDEPENDENT_CHECK_ENDPOINT,
    endpointTag: 'fictional/region',
    outputTokenParameter: 'max_tokens',
    credentialRef: 'fictional-provider-credential',
    usageScopeRef: 'fictional-check-budget',
    configuration: c,
  };
  const route: IndependentCheckRoute = {
    ...base,
    approval: {
      wireVersion: INDEPENDENT_CHECK_WIRE,
      configurationVersion: c.version,
      requestPolicySha256: await independentCheckRoutePolicyHash(base),
      evidenceRef: 'fictional-approval',
      effectivePolicyRef: 'fictional-effective-policy',
      evaluationRef: 'fictional-evaluation',
      responseIdentityRef: 'fictional-identity',
      tokenizerRef: 'fictional-tokenizer',
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
      verifiedAt: START,
      validUntil: END,
    },
  };
  const state = {
    enabled: true,
    calls: 0,
    requests: [] as { url: string; init: RequestInit }[],
    now: START,
    document: {
      id: 'fictional-check-response',
      object: 'chat.completion',
      created: 1,
      provider: c.provider,
      model: c.model,
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: JSON.stringify(verdict) },
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
    },
  };
  const counter: IndependentCheckCounter = {
    qualification: {
      model: c.model,
      modelVersion: c.modelVersion,
      wireVersion: INDEPENDENT_CHECK_WIRE,
      framingTokens: c.framingTokens,
      evidenceRef: 'fictional-tokenizer',
      verifiedAt: START,
      validUntil: END,
    },
    count: (s: string) => encode(s).length,
  };
  const options = {
    clock: { now: () => state.now },
    enabled: () => state.enabled,
    readRoute: () => route,
    allowlist: [
      {
        model: c.model,
        provider: c.provider,
        endpointTag: base.endpointTag,
        outputTokenParameter: base.outputTokenParameter,
      },
    ],
    counter,
    readApiKey: () => 'fictional-provider-key',
    fetch: async (url: string, init: RequestInit) => {
      state.calls++;
      state.requests.push({ url, init });
      return new Response(JSON.stringify(state.document), {
        headers: { 'content-type': 'application/json' },
      });
    },
  };
  const model = createSupportIndependentCheckModel(options);
  const context: IndependentCheckContext = {
    purpose: INDEPENDENT_CHECK_PURPOSE,
    configurationVersion: c.version,
    promptVersion: c.promptVersion,
    modelVersion: c.modelVersion,
    usageScopeRef: base.usageScopeRef,
    operationId: 'fictional-operation',
    attemptId: 'fictional-attempt',
    inputFingerprint: 'a'.repeat(64),
    usageReservationId: 'fictional-reservation',
    deadline: '2026-11-10T12:00:02.000Z',
    signal: new AbortController().signal,
    budgets: c.budgets,
  };
  const input = {
    trustedInstructions: c.trustedInstructions,
    kind: 'engineering' as const,
    facts: {
      actualBehavior: 'The export appears empty.',
      messages: ['The fictional export appears empty.'],
    },
    candidate: { actualBehavior: 'The export is empty.' },
    outbound: {
      body: 'Export is empty. <!-- hidden unverified claim -->',
      labels: ['bug'],
      templateId: 'issue',
    },
  };
  return { c, state, route, model, context, input, options, counter };
}
describe('purpose-qualified independent checker transport', () => {
  it('sends complete untrusted content through the actual transport with qualified provider policy and tokenizer', async () => {
    const f = await fixture();
    expect(await f.model.resolve()).not.toBeNull();
    const result = await f.model.generate(f.input, f.context, f.c);
    expect(f.model.parseVerdict(result.outputJson)).toEqual(verdict);
    expect(result.usage.costMicros).toBe(100);
    expect(f.state.calls).toBe(1);
    const body = JSON.parse(String(f.state.requests[0]!.init.body));
    expect(body.messages[1].content).toContain(
      '<!-- hidden unverified claim -->',
    );
    expect(body.messages[0].content).toContain(
      'candidate cannot verify itself',
    );
    expect(body.provider).toMatchObject({
      only: ['fictional/region'],
      allow_fallbacks: false,
      zdr: true,
      data_collection: 'deny',
    });
    expect(body.response_format.json_schema.name).toBe(
      'support_independent_check_v1',
    );
    expect(body.messages[1].content).not.toContain('fictional-provider-key');
  });
  it('is unavailable by default and never calls the provider', async () => {
    const f = await fixture();
    const m = createSupportIndependentCheckModel({ clock: f.options.clock });
    expect(await m.resolve()).toBeNull();
    expect(f.state.calls).toBe(0);
  });
  it.each([
    'disabled',
    'digest',
    'expired',
    'counter',
    'wrongPurpose',
  ] as const)('refuses %s route before a call', async (scenario) => {
    const f = await fixture();
    if (scenario === 'disabled') f.state.enabled = false;
    if (scenario === 'digest')
      f.route.configuration.trustedInstructions += ' changed';
    if (scenario === 'expired') f.state.now = END;
    if (scenario === 'counter')
      Object.assign(f.counter.qualification, { framingTokens: 513 });
    if (scenario === 'wrongPurpose')
      Object.assign(f.route.configuration, {
        purpose: 'support_bug_assessment',
      });
    expect(await f.model.resolve()).toBeNull();
    expect(f.state.calls).toBe(0);
  });
  it.each(['missing', 'promise'] as const)(
    'refuses unsupported %s credentials before physical fetch',
    async (kind) => {
      const f = await fixture();
      await f.model.resolve();
      if (kind === 'missing') f.options.readApiKey = () => '';
      else
        Reflect.set(f.options, 'readApiKey', () =>
          Promise.resolve('FICTIONAL_UNSUPPORTED_KEY'),
        );
      await expect(
        f.model.generate(f.input, f.context, f.c),
      ).rejects.toMatchObject({ code: 'credential_unavailable' });
      expect(f.state.calls).toBe(0);
    },
  );
  it.each([
    'provider',
    'model',
    'cache',
    'schema',
    'duplicate',
    'uncertainty',
  ] as const)(
    'observes %s response without turning protocol success into a pass',
    async (scenario) => {
      const f = await fixture();
      await f.model.resolve();
      if (scenario === 'provider') f.state.document.provider = 'Wrong Provider';
      if (scenario === 'model') f.state.document.model = 'fictional/wrong';
      if (scenario === 'cache')
        f.state.document.usage.prompt_tokens_details.cached_tokens = 1;
      if (scenario === 'schema')
        f.state.document.choices[0]!.message.content = JSON.stringify({
          ...verdict,
          unexplainedPass: true,
        });
      if (scenario === 'duplicate')
        f.state.document.choices[0]!.message.content =
          '{"privacy":"passed","privacy":"failed"}';
      if (scenario === 'uncertainty')
        f.state.document.choices[0]!.message.content = JSON.stringify({
          ...verdict,
          factual: 'uncertain',
        });
      if (scenario === 'uncertainty')
        expect(
          f.model.parseVerdict(
            (await f.model.generate(f.input, f.context, f.c)).outputJson,
          ).factual,
        ).toBe('uncertain');
      else if (scenario === 'schema' || scenario === 'duplicate') {
        const result = await f.model.generate(f.input, f.context, f.c);
        expect(result.usage.costMicros).toBe(100);
        expect(() => f.model.parseVerdict(result.outputJson)).toThrow();
      } else
        await expect(
          f.model.generate(f.input, f.context, f.c),
        ).rejects.toThrow();
      expect(f.state.calls).toBe(1);
    },
  );
  it('refuses changed current configuration and changed tokenizer after qualification', async () => {
    const f = await fixture();
    await f.model.resolve();
    f.counter.count = () => 1;
    await expect(f.model.generate(f.input, f.context, f.c)).rejects.toThrow();
    expect(f.state.calls).toBe(0);
  });
});
