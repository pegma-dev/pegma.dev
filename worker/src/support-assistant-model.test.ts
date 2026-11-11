import type { AssistantAttemptContext, AssistantModelInput } from '@pegma/support-desk-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSupportAssistantConfiguration,
  supportAssistantRoutePolicySha256,
  SUPPORT_ASSISTANT_ENDPOINT,
  SUPPORT_ASSISTANT_WIRE_VERSION,
  type ApprovedSupportAssistantRoute,
} from './support-assistant-config';
import {
  createSupportAssistantOpenRouterModel,
  SupportAssistantModelError,
} from './support-assistant-model';

const START = '2026-11-10T00:00:00.000Z';
const END = '2026-11-10T01:00:00.000Z';
const REFERENCE = {
  articleId: 'test-article',
  collectionId: 'test-collection',
  collectionPolicyVersion: 1,
  articleRevision: 1,
  contentHash: 'test-content',
  applicationGeneration: 1,
  governanceGeneration: 1,
  validationGeneration: 1,
};

/** All route, account, price and tokenizer evidence here is fictional test data. */
async function fixture(
  outputTokenParameter: 'max_tokens' | 'max_completion_tokens' = 'max_completion_tokens',
  maxAttempts = 1,
  implicitCache: 'absent' | 'approved' = 'absent',
) {
  let now = START;
  let enabled = true;
  const base: Omit<ApprovedSupportAssistantRoute, 'approval'> = {
    host: 'pegma.dev',
    purpose: 'support_answer',
    endpoint: SUPPORT_ASSISTANT_ENDPOINT,
    endpointTag: 'fictional/region-one',
    outputTokenParameter,
    credentialRef: 'PRIVATE_CREDENTIAL_REFERENCE',
    usageScopeRef: 'PRIVATE_USAGE_SCOPE',
    configuration: {
      version: 'PRIVATE_CONFIGURATION_VERSION',
      promptVersion: 'PRIVATE_PROMPT_VERSION',
      modelVersion: 'PRIVATE_MODEL_VERSION',
      provider: 'Fictional Provider',
      model: 'fictional/byte-token-model',
      pricingRef: 'PRIVATE_PRICE_REFERENCE',
      trustedInstructions: 'Answer from approved sources or escalate.',
      framingTokens: 512,
      budgets: {
        maxMessages: 8,
        maxInputBytes: 16_000,
        maxInputTokens: 8_192,
        maxContextTokens: 12_288,
        maxOutputBytes: 4_000,
        maxOutputTokens: 2_048,
        maxDurationMilliseconds: 1_000,
        maxCostMicros: 25_000,
        currency: 'USD',
        maxAttempts,
        maxAssistantTurns: 2,
      },
      dataControls: {
        status: 'verified',
        configurationBinding: 'PRIVATE_CONFIGURATION_VERSION',
        accountRef: 'PRIVATE_ACCOUNT_REFERENCE',
        projectRef: 'PRIVATE_PROJECT_REFERENCE',
        endpointRef: 'PRIVATE_ENDPOINT_REFERENCE',
        modelRef: 'PRIVATE_MODEL_REFERENCE',
        featuresRef: 'PRIVATE_FEATURES_REFERENCE',
        exceptionsRef: 'PRIVATE_EXCEPTIONS_REFERENCE',
        intermediaryRefs: ['PRIVATE_INTERMEDIARY_REFERENCE'],
        verifiedAt: START,
        validUntil: END,
      },
    },
  };
  const route: ApprovedSupportAssistantRoute = {
    ...base,
    approval: {
      configurationVersion: base.configuration.version,
      wireVersion: SUPPORT_ASSISTANT_WIRE_VERSION,
      evidenceRef: 'PRIVATE_APPROVAL',
      effectivePolicyRef: 'PRIVATE_EFFECTIVE_POLICY',
      evaluationRef: 'PRIVATE_EVALUATION',
      responseIdentityRef: 'PRIVATE_RESPONSE_PROOF',
      tokenizerRef: 'PRIVATE_TOKENIZER_PROOF',
      requestPolicySha256: await supportAssistantRoutePolicySha256(base),
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
      implicitCache,
      verifiedAt: START,
      validUntil: END,
    },
  };
  const configuration = createSupportAssistantConfiguration({
    clock: { now: () => now },
    isEnabled: () => enabled,
    readRoute: () => route,
    allowlist: [
      {
        model: base.configuration.model,
        provider: base.configuration.provider,
        endpointTag: base.endpointTag,
        outputTokenParameter: base.outputTokenParameter,
      },
    ],
    counter: {
      qualification: {
        model: base.configuration.model,
        modelVersion: base.configuration.modelVersion,
        wireVersion: SUPPORT_ASSISTANT_WIRE_VERSION,
        framingTokens: 512,
        evidenceRef: 'PRIVATE_TOKENIZER_PROOF',
        verifiedAt: START,
        validUntil: END,
      },
      count: (value) => new TextEncoder().encode(value).byteLength,
    },
  });
  const ready = await configuration.configuration.resolve();
  if (ready.outcome !== 'ready') throw new Error('Fictional test qualification failed');
  const input: AssistantModelInput = {
    trustedInstructions: base.configuration.trustedInstructions,
    messages: [
      { speaker: 'customer', text: 'How do I use the example?' },
      { speaker: 'support', text: 'The approved guide explains this.' },
    ],
    serializedSources: JSON.stringify([
      { reference: REFERENCE, text: 'Approved example guidance' },
    ]),
  };
  const context: AssistantAttemptContext = {
    purpose: 'support_answer',
    operationId: 'PRIVATE_OPERATION',
    attemptId: 'PRIVATE_ATTEMPT',
    attempt: 1,
    fence: {
      ticketId: 'PRIVATE_TICKET',
      turnId: 'PRIVATE_TURN',
      workerId: 'PRIVATE_WORKER',
      claimId: 'PRIVATE_CLAIM',
      claimGeneration: 1,
      attempt: 1,
      attemptId: 'PRIVATE_ATTEMPT',
      commandId: 'PRIVATE_COMMAND',
      correlationId: 'PRIVATE_CORRELATION',
      expectedRevision: 1,
      expectedHandlingGeneration: 1,
      triggerMessageId: 'PRIVATE_TRIGGER',
    },
    inputFingerprint: 'PRIVATE_INPUT_BINDING',
    configurationVersion: base.configuration.version,
    promptVersion: base.configuration.promptVersion,
    modelVersion: base.configuration.modelVersion,
    audienceVersion: 'PRIVATE_AUDIENCE',
    policyVersion: 'PRIVATE_POLICY',
    usageScopeRef: base.usageScopeRef,
    usageReservationId: 'PRIVATE_RESERVATION',
    applicability: {
      productId: 'PRIVATE_PRODUCT',
      productVersion: 'PRIVATE_VERSION',
    },
    allSourceReferences: [{ ...REFERENCE, articleId: 'PRIVATE_SERVER_SOURCE' }],
    deadline: '2026-11-10T00:00:05.000Z',
    signal: new AbortController().signal,
    budgets: {
      ...base.configuration.budgets,
      maxMessageCharacters: 4_000,
      maxAnswerTextCharacters: 3_000,
    },
  };
  return {
    route,
    configuration,
    input,
    context,
    config: ready.configuration,
    clock: { now: () => now },
    disable: () => {
      enabled = false;
    },
    setNow: (value: string) => {
      now = value;
    },
  };
}

