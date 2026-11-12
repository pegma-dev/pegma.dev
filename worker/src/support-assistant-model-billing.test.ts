import {
  createMemoryStore,
  defineCollection,
  type StoredRecord,
} from '@pegma/storage-core';
import { describe, expect, it, vi } from 'vitest';
import { supportAssistantFixture } from './support-assistant-fixtures';
import {
  createSupportAssistantConfiguration,
  supportAssistantRoutePolicySha256,
  SUPPORT_ASSISTANT_ENDPOINT,
  SUPPORT_ASSISTANT_WIRE_VERSION,
  type ApprovedSupportAssistantRoute,
} from './support-assistant-config';
import { createSupportAssistantOpenRouterModel } from './support-assistant-model';
import { createSupportAssistantUsage } from './support-assistant-usage';

const rawLedger = defineCollection<StoredRecord>({
  name: 'pegma.support-assistant-usage.v1',
  key: (value) => ({
    partition: String(value.partition),
    id: String(value.id),
  }),
  codec: {
    encode: (value) => ({ ...value }),
    decode: (value) => ({ ...value }),
  },
});
const key = { partition: 'support_answer', id: 'budget' };

describe('native billing through the public SDK and actual durable host ledger', () => {
  it('settles a finite over-budget native charge once, with no answer or new funding', async () => {
    const store = createMemoryStore();
    const f = await supportAssistantFixture({ store });
    const original = f.configuration();
    const config = {
      ...original,
      dataControls: {
        ...original.dataControls,
        intermediaryRefs: ['fictional-intermediary'],
      },
    };
    f.replaceConfiguration(config);
    // Fictional provider, price, route and qualification only. The actual
    // public SDK, Identity/roles, KB source, Store and accounting ports run.
    const base: Omit<ApprovedSupportAssistantRoute, 'approval'> = {
      host: 'pegma.dev' as const,
      purpose: 'support_answer' as const,
      endpoint: SUPPORT_ASSISTANT_ENDPOINT,
      endpointTag: 'fictional/region-one',
      outputTokenParameter: 'max_tokens' as const,
      credentialRef: 'fictional-credential-reference',
      usageScopeRef: f.usagePolicy.scopeRef,
      configuration: config,
    };
    const route: ApprovedSupportAssistantRoute = {
      ...base,
      approval: {
        configurationVersion: config.version,
        wireVersion: SUPPORT_ASSISTANT_WIRE_VERSION,
        evidenceRef: 'fictional-approval',
        effectivePolicyRef: 'fictional-policy',
        evaluationRef: 'fictional-evaluation',
        responseIdentityRef: 'fictional-identity',
        tokenizerRef: 'fictional-counter',
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
        verifiedAt: config.dataControls.verifiedAt,
        validUntil: config.dataControls.validUntil,
      },
    };
    const configuration = createSupportAssistantConfiguration({
      clock: f.clock,
      isEnabled: () => true,
      readRoute: () => route,
      allowlist: [
        {
          model: config.model,
          provider: config.provider,
          endpointTag: base.endpointTag,
          outputTokenParameter: base.outputTokenParameter,
        },
      ],
      counter: {
        qualification: {
          model: config.model,
          modelVersion: config.modelVersion,
          wireVersion: SUPPORT_ASSISTANT_WIRE_VERSION,
          framingTokens: config.framingTokens,
          evidenceRef: route.approval.tokenizerRef,
          verifiedAt: route.approval.verifiedAt,
          validUntil: route.approval.validUntil,
        },
        count: (text) => new TextEncoder().encode(text).byteLength,
      },
    });
    expect((await configuration.configuration.resolve()).outcome).toBe('ready');
    const fetch = vi.fn(async () =>
      Response.json({
        id: 'gen-fictional-overage',
        object: 'chat.completion',
        provider: config.provider,
        model: config.model,
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: JSON.stringify({
                kind: 'escalate',
                text: 'Contact support.',
                reason: 'other',
                citations: [],
              }),
            },
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 30,
          total_tokens: 130,
          cost: 0.15,
          currency: 'USD',
        },
      }),
    );
    const model = createSupportAssistantOpenRouterModel({
      clock: f.clock,
      configuration,
      readApiKey: () => 'fictional-not-a-real-key',
      fetch,
    });
    f.setModel((input, context) => model.generate(input, context, config));
    await f.untilTurn();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      (await f.messages()).filter(
        (message) => message.authorKind === 'assistant',
      ),
    ).toHaveLength(0);
    const retained = await store.collection(rawLedger).get(key);
    expect(retained).not.toBeNull();
    const payload: unknown = JSON.parse(String(retained!.payload));
    expect(payload).toMatchObject({
      spentMicros: '150000',
      accountingHold: false,
      reservations: [
        {
          state: 'known',
          reservedMicros: 10_000,
          usage: {
            inputTokens: 100,
            outputTokens: 30,
            costMicros: 150_000,
            currency: 'USD',
          },
        },
      ],
    });
    const context = f.usageReservations[0];
    if (!context) throw new Error('The real SDK did not reserve its attempt');
    const identity = {
      operationId: context.operationId,
      attemptId: context.attemptId,
      inputFingerprint: context.inputFingerprint,
      usageReservationId: context.usageReservationId,
    };
    const reconstructed = createSupportAssistantUsage({
      store,
      clock: f.clock,
      policy: f.usagePolicy,
    });
    expect(
      await reconstructed.reconcile(identity, {
        state: 'known',
        usage: {
          inputTokens: 100,
          outputTokens: 30,
          costMicros: 150_000,
          currency: 'USD',
        },
      }),
    ).toBe('reconciled');
    expect(await reconstructed.reconcile(identity, { state: 'unknown' })).toBe(
      'reconciled',
    );
    expect(await store.collection(rawLedger).get(key)).toEqual(retained);
    await f.createTicket('fictional-second-unfunded-ticket');
    await f.untilTurn();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      (await f.messages('fictional-second-unfunded-ticket')).filter(
        (message) => message.authorKind === 'assistant',
      ),
    ).toHaveLength(0);
  });
});
