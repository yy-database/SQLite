# CI and release

## Check workflows

| Workflow | File | Role |
|----------|------|------|
| Check Rust | `.github/workflows/check-rust.yml` | `rustfmt --check`, `cargo test` on ubuntu / macos / windows |
| Check TypeScript | `.github/workflows/check-typescript.yml` | `pnpm install`, `node scripts/check-test-floor.mjs`, examples, corpus job |
| Check Python | `.github/workflows/check-python.yml` | maturin wheel + clean-venv acceptance via harness python stage |

Triggers: push / PR to `dev` and `master`. Publish calls the three checks via `workflow_call`.

TypeScript job also installs the WASM target, `wasm-bindgen-cli`, and maturin so the merged gate can build native + WASM + wheel stages in one place.

## Corpus job

`check-typescript.yml` has a separate `corpus` job:

```text
pnpm install → node scripts/build-napi.mjs → pnpm corpus --seed 20261106 --count 200 --check
```

## npm publish (Trusted Publisher)

Sole trusted workflow filename (must match npm Trusted Publisher config):

- **file:** `publish-npm.yml`
- **repo:** `yy-database/SQLite`
- **environment:** `NPM_PUBLISH`
- **config mirror:** `nifty.config.ts` → `trust.npm`

Flow on `v*` tags (or `workflow_dispatch` with an existing tag):

1. Gate rust / typescript / python (reuse the check workflows).
2. Matrix-build native addons (`win32-x64`, `linux-x64`, `darwin-x64`, `darwin-arm64`) and upload artifacts.
3. On ubuntu: stage natives, build `@yydb/sqlite` + WASM, run `pnpm exec nifty publish --access public --version=<tag without v>`.
4. Poll `npm view` until every expected package lands at that version; assert WASM `dist.fileCount >= 4`.

Expected public packages:

- `@yydb/sqlite`
- `@yydb/sqlite-darwin-arm64`
- `@yydb/sqlite-darwin-x64`
- `@yydb/sqlite-linux-x64`
- `@yydb/sqlite-win32-x64`
- `@yydb/sqlite-unknown-wasm32`

Private / workspace-only packages (`@yydb/sqlite-harness`, fixtures, homepage) must stay out of the publish set. Local `nifty publish --placeholder` is only for `0.0.0` stubs — real versions publish only through OIDC on this workflow. Do not use a plaintext `NPM_TOKEN`.

## Branch discipline

- Land work on `dev`.
- No force-push.
- Tag releases as `v*`; version published must be strictly greater than the highest version already on npm for each package.
