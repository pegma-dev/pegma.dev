import { describe, expect, it, vi } from 'vitest';
import { knowledgePermissions } from '@pegma/knowledge-base-contracts';
import type { ResolutionTrustContext } from '@pegma/support-desk-application';
import {
  createSupportLearningBootstrap,
  readSupportLearningSourceConfiguration,
  SUPPORT_LEARNING_SOURCE_SETTING,
  SUPPORT_LEARNING_GOVERNANCE_READER,
  type SupportLearningSourceEnvironment,
} from './support-learning-bootstrap';

const start = '2026-11-10T12:00:00.000Z';
const signal = () => new AbortController().signal;
function configuration() {
  return {
    version: 1,
    revision: 'source-v1',
    namespace: 'fictional-source',
    intakeEnabled: true,
    product: {
      productId: 'workspace',
      version: '2.3.0',
      buildId: 'synthetic-build-230',
    },
    collectionIds: ['learning-guides'],
  };
}
function fixture(testEvidence = false) {
  let now = start;
  const raw = JSON.stringify({
    ...configuration(),
    ...(testEvidence
      ? { testEvidence: { retentionMilliseconds: 120_000 } }
      : {}),
  });
  const env: {
    -readonly [
      Key in keyof SupportLearningSourceEnvironment
    ]: SupportLearningSourceEnvironment[Key];
  } = {
    [SUPPORT_LEARNING_SOURCE_SETTING]: raw,
    PEGMA_KNOWLEDGE_ENABLED: 'true',
    PEGMA_SUPPORT_LEARNING_INTAKE_ENABLED: 'true',
  };
  const clock = { now: () => now };
  const bootstrap = createSupportLearningBootstrap(env, { clock });
  if (bootstrap === undefined)
    throw new Error('Expected valid Source configuration');
  const context = (): ResolutionTrustContext => ({
    ticketId: 'fictional-ticket',
    ticketRevision: 4,
    resolutionCycle: 1,
    resolvedAt: now,
    actorId: 'current-staff',
    acceptedAt: now,
  });
  return {
    env,
    raw,
    clock,
    bootstrap,
    context,
    at: (value: string) => {
      now = value;
    },
  };
}

describe('strict Source bootstrap configuration', () => {
  it('accepts and deeply freezes only the bounded declarative schema', () => {
    const result = readSupportLearningSourceConfiguration(
      JSON.stringify(configuration()),
    );
    expect(result).toEqual(configuration());
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.product)).toBe(true);
    expect(Object.isFrozen(result?.collectionIds)).toBe(true);
    expect(createSupportLearningBootstrap({})).toBeUndefined();
  });
  it.each([
    { ...configuration(), version: 2 },
    { ...configuration(), revision: '' },
    { ...configuration(), namespace: 'x'.repeat(81) },
    { ...configuration(), revision: 'bad\u0080revision' },
    { ...configuration(), intakeEnabled: 'true' },
    {
      ...configuration(),
      product: { productId: 'workspace', version: '2.3.0' },
    },
    {
      ...configuration(),
      product: { ...configuration().product, verified: true },
    },
    {
      ...configuration(),
      product: { ...configuration().product, buildId: 'x'.repeat(201) },
    },
    { ...configuration(), collectionIds: [] },
    { ...configuration(), collectionIds: ['one', 'one'] },
    {
      ...configuration(),
      collectionIds: Array.from({ length: 21 }, (_, index) => String(index)),
    },
    { ...configuration(), collectionIds: ['bad\ncollection'] },
    { ...configuration(), principalId: 'Admin' },
    { ...configuration(), permissions: ['knowledge.article.publish'] },
    { ...configuration(), verified: true },
    { ...configuration(), validUntil: '2030-01-01T00:00:00.000Z' },
    { ...configuration(), readApiKey: 'secret' },
    { ...configuration(), testEvidence: {} },
    { ...configuration(), testEvidence: { retentionMilliseconds: 0 } },
    { ...configuration(), testEvidence: { retentionMilliseconds: 1.5 } },
    {
      ...configuration(),
      testEvidence: { retentionMilliseconds: 100, access: {} },
    },
  ])('rejects invalid or trust-bearing data %#', (input) => {
    expect(
      readSupportLearningSourceConfiguration(JSON.stringify(input)),
    ).toBeUndefined();
  });
  it('rejects oversized UTF8, malformed and duplicate-key JSON', () => {
    for (const raw of [
      '{',
      'x'.repeat(16_385),
      JSON.stringify(configuration()).replace(
        '"version":1',
        '"version":1,"version":1',
      ),
    ])
      expect(readSupportLearningSourceConfiguration(raw)).toBeUndefined();
  });
});

