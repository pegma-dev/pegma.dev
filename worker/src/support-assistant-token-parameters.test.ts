import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSupportAssistantConfiguration,
  supportAssistantRoutePolicySha256,
  type ApprovedSupportAssistantRoute,
} from './support-assistant-config';
import { SUPPORT_ASSISTANT_CREDENTIAL_REF } from './support-assistant-production';
import { productionAnsweringFixture } from './support-assistant-production-fixtures';

type Parameter = ApprovedSupportAssistantRoute['outputTokenParameter'];

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('Configuration checks must not make provider requests.');
    }),
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

async function answering(parameter: Parameter) {
  const f = await productionAnsweringFixture();
  f.settings.route.outputTokenParameter = parameter;
  f.settings.route.approval.requestPolicySha256 =
    await supportAssistantRoutePolicySha256(f.settings.route);
  f.environment.PEGMA_SUPPORT_ASSISTANT_CONFIGURATION_JSON = JSON.stringify(
    f.settings,
  );
  const credentialRead = vi.fn(() => {
    throw new Error('Configuration checks must not read a credential.');
  });
  Object.defineProperty(f.environment, 'SUPPORT_ASSISTANT_OPENROUTER_API_KEY', {
    get: credentialRead,
    configurable: true,
  });
  return { ...f, credentialRead };
}

describe('production answering Azure token parameter compatibility', () => {
  it.each(['max_tokens', 'max_completion_tokens'] as const)(
    'qualifies the exact %s route without rewriting its approved selection',
    async (parameter) => {
      const f = await answering(parameter);
      const original = f.environment.PEGMA_SUPPORT_ASSISTANT_CONFIGURATION_JSON;
      const bundle = await f.bundle();
      expect(bundle.configuration).toBeDefined();
      expect(bundle.enabled?.()).toBe(true);
      const configured = bundle.configuration!;
      expect(configured.route.allowlist).toContainEqual({
        model: 'openai/gpt-4.1-mini',
        provider: 'Azure',
        endpointTag: 'azure/swedencentral',
        outputTokenParameter: parameter,
      });
      expect(configured.route.readRoute?.()).toEqual(f.settings.route);
      const current = createSupportAssistantConfiguration({
        ...configured.route,
        clock: f.f.runtime.clock,
        isEnabled: () => true,
      });
      expect((await current.configuration.resolve()).outcome).toBe('ready');
      expect(current.currentRoute()?.outputTokenParameter).toBe(parameter);
      expect(current.currentRoute()?.approval.requestPolicySha256).toBe(
        f.settings.route.approval.requestPolicySha256,
      );
      expect(f.environment.PEGMA_SUPPORT_ASSISTANT_CONFIGURATION_JSON).toBe(
        original,
      );
      expect(configured.readApiKey('another-purpose')).toBeUndefined();
      expect(f.credentialRead).not.toHaveBeenCalled();
    },
  );

  it('refuses an unsupported spelling even with a renewed policy hash before credentials', async () => {
    const f = await answering('max_tokens');
    Reflect.set(f.settings.route, 'outputTokenParameter', 'max_output_tokens');
    f.settings.route.approval.requestPolicySha256 =
      await supportAssistantRoutePolicySha256(f.settings.route);
    f.environment.PEGMA_SUPPORT_ASSISTANT_CONFIGURATION_JSON = JSON.stringify(
      f.settings,
    );
    expect((await f.bundle()).configuration).toBeUndefined();
    expect(f.credentialRead).not.toHaveBeenCalled();
  });

  it('refuses a supported field change with its stale policy binding before credentials', async () => {
    const f = await answering('max_tokens');
    f.settings.route.outputTokenParameter = 'max_completion_tokens';
    expect(await supportAssistantRoutePolicySha256(f.settings.route)).not.toBe(
      f.settings.route.approval.requestPolicySha256,
    );
    f.environment.PEGMA_SUPPORT_ASSISTANT_CONFIGURATION_JSON = JSON.stringify(
      f.settings,
    );
    expect((await f.bundle()).configuration).toBeUndefined();
    expect(f.credentialRead).not.toHaveBeenCalled();
  });

  it.each([
    'model',
    'provider',
    'endpoint-tag',
    'credential-reference',
    'tokenizer-evidence',
  ] as const)(
    'keeps the %s fence for the newer spelling before credentials',
    async (change) => {
      const f = await answering('max_completion_tokens');
      if (change === 'model')
        f.settings.route.configuration.model = 'openai/another-model';
      if (change === 'provider')
        f.settings.route.configuration.provider = 'OpenAI';
      if (change === 'endpoint-tag')
        f.settings.route.endpointTag = 'azure/another-region';
      if (change === 'credential-reference')
        f.settings.route.credentialRef =
          SUPPORT_ASSISTANT_CREDENTIAL_REF + '-other';
      if (change === 'tokenizer-evidence')
        f.settings.tokenizer.evidenceRef = 'fictional-other-tokenizer-proof';
      f.settings.route.approval.requestPolicySha256 =
        await supportAssistantRoutePolicySha256(f.settings.route);
      f.environment.PEGMA_SUPPORT_ASSISTANT_CONFIGURATION_JSON = JSON.stringify(
        f.settings,
      );
      expect((await f.bundle()).configuration).toBeUndefined();
      expect(f.credentialRead).not.toHaveBeenCalled();
    },
  );
});
