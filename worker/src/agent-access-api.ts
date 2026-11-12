import {
  OAuthError,
  type AgentAccessConfiguration,
  type AgentAccessServicePort,
  type ApproveInput,
} from '@pegma/agent-access';
import {
  ApiError,
  boundedString,
  json,
  optionalKeysObject,
  readJson,
} from './api-auth';
import {
  requireAgentBrowserContext,
  type AgentBrowserOptions,
} from './agent-authority';

const browserBodyTimeoutMs = 10_000;

export interface AgentAccessApiOptions extends AgentBrowserOptions {
  readonly service: AgentAccessServicePort;
  readonly configuration: AgentAccessConfiguration;
  readonly limit: (request: Request) => Promise<void>;
}

/** A transport may represent an empty DELETE as a stream rather than null. */
async function requireEmptyBody(request: Request): Promise<void> {
  if (request.body === null) return;
  const reader = request.body.getReader();
  const invalid = new ApiError(400, 'invalid_request');
  const timeout = new ApiError(408, 'request_timeout');
  const expiresAt = performance.now() + browserBodyTimeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let cancelled = false;
  const cancel = (reason: unknown): void => {
    if (cancelled) return;
    cancelled = true;
    // A source may never settle cancellation; it cannot hold this route open.
    try {
      void reader.cancel(reason).catch(() => {});
    } catch {
      /* Best effort. */
    }
  };
  const boundary = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(timeout);
      cancel(timeout);
    };
    timer = setTimeout(onAbort, browserBodyTimeoutMs);
    request.signal.addEventListener('abort', onAbort, { once: true });
    if (request.signal.aborted) onAbort();
  });
  // Input validation can fail before the race; keep any boundary rejection handled.
  void boundary.catch(() => {});
  try {
    const declared = request.headers.get('Content-Length');
    if (declared !== null && !/^0+$/u.test(declared)) throw invalid;
    // No bytes are buffered. Empty chunks periodically yield so deadline/abort
    // callbacks can run even when a source completes every read immediately.
    let emptyReads = 0;
    while (true) {
      if (performance.now() >= expiresAt) throw timeout;
      const chunk = await Promise.race([reader.read(), boundary]);
      if (performance.now() >= expiresAt || request.signal.aborted)
        throw timeout;
      if (chunk.done) return;
      if (chunk.value.byteLength !== 0) throw invalid;
      emptyReads += 1;
      if (emptyReads === 16) {
        emptyReads = 0;
        let yieldTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            boundary,
            new Promise<void>((resolve) => {
              yieldTimer = setTimeout(resolve, 0);
            }),
          ]);
        } finally {
          if (yieldTimer !== undefined) clearTimeout(yieldTimer);
        }
      }
    }
  } catch (error) {
    cancel(error);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined)
      request.signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

