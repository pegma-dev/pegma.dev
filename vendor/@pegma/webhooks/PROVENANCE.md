# Vendored `@pegma/webhooks` provenance

`@pegma/webhooks` is unpublished. pegma.dev consumes a byte-reproducible
`npm pack` artifact until the first public package release, then this bridge
is removed.

| Field | Value |
| --- | --- |
| Package | `@pegma/webhooks@0.0.0` |
| Artifact | `pegma-webhooks-0.0.0.tgz` |
| Source repository | `https://github.com/pegma-dev/webhooks` |
| Exact commit | `416db2fbafc48060fddedf4153924a1de987cc7b` |
| SHA-256 | `4c731b0b2419784bb38bdef9c46454b7644865d0e4a40061872c9cc90361e88f` |
| npm integrity | `sha512-ICl2G6Ty6JdYIIMMT70mNDrialTzN66pqK4l7xHZGO3KpKPJ745xtsNOBpiJEEJe7Yusf+IajR1f+g4APSCkJQ==` |
| Storage Core pin inside artifact | `@pegma/storage-core@0.4.0` |

## Reproduction

```text
git clone https://github.com/pegma-dev/webhooks.git
cd webhooks
git checkout 416db2fbafc48060fddedf4153924a1de987cc7b
npm ci
npm pack -w @pegma/webhooks --pack-destination .
Get-FileHash -Algorithm SHA256 .\pegma-webhooks-0.0.0.tgz
# or: shasum -a 256 pegma-webhooks-0.0.0.tgz
```

The SHA-256 of the resulting tarball must match the table above. npm records
the sha512 integrity automatically when the dependency is installed from the
local file path.
