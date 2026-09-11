---
layout: ../../layouts/MarkdownDoc.astro
title: AWS runbook — Pegma
description: One-shot AWS runbook for the Bench Ticket Pegma demo. DynamoDB records via @pegma/storage-dynamodb, S3 blobs, console mail catcher.
---

# AWS runbook

Same one-shot as [Local Docker](/runbooks/local-docker), [Cloudflare](/runbooks/cloudflare), and [Azure](/runbooks/azure): Bench Ticket with first-party email-code login, Sessions, Support Desk create/list/reply, Health. Mail is a **console catcher** (CloudWatch logs) — do not sign up for SES, SendGrid, ACS, or Resend. Do not add Stripe, Auth0, Entra, or Cognito.

## Requires the storage-core DynamoDB adapter PR

Record persistence on AWS uses the Storage Core adapter that passes `packages/storage-core/src/conformance.ts`. That package is being added in [pegma-dev/storage-core#7](https://github.com/pegma-dev/storage-core/pull/7) as **DynamoDB**, named to match siblings:

| Sibling | Package | Factory |
| --- | --- | --- |
| Azure Tables | `@pegma/storage-azure-tables` | `createAzureTablesStore` |
| Cloudflare D1 | `@pegma/storage-cloudflare-d1` | `createCloudflareD1Store` |
| AWS DynamoDB | `@pegma/storage-dynamodb` | `createDynamoDbStore` |

**Do not implement that adapter in pegma.dev.** If `pnpm add @pegma/storage-dynamodb` fails because the package is not on npm yet, stop and merge/publish [storage-core#7](https://github.com/pegma-dev/storage-core/pull/7) first, then resume at step 4. Blobs are already published (`@pegma/storage-s3` / `createS3BlobStore`).

Until that package is on npm, Local Docker, Cloudflare, and Azure still one-shot from this same fixture.

## Prerequisites

- Git, Docker, Node 22/24 with Corepack.
- AWS account.
- Authenticated AWS CLI: `aws sts get-caller-identity` must print an account. If it fails: `aws login` or `aws configure sso` (or export keys) and retry.
- Region default: `us-east-1`.

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
| Region | `us-east-1` |
| DynamoDB table | `bench-ticket` (every Storage Core collection shares one table) |
| S3 bucket | `bench-ticket-blobs-<account-id>` (globally unique) |
| App Runner / container service | `bench-ticket` |
| Email-code secret | `BENCH_TICKET_EMAIL_CODE_SECRET_BASE64` |

The adapter README’s table schema is `pk` (HASH) + `sk` (RANGE), on-demand billing. Mirror Azure: **one table for every collection**, not one table per collection.

## 3. Create AWS resources

```sh
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGION=us-east-1
BUCKET="bench-ticket-blobs-${ACCOUNT}"

aws dynamodb create-table \
  --region "$REGION" \
  --table-name bench-ticket \
  --billing-mode PAY_PER_REQUEST \
  --attribute-definitions \
    AttributeName=pk,AttributeType=S \
    AttributeName=sk,AttributeType=S \
  --key-schema \
    AttributeName=pk,KeyType=HASH \
    AttributeName=sk,KeyType=RANGE

aws dynamodb wait table-exists --region "$REGION" --table-name bench-ticket

aws s3api create-bucket --bucket "$BUCKET" --region "$REGION"
```

The adapter can create the table on first use (`createTableIfMissing` defaults to true). This runbook provisions it in infrastructure instead, then passes `createTableIfMissing: false` so the task role does not need `CreateTable`. Do not invent a second table “for audit”.

## 4. Point the host at DynamoDB (after the adapter is on npm)

```sh
pnpm add @pegma/storage-dynamodb @aws-sdk/client-dynamodb @pegma/storage-s3 @aws-sdk/client-s3
```

Pin `@pegma/storage-dynamodb` to the exact version in [catalog.json](/catalog.json) once the compiler lists it. Until then, use the version the storage-core release publishes (do not invent a caret range).

In `recipes/bench-ticket/host.ts`, replace `createMemoryStore()` with the sibling-shaped factory:

```ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { createDynamoDbStore } from "@pegma/storage-dynamodb";

const store = createDynamoDbStore({
  client: new DynamoDBClient({ region: process.env.AWS_REGION ?? "us-east-1" }),
  tableName: process.env.BENCH_TICKET_TABLE ?? "bench-ticket",
  createTableIfMissing: false,
});
```

If the published factory options differ, copy them from that package’s README — keep the call site a single `createDynamoDbStore({ … })` returning a Storage Core `Store`, then pass it to `createBenchTicketComposition` unchanged.

Optional blobs (provisioned above; not required for the ticket round-trip):

```ts
import { S3Client } from "@aws-sdk/client-s3";
import { createS3BlobStore } from "@pegma/storage-s3";

const blobs = createS3BlobStore({
  client: new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" }),
  bucket: process.env.BENCH_TICKET_BLOB_BUCKET!,
  endpoint: `https://s3.${process.env.AWS_REGION ?? "us-east-1"}.amazonaws.com`,
  maxObjectBytes: 16 * 1024 * 1024,
});
```

Set `BENCH_TICKET_MAIL_CATCHER=console`.

## 5. Deploy the container

Use the same Dockerfile as Local Docker. Example with App Runner (any container host that can reach DynamoDB is fine):

```sh
SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGION=us-east-1
ECR="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
aws ecr create-repository --repository-name bench-ticket --region "$REGION" || true
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$ECR"
docker build -f recipes/bench-ticket/Dockerfile -t "$ECR/bench-ticket:local" .
docker push "$ECR/bench-ticket:local"
```

Create an App Runner service (or ECS/Fargate) with:

| Env var | Value |
| --- | --- |
| `PORT` | `8787` |
| `BENCH_TICKET_MAIL_CATCHER` | `console` |
| `BENCH_TICKET_EMAIL_CODE_SECRET_BASE64` | `$SECRET` |
| `BENCH_TICKET_TABLE` | `bench-ticket` |
| `AWS_REGION` | `us-east-1` |
| `BENCH_TICKET_ORIGIN` | `https://<assigned-host>` (set after first URL exists, then redeploy) |

