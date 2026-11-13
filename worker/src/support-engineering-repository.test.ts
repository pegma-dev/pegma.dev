import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSupportApi } from './support-api';
import { createSupportRuntime } from './support-desk';
import {
  composeSupportEngineeringHuman,
  supportEngineeringIntakeOptions,
} from './support-engineering-composition';
import { engineeringRepositories } from './support-engineering-fixtures';
import {
  createSupportEngineeringHttpFixture,
  engineeringHttpObject,
  engineeringHttpResult,
} from './support-engineering-http-fixtures';
import {
  createSupportEngineeringRepositoryPorts,
  type SupportEngineeringRepository,
  type SupportEngineeringRepositoryAuthentication,
  type SupportEngineeringRepositoryOptions,
} from './support-engineering-repository';

const epoch = Date.parse('2026-11-11T12:00:00.000Z');
const configured: SupportEngineeringRepository = {
  repositoryId: '101',
  owner: 'fictional-org',
  name: 'workspace-core',
  visibility: 'public',
  appId: '301',
  installationId: '201',
};
const authentication: SupportEngineeringRepositoryAuthentication = {
  active: true,
  appId: '301',
  installationId: '201',
  binding: 'fictional-installation-authority',
  version: 'fictional-authority-v1',
  validUntil: new Date(epoch + 60_000).toISOString(),
  appJwt: 'FICTIONAL_APP_JWT',
  installationToken: 'FICTIONAL_INSTALLATION_TOKEN',
};
const installation = () => ({
  id: 201,
  app_id: 301,
  account: { id: 401, login: 'fictional-org', type: 'Organization' },
  target_id: 401,
  target_type: 'Organization',
  suspended_at: null,
  repository_selection: 'selected',
  permissions: { metadata: 'read', issues: 'write' },
  updated_at: '2026-11-11T11:00:00Z',
});

