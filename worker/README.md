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

The first public releases of `@pegma/identity` and
`@pegma/authorization-identity` are not on npm yet. Until both exact versions
can be installed, `identity-runtime.ts` composes the published D1 and Sessions
pieces but deliberately leaves the Identity ports absent. Capabilities report
that state and account operations fail closed. Tests exercise the complete
route boundary with injected ports, so installing the released packages is an
isolated composition-root change rather than a route rewrite.

Email-code identity is likewise an injected port. Its public delivery seam is
`VerificationEmailSender`; no Cloudflare Email Sending account, secret, or paid
plan is assumed by this repository.

The D1 schema is deployment-managed by
`migrations/0001_pegma_storage.sql`. The adapter runs with
`createSchemaIfMissing: false`, so request traffic never performs DDL.
Production CI applies pending migrations before activating a new Worker
version. The versioned route is limited to `pegma.dev/api/*`; Cloudflare Pages
continues to serve every static path.

Passkey removal stays disabled until an email-code recovery implementation is
live. This deliberately avoids a last-factor lockout in the passkey-only
configuration.

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
- `POST /api/identity/email-code/options|verify` — injected email-code flow.
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