describe('Source-only graph selection and current receipts', () => {
  it('returns only existing Source/intake ports, with no model, worker or checker configuration', async () => {
    const t = fixture();
    expect(t.bootstrap.learning.production).toBeUndefined();
    expect(t.bootstrap.learning.independentChecks).toBeUndefined();
    expect(t.bootstrap.learning.testEvidence).toBeUndefined();
    expect(
      await t.bootstrap.learning.source?.reviewPolicy.resolvePolicy(
        undefined,
        signal(),
      ),
    ).toEqual({ outcome: 'unavailable' });
    expect(
      (await t.bootstrap.learning.source?.serviceAccess.resolve(signal()))
        ?.outcome,
    ).toBe('ready');
    const author =
      await t.bootstrap.learning.source?.knowledgeAccess.resolve(signal());
    expect(author).toMatchObject({
      outcome: 'ready',
      authority: { access: { roles: [], entitlements: [] } },
    });
    expect(
      author?.outcome === 'ready' && author.authority.access.permissions,
    ).not.toContain(knowledgePermissions.validationManage);
  });
  it('uses per-operation five-minute applicability receipts without an expiring Source setting', async () => {
    const t = fixture();
    const port = t.bootstrap.learning.intake?.productContext;
    const first = await port?.resolve(t.context(), signal());
    expect(first).toMatchObject({
      ...configuration().product,
      verifiedAt: start,
      validUntil: '2026-11-10T12:05:00.000Z',
    });
    expect(first?.receiptId.length).toBeLessThanOrEqual(200);
    t.at('2036-11-10T12:00:00.000Z');
    expect(t.bootstrap.current()).toBe(true);
    const later = await port?.resolve(t.context(), signal());
    expect(later?.binding).toBe(first?.binding);
    expect(later?.contextVersion).toBe(first?.contextVersion);
    expect(later?.receiptId).not.toBe(first?.receiptId);
    expect(
      await port?.resolve({ ...t.context(), acceptedAt: start }, signal()),
    ).toBeNull();
  });
  it('closes captured ports when raw config, knowledge flag or selection changes', async () => {
    const t = fixture();
    const ports = t.bootstrap.learning.source;
    t.env.SUPPORT_LEARNING_SOURCE_CONFIGURATION_JSON = JSON.stringify({
      ...configuration(),
      revision: 'v2',
    });
    expect(await ports?.serviceAccess.resolve(signal())).toEqual({
      outcome: 'inactive',
    });
    expect(
      await t.bootstrap.learning.intake?.productContext?.resolve(
        t.context(),
        signal(),
      ),
    ).toBeNull();
    t.env.SUPPORT_LEARNING_SOURCE_CONFIGURATION_JSON = t.raw;
    t.env.PEGMA_KNOWLEDGE_ENABLED = 'false';
    expect(await ports?.retirementAccess.resolve(signal())).toEqual({
      outcome: 'inactive',
    });
    t.env.PEGMA_KNOWLEDGE_ENABLED = 'true';
    const captured = createSupportLearningBootstrap(t.env, {
      isSelected: () => false,
    });
    expect(
      await captured?.learning.source?.serviceAccess.resolve(signal()),
    ).toEqual({ outcome: 'inactive' });
  });
  it('changes authority identity when collection/product scope changes even with the same explicit revision', async () => {
    const t = fixture();
    const first =
      await t.bootstrap.learning.source?.serviceAccess.resolve(signal());
    const next = createSupportLearningBootstrap({
      ...t.env,
      [SUPPORT_LEARNING_SOURCE_SETTING]: JSON.stringify({
        ...configuration(),
        collectionIds: ['other-guides'],
      }),
    });
    const changed =
      await next?.learning.source?.serviceAccess.resolve(signal());
    expect(
      first?.outcome === 'ready' && first.authority.authorityVersion,
    ).not.toBe(
      changed?.outcome === 'ready' && changed.authority.authorityVersion,
    );
  });
  it('does not turn missing check policy into a success or accept a stale injected policy', async () => {
    const t = fixture();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const policy = vi.fn(async () => {
      await wait;
      return { outcome: 'unavailable' as const };
    });
    const options = { clock: t.clock, reviewPolicy: { resolvePolicy: policy } };
    const selected = createSupportLearningBootstrap(t.env, options);
    const result = selected?.learning.source?.reviewPolicy.resolvePolicy(
      undefined,
      signal(),
    );
    t.env.SUPPORT_LEARNING_SOURCE_CONFIGURATION_JSON = undefined;
    release();
    expect(await result).toEqual({ outcome: 'unavailable' });
  });
});

describe('optional internal governance read capability', () => {
  it('requires configured retention and exposes only validationManage within the selected callback scope', async () => {
    const t = fixture(true);
    const capability = t.bootstrap.learning.testEvidence;
    expect(capability?.retentionMilliseconds).toBe(120_000);
    const result = await capability?.governanceAccess.resolve(
      'learning-guides',
      signal(),
    );
    expect(result?.access.principalId).toBe(SUPPORT_LEARNING_GOVERNANCE_READER);
    expect(result?.access.permissions).toEqual([
      knowledgePermissions.validationManage,
    ]);
    expect(result?.access.roles).toEqual([]);
    expect(result?.access.entitlements).toEqual([]);
    expect(
      await capability?.governanceAccess.resolve(
        'unselected-private-collection',
        signal(),
      ),
    ).toBeNull();
    expect(fixture(false).bootstrap.learning.testEvidence).toBeUndefined();
  });
  it('checks live raw config, flags, cancellation and scope before returning authority', async () => {
    const t = fixture(true);
    const capability = t.bootstrap.learning.testEvidence!;
    const controller = new AbortController();
    controller.abort();
    expect(
      await capability.governanceAccess.resolve(
        'learning-guides',
        controller.signal,
      ),
    ).toBeNull();
    t.env.PEGMA_SUPPORT_LEARNING_INTAKE_ENABLED = 'false';
    expect(
      await capability.governanceAccess.resolve('learning-guides', signal()),
    ).toBeNull();
    t.env.PEGMA_SUPPORT_LEARNING_INTAKE_ENABLED = 'true';
    const result = capability.governanceAccess.resolve(
      'learning-guides',
      signal(),
    );
    t.env.SUPPORT_LEARNING_SOURCE_CONFIGURATION_JSON = undefined;
    expect(await result).toBeNull();
  });
});
