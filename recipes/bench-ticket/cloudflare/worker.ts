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

let cached:
  | {
      readonly key: string;
      readonly composition: ReturnType<typeof createBenchTicketComposition>;
    }
  | undefined;

function compositionCacheKey(env: BenchTicketEnv): string {
  return `${env.BENCH_TICKET_ORIGIN}\n${env.BENCH_TICKET_EMAIL_CODE_SECRET_BASE64}`;
}

function compositionFor(env: BenchTicketEnv) {
  const key = compositionCacheKey(env);
  if (cached && cached.key === key) {
    return cached.composition;
  }
  const composition = createBenchTicketComposition({
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
  cached = { key, composition };
  return composition;
}

export default {
  async fetch(request: Request, env: BenchTicketEnv): Promise<Response> {
    return handleBenchTicketRequest(request, compositionFor(env));
  },
};
