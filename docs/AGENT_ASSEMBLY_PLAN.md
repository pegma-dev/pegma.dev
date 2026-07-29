# Agent Assembly Plan

## Status

**Stage:** Phase 4 complete (public catalog MCP). Phase 5 (scaffold + eval)
remains open.

This document is the working plan for closing the gap between what AI coding
agents tend to do (regenerate common backend functions as bespoke code) and
what the Pegma stack already packages (typed, tested, pin-able components).

**Phase 0–4 artifacts:**

| Artifact | Path |
| --- | --- |
| TypeScript schema | `src/data/catalog-schema.ts` |
| Schema documentation | `docs/catalog/SCHEMA.md` |
| Registry gap inventory | `docs/catalog/GAP_INVENTORY.md` |
| Prioritized recipe backlog | `docs/catalog/RECIPE_BACKLOG.md` |
| Example catalog (fictional shape sample) | `docs/catalog/example-catalog.json` |
| Catalog compiler | `src/data/compile-catalog.ts` |
| Published catalog | `https://pegma.dev/catalog.json` (build emit) |
| P1 fixture (Northshelf accounts) | `recipes/cf-passkey-accounts/` |
| P2 fixture (Yard Loan outbox) | `recipes/storage-audit-mail-outbox/` |
| Hosted assembly skill (raw) | `https://pegma.dev/skill.md` (`public/skill.md`) |
| Skill install notes | `https://pegma.dev/skill` (`src/pages/skill.astro`) |
| Catalog tool logic | `src/data/mcp-tools.ts` |
| MCP Worker surface | `worker/src/mcp-server.ts` → `https://pegma.dev/api/mcp` |

**Goal:** An agent given a short product description chooses the right
`@pegma/*` packages, respects their refusals, and wires them at an explicit
composition root — instead of burning tokens to re-implement sessions,
identity, rate limits, mail outboxes, audit trails, and similar capabilities
from scratch on every project.

## The problem

Most of what a typical site needs has been built thousands of times:
sessions, audit trails, persistence ports, health probes, structured
logging, rate limits, first-party accounts, transactional mail. Two failure
modes dominate agent-driven builds today:

1. **Regeneration.** The agent writes novel, unverified logic for a solved
   problem — different every run, expensive in tokens, weak on edge cases.
2. **Mis-assembly.** The agent finds Pegma packages but wires them wrong,
   invents magic around them, or ignores stated refusals (passwords in an
   Identity host, durable events on Spine’s in-process bus, a mail package
   that “owns” its own outbox store, and so on).

Pegma’s governing principle already names the remedy: optimize for a fresh
agent context window — minimize what must be read to make a correct change;
mechanize how the change proves itself correct. The stack is built for
**assembly**, not generation. The missing piece is the agent-facing path
from product intent to a correct package set and composition.

This is not a marketing funnel and not a commercial product surface. It is
infrastructure for agents that build with public, MIT-licensed components.

## Audiences

In priority order:

1. **AI coding agents** assembling a host application (Claude, Cursor,
   Codex, Grok Build, OpenCode, and peers).
2. **Humans configuring those agents** (install a skill, point at a
   catalog, paste an MCP config).
3. **Component maintainers** who must keep agent-facing facts true when a
   package ships or a refusal changes.

## Design principles

These constrain every phase below.

1. **Catalog is the source of truth; transports are clients.**  
   A machine-readable composition catalog is compiled and published. HTML
   pages, `llms.txt`, a hosted skill, and an optional MCP server all read
   that catalog (or artifacts generated from it). The MCP is never the
   system of record.

2. **Skill teaches judgment; catalog holds facts.**  
   The skill is small and stable: how Pegma thinks, how to assemble, when
   to look things up, hard rules. Package inventories, versions,
   dependency edges, owns/refuses, and recipes live in the catalog so a
   release does not require every consumer to update a local skill file.

3. **Progressive disclosure.**  
   Tools and docs return the minimum needed for the next decision. No
   “dump the monorepo into the context window” endpoints. List → detail →
   recipe → cited source.

4. **Synthetic recipes, executed for real.**  
   Composition examples must not expose the architecture of production
   web properties (including commercial hosts outside this public
   ecosystem). Recipes are **synthetic on purpose**: purpose-built fixture
   hosts and composition sketches that exist only to teach assembly.

   Honesty still applies. A recipe that never compiled or ran is
   documentation that lies. Synthetic does **not** mean freehand prose.
   Every recipe is owned by a public fixture (package README excerpt,
   conformance test, dedicated recipe package, or scaffold) that CI
   executes. The site and catalog quote or link that fixture; they do not
   invent snippets for the page.

