import {
  createDetailCheck,
  createProcessCheck,
  runHealthChecks,
  toHealthResponse,
} from '@pegma/health';
import { identityLinkKeyFromVerifiedIdentityClaims } from '@pegma/authorization-identity';
import { runIdentityMaintenance } from './identity-maintenance';
import { createAppLogger, type LoggerEnv } from './logger';
import {
  createProductionIdentityRuntime,
  type IdentityRuntimeEnv,
} from './identity-runtime';
import {
  createProductionStore,
  handleGitHubReleaseWebhook,
  readGitHubReleaseWebhookConfig,
  type GitHubReleaseWebhookEnv,
} from './github-release-webhook';
import { loadReleaseHealthDetail } from './release-health';
import {
  RELEASE_RECONCILIATION_CRON,
  runReleaseReconciliation,
} from './release-reconciliation';
import { handleGetReleases, readReleasesConfig } from './releases-api';
import { createSupportApi } from './support-api';
import { parseStaffAllowlist } from './support-access';
import {
  createProductionSupportRuntime,
  probeSupportStore,
  supportHealthProbeEnabled,
  type SupportRuntimeEnv,
} from './support-desk';
import { runSupportMaintenance } from './support-maintenance';
import { createPegmaMcpHandler } from './mcp-server';
import type { CatalogFetchEnv } from './mcp-catalog-fetch';

type AppEnv = Env &
  LoggerEnv &
  IdentityRuntimeEnv &
  GitHubReleaseWebhookEnv &
  SupportRuntimeEnv &
  CatalogFetchEnv;