function document(
  content = JSON.stringify({
    kind: 'escalate',
    text: 'Please contact support.',
    reason: 'other',
    citations: [],
  }),
) {
  return {
    id: 'gen-test-1',
    object: 'chat.completion',
    created: 1,
    model: 'fictional/byte-token-model',
    provider: 'Fictional Provider',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content },
      },
    ],
    usage: {
      prompt_tokens: 200,
      completion_tokens: 40,
      total_tokens: 240,
      cost: 0.000001,
      is_byok: false,
    },
  };
}
function jsonResponse(value: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json', ...headers },
  });
}

afterEach(() => vi.useRealTimers());

describe('bounded support OpenRouter wire', () => {
  it('serializes only the provider input and fixed locked request policy', async () => {
    const f = await fixture();
    const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(document(), { 'x-generation-id': 'gen-test-1' }),
    );
    const model = createSupportAssistantOpenRouterModel({
      clock: f.clock,
      configuration: f.configuration,
      readApiKey: () => 'PRIVATE_API_KEY',
      fetch,
    });
    const result = await model.generate(f.input, f.context, f.config);
    expect(result).toEqual({
      outputJson: JSON.stringify({
        kind: 'escalate',
        reason: 'other',
        text: 'Please contact support.',
      }),
      provider: 'Fictional Provider',
      model: 'fictional/byte-token-model',
      requestId: 'gen-test-1',
      usage: {
        inputTokens: 200,
        outputTokens: 40,
        costMicros: 1,
        currency: 'USD',
      },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const call = fetch.mock.calls[0];
    if (!call) throw new Error('Missing scripted call');
    const [url, init] = call;
    expect(url).toBe(SUPPORT_ASSISTANT_ENDPOINT);
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit',
    });
    const headers = new Headers(init.headers);
    expect(headers.get('x-openrouter-cache')).toBe('false');
    expect(headers.get('authorization')).toBe('Bearer PRIVATE_API_KEY');
    if (typeof init.body !== 'string') throw new Error('Missing bounded request body');
    expect(init.body).not.toContain('PRIVATE_');
    const body = JSON.parse(init.body);
    expect(Object.keys(body).sort()).toEqual([
      'max_completion_tokens',
      'messages',
      'model',
      'provider',
      'response_format',
      'stream',
    ]);
    expect(body.provider).toEqual({
      only: ['fictional/region-one'],
      allow_fallbacks: false,
      data_collection: 'deny',
      zdr: true,
      require_parameters: true,
    });
    expect(body.stream).toBe(false);
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(JSON.parse(body.messages[1].content)).toEqual(f.input);
  });

  it('normalizes the closed answer wire into the exact SDK answer DTO', async () => {
    const f = await fixture();
    const model = createSupportAssistantOpenRouterModel({
      clock: f.clock,
      configuration: f.configuration,
      readApiKey: () => 'test-key',
      fetch: async () =>
        jsonResponse(
          document(
            JSON.stringify({
              kind: 'answer',
              text: 'Use the guide.',
              reason: null,
              citations: [REFERENCE],
            }),
          ),
        ),
    });
    expect(JSON.parse((await model.generate(f.input, f.context, f.config)).outputJson)).toEqual({
      kind: 'answer',
      text: 'Use the guide.',
      citations: [REFERENCE],
    });
  });

  it('uses only the separately qualified output-token parameter', async () => {
    const f = await fixture('max_tokens');
    const bodies: unknown[] = [];
    const model = createSupportAssistantOpenRouterModel({
      clock: f.clock,
      configuration: f.configuration,
      readApiKey: () => 'key',
      fetch: async (_url, init) => {
        if (typeof init.body !== 'string') throw new Error('Missing bounded body');
        bodies.push(JSON.parse(init.body));
        return jsonResponse(document());
      },
    });
    await model.generate(f.input, f.context, f.config);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toHaveProperty('max_tokens', f.context.budgets.maxOutputTokens);
    expect(bodies[0]).not.toHaveProperty('max_completion_tokens');
  });

  it('ceil-rounds the actual decimal lexeme without losing sub-micro precision', async () => {
    const f = await fixture();
    const raw = JSON.stringify(document()).replace(
      '"cost":0.000001',
      '"cost":0.0000010000000000000001',
    );
    const model = createSupportAssistantOpenRouterModel({
      clock: f.clock,
      configuration: f.configuration,
      readApiKey: () => 'test-key',
      fetch: async () => new Response(raw, { headers: { 'content-type': 'application/json' } }),
    });
    expect((await model.generate(f.input, f.context, f.config)).usage.costMicros).toBe(2);
  });

  it.each<[string, (value: ReturnType<typeof document>) => unknown]>([
    [
      'wrong provider',
      (d: ReturnType<typeof document>) => ({
        ...d,
        provider: 'Other Provider',
      }),
    ],
    ['wrong model', (d: ReturnType<typeof document>) => ({ ...d, model: 'other/model' })],
    [
      'truncation',
      (d: ReturnType<typeof document>) => ({
        ...d,
        choices: [{ ...d.choices[0], finish_reason: 'length' }],
      }),
    ],
    [
      'multiple choices',
      (d: ReturnType<typeof document>) => ({
        ...d,
        choices: [...d.choices, ...d.choices],
      }),
    ],
    [
      'fractional tokens',
      (d: ReturnType<typeof document>) => ({
        ...d,
        usage: { ...d.usage, prompt_tokens: 1.5 },
      }),
    ],
    [
      'inconsistent total',
      (d: ReturnType<typeof document>) => ({
        ...d,
        usage: { ...d.usage, total_tokens: 1 },
      }),
    ],
    [
      'missing cost',
      (d: ReturnType<typeof document>) => {
        const { cost: _cost, ...usage } = d.usage;
        return { ...d, usage };
      },
    ],
    [
      'negative cost',
      (d: ReturnType<typeof document>) => ({
        ...d,
        usage: { ...d.usage, cost: -1 },
      }),
    ],
    [
      'wrong currency',
      (d: ReturnType<typeof document>) => ({
        ...d,
        usage: { ...d.usage, currency: 'EUR' },
      }),
    ],
    [
      'unapproved reasoning',
      (d: ReturnType<typeof document>) => ({
        ...d,
        usage: {
          ...d.usage,
          completion_tokens_details: { reasoning_tokens: 1 },
        },
      }),
    ],
    [
      'cache under absent contract',
      (d: ReturnType<typeof document>) => ({
        ...d,
        usage: { ...d.usage, prompt_tokens_details: { cached_tokens: 1 } },
      }),
    ],
    [
      'tool result',
      (d: ReturnType<typeof document>) => ({
        ...d,
        choices: [
          {
            ...d.choices[0],
            message: { ...d.choices[0]!.message, tool_calls: [{ id: 'tool' }] },
          },
        ],
      }),
    ],
    [
      'unknown feature',
      (d: ReturnType<typeof document>) => ({
        ...d,
        alignment: { private: true },
      }),
    ],
  ])('refuses %s without a paid retry', async (_label, edit) => {
    const f = await fixture();
    const fetch = vi.fn(async () => jsonResponse(edit(document())));
    const model = createSupportAssistantOpenRouterModel({
      clock: f.clock,
      configuration: f.configuration,
      readApiKey: () => 'test-key',
      fetch,
    });
    await expect(model.generate(f.input, f.context, f.config)).rejects.toBeInstanceOf(
      SupportAssistantModelError,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicate JSON keys and mismatched generation headers', async () => {
    const f = await fixture();
    for (const response of [
      new Response(
        JSON.stringify(document()).replace('"cost":0.000001', '"cost":0,"cost":0.000001'),
        { headers: { 'content-type': 'application/json' } },
      ),
      jsonResponse(document(), { 'x-generation-id': 'different-generation' }),
    ]) {
      const model = createSupportAssistantOpenRouterModel({
        clock: f.clock,
        configuration: f.configuration,
        readApiKey: () => 'test-key',
        fetch: async () => response,
      });
      await expect(model.generate(f.input, f.context, f.config)).rejects.toBeInstanceOf(
        SupportAssistantModelError,
      );
    }
  });

  it('makes zero calls for disabled routes, missing credentials or invalid input budgets', async () => {
    const f = await fixture();
    const fetch = vi.fn(async () => jsonResponse(document()));
    const make = (key: string | undefined) =>
      createSupportAssistantOpenRouterModel({
        clock: f.clock,
        configuration: f.configuration,
        readApiKey: () => key,
        fetch,
      });
    await expect(make(undefined).generate(f.input, f.context, f.config)).rejects.toMatchObject({
      code: 'credential_unavailable',
    });
    await expect(
      make('key').generate(
        f.input,
        { ...f.context, budgets: { ...f.context.budgets, maxInputBytes: 1 } },
        f.config,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    f.disable();
    await expect(make('key').generate(f.input, f.context, f.config)).rejects.toMatchObject({
      code: 'route_unavailable',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses route revocation during an actual awaited scripted fetch', async () => {
    const f = await fixture();
    let release: (response: Response) => void = () => {};
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetch = vi.fn(() => held);
    const model = createSupportAssistantOpenRouterModel({
      clock: f.clock,
      configuration: f.configuration,
      readApiKey: () => 'key',
      fetch,
    });
    const pending = model.generate(f.input, f.context, f.config);
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'route_unavailable',
    });
    f.disable();
    release(jsonResponse(document()));
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('bounds a fetch that ignores cancellation and exposes no raw network error', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const signals: AbortSignal[] = [];
    const fetch = vi.fn((_url: string, init: RequestInit) => {
      if (!init.signal) throw new Error('Missing cancellation signal');
      signals.push(init.signal);
      return new Promise<Response>(() => {});
    });
    const model = createSupportAssistantOpenRouterModel({
      clock: f.clock,
      configuration: f.configuration,
      readApiKey: () => 'key',
      fetch,
    });
    const pending = model.generate(f.input, f.context, f.config);
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'deadline',
    });
    await vi.advanceTimersByTimeAsync(1_001);
    await assertion;
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const bad = createSupportAssistantOpenRouterModel({
      clock: f.clock,
      configuration: f.configuration,
      readApiKey: () => 'key',
      fetch: async () => {
        throw new Error('PRIVATE_NETWORK_PROMPT');
      },
    });
    const error = await bad.generate(f.input, f.context, f.config).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(SupportAssistantModelError);
    expect(String(error)).not.toContain('PRIVATE_NETWORK_PROMPT');
  });

  it('bounds response bytes before JSON parsing and cancels the reader', async () => {
    const f = await fixture();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(50_000));
      },
      cancel,
    });
    const model = createSupportAssistantOpenRouterModel({
      clock: f.clock,
      configuration: f.configuration,
      readApiKey: () => 'key',
      fetch: async () =>
        new Response(stream, {
          headers: { 'content-type': 'application/json' },
        }),
    });
    await expect(model.generate(f.input, f.context, f.config)).rejects.toMatchObject({
      code: 'response_limit',
    });
    expect(cancel).toHaveBeenCalled();
  });

  it('honors the original signal before fetch and while an actual body read is pending', async () => {
    const f = await fixture();
    const controller = new AbortController();
    const fetch = vi.fn(async () => jsonResponse(document()));
    const model = createSupportAssistantOpenRouterModel({
      clock: f.clock,
      configuration: f.configuration,
      readApiKey: () => 'key',
      fetch,
    });
    controller.abort();
    await expect(
      model.generate(f.input, { ...f.context, signal: controller.signal }, f.config),
    ).rejects.toMatchObject({ code: 'aborted' });
    expect(fetch).not.toHaveBeenCalled();

    const live = new AbortController();
    const cancel = vi.fn();
    let bodyRead: () => void = () => {};
    const reading = new Promise<void>((resolve) => {
      bodyRead = resolve;
    });
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          bodyRead();
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const held = createSupportAssistantOpenRouterModel({
      clock: f.clock,
      configuration: f.configuration,
      readApiKey: () => 'key',
      fetch: async () => new Response(body, { headers: { 'content-type': 'application/json' } }),
    });
    const pending = held.generate(f.input, { ...f.context, signal: live.signal }, f.config);
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'aborted',
    });
    await reading;
    live.abort();
    await assertion;
    expect(cancel).toHaveBeenCalled();
  });

  it('withholds a completed response when the trusted deadline expires during fetch', async () => {
    const f = await fixture();
    const model = createSupportAssistantOpenRouterModel({
      clock: f.clock,
      configuration: f.configuration,
      readApiKey: () => 'key',
      fetch: async () => {
        f.setNow('2026-11-10T00:00:06.000Z');
        return jsonResponse(document());
      },
    });
    await expect(model.generate(f.input, f.context, f.config)).rejects.toMatchObject({
      code: 'deadline',
    });
  });

  it('rejects malformed UTF8 and non-JSON or non-success provider responses', async () => {
    const f = await fixture();
    for (const response of [
      new Response(new Uint8Array([255]), {
        headers: { 'content-type': 'application/json' },
      }),
      new Response('PRIVATE_FAILURE', {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
      new Response('data: PRIVATE_STREAM', {
        headers: { 'content-type': 'text/event-stream' },
      }),
    ]) {
      const model = createSupportAssistantOpenRouterModel({
        clock: f.clock,
        configuration: f.configuration,
        readApiKey: () => 'key',
        fetch: async () => response,
      });
      const error = await model
        .generate(f.input, f.context, f.config)
        .catch((value: unknown) => value);
      expect(error).toBeInstanceOf(SupportAssistantModelError);
      expect(String(error)).not.toContain('PRIVATE_');
    }
  });
});

