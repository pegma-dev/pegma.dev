# Isolated support answering stage

This developer harness runs a fictional support conversation against native D1
through the published Support Desk and Knowledge Base applications. Its model
and provider receipts are scripted local ports. It exercises durable answering,
current Identity and role checks, approved KB retrieval, usage accounting, and
queue redelivery without making an external model request.

The standalone [configuration](../worker/wrangler.assistant-stage.jsonc) uses
`pegma-dev-support-assistant-stage`, a separate D1 database, and the
`pegma-support-assistant-stage-wakeup` queue. At creation on 2026-11-11 UTC,
the database had zero tables, no Worker was deployed, no schema was applied,
and no messages were enqueued. The checked-in config remains disabled:
`PEGMA_SUPPORT_ASSISTANT_STAGE_ENABLED` is `false`, the scenario is empty,
HTTP routes and cron triggers are empty, and workers.dev and preview URLs
are disabled.

## Source boundary

The [entry](../worker/src/support-assistant-stage-entry.ts) exports a queue
handler over the isolated database and scripted model. The production site retains
its existing dispatcher. The queue adapter enforces the strict stage flags on
each delivery. The standalone configuration registers the queue handler.

Each admitted delivery builds a fresh
[runtime](../worker/src/support-assistant-stage-scenario.ts) over the isolated
Store. The only accepted message body is the string `wake-v1`. It contains no
ticket ID, record cursor, customer content, or authority. Each invocation must
rediscover current SDK work and recheck the current verified principal, audited
roles, audience policy, source publication and applicability.

The [queue adapter](../worker/src/support-assistant-stage-queue.ts) runs at most
one physical SDK tick per delivery. A conditional checkpoint update holds the
original cursor while processing is in progress. Its scheduling hint covers the
bounded tick and SDK claim window. Successful preparation refines that hint to
the actual next-attempt time. Early duplicates defer at the retained cursor,
then rediscover the current SDK work in a later invocation.

Unavailable ticks, failed checkpoint writes and filtered scan pages request
bounded retries. Explicitly pending SDK work stops for inspection and manual
redrive. The adapter limits one wakeup to eight deliveries within a
fifteen-minute application window. SDK receipts and the durable usage ledger
deduplicate paid attempts across interrupted deliveries.

