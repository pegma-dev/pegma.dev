import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryStore } from '@pegma/storage-core';
import {
  createSupportDeskApplication,
  type EngineeringExportRequest,
  type EngineeringDispatchProofBinding,
} from '@pegma/support-desk-application';
import type {
  EngineeringExternalContext,
  EngineeringGitHubContext,
  EngineeringGitHubPort,
} from '@pegma/support-desk-ai';
import {
  createSupportEngineeringRepositoryPorts,
  type SupportEngineeringRepositoryAuthentication,
} from './support-engineering-repository';
import {
  createSupportEngineeringFixture,
  engineeringRepositories,
} from './support-engineering-fixtures';
import { createSupportEngineeringRuntime } from './support-engineering';

const epoch = Date.parse('2026-11-10T12:00:00.000Z');
const repository = {
  repositoryId: '101',
  owner: 'fictional-org',
  name: 'workspace-core',
  visibility: 'public' as const,
  appId: '301',
  installationId: '201',
};
const path = 'https://api.github.com/repos/fictional-org/workspace-core';
const marker = 'pegma-engineering:' + 'a'.repeat(48);
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
function fixture() {
  const state = {
    now: epoch,
    enabled: true,
    write: true,
    authority: true,
    authVersion: 'fictional-v1',
    installation: {
      id: 201,
      app_id: 301,
      app_slug: 'fictional-app',
      account: { id: 401, login: 'fictional-org', type: 'Organization' },
      target_id: 401,
      target_type: 'Organization',
      suspended_at: null,
      repository_selection: 'selected',
      permissions: { metadata: 'read', issues: 'write' },
      updated_at: '2026-11-10T11:00:00Z',
    },
    repository: {
      id: 101,
      name: 'workspace-core',
      full_name: 'fictional-org/workspace-core',
      owner: { id: 401, login: 'fictional-org', type: 'Organization' },
      visibility: 'public',
      private: false,
      archived: false,
      disabled: false,
      has_issues: true,
      default_branch: 'main',
      updated_at: '2026-11-10T11:00:00Z',
    },
    rows: [] as Record<string, unknown>[],
    searchTotal: undefined as number | undefined,
    incomplete: false,
    onRequest: undefined as
      | ((url: string, init: RequestInit) => Promise<Response | undefined>)
      | undefined,
    onAuth: undefined as (() => void) | undefined,
  };
  const clock = { now: () => new Date(state.now).toISOString() };
  const auth = vi.fn(
    async (): Promise<SupportEngineeringRepositoryAuthentication | null> => {
      state.onAuth?.();
      return !state.authority
        ? null
        : {
            active: true,
            appId: '301',
            installationId: '201',
            binding: 'fictional-installation',
            version: state.authVersion,
            validUntil: new Date(epoch + 3_600_000).toISOString(),
            appJwt: 'FICTIONAL_APP_JWT',
            installationToken: 'FICTIONAL_INSTALLATION_TOKEN',
          };
    },
  );
  const transport = vi.fn(async (url: string, init: RequestInit) => {
    const overridden = await state.onRequest?.(url, init);
    if (overridden !== undefined) return overridden;
    if (url === path + '/installation') return json(state.installation);
    if (url === path) return json(state.repository);
    if (url.startsWith('https://api.github.com/search/issues?')) {
      const requested = new URL(url).searchParams.get('q')!;
      const rows = requested.includes('pegma-engineering:')
        ? state.rows.filter(
            (row) =>
              typeof row.body === 'string' &&
              row.body.includes(requested.split('"')[1]!),
          )
        : state.rows;
      const limit = Number(new URL(url).searchParams.get('per_page'));
      return json({
        total_count: state.searchTotal ?? rows.length,
        incomplete_results: state.incomplete,
        items: rows.slice(0, limit),
      });
    }
    if (url === path + '/issues' && init.method === 'POST') {
      if (typeof init.body !== 'string')
        throw new Error('Expected exact fictional JSON');
      const body: unknown = JSON.parse(init.body);
      if (typeof body !== 'object' || body === null)
        throw new Error('Expected fictional issue');
      const created = remoteIssue({ ...body });
      state.rows.push(created);
      return json(created, 201);
    }
    const row = state.rows.find(
      (item) => url === path + '/issues/' + item.number,
    );
    return row === undefined ? json({ message: 'Not Found' }, 404) : json(row);
  });
  const options = {
    clock,
    repositories: [repository],
    enabled: () => state.enabled,
    issueCreationEnabled: () => state.write,
    authentication: { resolve: auth },
    fetch: transport,
  };
  const ports = createSupportEngineeringRepositoryPorts(options);
  const context = (): EngineeringExternalContext => ({
    purpose: 'support_bug_assessment',
    deadline: new Date(state.now + 10_000).toISOString(),
    signal: new AbortController().signal,
  });
  const dispatch = (): EngineeringGitHubContext => ({
    ...context(),
    dispatchId: 'fictional-dispatch',
    requestHash: 'b'.repeat(64),
    sourceFence: {
      ticketId: 'fictional-ticket',
      sourceGeneration: 1,
      sourceBindingHash: 'c'.repeat(64),
    },
  });
  const identity = (): Parameters<EngineeringGitHubPort['reconcile']>[0] => {
    const { dispatchId, requestHash, sourceFence } = dispatch();
    return {
      repositoryId: '101',
      exportMarker: marker,
      dispatchId,
      requestHash,
      sourceFence,
      operation: 'create_issue',
      repositoryMetadataHash: 'd'.repeat(64),
    };
  };
  async function request(): Promise<
    Extract<EngineeringExportRequest, { operation: 'create_issue' }>
  > {
    const metadata = await ports.github.getMetadata('101', context());
    if (metadata === null)
      throw new Error('Expected fictional current metadata');
    return {
      operation: 'create_issue',
      repository: metadata.repository,
      bundle: {
        title: 'Fictional export omits a row',
        body:
          'Reproduce with a fictional workspace.\n\nExport marker: ' + marker,
        labels: ['bug'],
        evidenceReferences: ['fictional-approved-reference'],
        templateId: 'bug-report',
        exportMarker: marker,
      },
    };
  }
  return {
    state,
    clock,
    auth,
    transport,
    ports,
    options,
    context,
    dispatch,
    identity,
    request,
  };
}
function remoteIssue(
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 501,
    number: 7,
    repository_url: path,
    url: path + '/issues/7',
    html_url: 'https://github.com/fictional-org/workspace-core/issues/7',
    state: 'open',
    title: 'Fictional export omits a row',
    body: 'Fictional approved repro.\n' + marker,
    labels: [{ name: 'bug' }],
    user: { id: 601, login: 'fictional-app[bot]', type: 'Bot' },
    performed_via_github_app: { id: 301, slug: 'fictional-app' },
    ...fields,
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('bounded public SDK GitHub issue transport', () => {
  it('keeps creation separately OFF by default while metadata and reconciliation are readable', async () => {
    const f = fixture();
    const { issueCreationEnabled: _write, ...readOptions } = f.options;
    const read = createSupportEngineeringRepositoryPorts(readOptions);
    await expect(
      read.github.createIssue(await f.request(), f.dispatch()),
    ).rejects.toThrow('unavailable');
    expect(
      f.transport.mock.calls.some(([, init]) => init.method === 'POST'),
    ).toBe(false);
    f.state.rows.push(remoteIssue());
    expect(
      (await read.github.reconcile(f.identity(), f.context())).outcome,
    ).toBe('accepted');
  });
  it('returns an explicit bounded candidate window with physical count and immutable repository scope', async () => {
    const f = fixture();
    f.state.rows = Array.from({ length: 5 }, (_, i) =>
      remoteIssue({
        id: 501 + i,
        number: 7 + i,
        url: path + '/issues/' + (7 + i),
        html_url:
          'https://github.com/fictional-org/workspace-core/issues/' + (7 + i),
      }),
    );
    f.state.searchTotal = 100;
    const result = await f.ports.github.searchDuplicates(
      { repositoryId: '101', query: 'workspace export', limit: 5 },
      f.context(),
    );
    expect(result.physicalResults).toBe(5);
    expect(result.issues).toHaveLength(5);
    expect(f.transport).toHaveBeenCalledTimes(3);
    const url = new URL(f.transport.mock.calls[2]![0]);
    expect(url.pathname).toBe('/search/issues');
    expect(url.searchParams.get('q')).toBe(
      'repo:fictional-org/workspace-core is:issue in:title,body workspace export',
    );
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('per_page')).toBe('5');
    expect(Object.keys(result.issues[0]!).sort()).toEqual([
      'body',
      'issueId',
      'issueNumber',
      'repositoryId',
      'title',
    ]);
  });
  it.each([
    'repo:other/foreign',
    'word OR repo:other/foreign',
    'word OR other',
    ' word',
    'word\nsecret',
    '"quoted"',
  ])('refuses unsafe search syntax %j before any HTTP', async (query) => {
    const f = fixture();
    await expect(
      f.ports.github.searchDuplicates(
        { repositoryId: '101', query, limit: 5 },
        f.context(),
      ),
    ).rejects.toThrow();
    expect(f.transport).not.toHaveBeenCalled();
  });
  it.each([0, 6, 1.5, NaN])(
    'refuses search capacity %s before any HTTP',
    async (limit) => {
      const f = fixture();
      await expect(
        f.ports.github.searchDuplicates(
          { repositoryId: '101', query: 'export', limit },
          f.context(),
        ),
      ).rejects.toThrow();
      expect(f.transport).not.toHaveBeenCalled();
    },
  );
  it.each([
    'incomplete',
    'foreign',
    'pull-request',
    'oversize',
    'duplicate',
    'too-many',
  ])('withholds malformed duplicate results: %s', async (mode) => {
    const f = fixture();
    f.state.rows.push(remoteIssue());
    if (mode === 'incomplete') f.state.incomplete = true;
    if (mode === 'foreign')
      f.state.rows[0]!.repository_url =
        'https://api.github.com/repos/foreign/repo';
    if (mode === 'pull-request') f.state.rows[0]!.pull_request = {};
    if (mode === 'oversize') f.state.rows[0]!.body = 'x'.repeat(12_001);
    if (mode === 'duplicate') f.state.rows.push(remoteIssue());
    if (mode === 'too-many')
      f.state.onRequest = async (url) =>
        url.includes('/search/issues?')
          ? json({
              incomplete_results: false,
              total_count: 6,
              items: Array(6).fill(remoteIssue()),
            })
          : undefined;
    await expect(
      f.ports.github.searchDuplicates(
        { repositoryId: '101', query: 'export', limit: 5 },
        f.context(),
      ),
    ).rejects.toThrow();
    expect(f.transport).toHaveBeenCalledTimes(3);
  });
  it('posts only the exact approved issue fields once and returns exact acknowledgement', async () => {
    const f = fixture();
    const request = await f.request();
    f.transport.mockClear();
    const ack = await f.ports.github.createIssue(request, f.dispatch());
    expect(ack).toEqual({
      repositoryId: '101',
      issueId: '501',
      issueNumber: 7,
    });
    const writes = f.transport.mock.calls.filter(
      ([, init]) => init.method === 'POST',
    );
    expect(writes).toHaveLength(1);
    const [url, init] = writes[0]!;
    expect(url).toBe(path + '/issues');
    expect(init.redirect).toBe('error');
    expect(JSON.parse(String(init.body))).toEqual({
      title: request.bundle.title,
      body: request.bundle.body,
      labels: ['bug'],
    });
    expect(String(init.body)).not.toContain('fictional-dispatch');
    expect(String(init.body)).not.toContain('fictional-ticket');
    expect(String(init.body)).not.toContain('fictional-approved-reference');
    expect(new Headers(init.headers).get('Authorization')).toBe(
      'Bearer FICTIONAL_INSTALLATION_TOKEN',
    );
    expect(f.transport).toHaveBeenCalledTimes(3);
  });
  it.each([401, 403, 404, 410, 422, 429, 500, 503])(
    'does not retry or claim rejection after POST status %s',
    async (status) => {
      const f = fixture();
      const request = await f.request();
      f.transport.mockClear();
      f.state.onRequest = async (_url, init) =>
        init.method === 'POST'
          ? json({ message: 'Fictional failure' }, status)
          : undefined;
      await expect(
        f.ports.github.createIssue(request, f.dispatch()),
      ).rejects.toThrow();
      expect(
        f.transport.mock.calls.filter(([, init]) => init.method === 'POST'),
      ).toHaveLength(1);
    },
  );
  it.each([
    'body',
    'title',
    'labels',
    'pull-request',
    'foreign',
    'other-app',
    'oversize',
    'redirect',
  ])(
    'withholds an inconsistent or unbounded POST acknowledgement: %s',
    async (mode) => {
      const f = fixture();
      const request = await f.request();
      f.transport.mockClear();
      f.state.onRequest = async (_url, init) => {
        if (init.method !== 'POST') return undefined;
        const row = remoteIssue({
          title: request.bundle.title,
          body: request.bundle.body,
        });
        if (mode === 'body') row.body = 'Changed body';
        if (mode === 'title') row.title = 'Changed title';
        if (mode === 'labels') row.labels = [];
        if (mode === 'pull-request') row.pull_request = {};
        if (mode === 'foreign')
          row.repository_url =
            'https://api.github.com/repos/foreign/repository';
        if (mode === 'other-app')
          row.performed_via_github_app = { id: 999, slug: 'other' };
        if (mode === 'oversize')
          return new Response('x'.repeat(65_537), {
            status: 201,
            headers: { 'content-type': 'application/json' },
          });
        if (mode === 'redirect')
          return new Response(null, {
            status: 302,
            headers: { location: 'https://foreign.invalid/' },
          });
        return json(row, 201);
      };
      await expect(
        f.ports.github.createIssue(request, f.dispatch()),
      ).rejects.toThrow();
      expect(
        f.transport.mock.calls.filter(([, init]) => init.method === 'POST'),
      ).toHaveLength(1);
    },
  );
  it.each([
    'missing-marker',
    'twice-marker',
    'title-control',
    'title-large',
    'body-large',
    'duplicate-label',
    'label-large',
  ])('rejects invalid outbound %s before further auth/HTTP', async (mode) => {
    const f = fixture();
    const request = await f.request();
    f.transport.mockClear();
    if (mode === 'missing-marker')
      Reflect.set(request.bundle, 'body', 'No marker');
    if (mode === 'twice-marker')
      Reflect.set(request.bundle, 'body', marker + '\n' + marker);
    if (mode === 'title-control')
      Reflect.set(request.bundle, 'title', 'Forbidden\u0000title');
    if (mode === 'title-large')
      Reflect.set(request.bundle, 'title', 'x'.repeat(201));
    if (mode === 'body-large')
      Reflect.set(request.bundle, 'body', 'x'.repeat(12_001) + marker);
    if (mode === 'duplicate-label')
      Reflect.set(request.bundle, 'labels', ['bug', 'bug']);
    if (mode === 'label-large')
      Reflect.set(request.bundle, 'labels', ['x'.repeat(101)]);
    await expect(
      f.ports.github.createIssue(request, f.dispatch()),
    ).rejects.toThrow();
    expect(f.transport).not.toHaveBeenCalled();
  });
  it('recovers an accepted lost POST acknowledgement by read-only exact marker, without another write', async () => {
    const f = fixture();
    const request = await f.request();
    f.state.onRequest = async (_url, init) => {
      if (init.method !== 'POST') return undefined;
      f.state.rows.push(
        remoteIssue({ title: request.bundle.title, body: request.bundle.body }),
      );
      throw new Error('Fictional accepted response lost');
    };
    await expect(
      f.ports.github.createIssue(request, f.dispatch()),
    ).rejects.toThrow();
    f.state.write = false;
    const reconciled = await f.ports.github.reconcile(
      f.identity(),
      f.context(),
    );
    expect(reconciled).toMatchObject({
      outcome: 'accepted',
      acknowledgement: { issueId: '501', issueNumber: 7 },
    });
    expect(
      f.transport.mock.calls.filter(([, init]) => init.method === 'POST'),
    ).toHaveLength(1);
  });
  it.each([
    'empty',
    'duplicate',
    'incomplete',
    'missing',
    'other-app',
    'human',
    'no-app',
    'extended-marker',
    'foreign',
    'pull-request',
  ])('keeps create reconciliation unknown for %s evidence', async (mode) => {
    const f = fixture();
    f.state.rows.push(remoteIssue());
    if (mode === 'empty') f.state.rows = [];
    if (mode === 'duplicate')
      f.state.rows.push(
        remoteIssue({
          id: 502,
          number: 8,
          url: path + '/issues/8',
          html_url: 'https://github.com/fictional-org/workspace-core/issues/8',
        }),
      );
    if (mode === 'incomplete') f.state.incomplete = true;
    if (mode === 'missing')
      f.state.onRequest = async (url) =>
        url.endsWith('/issues/7') ? json({}, 404) : undefined;
    if (mode === 'other-app')
      f.state.rows[0]!.performed_via_github_app = {
        id: 999,
        slug: 'foreign-app',
      };
    if (mode === 'human')
      f.state.rows[0]!.user = {
        id: 601,
        login: 'fictional-app[bot]',
        type: 'User',
      };
    if (mode === 'no-app') f.state.rows[0]!.performed_via_github_app = null;
    if (mode === 'extended-marker') f.state.rows[0]!.body = marker + 'f';
    if (mode === 'foreign')
      f.state.rows[0]!.repository_url =
        'https://api.github.com/repos/foreign/repo';
    if (mode === 'pull-request') f.state.rows[0]!.pull_request = {};
    expect(await f.ports.github.reconcile(f.identity(), f.context())).toEqual({
      outcome: 'unknown',
    });
    expect(
      f.transport.mock.calls.every(([, init]) => init.method === 'GET'),
    ).toBe(true);
  });
  it('links an existing issue by exact numeric identity with no marker, comment, edit or POST', async () => {
    const f = fixture();
    f.state.rows.push(
      remoteIssue({
        body: 'Existing ordinary issue',
        user: { type: 'User', id: 700 },
        performed_via_github_app: null,
      }),
    );
    const input = {
      ...f.identity(),
      operation: 'link_existing_issue' as const,
      issueId: '501',
      issueNumber: 7,
    };
    expect((await f.ports.github.reconcile(input, f.context())).outcome).toBe(
      'accepted',
    );
    expect(f.transport).toHaveBeenCalledTimes(3);
    expect(
      await f.ports.github.reconcile({ ...input, issueId: '502' }, f.context()),
    ).toEqual({ outcome: 'unknown' });
    expect(
      f.transport.mock.calls.every(([, init]) => init.method === 'GET'),
    ).toBe(true);
  });
  it.each([
    'revoked-before',
    'permission',
    'issues-off',
    'metadata',
    'gate-after-auth',
  ])('withholds POST before admission when %s changes', async (mode) => {
    const f = fixture();
    const request = await f.request();
    f.transport.mockClear();
    if (mode === 'revoked-before') f.state.authority = false;
    if (mode === 'permission') f.state.installation.permissions.issues = 'read';
    if (mode === 'issues-off') f.state.repository.has_issues = false;
    if (mode === 'metadata')
      f.state.repository.updated_at = '2026-11-10T11:00:01Z';
    if (mode === 'gate-after-auth')
      f.state.onAuth = () => {
        if (f.auth.mock.calls.length >= 6) f.state.write = false;
      };
    await expect(
      f.ports.github.createIssue(request, f.dispatch()),
    ).rejects.toThrow();
    expect(
      f.transport.mock.calls.some(([, init]) => init.method === 'POST'),
    ).toBe(false);
  });
  it('withholds a post-commit revoked acknowledgement but permits later read-only reconciliation', async () => {
    const f = fixture();
    const request = await f.request();
    f.state.onRequest = async (_url, init) => {
      if (init.method !== 'POST') return undefined;
      const row = remoteIssue({
        title: request.bundle.title,
        body: request.bundle.body,
      });
      f.state.rows.push(row);
      f.state.authority = false;
      return json(row, 201);
    };
    await expect(
      f.ports.github.createIssue(request, f.dispatch()),
    ).rejects.toThrow();
    expect(f.state.rows).toHaveLength(1);
    f.state.authority = true;
    f.state.write = false;
    expect(
      (await f.ports.github.reconcile(f.identity(), f.context())).outcome,
    ).toBe('accepted');
  });
  it('snapshots the approved request before asynchronous metadata/auth reads', async () => {
    const f = fixture();
    const request = await f.request();
    const original = structuredClone(request);
    f.state.onAuth = () => {
      Reflect.set(request.bundle, 'body', 'MUTATED_AFTER_ENTRY');
    };
    await f.ports.github.createIssue(request, f.dispatch());
    expect(f.state.rows[0]!.body).toBe(original.bundle.body);
  });
  it('bounds an ignored-abort POST by the single caller deadline and never starts a later request', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const request = await f.request();
    let started: () => void = () => {};
    const posted = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.state.onRequest = async (_url, init) => {
      if (init.method !== 'POST') return undefined;
      started();
      return new Promise<Response>(() => {});
    };
    const result = f.ports.github.createIssue(request, {
      ...f.dispatch(),
      deadline: new Date(epoch + 1_000).toISOString(),
    });
    const rejected = expect(result).rejects.toThrow();
    await posted;
    await vi.advanceTimersByTimeAsync(1_001);
    await rejected;
    expect(
      f.transport.mock.calls.filter(([, init]) => init.method === 'POST'),
    ).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('independently rereads current remote acceptance for exact Application proof bindings', async () => {
    const f = fixture();
    f.state.rows.push(remoteIssue());
    const identity = f.identity();
    const binding: EngineeringDispatchProofBinding = {
      ticketId: 'fictional-ticket',
      sourceGeneration: 1,
      sourceBindingHash: 'c'.repeat(64),
      repositoryId: '101',
      repositoryMetadataHash: 'd'.repeat(64),
      dispatchId: identity.dispatchId,
      requestHash: identity.requestHash,
      exportMarker: marker,
      operation: 'create_issue',
      result: {
        outcome: 'accepted',
        acknowledgement: {
          repositoryId: '101',
          issueId: '501',
          issueNumber: 7,
        },
      },
    };
    const verified = await f.ports.dispatchResults.verify(
      binding,
      new AbortController().signal,
    );
    expect(verified?.binding).toEqual(binding);
    expect(verified?.verifierReceiptId).toMatch(/^github-observation:/u);
    expect(f.transport).toHaveBeenCalledTimes(4);
    expect(verified?.validUntil).toBe(new Date(epoch + 10_000).toISOString());
    f.state.rows.push(
      remoteIssue({
        id: 502,
        number: 8,
        url: path + '/issues/8',
        html_url: 'https://github.com/fictional-org/workspace-core/issues/8',
      }),
    );
    expect(
      await f.ports.dispatchResults.verify(
        binding,
        new AbortController().signal,
      ),
    ).toBeNull();
    f.state.rows.pop();
    f.state.authority = false;
    expect(
      await f.ports.dispatchResults.verify(
        binding,
        new AbortController().signal,
      ),
    ).toBeNull();
  });
});

// Real public Application + AI coordinator, MemoryStore and durable dispatch.
// Only HTTP and declared product/model/check/authority systems are fictional.
describe('real SDK engineering dispatch with bounded GitHub transport', () => {
  it.each(['accepted', 'lost-ack', 'lost-ack-withdrawn', 'link'] as const)(
    'persists %s using the original SDK marker and one physical create opportunity',
    async (mode) => {
      const f = fixture();
      const sdk = await createSupportEngineeringFixture(createMemoryStore());
      const observed = await f.ports.github.getMetadata('101', f.context());
      if (observed === null) throw new Error('Expected metadata');
      sdk.metadata.set('101', observed.repository);
      const descriptor = {
        ...engineeringRepositories[0]!,
        repositoryId: repository.repositoryId,
        owner: repository.owner,
        name: repository.name,
        visibility: repository.visibility,
      };
      const policy = await sdk.runtime.putPolicy(sdk.actors.admin, {
        clientCommandId: 'POLICY-NUMERIC-REPOSITORY',
        expectedGeneration: 1,
        policy: { enabled: true, repositories: [descriptor] },
      });
      sdk.state.calibrationPolicyHash = policy.policyHash;
      sdk.state.modelRepositoryId = '101';
      if (mode === 'link') {
        sdk.state.linkExisting = true;
        f.state.rows.push(
          remoteIssue({ body: 'Existing fictional export issue' }),
        );
      }
      const application = createSupportDeskApplication({
        store: sdk.store,
        clock: sdk.clock,
        engineering: {
          enabled: true,
          maxModelAttempts: 1,
          routing: sdk.ports.routing,
          checks: sdk.ports.checks,
          repositoryMetadata: f.ports.repositoryMetadata,
          dispatchResults: f.ports.dispatchResults,
          productContext: {
            async resolve(input) {
              return {
                productId: 'workspace',
                version: '2.3.0',
                buildId: 'synthetic-build-230',
                binding: 'synthetic-workspace-230-binding',
                contextVersion: 'synthetic-product-context-v1',
                receiptId: 'fictional-product-proof',
                verifiedAt: input.acceptedAt,
                validUntil: new Date(epoch + 3_600_000).toISOString(),
              };
            },
          },
        },
      });
      const runtime = createSupportEngineeringRuntime({
        application,
        clock: sdk.clock,
        staffAccess: { resolve: sdk.resolve },
        processingEnabled: () => true,
        ports: { ...sdk.ports, github: f.ports.github },
      });
      await sdk.eligible();
      const process = () =>
        runtime.processWork({
          ...sdk.key(),
          workerId: 'fictional-http-worker',
          leaseMilliseconds: 30_000,
        });
      expect((await process()).outcome).toBe('candidate');
      expect((await process()).outcome).toBe('prepared');
      const prepared = await runtime.readWork(sdk.actors.security, sdk.key());
      if (prepared.proposal === undefined)
        throw new Error('Expected real SDK proposal');
      await runtime.reviewProposal(sdk.actors.staff, {
        ...sdk.key(),
        clientCommandId: 'APPROVE-HTTP-PROPOSAL',
        expectedWorkGeneration: prepared.workGeneration,
        proposalHash: prepared.proposal.proposalHash,
        decision: 'approve',
      });
      if (mode.startsWith('lost-ack'))
        f.state.onRequest = async (_url, init) => {
          if (init.method !== 'POST') return undefined;
          const before = await application.readEngineeringWork(
            sdk.actors.security,
            sdk.key(),
          );
          expect(before.dispatch?.exportMarker).toBe(
            prepared.proposal!.request.bundle.exportMarker,
          );
          const body: unknown = JSON.parse(String(init.body));
          if (typeof body !== 'object' || body === null)
            throw new Error('Expected issue');
          f.state.rows.push(remoteIssue({ ...body }));
          throw new Error('Fictional accepted POST lost ACK');
        };
      const result = await process();
      const work = await runtime.readWork(sdk.actors.security, sdk.key());
      if (mode.startsWith('lost-ack')) {
        expect(work.status).toBe('unknown');
        expect(result).toMatchObject({ outcome: 'pending', stage: 'dispatch' });
        if (mode === 'lost-ack-withdrawn') {
          await runtime.withdraw(sdk.actors.staff, {
            ticketId: sdk.key().ticketId,
            clientCommandId: 'WITHDRAW-AFTER-UNKNOWN',
            reason: 'privacy_withdrawal',
          });
          const withdrawn = await runtime.readWork(
            sdk.actors.security,
            sdk.key(),
          );
          expect(withdrawn.proposal).toBeUndefined();
          expect(withdrawn.withdrawnRequest?.exportMarker).toBe(
            prepared.proposal.request.bundle.exportMarker,
          );
          f.state.repository.updated_at = '2026-11-10T11:00:02Z';
          f.state.write = false;
        }
        await runtime.reconcileSource(sdk.key().ticketId);
      } else {
        expect(result.outcome).toBe('dispatched');
        expect(work.status).toBe('accepted');
      }
      const source = await application.readEngineeringReconciliation(
        await sdk.resolve('engineering-reconciler'),
        sdk.key().ticketId,
      );
      expect(source.destinations[0]?.reconciliation).toBe('confirmed');
      expect(source.destinations[0]?.acknowledgement).toMatchObject({
        issueId: '501',
        issueNumber: 7,
      });
      expect(
        f.transport.mock.calls.filter(([, init]) => init.method === 'POST'),
      ).toHaveLength(mode === 'link' ? 0 : 1);
      expect(sdk.state.modelCalls).toBe(1);
      expect(
        f.transport.mock.calls
          .filter(([, init]) => init.method === 'POST')
          .every(
            ([, init]) =>
              !String(init.body).includes('SYNTHETIC_PRIVATE_ENGINEERING_NOTE'),
          ),
      ).toBe(true);
    },
  );
});