5. **Public reference consumers may prove portability; they are not the
   recipe library.**  
   pegma.dev’s own Worker composition is a second-environment proof and
   may be summarized at a high level (which packages, which adapter). It
   is not a license to publish production route maps, data models, or
   operational topology as “the way to build a site.” Prefer synthetic
   fixtures for anything an agent is expected to copy.

6. **Compile, don’t hand-maintain load-bearing facts.**  
   Status, versions, and dependency edges should be derived from package
   metadata, release projection, and component plans wherever possible —
   the same discipline as the compiled roadmap.

7. **Pin exact 0.x versions; say what is unpublished.**  
   Agents must not compose fiction. Unpublished packages (for example
   Support Desk or Webhooks while they remain so) are marked unusable for
   production assembly until published.

8. **Explicit wiring only.**  
   No autodiscovery story in agent docs. The composition root is the map
   of the system.

## What already exists

Baseline the plan should reuse, not replace:

| Asset | Role today | Gap |
| --- | --- | --- |
| `src/data/components.ts` | Human-facing registry: summary, owns, refuses, packages, status | Not machine-oriented enough (deps, adapters, when-to-use, recipes) |
| Build-time plan aggregation | Roadmap stage from each repo’s `PROJECT_PLAN.md` | Does not emit an agent catalog |
| `public/llms.txt` | Short agent index | Index only; no composition planner |
| `/stack`, `/roadmap`, `/examples` | Human + agent readable surfaces | Examples skeleton; few full recipes |
| Component READMEs + conformance suites | Canonical package truth | Scattered; agents often regenerate instead of reading |
| pegma.dev Worker (Identity composition) | Second-environment proof on Cloudflare/D1 | Not a copy-paste product architecture for agents |
| Ecosystem uniformity (layout, scripts) | One worked shape teaches many repos | No hosted “how to assemble Pegma” skill |

## Target architecture

```text
                    ┌─────────────────────────────────────┐
                    │  Composition catalog (compiled)     │
                    │  components, versions, deps,        │
                    │  owns/refuses, adapters, recipes    │
                    └─────────────────────────────────────┘
                                      │
          ┌───────────────┬───────────┼───────────┬───────────────┐
          ▼               ▼           ▼           ▼               ▼
    pegma.dev/stack   llms.txt   catalog.json   skill.md    MCP tools
    (human pages)    (index)    (HTTP fetch)   (judgment)  (optional)
                                      │
                                      ▼
                         synthetic recipe fixtures
                         (tested in CI, public only)
```

### Catalog (facts)

A versioned, machine-readable document (JSON and optionally a generated
markdown companion) describing:

- Component id, title, repo, npm packages, publish status
- Exact latest published versions when available
- Owns / refuses (load-bearing; refusals are part of the contract)
- Composition dependencies (requires spine, storage-core, …)
- Hosting adapters (e.g. Azure Tables, Cloudflare D1) and when each applies
- Host must provide (cookies, HTTP boundary, secrets, DNS, UI)
- Recipe ids that use the component
- Links to plan, README, npm

### Skill (judgment)

A short, rarely updated markdown skill hosted at a stable public URL and
copy-pasteable into the major coding tools. It teaches:

- Assembly over generation
- Explicit composition root; pin exact versions
- Treat refuses as hard constraints
- Lookup workflow: catalog → component → recipe → fixture source
- How to use the catalog HTTP surface and, if configured, the MCP tools
- Prove with types and tests; do not paper over the compiler

It does **not** embed the full package encyclopedia.

### Recipes (synthetic, tested)

Named composition intents, for example:

- Cloudflare host with first-party passkey accounts and email-code fallback
- Durable rate limits on expensive auth paths
- Transactional mail outbox jobs committed in the caller’s transaction
- Append-only audit records inside the caller’s storage transaction
- Inbound webhook receipt ledger (when `@pegma/webhooks` is published)
- Support queue slice (when Support Desk packages are published)

Each recipe records:

- Intent (one paragraph product shape — synthetic, not a real product)
- Selected packages and pins
- Adapter choices
- Host responsibilities and non-goals
- Wiring sketch **sourced from a CI-tested fixture**
- Anti-patterns the agent must not invent

### MCP (optional transport)

A thin public MCP server in front of the same catalog. Suggested tools
(small payloads only):

| Tool | Returns |
| --- | --- |
| `list_components` | id, summary, status, packages |
| `get_component` | owns, refuses, deps, adapters, versions, links |
| `list_recipes` | id, intent one-liner, package set |
| `get_recipe` | full recipe metadata + fixture citation |
| `plan_composition` | deterministic recommendation from goals + host constraints |

