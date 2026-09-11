/**
 * Cloudflare Worker host for Bench Ticket.
 * Record store: `@pegma/storage-cloudflare-d1`. Mail: console catcher.
 *
 * Requires the storage-core D1 adapter (already published). Blobs: create an
 * R2 bucket in the runbook even though this demo does not store attachments.
 */
import {
  createCloudflareD1Store,
  type CloudflareD1Database,
} from '@pegma/storage-cloudflare-d1';
import {
  createBenchTicketComposition,
  createBenchTicketMailRenderer,
} from '../composition';
import { handleBenchTicketRequest } from '../handler';
import {
  createCatcherReconciliation,
  createConsoleMailProvider,
} from '../mail-catcher';

export interface BenchTicketEnv {
  readonly BENCH_TICKET_DB: CloudflareD1Database;
  readonly BENCH_TICKET_EMAIL_CODE_SECRET_BASE64: string;
  readonly BENCH_TICKET_ORIGIN: string;
}

let cached: ReturnType<typeof createBenchTicketComposition> | undefined;
let cachedOrigin: string | undefined;

function compositionFor(env: BenchTicketEnv) {
  if (cached && cachedOrigin === env.BENCH_TICKET_ORIGIN) {
    return cached;
  }
  cachedOrigin = env.BENCH_TICKET_ORIGIN;
  cached = createBenchTicketComposition({
    store: createCloudflareD1Store({
      database: env.BENCH_TICKET_DB,
      createSchemaIfMissing: true,
    }),
    origin: env.BENCH_TICKET_ORIGIN,
    emailCodeSecretBase64: env.BENCH_TICKET_EMAIL_CODE_SECRET_BASE64,
    mailDelivery: {
      provider: createConsoleMailProvider(),
      reconciliation: createCatcherReconciliation(),
      renderer: createBenchTicketMailRenderer(),
    },
  });
  return cached;
}

export default {
  async fetch(request: Request, env: BenchTicketEnv): Promise<Response> {
    return handleBenchTicketRequest(request, compositionFor(env));
  },
};
