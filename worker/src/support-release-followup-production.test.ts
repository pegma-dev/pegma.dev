import { afterEach, describe, expect, it, vi } from 'vitest';
import { knowledgePermissions } from '@pegma/knowledge-base-contracts';
import { hasPermission } from '@pegma/authorization-core';
import { supportPermissions } from '@pegma/support-desk-application';
import { createSupportPaidBootstrap } from './support-paid-bootstrap';
import { supportFollowupPaidFixture } from './support-release-followup-paid-fixtures';
import { createSupportFollowupGovernanceAccess } from './support-release-followup-bootstrap';
import { supportReleaseFollowupRoutePolicySha256 } from '@pegma/support-desk-ai/openrouter';
import { independentCheckRoutePolicyHash } from './support-independent-checks-model';

afterEach(() => vi.restoreAllMocks());
describe('purpose-specific default follow-up paid selection', () => {
  it('selects only explicitly qualified follow-up ports and the existing shared checker pool', async () => {
    const f = await supportFollowupPaidFixture();
    const bundle = await createSupportPaidBootstrap(f.env, { clock: f.clock });
    expect(bundle?.releaseFollowup?.production).toBeDefined();
    const paid = bundle!.releaseFollowup!.production!;
    expect(paid.checks.usagePolicy).toBe(
      bundle!.learning.independentChecks!.usagePolicy,
    );
    const authority = await paid.checks.authority.resolve(
      new AbortController().signal,
    );
    expect(authority.outcome).toBe('ready');
    if (authority.outcome !== 'ready')
      throw new Error('Actual intrinsic authority required');
    expect(authority.authority.access.permissions.toSorted()).toEqual(
      [
        supportPermissions.queueRead,
        supportPermissions.engineeringFollowupRead,
        supportPermissions.engineeringFollowupProcess,
      ].toSorted(),
    );
    expect(
      hasPermission(
        authority.authority.access,
        supportPermissions.engineeringFollowupReview,
      ),
    ).toBe(false);
    expect(paid.generator.enabled!()).toBe(true);
    Reflect.set(
      f.env,
      'PEGMA_SUPPORT_RELEASE_FOLLOWUP_PROCESSING_ENABLED',
      'false',
    );
    expect(paid.generator.enabled!()).toBe(false);
    expect(paid.checks.enabled!()).toBe(true);
  });
  it('does not inherit missing purpose approvals or evaluation identity and preserves nonpaid Source', async () => {
    const f = await supportFollowupPaidFixture();
    Reflect.deleteProperty(f.profile.checks.route, 'releaseFollowup');
    Reflect.set(
      f.env,
      'SUPPORT_PAID_CONFIGURATION_JSON',
      JSON.stringify(f.profile),
    );
    const bundle = await createSupportPaidBootstrap(f.env, { clock: f.clock });
    expect(bundle?.learning.source).toBeDefined();
    expect(bundle?.releaseFollowup).toBeUndefined();
    const changed = await supportFollowupPaidFixture();
    changed.profile.releaseFollowup.route.evaluation.artifactRef =
      'different-artifact';
    Reflect.set(
      changed.env,
      'SUPPORT_PAID_CONFIGURATION_JSON',
      JSON.stringify(changed.profile),
    );
    expect(
      (await createSupportPaidBootstrap(changed.env, { clock: changed.clock }))
        ?.releaseFollowup,
    ).toBeUndefined();
  });
  it('uses the existing narrow governance reader for explicit Source scope while learning and models are OFF', async () => {
    const f = await supportFollowupPaidFixture();
    const access = createSupportFollowupGovernanceAccess(f.env)!;
    const signal = new AbortController().signal;
    const known = await access.resolve(f.source.collectionIds[0]!, signal);
    expect(known?.access.principalId).toBe(
      'pegma/support-learning-governance-reader',
    );
    expect(known?.access.permissions).toEqual([
      knowledgePermissions.validationManage,
    ]);
    expect(await access.resolve('not-in-current-scope', signal)).toBeNull();
    Reflect.set(f.env, 'SUPPORT_LEARNING_SOURCE_CONFIGURATION_JSON', '{}');
    expect(await access.resolve(f.source.collectionIds[0]!, signal)).toBeNull();
  });
  it('accepts the explicitly approved max_completion_tokens route and refuses unknown parameters before any key read', async () => {
    async function profile(parameter: string) {
      const f = await supportFollowupPaidFixture();
      Reflect.set(f.profile.checks.route, 'outputTokenParameter', parameter);
      Reflect.set(
        f.profile.releaseFollowup.route,
        'outputTokenParameter',
        parameter,
      );
      const { approval: checkApproval, ...checks } = f.profile.checks.route;
      checkApproval.requestPolicySha256 =
        await independentCheckRoutePolicyHash(checks);
      const { approval, ...route } = f.profile.releaseFollowup.route;
      approval.requestPolicySha256 =
        await supportReleaseFollowupRoutePolicySha256(route);
      Reflect.set(
        f.env,
        'SUPPORT_PAID_CONFIGURATION_JSON',
        JSON.stringify(f.profile),
      );
      Reflect.set(f.env, 'PEGMA_SUPPORT_INDEPENDENT_CHECKS_ENABLED', 'false');
      const keys = vi.fn(() => {
        throw new Error('Route validation must not read keys');
      });
      Object.defineProperty(f.env, 'SUPPORT_ASSISTANT_OPENROUTER_API_KEY', {
        get: keys,
      });
      Object.defineProperty(
        f.env,
        'SUPPORT_INDEPENDENT_CHECK_RECEIPT_KEY_BASE64',
        { get: keys },
      );
      return { f, keys };
    }
    const approved = await profile('max_completion_tokens');
    const bundle = await createSupportPaidBootstrap(approved.f.env, {
      clock: approved.f.clock,
    });
    expect(bundle?.releaseFollowup?.production).toBeDefined();
    expect(approved.keys).not.toHaveBeenCalled();
    const unknown = await profile('max_unapproved_tokens');
    expect(
      (
        await createSupportPaidBootstrap(unknown.f.env, {
          clock: unknown.f.clock,
        })
      )?.releaseFollowup,
    ).toBeUndefined();
    expect(unknown.keys).not.toHaveBeenCalled();
  });
});
