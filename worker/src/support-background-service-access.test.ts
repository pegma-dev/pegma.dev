import { describe, expect, it, vi } from 'vitest';
import { supportPermissions as p } from '@pegma/support-desk-application';
import { knowledgePermissions as k } from '@pegma/knowledge-base-contracts';
import {
  createSupportBackgroundServiceAccess,
  SUPPORT_BACKGROUND_SERVICE_IDS,
  type SupportBackgroundServiceAccessOptions,
  type SupportBackgroundServiceKind,
  type SupportBackgroundServiceProfile,
} from './support-background-service-access';

const live = () => new AbortController().signal;
const source = [p.queueRead, p.learningRead, p.learningProcess];
const ceilings = {
  'learning-source': source,
  'learning-draft': [
    ...source,
    k.articleRead,
    k.draftRead,
    k.draftWrite,
    k.provenanceRead,
    k.provenanceWrite,
  ],
  'learning-retirement': [...source, k.draftRead, k.provenanceRead, k.retire],
  'engineering-process': [p.queueRead, p.engineeringRead, p.engineeringProcess],
  'engineering-reconcile': [p.engineeringReconcile],
};
function fixture() {
  const kinds = Object.keys(
    SUPPORT_BACKGROUND_SERVICE_IDS,
  ) as SupportBackgroundServiceKind[];
  const profiles = Object.fromEntries(
    kinds.map((kind) => [
      kind,
      {
        enabled: true,
        version: 'fictional-' + kind + '-v1',
        usageScopeRef: 'fictional-existing-usage-scope',
      },
    ]),
  ) as Record<
    SupportBackgroundServiceKind,
    SupportBackgroundServiceProfile | undefined
  >;
  const readProfile = vi.fn<
    NonNullable<SupportBackgroundServiceAccessOptions['readProfile']>
  >((kind) => profiles[kind]);
  const options: SupportBackgroundServiceAccessOptions = { readProfile };
  const ports = createSupportBackgroundServiceAccess(options);
  const byKind = {
    'learning-source': ports.learning.serviceAccess,
    'learning-draft': ports.learning.knowledgeAccess,
    'learning-retirement': ports.learning.retirementAccess,
    'engineering-process': ports.engineering.serviceAccess,
    'engineering-reconcile': ports.engineering.reconciliationAccess,
  };
  return { kinds, profiles, readProfile, options, ports, byKind };
}
function barrier() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { release, wait };
}
async function authority(
  port: ReturnType<typeof fixture>['byKind'][SupportBackgroundServiceKind],
) {
  const result = await port.resolve(live());
  if (result.outcome !== 'ready')
    throw new Error('Expected configured intrinsic authority');
  return result.authority;
}

