import {
  createDetailCheck,
  createProcessCheck,
  runHealthChecks,
  toHealthResponse,
} from '@pegma/health';
import { runIdentityMaintenance } from './identity-maintenance';
import { createAppLogger, type LoggerEnv } from './logger';
import {
  createProductionIdentityRuntime,
  type IdentityRuntimeEnv,
} from './identity-runtime';

type AppEnv = Env & LoggerEnv & IdentityRuntimeEnv;

/**
 * Thin Workers slice that proves pegma.dev's Pegma Logger wiring:
 * Cloudflare Workers Logs (via @pegma/logger-cloudflare + observability)
 * teed with Datadog when DATADOG_API_KEY is set.
 */
export default {
  async fetch(
    request: Request,
    env: AppEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const logger = createAppLogger(env, (p) => ctx.waitUntil(p));
    const url = new URL(request.url);
    const path = url.pathname;

    logger.log('info', 'request.received', {
      method: request.method,
      path,
      host: url.host,
    });

    if (
      request.method === 'GET' &&
      (path === '/' || path === '/health' || path === '/api/health')
    ) {
      const result = await runHealthChecks({
        service: 'pegma-dev-api',
        logger,
        checks: [
          createProcessCheck(),
          createDetailCheck('logging', {
            cloudflare: true,
            datadog: Boolean(env.DATADOG_API_KEY),
          }),
          createDetailCheck('identity', {
            storage: 'cloudflare-d1',
            sessions: '@pegma/sessions@0.1.0',
            runtime: '@pegma/identity@0.1.0',
            authorizationAdapter: '@pegma/authorization-identity@0.1.2',
            emailDelivery:
              String(env.IDENTITY_EMAIL_ENABLED) === 'true' &&
              Boolean(env.RESEND_API_KEY),
          }),
        ],
      });
      const { status, body } = toHealthResponse(result);
      return Response.json(body, { status });
    }

    if (path.startsWith('/api/identity/')) {
      try {
        return createProductionIdentityRuntime(env, logger).api(request);
      } catch (error) {
        logger.log('error', 'identity.runtime_unavailable', {
          error: error instanceof Error ? error.name : 'unknown',
        });
        return Response.json(
          { error: 'identity_unavailable' },
          {
            status: 503,
            headers: {
              'Cache-Control': 'no-store',
              'Content-Type': 'application/json; charset=utf-8',
              'X-Content-Type-Options': 'nosniff',
            },
          },
        );
      }
    }

    logger.log('warn', 'request.not_found', { method: request.method, path });
    return new Response('Not Found', { status: 404 });
  },
  scheduled(
    _controller: ScheduledController,
    env: AppEnv,
    ctx: ExecutionContext,
  ): void {
    const logger = createAppLogger(env, (promise) => ctx.waitUntil(promise));
    ctx.waitUntil(
      (async () => {
        try {
          await runIdentityMaintenance(
            createProductionIdentityRuntime(env, logger),
            logger,
          );
        } catch (error) {
          logger.log('error', 'identity.maintenance_unavailable', {
            error: error instanceof Error ? error.name : 'unknown',
          });
        }
      })(),
    );
  },
} satisfies ExportedHandler<AppEnv>;
