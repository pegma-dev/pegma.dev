import { systemClock, type Clock } from '@pegma/spine';
import { RELEASE_CATALOG } from './release-catalog';

/** Catalog-only configuration. Never uses the engineering App credentials. */
export interface ReleaseCatalogAuthenticationEnv {
  readonly GITHUB_RELEASE_AUTH_MODE?: string;
  readonly GITHUB_RELEASE_APP_CONFIGURATION?: string;
  readonly GITHUB_RELEASE_APP_PRIVATE_KEY_PKCS8?: string;
  readonly GITHUB_ALLOWED_REPOSITORY_IDS?: string;
  readonly GITHUB_ORGANIZATION_ID?: string;
}

export interface ReleaseCatalogCredential {
  readonly repositoryId: string;
  readonly organizationId: string;
  readonly token: string;
  readonly expiresAt: number;
  /** Synchronous current configuration, clock and cancellation fence. */
  current(): boolean;
}

export interface ReleaseCatalogAuthentication {
  resolve(input: {
    readonly purpose: 'public_release_catalog_read';
    readonly repositoryId: string;
    readonly deadline: number;
  }, signal: AbortSignal): Promise<ReleaseCatalogCredential | null>;
}

export function releaseRateHints(response: Response) {
  function integer(name: string, maximum: number): number | null {
    const value = response.headers.get(name);
    if (value === null || !/^\d{1,10}$/u.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null;
  }
  return {
    rateLimitRemaining: integer('x-ratelimit-remaining', 2_147_483_647),
    retryAfterSeconds: integer('retry-after', 86_400),
  };
}

/** Only finite public response facts may cross the issuer boundary. */
export class ReleaseCatalogAuthenticationUnavailable extends Error {
  constructor(readonly response?: {
    readonly httpStatus: number;
    readonly rateLimitRemaining: number | null;
    readonly retryAfterSeconds: number | null;
  }, readonly reason: 'invalid_configuration' | 'issuer_unavailable' | 'invalid_grant' | 'authority_unavailable' = 'authority_unavailable') {
    super('Catalog authentication unavailable');
  }
}

export class CatalogResponseError extends Error {
  constructor(readonly reason: 'too_large' | 'invalid_json') { super('Catalog response unavailable'); }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function numericId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d{0,15}$/u.test(value) &&
    Number.isSafeInteger(Number(value));
}
function timestamp(value: unknown): number {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(value)
    ? Date.parse(value) : NaN;
}
function base64url(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
    .replace(/=/gu, '').replace(/\+/gu, '-').replace(/\//gu, '_');
}

/** Bounded streaming JSON for credential and public repository responses. */
export async function readCatalogAuthenticationJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const limit = 65_536;
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/u.test(declared) && Number(declared) > limit)
    throw new CatalogResponseError('too_large');
  const reader = response.body?.getReader();
  if (!reader) throw new CatalogResponseError('invalid_json');
  const chunks: Uint8Array[] = [];
  let total = 0, reads = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw new ReleaseCatalogAuthenticationUnavailable();
      if (++reads > limit + 64) throw new CatalogResponseError('too_large');
      const next = await reader.read();
      if (signal.aborted) throw new ReleaseCatalogAuthenticationUnavailable();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) throw new CatalogResponseError('too_large');
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new CatalogResponseError('invalid_json'); }
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
  }
}

/**
 * Optional dedicated issuer; absent/anonymous mode performs no credential read.
 * Invalid or incomplete configured App mode is unavailable, never anonymous.
 * No private key, JWT, token or unprojected response escapes to logs/storage.
 */
