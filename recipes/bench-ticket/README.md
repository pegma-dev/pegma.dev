# Bench Ticket (support-queue-slice)

Synthetic makerspace helpdesk used by the public environment runbooks.

- Composition: [`composition.ts`](./composition.ts) (CI-tested)
- HTTP host: [`handler.ts`](./handler.ts) + Node [`host.ts`](./host.ts)
- Cloudflare Worker: [`cloudflare/`](./cloudflare/) (CI-tested with the existing `@cloudflare/vitest-pool-workers` D1 pool)
- Local Docker: [`docker-compose.yml`](./docker-compose.yml)

Follow the runbooks on the site, not this file:

- https://pegma.dev/runbooks
- https://pegma.dev/runbooks/local-docker
- https://pegma.dev/runbooks/cloudflare
- https://pegma.dev/runbooks/azure
- https://pegma.dev/runbooks/aws
