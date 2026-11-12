import { describe, expect, it } from 'vitest';
import type { EngineeringMutationOptions } from '@pegma/support-desk-application';
import { createSupportApi } from './support-api';
import { SUPPORT_ROLE } from './support-access';
import { composeSupportReleaseFollowup } from './support-release-followup-composition';
import { createSupportReleaseFollowupRuntime } from './support-release-followup';
import {
  createSupportReleaseFollowupFixture,
  followupCommandId,
} from './support-release-followup-fixtures';

type Operation = 'observe' | 'abandon' | 'retry' | 'reject' | 'reassess';
function barrier() {
  let enter!: () => void;
  let release!: () => void;
  return {
    entered: new Promise<void>((resolve) => {
      enter = resolve;
    }),
    wait: new Promise<void>((resolve) => {
      release = resolve;
    }),
    enter: () => enter(),
    release: () => release(),
  };
}
async function scenario(operation: Operation) {
  const f = await createSupportReleaseFollowupFixture();
  const access = await f.f.resolve(f.f.principals.staff);
  if (access === null)
    throw new Error('Expected actual stored Support authority');
  let body: Record<string, unknown>;
  if (operation === 'observe') {
    body = {
      commandId: followupCommandId,
      ...f.identity.association,
      inputReference: f.identity.inputReference,
    };
  } else {
    const target =
      operation === 'reject' || operation === 'reassess'
        ? await f.prepare()
        : await f.observe();
    const key = { ticketId: target.ticketId, workId: target.workId };
    if (operation === 'retry') {
      const work = await f.host.application.readEngineeringFollowupWork(
        access,
        key,
      );
      const paused = await f.api(
        f.request('abandon', {
          commandId: '78a10d15-1719-4bf6-9ec3-2fe61bf41c83',
          workId: work.workId,
          expectedWorkGeneration: work.workGeneration,
          reason: 'Staff held the fictional draftless work.',
        }),
      );
      if (paused.status !== 200)
        throw new Error('Expected actual SDK-held draftless work');
    }
    const work = await f.host.application.readEngineeringFollowupWork(
      access,
      key,
    );
    body = {
      commandId: followupCommandId,
      workId: work.workId,
      expectedWorkGeneration: work.workGeneration,
      ...(operation === 'abandon' || operation === 'reject'
        ? { reason: 'Staff reviewed the fictional release.' }
        : {}),
      ...(operation === 'reject'
        ? { bundleHash: work.preparedBundle?.bundleHash }
        : {}),
    };
  }
  const boundary = barrier();
  function paused(
    options?: EngineeringMutationOptions,
  ): EngineeringMutationOptions {
    return {
      ...options,
      verifyBeforeCommit: async () => {
        if (options?.verifyBeforeCommit === undefined)
          throw new Error('Host failed to supply the actual public late guard');
        boundary.enter();
        await boundary.wait;
        return options.verifyBeforeCommit();
      },
    };
  }
  const original = f.host.application;
  const reassess = original.reassessEngineeringFollowupBundle;
  if (reassess === undefined)
    throw new Error('Expected the actual published reassessment capability');
  // Observe only the public late callback; the real SDK still performs every
  // proof/read, receipt lookup, generation check and conditional transaction.
  const application: typeof original = {
    ...original,
    reassessEngineeringFollowupBundle: (access, input, planner, options) =>
      reassess.call(original, access, input, planner, paused(options)),
    observeEngineeringFollowup: (
      access: Parameters<typeof original.observeEngineeringFollowup>[0],
      input: Parameters<typeof original.observeEngineeringFollowup>[1],
      options?: EngineeringMutationOptions,
    ) => original.observeEngineeringFollowup(access, input, paused(options)),
    abandonEngineeringFollowupWork: (
      access: Parameters<typeof original.abandonEngineeringFollowupWork>[0],
      input: Parameters<typeof original.abandonEngineeringFollowupWork>[1],
      options?: EngineeringMutationOptions,
    ) =>
      original.abandonEngineeringFollowupWork(access, input, paused(options)),
    retryEngineeringFollowupWork: (
      access: Parameters<typeof original.retryEngineeringFollowupWork>[0],
      input: Parameters<typeof original.retryEngineeringFollowupWork>[1],
      options?: EngineeringMutationOptions,
    ) => original.retryEngineeringFollowupWork(access, input, paused(options)),
    rejectEngineeringFollowupBundle: (
      access: Parameters<typeof original.rejectEngineeringFollowupBundle>[0],
      input: Parameters<typeof original.rejectEngineeringFollowupBundle>[1],
      options?: EngineeringMutationOptions,
    ) =>
      original.rejectEngineeringFollowupBundle(access, input, paused(options)),
    prepareEngineeringFollowupBundle: (
      access: Parameters<typeof original.prepareEngineeringFollowupBundle>[0],
      input: Parameters<typeof original.prepareEngineeringFollowupBundle>[1],
      proof: Parameters<typeof original.prepareEngineeringFollowupBundle>[2],
      options?: EngineeringMutationOptions,
    ) =>
      original.prepareEngineeringFollowupBundle(
        access,
        input,
        proof,
        paused(options),
      ),
  };
  const configured = composeSupportReleaseFollowup(
    f.host,
    f.f.options.logger,
    f.composition,
  );
  if (configured === undefined)
    throw new Error('Expected actual enabled fixture composition');
  const runtime = createSupportReleaseFollowupRuntime({
    application,
    store: f.host.store,
    clock: f.clock,
    configuration: f.configured,
    enabled: () => f.state.enabled,
  });
  const api = createSupportApi({
    ...f.f.options,
    application,
    createLimiter: f.host.createLimiter,
    replyLimiter: f.host.replyLimiter,
    releaseFollowup: { ...configured, runtime: () => runtime },
  });
  return { f, body, boundary, api };
}

describe('actual late follow-up host authority at each new conditional SDK commit', () => {
  for (const operation of [
    'observe',
    'abandon',
    'retry',
    'reject',
    'reassess',
  ] as const) {
    it.each(['session', 'role', 'header'] as const)(
      operation + ' rejects original %s loss at the real late boundary',
      async (change) => {
        const { f, body, boundary, api } = await scenario(operation);
        const before = await f.rows();
        const request = f.request(operation, body);
        const pending = api(request);
        await Promise.race([
          boundary.entered,
          pending.then(() => {
            throw new Error('Expected the real producer late guard');
          }),
        ]);
        try {
          if (change === 'session') await f.f.destroy('staff');
          else if (change === 'role') await f.f.revoke('staff', SUPPORT_ROLE);
          else request.headers.set('X-Pegma-CSRF', 'changed-after-sdk-proof');
        } finally {
          boundary.release();
        }
        expect([401, 403]).toContain((await pending).status);
        expect(await f.rows()).toEqual(before);
        expect(f.f.engineering.state.creates).toHaveLength(1);
      },
    );
  }
});
