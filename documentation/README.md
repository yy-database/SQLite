# Maintainer documentation

Internal runbooks for this repository. Product users should start at the [root README](../readme.md), the [homepage guides](../projects/sqlite.ts/homepage/documents/zh-hans/index.md), and the published package READMEs.

| Page | Topic |
|------|-------|
| [layout.md](./layout.md) | Top-level tree and ownership boundaries |
| [build-and-test.md](./build-and-test.md) | Local toolchain, build scripts, test entry points |
| [ci-and-release.md](./ci-and-release.md) | GitHub Actions gates and npm Trusted Publisher |
| [packages.md](./packages.md) | Workspace packages and publishable artifacts |
| [harness.md](./harness.md) | `@yydb/sqlite-harness` CLI, layers, floors |
| [platforms.md](./platforms.md) | Native sidecars, WASM, and stage smokes |

Default branch is `dev`. Do not write to `master` beyond the historical initial commit.
