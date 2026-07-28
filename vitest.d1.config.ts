import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './worker/wrangler.jsonc' },
      miniflare: {
        bindings: {
          IDENTITY_EMAIL_FROM: 'Pegma <identity@pegma.dev>',
          IDENTITY_EMAIL_ENABLED: 'false',
        },
      },
    }),
  ],
  test: {
    include: ['worker/src/**/*.d1.test.ts'],
    testTimeout: 30_000,
  },
});