function createSupportHandler(env: AppEnv, logger: ReturnType<typeof createAppLogger>) {
  const identityRuntime = createProductionIdentityRuntime(env, logger);
  const supportRuntime = createProductionSupportRuntime(env, {
    sessions: identityRuntime.sessions,
    identity: identityRuntime.identity,
    identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
    logger,
  });
  const api = createSupportApi({
    application: supportRuntime.application,
    sessions: supportRuntime.sessions,
    identity: supportRuntime.identity,
    identityLinkFromClaims: supportRuntime.identityLinkFromClaims,
    createLimiter: supportRuntime.createLimiter,
    replyLimiter: supportRuntime.replyLimiter,
    logger,
    staffAllowlist: parseStaffAllowlist(env),
  });
  return { supportRuntime, api };
}

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

    // Public composition catalog MCP (stateless; catalog facts only).
    if (path === '/api/mcp') {
      try {
        return await createPegmaMcpHandler(env)(request, env, ctx);
      } catch (error) {
        logger.log('error', 'mcp.unavailable', {
          error: error instanceof Error ? error.name : 'unknown',
          message: error instanceof Error ? error.message : String(error),
        });
        return Response.json(
          { error: 'mcp_unavailable' },
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

    if (
      request.method === 'GET' &&
      (path === '/' || path === '/health' || path === '/api/health')
    ) {
      let releaseDetail: Awaited<ReturnType<typeof loadReleaseHealthDetail>> = {
        ingestionConfigured: Boolean(readGitHubReleaseWebhookConfig(env)),
        readConfigured: Boolean(readReleasesConfig(env)),
        lastSuccessfulWebhookAt: null,
        lastSuccessfulReconciliationAt: null,
        reconciliationStale: true,
        currentReleaseCount: 0,
      };
      try {
        releaseDetail = await loadReleaseHealthDetail(
          createProductionStore(env),
          env,
        );
      } catch (error) {
        logger.log('error', 'releases_health.unavailable', {
          error: error instanceof Error ? error.name : 'unknown',
        });
      }

      let supportDetail: {
        storage: 'cloudflare-d1';
        packages: string;
        probe: 'disabled' | 'ok' | 'fail';
      } = {
        storage: 'cloudflare-d1',
        packages: '@pegma/support-desk-application@0.1.0',
        probe: 'disabled',
      };
      if (supportHealthProbeEnabled(env)) {
        try {
          const identityRuntime = createProductionIdentityRuntime(env, logger);
          const supportRuntime = createProductionSupportRuntime(env, {
            sessions: identityRuntime.sessions,
            identity: identityRuntime.identity,
            identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
            logger,
          });
          const probe = await probeSupportStore(supportRuntime.store);
          supportDetail = {
            ...supportDetail,
            probe: probe.ok ? 'ok' : 'fail',
          };
        } catch {
          supportDetail = { ...supportDetail, probe: 'fail' };
        }
      }

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
          createDetailCheck('supportDesk', supportDetail),
          createDetailCheck('githubReleases', {
            ingestionConfigured: releaseDetail.ingestionConfigured,
            readConfigured: releaseDetail.readConfigured,
            lastSuccessfulWebhookAt: releaseDetail.lastSuccessfulWebhookAt,
            lastSuccessfulReconciliationAt:
              releaseDetail.lastSuccessfulReconciliationAt,
            reconciliationStale: releaseDetail.reconciliationStale,
            currentReleaseCount: releaseDetail.currentReleaseCount,
          }),
        ],
      });
      const { status, body } = toHealthResponse(result);
      return Response.json(body, { status });
    }

    if (path === '/api/releases') {
      const releasesConfig = readReleasesConfig(env);
      if (releasesConfig === null) {
        logger.log('error', 'releases_api.not_configured', {});
        return Response.json(
          { error: 'releases_not_configured' },
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
      try {
        return await handleGetReleases({
          request,
          store: createProductionStore(env),
          logger,
          config: releasesConfig,
        });
      } catch (error) {
        logger.log('error', 'releases_api.unavailable', {
          error: error instanceof Error ? error.name : 'unknown',
        });
        return Response.json(
          { error: 'releases_unavailable' },
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

    if (path === '/api/webhooks/github/releases') {
      const config = readGitHubReleaseWebhookConfig(env);
      if (config === null) {
        logger.log('error', 'github_release_webhook.not_configured', {});
        return Response.json(
          { error: 'webhook_not_configured' },
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
      try {
        return await handleGitHubReleaseWebhook({
          request,
          store: createProductionStore(env),
          logger,
          config,
        });
      } catch (error) {
        logger.log('error', 'github_release_webhook.unavailable', {
          error: error instanceof Error ? error.name : 'unknown',
        });
        return Response.json(
          { error: 'webhook_unavailable' },
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

    if (path === '/api/secure' || path.startsWith('/api/identity/')) {
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

    if (path.startsWith('/api/support/')) {
      try {
        return await createSupportHandler(env, logger).api(request);
      } catch (error) {
        logger.log('error', 'support.runtime_unavailable', {
          error: error instanceof Error ? error.name : 'unknown',
        });
        return Response.json(
          { error: 'support_unavailable' },
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
    controller: ScheduledController,
    env: AppEnv,
    ctx: ExecutionContext,
  ): void {
    const logger = createAppLogger(env, (promise) => ctx.waitUntil(promise));
    // Dispatch by cron expression so six-hour release reconciliation stays
    // independent of one-minute Identity maintenance.
    if (controller.cron === RELEASE_RECONCILIATION_CRON) {
      ctx.waitUntil(
        (async () => {
          try {
            const releasesConfig = readReleasesConfig(env);
            if (releasesConfig === null) {
              logger.log('error', 'release_reconciliation.not_configured', {});
              return;
            }
            await runReleaseReconciliation({
              store: createProductionStore(env),
              logger,
              config: releasesConfig,
            });
          } catch (error) {
            logger.log('error', 'release_reconciliation.unavailable', {
              error: error instanceof Error ? error.name : 'unknown',
            });
          }
        })(),
      );
      return;
    }

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

    ctx.waitUntil(
      (async () => {
        try {
          const identityRuntime = createProductionIdentityRuntime(env, logger);
          const supportRuntime = createProductionSupportRuntime(env, {
            sessions: identityRuntime.sessions,
            identity: identityRuntime.identity,
            identityLinkFromClaims: identityLinkKeyFromVerifiedIdentityClaims,
            logger,
          });
          await runSupportMaintenance(
            {
              store: supportRuntime.store,
              clock: supportRuntime.clock,
              limiters: supportRuntime.limiters,
              terminalRetentionMilliseconds:
                supportRuntime.terminalRetentionMilliseconds,
            },
            logger,
          );
        } catch (error) {
          logger.log('error', 'support.maintenance_unavailable', {
            error: error instanceof Error ? error.name : 'unknown',
          });
        }
      })(),
    );
  },
} satisfies ExportedHandler<AppEnv>;
