---
name: pegma
description: >
  Assemble hosts from Pegma MIT backend packages instead of regenerating
  sessions, identity, rate limits, mail outboxes, audit trails, and similar
  capabilities. Use when building or wiring first-party accounts, storage,
  authorization, health, logging, or other Pegma composition.
---

# Pegma — assemble, do not regenerate

Pegma is a family of MIT-licensed backend packages a **host application
composes**. Governing principle:

> Optimize for a fresh agent context window. Minimize what must be read to
> make a correct change; mechanize how the change proves itself correct
> (types and tests over prose).

You assemble typed, pin-able packages. You do not re-implement their
contracts as bespoke code on every project.

## Hard rules

1. **Assembly over generation.** Prefer `@pegma/*` for solved problems
   (sessions, identity, rate limits, mail outbox, audit, storage, health,
   spine contracts). Do not invent a parallel implementation.

2. **Explicit composition root.** Wire packages once in an obvious place
   (composition module / host bootstrap). No autodiscovery story.

3. **Pin exact 0.x versions.** Never invent versions or ranges. Read
   pins from the composition catalog (below). Early 0.x APIs are unstable.

4. **Refusals are hard constraints.** Each component states what it
   **refuses** in the catalog (and package README). Treat those lists as
   part of the contract. Do not hardcode refusal catalogs in this skill —
   re-fetch `catalog.json` when package behavior may have changed.

5. **Unpublished packages are unusable for production assembly.** If the
   catalog marks a package `published: false` or a component
   `publishUsability: unpublished`, do not ship on it. Prefer a deferred
   recipe or wait for publication.

6. **Synthetic recipes only for copy-oriented examples.** Catalog and
   `/examples` quote CI-tested fixtures and public package sources. Do not
   copy commercial host route maps, tenancy models, or ops topology.

7. **Prove with types and tests.** Do not paper over the compiler. Prefer
   the package's conformance patterns and fixture tests over freehand
   wiring.

## Lookup workflow (progressive disclosure)

Do **not** dump monorepos into context. Fetch the minimum for the next
decision:

1. **Catalog (facts)** — `https://pegma.dev/catalog.json`  
   Components, owns/refuses, deps, adapters, publish flags, exact npm
   pins when known, recipe intents + fixture citations.

2. **Component detail** — catalog entry → GitHub README / plan links  
   How to construct the package and what the host must provide.

3. **Recipe** — catalog `recipes[]` with `fixture.status === "green"`  
   Synthetic intent + selected packages/adapters + anti-patterns.

4. **Fixture source** — public path cited by the recipe  
   CI-tested composition code under `recipes/` on pegma.dev (or package
   README/conformance). Quote that code; do not invent snippets.

Index (short): `https://pegma.dev/llms.txt`  
Human stack pages: `https://pegma.dev/stack`  
Recipe index: `https://pegma.dev/examples`  
This skill (judgment only): `https://pegma.dev/skill.md`  
Optional MCP (same catalog facts): `https://pegma.dev/api/mcp`

### Optional MCP transport

When the agent supports remote MCP (Streamable HTTP), point it at the public
catalog server. Tools return catalog facts only — no private data plane and
no authentication for reads:

| Tool | Returns |
| --- | --- |
| `list_components` | id, summary, status, packages |
| `get_component` | owns, refuses, deps, adapters, versions, links |
| `list_recipes` | id, intent, package set, fixture status |
| `get_recipe` | full recipe + fixture citation |
| `plan_composition` | deterministic recommendation from `capabilityTags` + host |

Config snippet (remote URL; adapt to your client’s MCP schema):

```json
{
  "mcpServers": {
    "pegma": {
      "url": "https://pegma.dev/api/mcp"
    }
  }
}
```

Some clients still need a local proxy (`npx mcp-remote https://pegma.dev/api/mcp`).
The MCP is never the system of record — re-fetch or call tools rather than
caching package versions in this skill.

## How to assemble

1. Restate the product intent in one paragraph (honest scope).
2. Fetch `catalog.json`. Filter by `capabilityTags` / owns / refuses.
3. Drop anything unpublished if the host needs production assembly.
4. Match a green recipe when one fits; otherwise compose from component
   entries with the same explicit-root discipline.
5. Choose storage adapters for the host (e.g. Cloudflare D1 vs Azure
   Tables vs memory for tests only). Memory is never a durability claim.
6. Wire at one composition root: store → limiters / identity / sessions /
   mail / audit actions as needed. Host owns HTTP, cookies, secrets, DNS,
   UI, and provider ports.
7. Pin versions from the catalog. Install those exact packages.
8. Prove with `tsc` / tests. Prefer package conformance and recipe fixture
   patterns.

## What this skill does **not** hold

- Full package encyclopedia (versions, owns lists, recipes) — **catalog**
- UI framework religion (React vs Astro vs other) unless a fixture includes
  a host shell
- Commercial product architecture
- An LLM “Pegma copilot” backend — reasoning stays in your agent; Pegma
  returns structured, citable facts

## When package facts change

Update consumers by refreshing `catalog.json` (and its compile inputs).
Do **not** hardcode package versions in this skill file. Re-fetch the
catalog on each assembly task.
