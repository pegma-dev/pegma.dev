import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasPermission } from '@pegma/authorization-core';
import { supportPermissions } from '@pegma/support-desk-application';
import { createMemoryStore } from '@pegma/storage-core';
import { createSupportModelUsageLedger } from './support-model-usage-ledger';
import {
  createSupportPaidBootstrap,
  createSupportReceiptKeyProvider,
} from './support-paid-bootstrap';
import { readSupportPaidProfile } from './support-paid-profile';
import { paidBootstrapFixture, PAID_START } from './support-paid-bootstrap-fixtures';
const signal = () => new AbortController().signal;
afterEach(() => vi.restoreAllMocks());
describe('closed current paid operator bootstrap', () => {
  it('is inert when absent or malformed and refuses arbitrary grants/unknown fields', async () => {
    const key = vi.fn(() => {
      throw new Error('Secret must stay unread');
    });
    const env = Object.defineProperty({}, 'SUPPORT_INDEPENDENT_CHECK_RECEIPT_KEY_BASE64', {
      get: key,
    });
    expect(await createSupportPaidBootstrap(env)).toBeUndefined();
    const f = await paidBootstrapFixture();
    for (const changed of [
      { ...f.profile, permissions: ['Admin'] },
      { ...f.profile, version: 2 },
      { ...f.profile, revision: '' },
    ])
      expect(readSupportPaidProfile(JSON.stringify(changed))).toBeUndefined();
    expect(key).not.toHaveBeenCalled();
    expect(readSupportPaidProfile('{"version":1,"version":1}')).toBeUndefined();
  });
  it('retains genuine nonpaid policy and Source intake when model/funding/key flags are OFF', async () => {
    const f = await paidBootstrapFixture();
    Reflect.set(f.env, 'PEGMA_SUPPORT_INDEPENDENT_CHECKS_ENABLED', 'false');
    Reflect.set(f.env, 'PEGMA_SUPPORT_LEARNING_WORKER_ENABLED', 'false');
    const key = vi.fn(() => {
      throw new Error('No HMAC or provider key while OFF');
    });
    Object.defineProperty(f.env, 'SUPPORT_INDEPENDENT_CHECK_RECEIPT_KEY_BASE64', { get: key });
    Object.defineProperty(f.env, 'SUPPORT_ASSISTANT_OPENROUTER_API_KEY', { get: key });
    const b = await createSupportPaidBootstrap(f.env, { clock: f.clock });
    expect(b).toBeDefined();
    expect(await b!.learning.source!.reviewPolicy.resolvePolicy(undefined, signal())).toMatchObject(
      { outcome: 'ready', policy: { version: 'fictional-policy' } },
    );
    expect(b!.learning.intake!.enabled).toBe(true);
    expect(b!.learning.production?.enabled?.()).toBe(false);
    expect(key).not.toHaveBeenCalled();
  });
  it('keeps Source intake but holds paid ports with prior v1 checker route and tokenizer evidence', async () => {
    const f = await paidBootstrapFixture();
    Object.assign(f.profile.checks.route.approval, {
      wireVersion: 'openrouter-support-independent-check-v1',
    });
    Object.assign(f.profile.checks.qualification, {
      wireVersion: 'openrouter-support-independent-check-v1',
    });
    Reflect.set(f.env, 'SUPPORT_PAID_CONFIGURATION_JSON', JSON.stringify(f.profile));
    const key = vi.fn(() => {
      throw new Error('Prior wire evidence must not read a key');
    });
    Object.defineProperty(f.env, 'SUPPORT_INDEPENDENT_CHECK_RECEIPT_KEY_BASE64', { get: key });
    Object.defineProperty(f.env, 'SUPPORT_ASSISTANT_OPENROUTER_API_KEY', { get: key });
    const b = await createSupportPaidBootstrap(f.env, { clock: f.clock });
    expect(b).toBeDefined();
    expect(b!.learning.intake!.enabled).toBe(true);
    expect(await b!.learning.source!.reviewPolicy.resolvePolicy(undefined, signal())).toEqual({
      outcome: 'unavailable',
    });
    expect(b!.learning.independentChecks).toBeUndefined();
    expect(key).not.toHaveBeenCalled();
  });
  it('uses distinct intrinsic ceilings with the exact SAME checker pool and a distinct generation scope', async () => {
    const f = await paidBootstrapFixture();
    const b = (await createSupportPaidBootstrap(f.env, { clock: f.clock }))!;
    const learning = await b.learning.independentChecks!.authority.resolve(signal());
    const engineering = await b.learning.engineeringIndependentChecks!.authority.resolve(signal());
    const generation = await b.learning.production!.configuration!.serviceAccess.resolve(signal());
    expect(learning.outcome).toBe('ready');
    expect(engineering.outcome).toBe('ready');
    expect(generation.outcome).toBe('ready');
    if (
      learning.outcome !== 'ready' ||
      engineering.outcome !== 'ready' ||
      generation.outcome !== 'ready'
    )
      throw new Error('Actual intrinsic authority required');
    expect(learning.authority.access.principalId).toBe('pegma/support-learning-source');
    expect(engineering.authority.access.principalId).toBe('pegma/support-engineering-worker');
    expect(hasPermission(learning.authority.access, supportPermissions.engineeringRead)).toBe(
      false,
    );
    expect(hasPermission(engineering.authority.access, supportPermissions.learningRead)).toBe(
      false,
    );
    expect(learning.authority.usageScopeRef).toBe(f.profile.checks.usagePolicy.scopeRef);
    expect(engineering.authority.usageScopeRef).toBe(learning.authority.usageScopeRef);
    expect(generation.authority.usageScopeRef).toBe(f.profile.learning.usagePolicy.scopeRef);
    expect(b.learning.independentChecks!.usagePolicy).toBe(
      b.learning.engineeringIndependentChecks!.usagePolicy,
    );
    const store = createMemoryStore();
    const policy = b.learning.independentChecks!.usagePolicy!;
    const schema = {
      purpose: 'support_independent_check',
      collection: 'pegma.support-independent-checks.usage.v1',
      key: { partition: 'support_independent_check', id: 'budget' },
      binding: (c: { inputFingerprint: string }) => c.inputFingerprint,
      identity: (c: {
        purpose: string;
        operationId: string;
        attemptId: string;
        inputFingerprint: string;
        usageReservationId: string;
      }) => c,
    };
    const first = createSupportModelUsageLedger({ store, clock: f.clock, policy }, schema);
    const second = createSupportModelUsageLedger({ store, clock: f.clock, policy }, schema);
    const context = (id: string) => ({
      purpose: 'support_independent_check',
      operationId: id,
      attemptId: id,
      inputFingerprint: id,
      usageReservationId: id,
      usageScopeRef: policy.scopeRef,
      configurationVersion: policy.configurationVersion,
      modelVersion: policy.modelVersion,
      deadline: '2026-11-10T12:00:10.000Z',
      signal: signal(),
      budgets: { currency: 'USD', maxCostMicros: 1000 },
    });
    expect(await first.reserve(context('learning-check'))).toMatchObject({ outcome: 'reserved' });
    expect(await second.reserve(context('engineering-check'))).toMatchObject({
      outcome: 'reserved',
    });
    expect(await first.reserve(context('third-check'))).toMatchObject({ outcome: 'denied' });
  });
  it('revokes current policy, processing and operator receipt key after profile/source/key replacement', async () => {
    const f = await paidBootstrapFixture();
    const b = (await createSupportPaidBootstrap(f.env, { clock: f.clock }))!;
    expect(b.learning.independentChecks!.readReceiptKey!()).not.toBeNull();
    Reflect.set(f.env, 'SUPPORT_INDEPENDENT_CHECK_RECEIPT_KEY_BASE64', btoa('z'.repeat(32)));
    expect(b.learning.independentChecks!.readReceiptKey!()).toBeNull();
    expect(b.learning.production!.enabled!()).toBe(false);
    Reflect.set(
      f.env,
      'SUPPORT_PAID_CONFIGURATION_JSON',
      JSON.stringify({ ...f.profile, revision: 'replacement' }),
    );
    expect(await b.learning.source!.reviewPolicy.resolvePolicy(undefined, signal())).toEqual({
      outcome: 'unavailable',
    });
    expect((await b.learning.source!.serviceAccess.resolve(signal())).outcome).toBe('inactive');
  });
  it('holds current published or private draft ambiguity and never overwrites existing guidance', async () => {
    const f = await paidBootstrapFixture();
    const b = (await createSupportPaidBootstrap(f.env, { clock: f.clock }))!;
    const port = b.learning.production!.configuration!.targets;
    const context = { signal: signal(), deadline: '2026-11-10T12:00:10.000Z' };
    const result = await port.resolveScope(
      { ...f.source.product, binding: 'fictional-bound', contextVersion: 'fictional-current' },
      context,
    );
    if (result.outcome !== 'ready') throw new Error('Expected target scope');
    const input = {
      candidate: {
        problem: 'Fictional export',
        steps: ['Export.'],
        solution: 'Inspect the file.',
        validationRequirements: ['Check it opens.'],
        applicability: f.source.product,
      },
      scope: result.scope,
      newArticleId: 'new-guide',
      publishedMatches: [],
      explicitDrafts: [],
    };
    expect(await port.select(input, { ...context, sourceFence: {} as never })).toMatchObject({
      outcome: 'selected',
      operation: 'create',
    });
    expect(
      await port.select(
        { ...input, explicitDrafts: [{} as never] },
        { ...context, sourceFence: {} as never },
      ),
    ).toEqual({ outcome: 'held' });
    expect(
      await port.select(
        { ...input, publishedMatches: [{} as never] },
        { ...context, sourceFence: {} as never },
      ),
    ).toEqual({ outcome: 'held' });
  });
  it('refuses an unversioned/missing/expired key and a key arriving after profile revocation', async () => {
    const f = await paidBootstrapFixture();
    let enabled = true;
    const provider = createSupportReceiptKeyProvider(
      f.env,
      f.profile.checks.receiptKey as never,
      () => enabled,
      f.clock,
    );
    const pending = provider.resolve('support-independent-check-receipt', signal());
    enabled = false;
    expect(await pending).toBeNull();
    expect(await provider.resolve('wrong-key', signal())).toBeNull();
    expect(PAID_START).toBe(f.clock.now());
  });
  it.each([220, 1500])(
    'bounds KB metadata but retains the full %i-character problem and solution',
    async (length) => {
      const f = await paidBootstrapFixture();
      const b = (await createSupportPaidBootstrap(f.env, { clock: f.clock }))!;
      const port = b.learning.production!.configuration!.targets;
      const context = { signal: signal(), deadline: '2026-11-10T12:00:10.000Z' };
      const scope = await port.resolveScope(
        { ...f.source.product, binding: 'fictional-binding', contextVersion: 'fictional-version' },
        context,
      );
      if (scope.outcome !== 'ready') throw new Error('Expected actual target scope');
      const problem = 'p'.repeat(length),
        solution = 'Complete solution retained.';
      const selected = await port.select(
        {
          candidate: {
            problem,
            solution,
            steps: ['One full step.'],
            validationRequirements: ['Complete validation.'],
            applicability: f.source.product,
          },
          scope: scope.scope,
          newArticleId: 'bounded-guide',
          publishedMatches: [],
          explicitDrafts: [],
        },
        { ...context, sourceFence: {} as never },
      );
      expect(selected.outcome).toBe('selected');
      if (selected.outcome !== 'selected') throw new Error('Expected bounded draft');
      expect(selected.draft.title).toBe(f.profile.learning.target.title);
      expect(selected.draft.summary.length).toBeLessThanOrEqual(1000);
      expect(selected.draft.content.text).toContain(problem);
      expect(selected.draft.content.text).toContain(solution);
    },
  );

  it('closes a profile replaced while the explicit operator keyProvider is awaited, before any provider credential read', async () => {
    const f = await paidBootstrapFixture();
    let entered = false;
    let release: () => void = () => {};
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const key = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(32).fill(7),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    );
    const secret = vi.fn(() => {
      throw new Error('No provider credential after revocation');
    });
    Object.defineProperty(f.env, 'SUPPORT_ASSISTANT_OPENROUTER_API_KEY', { get: secret });
    const pending = createSupportPaidBootstrap(f.env, {
      clock: f.clock,
      keyProvider: {
        async resolve() {
          entered = true;
          await paused;
          return {
            id: f.profile.checks.receiptKey.id,
            key,
            validUntil: f.profile.checks.receiptKey.validUntil,
          };
        },
        current() {
          return true;
        },
      },
    });
    for (let turn = 0; turn < 100 && !entered; turn++)
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    expect(entered).toBe(true);
    Reflect.set(
      f.env,
      'SUPPORT_PAID_CONFIGURATION_JSON',
      JSON.stringify({ ...f.profile, revision: 'replaced-during-key-await' }),
    );
    release();
    expect(await pending).toBeUndefined();
    expect(secret).not.toHaveBeenCalled();
  });
  it('holds an unmatched checker pool without consulting an operator keyProvider', async () => {
    const f = await paidBootstrapFixture();
    const profile = {
      ...f.profile,
      checks: {
        ...f.profile.checks,
        usagePolicy: { ...f.profile.checks.usagePolicy, scopeRef: 'wrong-pool' },
      },
    };
    Reflect.set(f.env, 'SUPPORT_PAID_CONFIGURATION_JSON', JSON.stringify(profile));
    const resolve = vi.fn(async () => null);
    const b = await createSupportPaidBootstrap(f.env, {
      clock: f.clock,
      keyProvider: { resolve, current: () => false },
    });
    expect(b?.learning.intake?.enabled).toBe(true);
    expect(b?.learning.production).toBeUndefined();
    expect(resolve).not.toHaveBeenCalled();
  });
  it('rejects overlong KB title and tag metadata using the public ceilings', async () => {
    const f = await paidBootstrapFixture();
    for (const target of [
      { ...f.profile.learning.target, title: 't'.repeat(201) },
      { ...f.profile.learning.target, tags: ['t'.repeat(65)] },
      { ...f.profile.learning.target, tags: Array.from({ length: 17 }, (_, i) => 'tag-' + i) },
    ])
      expect(
        readSupportPaidProfile(
          JSON.stringify({ ...f.profile, learning: { ...f.profile.learning, target } }),
        ),
      ).toBeUndefined();
  });
  it('contains an unavailable operator keyProvider without removing current nonpaid Source policy', async () => {
    const f = await paidBootstrapFixture();
    const b = await createSupportPaidBootstrap(f.env, {
      clock: f.clock,
      keyProvider: {
        async resolve() {
          throw new Error('Fictional key service unavailable');
        },
        current() {
          throw new Error('Fictional key service unavailable');
        },
      },
    });
    expect(b?.learning.intake?.enabled).toBe(true);
    expect(await b?.learning.source?.reviewPolicy.resolvePolicy(undefined, signal())).toMatchObject(
      { outcome: 'ready' },
    );
    expect(b?.learning.production?.enabled?.()).toBe(false);
  });
});