describe('SDK025 staged generation wire boundary', () => {
  it('keeps stage and claim metadata private while making one bounded scripted request', async () => {
    const f = await fixture('max_completion_tokens', 2);
    const context: AssistantAttemptContext = {
      ...f.context,
      attempt: 2,
      attemptId: 'PRIVATE_GENERATION_ATTEMPT',
      fence: {
        ...f.context.fence,
        attempt: 2,
        attemptId: 'PRIVATE_GENERATION_ATTEMPT',
      },
      stagedRetrieval: {
        stage: 'generation',
        preparationAttemptId: 'PRIVATE_PREPARATION_ATTEMPT',
      },
    };
    const transport = vi.fn(async (_url: string, _init: RequestInit) => jsonResponse(document()));
    const key = vi.fn(() => 'PRIVATE_FICTIONAL_KEY');
    const model = createSupportAssistantOpenRouterModel({
      clock: f.clock,
      configuration: f.configuration,
      readApiKey: key,
      fetch: transport,
    });
    const result = await model.generate(f.input, context, f.config);
    expect(result.requestId).toBe('gen-test-1');
    expect(transport).toHaveBeenCalledTimes(1);
    expect(key).toHaveBeenCalledTimes(1);
    const call = transport.mock.calls[0];
    if (call === undefined || typeof call[1].body !== 'string')
      throw new Error('Missing actual scripted provider wire.');
    expect(call[0]).toBe(SUPPORT_ASSISTANT_ENDPOINT);
    expect(call[1].body).not.toContain('PRIVATE_');
    const body = JSON.parse(call[1].body);
    expect(JSON.parse(body.messages[1].content)).toEqual(f.input);
    expect(body).not.toHaveProperty('stagedRetrieval');
    expect(body).not.toHaveProperty('fence');
    expect(body.provider).toEqual({
      only: ['fictional/region-one'],
      allow_fallbacks: false,
      data_collection: 'deny',
      zdr: true,
      require_parameters: true,
    });
    expect(new Headers(call[1].headers).get('x-openrouter-cache')).toBe('false');
  });
});

