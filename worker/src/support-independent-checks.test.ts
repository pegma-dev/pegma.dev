import {
  createMemoryStore,
  type Store,
  type CollectionDefinition,
  type CollectionStore,
} from '@pegma/storage-core';
import { createRoleStore } from '@pegma/authorization-storage';
import { encode } from 'gpt-tokenizer';
import { describe, expect, it } from 'vitest';
import type { LearningChecksPort } from '@pegma/support-desk-ai';
import {
  createSupportEngineeringFixture,
  engineeringCanary,
} from './support-engineering-fixtures';
import {
  createSupportLearningFixture,
  learningCanary,
} from './support-learning-fixtures';
import {
  createSupportIndependentChecks,
  independentCheckAttempts,
  type IndependentCheckReceiptKey,
} from './support-independent-checks';
import {
  independentCheckRoutePolicyHash,
  INDEPENDENT_CHECK_PURPOSE,
  INDEPENDENT_CHECK_ENDPOINT,
  INDEPENDENT_CHECK_WIRE,
  type IndependentCheckRoute,
  type IndependentCheckModelOptions,
} from './support-independent-checks-model';

const PASS = {
  privacy: 'passed',
  factual: 'passed',
  security: 'clear',
  applicability: 'passed',
  duplication: 'passed',
  publicReproduction: 'passed',
  findings: [],
};
async function accounting(store: Store) {
  const row = await store
    .collection<{ payload: string }>({
      name: 'pegma.support-independent-checks.usage.v1',
      key: () => ({ partition: INDEPENDENT_CHECK_PURPOSE, id: 'budget' }),
      codec: {
        encode() {
          throw new Error('Read-only actual accounting observation');
        },
        decode(record) {
          if (
            record.partition !== INDEPENDENT_CHECK_PURPOSE ||
            record.id !== 'budget' ||
            typeof record.payload !== 'string'
          )
            throw new Error('Actual accounting row required');
          return { payload: record.payload };
        },
      },
    })
    .get({ partition: INDEPENDENT_CHECK_PURPOSE, id: 'budget' });
  if (!row) throw new Error('Real funded ledger required');
  return JSON.parse(row.payload);
}
function metered() {
  const real = createMemoryStore();
  const calls: string[] = [];
  const store: Store = {
    collection<T>(definition: CollectionDefinition<T>): CollectionStore<T> {
      const target = real.collection(definition);
      return new Proxy(target, {
        get(object, property, receiver) {
          const value: unknown = Reflect.get(object, property, receiver);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            calls.push(definition.name + ':' + String(property));
            return Reflect.apply(value, object, args);
          };
        },
      });
    },
  };
  return { store, calls };
}
async function provider(clock: { now(): string }, policyVersion: string) {
  const until = new Date(Date.parse(clock.now()) + 3_600_000).toISOString();
  const c: IndependentCheckRoute['configuration'] = {
    purpose: INDEPENDENT_CHECK_PURPOSE,
    version: 'fictional-checker-config',
    promptVersion: 'fictional-checker-prompt',
    parserVersion: 'fictional-checker-parser',
    modelVersion: 'fictional-checker-model',
    policyVersion,
    policyBinding: 'fictional-checker-policy-binding',
    rubricVersion: 'fictional-factual-rubric',
    model: 'fictional/independent',
    provider: 'Fictional Provider',
    pricingRef: 'fictional-price',
    trustedInstructions:
      'Check fictional whole requests against supplied authorized facts.',
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
      configurationBinding: 'fictional-checker-config',
      accountRef: 'fictional-account',
      projectRef: 'fictional-project',
      endpointRef: 'fictional-endpoint',
      modelRef: 'fictional-model',
      featuresRef: 'fictional-features',
      exceptionsRef: 'fictional-exceptions',
      intermediaryRefs: ['fictional-intermediary'],
      verifiedAt: clock.now(),
      validUntil: until,
    },
  };
  const base: Omit<IndependentCheckRoute, 'approval'> = {
    host: 'pegma.dev',
    purpose: INDEPENDENT_CHECK_PURPOSE,
    endpoint: INDEPENDENT_CHECK_ENDPOINT,
    endpointTag: 'fictional/region',
    outputTokenParameter: 'max_tokens',
    credentialRef: 'fictional-api-key-ref',
    usageScopeRef: 'fictional-independent-budget',
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
      verifiedAt: clock.now(),
      validUntil: until,
    },
  };
  const imported = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('FICTIONAL_TEST_ONLY_32_BYTE_HMAC__'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  const state = {
    enabled: true,
    calls: 0,
    bodies: [] as string[],
    key: {
      id: 'fictional-key-1',
      key: imported,
      validUntil: until,
    } as IndependentCheckReceiptKey | null,
    verdict: structuredClone(PASS),
    hook: undefined as (() => Promise<void>) | undefined,
    lost: false,
  };
  const options: IndependentCheckModelOptions = {
    clock,
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
    counter: {
      qualification: {
        model: c.model,
        modelVersion: c.modelVersion,
        wireVersion: INDEPENDENT_CHECK_WIRE,
        framingTokens: c.framingTokens,
        evidenceRef: 'fictional-tokenizer',
        verifiedAt: clock.now(),
        validUntil: until,
      },
      count: (s) => encode(s).length,
    },
    readApiKey: () => 'fictional-provider-credential',
    fetch: async (_url, init) => {
      state.calls++;
      state.bodies.push(String(init.body));
      await state.hook?.();
      if (state.lost) throw new Error('Fictional lost provider ACK');
      return new Response(
        JSON.stringify({
          id: 'fictional-response',
          object: 'chat.completion',
          created: 1,
          provider: c.provider,
          model: c.model,
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: JSON.stringify(state.verdict),
              },
            },
          ],
          usage: {
            prompt_tokens: 200,
            completion_tokens: 100,
            total_tokens: 300,
            cost: 0.0001,
            currency: 'USD',
            is_byok: false,
            prompt_tokens_details: { cached_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: 0 },
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  };
  const usagePolicy = {
    version: 'fictional-funding-v1',
    scopeRef: base.usageScopeRef,
    configurationVersion: c.version,
    modelVersion: c.modelVersion,
    pricingRef: c.pricingRef,
    currency: 'USD',
    maxCostMicros: 8_000,
    maxReservationCostMicros: 1_000,
    maxReservations: 8,
    validFrom: clock.now(),
    validUntil: until,
    terminalRetentionMilliseconds: 3_600_000,
  };
  return { state, options, route, usagePolicy };
}
async function engineering() {
  const measured = metered();
  const f = await createSupportEngineeringFixture(measured.store);
  const eligible = await f.eligible();
  expect((await f.process()).outcome).toBe('candidate');
  let captured: Parameters<typeof f.ports.checks.check>[0] | undefined;
  f.ports.checks.check = async (value) => {
    captured = structuredClone(value);
    return { outcome: 'held' };
  };
  await f.process();
  if (!captured || !captured.candidate)
    throw new Error('Actual SDK-built candidate request required');
  const p = await provider(f.clock, 'synthetic-check-policy-v1');
  const options = {
    ...p.options,
    store: measured.store,
    application: () => f.application,
    deferred: false,
    authority: {
      async resolve() {
        return {
          outcome: 'ready' as const,
          authority: {
            access: await f.resolve('engineering-staff'),
            authorityVersion: 'fictional-current-role-policy',
            usageScopeRef: p.usagePolicy.scopeRef,
          },
        };
      },
    },
    repositories: {
      async resolve(id: string) {
        return f.state.installationActive ? (f.metadata.get(id) ?? null) : null;
      },
    },
    usagePolicy: p.usagePolicy,
    readReceiptKey: () => p.state.key,
  };
  const adapter = createSupportIndependentChecks(options);
  const checks = adapter.engineeringFor(eligible.key);
  const input = {
    candidate: captured.candidate,
    exactRequest: captured.exactRequest,
    binding: captured.binding,
    checkPolicyVersion: 'synthetic-check-policy-v1',
  };
  const context = () => ({
    purpose: 'support_bug_assessment' as const,
    deadline: new Date(Date.parse(f.clock.now()) + 4_000).toISOString(),
    signal: new AbortController().signal,
  });
  measured.calls.length = 0;
  return { ...measured, f, p, options, adapter, checks, input, context };
}
async function learning(deferred = false) {
  const measured = metered();
  const f = await createSupportLearningFixture(measured.store);
  await f.enrollAndVerify();
  expect((await f.process()).outcome).toBe('candidate');
  let captured: Parameters<LearningChecksPort['check']>[0] | undefined;
  f.ports.checks.check = async (input) => {
    captured = structuredClone(input);
    return { outcome: 'held' };
  };
  await f.process();
  if (!captured) throw new Error('Actual SDK-built learning request required');
  const source = await f.runtime.readSource(f.actors.staff, 'learning-ticket');
  const p = await provider(f.clock, 'synthetic-learning-check-policy-v1');
  const options = {
    ...p.options,
    store: measured.store,
    application: () => f.application,
    deferred,
    authority: {
      async resolve() {
        return {
          outcome: 'ready' as const,
          authority: {
            access: await f.resolve(f.actors.staff.principalId),
            authorityVersion: 'fictional-current-policy',
            usageScopeRef: p.usagePolicy.scopeRef,
          },
        };
      },
    },
    knowledge: f.knowledge,
    knowledgeAccess: f.ports.knowledgeAccess,
    usagePolicy: p.usagePolicy,
    readReceiptKey: () => p.state.key,
  };
  const scope = {
    ticketId: 'learning-ticket',
    sourceGeneration: source.sourceGeneration,
  };
  const adapter = createSupportIndependentChecks(options);
  const checks = adapter.learningFor(scope);
  const context = () => ({
    purpose: 'support_learning' as const,
    deadline: new Date(Date.parse(f.clock.now()) + 4_000).toISOString(),
    signal: new AbortController().signal,
  });
  measured.calls.length = 0;
  return {
    ...measured,
    f,
    p,
    options,
    adapter,
    checks,
    scope,
    input: captured,
    context,
  };
}

/** Each call uses the actual durable controller and SDK-captured request. */
async function precomputeLearning(
  f: Awaited<ReturnType<typeof learning>>,
  adapter = f.adapter,
  checks = f.checks,
) {
  expect(await checks.check(f.input, f.context())).toEqual({ outcome: 'held' });
  expect(f.p.state.calls).toBe(0);
  const pending = await adapter.scanPending();
  expect(pending).toHaveLength(1);
  const hint = pending[0]!;
  expect(hint).toMatchObject({ kind: 'learning', scope: f.scope });
  await adapter.precomputePending(hint.operationId, f.context(), f.scope);
  return checks.check(f.input, f.context());
}

describe('actual SDK independent check admission and receipts', () => {
  it('checks the entire engineering request against genuine Source evidence and recovers a signed exact receipt without another paid call', async () => {
    const f = await engineering();
    const checked = await f.checks.check(f.input, f.context());
    expect(checked.outcome, JSON.stringify(f.calls)).toBe('checked');
    if (checked.outcome !== 'checked') return;
    const precomputeCalls = f.calls.length;
    f.calls.length = 0;
    expect(
      await f.checks.verify(checked.receipt, f.input.binding),
    ).toMatchObject({
      privacy: 'passed',
      factual: 'passed',
      security: 'clear',
    });
    const reuseCalls = f.calls.length;
    f.calls.length = 0;
    process.stdout.write(
      'independent-check-api-operations ' +
        JSON.stringify({
          directPrecompute: precomputeCalls,
          receiptVerification: reuseCalls,
        }) +
        '\n',
    );
    expect(await f.checks.check(f.input, f.context())).toEqual(checked);
    expect(f.p.state.calls).toBe(1);
    expect(f.p.state.bodies[0]).toContain('The downloaded export is empty.');
    expect(f.p.state.bodies[0]).not.toContain(engineeringCanary);
    expect(f.p.state.bodies[0]).not.toContain('synthetic-installation-');
    expect(f.p.state.bodies[0]).not.toContain('verificationReference');
    const staffView = await f.f.application.readStaffTicket(
      f.f.actors.staff,
      f.f.key().ticketId,
    );
    expect(
      staffView.messages.some(
        (message) =>
          message.visibility === 'internal' &&
          message.body === engineeringCanary,
      ),
    ).toBe(true);
    const wire = JSON.parse(
      JSON.parse(f.p.state.bodies[0]!).messages[1].content,
    );
    expect(wire.facts.messages).toEqual(
      staffView.messages
        .filter(
          (message) =>
            message.id === 'engineering-question' &&
            message.visibility === 'customer',
        )
        .map((message) => message.body),
    );
    expect(precomputeCalls).toBeGreaterThan(reuseCalls);
    expect(reuseCalls).toBe(0); // Cryptographic verification adds no paid-stage Store IO.
  });
  it('uses actual solution messages and target absence for learning instead of trusting candidate facts', async () => {
    const f = await learning(true);
    const checked = await precomputeLearning(f);
    expect(checked.outcome).toBe('checked');
    if (checked.outcome !== 'checked') return;
    expect(
      await f.checks.verify(checked.receipt, f.input.binding),
    ).toMatchObject({ applicability: 'passed', duplication: 'passed' });
    expect(f.p.state.bodies[0]).not.toContain(learningCanary);
    expect(f.p.state.bodies[0]).not.toContain('SYNTHETIC_PRIVATE_VERIFICATION');
    expect(f.p.state.bodies[0]).not.toContain('sourceReferences');
    const staffView = await f.f.application.readStaffTicket(
      f.f.actors.staff,
      'learning-ticket',
    );
    expect(
      staffView.messages.some(
        (message) =>
          message.visibility === 'internal' && message.body === learningCanary,
      ),
    ).toBe(true);
    const wire = JSON.parse(
      JSON.parse(f.p.state.bodies[0]!).messages[1].content,
    );
    expect(wire.facts.messages).toEqual(
      staffView.messages
        .filter(
          (message) =>
            message.id === 'learning-solution' &&
            message.visibility === 'customer',
        )
        .map((message) => message.body),
    );
  });
  it.each(['privacy', 'factual', 'applicability', 'duplication'] as const)(
    'holds independent learning %s failure and still accounts for the actual paid result',
    async (dimension) => {
      const f = await learning(true);
      f.p.state.verdict[dimension] = 'failed';
      expect((await precomputeLearning(f)).outcome).not.toBe(
        'checked',
      );
      expect(f.p.state.calls).toBe(1);
      const ledger = await f.store
        .collection(independentCheckAttempts)
        .get({ partition: INDEPENDENT_CHECK_PURPOSE, id: 'attempts' });
      expect(ledger?.entries[0]?.state).toBe('held');
      await f.checks.check(f.input, f.context());
      expect(f.p.state.calls).toBe(1);
    },
  );
  it.each(['restricted', 'uncertain'])(
    'security %s dominates an otherwise passing engineering verdict',
    async (security) => {
      const f = await engineering();
      f.p.state.verdict.security = security;
      expect(await f.checks.check(f.input, f.context())).toEqual({
        outcome: 'restricted',
      });
      expect(f.p.state.calls).toBe(1);
    },
  );
  it.each([
    'hidden-note',
    'forged-candidate',
    'forged-binding',
    'metadata',
    'policy',
  ] as const)('rejects engineering %s before paying', async (scenario) => {
    const f = await engineering();
    if (scenario === 'hidden-note')
      f.input.exactRequest = {
        ...f.input.exactRequest,
        bundle: {
          ...f.input.exactRequest.bundle,
          body:
            f.input.exactRequest.bundle.body +
            '\n<!--' +
            engineeringCanary +
            '-->',
        },
      };
    if (scenario === 'forged-candidate')
      f.input.candidate = {
        ...f.input.candidate,
        actualBehavior: 'Unverified exposure definitely occurred.',
      };
    if (scenario === 'forged-binding')
      f.input.binding = {
        ...f.input.binding,
        evidenceFingerprint: 'a'.repeat(64),
      };
    if (scenario === 'metadata') f.f.state.installationActive = false;
    if (scenario === 'policy') f.input.checkPolicyVersion = 'unapproved-policy';
    expect((await f.checks.check(f.input, f.context())).outcome).not.toBe(
      'checked',
    );
    expect(f.p.state.calls).toBe(0);
  });
  it('shows complete hidden Markdown, labels, templates and links to the independent checker', async () => {
    const f = await engineering();
    const { engineeringExportChecksBinding } =
      await import('@pegma/support-desk-application');
    f.input.exactRequest = {
      ...f.input.exactRequest,
      bundle: {
        ...f.input.exactRequest.bundle,
        body:
          f.input.exactRequest.bundle.body +
          '\n<!-- appears does not mean verified -->\nhttps://example.invalid/fictional',
        labels: ['bug', 'hidden-claim'],
        templateId: 'fictional-template',
      },
    };
    f.input.binding = await engineeringExportChecksBinding({
      ...f.input.binding,
      exactRequest: f.input.exactRequest,
    });
    f.p.state.verdict.factual = 'uncertain';
    expect((await f.checks.check(f.input, f.context())).outcome).not.toBe(
      'checked',
    );
    for (const text of [
      '<!-- appears does not mean verified -->',
      'hidden-claim',
      'fictional-template',
      'https://example.invalid/fictional',
    ])
      expect(f.p.state.bodies[0]).toContain(text);
  });
  it.each(['role', 'source', 'key', 'config', 'expiry'] as const)(
    'refuses late %s change after a real provider response',
    async (scenario) => {
      const f = await engineering();
      f.p.state.hook = async () => {
        if (scenario === 'role') await f.f.revoke('staff');
        if (scenario === 'source')
          await f.f.application.withdrawEngineeringSource(f.f.actors.staff, {
            ticketId: f.input.exactRequest.bundle.exportMarker
              ? 'engineering-ticket'
              : '',
            ...f.f.command('withdraw'),
            reason: 'privacy_withdrawal',
          });
        if (scenario === 'key') f.p.state.key = null;
        if (scenario === 'config') f.p.state.enabled = false;
        if (scenario === 'expiry') f.f.advance(60_001);
      };
      expect((await f.checks.check(f.input, f.context())).outcome).not.toBe(
        'checked',
      );
      expect(f.p.state.calls).toBe(1);
    },
  );
  it('never dispatches an exact concurrent duplicate or an unknown paid attempt twice', async () => {
    const f = await engineering();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    f.p.state.hook = async () => {
      entered();
      await gate;
    };
    const first = f.checks.check(f.input, f.context());
    try {
      await Promise.race([
        ready,
        first.then((result) => {
          throw new Error('Provider precondition failed: ' + result.outcome);
        }),
      ]);
      expect(await f.checks.check(f.input, f.context())).toEqual({
        outcome: 'held',
      });
    } finally {
      release();
    }
    expect((await first).outcome).toBe('checked');
    expect(f.p.state.calls).toBe(1);
    const g = await engineering();
    g.p.state.lost = true;
    expect((await g.checks.check(g.input, g.context())).outcome).toBe('held');
    expect((await g.checks.check(g.input, g.context())).outcome).toBe('held');
    expect(g.p.state.calls).toBe(1);
    expect(
      (
        await g.store
          .collection(independentCheckAttempts)
          .get({ partition: INDEPENDENT_CHECK_PURPOSE, id: 'attempts' })
      )?.entries[0]?.state,
    ).toBe('unknown');
  });
  it('requires a current key, purpose-qualified funding and route before a paid attempt', async () => {
    const f = await engineering();
    f.p.state.key = null;
    expect((await f.checks.check(f.input, f.context())).outcome).toBe('held');
    expect(f.p.state.calls).toBe(0);
    expect(
      await f.store
        .collection(independentCheckAttempts)
        .get({ partition: INDEPENDENT_CHECK_PURPOSE, id: 'attempts' }),
    ).toBeNull();
  });
  it('rejects modified receipt bytes, a different exact request, revoked Source, current policy and key rotation', async () => {
    const f = await engineering();
    const result = await f.checks.check(f.input, f.context());
    expect(result.outcome).toBe('checked');
    if (result.outcome !== 'checked') return;
    expect(
      await f.checks.verify(
        result.receipt.slice(0, -2) + 'aa',
        f.input.binding,
      ),
    ).toBeNull();
    expect(
      await f.checks.verify(result.receipt, {
        ...f.input.binding,
        requestHash: 'a'.repeat(64),
      }),
    ).toBeNull();
    f.p.state.key = { ...f.p.state.key!, id: 'fictional-rotated' };
    expect(await f.checks.verify(result.receipt, f.input.binding)).toBeNull();
    f.p.state.key = { ...f.p.state.key!, id: 'fictional-key-1' };
    await f.f.application.withdrawEngineeringSource(f.f.actors.staff, {
      ...f.f.command('withdraw'),
      ticketId: 'engineering-ticket',
      reason: 'privacy_withdrawal',
    });
    expect(
      await f.adapter.engineeringVerifier.verify(
        result.receipt,
        f.input.binding,
      ),
    ).toBeNull();
    // An SDK-bound receipt remains historical check evidence. It grants no live
    // Source eligibility and cannot pass the SDK's current Source/commit fences.
    expect(
      await f.checks.verify(result.receipt, f.input.binding),
    ).not.toBeNull();
    expect(
      await f.adapter.engineeringSdkVerifier.verify(
        result.receipt,
        f.input.binding,
      ),
    ).not.toBeNull();
    expect(
      await f.adapter
        .engineeringFor({
          ticketId: 'another-ticket',
          sourceGeneration: f.f.key().sourceGeneration,
        })
        .verify(result.receipt, f.input.binding),
    ).toBeNull();
    expect(f.p.state.calls).toBe(1);
  });
  it('defers the actual SDK proposal, precomputes once, then admits its exact regenerated request with a short durable receipt', async () => {
    const f = await engineering();
    const adapter = createSupportIndependentChecks({
      ...f.options,
      deferred: true,
    });
    const checks = adapter.engineeringFor(f.f.key());
    let verifyCalls = 0;
    Object.assign(f.f.ports.checks, checks, {
      verify: async (...args: Parameters<typeof checks.verify>) => {
        verifyCalls++;
        return checks.verify(...args);
      },
    });
    const originalSource = await f.f.source();
    const originalWork = await f.f.work();
    f.calls.length = 0;
    expect((await f.f.process()).outcome).toBe('held');
    const sdkHeldOperations = f.calls.length;
    expect(f.p.state.calls).toBe(0);
    const source = await f.f.source();
    const held = await f.f.work();
    expect(source).toMatchObject({
      state: 'eligible',
      sourceGeneration: originalSource.sourceGeneration,
    });
    expect(held.candidateHash).toBe(originalWork.candidateHash);
    expect(held.modelAttempts).toHaveLength(originalWork.modelAttempts.length);
    expect(held.proposal).toBeUndefined();
    expect(held.claim).toBeUndefined();
    const pending = await adapter.scanPending();
    expect(pending).toHaveLength(1);
    expect(JSON.stringify(pending)).not.toContain('exactRequest');
    f.calls.length = 0;
    const result = await adapter.precomputePending(
      pending[0]!.operationId,
      f.context(),
    );
    const precomputeOperations = f.calls.length;
    expect(result.outcome).toBe('checked');
    if (result.outcome !== 'checked') return;
    expect(result.receipt.length).toBeLessThanOrEqual(200);
    expect(f.p.state.calls).toBe(1);
    expect(await adapter.scanPending()).toEqual([]);
    const row = await f.store
      .collection(independentCheckAttempts)
      .get({ partition: INDEPENDENT_CHECK_PURPOSE, id: 'attempts' });
    expect(row?.entries[0]?.request).toBeNull();
    f.calls.length = 0;
    expect((await f.f.process()).outcome).toBe('prepared');
    process.stdout.write(
      'independent-check-sdk-api-operations ' +
        JSON.stringify({
          sdkHeld: sdkHeldOperations,
          separatePrecompute: precomputeOperations,
          sdkPreparedReplay: f.calls.length,
          sdkVerifyCalls: verifyCalls,
        }) +
        '\n',
    );
    expect(f.p.state.calls).toBe(1);
    expect(
      await adapter.readEngineeringReceipt(
        f.f.key(),
        f.input.binding,
        f.input.checkPolicyVersion,
      ),
    ).toBe(result.receipt);
    // Scope is recovered only from the authenticated durable receipt, never a hash scan.
    expect(
      await adapter.engineeringVerifier.verify(result.receipt, f.input.binding),
    ).not.toBeNull();
  });
  it('retains a changed full request separately and never supplies the old request receipt', async () => {
    const f = await engineering();
    const adapter = createSupportIndependentChecks({
      ...f.options,
      deferred: true,
    });
    const checks = adapter.engineeringFor(f.f.key());
    expect(await checks.check(f.input, f.context())).toEqual({
      outcome: 'held',
    });
    const first = (await adapter.scanPending())[0]!;
    expect(
      (await adapter.precomputePending(first.operationId, f.context())).outcome,
    ).toBe('checked');
    const { engineeringExportChecksBinding } =
      await import('@pegma/support-desk-application');
    const request = {
      ...f.input.exactRequest,
      bundle: {
        ...f.input.exactRequest.bundle,
        body: f.input.exactRequest.bundle.body + '\nNew independent text.',
      },
    };
    const binding = await engineeringExportChecksBinding({
      ...f.input.binding,
      exactRequest: request,
    });
    expect(
      await checks.check(
        { ...f.input, exactRequest: request, binding },
        f.context(),
      ),
    ).toEqual({ outcome: 'held' });
    expect(
      await adapter.readEngineeringReceipt(
        f.f.key(),
        binding,
        f.input.checkPolicyVersion,
      ),
    ).toBeNull();
    expect(await adapter.scanPending()).toHaveLength(1);
    expect(f.p.state.calls).toBe(1);
  });
  it.each(['withdrawal', 'expired', 'explicit-discard'] as const)(
    'redacts deferred private request bodies on %s without a paid call',
    async (scenario) => {
      const f = await engineering();
      const adapter = createSupportIndependentChecks({
        ...f.options,
        deferred: true,
      });
      const checks = adapter.engineeringFor(f.f.key());
      expect(await checks.check(f.input, f.context())).toEqual({
        outcome: 'held',
      });
      const pending = (await adapter.scanPending())[0]!;
      if (scenario === 'withdrawal') {
        await f.f.application.withdrawEngineeringSource(f.f.actors.staff, {
          ...f.f.command('privacy'),
          ticketId: 'engineering-ticket',
          reason: 'privacy_withdrawal',
        });
        expect(
          (await adapter.precomputePending(pending.operationId, f.context()))
            .outcome,
        ).toBe('held');
      }
      if (scenario === 'expired') {
        f.f.advance(60_001);
        expect(await adapter.purgeExpired()).toBe(1);
      }
      if (scenario === 'explicit-discard')
        expect(await adapter.discardPending(f.f.key())).toBe(1);
      const row = await f.store
        .collection(independentCheckAttempts)
        .get({ partition: INDEPENDENT_CHECK_PURPOSE, id: 'attempts' });
      expect(row?.entries[0]).toMatchObject({
        state: 'held',
        request: null,
        receipt: null,
        proof: null,
      });
      expect(f.p.state.calls).toBe(0);
      expect(await adapter.scanPending()).toEqual([]);
    },
  );
  it('persists known usage and retains unknown charges independently of semantic failure', async () => {
    const f = await learning(true);
    f.p.state.verdict.factual = 'failed';
    await precomputeLearning(f);
    const ledger = await f.store
      .collection({
        name: 'pegma.support-independent-checks.usage.v1',
        key: () => ({ partition: INDEPENDENT_CHECK_PURPOSE, id: 'budget' }),
        codec: {
          encode(value: { payload: string }) {
            return {
              partition: INDEPENDENT_CHECK_PURPOSE,
              id: 'budget',
              format: 1,
              payload: value.payload,
            };
          },
          decode(value) {
            return { payload: String(value.payload) };
          },
        },
      })
      .get({ partition: INDEPENDENT_CHECK_PURPOSE, id: 'budget' });
    expect(ledger).not.toBeNull();
    const accounting = JSON.parse(ledger!.payload);
    expect(accounting.spentMicros).toBe('100');
    expect(accounting.reservations[0]).toMatchObject({
      state: 'known',
      usage: { costMicros: 100 },
    });
    const g = await engineering();
    g.p.state.lost = true;
    await g.checks.check(g.input, g.context());
    const unknown = await g.store
      .collection(independentCheckAttempts)
      .get({ partition: INDEPENDENT_CHECK_PURPOSE, id: 'attempts' });
    expect(unknown?.entries[0]).toMatchObject({
      state: 'unknown',
      request: null,
      proof: null,
    });
  });
  it('enforces funded attempt capacity without evicting earlier packets or refreshing an expired owner', async () => {
    const f = await engineering();
    const adapter = createSupportIndependentChecks({
      ...f.options,
      deferred: true,
      usagePolicy: {
        ...f.options.usagePolicy,
        maxReservations: 1,
        maxCostMicros: 1_000,
      },
    });
    const checks = adapter.engineeringFor(f.f.key());
    expect(await checks.check(f.input, f.context())).toEqual({
      outcome: 'held',
    });
    const first = (await adapter.scanPending())[0]!;
    const { engineeringExportChecksBinding } =
      await import('@pegma/support-desk-application');
    const changed = {
      ...f.input.exactRequest,
      bundle: { ...f.input.exactRequest.bundle, title: 'A different request' },
    };
    const binding = await engineeringExportChecksBinding({
      ...f.input.binding,
      exactRequest: changed,
    });
    expect(
      await checks.check(
        { ...f.input, exactRequest: changed, binding },
        f.context(),
      ),
    ).toEqual({ outcome: 'held' });
    expect((await adapter.scanPending()).map((e) => e.operationId)).toEqual([
      first.operationId,
    ]);
    f.f.advance(60_001);
    expect(await adapter.purgeExpired()).toBe(1);
    expect(await checks.check(f.input, f.context())).toEqual({
      outcome: 'held',
    });
    expect(await adapter.scanPending()).toEqual([]);
    expect(f.p.state.calls).toBe(0);
  });
  it('recovers an actually committed successful check after the Store ACK is lost', async () => {
    const f = await engineering();
    let lose = true;
    const store: Store = {
      collection<T>(definition: CollectionDefinition<T>) {
        const target = f.store.collection(definition);
        return new Proxy(target, {
          get(object, name, receiver) {
            const value: unknown = Reflect.get(object, name, receiver);
            if (typeof value !== 'function') return value;
            return async (...args: unknown[]) => {
              const result: unknown = await Reflect.apply(value, object, args);
              if (
                name === 'update' &&
                definition.name === independentCheckAttempts.name &&
                lose &&
                JSON.stringify(result).includes('"state":"checked"')
              ) {
                lose = false;
                throw new Error(
                  'Fictional ACK lost after real checked-row commit',
                );
              }
              return result;
            };
          },
        });
      },
    };
    const adapter = createSupportIndependentChecks({
      ...f.options,
      store,
      deferred: true,
    });
    const checks = adapter.engineeringFor(f.f.key());
    expect(await checks.check(f.input, f.context())).toEqual({
      outcome: 'held',
    });
    const pending = (await adapter.scanPending())[0]!;
    expect(
      (await adapter.precomputePending(pending.operationId, f.context()))
        .outcome,
    ).toBe('unknown');
    expect(lose).toBe(false);
    expect(f.p.state.calls).toBe(1);
    const recovered = await checks.check(f.input, f.context());
    expect(recovered.outcome).toBe('checked');
    expect(f.p.state.calls).toBe(1);
    const durable = await f.store
      .collection(independentCheckAttempts)
      .get({ partition: INDEPENDENT_CHECK_PURPOSE, id: 'attempts' });
    expect(
      recovered.outcome === 'checked' ? recovered.receipt : undefined,
    ).toBe(durable?.entries[0]?.receipt);
    expect(await accounting(f.store)).toMatchObject({
      spentMicros: '100',
      reservations: [{ state: 'known', usage: { costMicros: 100 } }],
    });
  });
  it('does not transform a public reproduction failure into a reusable engineering receipt', async () => {
    const f = await engineering();
    f.p.state.verdict.publicReproduction = 'not_applicable';
    expect((await f.checks.check(f.input, f.context())).outcome).toBe('held');
    expect(f.p.state.calls).toBe(1);
  });
  it('does not treat candidate certainty as evidence when actual staff verification retains uncertainty', async () => {
    const f = await engineering();
    const ticket = await f.f.application.readStaffTicket(
      f.f.actors.staff,
      'engineering-ticket',
    );
    const accepted = await f.f.runtime.submitVerifiedFailure(f.f.actors.staff, {
      ticketId: 'engineering-ticket',
      clientCommandId: 'ACTUAL-UNCERTAIN-EVIDENCE',
      expectedRevision: ticket.ticket.revision,
      security: 'ordinary',
      evidence: {
        kind: 'staff_verified_failure',
        expectedBehavior: 'The export contains the workspace rows.',
        actualBehavior:
          'The export appears empty. Its contents were not independently opened.',
        reproductionSteps: ['Choose Export in a fictional workspace.'],
        visibleMessageIds: ['engineering-question'],
        verificationReference: 'FICTIONAL-UNCERTAIN-STAFF-OBSERVATION',
      },
    });
    const key = {
      ticketId: 'engineering-ticket',
      sourceGeneration: accepted.sourceGeneration,
    };
    let captured: Parameters<typeof f.f.ports.checks.check>[0] | undefined;
    f.f.ports.checks.check = async (input) => {
      captured = structuredClone(input);
      return { outcome: 'held' };
    };
    const process = () =>
      f.f.runtime.processWork({
        ...key,
        workerId: 'fictional-uncertainty-worker',
        leaseMilliseconds: 30_000,
      });
    expect((await process()).outcome).toBe('candidate');
    await process();
    if (!captured) throw new Error('Actual current request required');
    f.p.state.verdict.factual = 'failed';
    const checks = createSupportIndependentChecks(f.options).engineeringFor(
      key,
    );
    expect((await checks.check(captured, f.context())).outcome).toBe('held');
    expect(f.p.state.calls).toBe(1);
    expect(f.p.state.bodies[0]).toContain('appears empty');
    expect(f.p.state.bodies[0]).toContain('The downloaded export is empty.');
    expect(f.p.state.bodies[0]).toContain('staff_verified_failure');
  });
  it.each(['withdraw', 'reopen', 'service-role'] as const)(
    'real SDK forbids preparation when %s changes after SDK-bound receipt verification',
    async (scenario) => {
      const f = await engineering();
      const adapter = createSupportIndependentChecks({
        ...f.options,
        deferred: true,
      });
      const checks = adapter.engineeringFor(f.f.key());
      await checks.check(f.input, f.context());
      const pending = (await adapter.scanPending())[0]!;
      expect(
        (await adapter.precomputePending(pending.operationId, f.context()))
          .outcome,
      ).toBe('checked');
      let fired = false;
      Object.assign(f.f.ports.checks, checks, {
        async verify(...args: Parameters<typeof checks.verify>) {
          const proof = await checks.verify(...args);
          if (proof && !fired) {
            fired = true;
            if (scenario === 'withdraw')
              await f.f.application.withdrawEngineeringSource(
                f.f.actors.staff,
                {
                  ...f.f.command('privacy'),
                  ticketId: 'engineering-ticket',
                  reason: 'privacy_withdrawal',
                },
              );
            if (scenario === 'reopen') {
              await f.f.application.resolveTicket(f.f.actors.staff, {
                ...f.f.command('resolve'),
                ticketId: 'engineering-ticket',
              });
              await f.f.application.reopenTicket(f.f.actors.staff, {
                ...f.f.command('reopen'),
                ticketId: 'engineering-ticket',
              });
            }
            if (scenario === 'service-role') await f.f.revoke('processor');
          }
          return proof;
        },
      });
      expect((await f.f.process()).outcome).not.toBe('prepared');
      expect(fired).toBe(true);
      const work = await f.f.work();
      expect(work.proposal).toBeUndefined();
      expect(f.f.state.creates).toEqual([]);
      expect(f.p.state.calls).toBe(1);
    },
  );
  it('real host/SDK late staff authority still forbids approval after a valid independent receipt', async () => {
    const f = await engineering();
    const adapter = createSupportIndependentChecks({
      ...f.options,
      deferred: true,
    });
    const checks = adapter.engineeringFor(f.f.key());
    await checks.check(f.input, f.context());
    const pending = (await adapter.scanPending())[0]!;
    expect(
      (await adapter.precomputePending(pending.operationId, f.context()))
        .outcome,
    ).toBe('checked');
    Object.assign(f.f.ports.checks, checks);
    expect((await f.f.process()).outcome).toBe('prepared');
    let revoked = false;
    Object.assign(f.f.ports.checks, {
      async verify(...args: Parameters<typeof checks.verify>) {
        const proof = await checks.verify(...args);
        if (proof && !revoked) {
          revoked = true;
          await f.f.revoke('staff');
        }
        return proof;
      },
    });
    await expect(f.f.approve()).rejects.toThrow();
    expect(revoked).toBe(true);
    expect((await f.f.work()).approval).toBeUndefined();
    expect(f.f.state.creates).toEqual([]);
  });
  it('requires the original checker principal throughout the paid await, even if the replacement has more grants', async () => {
    const f = await engineering();
    let principal = 'engineering-staff';
    const authority = {
      async resolve() {
        return {
          outcome: 'ready' as const,
          authority: {
            access: await f.f.resolve(principal),
            authorityVersion: 'fictional-policy-v1',
            usageScopeRef: f.p.usagePolicy.scopeRef,
          },
        };
      },
    };
    const checks = createSupportIndependentChecks({
      ...f.options,
      authority,
    }).engineeringFor(f.f.key());
    f.p.state.hook = async () => {
      principal = 'engineering-security';
    };
    expect(await checks.check(f.input, f.context())).toEqual({
      outcome: 'held',
    });
    expect(f.p.state.calls).toBe(1);
  });
  it('observes actual Knowledge-role loss after the last draft read before signing learning evidence', async () => {
    const f = await learning(true);
    const roles = createRoleStore(f.store, 'pegma-learning-fixture');
    let reads = 0;
    const knowledge = {
      ...f.f.knowledge,
      async getDraft(...args: Parameters<typeof f.f.knowledge.getDraft>) {
        try {
          return await f.f.knowledge.getDraft(...args);
        } finally {
          if (++reads === 2) {
            const row = await roles.getRoleAssignment(
              'fixture-learning-role-knowledgeService',
            );
            if (!row) throw new Error('Actual role required');
            await roles.revokeRoleAssignmentWithAudit({
              assignmentId: row.assignment.id,
              expectedConcurrencyToken: row.concurrencyToken,
              revokedBy: { kind: 'system', systemId: 'fictional-check-test' },
              revokedAtEpochMs: Date.parse(f.f.clock.now()),
              auditEventId: 'fictional-knowledge-revoke',
            });
          }
        }
      },
    };
    const adapter = createSupportIndependentChecks({
      ...f.options,
      knowledge,
    });
    const checks = adapter.learningFor({
      ticketId: 'learning-ticket',
      sourceGeneration: f.input.exactRequest.sourceReferences.length
        ? (await f.f.runtime.readSource(f.f.actors.staff, 'learning-ticket'))
            .sourceGeneration
        : 0,
    });
    expect(await precomputeLearning(f, adapter, checks)).toEqual({
      outcome: 'held',
    });
    expect(reads).toBe(2);
    expect(f.p.state.calls).toBe(1);
  });
  it('retains unknown accounting on abort and never re-dispatches that pending owner', async () => {
    const f = await engineering();
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    f.p.state.hook = async () => {
      entered();
      await gate;
    };
    const controller = new AbortController();
    const first = f.checks.check(f.input, {
      ...f.context(),
      signal: controller.signal,
    });
    try {
      await Promise.race([
        ready,
        first.then(() => {
          throw new Error('Physical provider precondition required');
        }),
      ]);
      controller.abort();
      expect((await first).outcome).toBe('held');
    } finally {
      release();
    }
    expect((await f.checks.check(f.input, f.context())).outcome).toBe('held');
    expect(f.p.state.calls).toBe(1);
  });
  it('verifies already funded evidence without granting another paid call when funding is absent', async () => {
    const f = await engineering();
    const result = await f.checks.check(f.input, f.context());
    expect(result.outcome).toBe('checked');
    if (result.outcome !== 'checked') return;
    const { usagePolicy: _funding, ...options } = f.options;
    const adapter = createSupportIndependentChecks(options);
    const checks = adapter.engineeringFor(f.f.key());
    expect(await checks.verify(result.receipt, f.input.binding)).not.toBeNull();
    expect(
      (
        await checks.resolvePolicy(
          f.input.checkPolicyVersion,
          new AbortController().signal,
        )
      ).outcome,
    ).toBe('ready');
    expect(await checks.check(f.input, f.context())).toEqual({
      outcome: 'held',
    });
    expect(f.p.state.calls).toBe(1);
  });
  it('retains a genuine independent security restriction across the deferred boundary for the SDK', async () => {
    const f = await engineering();
    const adapter = createSupportIndependentChecks({
      ...f.options,
      deferred: true,
    });
    const checks = adapter.engineeringFor(f.f.key());
    Object.assign(f.f.ports.checks, checks);
    expect((await f.f.process()).outcome).toBe('held');
    f.p.state.verdict.security = 'uncertain';
    const pending = (await adapter.scanPending())[0]!;
    expect(
      (await adapter.precomputePending(pending.operationId, f.context()))
        .outcome,
    ).toBe('restricted');
    expect((await f.f.process()).outcome).not.toBe('prepared');
    expect((await f.f.source()).state).toBe('restricted');
    expect(f.p.state.calls).toBe(1);
    expect(f.f.state.creates).toEqual([]);
    const row = await f.store
      .collection(independentCheckAttempts)
      .get({ partition: INDEPENDENT_CHECK_PURPOSE, id: 'attempts' });
    expect(row?.entries[0]).toMatchObject({
      state: 'restricted',
      request: null,
      proof: null,
      receipt: null,
    });
  });
});

describe('compact checker proof boundaries', () => {
  it.each([
    'operation',
    'issuer',
    'future',
    'expiry',
    'verdict',
    'purpose',
    'noncanonical-time',
    'signature',
  ] as const)(
    'authenticates compact receipt %s header without Store reads',
    async (change) => {
      const f = await engineering();
      const result = await f.checks.check(f.input, f.context());
      expect(result.outcome).toBe('checked');
      if (result.outcome !== 'checked') return;
      const parts = result.receipt.split('.');
      expect(parts).toHaveLength(7);
      expect(result.receipt.length).toBeLessThanOrEqual(200);
      if (change === 'operation')
        parts[1] = (parts[1]![0] === 'a' ? 'b' : 'a') + parts[1]!.slice(1);
      if (change === 'issuer')
        parts[2] = (parts[2]![0] === 'A' ? 'B' : 'A') + parts[2]!.slice(1);
      if (change === 'future')
        parts[3] = (Date.parse(f.f.clock.now()) + 1).toString(36);
      if (change === 'expiry')
        parts[4] = (Number.parseInt(parts[4]!, 36) + 1).toString(36);
      if (change === 'verdict') parts[5] = parts[5] === 'p' ? 'n' : 'p';
      if (change === 'purpose') parts[5] = 'l';
      if (change === 'noncanonical-time') parts[4] = '0' + parts[4];
      if (change === 'signature')
        parts[6] = (parts[6]![0] === 'A' ? 'B' : 'A') + parts[6]!.slice(1);
      f.calls.length = 0;
      expect(
        await f.adapter.engineeringSdkVerifier.verify(
          parts.join('.'),
          f.input.binding,
        ),
      ).toBeNull();
      expect(f.calls).toEqual([]);
      expect(
        await f.adapter.engineeringSdkVerifier.verify(
          result.receipt,
          f.input.binding,
        ),
      ).not.toBeNull();
      expect(f.calls).toEqual([]);
    },
  );
  it.each([
    'sourceBindingHash',
    'evidenceFingerprint',
    'candidateHash',
    'routingBindingHash',
    'requestHash',
    'policyGeneration',
    'policyHash',
    'repositoryMetadataHash',
  ] as const)(
    'authenticates full supplied SDK binding field %s',
    async (field) => {
      const f = await engineering();
      const result = await f.checks.check(f.input, f.context());
      expect(result.outcome).toBe('checked');
      if (result.outcome !== 'checked') return;
      const binding = {
        ...f.input.binding,
        [field]:
          field === 'policyGeneration'
            ? f.input.binding.policyGeneration + 1
            : (String(f.input.binding[field])[0] === 'a' ? 'b' : 'a') +
              String(f.input.binding[field]).slice(1),
      };
      f.calls.length = 0;
      expect(
        await f.adapter.engineeringSdkVerifier.verify(result.receipt, binding),
      ).toBeNull();
      expect(f.calls).toEqual([]);
    },
  );
  it.each(['policyBinding', 'parserVersion'] as const)(
    'rejects approved current %s replacement with an unchanged key',
    async (field) => {
      const f = await engineering();
      const result = await f.checks.check(f.input, f.context());
      expect(result.outcome).toBe('checked');
      if (result.outcome !== 'checked') return;
      f.p.route.configuration[field] += '-replaced';
      const { approval, ...base } = f.p.route;
      approval.requestPolicySha256 =
        await independentCheckRoutePolicyHash(base);
      f.calls.length = 0;
      expect(
        await f.adapter.engineeringSdkVerifier.verify(
          result.receipt,
          f.input.binding,
        ),
      ).toBeNull();
      expect(f.calls).toEqual([]);
    },
  );
  it('rejects same-ID signing-key replacement and cross-purpose receipts using genuine crypto', async () => {
    const e = await engineering();
    const l = await learning(true);
    const er = await e.checks.check(e.input, e.context());
    const lr = await precomputeLearning(l);
    expect(er.outcome).toBe('checked');
    expect(lr.outcome).toBe('checked');
    if (er.outcome !== 'checked' || lr.outcome !== 'checked') return;
    const la = createSupportIndependentChecks(l.options);
    expect(
      await la.learningSdkVerifier.verify(er.receipt, l.input.binding),
    ).toBeNull();
    expect(
      await e.adapter.engineeringSdkVerifier.verify(
        lr.receipt,
        e.input.binding,
      ),
    ).toBeNull();
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('DIFFERENT_FICTIONAL_ONLY_HMAC_KEY'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    );
    e.p.state.key = { ...e.p.state.key!, key };
    expect(
      await e.adapter.engineeringSdkVerifier.verify(
        er.receipt,
        e.input.binding,
      ),
    ).toBeNull();
  });
  it.each(['role', 'source'] as const)(
    'withholds physical fetch after real %s revocation during the awaited pre-call proof',
    async (revoked) => {
      const f = await engineering();
      let resolves = 0;
      const checks = createSupportIndependentChecks({
        ...f.options,
        authority: {
          async resolve(signal) {
            const value = await f.options.authority.resolve();
            if (++resolves === 3) {
              if (revoked === 'role') await f.f.revoke('staff');
              else
                await f.f.application.withdrawEngineeringSource(
                  f.f.actors.staff,
                  {
                    ...f.f.command('privacy'),
                    ticketId: f.f.key().ticketId,
                    reason: 'privacy_withdrawal',
                  },
                );
            }
            if (signal.aborted) return { outcome: 'inactive' as const };
            return value;
          },
        },
      }).engineeringFor(f.f.key());
      expect(await checks.check(f.input, f.context())).toEqual({
        outcome: 'held',
      });
      expect(resolves).toBeGreaterThanOrEqual(3);
      expect(f.p.state.calls).toBe(0);
      expect(f.p.state.bodies).toEqual([]);
      const row = await f.store
        .collection(independentCheckAttempts)
        .get({ partition: INDEPENDENT_CHECK_PURPOSE, id: 'attempts' });
      expect(row?.entries[0]).toMatchObject({
        state: 'held',
        receipt: null,
        proof: null,
      });
      expect(await accounting(f.store)).toMatchObject({
        spentMicros: '0',
        reservations: [{ state: 'not_called', usage: null }],
      });
    },
  );
  it('accounts a missing synchronous credential as not_called and never treats it as a paid unknown', async () => {
    const f = await engineering();
    const checks = createSupportIndependentChecks({
      ...f.options,
      readApiKey: () => undefined,
    }).engineeringFor(f.f.key());
    expect(await checks.check(f.input, f.context())).toEqual({
      outcome: 'held',
    });
    expect(f.p.state.calls).toBe(0);
    expect(await accounting(f.store)).toMatchObject({
      spentMicros: '0',
      reservations: [{ state: 'not_called', usage: null }],
    });
  });
  it('holds an uncommitted DONE CAS after real competing opaque-version writes without paying again', async () => {
    const f = await engineering();
    let conflicts = 0;
    const store: Store = {
      collection<T>(definition: CollectionDefinition<T>) {
        const target = f.store.collection(definition);
        const update: CollectionStore<T>['update'] = (key, decide, options) =>
          target.update(
            key,
            async (current) => {
              const decision = await decide(current);
              if (
                definition.name === independentCheckAttempts.name &&
                current &&
                decision.action === 'write' &&
                JSON.stringify(decision.value).includes('"state":"checked"')
              ) {
                await target.put(current);
                conflicts++;
              }
              return decision;
            },
            options,
          );
        return new Proxy(target, {
          get(object, name, receiver) {
            if (name === 'update') return update;
            const value: unknown = Reflect.get(object, name, receiver);
            return typeof value === 'function' ? value.bind(object) : value;
          },
        });
      },
    };
    const adapter = createSupportIndependentChecks({
      ...f.options,
      store,
      deferred: true,
    });
    const checks = adapter.engineeringFor(f.f.key());
    await checks.check(f.input, f.context());
    const pending = (await adapter.scanPending())[0]!;
    expect(
      (await adapter.precomputePending(pending.operationId, f.context()))
        .outcome,
    ).toBe('unknown');
    expect(conflicts).toBe(2);
    const head = await f.store
      .collection(independentCheckAttempts)
      .get({ partition: INDEPENDENT_CHECK_PURPOSE, id: 'attempts' });
    expect(head?.entries[0]).toMatchObject({
      state: 'unknown',
      receipt: null,
      proof: null,
      request: null,
    });
    expect(await checks.check(f.input, f.context())).toEqual({
      outcome: 'held',
    });
    expect(f.p.state.calls).toBe(1);
    expect(await accounting(f.store)).toMatchObject({
      spentMicros: '100',
      reservations: [{ state: 'known' }],
    });
  });
});