export function releaseCatalogAuthenticationFor(
  environment: () => ReleaseCatalogAuthenticationEnv,
  options: { readonly clock?: Clock; readonly fetch?: typeof fetch } = {},
): ReleaseCatalogAuthentication | undefined {
  const mode = environment().GITHUB_RELEASE_AUTH_MODE;
  if (mode === undefined || mode === 'anonymous') return undefined;
  const clock = options.clock ?? systemClock;
  const transport = options.fetch ?? fetch;
  return {
    async resolve(input, signal) {
      const env = environment();
      if (signal.aborted || input.purpose !== 'public_release_catalog_read' ||
          !RELEASE_CATALOG.some(entry => entry.repositoryId === input.repositoryId)) return null;
      if (env.GITHUB_RELEASE_AUTH_MODE !== 'github_app')
        throw new ReleaseCatalogAuthenticationUnavailable(undefined, 'invalid_configuration');
      const raw = env.GITHUB_RELEASE_APP_CONFIGURATION;
      const pem = env.GITHUB_RELEASE_APP_PRIVATE_KEY_PKCS8;
      const allowed = env.GITHUB_ALLOWED_REPOSITORY_IDS;
      const organizationId = env.GITHUB_ORGANIZATION_ID;
      if (typeof raw !== 'string' || raw.length > 2_048 || typeof pem !== 'string' ||
          pem.length > 16_384 || typeof allowed !== 'string' || !numericId(organizationId))
        throw new ReleaseCatalogAuthenticationUnavailable(undefined, 'invalid_configuration');
      let config: unknown;
      try { config = JSON.parse(raw); }
      catch { throw new ReleaseCatalogAuthenticationUnavailable(undefined, 'invalid_configuration'); }
      const ids = allowed.split(',').map(value => value.trim());
      if (!record(config) || Object.keys(config).sort().join(',') !== 'appId,installationId,validUntil,version' ||
          !numericId(config.appId) || !numericId(config.installationId) ||
          typeof config.version !== 'string' || !/^[A-Za-z0-9._-]{1,100}$/u.test(config.version) ||
          ids.length !== RELEASE_CATALOG.length || new Set(ids).size !== ids.length ||
          !RELEASE_CATALOG.every(entry => ids.includes(entry.repositoryId)))
        throw new ReleaseCatalogAuthenticationUnavailable(undefined, 'invalid_configuration');
      const validUntil = timestamp(config.validUntil);
      const started = new Date(clock.now()).getTime();
      if (!Number.isFinite(started) || !Number.isFinite(validUntil) ||
          !Number.isFinite(input.deadline) || validUntil <= started || input.deadline <= started)
        throw new ReleaseCatalogAuthenticationUnavailable(undefined, 'invalid_configuration');
      let expiresAt = Math.min(validUntil, input.deadline);
      function current() {
        const now = new Date(clock.now()).getTime(), latest = environment();
        return !signal.aborted && Number.isFinite(now) && now >= started && now < expiresAt &&
          latest.GITHUB_RELEASE_AUTH_MODE === 'github_app' &&
          latest.GITHUB_RELEASE_APP_CONFIGURATION === raw &&
          latest.GITHUB_ALLOWED_REPOSITORY_IDS === allowed &&
          latest.GITHUB_ORGANIZATION_ID === organizationId &&
          latest.GITHUB_RELEASE_APP_PRIVATE_KEY_PKCS8 === pem;
      }
      function assertCurrent() { if (!current()) throw new ReleaseCatalogAuthenticationUnavailable(); }
      const match = /^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)\s+-----END PRIVATE KEY-----\s*$/u.exec(pem);
      if (!match) throw new ReleaseCatalogAuthenticationUnavailable(undefined, 'invalid_configuration');
      let key: CryptoKey;
      try {
        key = await crypto.subtle.importKey('pkcs8',
          Uint8Array.from(atob(match[1]!.replace(/\s/gu, '')), char => char.charCodeAt(0)),
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
      } catch { throw new ReleaseCatalogAuthenticationUnavailable(undefined, 'invalid_configuration'); }
      assertCurrent();
      if (!('modulusLength' in key.algorithm) || typeof key.algorithm.modulusLength !== 'number' ||
          key.algorithm.modulusLength < 2_048 || key.algorithm.modulusLength > 4_096)
        throw new ReleaseCatalogAuthenticationUnavailable(undefined, 'invalid_configuration');
      const seconds = Math.floor(new Date(clock.now()).getTime() / 1_000);
      const jwtExpiry = (seconds + 540) * 1_000;
      expiresAt = Math.min(expiresAt, jwtExpiry);
      const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
      const unsigned = encode({ alg: 'RS256', typ: 'JWT' }) + '.' +
        encode({ iat: seconds - 60, exp: seconds + 540, iss: config.appId });
      const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
      assertCurrent();
      const jwt = unsigned + '.' + base64url(new Uint8Array(signature));
      const url = 'https://api.github.com/app/installations/' + config.installationId + '/access_tokens';
      const response = await transport(url, {
        method: 'POST', redirect: 'error', signal,
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'pegma-dev-release-catalog',
          'X-GitHub-Api-Version': '2022-11-28', Authorization: 'Bearer ' + jwt,
          'Content-Type': 'application/json' },
        body: JSON.stringify({ repository_ids: [Number(input.repositoryId)], permissions: { metadata: 'read' } }),
      });
      assertCurrent();
      if (response.status !== 201) throw new ReleaseCatalogAuthenticationUnavailable({
        httpStatus: response.status, ...releaseRateHints(response),
      }, 'issuer_unavailable');
      if (response.redirected || (response.url !== '' && response.url !== url))
        throw new ReleaseCatalogAuthenticationUnavailable();
      let grant: unknown;
      try { grant = await readCatalogAuthenticationJson(response, signal); }
      catch (error) {
        if (error instanceof ReleaseCatalogAuthenticationUnavailable) throw error;
        throw new ReleaseCatalogAuthenticationUnavailable(undefined, 'invalid_grant');
      }
      assertCurrent();
      if (!record(grant) || typeof grant.token !== 'string' || !/^[\x21-\x7E]{1,2048}$/u.test(grant.token) ||
          grant.repository_selection !== 'selected' || !record(grant.permissions) ||
          grant.permissions.metadata !== 'read' || Object.keys(grant.permissions).length !== 1 ||
          !Array.isArray(grant.repositories) || grant.repositories.length !== 1)
        throw new ReleaseCatalogAuthenticationUnavailable(undefined, 'invalid_grant');
      const repository: unknown = grant.repositories[0];
      if (!record(repository) || String(repository.id) !== input.repositoryId || repository.private !== false)
        throw new ReleaseCatalogAuthenticationUnavailable(undefined, 'invalid_grant');
      expiresAt = Math.min(expiresAt, timestamp(grant.expires_at));
      assertCurrent();
      return { repositoryId: input.repositoryId, organizationId, token: grant.token, expiresAt, current };
    },
  };
}
