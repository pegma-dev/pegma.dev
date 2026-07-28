# pegma.dev Project Plan

## Status

**Stage:** LIVE — Phases 1 and 2 complete 2026-07-27. https://pegma.dev
serves the static site from Cloudflare Pages (project `pegma-dev`;
`www` 301s to the apex); push-to-main deploys production via the SHA-pinned
workflow, while PRs validate without receiving production credentials.
**Phase 3 complete 2026-07-27. Phase 4 complete 2026-07-28:** its D1-backed
Identity consumer now
composes the exact public Identity, Authorization adapter, Sessions, Mail,
rate-limit, and storage packages. Worker version
`f627b1ee-7675-47b2-a72b-6b26210f3bb3` is live on `pegma.dev/api/*`; production
health, capabilities, unauthenticated account, and cross-origin rejection
smoke tests pass. Resend email-code delivery was activated on 2026-07-28 after
the sender domain and managed secret were installed; the scheduled durable
outbox delivered its provider smoke test successfully.

**Hosting decision:** Cloudflare (Pages for the static site; Workers when a
dynamic slice exists). Deliberate: the reference application
(retiregolden.org) runs the stack on Azure, and this site is the ecosystem's
**second reference environment** — the proof that Pegma components are
portable in fact, not just in intent.

**Visibility decision (2026-07-27): public.** The repo is the site —
everything in it ships to the internet, so a private repo would protect
nothing while forfeiting source-as-example value and the credibility of an
open-source stack whose own site is open. The concern that the repo might
accumulate non-public planning is handled by policy, not visibility (see the
content rule below).

**License:** MIT (site code). Brand assets carry their own license notes
from the brand kit.

## The content rule

**If a document could not appear on pegma.dev, it does not enter this
repository.** Private planning, business strategy, and anything
RetireGolden-commercial lives in its existing private home
(RetireGolden-Docs), never here. This rule is what makes the public
visibility decision safe permanently — history cannot be scrubbed later, so
the discipline applies from the first commit.

## Vision

pegma.dev is the front door of the ecosystem: the place that explains what
Pegma is, shows what exists and what is coming, and demonstrates how the
pieces snap together. Its audiences, in order:

1. **AI agents building sites for people.** Pegma's governing principle is
   that components are assembled and maintained by agents. The site's
   content is written to be _quoted into a context window_: terse component
   summaries, copy-pasteable wiring examples, stable URLs, and llms.txt.
   An agent that lands here should leave with the right packages and the
   right composition in one read.
2. **Developers evaluating the stack.** What it is, what it refuses to do,
   how honest the components are about their limits — the ecosystem's
   plans-as-published are the differentiator; surface them.
3. **Nobody else.** It is not a blog, not a company site, not a funnel.

And the site is itself an exhibit: the second environment the stack runs in,
with its source public. The most convincing "runs on Cloudflare" doc is this
repository.

## What the site contains

- **Home** — what Pegma is (the πῆγμα framing: a framework fastened
  together), the governing principle, and the honest state of the project
  (early 0.x, packages unstable).
- **The stack** — one page per component (spine, storage-core,
  authorization-core, audit, webhooks, sessions, rate-limit, support-desk),
  each a terse summary: what it owns, what it refuses, current status,
  links to repo/npm/plan. Generated or checked against the repos, not
  hand-maintained (see design decisions).
- **Roadmap** — the aggregate view across component plans: what phase each
  component is in, what gates what. Built from the repos' PROJECT_PLAN.md
  status sections at build time so it cannot drift.
- **Examples** — composition recipes: "a site with accounts," "a support
  queue," "webhook handling done honestly." Code shown is lifted from real
  consumers or conformance tests, never invented for the page.
- **Brand** — the mark, lockups, and usage notes from the brand kit
  (assets vendored from `C:\Users\Nathan\source\repos\pegma\brand`,
  including its license notes).

## Design decisions

### Static-first on Cloudflare Pages

The site's job is served by static output: fast, free-tier friendly, nothing
to operate. Astro, matching retiregolden.org — the one static-site idiom the
ecosystem's agents already maintain in production, which is worth more than
any framework comparison. No backend exists until the environment-test phase
justifies one; a marketing site does not get a database on principle.

