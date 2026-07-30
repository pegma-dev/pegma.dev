# Security Scan — pegma.dev

Point-in-time security review per the `security-scan` skill. Date: 2026-07-29.
Read-only review; this report is the only file created.

## Phase 0 — Recon

### Stack

- **Frontend:** Astro 7 static site, built to `dist/`, deployed to Cloudflare
  Pages (`wrangler pages deploy dist`, project `pegma-dev`). Client logic in
  six static scripts under `public/*.js` (account, feedback, staff support,
  stack releases).
- **Backend:** Cloudflare Worker `pegma-dev-api` (TypeScript, `nodejs_compat`),
  routed at `pegma.dev/api/*`. Storage: D1 database `pegma-dev-identity` via
  `@pegma/storage-core` over `@pegma/storage-cloudflare-d1`. Cron triggers:
  1-minute identity/support maintenance, 6-hour GitHub release reconciliation.
- **Toolchain:** Node 22, npm, TypeScript, Vitest, Wrangler 4.

### Trust boundaries

Public HTTP entry points (unauthenticated internet traffic unless noted):

| Entry point | Attacker-controlled input |
| --- | --- |
| Pages static assets (`/*`) | path only |
| `GET /api/health` | none |
| `GET /api/releases` | query params (pagination/filtering) |
| `POST /api/webhooks/github/releases` | body + `X-Hub-Signature-256` (HMAC-verified) |
| `/api/mcp` | JSON-RPC body (stateless catalog MCP) |
| `/api/secure`, `/api/identity/*` | bodies, headers (session cookies), email addresses |
| `/api/support/*` | bodies, headers (session cookies), staff allowlist |
| Cron triggers | not attacker-reachable |

External calls: D1 (`IDENTITY_DB`), GitHub API (release reconciliation),
email providers (Resend / Azure ACS / Cloudflare Email), Datadog logs.

### Scope

- **In scope:** `src/`, `worker/src/`, `worker/migrations/`, `public/`,
  `.github/workflows/`, `astro.config.mjs`, `package.json`, `recipes/`,
  `evals/`, root config files, plus live probing of https://pegma.dev.
- **Excluded:** `node_modules/`, `dist/`, `.astro/`, `.wrangler/`,
  `package-lock.json` (audited via `npm audit` instead), `.claude/worktrees/`
  (vendored copies of this repo), `.grok/`, `brand/` (binary assets).
  `@pegma/*` package internals were read only to verify how this repo's code
  is exercised (query parameterization, ownership enforcement).

## Phase 1 — Mechanized sweeps

| Sweep | Result |
| --- | --- |
| `npm audit` | **0 vulnerabilities** (515 dependencies) |
| DOM XSS sinks (`dangerouslySetInnerHTML`, `set:html`, `innerHTML`, `eval(`, `new Function`, `document.write`) in `src/` and `public/*.js` | **0 hits** |
| Secrets (`AKIA[0-9A-Z]{16}`, `BEGIN … PRIVATE KEY`, hardcoded `password`/`apiKey`/`secret` assignments) | **0 real hits** — only test fixture `'re_test_secret'` in `worker/src/*.test.ts` |
| Shell exec / CORS wildcard / open redirects in `worker/src/` | **0 hits** — `.exec()` matches are `RegExp.exec` for path routing; `releases-api.test.ts:177` asserts `Access-Control-Allow-Origin` is **null** on API responses |
| Raw SQL / string-concatenated queries in `worker/` | **0 hits** — all D1 access via `@pegma/storage-cloudflare-d1` with `.bind()` parameters (verified in package dist); `worker/migrations/0001_pegma_storage.sql` is static DDL with transaction-guard triggers |
| Auth-middleware gaps | Routed by hand in `worker/src/index.ts`; every route verified in Phase 2 |

Leads requiring manual verification all resolved clean or became findings
below. Raw outputs reproduced in the Appendix.

## Phase 2 — Layer-by-layer review

### Frontend (`src/`, `public/*.js`) — clean

- All six client scripts render API data exclusively via `textContent`
  (35 call sites); no `innerHTML`/`outerHTML`/`insertAdjacentHTML`/
  `document.write`/`eval` anywhere — ticket bodies and account data cannot
  become DOM XSS.
- No `localStorage`/`sessionStorage`/`postMessage`. CSRF synchronizer token
  kept in memory only, sent as `X-Pegma-CSRF` with `credentials:
  'same-origin'` (e.g. `public/account.js:29-35`).
- Sign-in uses WebAuthn/passkeys (`navigator.credentials.get/create`) plus
  email codes — no passwords client-side.
- `<script is:inline type="module" src="…">` references external files only;
  CSP `script-src 'self'` is satisfiable and present
  (`public/_headers:4`).
- `catalog.json.ts` is build-time prerendered JSON from the roadmap compiler;
  no request input.

