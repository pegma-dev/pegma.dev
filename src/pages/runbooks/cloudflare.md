---
layout: ../../layouts/MarkdownDoc.astro
title: Cloudflare runbook — Pegma
description: One-shot Cloudflare runbook for the Bench Ticket Pegma demo. D1 records, R2 bucket, console mail catcher.
---

# Cloudflare runbook

One-shot the same **Bench Ticket** demo as [Local Docker](/runbooks/local-docker) on Cloudflare: first-party email-code login, Sessions, Support Desk create/list/reply, Health. Record store is `@pegma/storage-cloudflare-d1`. Provision an R2 bucket for blobs (the demo does not store attachments; the bucket is the host-owned blob binding the stack expects). Mail is a **console catcher** (`wrangler tail`) — do not sign up for Resend, SES, SendGrid, or ACS.

Do not add Stripe, Auth0, Entra, or passkeys-required login.

**Fixture:** [`recipes/bench-ticket`](https://github.com/pegma-dev/pegma.dev/tree/main/recipes/bench-ticket) — Worker entry [`cloudflare/worker.ts`](https://github.com/pegma-dev/pegma.dev/blob/main/recipes/bench-ticket/cloudflare/worker.ts), Wrangler config [`cloudflare/wrangler.jsonc`](https://github.com/pegma-dev/pegma.dev/blob/main/recipes/bench-ticket/cloudflare/wrangler.jsonc).

## Prerequisites

- Git.
- Node 22 or 24 with Corepack (`corepack enable`).
- Cloudflare account.
- Authenticated Wrangler: `npx wrangler whoami` must print your account. If it fails: `npx wrangler login` and complete the browser flow.

## 1. Get the source

```sh
git clone https://github.com/pegma-dev/pegma.dev.git
cd pegma.dev
git checkout main
npm install -g corepack
corepack enable
pnpm install --frozen-lockfile
```

## 2. Default names

| Resource | Default name | Binding |
| --- | --- | --- |
| Worker script | `bench-ticket` | — |
| D1 database | `bench-ticket` | `BENCH_TICKET_DB` |
| R2 bucket | `bench-ticket-blobs` | `BENCH_TICKET_BLOBS` |
| Origin var | `BENCH_TICKET_ORIGIN` | Worker `vars` |
| Email-code secret | `BENCH_TICKET_EMAIL_CODE_SECRET_BASE64` | Worker **secret** |

## 3. Create D1 and R2

```sh
npx wrangler d1 create bench-ticket
npx wrangler r2 bucket create bench-ticket-blobs
```

Copy the D1 `database_id` UUID from the `d1 create` output into `recipes/bench-ticket/cloudflare/wrangler.jsonc`, replacing `REPLACE_AFTER_D1_CREATE`. Leave `database_name` as `bench-ticket`.

The D1 adapter creates its schema on first use (`createSchemaIfMissing: true`). Do not invent a second database “just for audit” — Audit records live in the caller collection on this same D1.

## 4. Origin and secret

After first deploy Wrangler prints a `*.workers.dev` URL. Set `vars.BENCH_TICKET_ORIGIN` in `wrangler.jsonc` to that origin with **no trailing slash** (example: `https://bench-ticket.<account>.workers.dev`). Identity refuses origins that are not a full origin.

Generate a 32-byte secret and put it as a Worker secret (not a `vars` value):

```sh
SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
echo "$SECRET"
npx wrangler secret put BENCH_TICKET_EMAIL_CODE_SECRET_BASE64 \
  -c recipes/bench-ticket/cloudflare/wrangler.jsonc
```

Paste `$SECRET` at the prompt. Do not commit it.

## 5. Deploy

```sh
npx wrangler deploy -c recipes/bench-ticket/cloudflare/wrangler.jsonc
```

If origin was still `REPLACE`, set `BENCH_TICKET_ORIGIN` to the printed `workers.dev` URL and deploy a second time so Identity’s allowed origin matches the live host.

```sh
npx wrangler deploy -c recipes/bench-ticket/cloudflare/wrangler.jsonc
```

## 6. Verify

Replace `$ORIGIN` with the Worker origin.

```sh
ORIGIN=https://bench-ticket.REPLACE.workers.dev
curl -sS "$ORIGIN/health"
```

Expect HTTP 200, `"ok": true`, `"service": "bench-ticket"`.

In a second terminal:

```sh
npx wrangler tail bench-ticket -c recipes/bench-ticket/cloudflare/wrangler.jsonc
```

Ticket round-trip:

```sh
BEGIN=$(curl -sS -X POST "$ORIGIN/api/auth/begin" \
  -H 'content-type: application/json' \
  -d '{"email":"member@bench.example","flow":"create"}')
HANDLE=$(printf '%s' "$BEGIN" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).codeHandle))")
```

The tail session logs a line `[bench-ticket mail] … subject=Your Bench Ticket code is ########`. Copy the eight digits.

```sh
CODE=12345678   # from wrangler tail
curl -sS -c /tmp/bench-ticket.cookies -X POST "$ORIGIN/api/auth/finish" \
  -H 'content-type: application/json' \
  -d "{\"flow\":\"create\",\"codeHandle\":\"$HANDLE\",\"code\":\"$CODE\"}"

curl -sS -b /tmp/bench-ticket.cookies -X POST "$ORIGIN/api/tickets" \
  -H 'content-type: application/json' \
  -d '{"subject":"Laser cutter jammed","body":"The bed will not home.","category":"tools"}'

curl -sS -b /tmp/bench-ticket.cookies "$ORIGIN/api/tickets"
```

Open `$ORIGIN` in a browser for the same path. Codes are **not** in Mailpit; they are in `wrangler tail`.

## Failure signs

| Sign | Next command |
| --- | --- |
| `wrangler whoami` not authenticated | `npx wrangler login` |
| `D1 database not found` / binding error | Confirm `database_id` in `wrangler.jsonc` matches `npx wrangler d1 list`. |
| Health 503 / storage fail | `npx wrangler d1 execute bench-ticket --command 'SELECT name FROM sqlite_master;'` then redeploy. First-request schema create needs the D1 binding. |
| `Bench Ticket origin is invalid` / finish 400 | `BENCH_TICKET_ORIGIN` must equal the URL you curl (`https://…workers.dev`, no path, no slash). Redeploy after editing `vars`. |
| Begin 200, no code in tail | Tail must be running **before** begin. `npx wrangler tail bench-ticket -c recipes/bench-ticket/cloudflare/wrangler.jsonc` |
| `Identity email-code secret is missing` | `npx wrangler secret put BENCH_TICKET_EMAIL_CODE_SECRET_BASE64 -c recipes/bench-ticket/cloudflare/wrangler.jsonc` |
| KV mentioned as a store | Stop. Storage Core **rejects KV**. Use D1 only. |

## Teardown

```sh
npx wrangler delete -c recipes/bench-ticket/cloudflare/wrangler.jsonc
npx wrangler d1 delete bench-ticket
npx wrangler r2 bucket delete bench-ticket-blobs
rm -f /tmp/bench-ticket.cookies
```

Confirm each delete. D1 delete is irreversible.

## Store wiring (same composition)

The Worker already injects D1:

```ts
import { createCloudflareD1Store } from "@pegma/storage-cloudflare-d1";

const store = createCloudflareD1Store({
  database: env.BENCH_TICKET_DB,
  createSchemaIfMissing: true,
});
```

That `Store` is passed to `createBenchTicketComposition` — identical to Local Docker’s memory store and Azure Tables / AWS DynamoDB in the sibling runbooks.
