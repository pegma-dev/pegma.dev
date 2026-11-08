# Knowledge Base host composition

The host consumes exact published `@pegma/agent-access@0.1.1` and the four
`@pegma/knowledge-base-*` packages at `0.1.2`. It composes the existing
Identity, Sessions, stored roles and D1 Store. The public catalog server at
`/api/mcp` remains separate from protected article authoring.

## Configuration and activation

`worker/wrangler.jsonc` starts with `PEGMA_KNOWLEDGE_ENABLED=false` and
`PEGMA_AGENT_CLIENTS_JSON=[]`. Disabled requests fail before opening Identity
or D1. Empty client configuration disables the OAuth issuer and delegated
transports, while the browser KB composition can still operate independently.

Client configuration is an explicit JSON array of the released `PublicClient`
shape: `clientId`, `name`, `redirectUris`, `allowedScopes`, and `grantTypes`.
The host bounds it to 16 clients and 16 KiB, rejects unknown fields and scopes,
and delegates redirect and OAuth validation to Agent Access. Never infer a
client registration or callback from a synthetic test. Record the actual
requested client, installed version, provider mode, callback and observed flow.
No dynamic registration endpoint or client secret is supplied.

Wrangler owns these plain variables; a deploy replaces dashboard-added plain
variables. Change configuration through review and regenerate Worker types.
The two exact root discovery routes are also part of the checked-in Worker
ingress. No database migration is added: all new collections use the existing
generic Storage Core schema with `createSchemaIfMissing:false`.

Before customer availability, retain actual existing-login/Admin consent,
device-code and PKCE results for the requested clients, scoped API/MCP flows,
revocation and authority failures, and real D1 evidence handling. Keep test
collections closed while completing controlled staff acceptance. Source tests
do not prove installed-client compatibility, production operation or a pilot.

## Browser and agent boundaries

- `/account/agents/device` accepts the human device code. The authorize shell
  displays the exact pending request and requires an explicit decision.
- `/api/agent-access/*` composes released device, authorization, token and
  revocation endpoints plus browser-only consent and known-grant controls.
- `/.well-known/oauth-authorization-server` describes the existing host issuer.
  The protected resource metadata path is
  `/.well-known/oauth-protected-resource/api/knowledge/mcp`.
- `/api/knowledge/mcp` is the single canonical OAuth audience. The versioned
  HTTP endpoint `/api/knowledge/v1` uses that same audience and dispatcher.
- `/staff/knowledge` provides current-permission-gated governance, article,
  report and publication controls. `/knowledge` uses only signed-in published
  article and portal DTOs.

Only a current stored Admin may link an agent. Each bearer use and refresh
rechecks the active account and current role permissions. The initial scopes
are exactly draft read, draft write and evidence submission. They confer no
Admin/Support role, publication, review, collection or governance control, or
private provenance access. Adding future scopes requires explicit configuration
and fresh consent; it cannot silently widen an existing grant.

Browser mutations retain the existing same-origin/session/CSRF boundary.
Protected transports require a header bearer; a browser cookie is insufficient.
Grant controls are owner-only and require a known returned grant ID. Browser
logout revokes its session, not every separately approved agent grant; use the
explicit grant revocation control for that family.

## Staff-confirmed test reports

An agent with evidence-submission scope submits a bounded report through
`/api/knowledge/reports`. It receives only its own acknowledgement and opaque
receipt/status, without staff identities or private report listings. Staff
inspect the report and exact article/check/build bindings through their browser
session. Confirmation is a human review decision, not accepted KB evidence.

The confirmation binds the complete submission, intended submitting principal,
exact draft, report generation and the released validation-requirements DTO.
That DTO includes governance generation, policy, expected staging build and
check freshness. A changed view requires fresh review. Staff do not need
governance mutation authority to confirm a report.

The agent then calls the actual released `submitEvidence` operation with its
receipt. The host rechecks the confirmation and current reviewer authority;
the KB checks trusted attester/runner, exact revision/hash/policy/applicability,
build, result and execution freshness. Confirmation never resets execution
time. Actual evidence revocation is a separate KB command. Article publication
still requires staff approval of the complete current review snapshot.

Reports and KB evidence remain private verification records. The initial host
does not attach reports as private article source references or accept arbitrary
source-reference writes. A future support-ticket integration must compose its
actual source authorization and withdrawal verifier before enabling provenance
writes. Draft changes must not withdraw an otherwise valid earlier publication.

## Operational limits

Distributed protocol, browser and protected-resource admission uses the host's
released durable rate limiter. Report storage has explicit physical capacity
bounds; exhaustion refuses new work. Configure collection governance, trusted
reviewers/runners, retention/deletion procedures and operational monitoring
before enabling a customer cohort. This source slice does not assert those
operator settings have been applied or that retention maintenance has run.

Disable the feature with its host switch if acceptance fails. Existing Identity,
role administration, human Support Desk and public catalog routes continue
through their original composition. No model/provider, automatic knowledge
publication, GitHub export or customer notification is enabled by this slice.
