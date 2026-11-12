import { json } from './api-auth';
import {
  createSupportEngineeringHandlers,
  type SupportEngineeringHandlerOptions,
} from './support-engineering-handlers';

export interface SupportEngineeringRouterOptions {
  /** Strict current server flag. Absence and exceptions remain OFF. */
  readonly enabled?: () => boolean;
  /** Existing request-scoped host dependencies; no default authority or clients. */
  readonly configuration?: Omit<SupportEngineeringHandlerOptions, 'enabled'>;
}

const ticketNamespace = /^\/api\/support\/admin\/tickets\/[A-Za-z0-9._~-]{1,200}\/engineering(?:\/|$)/u;
const policyNamespace = /^\/api\/support\/admin\/engineering(?:\/|$)/u;

/** Own unknown subpaths too, so they cannot fall through to legacy commands. */
export function isSupportEngineeringRequest(pathname: string): boolean {
  return ticketNamespace.test(pathname) || policyNamespace.test(pathname);
}

function notFound(): Response {
  return json({ error: 'not_found' }, { status: 404 });
}

/**
 * Optional router, not an entrypoint registration. Call before the existing
 * Support API and use its fallback only for null. No Store, runtime, provider,
 * route or global authorization/cache is created by this factory.
 */
export function createSupportEngineeringRouter(options: SupportEngineeringRouterOptions = {}) {
  const configuration = options.configuration;
  function enabled() {
    if (configuration === undefined) return false;
    try { return options.enabled?.() === true; } catch { return false; }
  }
  return async function route(request: Request): Promise<Response | null> {
    if (!isSupportEngineeringRequest(new URL(request.url).pathname)) return null;
    if (configuration === undefined || !enabled()) return notFound();
    try {
      // Handler state and browser credential fences belong to this dispatch,
      // never to a shared router instance or another HTTP invocation.
      const handle = createSupportEngineeringHandlers({ ...configuration, enabled });
      const response = await handle(request);
      if (!enabled()) return notFound();
      return response ?? notFound();
    } catch {
      if (!enabled()) return notFound();
      return json({ error: 'support_engineering_unavailable' }, { status: 503 });
    }
  };
}
