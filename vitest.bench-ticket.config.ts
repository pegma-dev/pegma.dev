import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/** Same pool as `vitest.d1.config.ts`, pointed at the Bench Ticket Worker. */
const TEST_SECRET = btoa(String.fromCharCode(...new Uint8Array(32).fill(11)));

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './recipes/bench-ticket/cloudflare/wrangler.jsonc' },
      miniflare: {
        bindings: {
          BENCH_TICKET_EMAIL_CODE_SECRET_BASE64: TEST_SECRET,
          BENCH_TICKET_ORIGIN: 'https://bench-ticket.example.workers.dev',
        },
      },
    }),
  ],
  test: {
    include: ['recipes/bench-ticket/cloudflare/**/*.d1.test.ts'],
    testTimeout: 30_000,
  },
});
