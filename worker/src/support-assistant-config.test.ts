import { describe, expect, it, vi } from 'vitest';
import {
  createSupportAssistantConfiguration,
  supportAssistantRoutePolicySha256,
  SUPPORT_ASSISTANT_ENDPOINT,
  SUPPORT_ASSISTANT_WIRE_VERSION,
  type ApprovedSupportAssistantRoute,
  type QualifiedSupportAssistantCounter,
} from './support-assistant-config';

const START = '2026-11-10T00:00:00.000Z';
const END = '2026-11-10T01:00:00.000Z';

/** Fictional byte-token model and test-only approvals; no real route is selected. */
async function fixture() {
  let now = START;
  let enabled = true;
  const base: Omit<ApprovedSupportAssistantRoute, 'approval'> = {
    host: 'pegma.dev',
    purpose: 'support_answer',
    endpoint: SUPPORT_ASSISTANT_ENDPOINT,
    endpointTag: 'fictional/region-one',
    outputTokenParameter: 'max_tokens',
    credentialRef: 'test-secret-reference',
    usageScopeRef: 'test-budget-scope',
    configuration: {
      version: 'test-configuration-v1',
      promptVersion: 'test-prompt-v1',
      modelVersion: 'test-model-v1',
      provider: 'Fictional Provider',
      model: 'fictional/byte-token-model',
      pricingRef: 'test-price-v1',
      trustedInstructions: 'Answer only from supplied sources or escalate.',
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
        maxAttempts: 1,
        maxAssistantTurns: 2,
      },
      dataControls: {
        status: 'verified',
        configurationBinding: 'test-configuration-v1',
        accountRef: 'test-account-proof',
        projectRef: 'test-project-proof',
        endpointRef: 'test-endpoint-proof',
        modelRef: 'test-model-proof',
        featuresRef: 'test-features-proof',
        exceptionsRef: 'test-exceptions-proof',
        intermediaryRefs: ['test-openrouter-proof'],
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
      evidenceRef: 'test-approval',
      effectivePolicyRef: 'test-effective-policy',
      evaluationRef: 'test-evaluation',
      responseIdentityRef: 'test-response-identity',
      tokenizerRef: 'test-byte-token-qualification',
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
      implicitCache: 'absent',
      verifiedAt: START,
      validUntil: END,
    },
  };
  const counter: QualifiedSupportAssistantCounter = {
    qualification: {
      model: base.configuration.model,
      modelVersion: base.configuration.modelVersion,
      wireVersion: SUPPORT_ASSISTANT_WIRE_VERSION,
      framingTokens: 512,
      evidenceRef: 'test-byte-token-qualification',
      verifiedAt: START,
      validUntil: END,
    },
    count: (text) => new TextEncoder().encode(text).byteLength,
  };
  let current: unknown = route;
  const readRoute = vi.fn(() => current);
  const options = {
    clock: { now: () => now },
    isEnabled: () => enabled,
    readRoute,
    counter,
    allowlist: [
      {
        model: base.configuration.model,
        provider: base.configuration.provider,
        endpointTag: base.endpointTag,
        outputTokenParameter: base.outputTokenParameter,
      },
    ],
  };
  const provider = createSupportAssistantConfiguration(options);
  return {
    provider,
    route,
    options,
    readRoute,
    counter,
    setRoute: (value: unknown) => {
      current = value;
    },
    setNow: (value: string) => {
      now = value;
    },
    disable: () => {
      enabled = false;
    },
  };
}