describe('intrinsic bounded background authority', () => {
  it('keeps absent configuration OFF without a lookup capability', async () => {
    const ports = createSupportBackgroundServiceAccess();
    for (const port of [
      ...Object.values(ports.learning),
      ...Object.values(ports.engineering),
    ])
      expect(await port.resolve(live())).toEqual({ outcome: 'inactive' });
  });

  it.each(Object.keys(ceilings) as SupportBackgroundServiceKind[])(
    'gives %s its exact literal ceiling and distinct fixed identity',
    async (kind) => {
      const f = fixture();
      const current = await authority(f.byKind[kind]);
      expect(current.access.principalId).toBe(
        SUPPORT_BACKGROUND_SERVICE_IDS[kind],
      );
      expect(current.access.permissions.toSorted()).toEqual(
        ceilings[kind].toSorted(),
      );
      expect(current.access.roles).toEqual([]);
      expect(current.access.entitlements).toEqual([]);
      expect(current.authorityVersion).toBe('fictional-' + kind + '-v1');
      expect(f.readProfile).toHaveBeenCalledExactlyOnceWith(
        kind,
        expect.any(AbortSignal),
      );
      expect(new Set(Object.values(SUPPORT_BACKGROUND_SERVICE_IDS)).size).toBe(
        5,
      );
      for (const forbidden of [
        p.learningReview,
        p.learningEvidenceSubmit,
        p.learningWithdraw,
        p.engineeringReview,
        p.engineeringEvidenceSubmit,
        p.engineeringWithdraw,
        p.engineeringPolicyManage,
        p.engineeringRestrictedRead,
        p.manage,
        p.replyAny,
        k.publish,
        k.review,
        k.reviewSubmit,
        k.evidenceSubmit,
        k.evidenceRevoke,
        k.collectionManage,
        k.validationManage,
      ])
        expect(current.access.permissions).not.toContain(forbidden);
    },
  );

  it('returns the actual selected accounting reference only on service-shaped ports', async () => {
    const f = fixture();
    const service = await f.ports.learning.serviceAccess.resolve(live());
    expect(service).toMatchObject({
      outcome: 'ready',
      authority: { usageScopeRef: 'fictional-existing-usage-scope' },
    });
    for (const port of [
      f.ports.learning.knowledgeAccess,
      f.ports.learning.retirementAccess,
    ])
      expect(await authority(port)).not.toHaveProperty('usageScopeRef');
  });

  it('reads every profile afresh and exposes version/scope revocation without caching', async () => {
    const f = fixture();
    const first = await authority(f.ports.learning.serviceAccess);
    f.profiles['learning-source'] = {
      enabled: true,
      version: 'fictional-scope-v2',
      usageScopeRef: 'fictional-selected-ledger-two',
    };
    const changed = await authority(f.ports.learning.serviceAccess);
    expect(changed.authorityVersion).not.toBe(first.authorityVersion);
    expect(changed).toHaveProperty(
      'usageScopeRef',
      'fictional-selected-ledger-two',
    );
    f.profiles['learning-source'] = { enabled: false };
    expect(await f.ports.learning.serviceAccess.resolve(live())).toEqual({
      outcome: 'inactive',
    });
    expect(f.readProfile).toHaveBeenCalledTimes(3);
  });

  it('keeps source/retirement/reconciliation profiles independent of paid-purpose OFF', async () => {
    const f = fixture();
    f.profiles['learning-draft'] = { enabled: false };
    f.profiles['engineering-process'] = { enabled: false };
    expect(await f.ports.learning.knowledgeAccess.resolve(live())).toEqual({
      outcome: 'inactive',
    });
    expect(await f.ports.engineering.serviceAccess.resolve(live())).toEqual({
      outcome: 'inactive',
    });
    for (const kind of [
      'learning-source',
      'learning-retirement',
      'engineering-reconcile',
    ] as const)
      expect((await f.byKind[kind].resolve(live())).outcome).toBe('ready');
  });

  it('refuses pre-aborted and missing profiles without granting authority', async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    expect(
      await f.ports.learning.serviceAccess.resolve(controller.signal),
    ).toEqual({ outcome: 'inactive' });
    expect(f.readProfile).not.toHaveBeenCalled();
    f.profiles['learning-source'] = undefined;
    expect(await f.ports.learning.serviceAccess.resolve(live())).toEqual({
      outcome: 'inactive',
    });
  });

  it('refuses cancellation during a genuine awaited profile callback', async () => {
    const f = fixture();
    const gate = barrier();
    const controller = new AbortController();
    f.readProfile.mockImplementationOnce(async () => {
      await gate.wait;
      return f.profiles['learning-source'];
    });
    const result = f.ports.learning.serviceAccess.resolve(controller.signal);
    controller.abort();
    gate.release();
    expect(await result).toEqual({ outcome: 'inactive' });
  });

  it('refuses a changed trusted reader after its await', async () => {
    const f = fixture();
    const gate = barrier();
    f.readProfile.mockImplementationOnce(async () => {
      await gate.wait;
      return f.profiles['learning-source'];
    });
    const result = f.ports.learning.serviceAccess.resolve(live());
    f.options.readProfile = () => ({ enabled: false });
    gate.release();
    expect(await result).toEqual({ outcome: 'unavailable' });
  });

  it.each([
    { enabled: true },
    { enabled: true, version: '' },
    { enabled: true, version: 'v'.repeat(201), usageScopeRef: 'scope' },
    { enabled: true, version: 'v\u0000bad', usageScopeRef: 'scope' },
    { enabled: true, version: 'current', usageScopeRef: 'scope\n' },
    {
      enabled: true,
      version: 'current',
      usageScopeRef: 'scope',
      permissions: [k.publish],
    },
    {
      enabled: true,
      version: 'current',
      usageScopeRef: 'scope',
      principalId: 'human',
    },
  ])(
    'contains malformed profile %# without adding authority',
    async (profile) => {
      const f = fixture();
      f.readProfile.mockReturnValueOnce(
        profile as SupportBackgroundServiceProfile,
      );
      expect(await f.ports.learning.serviceAccess.resolve(live())).toEqual({
        outcome: 'unavailable',
      });
    },
  );

  it('requires actual usage scope for service contracts while narrow KB ports need no budget reference', async () => {
    const f = fixture();
    f.readProfile.mockReturnValue({
      enabled: true,
      version: 'actual-profile-v1',
    });
    expect(await f.ports.learning.serviceAccess.resolve(live())).toEqual({
      outcome: 'unavailable',
    });
    expect(
      await f.ports.engineering.reconciliationAccess.resolve(live()),
    ).toEqual({ outcome: 'unavailable' });
    expect(
      (await f.ports.learning.retirementAccess.resolve(live())).outcome,
    ).toBe('ready');
  });

  it('contains callback failure and rejects getters without evaluating their data', async () => {
    const f = fixture();
    f.readProfile.mockRejectedValueOnce(new Error('Fictional private failure'));
    expect(await f.ports.learning.serviceAccess.resolve(live())).toEqual({
      outcome: 'unavailable',
    });
    let evaluated = false;
    f.readProfile.mockReturnValueOnce({
      enabled: true,
      get version() {
        evaluated = true;
        return 'invalid';
      },
    });
    expect(await f.ports.learning.retirementAccess.resolve(live())).toEqual({
      outcome: 'unavailable',
    });
    expect(evaluated).toBe(false);
  });
});
