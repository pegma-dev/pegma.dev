import { createMemoryStore } from '@pegma/storage-core';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { RELEASE_CATALOG } from './release-catalog';
import { componentReleaseCollection, componentReleaseKey } from './component-release';
import { readReleaseOpsState } from './release-ops-state';
import { runReleaseReconciliation } from './release-reconciliation';
import {
  releaseCatalogAuthenticationFor, releaseRateHints,
  type ReleaseCatalogAuthentication, type ReleaseCatalogAuthenticationEnv,
} from './release-catalog-auth';

const ID = RELEASE_CATALOG[0]!.repositoryId;
const ORG = '309286193';
const START = Date.parse('2026-11-14T06:00:00Z');
const TOKEN = 'fictional-catalog-token';
const latest = { id: 123, tag_name: 'v1.0.0', published_at: '2026-11-01T00:00:00Z', draft: false, prerelease: false };
let pem: string, publicKey: CryptoKey;
beforeAll(async () => {
  const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  publicKey = keys.publicKey;
  const bytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
  pem = '-----BEGIN PRIVATE KEY-----\n' + btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')) + '\n-----END PRIVATE KEY-----';
});

function fixture() {
  const state = { now: START };
  const env: { -readonly [K in keyof ReleaseCatalogAuthenticationEnv]: ReleaseCatalogAuthenticationEnv[K] } = {
    GITHUB_RELEASE_AUTH_MODE: 'github_app', GITHUB_RELEASE_APP_PRIVATE_KEY_PKCS8: pem,
    GITHUB_RELEASE_APP_CONFIGURATION: JSON.stringify({ appId: '10', installationId: '20', version: 'fixture-v1',
      validUntil: new Date(START + 3_600_000).toISOString() }),
    GITHUB_ORGANIZATION_ID: ORG,
    GITHUB_ALLOWED_REPOSITORY_IDS: RELEASE_CATALOG.map(entry => entry.repositoryId).join(','),
  };
  const grant = { token: TOKEN, expires_at: new Date(START + 3_600_000).toISOString(),
    repository_selection: 'selected', permissions: { metadata: 'read' }, repositories: [{ id: Number(ID), private: false }] };
  const metadata = { id: Number(ID), private: false, visibility: 'public', owner: { id: Number(ORG), login: 'pegma-dev', type: 'Organization' } };
  const transport = vi.fn<typeof fetch>(async (url) => {
    if (String(url).endsWith('/access_tokens')) return Response.json(grant, { status: 201 });
    if (String(url).endsWith('/releases/latest')) return Response.json(latest, { headers: { ETag: 'fictional-etag' } });
    return Response.json(metadata);
  });
  const clock = { now: () => new Date(state.now).toISOString() };
  const auth = () => releaseCatalogAuthenticationFor(() => env, { clock, fetch: transport })!;
  const resolve = (signal = new AbortController().signal) => auth().resolve({
    purpose: 'public_release_catalog_read', repositoryId: ID, deadline: state.now + 10_000,
  }, signal);
  const store = createMemoryStore();
  const log = vi.fn();
  const run = () => runReleaseReconciliation({ store, logger: { log }, config: { allowedRepositoryIds: new Set([ID]) },
    scheduledTime: START, now: new Date(START).toISOString(), clock, authentication: auth(), fetchImpl: transport });
  const row = () => store.collection(componentReleaseCollection()).get(componentReleaseKey(ID));
  const seed = () => store.collection(componentReleaseCollection()).update(componentReleaseKey(ID), () => ({ action: 'write', value: {
    repositoryId: ID, repositoryName: 'spine', releaseId: '999', tagName: 'v0.9.0',
    publishedAt: '2026-10-01T00:00:00Z', observedAt: '2026-11-13T00:00:00Z',
    releaseUrl: 'https://github.com/pegma-dev/spine/releases/tag/v0.9.0',
  } }));
  return { state, env, grant, metadata, transport, clock, auth, resolve, store, log, run, row, seed };
}

