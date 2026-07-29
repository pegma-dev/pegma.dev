// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://pegma.dev',
  trailingSlash: 'never',
  // compressHTML eats the newline+indent at text↔inline-tag boundaries, so
  // source like "lives in\n  <a …>catalog.json</a>" rendered as
  // "lives incatalog.json". Serving uncompressed HTML (Cloudflare applies
  // gzip/brotli anyway) fixes the whole class instead of policing every
  // line break next to an <a>/<code>/<strong>.
  compressHTML: false,
  build: {
    // Emit /stack.html rather than /stack/index.html so Pages serves
    // /stack directly — no 308 to a trailing-slash URL, and the served
    // URL matches the canonical (stable-URL pass, site plan Phase 3).
    format: 'file',
  },
});