### Backend (`worker/src/`) — 2 Low findings; otherwise strong

Every non-test file reviewed end-to-end. Confirmed clean:

- **Webhook signature** (`github-webhook-signature.ts:18-49`): HMAC-SHA256
  via `crypto.subtle.verify` (constant-time) over exact raw bytes, strict
  `sha256=` prefix + hex/length validation, before any parsing; fail-closed
  when unconfigured (503, never "skipped"). Live probe: unsigned POST →
  `401 invalid_signature`.
- **Webhook payload** (`github-release-webhook.ts`): 1 MiB bounded body,
  GitHub org-ID and repo-ID allowlists (`wrangler.jsonc:18-19`), GUID-format
  delivery ID, repo/tag names regex-constrained before URL construction;
  payload-supplied URLs never fetched.
- **Sessions**: 256-bit `crypto.getRandomValues` tokens; server-side record
  must match embedded subject; issuer/email-verified/active re-checked per
  request; invalid sessions destroyed, not just rejected.
- **CSRF**: `__Host-`-prefixed `Secure; HttpOnly; SameSite=Strict` cookie;
  mutations require `Origin` + `Sec-Fetch-Site: same-origin` + synchronizer
  token compared via SHA-256 constant-time equality.
- **Staff authz**: every `/api/support/admin/*` route calls
  `requireStaffAccess` (`support-access.ts:115-135`) before any application
  call; allowlist from env only; non-staff → 403. Live probe:
  unauthenticated `/api/support/requests` → 404.
- **IDOR**: principals come only from server-side sessions; ticket ownership
  enforced in the application package (verified); non-owned and missing
  tickets share one content-free 404.
- **Injection**: parameterized D1 throughout; ticket IDs charset-bounded
  `[A-Za-z0-9._~-]{1,200}`; mail renderer HTML-escapes user content
  (`resend-mail.ts:102-109`).
- **SSRF**: all outbound URLs are code constants or env-only (GitHub API with
  allowlisted repo IDs, Resend, ACS endpoint validated https/no-credentials,
  `CATALOG_URL`, Datadog intake). Zero request-influenced fetches.
- **Rate limiting**: passkey register 10/5 min, passkey auth 30/5 min,
  email-code request 5/10 min, verify 10/10 min; support create 10/hr, reply
  30/hr per-principal, before any write. Keys are SHA-256 of
  `CF-Connecting-IP` (trustworthy: `workers_dev: false`, route-only).
- **Errors/logging**: stable public error codes; only `error.name` (never
  message/stack) logged from `index.ts`; all 46 log call sites free of
  emails, tokens, session IDs, message bodies.
- **Body limits**: 64 KiB JSON on identity/support, 1 MiB webhook, caps on
  outbound provider responses; streaming readers cancel on overflow.

### Data layer (`worker/migrations/`) — clean

Single migration, static DDL, transaction-guard triggers; deploy pipeline
fail-closed on any unexpected migration change (see CI).

### Config & CI (`.github/workflows/`, `wrangler.jsonc`, `public/_headers`) — 2 Low findings

- `ci.yml`/`deploy.yml`: actions SHA-pinned (`actions/checkout@3d3c42e5…`),
  `permissions: contents: read`, no `pull_request_target`, no untrusted input
  interpolated into `run:` steps, secrets only via `secrets.*` env in the
  deploy step, production migration baseline verified by SHA-256 before
  deploy (`deploy.yml:37-42`).
- `wrangler.jsonc`: no secrets in `vars`; `workers_dev: false`,
  `preview_urls: false`; route-only on the custom domain.
- Real secrets live in `worker/.dev.vars` locally — gitignored
  (`.gitignore:10`); `.dev.vars.example` contains placeholders only.

### Dependencies — clean

`npm audit`: 0 vulnerabilities across 515 dependencies.

## Findings

### [LOW] Missing HTTP Strict-Transport-Security

- **Location:** `public/_headers:1-6` (header absent); confirmed live —
  `curl -I https://pegma.dev/` returns no `Strict-Transport-Security`.
- **Evidence:** response carries CSP, COOP, Permissions-Policy,
  Referrer-Policy, `nosniff` — but no HSTS.
- **Exploitability:** a network attacker could SSL-strip a user's first-ever
  HTTP visit to pegma.dev. No practical exploit against modern
  HTTPS-First browsers; hardening gap only.
- **Confidence:** Confirmed
- **Fix:** add `Strict-Transport-Security: max-age=63072000;
  includeSubDomains; preload` to the `/*` block in `public/_headers`, and
  enable HSTS zone-wide in the Cloudflare dashboard (SSL/TLS → Edge
  Certificates) so it also covers API responses from the Worker.
