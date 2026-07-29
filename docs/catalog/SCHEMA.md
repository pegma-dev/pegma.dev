# Composition catalog schema

Machine-readable facts for agents assembling hosts from `@pegma/*` packages.
This document describes schema **0.1.0** (`CATALOG_SCHEMA_VERSION` in
`src/data/catalog-schema.ts`).

**Status:** Phase 0 — types and documentation only. Phase 1 emits
`catalog.json` at a stable URL. HTML pages, `llms.txt`, the hosted skill, and
any MCP tools are clients of this catalog (or of artifacts generated from it).

## Design constraints

| Rule | Implication |
| --- | --- |
| Catalog is source of truth | Transports do not invent package facts |
| Progressive disclosure | Prefer small list payloads; detail and recipes on demand |
| Exact 0.x pins | `version` is a concrete string or `null` — never a range guess |
| Unpublished is explicit | `published: false` / `publishUsability: "unpublished"` |
| Synthetic recipes | Intents describe purpose-built fixtures, not commercial products |
| Executed examples | Wiring code only when `fixture.status` is `green` and cited |

## Document shape

```text
CompositionCatalog
├── schemaVersion, generatedAt, snapshotDate?
├── components[]  → CatalogComponent
└── recipes[]     → CatalogRecipe
```

### `CompositionCatalog`

| Field | Type | Notes |
| --- | --- | --- |
| `schemaVersion` | string | Catalog schema id (`0.1.0`), not a package version |
| `generatedAt` | string | ISO-8601 compile time |
| `snapshotDate` | string? | Hand registry snapshot date when that is an input |
| `components` | `CatalogComponent[]` | Full component set |
| `recipes` | `CatalogRecipe[]` | Composition intents (may be empty until Phase 2) |

### `CatalogComponent`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Stable; usually GitHub repo short name (`spine`, `identity`) |
| `title` | string | Human title |
| `repo` | string | Repo name under `github.com/pegma-dev` |
| `packages` | `CatalogPackage[]` | npm packages with publish flags and pins |
| `status` | enum | `published` \| `in_development` \| `planned` |
| `publishUsability` | enum | `usable` \| `unpublished` \| `partial` |
| `summary` | string | One-line role |
| `owns` | string[] | Load-bearing responsibilities |
| `refuses` | string[] | Hard constraints — part of the contract |
| `dependencies` | `CatalogDependency[]` | Edges to other component ids |
| `adapters` | `CatalogAdapter[]` | Hosting choices (`cloudflare-d1`, `azure-tables`, …) |
| `hostMustProvide` | string[] | Cookies, HTTP boundary, secrets, DNS, UI, … |
| `capabilityTags` | `CapabilityTag[]` | Structured tags for deterministic planning |
| `recipeIds` | string[] | Recipes that include this component |
| `links` | object | `githubRepo` required; plan/readme/npm optional |
| `now` | string? | Plain-language snapshot from the hand registry |
| `stage` | string? | Compiled stage from `PROJECT_PLAN.md` (Phase 1) |

### `CatalogPackage`

| Field | Type | Notes |
| --- | --- | --- |
| `name` | string | e.g. `@pegma/spine` |
| `version` | string \| null | Exact pin or null if unknown/unpublished |
| `published` | boolean | Production-assembly gate |
| `npmUrl` | string? | Package page when published |

### `CatalogDependency`

| Field | Type | Notes |
| --- | --- | --- |
| `componentId` | string | Target `CatalogComponent.id` |
| `kind` | enum | `requires` \| `optional` \| `composes_with` |
| `note` | string? | Short agent hint |

### `CatalogAdapter`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Stable within the component |
| `packageName` | string? | Implementing package |
| `host` | enum | `cloudflare` \| `azure` \| `memory` \| `other` |
| `when` | string | When to choose this adapter |

### `CatalogRecipe`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Stable recipe id |
| `intent` | string | Synthetic product shape (one paragraph) |
| `packages` | string[] | Package names, optionally pinned as `name@version` |
| `adapters` | `{ componentId, adapterId }[]` | Component-scoped adapter selections |
| `hostResponsibilities` | string[] | Host-owned work |
| `nonGoals` | string[] | Out of scope for the recipe |
| `antiPatterns` | string[] | What not to invent |
| `fixture` | object | Citation + kind + status |
| `capabilityTags` | `CapabilityTag[]` | Overlap with component tags for planning |
| `requiresPublished` | string[] | Component ids that must be usable |
| `backlogPriority` | number? | Phase 0 ordering only (1 = first) |

### `RecipeFixtureCitation`

| Field | Type | Notes |
| --- | --- | --- |
| `kind` | enum | `package_readme` \| `conformance` \| `recipe_package` \| `scaffold` \| `pending` |
| `citation` | string | Public URL or path |
| `status` | enum | `green` \| `pending` \| `none` |

## Capability tags

Structured flags (not free text) so `plan_composition` can stay rule-based:

`accounts`, `passkeys`, `email_codes`, `sessions`, `authorization`, `storage`,
`storage_blobs`, `audit`, `mail_transactional`, `rate_limit_durable`,
`rate_limit_memory`, `webhooks_inbound`, `support_queue`, `health`, `logging`,
`events_in_process`, `cloudflare`, `azure`, `static_host`.

## TypeScript source

Canonical types: [`src/data/catalog-schema.ts`](../../src/data/catalog-schema.ts).

Illustrative (non-authoritative) document:
[`example-catalog.json`](./example-catalog.json) — **fictional** component ids and
packages for shape checking only (not Pegma lifecycle facts). Phase 1 emits a
compiled catalog from plans + version authority; do not treat this sample as
roadmap truth.

## Gap inventory and recipes

- Field-by-field registry comparison: [`GAP_INVENTORY.md`](./GAP_INVENTORY.md)
- Prioritized synthetic recipe backlog: [`RECIPE_BACKLOG.md`](./RECIPE_BACKLOG.md)