describe('repository reads in the existing human engineering composition', () => {
  it.each(['approve', 'revoked', 'metadata-changed'] as const)(
    'uses actual SDK policy, proposal and human review with %s metadata authority',
    async (mode) => {
      const f = await createSupportEngineeringHttpFixture();
      const reads = fixture({
        clock: f.engineering.clock,
        authentication: { resolve: async () => reads.state.authority },
      });
      // External observations are fictional HTTP only. Policy, Source, Work,
      // proposal, review, receipts, Identity and stored roles are actual SDKs.
      reads.state.authority = {
        ...authentication,
        validUntil: new Date(
          Date.parse(f.engineering.clock.now()) + 60_000,
        ).toISOString(),
      };
      const observed = await reads.ports.repositoryMetadata.resolve(
        '101',
        signal(),
      );
      if (observed === null)
        throw new Error('Expected bounded fictional repository observation');
      f.engineering.metadata.set('101', observed);
      const descriptor = {
        ...engineeringRepositories[0]!,
        repositoryId: '101',
        owner: configured.owner,
        name: configured.name,
      };
      const dependencies = f.engineering.ports;
      const human = {
        enabled: () => true,
        reviewEnabled: () => true,
        configuration: {
          application: {
            enabled: true,
            repositoryMetadata: reads.ports.repositoryMetadata,
            routing: dependencies.routing,
            checks: dependencies.checks,
          },
          repositories: [{ key: 'workspace-core', descriptor }],
          reviewProofs: {
            serviceAccess: dependencies.serviceAccess,
            routing: dependencies.routing,
            checks: dependencies.checks,
            github: reads.ports.github,
          },
        },
      };
      const intake = supportEngineeringIntakeOptions(human);
      if (intake === undefined)
        throw new Error('Expected explicitly enabled human composition');
      const runtime = createSupportRuntime({
        store: f.host.store,
        identity: f.identity,
        sessions: f.sessions,
        identityLinkFromClaims: f.options.identityLinkFromClaims,
        logger: f.options.logger,
        clock: f.engineering.clock,
        engineering: intake,
      });
      const api = createSupportApi({
        ...f.options,
        application: runtime.application,
        roleStore: runtime.roleStore,
        createLimiter: runtime.createLimiter,
        replyLimiter: runtime.replyLimiter,
        engineering: composeSupportEngineeringHuman(
          runtime,
          f.options.logger,
          human,
        ),
      });
      const prepare = await api(
        f.request(
          'policy/prepare',
          {
            commandId: 'READ-ONLY-REPOSITORY-POLICY',
            expectedGeneration: 1,
            enabled: true,
            repositoryKeys: ['workspace-core'],
          },
          'both',
        ),
      );
      expect(prepare.status).toBe(200);
      const prepared = engineeringHttpResult(
        await engineeringHttpObject(prepare),
      );
      const committed = await api(
        f.request('policy', { intent: prepared.intent }, 'both'),
      );
      expect(committed.status).toBe(200);
      const policy = engineeringHttpResult(
        await engineeringHttpObject(committed),
      );
      if (typeof policy.policyHash !== 'string')
        throw new Error('Expected actual SDK policy hash');
      f.engineering.state.calibrationPolicyHash = policy.policyHash;
      f.engineering.state.modelRepositoryId = '101';
      await f.verified();
      const work = await f.prepared();
      const callsBeforeHumanReview = f.engineering.state.modelCalls;
      const projection = await api(
        f.request(
          'proposal',
          undefined,
          'staff',
          '?sourceGeneration=' + work.sourceGeneration,
        ),
      );
      expect(projection.status).toBe(200);
      const view = engineeringHttpResult(
        await engineeringHttpObject(projection),
      );
      const packet = { intent: view.intent };
      const before = await f.rows();
      reads.transport.mockClear();
      if (mode === 'revoked') reads.state.authority = null;
      if (mode === 'metadata-changed')
        reads.state.repository.updated_at = '2026-11-11T11:01:00Z';
      const approved = await api(f.request('review', packet));
      if (mode !== 'approve') {
        expect(approved.status).toBe(503);
        expect(await f.rows()).toEqual(before);
      } else {
        expect(approved.status).toBe(200);
        expect(
          engineeringHttpResult(await engineeringHttpObject(approved)).status,
        ).toBe('approved');
        expect(reads.transport.mock.calls.length).toBeGreaterThanOrEqual(4); // AI and Application each observe current metadata.
        expect(
          reads.transport.mock.calls.every(
            ([url]) =>
              url ===
                'https://api.github.com/repos/fictional-org/workspace-core' ||
              url ===
                'https://api.github.com/repos/fictional-org/workspace-core/installation',
          ),
        ).toBe(true);
        const accepted = await f.rows();
        reads.state.authority = null;
        reads.transport.mockClear();
        expect((await api(f.request('review', packet))).status).toBe(200);
        expect(await f.rows()).toEqual(accepted);
        expect(reads.transport).not.toHaveBeenCalled();
      }
      expect(f.engineering.state.modelCalls).toBe(callsBeforeHumanReview);
      expect(f.engineering.state.creates).toEqual([]);
    },
  );
});
const repository = () => ({
  id: 101,
  name: 'workspace-core',
  full_name: 'fictional-org/workspace-core',
  owner: { id: 401, login: 'fictional-org', type: 'Organization' },
  private: false,
  visibility: 'public',
  archived: false,
  disabled: false,
  has_issues: true,
  default_branch: 'main',
  updated_at: '2026-11-11T11:00:00Z',
  temp_clone_token: 'FICTIONAL_RESPONSE_FIELD_MUST_NOT_ESCAPE',
});
const response = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  });
const signal = () => new AbortController().signal;
const context = (milliseconds = 10_000) => ({
  purpose: 'support_bug_assessment' as const,
  deadline: new Date(epoch + milliseconds).toISOString(),
  signal: signal(),
});

