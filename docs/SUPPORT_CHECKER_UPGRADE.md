# Preparing the independent checker wire upgrade

The host pins synchronized public Support Desk `0.2.12`, released from
`b41b301c955b1960ca2c6f9d3a186f2c6be28ca2` after strict public registry and
release-artifact verification. The
[public release](https://github.com/pegma-dev/support-desk/releases/tag/v0.2.12)
supersedes the host's `0.2.11` dependency selection. Publication and local tests
do not establish provider quality, deployed Free CPU acceptance or customer
activation.

The producer wire remains `openrouter-support-independent-check-v2`. It places
the current server-configured review policy in the system message while
retaining the complete user envelope as data. The verdict schema remains named
`support_independent_check_v1`; that schema name does not identify the wire.
The host's [checker adapter](../worker/src/support-independent-checks-model.ts)
delegates this contract and the route-policy hash to the SDK.

The normal paid bootstrap also permits one explicit learning/engineering
checker-only tuple:
`openai/gpt-5.4` / `Azure` / `azure` / `max_completion_tokens` with
`providerSelectionScope:'provider_group'`. Route, static checker allowlist and
current Admin approval must independently select that scope. The route must
include a hash-bound `providerMaxPrice` with finite prompt/completion prices in
USD per million tokens and `request:0`; the SDK checks its worst-case token cost
against configured and current total-cost caps. Any change requires current
approval of the new policy hash, not an inferred approval from recomputing it.
The group requires separate current privacy, evaluation and tokenizer evidence;
an earlier exact-region approval does not qualify it or guarantee a region.

GPT-5.4 checks use the static `gpt-tokenizer@4.1.2` `model/gpt-5.4` entry with
request-derived merge caching disabled and special-looking text counted as
ordinary input. Its implementation is loaded only when the profile selects
GPT-5.4; absent, malformed, unknown-model and legacy-mini selections do not
initialize it. This does not establish bundle size or deployed CPU acceptance.
Qualification model/version, framing and evidence dates remain
operator evidence, checked by the SDK. Unknown models refuse before key access
or a provider request. The legacy GPT-4.1-mini checker selection, generation,
customer-answer and release-follow-up generator allowlists remain unchanged.
All host checker consumers receive the shared checker tuple/counter; the
published SDK separately refuses provider groups for release-follow-up checks.
That purpose remains held for a group route rather than inheriting a learning
or engineering approval. No
route, price, approval, credential or feature flag is installed or enabled by
this code change. Customer AI remains off.

Legacy endpoint routing sends `provider.only=[endpointTag]`,
`allow_fallbacks:false`, `zdr:true`, `data_collection:'deny'` and
`require_parameters:true`. The transport regression pins this complete block
of existing routing constraints.

Before enabling a selected checker profile, qualify the actual installed wire
and exact endpoint/model and provider routing block, tokenizer implementation,
complete system and user contents, framing allowance and structured schema.
Both message contents count against byte/input-token admission; input plus reserved output must also fit the
context ceiling. Do not keep a v1 approval or tokenizer evidence, lower counts,
raise budgets, infer approval from a new digest, or relabel old provider results.
The SDK must refuse stale route/tokenizer evidence before credential access.
The host preserves nonpaid Source intake when checker qualification is absent.

The host wrapper regressions check policy placement, unchanged complete outbound
data, full-message byte/token admission and prior-wire refusal. They require
the new public producer behavior and remain unqualified until executed against
the verified public graph. Fictional fixture evidence is never an operator
approval or a successful model-quality evaluation.

After verified public adoption, run the complete normal check, ordinary tests,
all unfiltered Native D1 files, both benchmarks and build on actual Node22 and
Node24. Keep the existing physical D1 meter at 50 calls per invocation and 100
bound parameters per statement, including actual batch calls. Do not substitute
logical call counts or a selected passing case for the complete path. Recheck
provider preparation/check stages, staged review, history, paid-profile
withdrawal and exact acknowledgements using fictional provider responses only.

Native tests measure real local D1 calls, not deployed Free CPU acceptance.
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
currently give Free invocations 10ms CPU; waiting for network or D1 is distinct
from CPU time. The longer trusted system policy adds real encoding/tokenizer
work, so retain a separate current-build cold/warm CPU measurement and quota
acceptance gate. Do not increase CPU/D1 caps or enable customer AI to obtain a
passing qualification. Cloud execution and live provider evaluation remain
separately authorized host operations.

Producer contract:
[AI adapter](https://github.com/pegma-dev/support-desk/blob/b41b301c955b1960ca2c6f9d3a186f2c6be28ca2/packages/ai/README.md),
[upgrade notes](https://github.com/pegma-dev/support-desk/blob/b41b301c955b1960ca2c6f9d3a186f2c6be28ca2/docs/UPGRADING.md).
