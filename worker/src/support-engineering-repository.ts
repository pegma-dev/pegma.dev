import type { Clock } from '@pegma/spine';
import type {
  EngineeringDispatchResultVerifier,
  EngineeringRepositoryMetadataPort,
  EngineeringRepositoryObservation,
} from '@pegma/support-desk-application';
import type {
  EngineeringExternalContext,
  EngineeringGitHubMetadata,
  EngineeringGitHubPort,
} from '@pegma/support-desk-ai';
import {
  createSupportEngineeringIssueOperations,
  type SupportEngineeringRepositorySession,
} from './support-engineering-github';

/** Trusted deployment configuration, copied at construction; never request input. */
export interface SupportEngineeringRepository {
  readonly repositoryId: string;
  readonly owner: string;
  readonly name: string;
  readonly visibility: 'public' | 'private';
  readonly appId: string;
  readonly installationId: string;
}

/** Credentials and their current authority come from the host's trusted issuer. */
export interface SupportEngineeringRepositoryAuthentication {
  readonly active: true;
  readonly appId: string;
  readonly installationId: string;
  readonly binding: string;
  readonly version: string;
  readonly validUntil: string;
  readonly appJwt: string;
  readonly installationToken: string;
}

export interface SupportEngineeringRepositoryOptions {
  readonly clock: Clock;
  /** Omission, false and exceptions all keep this capability OFF. */
  readonly enabled?: () => boolean;
  /** Separate OFF-by-default write gate. Read-only reconciliation stays available. */
  readonly issueCreationEnabled?: () => boolean;
  readonly repositories?: readonly SupportEngineeringRepository[];
  readonly authentication?: {
    resolve(
      repository: SupportEngineeringRepository,
      signal: AbortSignal,
    ): Promise<SupportEngineeringRepositoryAuthentication | null>;
  };
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

const API = 'https://api.github.com';
const API_VERSION = '2026-03-10';
const MAX_BODY_BYTES = 65_536;
const MAX_DURATION = 10_000;
const encoder = new TextEncoder();
const noControls = /^[^\u0000-\u001F\u007F]+$/u;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function bounded(value: unknown, maximum = 200): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    noControls.test(value)
  );
}
function id(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[1-9][0-9]{0,15}$/u.test(value) &&
    Number.isSafeInteger(Number(value))
  );
}
function remoteId(value: unknown): string | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : null;
}
function instant(value: unknown): number | null {
  if (!bounded(value, 40)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? parsed
    : null;
}
function githubTimestamp(value: unknown): value is string {
  return (
    bounded(value, 40) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
function credential(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    /^[\x21-\x7E]+$/u.test(value)
  );
}
function catalog(
  input: readonly SupportEngineeringRepository[],
): ReadonlyMap<string, SupportEngineeringRepository> {
  if (!Array.isArray(input) || input.length > 20)
    throw new TypeError('Invalid engineering repository configuration');
  const result = new Map<string, SupportEngineeringRepository>();
  const names = new Set<string>();
  for (const value of input) {
    if (
      !record(value) ||
      !id(value.repositoryId) ||
      !id(value.appId) ||
      !id(value.installationId) ||
      typeof value.owner !== 'string' ||
      !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/u.test(value.owner) ||
      typeof value.name !== 'string' ||
      !/^[a-zA-Z0-9_.-]{1,100}$/u.test(value.name) ||
      ['.', '..'].includes(value.name) ||
      (value.visibility !== 'public' && value.visibility !== 'private') ||
      result.has(value.repositoryId)
    )
      throw new TypeError('Invalid engineering repository configuration');
    const name = (value.owner + '/' + value.name).toLowerCase();
    if (names.has(name))
      throw new TypeError('Invalid engineering repository configuration');
    names.add(name);
    result.set(
      value.repositoryId,
      Object.freeze({
        repositoryId: value.repositoryId,
        owner: value.owner,
        name: value.name,
        visibility: value.visibility,
        appId: value.appId,
        installationId: value.installationId,
      }),
    );
  }
  return result;
}

async function fingerprint(prefix: string, value: unknown): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      encoder.encode(JSON.stringify(value)),
    ),
  );
  return (
    prefix +
    [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  );
}

