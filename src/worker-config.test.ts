import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { unstable_readConfig } from 'wrangler';

it('keeps request query redaction enabled in the normalized deployment config', () => {
  const config = unstable_readConfig({
    config: fileURLToPath(new URL('../worker/wrangler.jsonc', import.meta.url)),
  });

  expect(config.observability?.redact_query_string).toBe(true);
});
