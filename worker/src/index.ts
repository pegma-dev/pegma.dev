import {
  createDetailCheck,
  createProcessCheck,
  runHealthChecks,
  toHealthResponse,
} from '@pegma/health';
import { createAppLogger, type LoggerEnv } from './logger';

export interface Env extends LoggerEnv {}

/**
 * Thin Workers slice that proves pegma.dev's Pegma Logger wiring:
 * Cloudflare Workers Logs (via @pegma/logger-cloudflare + observability)
 * teed with Datadog when DATADOG_API_KEY is set.
 */
export default {
  async fetch(
    request: Request,
    env: Env,
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

    if (request.method === 'GET' && (path === '/' || path === '/health')) {
      const result = await runHealthChecks({
        service: 'pegma-dev-api',
        logger,
        checks: [
          createProcessCheck(),
          createDetailCheck('logging', {
            cloudflare: true,
            datadog: Boolean(env.DATADOG_API_KEY),
          }),
        ],
      });
      const { status, body } = toHealthResponse(result);
      return Response.json(body, { status });
    }

    logger.log('warn', 'request.not_found', { method: request.method, path });
    return new Response('Not Found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