### The roadmap is compiled, not written

Component status lives in each repo's PROJECT_PLAN.md — already public,
already maintained, already the source of truth. The site pulls those at
build time (raw.githubusercontent, statically, no runtime calls) and renders
the aggregate. A roadmap page that can drift from the repos would become the
thing Pegma exists to avoid: prose that lies about the code.

### The environment test is real, and it is phased

"Run the stack on Cloudflare" means a storage-core adapter for a Cloudflare
backend plus a small real consumer on Workers. Decisions taken now:

- **Adapter target: D1** (SQLite). Storage-core's port needs conditional
  writes and single-partition transactions; D1's transactional SQL can honor
  the conformance suite. **KV is rejected** — eventually consistent, no CAS,
  cannot pass conformance and must not be bent to pretend. Durable Objects
  are deferred as exotic until D1 proves insufficient.
- **The adapter lives in the storage-core repository** (as
  `packages/storage-cloudflare-d1`), per the ecosystem's adapter convention
  — this site repo only consumes it.
- This deliberately revisits the earlier "Azure Tables first, no backend
  sprawl" stance: the sprawl rule was about not _promising_ many databases;
  one second adapter to prove the conformance suite travels is the point of
  having a conformance suite. Decided 2026-07-27.

### The dynamic slice earns its way in

The first Workers consumer should be small and real. Candidates, in
preference order: (1) the site's contact/support channel as a hosted
**support-desk** instance — which would also hand support-desk, sessions,
and rate-limit their second-environment verdicts in one move; (2) a
rate-limited feedback endpoint (rate-limit + webhooks receipts) if
support-desk is not ready when the phase arrives. What it will not be:
a demo that exists only to exist.

### Public copy credits RetireGolden, LLC

All authorship and copyright in public copy names RetireGolden, LLC — never
an individual. Standing rule across all public properties.

### Analytics, minimally

Cloudflare Web Analytics (cookieless, free) if anything. No consent banner
by construction; nothing that would require one is allowed on.

## Scope

### Non-goals

- **Hosting component documentation.** Each repo's docs are canonical; the
  site summarizes and links (or build-time-pulls), never forks content into
  a second home that can drift.
- **A blog / news feed.** Release notes live with releases.
- **Accounts, personalization, or any state** before the environment-test
  phase — and then only what the test slice needs.
- **Paid anything.** Pegma has no commercial surface; commerce is
  RetireGolden's, elsewhere.

## Delivery phases

### Phase 1 — the static site ✓ (2026-07-27)

Astro scaffold, brand applied (favicons, lockups, social card from the
kit), Home + Stack + Roadmap (hand-written once, honestly marked as
snapshot) + Examples skeleton. Exit: the site builds statically and reads
correctly to both target audiences. **Done:** four pages rendering from a
single dated registry (`src/data/components.ts`, the file Phase 3
replaces); examples lifted from the storage-core and spine READMEs.

### Phase 2 — Cloudflare deployment ✓ (2026-07-27)

Cloudflare Pages project, `pegma.dev` custom domain, GitHub integration or
Actions deploy (SHA-pinned, per ecosystem standard).
Exit: push-to-main publishes; the domain serves the site with an A grade on
the obvious security headers. **Done:** project `pegma-dev`, deploys via
plain `npx wrangler` in the SHA-pinned workflow (the CI token is scoped to
Pages:Edit only — deliberately no Worker, D1, or DNS scope; the custom domain
was attached in the dashboard); security headers served from
`public/_headers`, CSP with same-origin scripts only; `www` 301s to the apex.
The initial D1 migration was operator-applied and production CI pins its exact
hash; a future schema change remains fail-closed until it has a separate
least-privileged D1 credential. Pull requests run the build gate but never
receive the production token; branch previews remain disabled until a
separately scoped preview credential exists.

The Worker is an explicit operator deployment until a second GitHub credential
has least-privileged Worker script plus `pegma.dev` route authority. The broad
local OAuth credential is never copied into GitHub.

### Phase 3 — the compiled roadmap ✓ (2026-07-27)

