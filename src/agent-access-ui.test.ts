import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { BrowserNode, documentFromTemplate } from './test-support-browser';

const locator = 'synthetic_owned_grant';
const resource = 'https://pegma.dev/api/knowledge/mcp';
const managementPath = `/account/agents/authorize?grant_id=${locator}`;
const approval = {
  flow: 'authorization_code',
  requestId: locator,
  status: 'pending',
  clientId: 'synthetic-client',
  clientName: 'Synthetic hosted client',
  resource,
  requestedScopes: [
    { name: 'knowledge.draft.read', description: 'Read drafts' },
  ],
  expiresAt: '2026-11-14T16:10:00.000Z',
};
const grant = {
  grantId: locator,
  clientId: approval.clientId,
  resource,
  scopes: approval.requestedScopes,
  status: 'active',
  createdAt: '2026-11-14T16:00:00.000Z',
  expiresAt: '2026-11-21T16:00:00.000Z',
};

/** A navigation stack, rather than a replaceState spy: Back reopens its URL. */
function navigation(initial: string, failHistory = false) {
  const entries = [new URL(initial, 'https://pegma.dev').href];
  const events: { kind: string; url: string; state?: unknown }[] = [];
  let index = 0;
  return {
    entries,
    events,
    location: {
      get href() {
        return entries[index] ?? '';
      },
      get pathname() {
        return new URL(this.href).pathname;
      },
      get search() {
        return new URL(this.href).search;
      },
      assign(url: string) {
        events.push({ kind: 'assign', url });
        entries.splice(
          index + 1,
          entries.length,
          new URL(url, this.href).href,
        );
        ++index;
      },
    },
    history: {
      replaceState(state: unknown, _unused: string, url: string) {
        if (failHistory) throw new Error('Synthetic unavailable history');
        const target = new URL(url, entries[index]);
        if (target.origin !== 'https://pegma.dev')
          throw new Error('Cross-origin history');
        entries[index] = target.href;
        events.push({ kind: 'replace', url: target.href, state });
      },
      back() {
        if (index > 0) --index;
      },
    },
  };
}

interface Call {
  readonly path: string;
  readonly method: string;
  readonly body?: string;
  readonly init: RequestInit;
}

async function browser(
  nav: ReturnType<typeof navigation>,
  respond: (call: Call) => Response | Promise<Response>,
) {
  const document = documentFromTemplate(
    readFileSync(
      new URL('./pages/account/agents/authorize.astro', import.meta.url),
      'utf8',
    ),
  );
  const query = document.querySelector.bind(document);
  document.querySelector = (selector: string) =>
    selector === '[data-agent-flow]'
      ? (document
          .all()
          .find((node) => node.dataset.agentFlow !== undefined) ?? null)
      : query(selector);
  // BrowserNode intentionally models only the DOM subset needed by host tests.
  document.createElement = (tag: string) => {
    const node = new BrowserNode(tag);
    for (const key of ['id', 'name'])
      Object.defineProperty(node, key, {
        get: () => node.attributes.get(key) ?? '',
        set: (value: string) => node.attributes.set(key, value),
      });
    return node;
  };
  const calls: Call[] = [];
  const storage = new Proxy(
    {},
    {
      get() {
        throw new Error('Unexpected browser storage');
      },
    },
  );
  const window = Object.assign(new EventTarget(), {
    ...nav,
    confirm: () => true,
    localStorage: storage,
    sessionStorage: storage,
  });
  await runInNewContext(
    `(async () => {${readFileSync(
      new URL('../public/agent-access.js', import.meta.url),
      'utf8',
    )}\n})()`,
    {
      document,
      window,
      localStorage: storage,
      sessionStorage: storage,
      URL,
      URLSearchParams,
      Headers,
      Date,
      fetch: async (path: string, init: RequestInit = {}) => {
        if (init.body !== undefined && typeof init.body !== 'string')
          throw new Error('Unexpected request body');
        const call = {
          path,
          method: init.method ?? 'GET',
          body: init.body,
          init,
        };
        calls.push(call);
        return respond(call);
      },
    },
  );
  function node(id: string) {
    const found = document.querySelector(`#${id}`);
    if (found === null) throw new Error(`Missing page element: ${id}`);
    return found;
  }
  function submit(decision = 'approve') {
    const event = new Event('submit', { cancelable: true });
    Object.defineProperty(event, 'submitter', {
      value: { value: decision },
    });
    node('agent-consent').dispatchEvent(event);
  }
  function restore() {
    const event = new Event('pageshow');
    Object.defineProperty(event, 'persisted', { value: true });
    window.dispatchEvent(event);
  }
  return { calls, node, submit, restore };
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}
const state = { csrfToken: 'synthetic-csrf', resource };

