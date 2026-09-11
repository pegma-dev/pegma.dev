---
layout: ../../layouts/MarkdownDoc.astro
title: Local Docker runbook — Pegma
description: One-shot Local Docker runbook for the Bench Ticket Pegma demo. Docker plus this repo; Mailpit for email codes.
---

# Local Docker runbook

One-shot a working **Bench Ticket** site on a laptop that has Docker and nothing else (no cloud account, no npm token, no IdP). The user starts empty. You end with a site at `http://localhost:8787`, Mailpit at `http://localhost:8025` for login codes, a passing health check, and a ticket create/list/reply round-trip.

This is the template for the [Cloudflare](/runbooks/cloudflare), [Azure](/runbooks/azure), and [AWS](/runbooks/aws) runbooks. Do not add Stripe, Auth0, Entra, Cognito, SES, SendGrid, or ACS.

**Fixture:** [`recipes/bench-ticket`](https://github.com/pegma-dev/pegma.dev/tree/main/recipes/bench-ticket) in this repository. Composition is CI-tested. Local Docker uses `createMemoryStore()` from `@pegma/storage-core` — honest for a laptop, not a durability claim.

## Prerequisites

- Docker Engine with Compose v2 (`docker compose version`).
- Git.
- Ports **8787** (app), **8025** (Mailpit UI), and **1025** (Mailpit SMTP) free on localhost.
- No cloud login. Authenticated CLIs are not required.

If `docker` is missing, install Docker Desktop or Engine for the OS, then continue. Do not substitute Podman unless Compose is confirmed (`docker compose version` prints v2).

## 1. Get the source

```sh
git clone https://github.com/pegma-dev/pegma.dev.git
cd pegma.dev
git checkout main
```

If you already have a clone, `cd` into it and `git pull origin main`.

## 2. Default names and env vars

Compose file: `recipes/bench-ticket/docker-compose.yml`.

| Name | Value |
| --- | --- |
| App origin | `http://localhost:8787` |
| Mailpit UI | `http://localhost:8025` |
| Mailpit SMTP | `mailpit:1025` (from the app container) |
| Email-code HMAC secret | `BENCH_TICKET_EMAIL_CODE_SECRET_BASE64` (32 bytes of `0x0b`, base64; **local demo only**) |
| Store | in-memory (`createMemoryStore()`) |
| Mail catcher | Mailpit SMTP (`BENCH_TICKET_MAIL_CATCHER=mailpit`) |

The compose file already sets these. Do not invent a production email vendor. Do not enable passkeys.

## 3. Start

From the repository root:

```sh
docker compose -f recipes/bench-ticket/docker-compose.yml up --build
```

Wait until the app healthcheck is healthy (compose prints `Started` / health passing, usually under a minute). Leave this terminal running.

## 4. Verify

In a **second** terminal:

```sh
curl -sS http://localhost:8787/health
```

Expect HTTP 200 and JSON with `"ok": true`, `"service": "bench-ticket"`, and checks named `process` and `storage`.

Open the site: [http://localhost:8787](http://localhost:8787). You should see the Bench Ticket sign-in form.

Mailpit UI: [http://localhost:8025](http://localhost:8025). It should load empty until a code is requested.

### Ticket round-trip (agent, no browser required)

```sh
# 1. Request an email code
BEGIN=$(curl -sS -X POST http://localhost:8787/api/auth/begin \
  -H 'content-type: application/json' \
  -d '{"email":"member@bench.example","flow":"create"}')
echo "$BEGIN"
HANDLE=$(printf '%s' "$BEGIN" | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).codeHandle))")

# 2. Read the 8-digit code from Mailpit
sleep 1
CODE=$(curl -sS 'http://localhost:8025/api/v1/messages' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const j=JSON.parse(s);const sub=(j.messages||j)||[];const m=JSON.stringify(sub).match(/Your Bench Ticket code is (\\d{8})/); if(!m) {console.error(s); process.exit(1);} console.log(m[1]);})")
echo "code=$CODE"

# 3. Finish sign-up (saves the session cookie)
curl -sS -c /tmp/bench-ticket.cookies -X POST http://localhost:8787/api/auth/finish \
  -H 'content-type: application/json' \
  -d "{\"flow\":\"create\",\"codeHandle\":\"$HANDLE\",\"code\":\"$CODE\"}"

# 4. File a ticket, list the queue, reply
curl -sS -b /tmp/bench-ticket.cookies -X POST http://localhost:8787/api/tickets \
  -H 'content-type: application/json' \
  -d '{"subject":"Laser cutter jammed","body":"The bed will not home.","category":"tools"}'

curl -sS -b /tmp/bench-ticket.cookies http://localhost:8787/api/tickets

TICKET_ID=$(curl -sS -b /tmp/bench-ticket.cookies http://localhost:8787/api/tickets \
  | node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.parse(s).tickets[0].id))")

curl -sS -b /tmp/bench-ticket.cookies -X POST \
  "http://localhost:8787/api/tickets/$TICKET_ID/replies" \
  -H 'content-type: application/json' \
  -d '{"body":"Cleared the gantry. Still stuck."}'
```

Expect: health 200, Mailpit message whose subject contains `Your Bench Ticket code is` plus eight digits, finish returns a `principalId`, create returns **201**, list includes that ticket, reply returns **200** with more than one message.

A person can do the same in the browser: enter an email, Create account, copy the code from Mailpit, verify, file a ticket, reply.

## Failure signs

| Sign | Next command |
| --- | --- |
| `Cannot connect to the Docker daemon` | Start Docker, then rerun `docker compose … up --build`. |
| Port already allocated (`8787` / `8025` / `1025`) | `ss -ltnp \| grep -E '8787\|8025\|1025'` then stop the other process, or change the left-hand ports in the compose file. |
| App unhealthy / `curl: Failed to connect` | `docker compose -f recipes/bench-ticket/docker-compose.yml logs app --tail=80` |
| Health 503 / `storage` check fail | Rebuild: `docker compose -f recipes/bench-ticket/docker-compose.yml up --build --force-recreate`. Memory store should not fail a ping; this is almost always a crash looping before listen. |
| `Mailpit SMTP timed out` / begin 500 | `docker compose -f recipes/bench-ticket/docker-compose.yml logs mailpit --tail=40`. Confirm `MAILPIT_SMTP_HOST=mailpit` (the **service** name, not localhost) from the app container. |
| Begin 200 but Mailpit empty | Wait 2s, `curl -sS http://localhost:8025/api/v1/messages`. If still empty: `docker compose … logs app --tail=80` and look for SMTP errors. |
| Finish `verification_failed` | Code is 8 digits from the **latest** Mailpit message. Do not reuse a code. Request a new one. |
| Finish `invalid_input` / origin errors | Origin must stay `http://localhost:8787` (no path). Do not change `BENCH_TICKET_ORIGIN` without matching the published host. |
| Ticket `401 unauthenticated` | Cookie file missing. Rerun finish with `-c /tmp/bench-ticket.cookies` then `-b` the same file. |

## Teardown

```sh
docker compose -f recipes/bench-ticket/docker-compose.yml down -v
rm -f /tmp/bench-ticket.cookies
```

That stops the app and Mailpit and removes the compose network. There is no cloud resource to delete. Memory store state dies with the container — that is expected.

## What this demo refuses

- Passwords, Auth0, Entra, Cognito, social login.
- Stripe / Billing Core.
- Production email (Resend, SES, ACS, SendGrid).
- Passkeys as the **required** login (optional extra only after email-code works, and only on HTTPS with a stable origin).
