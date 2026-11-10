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

The AWS record adapter is the published `@pegma/storage-dynamodb@0.4.5` (`createDynamoDbStore`); see the [qualified release](https://github.com/pegma-dev/storage-core/releases/tag/v0.4.5). The AWS runbook describes the same composition shape as Azure and D1. The committed host and CI fixture use MemoryStore; package publication does not establish an AWS deployment of that fixture.

**Fixture (CI-tested):** [`recipes/bench-ticket`](https://github.com/pegma-dev/pegma.dev/tree/main/recipes/bench-ticket) — catalog recipe `support-queue-slice`. Pin versions from [`catalog.json`](/catalog.json). Do not invent Auth0, Entra, or Stripe steps.

Start with [Local Docker](/runbooks/local-docker). Use it as the template for the cloud runbooks.