`plan_composition` is rule-based over the catalog (capability tags →
packages → recipes). It is not an LLM hosted inside Pegma. Agents already
have a model; Pegma should return structured, citable facts.

No authentication for public catalog reads. Rate limiting may be added if
abuse appears. Nothing that would require a consent banner.

### Scaffold (recommended third leg)

Even with perfect docs, cold-start assembly is harder than editing a known
good skeleton. A public synthetic starter (for example a minimal Cloudflare
Worker host with a composition root and pinned `@pegma/*` versions) gives
agents something to modify rather than invent. The scaffold is itself a
recipe fixture, not a branded product clone.

## Phased delivery

### Phase 0 — Catalog schema and gap inventory ✓ complete

Define the catalog schema (TypeScript types + example JSON) in this repo or
a small public agent-facing package. Inventory current registry fields vs.
schema. List first synthetic recipe intents that can be backed by already
published packages (spine, storage-core, sessions, identity, mail,
rate-limit, authorization-identity, health, logger adapters, audit).

**Exit:** schema documented; recipe backlog prioritized; no production
architecture disclosure in any recipe intent.

**Done:** schema 0.1.0 in `src/data/catalog-schema.ts` with docs under
`docs/catalog/`; gap inventory maps `PegmaComponent` → catalog fields; recipe
backlog prioritizes P1 `cf-passkey-accounts` and P2 `storage-audit-mail-outbox`
(synthetic intents only); deferred recipes gated on unpublished packages.

### Phase 1 — Compiled catalog artifact ✓ complete

Emit `catalog.json` (and optionally generated markdown) at site build or
from a small compile step fed by the component registry, plan aggregation,
and — where available — release projection / npm version facts.

Publish at a stable URL under pegma.dev (static is enough). Expand
`llms.txt` to point at the catalog and recipe index without pasting the
entire catalog into the index file.

**Exit:** an agent can HTTP-fetch a complete, dated composition catalog;
unpublished packages are explicitly flagged.

**Done:** `src/pages/catalog.json.ts` prerenders `/catalog.json` via
`compileCompositionCatalog` (registry + plan stage + npm latest pins +
enrichment + recipe backlog). `public/llms.txt` links the catalog without
inlining it. Unpublished packages get `published: false` / `publishUsability:
unpublished|partial`.

### Phase 2 — Synthetic recipe fixtures ✓

Create public, CI-tested fixtures for the highest-value published
compositions. Home chosen: `recipes/` in this repository (boring wins over a
second repo until coverage grows).

Rules for fixtures:

- Synthetic product names and domains only
- No routes, schemas, or operational topology copied from commercial hosts
- Must build and test in CI on every relevant change
- Site/catalog may only quote code that exists in those fixtures (or in
  already-public package README/conformance sources)

Shipped:

| Recipe | Path | Catalog fixture |
| --- | --- | --- |
| `cf-passkey-accounts` | `recipes/cf-passkey-accounts/` | green |
| `storage-audit-mail-outbox` | `recipes/storage-audit-mail-outbox/` | green |

P3–P6 remain pending. Deferred D1–D2 still wait on package publication.

**Exit:** catalog recipe entries resolve to green fixtures for P1–P2;
`/examples` indexes those recipes and quotes only fixture (or package
README) sources.

### Phase 3 — Hosted skill ✓

Publish a stable skill document (URL + raw markdown) that encodes assembly
judgment and the lookup workflow. Provide short install notes for common
tools (project rules / skills directories / plugin snippets) without
pretending one universal skill registry exists.

Shipped:

| Surface | Path / URL |
| --- | --- |
| Skill markdown | `public/skill.md` → `https://pegma.dev/skill.md` |
| Install notes | `src/pages/skill.astro` → `https://pegma.dev/skill` |
| Index links | `public/llms.txt`, footer agent links |

The skill teaches judgment only; versions and package sets stay in
`catalog.json`.

**Exit:** a human can add the Pegma skill to a major coding agent in one
sitting; the skill does not hardcode package versions.

### Phase 4 — MCP surface ✓

Implement a thin MCP server over the published catalog. Hosted on the
existing `pegma-dev-api` Worker at `/api/mcp` (stateless Streamable HTTP via
`createMcpHandler`). Tools: list/get components, list/get recipes,
`plan_composition`. Same progressive-disclosure limits as above. Catalog is
fetched from the static `catalog.json` URL — MCP is never the system of
record.