- **Disposition:** ✅ Resolved 2026-07-29 — added the recommended
  `Strict-Transport-Security` header to the `/*` block in `public/_headers`,
  with `src/security-headers.test.ts` asserting the whole static header set so
  a regression fails CI. `includeSubDomains` is safe today: `www.pegma.dev`
  already serves HTTPS and 301s to the apex. Two operator actions remain
  outside this repository: enabling HSTS zone-wide so Worker `/api/*`
  responses carry it, and submitting the apex to hstspreload.org (the
  `preload` token alone does nothing until then).

### [LOW] `Access-Control-Allow-Origin: *` on static HTML responses

- **Location:** live response header on `https://pegma.dev/` (not present in
  `public/_headers` — added by the static-asset serving layer).
- **Evidence:** `Access-Control-Allow-Origin: *` on the homepage HTML.
- **Exploitability:** allows any origin to read public static pages via
  `fetch` — content that is already public. No credentials are involved
  (session APIs are on `/api/*`, which correctly return **no** ACAO header —
  asserted in `releases-api.test.ts:177`). No practical impact.
- **Confidence:** Confirmed
- **Fix:** optional; if desired, strip the header for HTML responses via a
  Pages `_headers` override or serve static assets through the Worker and
  control headers explicitly.
- **Disposition:** ⚠️ Disputed 2026-07-29 — not a valid finding: the header
  grants cross-origin script read access to bytes that are already served to
  anonymous clients and published from a public repository, so it discloses
  nothing. Nothing on the Pages origin is credentialed, and without
  `Access-Control-Allow-Credentials: true` a browser will not attach the
  `__Host-` session cookie to a cross-origin read regardless of ACAO. The
  credentialed surface is `/api/*` on the Worker, which returns no ACAO
  (asserted in `releases-api.test.ts:177`). The finding's own exploitability
  note and "optional" fix agree there is no impact; changing the header would
  add a Pages override with no security effect.

### [LOW] Public health endpoint discloses versions and ops timing

- **Location:** `worker/src/index.ts:161-192`
- **Evidence:** `createDetailCheck('identity', { … runtime:
  '@pegma/identity@0.1.0', authorizationAdapter:
  '@pegma/authorization-identity@0.1.2' … })`, plus
  `lastSuccessfulWebhookAt`, `lastSuccessfulReconciliationAt`,
  `reconciliationStale`, and `datadog: Boolean(env.DATADOG_API_KEY)` — all
  served unauthenticated at `GET /api/health` (verified live).
- **Exploitability:** any internet client learns exact dependency versions
  (a targeting map for future CVEs), which log sinks are configured, and the
  webhook/reconciliation cadence (useful for timing the replay window in the
  next finding). No secret values exposed — only their presence.
- **Confidence:** Confirmed
- **Fix:** return coarse status (`ok`/`degraded`) publicly and move detail
  behind the staff allowlist, or strip versions/timestamps from the public
  body. If public detail is deliberate for the reference environment,
  document that in the endpoint contract.
- **Disposition:** ⚠️ Disputed 2026-07-29 — not a valid finding: nothing in
  the body is confidential in this repository. The version strings are
  hardcoded literals in `worker/src/index.ts` in a **public** repo whose
  `package.json` pins the same versions (`@pegma/identity` 0.1.0,
  `@pegma/authorization-identity` 0.1.2, `@pegma/sessions` 0.1.0), so the
  endpoint reveals nothing an attacker cannot read from the source — and,
  being literals, it is not even evidence of what is deployed. The site
  publishes those versions on purpose: `GET /api/releases` and the Stack page
  are a deliberate public feed of every `@pegma/*` release. The ops timing is
  likewise already public — `/api/releases` returns the same reconciliation
  instant as `observedAt` (both `2026-07-30T00:00:05.178Z` when probed), and
  the 1-minute/6-hour cron cadence is in the public `worker/wrangler.jsonc`.
  `datadog` and `emailDelivery` are configuration booleans with no secret
  values, and `@pegma/health` defines check detail as "booleans and names,
  never secrets". The finding's own alternative remedy — document the public
  contract — is already met in `worker/README.md`, which specifies the
  `githubReleases` detail fields and the "no secrets, delivery IDs, or
  payloads" rule. Gating this endpoint behind sessions would also add D1 reads
  to a liveness probe, making it fail for exactly the monitors it exists for.

### [LOW] Webhook replay: delivery ID unsigned, no body-hash binding

- **Location:** `worker/src/github-release-webhook.ts:269-341`;
  `worker/src/github-webhook-signature.ts:18-49`
- **Evidence:** the HMAC covers only the raw body; `x-github-delivery` (the
  ledger dedup key) is an unsigned header and there is no freshness check.
