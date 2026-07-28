# pegma-dev-api Worker

Cloudflare Worker composition root for pegma.dev. It preserves the existing
Pegma logging composition and public health endpoint:

```ts
createTeeLogger(createCloudflareLogger(), createDatadogLogger(submit));
```

## Cloudflare log store

Workers Logs is enabled in `wrangler.jsonc` via:

```jsonc
"observability": {
  "enabled": true,
  "logs": { "enabled": true, "persist": true }
}
```

Redeploy with `npm run worker:deploy`. Query logs in the dashboard under
Workers → `pegma-dev-api` → Observability, or `npm run worker:tail`.

## Datadog arm

Optional. Without `DATADOG_API_KEY`, only the Cloudflare sink runs.

```sh
npx wrangler secret put DATADOG_API_KEY -c worker/wrangler.jsonc
# optional site host (bare domain only; default is us5.datadoghq.com):
npx wrangler secret put DATADOG_SITE -c worker/wrangler.jsonc
# value: us5.datadoghq.com   (or datadoghq.eu — not a full URL)
```

CI deploys this Worker with the same `CLOUDFLARE_API_TOKEN` as Pages; that
token needs **Workers:Edit** and **D1:Edit** in addition to **Pages:Edit**.

## Identity composition

The account boundary is fixed to issuer `https://pegma.dev` and WebAuthn RP ID
`pegma.dev`. Cloudflare D1 is consumed only through
`@pegma/storage-cloudflare-d1`; `@pegma/sessions@0.1.0` stores SHA-256-hashed
opaque session identifiers. The browser receives a cryptographically random
`__Host-pegma_session` cookie with `Secure`, `HttpOnly`, `SameSite=Strict`, and
`Path=/`.

Every Identity response is `no-store`. Browser mutations require the exact
production origin and same-origin Fetch Metadata. Authenticated mutations also
require a per-session synchronizer token. Request bodies are bounded before
JSON parsing, and logs contain route/error classifications rather than contact
data, credentials, codes, or session identifiers.

The production composition pins `@pegma/identity@0.1.0` and
`@pegma/authorization-identity@0.1.2`. Account creation and fallback sign-in
commit the email-code operation and its `@pegma/mail@0.1.0` job atomically in
Identity's D1 collection. Start routes never receive or return the generated
code; verify routes accept the user-supplied eight digits, and only the
scheduled renderer recovers the stored protected material for delivery.

Delivery uses a host-owned Resend adapter because its API accepts the Mail
job's mandatory idempotency key and supports authoritative status retrieval
for reconciliation. The adapter has a ten-second timeout and bounds provider
responses before parsing. Email-code capability and passkey removal fail
closed unless a key is present and `IDENTITY_EMAIL_ENABLED` is explicitly
`true`. Cloudflare Email Sending is not used: it requires Workers Paid and
does not document the idempotent submission/reconciliation contract required
here.

Set the stable email-code HMAC secret and optional Resend credential
interactively; never commit either value:

```sh
npx wrangler secret put IDENTITY_EMAIL_CODE_SECRET_BASE64 -c worker/wrangler.jsonc
npx wrangler secret put RESEND_API_KEY -c worker/wrangler.jsonc
```

The first value is canonical base64 for 32–128 cryptographically random bytes
and must remain stable while any email-code or Mail job is live. Verify the
`pegma.dev` sender domain and smoke-test delivery before changing
`IDENTITY_EMAIL_ENABLED` to `true`.

The D1 schema is deployment-managed by
`migrations/0001_pegma_storage.sql`. The adapter runs with
`createSchemaIfMissing: false`, so request traffic never performs DDL.
Production CI applies pending migrations before activating a new Worker
version. The versioned route is limited to `pegma.dev/api/*`; Cloudflare Pages
continues to serve every static path.

Passkey removal stays disabled until an email-code recovery implementation is
live. This deliberately avoids a last-factor lockout in the passkey-only
configuration.

The one-minute Cron trigger advances independently persisted cursors for
challenge, email-operation, Mail send, Mail reconciliation, and terminal
retention scans. It also purges expired Sessions and sweeps all four durable
rate-limit policies. Replaying a cursor after a crash is safe because claims
and deletions are conditional. Dead-letter and terminal-unknown Mail remains
in D1 for operator inspection until explicitly acknowledged. Email delivery
must remain disabled until the host also has an authenticated, audited
operator acknowledgement workflow; this Worker intentionally exposes no
public acknowledgement endpoint.

## Endpoints

- `GET /`, `GET /health`, or `GET /api/health` — JSON from `@pegma/health`
  (`createProcessCheck` + logging sink booleans). Emits `request.received`
  and, with the checks registered today, `health.ok` through the teed Spine
  logger (both checks are always `ok`; an absent Datadog key is detail only).
  Package mapping for when a check reports otherwise: HTTP `200` for status
  `ok`/`degraded`, `503` for status `fail` (log event `health.failed`).
- `GET /api/identity/capabilities` — issuer, RP ID, and live flow availability.
- `GET /api/identity/account` — verified account and passkey snapshot.
- `POST /api/identity/passkeys/authentication/options|verify` — passkey sign-in.
- `POST /api/identity/passkeys/registration/options|verify` — authenticated
  passkey enrollment.
- `DELETE /api/identity/passkeys` — authenticated passkey removal.
- `POST /api/identity/email-code/account/options|verify` — account creation.
- `POST /api/identity/email-code/sign-in/options|verify` — enumeration-safe
  fallback sign-in.
- `POST /api/identity/logout` — server-side revocation and cookie expiry.

Example body:

```json
{
  "ok": true,
  "status": "ok",
  "service": "pegma-dev-api",
  "checkedAt": "2026-07-27T21:00:00.000Z",
  "checks": {
    "process": { "status": "ok" },
    "logging": {
      "status": "ok",
      "detail": { "cloudflare": true, "datadog": true }
    }
  }
}
```
