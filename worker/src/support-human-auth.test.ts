import { supportPermissions } from '@pegma/support-desk-application';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, authenticate } from './api-auth';
import { IDENTITY_ISSUER, SESSION_COOKIE } from './identity-api';
import { SUPPORT_ROLE } from './support-access';
import { createSupportEngineeringHttpFixture } from './support-engineering-http-fixtures';
import { supportHumanBrowser } from './support-human-auth';

const START = Date.parse('2026-11-13T04:00:00.000Z');

afterEach(() => {
  vi.useRealTimers();
});

async function fixture() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  const f = await createSupportEngineeringHttpFixture();
  const rawSessionId = f.cookies.get('staff')!.slice(SESSION_COOKIE.length + 1);
  const get = vi.fn((...args: Parameters<typeof f.sessions.get>) =>
    f.sessions.get(...args),
  );
  const observe = vi.fn((...args: Parameters<typeof f.sessions.observe>) =>
    f.sessions.observe(...args),
  );
  const sessions = { ...f.sessions, get, observe };
  const options = { ...f.options, sessions };
  const state: { afterAccess?: () => Promise<void> } = {};
  const request = f.request('enroll', { commandId: crypto.randomUUID() });
  const admitted = vi.fn(async (incoming: Request) => {
    const value = await authenticate(incoming, options);
    if (value === null) throw new ApiError(401, 'authentication_required');
    return value;
  });
  const access = vi.fn(async (coordinates: Parameters<
    Parameters<typeof supportHumanBrowser>[1]['access']
  >[0]) => {
    const value = await f.resolve(coordinates.link.subject);
    await state.afterAccess?.();
    if (value === null) throw new ApiError(401, 'authentication_required');
    return value;
  });
  const browser = supportHumanBrowser(request, {
    sessions,
    authenticate: admitted,
    access,
    permission: supportPermissions.engineeringFollowupEvidenceSubmit,
    mutation: true,
  });
  return { f, rawSessionId, get, observe, admitted, access, state, request, browser };
}

describe('fresh read-only closing browser session fences', () => {
  it('touches only initial admission and observes the same raw id on all four closing reads', async () => {
    const f = await fixture();
    await f.browser.current();
    const initial = await f.f.sessions.observe(f.rawSessionId);
    expect(initial).not.toBeNull();
    for (let read = 1; read < 4; read++) {
      vi.setSystemTime(START + read * 60_000);
      await f.browser.current();
      f.browser.assertCurrent();
    }
    expect(f.admitted).toHaveBeenCalledTimes(1);
    expect(f.get.mock.calls).toEqual([[f.rawSessionId]]);
    expect(f.observe.mock.calls).toEqual(
      Array.from({ length: 4 }, () => [f.rawSessionId]),
    );
    expect(f.access).toHaveBeenCalledTimes(4);
    expect((await f.f.sessions.observe(f.rawSessionId))?.lastSeenAt).toBe(
      initial!.lastSeenAt,
    );
  });

  it('refuses revocation after the awaited current role and Identity lookup', async () => {
    const f = await fixture();
    await f.browser.current();
    f.state.afterAccess = () => f.f.sessions.destroy(f.rawSessionId);
    await expect(f.browser.current()).rejects.toMatchObject({ status: 401 });
    expect(f.get).toHaveBeenCalledTimes(1);
    expect(f.observe).toHaveBeenCalledTimes(2);
  });

  it('observes the current clock when idle expiry arrives during the authority await', async () => {
    const f = await fixture();
    await f.browser.current();
    vi.setSystemTime(START + 12 * 60 * 60_000 - 1);
    f.state.afterAccess = async () => {
      vi.setSystemTime(START + 12 * 60 * 60_000);
    };
    await expect(f.browser.current()).rejects.toMatchObject({ status: 401 });
    expect(f.get).toHaveBeenCalledTimes(1);
    expect(f.observe.mock.calls.at(-1)).toEqual([f.rawSessionId]);
  });

  it('propagates a closing observation failure without returning cached authority', async () => {
    const f = await fixture();
    await f.browser.current();
    const failure = new Error('Synthetic current session read unavailable');
    f.observe.mockRejectedValueOnce(failure);
    await expect(f.browser.current()).rejects.toBe(failure);
    expect(f.get).toHaveBeenCalledTimes(1);
  });

  it('retains current stored-role checks before the closing observation', async () => {
    const f = await fixture();
    await f.browser.current();
    await f.f.revoke('staff', SUPPORT_ROLE);
    await expect(f.browser.current()).rejects.toMatchObject({ status: 403 });
    expect(f.access).toHaveBeenCalledTimes(2);
    expect(f.observe).toHaveBeenCalledTimes(1);
  });

  it('refuses replacement session data under the same raw credential', async () => {
    const f = await fixture();
    await f.browser.current();
    f.state.afterAccess = async () => {
      await f.f.sessions.destroy(f.rawSessionId);
      await f.f.sessions.create(f.rawSessionId, {
        principalId: f.f.principals.staff,
        data: JSON.stringify({
          version: 1,
          issuer: IDENTITY_ISSUER,
          subject: f.f.principals.staff,
          csrfToken: 'z'.repeat(43),
        }),
      });
    };
    await expect(f.browser.current()).rejects.toMatchObject({ status: 401 });
  });

  it('keeps the synchronous absolute-expiry fence after a successful observation', async () => {
    const f = await fixture();
    await f.browser.current();
    const session = await f.f.sessions.observe(f.rawSessionId);
    if (session === null) throw new Error('Expected the actual live session');
    vi.setSystemTime(new Date(session.expiresAt));
    expect(() => f.browser.assertCurrent()).toThrow('authentication_required');
  });
});
