---
layout: ../../layouts/MarkdownDoc.astro
title: Azure runbook — Pegma
description: One-shot Azure runbook for the Bench Ticket Pegma demo. Azure Tables records, Blob container, console mail catcher.
---

# Azure runbook

One-shot the same **Bench Ticket** demo as [Local Docker](/runbooks/local-docker) on Azure: first-party email-code login, Sessions, Support Desk create/list/reply, Health. Record store is `@pegma/storage-azure-tables`. Provision a Blob container for `@pegma/storage-azure-blob` (the demo does not store attachments). Mail is a **console catcher** on container logs — do not sign up for ACS, SES, SendGrid, or Resend.

Do not add Stripe, Auth0, Entra, or passkeys-required login. Entra is an IdP adapter for hosts that already authenticate with Entra; this demo uses `@pegma/identity` email codes.

**Fixture:** [`recipes/bench-ticket`](https://github.com/pegma-dev/pegma.dev/tree/main/recipes/bench-ticket). Reuse the Node host (`host.ts`) with the store factory swapped to Azure Tables — same `createBenchTicketComposition`.

## Prerequisites

- Git, Docker (to build the existing demo image), Node 22/24 with Corepack.
- Azure account.
- Authenticated Azure CLI: `az account show` must print a subscription. If it fails: `az login` and complete the browser flow.

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

| Resource | Default name |
| --- | --- |
| Resource group | `rg-bench-ticket` |
| Region | `eastus` |
| Storage account | `stbenchticket` plus a unique suffix (Azure names are global) |
| Table | `pegma` (every Storage Core collection shares one table) |
| Blob container | `bench-ticket-blobs` |
| Container Apps env | `cae-bench-ticket` |
| Container app | `ca-bench-ticket` |
| Email-code secret | `BENCH_TICKET_EMAIL_CODE_SECRET_BASE64` |

## 3. Create Azure resources

```sh
az group create --name rg-bench-ticket --location eastus

az storage account create \
  --name stbenchticket$RANDOM \
  --resource-group rg-bench-ticket \
  --location eastus \
  --sku Standard_LRS

ACCOUNT=$(az storage account list -g rg-bench-ticket --query '[0].name' -o tsv)
CONN=$(az storage account show-connection-string -g rg-bench-ticket -n "$ACCOUNT" --query connectionString -o tsv)

az storage table create --name pegma --connection-string "$CONN"
az storage container create --name bench-ticket-blobs --connection-string "$CONN"
```

Save `$CONN`. Do not commit it.

## 4. Point the host at Azure Tables

The published demo `host.ts` uses `createMemoryStore()`. For Azure, add the published adapter and swap the factory. Exact packages (pin from [catalog.json](/catalog.json) if these drifted):

```sh
pnpm add @pegma/storage-azure-tables@0.4.0 @azure/data-tables
```

In `recipes/bench-ticket/host.ts`, replace `createMemoryStore()` with:

```ts
import { TableClient, AzureNamedKeyCredential } from "@azure/data-tables";
import { createAzureTablesStore } from "@pegma/storage-azure-tables";

const account = process.env.AZURE_STORAGE_ACCOUNT!;
const key = process.env.AZURE_STORAGE_ACCOUNT_KEY!;
const endpoint = `https://${account}.table.core.windows.net`;
const client = new TableClient(endpoint, "pegma", new AzureNamedKeyCredential(account, key));
const store = createAzureTablesStore({ client, createTableIfMissing: false });
```

Set `BENCH_TICKET_MAIL_CATCHER=console` so codes go to stdout (container logs), not Mailpit.

Keep `createBenchTicketComposition({ store, origin, … })` unchanged.

## 5. Deploy the container

```sh
SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
ACCOUNT=$(az storage account list -g rg-bench-ticket --query '[0].name' -o tsv)
KEY=$(az storage account keys list -g rg-bench-ticket -n "$ACCOUNT" --query '[0].value' -o tsv)

az acr create -g rg-bench-ticket -n benchticketacr$RANDOM --sku Basic
ACR=$(az acr list -g rg-bench-ticket --query '[0].name' -o tsv)
az acr login -n "$ACR"
IMAGE="${ACR}.azurecr.io/bench-ticket:local"
docker build -f recipes/bench-ticket/Dockerfile -t "$IMAGE" .
docker push "$IMAGE"

az containerapp env create -g rg-bench-ticket -n cae-bench-ticket -l eastus

# First create without origin, then set origin from the assigned FQDN.
az containerapp create \
  -g rg-bench-ticket \
  -n ca-bench-ticket \
  --environment cae-bench-ticket \
  --image "$IMAGE" \
  --ingress external \
  --target-port 8787 \
  --registry-server "${ACR}.azurecr.io" \
  --env-vars \
    BENCH_TICKET_MAIL_CATCHER=console \
    BENCH_TICKET_EMAIL_CODE_SECRET_BASE64="$SECRET" \
    AZURE_STORAGE_ACCOUNT="$ACCOUNT" \
    AZURE_STORAGE_ACCOUNT_KEY="$KEY" \
    PORT=8787

FQDN=$(az containerapp show -g rg-bench-ticket -n ca-bench-ticket --query properties.configuration.ingress.fqdn -o tsv)
ORIGIN="https://$FQDN"
az containerapp update -g rg-bench-ticket -n ca-bench-ticket \
  --set-env-vars "BENCH_TICKET_ORIGIN=$ORIGIN"
```

Identity requires the live HTTPS origin. Redeploy/update env after the FQDN exists.

## 6. Verify

```sh
ORIGIN=https://$(az containerapp show -g rg-bench-ticket -n ca-bench-ticket --query properties.configuration.ingress.fqdn -o tsv)
curl -sS "$ORIGIN/health"
```

Expect HTTP 200, `"ok": true`, `"service": "bench-ticket"`.

```sh
az containerapp logs show -g rg-bench-ticket -n ca-bench-ticket --follow
```

Then the same begin / copy 8-digit code from logs / finish / file ticket / reply sequence as Local Docker, using `$ORIGIN` instead of `http://localhost:8787`. Log line prefix: `[bench-ticket mail]`.

## Failure signs

| Sign | Next command |
| --- | --- |
| `az account show` fails | `az login` |
| Storage account name taken | Add a longer suffix; Azure storage names are global and lowercase. |
| `TableNotFound` | `az storage table create --name pegma --connection-string "$CONN"` |
| Health 503 / storage fail | Confirm `AZURE_STORAGE_ACCOUNT` / `AZURE_STORAGE_ACCOUNT_KEY` on the container app: `az containerapp show -g rg-bench-ticket -n ca-bench-ticket`. |
| Origin invalid / finish 400 | `BENCH_TICKET_ORIGIN` must be `https://<fqdn>` with no path. `az containerapp update … --set-env-vars BENCH_TICKET_ORIGIN=…` |
| No code in logs | `az containerapp logs show … --follow` **before** calling begin. `BENCH_TICKET_MAIL_CATCHER` must be `console`. |
| Building image fails on `tsx` | Image must `pnpm install` **before** `NODE_ENV=production` (the checked-in Dockerfile already does). |

## Teardown

```sh
az group delete --name rg-bench-ticket --yes --no-wait
rm -f /tmp/bench-ticket.cookies
```

That removes the storage account, table, blob container, ACR, and Container App.

## Store wiring (same composition)

```ts
import { createAzureTablesStore } from "@pegma/storage-azure-tables";

const store = createAzureTablesStore({
  client,
  createTableIfMissing: false,
});
```

Hand that `Store` to `createBenchTicketComposition`. Blob: `@pegma/storage-azure-blob` + `createAzureBlobStore({ containerClient })` when the host grows attachments; this demo’s ticket round-trip does not need it.
