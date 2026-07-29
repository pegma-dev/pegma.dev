# Synthetic recipe fixtures

CI-tested composition sketches for agents. Product names and domains are
**fictional on purpose** — they teach assembly, not commercial architecture.

| Recipe id | Intent (short) | Path |
| --- | --- | --- |
| `cf-passkey-accounts` | Northshelf Branch — passkey + email-code accounts on a Cloudflare-shaped host | [`cf-passkey-accounts/`](./cf-passkey-accounts/) |
| `storage-audit-mail-outbox` | Yard Loan — inventory mutation + audit + mail job in one transaction | [`storage-audit-mail-outbox/`](./storage-audit-mail-outbox/) |

## Rules

1. **Synthetic only.** No routes, schemas, or ops topology from production hosts.
2. **Executed.** Every recipe has a `*.test.ts` included in `npm test`.
3. **Catalog citation.** `/catalog.json` and `/examples` may quote wiring only
   from files under this tree (or from already-public package README/conformance
   sources). `fixture.status` is `green` only when CI covers the fixture.
4. **Composition root is the map.** Fixtures wire packages explicitly; no
   autodiscovery story.

## Production vs test adapters

Fixtures use `@pegma/storage-core` **memory** stores in tests so CI stays
fast and free of cloud credentials. Recipe metadata and comments name the
production adapter the host should choose (for example Cloudflare D1 for
`cf-passkey-accounts`). Memory is never a durability claim.