Those application bounds are independent of broker retention. Cloudflare
currently documents fixed 24-hour queue retention on Workers Free; configurable
retention depends on the plan. The account plan and effective retention must be
checked during cloud qualification. See
[Queues limits](https://developers.cloudflare.com/queues/platform/limits/).

## Run the local checks

Use the repository's supported Node version and frozen dependency install.
The current package selection is Support Desk `0.2.13` with direct Knowledge Base
`0.1.8`; [package.json](../package.json) and the
[lockfile](../pnpm-lock.yaml) are authoritative.

From the repository root:

```sh
pnpm run check
pnpm exec vitest run --config vitest.config.ts worker/src/support-assistant-usage.test.ts worker/src/support-assistant-stage-launcher.test.ts
pnpm exec vitest run --config vitest.d1.config.ts worker/src/support-assistant-stage-entry.d1.test.ts worker/src/support-assistant-stage-recovery.d1.test.ts
```

The normal `check` command runs `check:assistant-stage` to type-check the
launcher through a [tracked project](../scripts/tsconfig.support-assistant-stage.json)
and runs Wrangler's standalone-config deploy dry run. The dry run bundles the
queue entry into the ignored `.wrangler/assistant-stage-dry-run` directory.
The normal Node test suite also runs the
[local launcher smoke test](../worker/src/support-assistant-stage-launcher.test.ts),
which generates an actual SDK seed in a fresh temporary directory, checks its
persisted artifacts, and verifies that repeating the launcher refuses to
replace them.

The [Native D1 tests](../worker/src/support-assistant-stage-entry.d1.test.ts)
invoke the actual entry, SDK seeder, Identity, audited RoleStore, KB, Support
application, usage ledger and Cloudflare test-pool queue messages. Setup and
assertion reads occur outside the measured queue invocation. Every runtime D1
execution uses the [meter](../worker/src/support-assistant-stage-budget.ts),
which blocks physical call 51 and parameter 101 before execution or binding.
Batches retain their actual statement count; the physical-call metric counts a
native batch invocation once.

At the earlier checkpoint, 35 entry and recovery cases passed against the
then-selected `0.2.3` packages
on Node 22.18.0. Recovery profiles recorded 31 physical D1 calls for preparation
and 50 for answering, with zero blocked calls. Preparation made zero model or
reservation calls. Answering used one model call, one reservation and one
reconciliation, with the persisted ledger stable across later duplicates.
These historical results apply to that fictional fixture. The earlier public
`0.2.5` graph passed the normal 1,125-test local/CI
[adoption checkpoint](KNOWLEDGE_COMPOSITION.md#public-025-adoption-checkpoint).
That checkpoint does not qualify the current `0.2.13` graph. Current host
validation remains pending. Deployed broker timing, retry delivery, CPU use and
wider workloads retain their qualification gates.

## Generate a fictional seed locally

The [launcher](../scripts/seed-support-assistant-stage.mts) creates a new local
directory exclusively, disables remote bindings and environment-file loading,
applies the exact hash-checked migration to local D1, then calls the actual
[SDK seeder](../worker/src/support-assistant-stage-seed.ts). It refuses an
existing output directory or a populated seed database. Partial output remains
available for inspection after a failure.

For example, in PowerShell from the repository root:

```powershell
$stageSeed = Join-Path ([System.IO.Path]::GetTempPath()) ("pegma-support-stage-" + [guid]::NewGuid())
pnpm exec tsx scripts/seed-support-assistant-stage.mts --output-dir $stageSeed
```

The output contains `wrangler.seed.json`, local D1 persistence under
`.wrangler/state/v3`, `scenario.json`, and `seed-result.json`. The scenario is
valid for one hour from creation. The SDK seeder creates verified fictional
principals and audited roles, a tested and approved fictional article, its
retrieval index, and one assistant-managed ticket. It creates no browser session
or Agent grant. Principals, email addresses, product data and provider data are
fictional. The isolated database reuses the host's `https://pegma.dev` issuer
and `pegma.dev` RP identifiers so the actual principal resolver can validate
the seeded claims. The harness exposes no sign-in or HTTP surface.

## Complete the cloud measurement

After the source review and CI gates, deploy the standalone config with its
flag still false. Verify its deployed bindings point to the isolated database
and queue and that no HTTP ingress or cron trigger was added. The checked-in
config has no provider secret, producer binding or `cpu_ms` override.

Use authenticated operator access for the cloud steps. An existing authorized
Wrangler OAuth login can perform the D1 import; the normal repository checks
need no cloud-write credentials. The repository's deployment workflow does not
perform the import or publish the wake message. For API-token access, remote
import needs D1 write authority in the target account; message publication
accepts `Queues Write` or `Workers Scripts Write`. Use the narrow account and
resource restrictions supported by the chosen authentication method and verify
the target database and queue before each write. See the
[D1 API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/)
and [Queue Push API](https://developers.cloudflare.com/api/resources/queues/subresources/messages/methods/push/).

Generate a fresh seed window and inspect its local output. Transfer only that
fictional local database into the empty isolated D1 database using a verified
local export. From the repository root, with `$stageSeed` pointing at the fresh
launcher output, export the generated configuration's local database:

```powershell
pnpm exec wrangler d1 export pegma-local-support-assistant-seed --local --config "$stageSeed/wrangler.seed.json" --output "$stageSeed/seed.sql"
```

Inspect the export and confirm its two tables and 90 fictional records. After
the source review and CI gates, import that SQL into the isolated remote target:

```powershell
pnpm exec wrangler d1 execute pegma-dev-support-assistant-stage --remote --config worker/wrangler.assistant-stage.jsonc --file "$stageSeed/seed.sql"
```

The export includes the reviewed schema. Remote import and its readback are
pending cloud qualification. The launcher performs local writes. See the
[D1 import/export documentation](https://developers.cloudflare.com/d1/best-practices/import-export-data/).

Set the exact generated scenario and the explicit stage flag for this isolated
Worker, then send one `wake-v1` string through the authenticated Cloudflare
Dashboard or the documented Queue Push API. The installed Wrangler CLI has no
queue-message send command. Retain actual deployment identity, broker message
attempts, requested and observed retry timing, coarse stage profiles, final ticket state and usage
ledger evidence. Verify preparation records zero model and reservation calls;
the reconstructed answer occurs once; later duplicate deliveries make no new
answer or spend. Capture the broker interruption and disabled-stage cases too.
Return the stage flag to false after the bounded measurement.

Logs contain outcome, queue disposition, counters and elapsed wall time. They
exclude source bodies, record IDs, cursors, credentials and raw errors.
Capture CPU consumption separately from elapsed wall time. Confirm the account's
effective plan and deployed CPU measurements against
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
before treating this as Workers Free acceptance. External model use, customer
chat and production rollout retain their respective qualification gates.