/** Public-safe reproduction of the observed fictional provider usage shape.
 * Generation identity, model and content remain the existing fictional builder.
 * Exact native cost decimal and all zero media fields are preserved. */
function zeroMediaDocument() {
  return {
    ...document(),
    usage: {
      prompt_tokens: 436,
      completion_tokens: 160,
      total_tokens: 596,
      cost: 0.00047344,
      is_byok: false,
      prompt_tokens_details: {
        cached_tokens: 0,
        cache_write_tokens: 0,
        audio_tokens: 0,
        video_tokens: 0,
      },
      completion_tokens_details: { reasoning_tokens: 0, image_tokens: 0, audio_tokens: 0 },
      cost_details: {
        upstream_inference_cost: 0.00047344,
        upstream_inference_prompt_cost: 0.00019184,
        upstream_inference_completions_cost: 0.0002816,
      },
    },
  };
}

describe('observed zero-media provider usage compatibility', () => {
  it.each(['absent', 'approved'] as const)(
    'accepts only the known zero media fields with cache treatment %s and exact native rounding',
    async (implicitCache) => {
      const f = await fixture('max_tokens', 1, implicitCache);
      const transport = vi.fn(async () => jsonResponse(zeroMediaDocument()));
      const model = createSupportAssistantOpenRouterModel({
        clock: f.clock,
        configuration: f.configuration,
        readApiKey: () => 'fictional-key',
        fetch: transport,
      });
      const result = await model.generate(f.input, f.context, f.config);
      expect(result.usage).toEqual({
        inputTokens: 436,
        outputTokens: 160,
        costMicros: 474,
        currency: 'USD',
      });
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['prompt_tokens_details', 'video_tokens', 1],
    ['completion_tokens_details', 'image_tokens', 1],
    ['completion_tokens_details', 'audio_tokens', 1],
    ['prompt_tokens_details', 'unknown_tokens', 0],
    ['completion_tokens_details', 'unknown_tokens', 0],
    ['prompt_tokens_details', 'video_tokens', -1],
    ['completion_tokens_details', 'image_tokens', 0.5],
    ['completion_tokens_details', 'audio_tokens', null],
  ] as const)(
    'rejects %s.%s=%s even when implicit caching is approved',
    async (group, key, value) => {
      const f = await fixture('max_tokens', 1, 'approved');
      const observed = zeroMediaDocument();
      const altered = {
        ...observed,
        usage: { ...observed.usage, [group]: { ...observed.usage[group], [key]: value } },
      };
      const transport = vi.fn(async () => jsonResponse(altered));
      const model = createSupportAssistantOpenRouterModel({
        clock: f.clock,
        configuration: f.configuration,
        readApiKey: () => 'fictional-key',
        fetch: transport,
      });
      await expect(model.generate(f.input, f.context, f.config)).rejects.toBeInstanceOf(
        SupportAssistantModelError,
      );
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
});
