import { hasPermission, type AccessContext } from '@pegma/authorization-core';
import type { SessionStore } from '@pegma/sessions';
import type { Authenticated } from './api-auth';
import {
  ApiError,
  isPlainObject,
  requireCsrf,
  requireSameOriginMutation,
} from './api-auth';
import { IDENTITY_ISSUER } from './identity-api';

export type SupportHumanCoordinates = Readonly<
  Pick<Authenticated, 'rawSessionId' | 'csrfToken' | 'link'>
>;

interface HumanControlAuthority {
  readonly sessions: Pick<SessionStore, 'get'>;
  readonly authenticate: (request: Request) => Promise<Authenticated>;
  readonly access: (
    authenticated: SupportHumanCoordinates,
  ) => Promise<AccessContext> | AccessContext;
  readonly permission: string;
  readonly mutation: boolean;
}

/** Operation-local browser fences. Nothing here is a stored grant or an AA scope. */
export function supportHumanBrowser(
  request: Request,
  options: HumanControlAuthority,
) {
  const headers = Object.freeze(
    ['Cookie', 'Origin', 'X-Pegma-CSRF', 'Sec-Fetch-Site', 'Authorization'].map(
      (name) => Object.freeze({ name, value: request.headers.get(name) }),
    ),
  );
  function guard() {
    if (new URL(request.url).origin !== IDENTITY_ISSUER)
      throw new ApiError(403, 'cross_origin_denied');
    if (request.headers.has('Authorization'))
      throw new ApiError(403, 'browser_session_required');
    if (options.mutation) requireSameOriginMutation(request);
    if (headers.some(({ name, value }) => request.headers.get(name) !== value))
      throw new ApiError(403, 'browser_credential_changed');
  }
  let original: SupportHumanCoordinates | undefined;
  let observedExpiry = 0;
  return Object.freeze({
    /** Closing synchronous header/absolute-expiry fence after a current() read. */
    assertCurrent() {
      guard();
      if (original === undefined || Date.now() >= observedExpiry)
        throw new ApiError(401, 'authentication_required');
    },
    async current() {
      guard();
      if (original === undefined) {
        // Full admission and configured bootstrap happen once in this HTTP
        // invocation. Retain credential coordinates, never user/role authority.
        const admitted = await options.authenticate(request);
        guard();
        if (options.mutation) await requireCsrf(request, admitted);
        guard();
        original = Object.freeze({
          rawSessionId: admitted.rawSessionId,
          csrfToken: admitted.csrfToken,
          link: Object.freeze({
            issuer: admitted.link.issuer,
            subject: admitted.link.subject,
          }),
        });
      }
      const authenticated = original;
      // Every call still resolves current roles and active verified Identity;
      // the closing SessionStore read validates these same immutable credentials.
      const access = await options.access(authenticated);
      guard();
      if (
        access.principalId !== authenticated.link.subject ||
        !hasPermission(access, options.permission)
      )
        throw new ApiError(403, 'forbidden');
      // SessionStore.get enforces revocation and idle expiry. Keep this one
      // closing read after role/Identity awaits; do not restart authorization.
      const session = await options.sessions.get(authenticated.rawSessionId);
      guard();
      if (session === null) throw new ApiError(401, 'authentication_required');
      let data: unknown;
      try {
        data = JSON.parse(session.data);
      } catch {
        throw new ApiError(401, 'authentication_required');
      }
      const expiresAt = Date.parse(session.expiresAt);
      if (
        session.principalId !== authenticated.link.subject ||
        !isPlainObject(data) ||
        Object.keys(data).length !== 4 ||
        data.version !== 1 ||
        data.csrfToken !== authenticated.csrfToken ||
        data.issuer !== authenticated.link.issuer ||
        data.subject !== authenticated.link.subject ||
        !Number.isFinite(expiresAt) ||
        Date.now() >= expiresAt
      )
        throw new ApiError(401, 'authentication_required');
      // get() deliberately returns its initially validated record; the final
      // synchronous absolute-expiry comparison covers time spent in that read.
      observedExpiry = expiresAt;
      return Object.freeze({ authenticated, access });
    },
  });
}
