# Isolated whole-checker CPU fixture

This source harness supports measuring one complete published Support Desk `0.2.13`
checker invocation with the actual pinned `gpt-tokenizer@4.1.2` GPT-5.4 counter.
The [entry](../worker/src/support-checker-cpu-stage-entry.ts) accepts only four
fixed queue selectors. The [runner](../worker/src/support-checker-cpu-stage.ts)
uses the genuine SDK's `resolve`, explicit `withinBudget`, `generate`, transport
validation and parsing. Every token-counter call delegates to the actual
counter. Counts are never memoized, and the workload is never split or shortened.

The [frozen inputs](../worker/src/support-checker-cpu-inputs.ts) preserve the two
fictional known-pair USER byte strings. The genuine SDK reconstructs the captured
v3 SYSTEM message from their common trusted policy. Both original Node captures
had identical request bytes and metrics. No semantic oracle or provider result
is included; the local scripted response uses only `uncertain` and
`not_applicable` verdicts.

| Input       | USER bytes | Complete SYSTEM + USER bytes | Input tokens including framing |
| ----------- | ---------: | ---------------------------: | -----------------------------: |
| normal      |     13,053 |                       24,122 |                          5,271 |
| unsupported |     12,605 |                       23,674 |                          5,177 |

The data module retains full input/SYSTEM/wire hashes. The SYSTEM has 1,849
tokens; framing remains 1,024. Fictional caps remain 32,768 input bytes, 8,192
input tokens, 16,384 context tokens, 8,192 output bytes, 768 output tokens,
15,000 ms duration, 35,200 microUSD ($0.0352) and one attempt. All three group opt-ins and
the hash-bound `max_price` of 2.75/16.5 USD per million tokens, request 0, are
fictional callback data. They grant no operator approval. The fake credential
and provider are in-process only; no environment key, external request, Store,
D1, customer HTTP handler, cron, producer binding or retry is used. Fictional
qualification expires on 2027-01-01; expired evidence holds the fixture.

## Source and resource boundary

The separate [manifest](../worker/wrangler.checker-cpu-stage.jsonc) names
`pegma-dev-support-checker-cpu-stage` and the dedicated
`pegma-support-checker-cpu-stage-wakeup` queue. It has batch size 1 and concurrency 1,
zero retries, no HTTP routes, workers.dev or preview URL, no database/service/
secret/config bindings and no CPU-limit override. Compatibility matches the
current host. It enables complete invocation logs. The production manifest,
existing answering-stage resources, SDK pins and customer AI settings stay as
they are. Normal deployment does not deploy this separate manifest.
The normal `pnpm run check` gate does validate and bundle it through the
binding-free `check:checker-cpu-stage` dry run.

Cloudflare currently documents Queues on Workers Free with 10,000 standard
operations/day and fixed 24-hour retention. Four small messages normally require
12 write/read/delete operations; actual duplicate deliveries and account usage
still count. These are Free-supported queue features. See the current
[Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)
and [Queues limits](https://developers.cloudflare.com/queues/platform/limits/).
Creating resources, deployment, queue publication and observation require a
separate operator execution. This source checkpoint performs none of them.

## Four-delivery protocol

After source inspection, local test qualification and the configured review/CI
gates, an operator may separately qualify the isolated deployment. Bind its
source/tree, lockfile, account, Worker version, queue, effective plan and deployed
consumer settings before sending messages. Set `CLOUDFLARE_ACCOUNT_ID` explicitly
for that isolated account when executing Wrangler; this manifest deliberately
contains no account selection. Do not point the manifest at the
existing production or answering-stage queue. Do not raise a CPU limit.

Send one selector, await its terminal platform invocation record, then proceed:

1. `checker-cpu-v1:normal:first-use`
2. `checker-cpu-v1:normal:warm`
3. `checker-cpu-v1:unsupported:first-use`
4. `checker-cpu-v1:unsupported:warm`

Each is one whole SDK invocation, with at most one in-process provider call.
Each message is acknowledged; the consumer never requests a retry. Malformed,
broker-redelivered (`attempts !== 1`), wrong-queue or multi-message deliveries
refuse model work. Repeating a selector is refused within the same entry/isolate;
a newly published first-use selector can run again after isolate replacement.
A warm selector requires a completed first sample of that input in the same
entry/isolate. A new isolate refuses an unpaired warm selector.

The terminal logs distinguish per-input first-use, the optional counter module's
actual request by this entry, and successful token-count calls. A held delivery
can request the module yet execute no counts; it does not advance the count-use
label. Held records include only a finite fixture reason or `sdk-or-runtime`,
never raw error text. A fresh counter wrapper does not reset tokenizer tables.
On a reused isolate, the second input's first-use sample may already have a
previously requested module. To observe module-first-use for both
inputs, the operator needs a fresh, observed isolate/version for each input
pair while retaining the exact same source and input bytes. Concurrency 1 does
not guarantee isolate reuse. Missing or mismatched samples are inconclusive;
no automatic extra messages, warming calls or cache resets are performed.

## Actual invocation CPU evidence

Capture the terminal Cloudflare invocation event, including its actual queue
trigger, script/version, outcome, correlation identity and CPU field. Workers
Logs exposes `$workers.cpuTimeMs`; the Workers Trace Events dataset exposes
`CPUTimeMs`. The invocation's start/finish fixture markers, isolate ID, input
hashes and observed count sequence must belong to that same platform event
or match its platform request identity. Preserve the raw event and unit.
If CPU data or an unambiguous join is missing, hold the measurement.

Use platform invocation CPU, not elapsed wall time, SDK deadlines, build
`startup_time_ms`, a local timer or aggregate percentiles. The whole fixture's
CPU includes its small diagnostics and in-process response construction; do
not subtract guessed overhead. A start marker alone does not prove completion.
CPU termination may prevent a finish marker; retain the platform outcome.

Identify the effective CPU allowance for the actual trigger and account before
drawing a limit conclusion. The generic Workers table gives Free HTTP requests
and Cron Triggers 10 ms. The Queues page separately says consumer invocations
default to 30 seconds CPU, while describing consumers as sharing Worker CPU
limits. That documentation does not alone resolve the actual Free consumer's
effective allowance. A queue's 15-minute wall limit never establishes its CPU
allowance. Leave that limit unknown until current platform settings/evidence
resolve it. Record the actual deployed host checker's HTTP, scheduled or queue
trigger separately; a passing queue sample does not qualify another trigger.
This fixture declares neither a 10ms failure nor a production architecture
prerequisite.

Primary references:

- [Workers CPU limits and monitoring](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)
- [Queues consumer CPU context](https://developers.cloudflare.com/queues/platform/limits/#increasing-queue-consumer-worker-cpu-limits)
- [Workers invocation telemetry fields](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/)
- [Workers Trace Events CPUTimeMs](https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/account/workers_trace_events/)

Local tests can verify complete wires, repeated actual counts, acknowledgement,
isolate bookkeeping and network refusal. They provide no deployed CPU, model
quality, paid-route approval or customer activation evidence. The complete host
invocation, including its own storage and authorization overhead, retains its
separate qualification gate.