Shipped:

| Surface | Path / URL |
| --- | --- |
| Tool logic (pure) | `src/data/mcp-tools.ts` |
| Catalog fetch + cache | `worker/src/mcp-catalog-fetch.ts` |
| MCP server factory | `worker/src/mcp-server.ts` |
| Endpoint | `https://pegma.dev/api/mcp` |
| Config snippet | `public/skill.md`, `/skill` |

**Exit:** MCP config snippet on pegma.dev; tools return catalog facts only;
no private data plane.

**Done:** public MCP tools over catalog.json; install/config on skill page
and `llms.txt`; `plan_composition` is rule-based over structured
`capabilityTags`.

### Phase 5 — Scaffold and eval harness

Public synthetic starter template with pinned known-good versions and an
empty-ish composition root. Small offline or CI eval set of prompts
(“static brochure site”, “passkey accounts on Workers”, “health endpoint
only”, “do not use passwords”) scored on package selection and refusal
compliance — not on UI polish.

**Exit:** measured improvement when skill + catalog (+ MCP if present) are
enabled vs. baseline agent with only web search.

## Non-goals

- **Documenting or scaffolding commercial product architecture.**  
  Synthetic fixtures only for copy-oriented recipes.
- **Hosting a second full documentation site that forks component READMEs.**  
  Catalog summarizes and links; package repos remain canonical.
- **An LLM-powered “Pegma copilot” backend.**  
  Facts and rules in the catalog; reasoning stays in the user’s agent.
- **Framework religion.**  
  Pegma owns backend composition. Unless a recipe fixture includes a host
  shell, the skill does not dictate React vs. Astro vs. another UI stack.
- **Accounts, personalization, or analytics on the agent surface.**  
  Public static/API facts only; cookieless Cloudflare Web Analytics or
  nothing on pages that need none.
- **Auto-updating every consumer’s local skill on each release.**  
  That is the problem the catalog exists to solve.

## Reconciliation with the examples rule

The repository’s standing rule is that examples come from real executed
code, not invented page-only snippets. This plan keeps that rule and
narrows **which** real code may be used for agent recipes:

| Allowed sources for recipe code | Disallowed |
| --- | --- |
| Public package READMEs | Commercial host internals |
| Conformance tests and public fixtures | Private planning docs |
| Dedicated synthetic recipe packages/apps under pegma-dev | “Representative” rewrites of production systems |
| High-level package lists for pegma.dev’s own public consumer | Route maps, tenancy models, or ops topology of production apps |

Synthetic means **purpose-built and non-product**; executed means **CI
proves it**. Both are required.

## Success criteria

The gap is closed when, for a short honest product description within
Pegma’s scope:

1. The agent selects the correct package set (and skips unpublished ones).
2. The agent respects refusals without being re-prompted.
3. The agent wires components at an explicit composition root with pinned
   versions.
4. Token spend on re-implementing packaged capabilities drops in favor of
   fetch + compose + test.
5. When a package ships or a refusal changes, updating the catalog (or its
   compile inputs) updates every MCP/skill consumer without a skill rewrite.

## Open questions

Phase 0 recommendations (not irreversible) are recorded in
`docs/catalog/GAP_INVENTORY.md` under “Decisions locked for Phase 1 compile.”

- **Catalog compile home:** ~~site build only vs. small shared package~~ →
  **prefer site build first**; extract a package only if MCP cannot fetch the
  static catalog cleanly.
- **Version authority:** ~~registry prose vs Store vs npm~~ → **precedence:**
  release-projection Store when present → npm at compile time → else
  `version: null` / unpublished (never parse versions from `now` prose).
- **Recipe repo layout:** monorepo fixtures vs. one examples repository
  (still open for Phase 2; backlog citations are layout-agnostic).
- **`plan_composition` input shape:** ~~free text vs structured~~ →
  **structured `capabilityTags`** (see schema).
- **Skill packaging:** single canonical markdown vs. thin per-tool wrappers
  that only differ in install paths. (Phase 3)
- **MCP hosting:** ~~extend `pegma-dev-api` vs. separate Worker~~ →
  **extend `pegma-dev-api` at `/api/mcp`** (stateless, public catalog only;
  no new secrets or private data plane).

## Implementation note

When implementation starts, prefer the smallest Phase 0–1 slice that makes
an agent’s first lookup better than today’s `llms.txt` alone. Do not block
the catalog on MCP. Do not block recipes on a perfect scaffold. Do not
weaken the content rule to ship faster: if a document could not appear on
pegma.dev, it does not enter this repository.