function fixture(overrides: Partial<SupportEngineeringRepositoryOptions> = {}) {
  const state = {
    enabled: true,
    milliseconds: epoch,
    authority:
      authentication as SupportEngineeringRepositoryAuthentication | null,
    installation: installation(),
    repository: repository(),
  };
  const resolve = vi.fn(
    async (_repository: SupportEngineeringRepository, _signal: AbortSignal) =>
      state.authority,
  );
  const transport = vi.fn(async (url: string, _init: RequestInit) =>
    response(
      url.endsWith('/installation') ? state.installation : state.repository,
    ),
  );
  const options: SupportEngineeringRepositoryOptions = {
    clock: { now: () => new Date(state.milliseconds).toISOString() },
    enabled: () => state.enabled,
    repositories: [configured],
    authentication: { resolve },
    fetch: transport,
    ...overrides,
  };
  return {
    state,
    resolve,
    transport,
    options,
    ports: createSupportEngineeringRepositoryPorts(options),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('bounded trusted GitHub engineering repository reads', () => {
  it('projects both actual public SDK shapes through exactly two fixed authenticated GETs', async () => {
    const f = fixture();
    const value = await f.ports.github.getMetadata('101', context());
    expect(value).toMatchObject({
      repository: {
        repositoryId: '101',
        owner: 'fictional-org',
        name: 'workspace-core',
        visibility: 'public',
      },
      authority: { active: true, validUntil: authentication.validUntil },
    });
    expect(Object.keys(value!.repository).sort()).toEqual([
      'installationBinding',
      'metadataVersion',
      'name',
      'owner',
      'repositoryId',
      'visibility',
    ]);
    expect(value!.repository.installationBinding).toMatch(
      /^github-installation:[a-f0-9]{64}$/u,
    );
    expect(value!.repository.metadataVersion).toMatch(
      /^github-repository:[a-f0-9]{64}$/u,
    );
    expect(value!.authority.binding).toBe(
      value!.repository.installationBinding,
    );
    expect(f.resolve).toHaveBeenCalledTimes(3);
    expect(f.transport.mock.calls.map(([url]) => url)).toEqual([
      'https://api.github.com/repos/fictional-org/workspace-core/installation',
      'https://api.github.com/repos/fictional-org/workspace-core',
    ]);
    const requests = f.transport.mock.calls.map(([, init]) => init);
    for (const request of requests) {
      expect(request.method).toBe('GET');
      expect(request.redirect).toBe('error');
      const headers = new Headers(request.headers);
      expect(headers.get('Accept')).toBe('application/vnd.github+json');
      expect(headers.get('X-GitHub-Api-Version')).toBe('2026-03-10');
      expect(headers.get('User-Agent')).toBe('Pegma-support-engineering');
    }
    expect(new Headers(requests[0]!.headers).get('Authorization')).toBe(
      'Bearer ' + authentication.appJwt,
    );
    expect(new Headers(requests[1]!.headers).get('Authorization')).toBe(
      'Bearer ' + authentication.installationToken,
    );
    expect(JSON.stringify(value)).not.toContain('FICTIONAL_');
    expect(await f.ports.repositoryMetadata.resolve('101', signal())).toEqual(
      value!.repository,
    );
    expect(f.transport).toHaveBeenCalledTimes(4); // No cache: the second SDK consumer has a fresh observation.
  });

  it.each([
    'omitted',
    'false',
    'throwing',
    'no-auth',
    'unknown',
    'aborted',
    'invalid-clock',
  ] as const)(
    'keeps %s unavailable before credentials or transport',
    async (mode) => {
      const f = fixture();
      const { enabled: _enabled, ...disabled } = f.options;
      void _enabled;
      const ports = createSupportEngineeringRepositoryPorts(
        mode === 'omitted'
          ? disabled
          : mode === 'no-auth'
            ? {
                clock: f.options.clock,
                enabled: () => true,
                repositories: [configured],
                fetch: f.transport,
              }
            : {
                ...f.options,
                ...(mode === 'false'
                  ? { enabled: () => false }
                  : mode === 'throwing'
                    ? {
                        enabled: () => {
                          throw new Error('Fictional outage');
                        },
                      }
                    : mode === 'invalid-clock'
                      ? {
                          clock: {
                            now: () => {
                              throw new Error('Fictional clock outage');
                            },
                          },
                        }
                      : {}),
              },
      );
      const controller = new AbortController();
      if (mode === 'aborted') controller.abort();
      expect(
        await ports.repositoryMetadata.resolve(
          mode === 'unknown' ? '101/../../anything' : '101',
          controller.signal,
        ),
      ).toBeNull();
      expect(f.resolve).not.toHaveBeenCalled();
      expect(f.transport).not.toHaveBeenCalled();
    },
  );

  it('copies its finite repository allowlist rather than trusting subsequent caller mutation', async () => {
    const row = { ...configured };
    const rows = [row];
    const f = fixture({ repositories: rows });
    row.owner = 'different-owner';
    rows.length = 0;
    expect(
      (await f.ports.repositoryMetadata.resolve('101', signal()))?.owner,
    ).toBe('fictional-org');
    expect(Object.isFrozen(f.resolve.mock.calls[0]?.[0])).toBe(true);
  });

  it('accepts an explicitly configured private repository with an all-repositories installation', async () => {
    const f = fixture({
      repositories: [{ ...configured, visibility: 'private' }],
    });
    f.state.installation.repository_selection = 'all';
    f.state.repository.visibility = 'private';
    f.state.repository.private = true;
    expect(
      (await f.ports.github.getMetadata('101', context()))?.repository
        .visibility,
    ).toBe('private');
  });

  it.each([
    { ...configured, repositoryId: '0101' },
    { ...configured, owner: '../owner' },
    { ...configured, name: '..' },
    { ...configured, installationId: '9007199254740992' },
    { ...configured, appId: '0' },
  ])('rejects malformed immutable configuration before any work: %j', (row) => {
    expect(() => fixture({ repositories: [row] })).toThrow(
      'Invalid engineering repository configuration',
    );
  });
  it('rejects duplicate repository identities and a catalog beyond the SDK policy bound', () => {
    expect(() => fixture({ repositories: [configured, configured] })).toThrow();
    expect(() =>
      fixture({
        repositories: [
          configured,
          { ...configured, repositoryId: '102', owner: 'Fictional-Org' },
        ],
      }),
    ).toThrow();
    expect(() =>
      fixture({
        repositories: Array.from({ length: 21 }, (_, index) => ({
          ...configured,
          repositoryId: String(index + 1),
          name: 'repo-' + index,
        })),
      }),
    ).toThrow();
  });

  it.each([301, 302, 304, 401, 403, 404, 429, 503])(
    'does not retry or treat installation HTTP %s as repository absence',
    async (status) => {
      const f = fixture({ fetch: async () => new Response(null, { status }) });
      expect(
        await f.ports.repositoryMetadata.resolve('101', signal()),
      ).toBeNull();
      expect(f.resolve).toHaveBeenCalledTimes(1);
    },
  );

  it.each([401, 403, 404, 429, 503])(
    'does not retry repository HTTP %s after installation discovery succeeds',
    async (status) => {
      const transport = vi.fn(async (url: string) =>
        url.endsWith('/installation')
          ? response(installation())
          : new Response(null, { status }),
      );
      const f = fixture({ fetch: transport });
      expect(
        await f.ports.repositoryMetadata.resolve('101', signal()),
      ).toBeNull();
      expect(transport).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['redirected', 'foreign-url'] as const)(
    'rejects a transport returning a successful %s response',
    async (mode) => {
      const transport = vi.fn(async () => {
        const value = response(installation());
        Object.defineProperty(
          value,
          mode === 'redirected' ? 'redirected' : 'url',
          {
            value:
              mode === 'redirected' ? true : 'https://foreign.example/metadata',
          },
        );
        return value;
      });
      const f = fixture({ fetch: transport });
      expect(
        await f.ports.repositoryMetadata.resolve('101', signal()),
      ).toBeNull();
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );

  it('does not perform the second read after trusted authority is revoked between the two reads', async () => {
    const f = fixture();
    let calls = 0;
    f.resolve.mockImplementation(async () =>
      ++calls === 1 ? authentication : null,
    );
    expect(
      await f.ports.repositoryMetadata.resolve('101', signal()),
    ).toBeNull();
    expect(f.transport).toHaveBeenCalledTimes(1);
  });

  it('aborts the bounded read when its caller aborts and does not continue on a late transport result', async () => {
    let release: (response: Response) => void = () => undefined;
    const pendingResponse = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const transport = vi.fn(async () => pendingResponse);
    const f = fixture({ fetch: transport });
    const controller = new AbortController();
    const pending = f.ports.repositoryMetadata.resolve(
      '101',
      controller.signal,
    );
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    controller.abort();
    expect(await pending).toBeNull();
    release(response(installation()));
    await Promise.resolve();
    await Promise.resolve();
    expect(f.resolve).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['wrong installation', { id: 202 }],
    ['wrong App', { app_id: 302 }],
    ['suspended', { suspended_at: '2026-11-11T11:00:00Z' }],
    [
      'wrong owner',
      { account: { id: 401, login: 'other-org', type: 'Organization' } },
    ],
    ['wrong account type', { target_type: 'User' }],
    ['wrong account ID', { target_id: 402 }],
    ['missing metadata permission', { permissions: { issues: 'write' } }],
    [
      'malformed permission',
      { permissions: { metadata: 'read', issues: true } },
    ],
    ['unknown selection', { repository_selection: 'unknown' }],
    ['invalid version date', { updated_at: 'invalid' }],
  ])(
    'refuses %s before a public repository GET can masquerade as installation membership',
    async (_name, change) => {
      const f = fixture({
        fetch: vi.fn(async () => response({ ...installation(), ...change })),
      });
      expect(
        await f.ports.repositoryMetadata.resolve('101', signal()),
      ).toBeNull();
      expect(f.resolve).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['wrong repository ID', { id: 102 }],
    ['unsafe numeric ID', { id: Number.MAX_SAFE_INTEGER + 1 }],
    ['renamed repository', { name: 'different' }],
    ['redirected name', { full_name: 'other-org/workspace-core' }],
    [
      'changed owner ID',
      { owner: { id: 402, login: 'fictional-org', type: 'Organization' } },
    ],
    ['changed visibility', { visibility: 'private' }],
    ['inconsistent privacy', { private: true }],
    ['archived', { archived: true }],
    ['disabled', { disabled: true }],
    ['missing issues state', { has_issues: undefined }],
    ['missing branch', { default_branch: null }],
    ['missing version', { updated_at: null }],
  ])('does not release metadata for %s', async (_name, change) => {
    const transport = vi.fn(async (url: string) =>
      response(
        url.endsWith('/installation')
          ? installation()
          : { ...repository(), ...change },
      ),
    );
    const f = fixture({ fetch: transport });
    expect(await f.ports.github.getMetadata('101', context())).toBeNull();
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each(['revoked', 'version', 'binding', 'expired', 'off'] as const)(
    'withholds an otherwise valid observation after final authority becomes %s',
    async (mode) => {
      const f = fixture();
      let calls = 0;
      f.resolve.mockImplementation(async () => {
        calls += 1;
        if (calls !== 3) return authentication;
        if (mode === 'off') {
          f.state.enabled = false;
          return authentication;
        }
        return mode === 'revoked'
          ? null
          : {
              ...authentication,
              ...(mode === 'version'
                ? { version: 'new' }
                : mode === 'binding'
                  ? { binding: 'new' }
                  : { validUntil: new Date(epoch).toISOString() }),
            };
      });
      expect(
        await f.ports.repositoryMetadata.resolve('101', signal()),
      ).toBeNull();
      expect(f.transport).toHaveBeenCalledTimes(2);
    },
  );

  it('uses a frozen first authority snapshot and permits token rotation only with unchanged authority', async () => {
    const initial = { ...authentication };
    const f = fixture();
    f.resolve.mockImplementation(async () => initial);
    f.transport.mockImplementation(async (url) => {
      if (url.endsWith('/installation')) {
        initial.appJwt = 'ROTATED_APP';
        initial.installationToken = 'ROTATED_INSTALLATION';
      }
      return response(
        url.endsWith('/installation') ? installation() : repository(),
      );
    });
    expect(
      await f.ports.repositoryMetadata.resolve('101', signal()),
    ).not.toBeNull();
    expect(
      new Headers(f.transport.mock.calls[0]![1].headers).get('Authorization'),
    ).toBe('Bearer FICTIONAL_APP_JWT');
    expect(
      new Headers(f.transport.mock.calls[1]![1].headers).get('Authorization'),
    ).toBe('Bearer ROTATED_INSTALLATION');
  });

  it('changes bindings when current authority or projected GitHub metadata changes', async () => {
    const f = fixture();
    const first = await f.ports.github.getMetadata('101', context());
    f.state.repository.updated_at = '2026-11-11T11:01:00Z';
    const second = await f.ports.github.getMetadata('101', context());
    expect(second!.repository.installationBinding).toBe(
      first!.repository.installationBinding,
    );
    expect(second!.repository.metadataVersion).not.toBe(
      first!.repository.metadataVersion,
    );
    f.state.authority = {
      ...authentication,
      version: 'fictional-authority-v2',
    };
    const third = await f.ports.github.getMetadata('101', context());
    expect(third!.repository.installationBinding).not.toBe(
      second!.repository.installationBinding,
    );
  });

  it.each([
    'length',
    'stream',
    'utf8',
    'json',
    'content-type',
    'transport',
  ] as const)('fails closed on bounded response %s failure', async (mode) => {
    const transport = vi.fn(async () => {
      if (mode === 'transport')
        throw new Error('FICTIONAL_PRIVATE_NETWORK_DETAIL');
      if (mode === 'length')
        return new Response('{}', {
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': '65537',
          },
        });
      if (mode === 'stream')
        return new Response(' '.repeat(65_537), {
          headers: { 'Content-Type': 'application/json' },
        });
      if (mode === 'utf8')
        return new Response(new Uint8Array([255]), {
          headers: { 'Content-Type': 'application/json' },
        });
      return new Response(mode === 'json' ? '{' : '{}', {
        headers: {
          'Content-Type':
            mode === 'content-type' ? 'text/html' : 'application/json',
        },
      });
    });
    const f = fixture({ fetch: transport });
    expect(
      await f.ports.repositoryMetadata.resolve('101', signal()),
    ).toBeNull();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each(['authentication', 'fetch', 'body'] as const)(
    'enforces the SAME total deadline with a noncooperative %s',
    async (mode) => {
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'performance'],
      });
      const never = new Promise<never>(() => undefined);
      let cancelled = 0;
      const f = fixture(
        mode === 'authentication'
          ? { authentication: { resolve: () => never } }
          : {
              fetch: () =>
                mode === 'fetch'
                  ? never
                  : Promise.resolve(
                      new Response(
                        new ReadableStream({
                          pull: () => never,
                          cancel() {
                            cancelled += 1;
                          },
                        }),
                        { headers: { 'Content-Type': 'application/json' } },
                      ),
                    ),
            },
      );
      const pending = f.ports.github.getMetadata('101', context(100));
      await vi.advanceTimersByTimeAsync(100);
      expect(await pending).toBeNull();
      if (mode === 'body') expect(cancelled).toBe(1);
    },
  );

  it('does not reset the total deadline between authentication and the second HTTP read', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let reads = 0;
    const f = fixture({
      fetch: async () => {
        reads += 1;
        await new Promise((resolve) => setTimeout(resolve, 60));
        return response(installation());
      },
    });
    const pending = f.ports.github.getMetadata('101', context(100));
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toBeNull();
    expect(reads).toBe(2);
    await vi.advanceTimersByTimeAsync(100); // Late second completion cannot produce a successful observation.
    expect(f.resolve).toHaveBeenCalledTimes(2);
  });

  it('bounds a hanging read by credential expiry even when the injected clock does not advance', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const observed: { signal?: AbortSignal } = {};
    const f = fixture({
      authentication: {
        resolve: async () => ({
          ...authentication,
          validUntil: new Date(epoch + 20).toISOString(),
        }),
      },
      fetch: async (_url, init) => {
        if (init.signal != null) observed.signal = init.signal;
        return new Promise<Response>(() => undefined);
      },
    });
    const pending = f.ports.repositoryMetadata.resolve('101', signal());
    await vi.advanceTimersByTimeAsync(20);
    expect(await pending).toBeNull();
    expect(observed.signal?.aborted).toBe(true);
  });

  it('does not renew the credential-expiry timer between two slow reads', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    let reads = 0;
    const expiring = vi.fn(async () => ({
      ...authentication,
      validUntil: new Date(epoch + 80).toISOString(),
    }));
    const f = fixture({
      authentication: {
        resolve: expiring,
      },
      fetch: async (url) => {
        reads += 1;
        await new Promise((resolve) => setTimeout(resolve, 60));
        return response(
          url.endsWith('/installation') ? installation() : repository(),
        );
      },
    });
    const pending = f.ports.github.getMetadata('101', context(200));
    await vi.advanceTimersByTimeAsync(80);
    expect(await pending).toBeNull();
    expect(reads).toBe(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(expiring).toHaveBeenCalledTimes(2);
  });
});


describe('engineering response progress regressions', () => {
  it('refuses non-progressing empty response chunks within a finite read budget', async () => {
    const f = fixture();
    let reads = 0;
    f.transport.mockImplementation(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              reads += 1;
              if (reads <= 200) controller.enqueue(new Uint8Array());
              else {
                controller.enqueue(
                  new TextEncoder().encode(
                    JSON.stringify(f.state.installation),
                  ),
                );
                controller.close();
              }
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    expect(await f.ports.github.getMetadata('101', context())).toBeNull();
    expect(reads).toBeLessThan(100);
    expect(f.transport).toHaveBeenCalledTimes(1);
  });
});
