# Working in this repository

Read this before changing anything. It is short on purpose.

## What this is part of

This is the public website of **Pegma**, a family of MIT-licensed packages a
host application composes. It is also the ecosystem's second reference
environment: the site deploys to Cloudflare, while the reference application
(retiregolden.org) runs the stack on Azure.

The governing principle, which every rule below follows from:

> **Optimize for a fresh agent context window.** How much must be read to make
> a correct change, and how does the change prove itself correct? Minimize the
> first, mechanize the second.

## Hard rules

**The content rule is absolute.** If a document could not appear on
pegma.dev, it does not enter this repository — no private planning, no
business strategy, no RetireGolden-commercial material, ever. History cannot
be scrubbed; the rule has no exceptions and no "temporary" branch.

**Public copy credits RetireGolden, LLC** — never an individual's name, in
any page, footer, meta tag, or license header.

**The roadmap is compiled, not written.** Component status is pulled at
build time from each repo's PROJECT_PLAN.md. Do not hand-edit roadmap facts
into pages; fix the source repo or fix the compiler.

**Examples come from real code.** Composition examples are imported from
tested files or quoted with a source link. Do not invent example code for a
page — an example that was never executed is documentation that lies.

**Static until the plan says otherwise.** No backend, no state, no accounts
before the environment-test phase (Phase 4). A thin Workers API
(`worker/`, `pegma-dev-api`) may exist for logging and later Pegma
consumers; its storage goes through `@pegma/storage-core` over the D1
adapter — the adapter itself lives in the storage-core repository, not
here.

**Brand assets come from the kit.** Use the vendored assets (marks, lockups,
favicons, social card) with their license notes; do not redraw, restyle, or
generate new brand imagery.

**Nothing that would require a consent banner.** Analytics is Cloudflare Web
Analytics (cookieless) or nothing.

**CI uses SHA-pinned actions**, matching every other Pegma repository.

## Reference points

The plan is `docs/PROJECT_PLAN.md`. The ecosystem's repos (spine,
storage-core, authorization-core, audit, webhooks, sessions, rate-limit,
support-desk, mail, identity, logger-adapters) are the source of truth for
everything the site says about them.
