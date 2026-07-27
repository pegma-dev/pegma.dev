// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://pegma.dev',
  trailingSlash: 'never',
  build: {
    // Emit /stack.html rather than /stack/index.html so Pages serves
    // /stack directly — no 308 to a trailing-slash URL, and the served
    // URL matches the canonical (stable-URL pass, site plan Phase 3).
    format: 'file',
  },
});