/** A streaming bound applies even without a Content-Length or cooperative body. */
async function json(response: Response, signal: AbortSignal): Promise<unknown> {
  const type = response.headers
    .get('content-type')
    ?.split(';')[0]
    ?.trim()
    .toLowerCase();
  const size = response.headers.get('content-length');
  if (
    (type !== 'application/json' && type !== 'application/vnd.github+json') ||
    response.body === null ||
    (size !== null &&
      (!/^(0|[1-9][0-9]*)$/u.test(size) || Number(size) > MAX_BODY_BYTES))
  )
    throw new Error('Unavailable metadata');
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error('Unavailable metadata');
      const next = await reader.read();
      if (signal.aborted) throw new Error('Unavailable metadata');
      if (next.done) break;
      length += next.value.byteLength;
      if (length > MAX_BODY_BYTES) throw new Error('Unavailable metadata');
      chunks.push(next.value);
    }
    const all = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      all.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all));
  } finally {
    // Cancellation is best effort; it must not extend the operation deadline.
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

/**
 * Two fixed metadata reads precede each operation. No retries/cache; every
 * response is bounded to 64 KiB and the entire operation to ten seconds.
 * App-JWT installation discovery proves membership even for public repositories;
 * a public repository GET with an installation token alone cannot prove that.
 * Neither credentials nor unprojected GitHub response fields escape this port.
 */
export function createSupportEngineeringRepositoryPorts(
  options: SupportEngineeringRepositoryOptions,
): {
  readonly repositoryMetadata: EngineeringRepositoryMetadataPort;
  readonly github: EngineeringGitHubPort;
  readonly dispatchResults: EngineeringDispatchResultVerifier;
} {
  const repositories = catalog(options.repositories ?? []);
  const authenticate = options.authentication;
  const transport =
    options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  const enabled = () => {
    try {
      return options.enabled?.() === true;
    } catch {
      return false;
    }
  };
  const now = () => {
    try {
      return instant(options.clock.now());
    } catch {
      return null;
    }
  };

  async function withinRepository<Value>(
    repositoryId: string,
    parent: AbortSignal,
    use: (session: SupportEngineeringRepositorySession) => Promise<Value>,
    context?: EngineeringExternalContext,
  ): Promise<{ readonly value: Value; readonly validUntil: string } | null> {
    const configured = repositories.get(repositoryId);
    const start = now();
    if (
      !enabled() ||
      configured === undefined ||
      authenticate === undefined ||
      parent.aborted ||
      start === null ||
      (context !== undefined && context.purpose !== 'support_bug_assessment')
    )
      return null;
    const requestedDeadline =
      context === undefined ? start + MAX_DURATION : instant(context.deadline);
    if (requestedDeadline === null || requestedDeadline <= start) return null;
    let expires = Math.min(start + MAX_DURATION, requestedDeadline);
    let authorityExpires = Infinity;
    const monotonicStart = performance.now();
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let finish: (value: null) => void = () => undefined;
    const stopped = new Promise<null>((resolve) => {
      finish = resolve;
    });
    const stop = () => {
      controller.abort();
      finish(null);
    };
    const remaining = () => {
      const current = now();
      return current === null
        ? 0
        : Math.min(
            expires - current,
            expires - start - (performance.now() - monotonicStart),
          );
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(stop, Math.max(0, remaining()));
    };
    const current = () => {
      if (
        !enabled() ||
        controller.signal.aborted ||
        parent.aborted ||
        remaining() <= 0
      )
        throw new Error('Unavailable metadata');
    };
    parent.addEventListener('abort', stop, { once: true });
    if (parent.aborted) stop();
    schedule();
    async function authority(): Promise<SupportEngineeringRepositoryAuthentication> {
      current();
      const value = await authenticate!.resolve(configured!, controller.signal);
      current();
      if (
        value === null ||
        value.active !== true ||
        value.appId !== configured!.appId ||
        value.installationId !== configured!.installationId ||
        !bounded(value.binding) ||
        !bounded(value.version) ||
        !credential(value.appJwt) ||
        !credential(value.installationToken)
      )
        throw new Error('Unavailable metadata');
      const until = instant(value.validUntil);
      if (until === null || until <= (now() ?? Infinity))
        throw new Error('Unavailable metadata');
      const snapshot = Object.freeze({
        active: true as const,
        appId: value.appId,
        installationId: value.installationId,
        binding: value.binding,
        version: value.version,
        validUntil: value.validUntil,
        appJwt: value.appJwt,
        installationToken: value.installationToken,
      });
      authorityExpires = Math.min(authorityExpires, until);
      expires = Math.min(expires, until);
      schedule();
      return snapshot;
    }
    function sameAuthority(
      first: SupportEngineeringRepositoryAuthentication,
      last: SupportEngineeringRepositoryAuthentication,
    ) {
      if (
        first.binding !== last.binding ||
        first.version !== last.version ||
        first.appId !== last.appId ||
        first.installationId !== last.installationId
      )
        throw new Error('Unavailable metadata');
    }
    async function request(
      url: string,
      token: string,
      method: 'GET' | 'POST' = 'GET',
      body?: string,
    ): Promise<unknown> {
      current();
      const response = await transport(url, {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: 'Bearer ' + token,
          'X-GitHub-Api-Version': API_VERSION,
          'User-Agent': 'Pegma-support-engineering',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body }),
      });
      current();
      if (
        response.status !== (method === 'POST' ? 201 : 200) ||
        response.redirected ||
        (response.url !== '' && response.url !== url)
      )
        throw new Error('Unavailable metadata');
      const value = await json(response, controller.signal);
      current();
      return value;
    }
    async function run(): Promise<{
      readonly value: Value;
      readonly validUntil: string;
    }> {
      const first = await authority();
      const path =
        API +
        '/repos/' +
        encodeURIComponent(configured!.owner) +
        '/' +
        encodeURIComponent(configured!.name);
      const installation = await request(path + '/installation', first.appJwt);
      if (
        !record(installation) ||
        remoteId(installation.id) !== configured!.installationId ||
        remoteId(installation.app_id) !== configured!.appId ||
        installation.suspended_at !== null ||
        !record(installation.account) ||
        installation.account.login !== configured!.owner ||
        remoteId(installation.account.id) === null ||
        (installation.account.type !== 'User' &&
          installation.account.type !== 'Organization') ||
        installation.target_type !== installation.account.type ||
        installation.target_id !== installation.account.id ||
        (installation.repository_selection !== 'selected' &&
          installation.repository_selection !== 'all') ||
        !record(installation.permissions) ||
        installation.permissions.metadata !== 'read' ||
        !githubTimestamp(installation.updated_at)
      )
        throw new Error('Unavailable metadata');
      const permissions = Object.entries(installation.permissions).sort(
        ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
      );
      if (
        permissions.length > 100 ||
        permissions.some(
          ([key, value]) =>
            !/^[a-z_]{1,100}$/u.test(key) ||
            (value !== 'read' && value !== 'write'),
        )
      )
        throw new Error('Unavailable metadata');
      const middle = await authority();
      sameAuthority(first, middle);
      const repository = await request(path, middle.installationToken);
      if (
        !record(repository) ||
        remoteId(repository.id) !== configured!.repositoryId ||
        repository.name !== configured!.name ||
        repository.full_name !== configured!.owner + '/' + configured!.name ||
        !record(repository.owner) ||
        repository.owner.login !== configured!.owner ||
        repository.owner.id !== installation.account.id ||
        repository.owner.type !== installation.account.type ||
        repository.visibility !== configured!.visibility ||
        repository.private !== (configured!.visibility === 'private') ||
        repository.archived !== false ||
        repository.disabled !== false ||
        typeof repository.has_issues !== 'boolean' ||
        !bounded(repository.default_branch) ||
        !githubTimestamp(repository.updated_at)
      )
        throw new Error('Unavailable metadata');
      const installationBinding = await fingerprint('github-installation:', [
        API_VERSION,
        configured!.appId,
        configured!.installationId,
        installation.account.id,
        installation.account.type,
        installation.account.login,
        installation.repository_selection,
        permissions,
        installation.updated_at,
        first.binding,
        first.version,
      ]);
      current();
      const metadataVersion = await fingerprint('github-repository:', [
        API_VERSION,
        configured!.repositoryId,
        repository.full_name,
        repository.visibility,
        repository.private,
        repository.archived,
        repository.disabled,
        repository.has_issues,
        repository.default_branch,
        repository.updated_at,
        installationBinding,
      ]);
      current();
      const observation: EngineeringRepositoryObservation = Object.freeze({
        repositoryId: configured!.repositoryId,
        owner: configured!.owner,
        name: configured!.name,
        visibility: configured!.visibility,
        installationBinding,
        metadataVersion,
      });
      const issuePermission = installation.permissions.issues;
      const issuesEnabled = repository.has_issues;
      const appSlug =
        typeof installation.app_slug === 'string' &&
        /^[a-z0-9][a-z0-9-]{0,99}$/u.test(installation.app_slug)
          ? installation.app_slug
          : null;
      async function issueRequest(url: string, body?: string) {
        if (
          issuePermission !== 'write' &&
          (body !== undefined || issuePermission !== 'read')
        )
          throw new Error('Unavailable metadata');
        const writeCurrent = () => {
          if (body === undefined) return;
          if (
            issuesEnabled !== true ||
            options.issueCreationEnabled?.() !== true
          )
            throw new Error('Unavailable metadata');
        };
        writeCurrent();
        const latest = await authority();
        sameAuthority(first, latest);
        current();
        writeCurrent();
        return request(
          url,
          latest.installationToken,
          body === undefined ? 'GET' : 'POST',
          body,
        );
      }
      const value = await use({
        repository: observation,
        appId: configured!.appId,
        appSlug,
        path,
        current,
        search: (query, limit) =>
          issueRequest(
            API +
              '/search/issues?' +
              new URLSearchParams({
                q: query,
                per_page: String(limit),
                page: '1',
              }),
          ),
        issue: (number) => issueRequest(path + '/issues/' + number),
        create: (body) => issueRequest(path + '/issues', body),
      });
      // Last await rereads trusted authority, including after an uncertain POST.
      // A withheld acknowledgement is unknown; this port never retries a write.
      const last = await authority();
      sameAuthority(first, last);
      current();
      return { value, validUntil: new Date(authorityExpires).toISOString() };
    }
    try {
      return await Promise.race([run(), stopped]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer!);
      parent.removeEventListener('abort', stop);
      controller.abort();
    }
  }
  const observe = async (
    repositoryId: string,
    signal: AbortSignal,
    context?: EngineeringExternalContext,
  ): Promise<EngineeringGitHubMetadata | null> => {
    const observed = await withinRepository(
      repositoryId,
      signal,
      async (session) => session.repository,
      context,
    );
    return observed === null
      ? null
      : Object.freeze({
          repository: observed.value,
          authority: Object.freeze({
            active: true as const,
            binding: observed.value.installationBinding,
            validUntil: observed.validUntil,
          }),
        });
  };
  const issues = createSupportEngineeringIssueOperations(
    (repositoryId, context, use) =>
      withinRepository(repositoryId, context.signal, use, context),
    options.clock,
  );
  return Object.freeze({
    repositoryMetadata: Object.freeze({
      resolve: (repositoryId: string, signal: AbortSignal) =>
        observe(repositoryId, signal).then(
          (value) => value?.repository ?? null,
        ),
    }),
    github: Object.freeze({
      getMetadata: (
        repositoryId: string,
        context: EngineeringExternalContext,
      ) => observe(repositoryId, context.signal, context),
      ...issues.github,
    }),
    dispatchResults: issues.dispatchResults,
  });
}
