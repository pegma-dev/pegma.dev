import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['worker/src/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.d1.test.ts'],
    testTimeout: 30_000,
  },
});
