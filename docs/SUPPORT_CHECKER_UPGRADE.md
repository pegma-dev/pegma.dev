# Preparing the independent checker wire upgrade

The host pins synchronized public Support Desk `0.2.11`, released from
`8f6bc9f033c93dc8166a15c5c214dd4319894c1f` after strict public registry and
release-artifact verification. The
[public release](https://github.com/pegma-dev/support-desk/releases/tag/v0.2.11)
supersedes the host's `0.2.10` dependency selection. Publication and local tests
do not establish provider quality, deployed Free CPU acceptance or customer
activation.

The new producer wire is `openrouter-support-independent-check-v2`. It places
the current server-configured review policy in the system message while
retaining the complete user envelope as data. The verdict schema remains named
`support_independent_check_v1`; that schema name does not identify the wire.
The host's [checker adapter](../worker/src/support-independent-checks-model.ts)
delegates this contract and the route-policy hash to the SDK.

Before enabling a selected checker profile, qualify the actual installed wire
and exact endpoint/model, tokenizer implementation, complete system and user
contents, framing allowance and structured schema. Both message contents count
against byte/input-token admission; input plus reserved output must also fit the
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
[AI adapter](https://github.com/pegma-dev/support-desk/blob/8f6bc9f033c93dc8166a15c5c214dd4319894c1f/packages/ai/README.md),
[upgrade notes](https://github.com/pegma-dev/support-desk/blob/8f6bc9f033c93dc8166a15c5c214dd4319894c1f/docs/UPGRADING.md).