- **Exploitability:** an attacker possessing any previously valid signed body
  (requires GitHub org/repo admin or the secret itself) can replay it under a
  fresh delivery GUID, bypassing ledger dedup and re-applying a stale
  projection. Impact bounded: projection ordering rejects strictly older
  upserts, and 6-hour reconciliation force-restores GitHub's authoritative
  state. No signature-bypass path (verification failure → 401 first).
- **Confidence:** Confirmed (gap exists; the strong precondition keeps it Low)
- **Fix:** store a hash of the signed body alongside the ledger entry and
  reject bodies seen under a different delivery ID. (GitHub signs no
  timestamp, so a true freshness window is unavailable; reconciliation
  already bounds worst-case drift.)
- **Disposition:** ✅ Resolved 2026-07-29 — dedup now keys on data the
  signature covers: `worker/src/github-webhook-body-binding.ts` binds the
  SHA-256 of the signed body to the first delivery id that carried it via
  `insertIfAbsent`, and `handleGitHubReleaseWebhook` refuses the same bytes
  under a different delivery id with `409 duplicate_body` before the ledger or
  any projection runs. The claim is race-free rather than a read-then-write
  check, and it is permanent: GitHub keeps one delivery id per event across
  redeliveries, so a retry re-binds and runs while a different id stays
  refused. Covered by
  `worker/src/github-webhook-body-binding.test.ts` plus replay and
  failed-delivery cases in `worker/src/github-release-webhook.test.ts`;
  documented in `worker/README.md`.

## Phase 3 — Summary

| Severity | Count |
| --- | --- |
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 4 |

Dispositions recorded 2026-07-29, one per finding above:

| Finding | Disposition |
| --- | --- |
| Missing HSTS | ✅ Resolved — header added to `public/_headers` |
| ACAO `*` on static HTML | ⚠️ Disputed — public bytes, no credentialed origin |
| Health endpoint detail | ⚠️ Disputed — same facts already public by design |
| Webhook replay binding | ✅ Resolved — signed body bound to its delivery id |

| Layer | Status |
| --- | --- |
| Frontend (`src/`, `public/*.js`) | Clean — no DOM-XSS sinks, memory-only CSRF token, passkey auth, no web storage |
| Backend (`worker/src/`) | 2 Low — strong authz, IDOR, injection, SSRF, rate-limit, logging posture |
| Data layer (`worker/migrations/`) | Clean — static DDL, parameterized access, fail-closed migration baseline |
| Config & CI | 2 Low — SHA-pinned actions, least-privilege permissions, no committed secrets |
| Dependencies | Clean — 0 known vulnerabilities |

### Unverified / Needs Manual Review

- **Email-code verify endpoints open when mail delivery disabled**
  (`worker/src/identity-api.ts:608,648` use `composedEmailRecovery`, not
  `readyEmailRecovery`). Verify endpoints stay reachable while begin
  endpoints fail closed; exploiting requires a valid code handle minted by
  the gated begin endpoints. Likely intentional (in-flight codes survive a
  config toggle); warrants a deliberate decision, not confirmable as a bug.
- **Per-code-handle attempt caps** live inside `@pegma/identity`
  (out of scope). Host wires IP-based limiters (10 verify attempts/10 min)
  against a 10⁸ code space — defense-in-depth question only.
- **`/api/mcp` self-fetch amplification** — each cold isolate fetches the
  site's own `catalog.json` (5-minute cache). Negligible impact
  (CDN-cached static file); no exploit path established.
- **Minimum TLS version of the Cloudflare zone** — could not be verified
  remotely (client TLS stack cannot offer legacy versions). Confirm
  "Minimum TLS Version ≥ 1.2" in the dashboard. TLS 1.2 confirmed working.
- **(Non-security observation)** unknown paths return `200` with the site
  shell HTML instead of `404` (soft-404) — SEO/correctness issue, no
  exposure: probed `/.git/HEAD`, `/.env`, `/wrangler.toml` all return the
  fallback page, not real files.

## Appendix — raw sweep outputs

- `npm audit`: `{ vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0,
  critical: 0, total: 0 } }` (prod 158, dev 357).
- Secret grep (`git grep -iE "(api[_-]?key|secret|token|password|
  private[_-]?key)\s*[:=]\s*['\"][^'\"]{8,}"`): 4 hits, all
  `apiKey: 're_test_secret'` / `resendApiKey: 're_test_secret'` in
  `worker/src/identity-runtime.test.ts` and `worker/src/resend-mail.test.ts`
  — test fixtures, not credentials.
- Live probes (2026-07-29): `GET /` 200 with full security-header set minus
  HSTS; `POST /api/webhooks/github/releases` (no signature) →
  `401 {"error":"invalid_signature"}`; `GET /api/support/requests`
  (unauthenticated) → `404 {"error":"not_found"}`; `GET /api/health` → 200
  with version/timing detail (finding 3); `/.git/HEAD`, `/.env`,
  `/wrangler.toml` → 200 fallback HTML (no file content).
