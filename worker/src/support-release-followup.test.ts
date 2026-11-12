import { describe, expect, it, vi } from 'vitest';
import { hasPermission } from '@pegma/authorization-core';
import { supportPermissions } from '@pegma/support-desk-application';
import { createSupportApi } from './support-api';
import { createSupportRuntime } from './support-desk';
import { createSupportReleaseFollowupRuntime } from './support-release-followup';
import { supportReleaseFollowupApplicationOptions } from './support-release-followup-ports';
import { composeSupportReleaseFollowup } from './support-release-followup-composition';
import { IDENTITY_ISSUER, SESSION_COOKIE } from './identity-api';
import { SUPPORT_ROLE } from './support-access';
import {
  engineeringHttpObject,
  engineeringHttpResult,
} from './support-engineering-http-fixtures';
import {
  createSupportReleaseFollowupFixture,
  followupCommandId,
  followupPrivateMarker,
} from './support-release-followup-fixtures';

type Fixture = Awaited<ReturnType<typeof createSupportReleaseFollowupFixture>>;
async function prepared() {
  const f = await createSupportReleaseFollowupFixture();
  const work = await f.prepare();
  if (work.preparedBundle === undefined)
    throw new Error('Expected real checked bundle');
  const packet = {
    commandId: followupCommandId,
    workId: work.workId,
    expectedWorkGeneration: work.workGeneration,
    expectedTicketRevision: work.acceptedTicketRevision,
    bundleHash: work.preparedBundle.bundleHash,
    messageId: 'cd5f67c1-5a0a-43ce-8548-1e0f88f9c2f2',
  };
  return { f, work, packet };
}
function gate() {
  let enter!: () => void;
  let release!: () => void;
  return {
    entered: new Promise<void>((resolve) => {
      enter = resolve;
    }),
    held: new Promise<void>((resolve) => {
      release = resolve;
    }),
    enter: () => enter(),
    release: () => release(),
  };
}
function heldBody(original: Request, input: unknown) {
  const entered = gate();
  const resume = gate();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        entered.enter();
        await resume.held;
        if (cancelled) return;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(input)));
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const init = {
    method: 'POST',
    headers: original.headers,
    body: stream,
    duplex: 'half',
  };
  return {
    request: new Request(original.url, init),
    entered: entered.entered,
    release: resume.release,
    get cancelled() {
      return cancelled;
    },
  };
}
async function noticeCount(f: Fixture) {
  const staff = await f.f.resolve(f.f.principals.peer);
  if (staff === null) throw new Error('Expected independent current peer');
  return (
    await f.host.application.readStaffTicket(staff, 'engineering-ticket')
  ).messages.filter(
    (entry) => entry.id === 'cd5f67c1-5a0a-43ce-8548-1e0f88f9c2f2',
  ).length;
}

