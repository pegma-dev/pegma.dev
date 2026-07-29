// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://pegma.dev',
  trailingSlash: 'never',
  // compressHTML removes boundary whitespace around inline elements (e.g. newline+indent between text and <a>), so
  // source like "lives in\n  <a …>catalog.json</a>" can render as "lives incatalog.json".
  // Disabling HTML minification here avoids having to police line breaks next to inline tags;
  // Cloudflare still applies gzip/brotli at the edge.
  compressHTML: false,
  build: {
    // Emit /stack.html rather than /stack/index.html so Pages serves
    // /stack directly — no 308 to a trailing-slash URL, and the served
    // URL matches the canonical (stable-URL pass, site plan Phase 3).
    format: 'file',
  },
});
