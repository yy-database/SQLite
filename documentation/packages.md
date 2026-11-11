# Packages map

pnpm workspace roots (`pnpm-workspace.yaml`):

- `projects/sqlite.ts/packages/*`
- `projects/sqlite.ts/platforms/*`
- `projects/sqlite.ts/homepage`

## TypeScript / npm

| Package | Path | Publish? | Role |
|---------|------|----------|------|
| `@yydb/sqlite` | `packages/sqlite` | yes | Sync Node facade + `./inspect` |
| `@yydb/sqlite-harness` | `packages/sqlite-harness` | no (`private`) | Test / corpus / oracle / bench CLI |
| `@yydb/sqlite-fixtures` | `packages/sqlite-fixtures` | no | Binary fixtures from external engines |
| homepage | `homepage` | no | Capability docs + static pages |
| `@yydb/sqlite-win32-x64` | `platforms/sqlite-win32-x64` | yes | Native `.node` sidecar |
| `@yydb/sqlite-linux-x64` | `platforms/sqlite-linux-x64` | yes | Native `.node` sidecar |
| `@yydb/sqlite-darwin-x64` | `platforms/sqlite-darwin-x64` | yes | Native `.node` sidecar |
| `@yydb/sqlite-darwin-arm64` | `platforms/sqlite-darwin-arm64` | yes | Native `.node` sidecar |
| `@yydb/sqlite-unknown-wasm32` | `platforms/sqlite-unknown-wasm32` | yes | WASM `MemoryDatabase` + assets |

`@yydb/sqlite` lists the platform packages as `optionalDependencies`. Consumers must not import sidecars directly.

Facade exports (see package README for API depth):

| Subpath | Purpose |
|---------|---------|
| `@yydb/sqlite` | `SQLite`, statements, transactions, errors |
| `@yydb/sqlite/inspect` | Format-3 readers / writers / snapshots without SQL |

## Python

| Artifact | Path | Role |
|----------|------|------|
| `sqlite-format3` | `projects/sqlite.py/packages/sqlite` | maturin wheel over `sqlite-pyo3` |

Built from `projects/sqlite.rs/sqlite-pyo3`. Acceptance runs inside the harness python stage (clean venv), not only as an in-tree unittest discovery.

## Rust crates

Workspace members under `projects/sqlite.rs`:

| Crate | Binding |
|-------|---------|
| `sqlite-napi` | Node-API addon |
| `sqlite-pyo3` | PyO3 extension module |
| `sqlite-wasm` | `wasm-bindgen` crate |

Shared product logic is the `sqlite` facade crate from `database.rs` (git `rev`). Do not add new workspace crates or shared intermediate packages without explicit approval — fold reuse into the facade or an existing binding crate.

## Root workspace

Root `package.json` name `sqlite-workspace` is private. It wires scripts (`test`, `build:napi`, `examples:*`, `corpus`) and shared example/devDependencies (`better-sqlite3`, ORMs used by demos). Never `npm init` / install at the repo root for probe installs — use the system temp directory for pack/install assertions.