describe('registered release follow-up staff controls with actual SDK services', () => {
  it('keeps omitted or disabled composition absent from the actual Support API', async () => {
    const f = await createSupportReleaseFollowupFixture();
    const legacy = createSupportApi({
      ...f.f.options,
      application: f.host.application,
      createLimiter: f.host.createLimiter,
      replyLimiter: f.host.replyLimiter,
    });
    expect((await legacy(f.request('scan'))).status).toBe(404);
    f.state.enabled = false;
    expect((await f.api(f.request('scan'))).status).toBe(404);
    expect(f.state.modelCalls).toBe(0);
  });

  it('discovers one real accepted issue and exposes only the selected private staff view', async () => {
    const { f, work } = await prepared();
    let cursor: string | null = null;
    const discovered: unknown[] = [];
    let pages = 0;
    do {
      const scan = await f.api(
        f.request(
          'scan',
          undefined,
          'staff',
          cursor === null ? '' : '?cursor=' + encodeURIComponent(cursor),
        ),
      );
      expect(scan.status).toBe(200);
      const page = engineeringHttpResult(await engineeringHttpObject(scan));
      expect(page.physicalRows).toBeLessThanOrEqual(16);
      if (!Array.isArray(page.reviewCandidates))
        throw new Error('Expected real bounded review hints');
      discovered.push(...page.reviewCandidates);
      if (page.nextCursor !== null && typeof page.nextCursor !== 'string')
        throw new Error('Expected actual SDK cursor');
      cursor = page.nextCursor;
      expect(++pages).toBeLessThan(32);
    } while (cursor !== null);
    expect(discovered).toContainEqual({
      ticketId: work.ticketId,
      workId: work.workId,
    });
    const response = await f.api(
      f.request('work', undefined, 'staff', '?workId=' + work.workId),
    );
    expect(response.status).toBe(200);
    const value = await engineeringHttpObject(response);
    expect(engineeringHttpResult(value)).toMatchObject({
      ticketId: work.ticketId,
      workId: work.workId,
      prepared: { bundleHash: work.preparedBundle!.bundleHash },
    });
    expect(JSON.stringify(value)).not.toContain(followupPrivateMarker);
    expect(JSON.stringify(value)).not.toContain('claimId');
    expect(f.state.modelCalls).toBe(1);
    expect(f.f.engineering.state.creates).toHaveLength(1);
  });

  it.each(['customer', 'admin', 'knowledge'] as const)(
    'denies %s without a stored Support grant',
    async (actor) => {
      const f = await createSupportReleaseFollowupFixture();
      const before = await f.rows();
      expect((await f.api(f.request('scan', undefined, actor))).status).toBe(
        403,
      );
      expect(await f.rows()).toEqual(before);
      const access = await f.f.resolve(f.f.principals[actor]);
      if (access === null) throw new Error('Expected genuine active Identity');
      expect(
        hasPermission(access, supportPermissions.engineeringFollowupReview),
      ).toBe(false);
    },
  );

  it('grants human follow-up controls without processing or implicit KB authority', async () => {
    const f = await createSupportReleaseFollowupFixture();
    const access = await f.f.resolve(f.f.principals.staff);
    if (access === null) throw new Error('Expected current Support authority');
    for (const permission of [
      supportPermissions.engineeringFollowupRead,
      supportPermissions.engineeringFollowupReview,
      supportPermissions.engineeringFollowupEvidenceSubmit,
    ])
      expect(hasPermission(access, permission)).toBe(true);
    expect(
      hasPermission(access, supportPermissions.engineeringFollowupProcess),
    ).toBe(false);
    expect(hasPermission(access, 'knowledge.article.publish')).toBe(false);
  });

  it('posts exactly one approved web message and replays the same historical receipt without current proof', async () => {
    const { f, packet } = await prepared();
    const first = await f.api(f.request('post', packet));
    expect(first.status).toBe(200);
    const accepted = engineeringHttpResult(await engineeringHttpObject(first));
    expect(accepted).toMatchObject({
      ticketId: 'engineering-ticket',
      workId: packet.workId,
      messageId: packet.messageId,
      bundleHash: packet.bundleHash,
    });
    const committed = await f.rows();
    f.state.proofAvailable = false;
    const replay = await f.api(f.request('post', structuredClone(packet)));
    expect(replay.status).toBe(200);
    expect(engineeringHttpResult(await engineeringHttpObject(replay))).toEqual(
      accepted,
    );
    expect(await f.rows()).toEqual(committed);
    expect(await noticeCount(f)).toBe(1);
    expect(f.state.modelCalls).toBe(1);
    expect(f.f.engineering.state.creates).toHaveLength(1);
    expect([409, 503]).toContain(
      (
        await f.api(
          f.request('post', { ...packet, messageId: 'different-message' }),
        )
      ).status,
    );
    expect(await f.rows()).toEqual(committed);
    expect(await noticeCount(f)).toBe(1);
  });

  it.each(['session', 'role'] as const)(
    'prevents a new web post after actual %s revocation during release proof',
    async (change) => {
      const { f, packet } = await prepared();
      const barrier = gate();
      let once = true;
      f.state.confirm = async () => {
        if (once) {
          once = false;
          barrier.enter();
          await barrier.held;
        }
      };
      const pending = f.api(f.request('post', packet));
      await Promise.race([
        barrier.entered,
        pending.then(() => {
          throw new Error('Expected genuine release proof await');
        }),
      ]);
      try {
        if (change === 'session') await f.f.destroy('staff');
        else await f.f.revoke('staff', SUPPORT_ROLE);
      } finally {
        barrier.release();
      }
      expect([401, 403]).toContain((await pending).status);
      expect(await noticeCount(f)).toBe(0);
    },
  );

  it('recovers an actually committed post after its closing session guard withheld the ACK', async () => {
    const { f, packet } = await prepared();
    let lose = true;
    f.f.hooks.commit = async () => {
      if (lose) {
        lose = false;
        await f.f.destroy('staff');
      }
    };
    expect((await f.api(f.request('post', packet))).status).toBe(401);
    expect(await noticeCount(f)).toBe(1);
    f.f.hooks.commit = undefined;
    const sessionId = 'z'.repeat(43);
    const csrfToken = 'y'.repeat(43);
    await f.f.sessions.create(sessionId, {
      principalId: f.f.principals.staff,
      data: JSON.stringify({
        version: 1,
        issuer: IDENTITY_ISSUER,
        subject: f.f.principals.staff,
        csrfToken,
      }),
    });
    f.f.cookies.set('staff', SESSION_COOKIE + '=' + sessionId);
    f.f.csrf.set('staff', csrfToken);
    f.state.proofAvailable = false;
    const committed = await f.rows();
    expect(
      (await f.api(f.request('post', structuredClone(packet)))).status,
    ).toBe(200);
    expect(await f.rows()).toEqual(committed);
    expect(await noticeCount(f)).toBe(1);
  });

  it.each(['reopened', 'rolled_back'] as const)(
    'holds a prepared update after current %s evidence',
    async (change) => {
      const { f, packet } = await prepared();
      if (change === 'reopened') {
        f.state.context = {
          ...f.state.context,
          issueHead: {
            ...f.state.context.issueHead,
            generation: 2,
            hash: 'issue-reopened',
            state: 'open',
          },
        };
      } else
        f.state.context = {
          ...f.state.context,
          deploymentHead: {
            ...f.state.context.deploymentHead,
            generation: 2,
            hash: 'deployment-rollback',
            state: 'rolled_back',
          },
        };
      expect([409, 503]).toContain(
        (await f.api(f.request('post', packet))).status,
      );
      expect(await noticeCount(f)).toBe(0);
    },
  );

  it('holds actual work through the guarded SDK and recovers its exact receipt without current proof', async () => {
    const f = await createSupportReleaseFollowupFixture();
    const key = await f.observe();
    const access = await f.f.resolve(f.f.principals.staff);
    if (access === null)
      throw new Error('Expected current actual Support authority');
    const work = await f.host.application.readEngineeringFollowupWork(
      access,
      key,
    );
    const body = {
      commandId: followupCommandId,
      workId: key.workId,
      expectedWorkGeneration: work.workGeneration,
      reason: 'Staff paused the fictional update.',
    };
    const response = await f.api(f.request('abandon', body));
    expect(response.status).toBe(200);
    const accepted = engineeringHttpResult(
      await engineeringHttpObject(response),
    );
    expect(accepted).toMatchObject({ ...key, status: 'held' });
    const committed = await f.rows();
    f.state.proofAvailable = false;
    const retry = await f.api(f.request('abandon', structuredClone(body)));
    expect(retry.status).toBe(200);
    expect(engineeringHttpResult(await engineeringHttpObject(retry))).toEqual(
      accepted,
    );
    expect(await f.rows()).toEqual(committed);
  });

  it('does not turn a signed release hint without trusted deployed evidence into new work', async () => {
    const f = await createSupportReleaseFollowupFixture();
    f.state.proofAvailable = false;
    const access = await f.f.resolve(f.f.principals.staff);
    if (access === null) throw new Error('Expected current real Support role');
    const value = await f.host.application.observeEngineeringFollowup(
      access,
      f.identity,
    );
    expect(value.outcome).toBe('held');
    expect(value.workId).toBeUndefined();
    expect(f.state.modelCalls).toBe(0);
  });

  it.each(['Authorization', 'Origin', 'X-Pegma-CSRF'] as const)(
    'rejects invalid %s without changing the accepted work',
    async (header) => {
      const { f, packet } = await prepared();
      const rows = await f.rows();
      const request = f.request('post', packet);
      request.headers.set(
        header,
        header === 'Authorization'
          ? 'Bearer synthetic-not-browser'
          : 'synthetic-invalid',
      );
      expect((await f.api(request)).status).toBe(403);
      expect(await f.rows()).toEqual(rows);
      expect(await noticeCount(f)).toBe(0);
    },
  );

  it.each(['session', 'role', 'header'] as const)(
    'rechecks the original %s after an actual delayed JSON body',
    async (change) => {
      const { f, packet } = await prepared();
      const rows = await f.rows();
      const body = heldBody(f.request('post', packet), packet);
      const pending = f.api(body.request);
      await Promise.race([
        body.entered,
        pending.then(() => {
          throw new Error('Expected actual JSON body await');
        }),
      ]);
      try {
        if (change === 'session') await f.f.destroy('staff');
        else if (change === 'role') await f.f.revoke('staff', SUPPORT_ROLE);
        else
          body.request.headers.set('X-Pegma-CSRF', 'changed-after-admission');
      } finally {
        body.release();
      }
      expect([401, 403]).toContain((await pending).status);
      expect(await f.rows()).toEqual(rows);
      expect(await noticeCount(f)).toBe(0);
    },
  );

  it('cancels a stalled request at the established total body deadline with no post', async () => {
    const { f, packet } = await prepared();
    const rows = await f.rows();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const body = heldBody(f.request('post', packet), packet);
    try {
      const pending = f.api(body.request);
      await Promise.race([
        body.entered,
        pending.then(() => {
          throw new Error('Expected bounded JSON reader');
        }),
      ]);
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await pending).status).toBe(408);
      expect(body.cancelled).toBe(true);
      expect(await f.rows()).toEqual(rows);
      expect(await noticeCount(f)).toBe(0);
    } finally {
      body.release();
      vi.useRealTimers();
    }
  });

  it('rejects caller correlation and unknown packet fields before any SDK command', async () => {
    const { f, packet } = await prepared();
    const rows = await f.rows();
    expect(
      (
        await f.api(
          f.request('post', {
            ...packet,
            correlationId: 'caller-selected-authority',
          }),
        )
      ).status,
    ).toBe(400);
    expect(await f.rows()).toEqual(rows);
    expect(await noticeCount(f)).toBe(0);
  });

  it('retains an actual unknown paid attempt across a fresh host/application composition without calling again', async () => {
    const f = await createSupportReleaseFollowupFixture();
    const key = await f.observe();
    f.state.modelOutcome = 'unknown';
    const command = {
      ...key,
      workerId: 'synthetic-unknown-followup-worker',
      leaseMilliseconds: 30_000,
    };
    await f.runtime.process(command);
    expect(f.state.modelCalls).toBe(1);
    const access = await f.f.resolve(f.f.principals.staff);
    if (access === null)
      throw new Error('Expected current actual Support authority');
    const held = await f.host.application.readEngineeringFollowupWork(
      access,
      key,
    );
    expect(held.modelAttempts).toHaveLength(1);
    expect(held.modelAttempts[0]!.accounting).toBe('unknown');
    const restarted = createSupportRuntime({
      store: f.host.store,
      identity: f.host.identity,
      sessions: f.host.sessions,
      identityLinkFromClaims: f.host.identityLinkFromClaims,
      logger: f.f.options.logger,
      clock: f.clock,
      engineeringFollowup: supportReleaseFollowupApplicationOptions(
        f.composition,
      ),
    });
    const runtime = createSupportReleaseFollowupRuntime({
      application: restarted.application,
      store: restarted.store,
      clock: restarted.clock,
      configuration: f.configured,
      enabled: () => true,
    });
    await runtime.process(command);
    const current = await restarted.application.readEngineeringFollowupWork(
      access,
      key,
    );
    expect(f.state.modelCalls).toBe(1);
    expect(current.modelAttempts).toEqual(held.modelAttempts);
  });

  it('keeps missing purpose-specific generation held without borrowing the existing engineering model', async () => {
    const f = await createSupportReleaseFollowupFixture();
    const key = await f.observe();
    const before = await f.rows();
    const { generation, ...configuration } = f.configured;
    void generation;
    const runtime = createSupportReleaseFollowupRuntime({
      application: f.host.application,
      store: f.host.store,
      clock: f.clock,
      configuration,
      enabled: () => true,
    });
    expect(
      await runtime.process({
        ...key,
        workerId: 'synthetic-missing-generation',
        leaseMilliseconds: 30_000,
      }),
    ).toEqual({ outcome: 'held', reason: 'followup_generation_unavailable' });
    expect(await f.rows()).toEqual(before);
    expect(f.state.modelCalls).toBe(0);
  });

  it('aborts an in-flight proof without allowing a later released callback to post', async () => {
    const { f, packet } = await prepared();
    const before = await f.rows();
    const barrier = gate();
    let once = true;
    f.state.confirm = async () => {
      if (once) {
        once = false;
        barrier.enter();
        await barrier.held;
      }
    };
    const controller = new AbortController();
    const incoming = new Request(f.request('post', packet), {
      signal: controller.signal,
    });
    const pending = f.api(incoming);
    await Promise.race([
      barrier.entered,
      pending.then(() => {
        throw new Error('Expected actual release proof callback');
      }),
    ]);
    controller.abort();
    barrier.release();
    expect((await pending).status).toBe(503);
    expect(await noticeCount(f)).toBe(0);
    expect(await f.rows()).toEqual(before);
  });

  it('accepts only the trusted observed deployment and replays its exact observation without processing automatically', async () => {
    const f = await createSupportReleaseFollowupFixture();
    const body = {
      commandId: followupCommandId,
      ...f.identity.association,
      inputReference: f.identity.inputReference,
    };
    const response = await f.api(f.request('observe', body));
    expect(response.status).toBe(200);
    const accepted = engineeringHttpResult(
      await engineeringHttpObject(response),
    );
    expect(accepted).toMatchObject({
      ticketId: 'engineering-ticket',
      outcome: 'queued',
    });
    const committed = await f.rows();
    f.state.proofAvailable = false;
    const replay = await f.api(f.request('observe', structuredClone(body)));
    expect(replay.status).toBe(200);
    expect(engineeringHttpResult(await engineeringHttpObject(replay))).toEqual(
      accepted,
    );
    expect(await f.rows()).toEqual(committed);
    expect(f.state.modelCalls).toBe(0);
  });

  it('checks explicit retained edits with paid generation absent and recovers the exact preparation', async () => {
    const { f, work } = await prepared();
    const { generation, ...configuration } = f.configured;
    void generation;
    const runtime = createSupportReleaseFollowupRuntime({
      application: f.host.application,
      store: f.host.store,
      clock: f.clock,
      configuration,
      enabled: () => true,
    });
    const handler = composeSupportReleaseFollowup(
      f.host,
      f.f.options.logger,
      f.composition,
    );
    if (handler === undefined)
      throw new Error('Expected actual optional composition');
    const api = createSupportApi({
      ...f.f.options,
      application: f.host.application,
      createLimiter: f.host.createLimiter,
      replyLimiter: f.host.replyLimiter,
      releaseFollowup: { ...handler, runtime: () => runtime },
    });
    const body = {
      commandId: followupCommandId,
      workId: work.workId,
      expectedWorkGeneration: work.workGeneration,
      content: {
        customerDraft: {
          body: 'The verified deployed export correction is ready for your next export.',
        },
        kbProposal: null,
        retestRequests: [],
      },
    };
    const response = await api(f.request('reassess', body));
    expect(response.status).toBe(200);
    const accepted = engineeringHttpResult(
      await engineeringHttpObject(response),
    );
    const committed = await f.rows();
    f.state.proofAvailable = false;
    const replay = await api(f.request('reassess', structuredClone(body)));
    expect(replay.status).toBe(200);
    expect(engineeringHttpResult(await engineeringHttpObject(replay))).toEqual(
      accepted,
    );
    expect(await f.rows()).toEqual(committed);
    expect(f.state.modelCalls).toBe(1);
    expect(await noticeCount(f)).toBe(0);
  });
});
