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
- A **Workers API** (`worker/`, script `pegma-dev-api`) that wires
  Spine logging through `@pegma/logger-tee` → Cloudflare Workers Logs +
  Datadog. Workers Logs persistence is enabled via Wrangler
  `observability` (the Cloudflare log store). Datadog ships when
  `DATADOG_API_KEY` is set as a Worker secret.
- The **portability exhibit**: the account API composes
  `@pegma/storage-cloudflare-d1` and exact `@pegma/sessions@0.1.0` today.
  Identity and its Authorization adapter remain fail-closed injected ports
  until their first exact public versions can replace the release boundary in
  `worker/src/identity-runtime.ts`.

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
booleans), returns the shared JSON shape, and emits `health.ok` through the
Pegma adapters with the checks registered today.

`/account` is the static account shell. Its same-origin `/api/identity/*`
contract supports passkey sign-in and enrollment, email-code sign-in through
an injected delivery provider, server-side session revocation, and no-store
account reads. The checked-in Worker does not assume or purchase an email
provider.

## The content rule

This repository is public because everything in it ships to the internet
anyway. The corollary is absolute: **if a document could not appear on
pegma.dev, it does not enter this repository.** Private planning lives
elsewhere, permanently.

## License

Site code: MIT © RetireGolden, LLC. Brand assets carry their own license
notes.
