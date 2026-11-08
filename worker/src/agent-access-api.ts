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

export interface AgentAccessApiOptions extends AgentBrowserOptions {
  readonly service: AgentAccessServicePort;
  readonly configuration: AgentAccessConfiguration;
  readonly limit: (request: Request) => Promise<void>;
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
      await options.limit(request);
      const { authenticated, context } = await requireAgentBrowserContext(
        request,
        options,
        request.method !== 'GET',
      );
      if (path === '/api/agent-access/state') {
        if (url.search !== '') throw new ApiError(400, 'invalid_request');
        response = json({
          csrfToken: authenticated.csrfToken,
          resource: options.configuration.resource,
          scopes: options.configuration.scopes,
        });
      } else if (grant !== null) {
        if (
          url.search !== '' ||
          (request.method === 'DELETE' && request.body !== null)
        )
          throw new ApiError(400, 'invalid_request');
        const grantId = boundedString(grant[1], 1, 128);
        if (request.method === 'GET')
          response = json(await options.service.getGrant(context, grantId));
        else {
          await options.service.revokeGrant(context, grantId);
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
          await readJson(request),
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
        response = json(await options.service.approve(context, command));
      }
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
