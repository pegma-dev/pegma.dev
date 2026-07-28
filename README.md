# pegma.dev

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

The website for [Pegma](https://pegma.dev): what the stack is, the roadmap
across its components, and usage examples — deployed on **Cloudflare** as
the ecosystem's second reference environment (the reference application,
retiregolden.org, runs the stack on Azure).

> [!IMPORTANT]
> The public site is live at https://pegma.dev. See
> [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) for phases.

## What this repo is

- An **Astro static site** (Cloudflare Pages) presenting the Pegma
  component ecosystem: per-component summaries, a roadmap **compiled at
  build time from each repo's public PROJECT_PLAN.md** so it cannot drift,
  and composition examples lifted from real code.
- A thin **Workers API** (`worker/`, script `pegma-dev-api`) that wires
  Spine logging through `@pegma/logger-tee` → Cloudflare Workers Logs +
  Datadog. Workers Logs persistence is enabled via Wrangler
  `observability` (the Cloudflare log store). Datadog ships when
  `DATADOG_API_KEY` is set as a Worker secret.
- Eventually, the **portability exhibit**: a small real consumer on
  Cloudflare Workers over a `storage-cloudflare-d1` adapter (which will
  live in the storage-core repo and must pass the same conformance suite as
  the Azure adapter).

## Worker logging

```sh
npm ci
npm run worker:deploy
# optional Datadog arm:
npx wrangler secret put DATADOG_API_KEY -c worker/wrangler.jsonc
# optional EU site:
npx wrangler secret put DATADOG_SITE -c worker/wrangler.jsonc
npm run worker:tail
```

`GET /health` on the Worker uses `@pegma/health` (process + logging sink
booleans), returns the shared JSON shape, and emits `health.ok` /
`health.degraded` / `health.failed` through the Pegma adapters.

## The content rule

This repository is public because everything in it ships to the internet
anyway. The corollary is absolute: **if a document could not appear on
pegma.dev, it does not enter this repository.** Private planning lives
elsewhere, permanently.

## License

Site code: MIT © RetireGolden, LLC. Brand assets carry their own license
notes.