describe('dedicated catalog App issuer', () => {
  it('keeps absent/anonymous mode credential-free, even when engineering credentials exist', () => {
    const read = vi.fn(() => { throw new Error('must not read a key'); });
    for (const mode of [undefined, 'anonymous']) {
      const env = { GITHUB_RELEASE_AUTH_MODE: mode };
      Object.defineProperty(env, 'GITHUB_RELEASE_APP_PRIVATE_KEY_PKCS8', { get: read });
      Object.defineProperty(env, 'SUPPORT_ENGINEERING_APP_JWT', { get: read });
      expect(releaseCatalogAuthenticationFor(() => env)).toBeUndefined();
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('signs RS256 with bounded claims and mints one metadata-only exact-ID token', async () => {
    const f = fixture(); const result = await f.resolve();
    expect(result).toMatchObject({ repositoryId: ID, organizationId: ORG, token: TOKEN });
    expect(result!.current()).toBe(true);
    expect(f.transport).toHaveBeenCalledTimes(1);
    const [url, init] = f.transport.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/app/installations/20/access_tokens');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(JSON.parse(String(init!.body))).toEqual({ repository_ids: [Number(ID)], permissions: { metadata: 'read' } });
    const jwt = new Headers(init!.headers).get('Authorization')!.slice('Bearer '.length);
    const parts = jwt.split('.');
    const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/gu, '+').replace(/_/gu, '/')), char => char.charCodeAt(0));
    expect(JSON.parse(new TextDecoder().decode(decode(parts[0]!)))).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(JSON.parse(new TextDecoder().decode(decode(parts[1]!)))).toEqual({ iss: '10', iat: START / 1000 - 60, exp: START / 1000 + 540 });
    expect(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, decode(parts[2]!),
      new TextEncoder().encode(parts[0] + '.' + parts[1]))).toBe(true);
    f.env.GITHUB_RELEASE_APP_CONFIGURATION = f.env.GITHUB_RELEASE_APP_CONFIGURATION!.replace('fixture-v1', 'fixture-v2');
    expect(result!.current()).toBe(false);
  });

  it.each(['missing-key', 'bad-mode', 'bad-json', 'expired-config', 'outside-allowlist', 'extra-allowlist', 'unknown-config-field'])(
    'refuses %s before minting and never substitutes engineering authentication', async (fault) => {
      const f = fixture();
      if (fault === 'missing-key') delete f.env.GITHUB_RELEASE_APP_PRIVATE_KEY_PKCS8;
      if (fault === 'bad-mode') f.env.GITHUB_RELEASE_AUTH_MODE = 'mistyped';
      if (fault === 'bad-json') f.env.GITHUB_RELEASE_APP_CONFIGURATION = 'not-json';
      if (fault === 'expired-config') f.state.now += 3_600_000;
      if (fault === 'outside-allowlist') f.env.GITHUB_ALLOWED_REPOSITORY_IDS = '999';
      if (fault === 'extra-allowlist') f.env.GITHUB_ALLOWED_REPOSITORY_IDS += ',999';
      if (fault === 'unknown-config-field') f.env.GITHUB_RELEASE_APP_CONFIGURATION = JSON.stringify({
        ...JSON.parse(f.env.GITHUB_RELEASE_APP_CONFIGURATION!), token: 'not-a-supported-config-field' });
      await expect(f.resolve()).rejects.toMatchObject({ reason: 'invalid_configuration' });
      expect(f.transport).not.toHaveBeenCalled();
    },
  );

  it.each(['contents-read', 'issues-write', 'extra-repository', 'wrong-repository', 'private', 'all-repositories', 'expired-token'])(
    'rejects a %s grant instead of accepting broader or stale authority', async (fault) => {
      const f = fixture(); const grant: Record<string, unknown> = { ...f.grant };
      if (fault === 'contents-read') grant.permissions = { metadata: 'read', contents: 'read' };
      if (fault === 'issues-write') grant.permissions = { metadata: 'read', issues: 'write' };
      if (fault === 'extra-repository') grant.repositories = [...f.grant.repositories, { id: 999, private: false }];
      if (fault === 'wrong-repository') grant.repositories = [{ id: 999, private: false }];
      if (fault === 'private') grant.repositories = [{ id: Number(ID), private: true }];
      if (fault === 'all-repositories') grant.repository_selection = 'all';
      if (fault === 'expired-token') grant.expires_at = new Date(START).toISOString();
      f.transport.mockResolvedValueOnce(Response.json(grant, { status: 201 }));
      if (fault === 'expired-token') await expect(f.resolve()).rejects.toThrow('Catalog authentication unavailable');
      else await expect(f.resolve()).rejects.toMatchObject({ reason: 'invalid_grant' });
      expect(f.transport).toHaveBeenCalledTimes(1);
    },
  );

  it('refuses cancellation and an unapproved purpose/repository without a network call', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    expect(await f.resolve(controller.signal)).toBeNull();
    // Deliberately invalid runtime input: exercise the guard beyond TS callers.
    expect(await f.auth().resolve({ purpose: 'support_bug_assessment' as 'public_release_catalog_read', repositoryId: ID,
      deadline: START + 10_000 }, new AbortController().signal)).toBeNull();
    expect(await f.auth().resolve({ purpose: 'public_release_catalog_read', repositoryId: '999', deadline: START + 10_000 }, new AbortController().signal)).toBeNull();
    expect(f.transport).not.toHaveBeenCalled();
  });
});

