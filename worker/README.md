# pegma-dev-api Worker

Thin Cloudflare Worker that proves pegma.dev's Pegma logging composition:

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
# if using the EU site:
npx wrangler secret put DATADOG_SITE -c worker/wrangler.jsonc
# value: datadoghq.eu
```

## Endpoints

- `GET /` or `GET /health` — JSON health; emits `request.received` and
  `health.ok` through the teed Spine logger.
