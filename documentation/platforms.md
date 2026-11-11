# Platforms

Published sidecars under `projects/sqlite.ts/platforms/` plus harness stage smokes that prove each binding against an external oracle.

## Native Node sidecars

Built by `node scripts/build-napi.mjs` from `sqlite-napi`. Filenames are fixed in `scripts/native-artifacts.mjs`:

| Package | Artifact | Host |
|---------|----------|------|
| `@yydb/sqlite-win32-x64` | `sqlite.win32-x64.node` | Windows x64 |
| `@yydb/sqlite-linux-x64` | `sqlite.linux-x64.node` | Linux x64 |
| `@yydb/sqlite-darwin-x64` | `sqlite.darwin-x64.node` | macOS Intel |
| `@yydb/sqlite-darwin-arm64` | `sqlite.darwin-arm64.node` | macOS Apple Silicon |

`@yydb/sqlite` lists these as `optionalDependencies`. Application code imports the facade only. Override resolution with `SQLITE_NATIVE=/absolute/path/to/sqlite.<platform>.node` when staging outside the optional-dep layout.

## WebAssembly

| Package | Build | Role |
|---------|-------|------|
| `@yydb/sqlite-unknown-wasm32` | `node scripts/build-wasm.mjs` | In-memory `MemoryDatabase` + WASM assets under `lib/` |

`wasm-bindgen-cli` must match the pin from `node scripts/build-wasm.mjs --print-wasm-bindgen-version`.

## Harness stages

Registration: `projects/sqlite.ts/packages/sqlite-harness/stages/stages.mjs` (`platformStages`). Consumed by `pnpm test` / the harness `test` command. Stages report **assertion** counts (split into `storage` / `sql` layers); `rows` is data volume only. Each stage must show external truth (`PRAGMA integrity_check` via CPython `sqlite3`, see `verify_sqlite.py`).

| Stage | Runner | Binding | What it proves |
|-------|--------|---------|----------------|
| `platforms/node` | `stages/node/smoke.mjs` | `sqlite-napi` | Writer path + integrity check |
| `platforms/wasm` | build WASM, then `platforms/sqlite-unknown-wasm32/tests/smoke.mjs` | `sqlite-wasm` | In-memory SQL → snapshot on disk + integrity check |
| `platforms/python` | `stages/python/run_tests.mjs` | `sqlite-pyo3` | maturin wheel in a **clean venv**, feature tests (roundtrip, WAL, hot journal, `WITHOUT ROWID`, UTF-16) |

Assertion floors live next to each stage runner in `stages.mjs` (not in the TS suite floor table). Build artifacts under stages (`lib/`, `out/`, `wheels/`, `.venv/`) are gitignored.

Contract detail: [stages/README.md](../projects/sqlite.ts/packages/sqlite-harness/stages/README.md). Package roles: [packages.md](./packages.md).