describe('authenticated catalog observation', () => {
  it.each([200, 304, 404])('requires fresh public metadata after latest HTTP %i before changing catalog state', async (status) => {
    const f = fixture(); await f.seed();
    f.transport.mockImplementation(async url => String(url).endsWith('/access_tokens') ? Response.json(f.grant, { status: 201 }) :
      String(url).endsWith('/releases/latest') ? (status === 200 ? Response.json(latest) : new Response(null, { status })) : Response.json(f.metadata));
    const result = await f.run();
    expect(result).toEqual({ examined: 1, upserted: status === 200 ? 1 : 0, cleared: status === 404 ? 1 : 0,
      notModified: status === 304 ? 1 : 0, failed: 0 });
    expect(f.transport.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.github.com/app/installations/20/access_tokens',
      `https://api.github.com/repositories/${ID}/releases/latest`, `https://api.github.com/repositories/${ID}`,
    ]);
    for (const [, init] of f.transport.mock.calls.slice(1)) {
      expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
      expect(new Headers(init!.headers).get('Authorization')).toBe('Bearer ' + TOKEN);
    }
    expect((await readReleaseOpsState(f.store)).lastSuccessfulReconciliationAt).toBe(new Date(START).toISOString());
    if (status === 404) expect(await f.row()).toBeNull();
    else expect((await f.row())!.releaseId).toBe(status === 200 ? '123' : '999');
    expect(JSON.stringify(f.log.mock.calls)).not.toContain(TOKEN);
  });

  it.each(['private', 'cross-org', 'wrong-id', 'wrong-owner-type'])('preserves the prior projection when the current HTTP 200 repository is %s', async (fault) => {
    const f = fixture(); await f.seed(); const before = await f.row();
    if (fault === 'private') { f.metadata.private = true; f.metadata.visibility = 'private'; }
    if (fault === 'cross-org') f.metadata.owner.id = 999;
    if (fault === 'wrong-id') f.metadata.id = 999;
    if (fault === 'wrong-owner-type') f.metadata.owner.type = 'User';
    expect((await f.run()).failed).toBe(1);
    expect(await f.row()).toEqual(before);
    expect((await readReleaseOpsState(f.store)).lastSuccessfulReconciliationAt).toBeNull();
    expect(f.transport).toHaveBeenCalledTimes(3);
    expect(f.log).toHaveBeenCalledWith('error', 'release_reconciliation.partial_failure', expect.objectContaining({
      failureDetails: [expect.objectContaining({ phase: 'repository', failureClass: 'invalid_repository' })],
    }));
  });

  it('uses immutable organization identity when its display login changes', async () => {
    const f = fixture(); f.metadata.owner.login = 'renamed-display-login';
    expect((await f.run()).upserted).toBe(1);
    expect((await f.row())!.releaseId).toBe('123');
  });

  it.each([
    ['fetch', 'fetch_rejected', undefined], ['status', 'http_status', 403],
    ['JSON', 'invalid_json', 200], ['size', 'too_large', 200],
  ] as const)('keeps metadata %s failures separate from the earlier release body', async (fault, failureClass, httpStatus) => {
    const f = fixture(); const normal = f.transport.getMockImplementation()!;
    f.transport.mockImplementation(async (url, init) => {
      if (!String(url).endsWith('/repositories/' + ID)) return normal(url, init);
      if (fault === 'fetch') throw new Error('PRIVATE_METADATA_ERROR');
      if (fault === 'status') return new Response('PRIVATE_METADATA_ERROR', { status: 403 });
      if (fault === 'JSON') return new Response('PRIVATE_METADATA_ERROR');
      return new Response('PRIVATE_METADATA_ERROR', { headers: { 'Content-Length': '65537' } });
    });
    expect((await f.run()).failed).toBe(1);
    const fields = f.log.mock.calls[0]![2];
    expect(fields.failureDetails[0]).toMatchObject({ phase: 'repository', failureClass });
    expect(fields.failureDetails[0].httpStatus).toBe(httpStatus);
    expect(fields.failureDetails[0]).not.toHaveProperty('bodyBytes');
    expect(fields.failureDetails[0]).not.toHaveProperty('bodyBytesSource');
    expect(JSON.stringify(fields)).not.toContain('PRIVATE_METADATA_ERROR');
  });

  it.each([304, 404])('does not treat HTTP %i as success when public repository access cannot be verified', async status => {
    const f = fixture(); await f.seed(); const before = await f.row();
    f.transport.mockImplementation(async url => String(url).endsWith('/access_tokens') ? Response.json(f.grant, { status: 201 }) :
      new Response(null, { status: String(url).endsWith('/releases/latest') ? status : 404 }));
    expect((await f.run()).failed).toBe(1); expect(await f.row()).toEqual(before);
    expect((await readReleaseOpsState(f.store)).lastSuccessfulReconciliationAt).toBeNull();
  });

  it('keeps missing configured authority unavailable with no anonymous request or retry', async () => {
    const f = fixture(); await f.seed(); const before = await f.row(); delete f.env.GITHUB_RELEASE_APP_PRIVATE_KEY_PKCS8;
    expect((await f.run()).failed).toBe(1); expect(await f.row()).toEqual(before);
    expect(f.transport).not.toHaveBeenCalled();
  });

  it('retains only numeric hints for a 403, never reads its body and never retries', async () => {
    const f = fixture(); await f.seed(); const before = await f.row();
    const response = new Response('PRIVATE_UPSTREAM_MESSAGE', { status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'retry-after': '60', 'x-unrelated': TOKEN } });
    const read = vi.fn(() => { throw new Error('must not read an error body'); });
    Object.defineProperty(response, 'body', { get: read });
    f.transport.mockImplementation(async url => String(url).endsWith('/access_tokens') ? Response.json(f.grant, { status: 201 }) : response);
    expect((await f.run()).failed).toBe(1); expect(await f.row()).toEqual(before);
    expect(f.transport).toHaveBeenCalledTimes(2); expect(read).not.toHaveBeenCalled();
    expect(f.log).toHaveBeenCalledWith('error', 'release_reconciliation.partial_failure', expect.objectContaining({
      failureDetails: [{ repositoryId: ID, phase: 'status', failureClass: 'http_status', httpStatus: 403,
        rateLimitRemaining: 0, retryAfterSeconds: 60 }],
    }));
    expect(JSON.stringify(f.log.mock.calls)).not.toMatch(/PRIVATE_UPSTREAM_MESSAGE|fictional-catalog-token|x-unrelated/u);
  });

  it.each(['expiry', 'configuration'])('refuses %s changes across an awaited repository read', async fault => {
    const f = fixture(); await f.seed(); const before = await f.row();
    const normal = f.transport.getMockImplementation()!;
    f.transport.mockImplementation(async (url, init) => {
      const response = await normal(url, init);
      if (String(url).endsWith('/repositories/' + ID)) {
        if (fault === 'expiry') f.state.now += 10_001;
        else f.env.GITHUB_RELEASE_AUTH_MODE = 'anonymous';
      }
      return response;
    });
    expect((await f.run()).failed).toBe(1); expect(await f.row()).toEqual(before);
    expect((await readReleaseOpsState(f.store)).lastSuccessfulReconciliationAt).toBeNull();
    expect(f.transport).toHaveBeenCalledTimes(3);
  });

  it('applies one ten-second deadline even to an issuer that does not settle', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); const resolve = vi.fn<ReleaseCatalogAuthentication['resolve']>(() => new Promise<null>(() => {}));
      const run = runReleaseReconciliation({ store: f.store, logger: { log: f.log },
        config: { allowedRepositoryIds: new Set([ID]) }, scheduledTime: START,
        authentication: { resolve }, clock: f.clock, fetchImpl: f.transport });
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await run).failed).toBe(1); expect(resolve).toHaveBeenCalledTimes(1);
      expect(resolve.mock.calls[0]![1].aborted).toBe(true);
      expect(f.transport).not.toHaveBeenCalled();
      expect((await readReleaseOpsState(f.store)).lastSuccessfulReconciliationAt).toBeNull();
    } finally { vi.useRealTimers(); }
  });
});

describe('finite response hints', () => {
  it.each(['-1', '0.5', 'infinite', '999999999999999999999', 'Wed, 14 Nov 2026 06:01:00 GMT'])(
    'retains no raw value for %s', value => {
      expect(releaseRateHints(new Response(null, { headers: { 'x-ratelimit-remaining': value, 'retry-after': value } })))
        .toEqual({ rateLimitRemaining: null, retryAfterSeconds: null });
    },
  );
});