Give the task role DynamoDB access to table `bench-ticket` and `s3:GetObject`/`PutObject` on the blob bucket. Do not put AWS keys in the image.

## 6. Verify

```sh
ORIGIN=https://REPLACE.awsapprunner.com
curl -sS "$ORIGIN/health"
```

Expect HTTP 200, `"ok": true`, `"service": "bench-ticket"`. Then the same begin / 8-digit code from logs / finish / file ticket / reply sequence as Local Docker. Log prefix: `[bench-ticket mail]`.

Follow logs with the platform’s tail (`aws logs tail … --follow` or App Runner application logs).

## Failure signs

| Sign | Next command |
| --- | --- |
| `aws sts get-caller-identity` fails | `aws login` / `aws configure sso` |
| `pnpm add @pegma/storage-dynamodb` 404 | Adapter PR not merged/published. Do **not** implement DynamoDB here. Finish Local Docker / Cloudflare / Azure instead. See [storage-core#7](https://github.com/pegma-dev/storage-core/pull/7). |
| `Cannot find module '@pegma/storage-dynamodb'` | Same — wait for the storage-core AWS package; name it `@pegma/storage-dynamodb` / `createDynamoDbStore`. |
| `ResourceNotFoundException` | `aws dynamodb describe-table --table-name bench-ticket`. Recreate using `pk` HASH + `sk` RANGE. |
| Health 503 / storage fail | IAM: the task role needs DynamoDB on that table. `aws dynamodb scan --table-name bench-ticket --max-items 1`. |
| Origin invalid / finish 400 | `BENCH_TICKET_ORIGIN` must be the public HTTPS origin with no path. |
| No code in logs | Tail logs **before** begin. `BENCH_TICKET_MAIL_CATCHER=console`. |
| Temptation to use Cognito | Stop. This demo is `@pegma/identity` email-code only. |

## Teardown

```sh
aws dynamodb delete-table --table-name bench-ticket --region us-east-1
aws s3 rb "s3://bench-ticket-blobs-${ACCOUNT}" --force
aws ecr delete-repository --repository-name bench-ticket --force --region us-east-1
# plus delete the App Runner / ECS service
rm -f /tmp/bench-ticket.cookies
```

## Store wiring (same composition)

After the adapter exists, the host is the Azure/D1 shape:

```ts
import { createDynamoDbStore } from "@pegma/storage-dynamodb";

const store = createDynamoDbStore({
  client,
  tableName: "bench-ticket",
  createTableIfMissing: false,
});
```

Pass `store` into `createBenchTicketComposition`. Do not give Audit, Mail, Identity, or Support Desk a second DynamoDB table.
