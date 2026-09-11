---
layout: ../layouts/MarkdownDoc.astro
title: Environment runbooks — Pegma
description: One-shot environment runbooks for a small Pegma support-desk demo. Local Docker, Cloudflare, Azure, and AWS.
---

# Environment runbooks

An agent with the right CLI (and nothing else) can one-shot a working **Bench Ticket** demo: a small makerspace helpdesk, not this marketing site and not a new product.

Logged-out: sign in with a first-party **email code**. Logged-in: file a ticket, see the queue, add a reply. That path exercises Identity, Sessions, Mail, Storage Core, Support Desk, and Health. No Stripe, Auth0, Entra, Cognito, passkeys-required login, or production email vendor.

| Environment | Record store | Blobs | Mail | Runbook |
| --- | --- | --- | --- | --- |
| Local Docker | `createMemoryStore()` | none (no attachments) | Mailpit | [Local Docker](/runbooks/local-docker) |
| Cloudflare | `@pegma/storage-cloudflare-d1` | R2 bucket (provisioned) | console / `wrangler tail` | [Cloudflare](/runbooks/cloudflare) |
| Azure | `@pegma/storage-azure-tables` | Blob container (provisioned) | console / container logs | [Azure](/runbooks/azure) |
| AWS | `@pegma/storage-dynamodb` | S3 (`@pegma/storage-s3`) | console / CloudWatch | [AWS](/runbooks/aws) |

The AWS record adapter is `@pegma/storage-dynamodb` (`createDynamoDbStore`) from [storage-core#7](https://github.com/pegma-dev/storage-core/pull/7). The AWS runbook uses the same one-shot shape as Azure and D1; it requires that adapter PR to be merged before `pnpm add` succeeds.

**Fixture (CI-tested):** [`recipes/bench-ticket`](https://github.com/pegma-dev/pegma.dev/tree/main/recipes/bench-ticket) — catalog recipe `support-queue-slice`. Pin versions from [`catalog.json`](/catalog.json). Do not invent Auth0, Entra, or Stripe steps.

Start with [Local Docker](/runbooks/local-docker). Use it as the template for the cloud runbooks.
