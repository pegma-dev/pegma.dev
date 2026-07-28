# Vendored `@pegma/webhooks` provenance

`@pegma/webhooks` is unpublished. pegma.dev consumes a byte-reproducible
`npm pack` artifact until the first public package release, then this bridge
is removed.

| Field | Value |
| --- | --- |
| Package | `@pegma/webhooks@0.0.0` |
| Artifact | `pegma-webhooks-0.0.0.tgz` |
| Source repository | `https://github.com/pegma-dev/webhooks` |
| Exact commit | `1e5ef0732c3595ea82cb80394cf55cd9a0442318` |
| SHA-256 | `2c27d51169c42598b17f95b099cb01b35a8c6cf5bfa42ce1f2c09480746e9521` |
| npm integrity | `sha512-d/SvLJqd7CInzsDKLM6goI8yXh08jMBBzpHlvy3TMYyRmmbthJpkurJda3jZ2aGvrqbW/Rx3nAyxf1ZZhB20Zw==` |
| Storage Core pin inside artifact | `@pegma/storage-core@0.4.0` |

## Reproduction

```text
git clone https://github.com/pegma-dev/webhooks.git
cd webhooks
git checkout 1e5ef0732c3595ea82cb80394cf55cd9a0442318
npm ci
npm pack -w @pegma/webhooks --pack-destination .
Get-FileHash -Algorithm SHA256 .\pegma-webhooks-0.0.0.tgz
# or: shasum -a 256 pegma-webhooks-0.0.0.tgz
```

The SHA-256 of the resulting tarball must match the table above. npm records
the sha512 integrity automatically when the dependency is installed from the
local file path.