describe('Agent Access hosted-PKCE management recovery', () => {
  it.each([
    'https://client.example.test/callback?existing=keep&code=synthetic-code&iss=https%3A%2F%2Fpegma.dev&state=exact%2F%2B%25',
    'http://127.0.0.1:54983/callback?code=synthetic-code&iss=https%3A%2F%2Fpegma.dev&state=exact%2F%2B%25',
  ])(
    'retains a locator-only Back entry before the unchanged callback %s',
    async (callback) => {
      const nav = navigation(
        `/account/agents/authorize?request_id=${locator}&state=not-retained`,
      );
      const first = await browser(nav, ({ path, method }) => {
        if (path === '/api/agent-access/state') return json(state);
        if (path === `/api/agent-access/approval?request_id=${locator}`)
          return json(approval);
        if (path === '/api/agent-access/approval' && method === 'POST')
          return json({
            flow: 'authorization_code',
            redirectUri: callback,
          });
        throw new Error(`Unexpected approval request: ${method} ${path}`);
      });
      first.submit();
      await vi.waitFor(() => expect(nav.events).toHaveLength(2));
      expect(nav.events).toEqual([
        {
          kind: 'replace',
          url: `https://pegma.dev${managementPath}`,
          state: null,
        },
        { kind: 'assign', url: callback },
      ]);
      expect(first.calls.map(({ path }) => path)).toEqual([
        '/api/agent-access/state',
        `/api/agent-access/approval?request_id=${locator}`,
        '/api/agent-access/approval',
      ]);
      expect(JSON.parse(first.calls[2]?.body ?? '')).toEqual({
        requestId: locator,
        decision: 'approve',
        approvedScopes: ['knowledge.draft.read'],
      });
      expect(
        new Headers(first.calls[2]?.init.headers).get('X-Pegma-CSRF'),
      ).toBe(state.csrfToken);
      expect(first.calls[2]?.init).toMatchObject({
        credentials: 'same-origin',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
      nav.history.back();
      expect(nav.location.href).toBe(`https://pegma.dev${managementPath}`);
      // The pending approval is now expired; its endpoint must never be used.
      const returned = await browser(nav, ({ path }) => {
        if (path === '/api/agent-access/state') return json(state);
        if (path === `/api/agent-access/grants/${locator}`)
          return json(grant);
        if (path.startsWith('/api/agent-access/approval'))
          return json({ error: 'expired_token' }, 400);
        throw new Error(`Unexpected return lookup: ${path}`);
      });
      expect(returned.calls.map(({ path }) => path)).toEqual([
        '/api/agent-access/state',
        `/api/agent-access/grants/${locator}`,
      ]);
      expect(returned.node('agent-grant').hidden).toBe(false);
      expect(returned.node('agent-grant-details').textContent).toContain(
        locator,
      );
      expect(returned.node('agent-grant-management-link').href).toBe(
        managementPath,
      );
      expect(returned.node('agent-revoke').disabled).toBe(false);
    },
  );

  it.each(['owner', 'different-owner'])(
    'refreshes the same retained document after Back with %s access',
    async (actor) => {
      const nav = navigation(
        `/account/agents/authorize?request_id=${locator}`,
      );
      const callback =
        'https://client.example.test/callback?code=synthetic-code&state=exact';
      let returning = false;
      let restoreStatePending = true;
      let finishState = (_response: Response) => {};
      const pendingState = new Promise<Response>((resolve) => {
        finishState = resolve;
      });
      const b = await browser(nav, ({ path, method }) => {
        if (path === '/api/agent-access/state') {
          if (returning && restoreStatePending) {
            restoreStatePending = false;
            return pendingState;
          }
          return json(state);
        }
        if (returning) {
          if (path !== `/api/agent-access/grants/${locator}`)
            throw new Error(
              'Restoration must not reuse the expired approval.',
            );
          return actor === 'owner'
            ? json({ ...grant, status: 'revoked' })
            : json({ error: 'access_denied' }, 403);
        }
        if (method === 'GET') return json(approval);
        return json({ flow: 'authorization_code', redirectUri: callback });
      });
      b.submit();
      await vi.waitFor(() => expect(nav.events).toHaveLength(2));
      nav.history.back();
      returning = true;
      b.restore();
      expect(b.node('agent-panel').hidden).toBe(true);
      expect(b.node('agent-request').hidden).toBe(true);
      expect(b.node('agent-grant').hidden).toBe(true);
      expect(nav.location.href).toBe(`https://pegma.dev${managementPath}`);
      finishState(json(state));
      if (actor === 'owner') {
        await vi.waitFor(() =>
          expect(b.node('agent-status').textContent).toBe('Grant loaded.'),
        );
        expect(b.node('agent-grant-details').textContent).toContain(
          'revoked',
        );
        expect(b.node('agent-revoke').disabled).toBe(true);
      } else {
        await vi.waitFor(() =>
          expect(b.node('agent-status').textContent).toContain(
            'not available to this account',
          ),
        );
        expect(b.node('agent-grant').hidden).toBe(true);
      }
      expect(
        b.calls.filter(({ method }) => method === 'POST'),
      ).toHaveLength(1);
      expect(
        b.calls.filter(({ path }) =>
          path.startsWith('/api/agent-access/approval?'),
        ),
      ).toHaveLength(1);
      expect(
        b.calls.filter(
          ({ path }) => path === `/api/agent-access/grants/${locator}`,
        ),
      ).toHaveLength(1);
      expect(nav.events).toHaveLength(2);
    },
  );

  it.each(['active', 'revoked', 'expired'])(
    'renders the current owner GrantView status %s from a bookmark',
    async (status) => {
      const b = await browser(navigation(managementPath), ({ path }) =>
        path === '/api/agent-access/state'
          ? json(state)
          : json({ ...grant, status }),
      );
      expect(b.node('agent-grant-details').textContent).toContain(status);
      expect(b.node('agent-revoke').disabled).toBe(status === 'revoked');
      expect(b.calls).toHaveLength(2);
    },
  );

  it('does not expose a foreign grant or turn its locator into owner authority', async () => {
    const b = await browser(navigation(managementPath), ({ path }) =>
      path === '/api/agent-access/state'
        ? json(state)
        : json({ error: 'access_denied' }, 403),
    );
    expect(b.node('agent-grant').hidden).toBe(true);
    expect(b.node('agent-grant-details').textContent).toBe('');
    expect(b.node('agent-grant-management-link').hidden).toBe(true);
    expect(b.node('agent-status').textContent).toContain(
      'not available to this account',
    );
    expect(b.calls.map(({ method }) => method)).toEqual([
      'GET',
      'GET',
      'GET',
    ]);
  });

  it.each(['grant_id=', 'grant_id=one&grant_id=two', 'grant_id=bad%2Fid'])(
    'refuses an invalid or ambiguous management locator: %s',
    async (query) => {
      const b = await browser(
        navigation(
          `/account/agents/authorize?${query}&request_id=${locator}`,
        ),
        () => json(state),
      );
      expect(b.calls).toHaveLength(1);
      expect(b.node('agent-status').textContent).toContain(
        'Check the request',
      );
    },
  );

  it.each(['deny', 'failed-approval', 'unavailable-history'])(
    'preserves callback/error behavior for %s',
    async (mode) => {
      const callback = `https://client.example.test/callback?${mode === 'deny' ? 'error=access_denied' : 'code=synthetic-code'}&state=exact`;
      const nav = navigation(
        `/account/agents/authorize?request_id=${locator}`,
        mode === 'unavailable-history',
      );
      const b = await browser(nav, ({ path, method }) => {
        if (path === '/api/agent-access/state') return json(state);
        if (method === 'GET') return json(approval);
        return mode === 'failed-approval'
          ? json({ error: 'expired_token' }, 400)
          : json({ flow: 'authorization_code', redirectUri: callback });
      });
      b.submit(mode === 'deny' ? 'deny' : 'approve');
      if (mode === 'failed-approval') {
        await vi.waitFor(() =>
          expect(b.node('agent-status').dataset.tone).toBe('error'),
        );
        expect(nav.events).toEqual([]);
      } else {
        await vi.waitFor(() =>
          expect(nav.events).toEqual([{ kind: 'assign', url: callback }]),
        );
      }
    },
  );
});