describe('support assistant closed route configuration', () => {
  it('defaults disabled without consulting a route or inventing a counter', async () => {
    const readRoute = vi.fn(() => {
      throw new Error('private configuration');
    });
    const provider = createSupportAssistantConfiguration({
      clock: { now: () => START },
      readRoute,
    });
    expect(await provider.configuration.resolve()).toEqual({
      outcome: 'disabled',
    });
    expect(readRoute).not.toHaveBeenCalled();
    expect(() => provider.tokenCounter.count('content')).toThrow(
      'counter unavailable',
    );
  });

  it('requires an explicit allowlist and a qualified local counter', async () => {
    const f = await fixture();
    const { counter: _counter, ...withoutCounter } = f.options;
    expect(
      await createSupportAssistantConfiguration(
        withoutCounter,
      ).configuration.resolve(),
    ).toEqual({ outcome: 'unavailable' });
    expect(
      await createSupportAssistantConfiguration({
        ...f.options,
        allowlist: [],
      }).configuration.resolve(),
    ).toEqual({ outcome: 'unavailable' });
    expect(
      await createSupportAssistantConfiguration({
        ...f.options,
        counter: {
          ...f.counter,
          qualification: {
            ...f.counter.qualification,
            model: 'different/model',
          },
        },
      }).configuration.resolve(),
    ).toEqual({ outcome: 'unavailable' });
  });

  it('returns only the public SDK configuration after verifying its exact policy digest', async () => {
    const f = await fixture();
    expect(f.provider.currentRoute()).toBeUndefined();
    const ready = await f.provider.configuration.resolve();
    expect(ready).toEqual({
      outcome: 'ready',
      configuration: f.route.configuration,
    });
    expect(f.provider.tokenCounter.count('abc')).toBe(3);
    expect(JSON.stringify(ready)).not.toContain('test-secret-reference');
    if (ready.outcome !== 'ready') throw new Error('Test route was not ready');
    Object.assign(ready.configuration.budgets, { maxCostMicros: 1 });
    expect((await f.provider.configuration.resolve()).outcome).toBe('ready');
    expect(f.provider.currentRoute()?.configuration.budgets.maxCostMicros).toBe(
      25_000,
    );
  });

  it('honors expected version and immediate disablement without restoring old readiness', async () => {
    const f = await fixture();
    expect((await f.provider.configuration.resolve()).outcome).toBe('ready');
    expect(await f.provider.configuration.resolve('old-version')).toEqual({
      outcome: 'unavailable',
    });
    f.disable();
    f.readRoute.mockClear();
    expect(await f.provider.configuration.resolve()).toEqual({
      outcome: 'disabled',
    });
    expect(f.readRoute).not.toHaveBeenCalled();
    expect(f.provider.currentRoute()).toBeUndefined();
  });

  it.each<[string, (route: ApprovedSupportAssistantRoute) => unknown]>([
    [
      'expired',
      (r: ApprovedSupportAssistantRoute) => ({
        ...r,
        approval: { ...r.approval, validUntil: START },
      }),
    ],
    [
      'future evidence',
      (r: ApprovedSupportAssistantRoute) => ({
        ...r,
        approval: { ...r.approval, verifiedAt: END },
      }),
    ],
    [
      'logging enabled',
      (r: ApprovedSupportAssistantRoute) => ({
        ...r,
        approval: { ...r.approval, inputOutputLogging: true },
      }),
    ],
    [
      'safety retention',
      (r: ApprovedSupportAssistantRoute) => ({
        ...r,
        approval: { ...r.approval, safetyRetention: true },
      }),
    ],
    [
      'missing intermediary',
      (r: ApprovedSupportAssistantRoute) => ({
        ...r,
        configuration: {
          ...r.configuration,
          dataControls: {
            ...r.configuration.dataControls,
            intermediaryRefs: [],
          },
        },
      }),
    ],
    [
      'arbitrary URL',
      (r: ApprovedSupportAssistantRoute) => ({
        ...r,
        endpoint: 'https://example.invalid/chat',
      }),
    ],
    [
      'wrong endpoint tag',
      (r: ApprovedSupportAssistantRoute) => ({
        ...r,
        endpointTag: 'fictional/region-two',
      }),
    ],
    [
      'unknown route field',
      (r: ApprovedSupportAssistantRoute) => ({ ...r, fallback: true }),
    ],
    [
      'changed same-version credential reference',
      (r: ApprovedSupportAssistantRoute) => ({
        ...r,
        credentialRef: 'new-unapproved-reference',
      }),
    ],
    [
      'tampered digest',
      (r: ApprovedSupportAssistantRoute) => ({
        ...r,
        approval: { ...r.approval, requestPolicySha256: '0'.repeat(64) },
      }),
    ],
  ])('refuses %s', async (_label, edit) => {
    const f = await fixture();
    await f.provider.configuration.resolve();
    f.setRoute(edit(f.route));
    expect(await f.provider.configuration.resolve()).toEqual({
      outcome: 'unavailable',
    });
    expect(f.provider.currentRoute()).toBeUndefined();
  });

  it('refuses expired qualification and a noncanonical clock', async () => {
    const f = await fixture();
    await f.provider.configuration.resolve();
    f.setNow(END);
    expect(await f.provider.configuration.resolve()).toEqual({
      outcome: 'unavailable',
    });
    expect(() => f.provider.tokenCounter.count('text')).toThrow();
    f.setNow('2026-11-10T00:00:00Z');
    expect(await f.provider.configuration.resolve()).toEqual({
      outcome: 'unavailable',
    });
    f.setNow('invalid');
    expect(await f.provider.configuration.resolve()).toEqual({
      outcome: 'unavailable',
    });
  });
});