Build-time aggregation of component PROJECT_PLAN.md statuses into the
roadmap and per-component pages; llms.txt and stable-URL pass. Exit: a
component phase change appears on the site at next build with zero site-repo
edits. **Done:** `src/data/live-status.ts` fetches each plan's Status stage
line at build (fail-soft to the dated registry snapshot; six of eight
components carry plans), a weekly scheduled rebuild plus workflow_dispatch
keeps builds fresh without site commits, `/llms.txt` is live, and the build
emits file-format output so extensionless URLs serve 200 with no
trailing-slash redirect. Verified live: the roadmap shows plan text the
registry never contained.

### Phase 4 — the environment test ✓ (2026-07-28)

`packages/storage-cloudflare-d1` in the storage-core repo, passing the full
conformance suite against real D1 (Miniflare/wrangler in CI). Then the
dynamic slice on Workers consuming it. Exit: the conformance suite green on
a second real backend, and one production Pegma consumer running outside
Azure.

**Identity consumer composed (2026-07-28):** the Worker now pins
`@pegma/identity@0.1.0`, `@pegma/authorization-identity@0.1.2`,
`@pegma/sessions@0.1.0`, `@pegma/mail@0.1.0`,
`@pegma/rate-limit@0.1.0`, and the D1/storage `0.4.0` packages. It exposes a
secure account API/browser boundary for issuer `https://pegma.dev` and RP ID
`pegma.dev`, uses four durable abuse limits, and schedules cursor-persisted
maintenance. Its generic `GET /api/secure` proof resolves the opaque cookie
through Sessions and revalidates the Identity/Authorization claims before
returning the issuer and subject. Email jobs commit atomically in Identity
storage; a fail-closed
Resend adapter provides idempotent send and reconciliation. The free-tier
provider account, verified sender domain, managed secrets, activation gate,
and provider delivery smoke test were completed on 2026-07-28. No paid email
service is assumed.

**Logging precursor (2026-07-27):** Worker `pegma-dev-api` is deployed with
`@pegma/logger-tee` → `@pegma/logger-cloudflare` + `@pegma/logger-datadog`.
Workers Logs (Cloudflare’s log store) is enabled via Wrangler
`observability.logs`. Datadog is optional until `DATADOG_API_KEY` is set.
The Phase 4 account consumer now uses the published D1 adapter, Sessions,
Identity, and Authorization adapter; its Resend email-code entry points are
live behind their fail-closed capability checks.

### Phase 5 — dogfood support

If Phase 4's slice was not support-desk: revisit hosting the site's contact
channel as a support-desk instance once support-desk reaches its
deployable phase. Exit: pegma.dev's "contact" is a Pegma component in
production.

## Open questions

**Pages vs. Workers-serving-static.** Pages is simpler today; Cloudflare is
converging the two. Decide at Phase 2 by whatever is boring and documented
that week; the site must not care.

**How much D1 shows through.** The adapter maps a partitioned KV-ish port
onto SQLite; whether partition scans become SQL queries with real indexes
(faster than the Azure adapter's honest scans) is an adapter-internal fact —
but if it changes practical scale envelopes (sessions' "thousands not
millions"), the component docs sharpen, not the port.

**Examples freshness.** Lifted-from-real-code examples can still rot. Lean:
examples are imported from tested files at build time where possible, quoted
with a source link where not. Decide in Phase 3.

## Near-term backlog

1. Complete independent review and local/remote D1 tests for the exact
   Identity composition. **Done 2026-07-28.**
2. Configure the Resend free-tier account, verify the `pegma.dev` sender,
   install its managed provider secret, and smoke-test idempotent delivery
   behind an authenticated, audited terminal-mail acknowledgement workflow
   before enabling email-code entry points. **Done 2026-07-28:** the stable
   HMAC and provider secrets are in Cloudflare's managed secret store, live
   health and capabilities expose delivery, and Resend reported the scheduled
   durable-outbox test message as delivered.
3. Route same-origin `/api/*` traffic to `pegma-dev-api`, deploy, and verify the
   D1-backed account flow without changing the Pages-hosted static architecture.
   **Done 2026-07-28, including email activation.**
