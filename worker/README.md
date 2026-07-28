# pegma-dev-api Worker

Thin Cloudflare Worker that proves pegma.dev's Pegma logging composition and
hosts the public health endpoint via `@pegma/health`:

```ts
createTeeLogger(
  createCloudflareLogger(),
  createDatadogLogger(submit),
)
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
token needs **Workers:Edit** in addition to **Pages:Edit**.

## Endpoints

- `GET /` or `GET /health` — JSON from `@pegma/health`
  (`createProcessCheck` + logging sink booleans). Emits `request.received`
  and `health.ok` / `health.degraded` / `health.failed` through the teed Spine
  logger. HTTP `200` when status is `ok` or `degraded`; `503` on `fail`.
  No storage probe yet (D1 consumer still gated).

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

## Vendored `@pegma/health`

Until `@pegma/health` is on npm, the Worker depends on
`worker-vendor/pegma-health-0.1.0.tgz` packed from `pegma-dev/health`.