/** Existing-login consent and owner-only views. Public OAuth routes live in AA. */
export function createAgentAccessApi(
  options: AgentAccessApiOptions,
): (request: Request) => Promise<Response | null> {
  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    const grant = /^\/api\/agent-access\/grants\/([A-Za-z0-9_-]{1,128})$/u.exec(
      path,
    );
    if (
      path !== '/api/agent-access/state' &&
      path !== '/api/agent-access/approval' &&
      grant === null
    )
      return null;
    let response: Response;
    try {
      const allowed =
        path === '/api/agent-access/state'
          ? ['GET']
          : grant === null
            ? ['GET', 'POST']
            : ['GET', 'DELETE'];
      if (!allowed.includes(request.method))
        return json(
          { error: 'method_not_allowed' },
          {
            status: 405,
            headers: {
              Allow: allowed.join(', '),
              'Referrer-Policy': 'no-referrer',
            },
          },
        );
      const credentialHeaders = [
        'Cookie',
        'Origin',
        'X-Pegma-CSRF',
        'Sec-Fetch-Site',
        'Authorization',
      ].map((name) => ({ name, value: request.headers.get(name) }));
      function sameBrowserHeaders() {
        if (
          credentialHeaders.some(
            ({ name, value }) => request.headers.get(name) !== value,
          )
        )
          throw new ApiError(403, 'browser_credential_changed');
      }
      await options.limit(request);
      sameBrowserHeaders();
      const { authenticated, context } = await requireAgentBrowserContext(
        request,
        options,
        request.method !== 'GET',
      );
      sameBrowserHeaders();
      const principalId = context.access.principalId;
      const sessionId = authenticated.rawSessionId;
      async function currentMutationContext() {
        sameBrowserHeaders();
        const current = await requireAgentBrowserContext(
          request,
          options,
          true,
        );
        sameBrowserHeaders();
        if (
          current.authenticated.rawSessionId !== sessionId ||
          current.context.access.principalId !== principalId
        )
          throw new ApiError(403, 'browser_credential_changed');
        return current.context;
      }
      if (path === '/api/agent-access/state') {
        if (url.search !== '') throw new ApiError(400, 'invalid_request');
        response = json({
          csrfToken: authenticated.csrfToken,
          resource: options.configuration.resource,
          scopes: options.configuration.scopes,
        });
      } else if (grant !== null) {
        if (url.search !== '') throw new ApiError(400, 'invalid_request');
        const grantId = boundedString(grant[1], 1, 128);
        if (request.method === 'GET')
          response = json(await options.service.getGrant(context, grantId));
        else {
          let currentContext = context;
          if (request.body !== null) {
            await requireEmptyBody(request);
            // Empty input still adds an awaited boundary before a protected mutation.
            currentContext = await currentMutationContext();
          }
          await options.service.revokeGrant(currentContext, grantId);
          response = new Response(null, {
            status: 204,
            headers: {
              'Cache-Control': 'no-store',
              Pragma: 'no-cache',
              Vary: 'Cookie',
            },
          });
        }
      } else if (request.method === 'GET') {
        const keys = [...url.searchParams.keys()];
        if (
          keys.length !== 1 ||
          (keys[0] !== 'request_id' && keys[0] !== 'user_code')
        )
          throw new ApiError(400, 'invalid_request');
        const selector = boundedString(url.searchParams.get(keys[0]), 1, 128);
        response = json(
          keys[0] === 'user_code'
            ? await options.service.getDeviceApproval(context, selector)
            : await options.service.getAuthorizationApproval(context, selector),
        );
      } else {
        if (url.search !== '') throw new ApiError(400, 'invalid_request');
        const body = optionalKeysObject(
          await readJson(request, { timeoutMs: browserBodyTimeoutMs }),
          ['requestId', 'decision'],
          ['approvedScopes', 'userCode'],
        );
        if (body.decision !== 'approve' && body.decision !== 'deny')
          throw new ApiError(400, 'invalid_request');
        let approvedScopes: string[] | undefined;
        if (body.approvedScopes !== undefined) {
          if (
            !Array.isArray(body.approvedScopes) ||
            body.approvedScopes.length > 3
          )
            throw new ApiError(400, 'invalid_request');
          approvedScopes = body.approvedScopes.map((value: unknown) =>
            boundedString(value, 1, 128),
          );
        }
        const command: ApproveInput = {
          requestId: boundedString(body.requestId, 1, 128),
          decision: body.decision,
          ...(approvedScopes === undefined ? {} : { approvedScopes }),
          ...(body.userCode === undefined
            ? {}
            : { userCode: boundedString(body.userCode, 1, 128) }),
        };
        // Body input is an awaited browser boundary. Account/role authority in
        // AA cannot establish that the original host session is still live.
        const currentContext = await currentMutationContext();
        response = json(await options.service.approve(currentContext, command));
      }
      // The service may have awaited private reads or a committed mutation.
      // Withhold its response if the original browser no longer has authority;
      // this does not undo an approval or revocation that already committed.
      const final = await requireAgentBrowserContext(
        request,
        options,
        request.method !== 'GET',
      );
      sameBrowserHeaders();
      if (
        final.authenticated.rawSessionId !== sessionId ||
        final.context.access.principalId !== principalId
      )
        throw new ApiError(403, 'forbidden');
    } catch (error) {
      if (error instanceof ApiError)
        response = json(
          { error: error.code },
          {
            status: error.status,
            ...(error.retryAfterSeconds === undefined
              ? {}
              : {
                  headers: { 'Retry-After': String(error.retryAfterSeconds) },
                }),
          },
        );
      else if (error instanceof OAuthError)
        response = json(error.toJSON(), { status: error.status });
      else {
        options.logger.log('error', 'agent_access.browser_unavailable', {
          error: error instanceof Error ? error.name : 'unknown',
        });
        response = json({ error: 'service_unavailable' }, { status: 503 });
      }
    }
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    return response;
  };
}
