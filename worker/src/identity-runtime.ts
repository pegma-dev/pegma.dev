import { createSessionStore } from '@pegma/sessions';
import { createCloudflareD1Store } from '@pegma/storage-cloudflare-d1';
import type { Logger } from '@pegma/spine';
import { createIdentityApi } from './identity-api';

/**
 * Stable production composition available before the Identity packages ship.
 *
 * D1 and @pegma/sessions are live here. Identity and its authorization
 * adapter are intentionally absent until their exact public releases can be
 * installed. The API advertises that state through /capabilities and fails
 * closed with 503 for identity operations.
 */
export function createProductionIdentityApi(
  env: Pick<Env, 'IDENTITY_DB'>,
  logger: Logger,
): (request: Request) => Promise<Response> {
  const store = createCloudflareD1Store({
    database: env.IDENTITY_DB,
    createSchemaIfMissing: false,
  });
  return createIdentityApi({
    sessions: createSessionStore(store, { logger }),
    logger,
  });
}
