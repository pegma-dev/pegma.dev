# Catalog gap inventory

Compares the human-facing component registry
([`src/data/components.ts`](../../src/data/components.ts)) and related site
surfaces against the composition catalog schema
([`SCHEMA.md`](./SCHEMA.md), [`catalog-schema.ts`](../../src/data/catalog-schema.ts)).

**Date:** 2026-07-28 · **Schema:** 0.1.0 · **Registry snapshot:** 2026-07-28 (`SNAPSHOT_DATE` in `components.ts`)

## Registry fields today (`PegmaComponent`)

| Field | Present | Catalog destination | Gap |
| --- | --- | --- | --- |
| `repo` | yes | `id` + `repo` | No separate stable `id` field (today `repo` is the id) |
| `title` | yes | `title` | — |
| `packages` | yes (`string[]`) | `packages[]` with version/published | No per-package version or publish flag |
| `status` | yes | `status` | Hand-maintained only — **do not trust as sole authority** (see below); also no `publishUsability` aggregate |
| `summary` | yes | `summary` | — |
| `owns` | yes | `owns` | — |
| `refuses` | yes | `refuses` | — |
| `now` | yes | `now` | Not structured; versions embedded in prose |
| `plan` | optional path | `links.plan` | No absolute URL; no README/npm link objects |

## Fields the schema requires that the registry lacks

| Schema field | Why agents need it | Suggested Phase 1 source |
| --- | --- | --- |
| `status` | Lifecycle without registry drift | Prefer mapping from each repo’s `PROJECT_PLAN.md` stage (same discipline as the compiled roadmap); hand registry is fallback only when the plan is unreachable |
| `packages[].version` | Exact 0.x pins | npm / release projection / registry snapshot with precedence |
| `packages[].published` | Skip unpublished packages | npm existence + hand status |
| `publishUsability` | Fast list filter | Derived from package flags |
| `dependencies` | Correct composition order | Hand edges + package peer/optional deps where honest |
| `adapters` | Cloudflare vs Azure vs memory | Hand table per component (storage already known) |
| `hostMustProvide` | Stop agents from assuming the package owns cookies/DNS/UI | Hand list from READMEs / refuses |
| `capabilityTags` | Deterministic `plan_composition` | Hand tags on compile inputs |
| `recipeIds` | Recipe → component index | Recipe backlog + fixtures |
| `links.githubRepo` / `readme` / `npm` | Progressive disclosure | Convention + npm |
| `stage` | Drift-resistant status | Existing plan aggregation (`live-status` path) |
| `recipes[]` | Named intents with fixture citations | Recipe backlog → fixtures (Phase 2) |

## Adjacent surfaces (not the catalog)

| Asset | Role | Gap vs catalog |
| --- | --- | --- |
| `public/llms.txt` | Short agent index | No deps, pins, recipes, or refuses detail; Phase 1 should link to catalog URL only |
| `/stack` | Human component pages | Renders registry + stage; not machine-oriented |
| `/roadmap` | Compiled stage view | Stage only; not composition |
| `/examples` | Skeleton snippets from READMEs | Not recipe-index shaped; no fixture status |
| `worker/src/release-catalog.ts` | Release webhook allowlist / display order | Repo id map only — reuse order, not package facts |
| Component READMEs + conformance | Canonical package truth | Scattered; catalog must summarize and link, not fork |

## Published vs assembly-usable (registry prose, 2026-07-28)

Agents must treat **npm publication** as the production gate. Hand status alone
is insufficient when packages remain unpublished.

| Component | Registry status | Assembly-usable today? | Notes |
| --- | --- | --- | --- |
| spine | published | yes | Pin from registry/npm (e.g. 0.1.1) |
| storage-core | published | yes | Core + azure-tables + cloudflare-d1 |
| authorization-core | published | yes | Multiple `@pegma/authorization-*` packages |
| audit | published | yes | 0.1.0; needs caller storage transaction |
| health | published | yes | |
| sessions | published | yes | |
| mail | published | yes | |
| identity | published | yes | |
| rate-limit | published | yes | |
| logger-adapters | published | yes | |
| support-desk | in development | **no** | Packages unpublished |
| webhooks | in development | **no** | Unpublished (local vendor tarball on this site only) |

## Decisions locked for Phase 1 compile (from open questions)

These are Phase 0 recommendations so Phase 1 does not re-litigate shape:

1. **Compile home:** site build in this repo for the first `catalog.json`
   (static publish). Extract a shared package only if the MCP Worker cannot
   consume the same static URL cleanly.
2. **Version authority (precedence):** release-projection Store facts when
   present → else npm at compile time → else registry `now` parse is
   **forbidden**; leave `version: null` and `published: false` rather than
   guess from prose.
3. **Recipe layout:** backlog lives in `docs/catalog/`; fixtures decide their
   home in Phase 2 (dedicated examples repo vs in-package). Catalog only
   stores citations.
4. **`plan_composition` inputs:** structured `capabilityTags` + host
   constraints — not free-text LLM classification inside Pegma.

## What Phase 0 deliberately does not do

- Emit `catalog.json` or change the site build (Phase 1)
- Add recipe fixture code (Phase 2)
- Publish a skill or MCP tools (Phases 3–4)
- Document commercial host route maps or data models
