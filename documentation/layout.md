# Layout

```text
SQLite/
├── documentation/          Maintainer docs (this tree)
├── scripts/                Native / WASM / gate entry scripts
├── harness/                Thin CLI shim (forwards to sqlite-harness)
├── .github/workflows/      Check + publish workflows
└── projects/
    ├── sqlite.rs/          Rust FFI workspace (napi / pyo3 / wasm)
    ├── sqlite.ts/          pnpm workspace: packages, platforms, examples, homepage
    └── sqlite.py/          Python packaging (`sqlite-format3`) + examples
```

## Ownership

| Area | Owns | Does not own |
|------|------|--------------|
| `projects/sqlite.rs` | Binding crates only (`sqlite-napi`, `sqlite-pyo3`, `sqlite-wasm`) | Page / SQL engine implementation |
| `database.rs` (git dep) | Shared `sqlite` facade, formats, storage | Packaging / npm / wheels |
| `projects/sqlite.ts/packages/sqlite` | Published Node facade (`@yydb/sqlite`) | Native binary blobs (platforms do) |
| `projects/sqlite.ts/packages/sqlite-harness` | Test / corpus / oracle / bench toolbox | Product public API |
| `projects/sqlite.ts/platforms/*` | Optional native / WASM artifacts | Application import surface |
| `projects/sqlite.py/packages/sqlite` | `sqlite-format3` wheel metadata + acceptance | Shared engine code |

Core codecs come from [`database.rs`](https://github.com/oovm/database.rs) via a pinned `rev` in `projects/sqlite.rs/Cargo.toml`. Local path overrides belong in `projects/sqlite.rs/.cargo/config.toml` (see `config.example.toml` when present) — never commit machine-local absolute paths.

## Conventions

- Package scope: `@yydb/<directory-name>` for npm; Python module `sqlite_format3`.
- Platform directory names: `sqlite-<os>-<arch>`; WASM is fixed as `sqlite-unknown-wasm32`.
- Binding crates stay thin: type conversion and error mapping only; parse/execute logic stays in the facade.
- Product packages must install cleanly under plain Node (`exports` → `dist/*.js` / `dist/*.d.ts`), not TypeScript sources.
