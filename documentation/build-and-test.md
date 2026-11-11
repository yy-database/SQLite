# Build and test

## Prerequisites

- Node.js **24+** for the workspace scripts (published `@yydb/sqlite` engines field is `>=18`)
- pnpm **10.18.3** (`packageManager` in root `package.json`)
- Rust **nightly** (`projects/sqlite.rs/rust-toolchain.toml` / root `rust-toolchain.toml`)
- Python **3.12+** (acceptance / wheel stages; package requires `>=3.9`)
- `maturin` (`>=1.7,<2`) for the PyO3 wheel
- `wasm-bindgen-cli` version must match the pin printed by `node scripts/build-wasm.mjs --print-wasm-bindgen-version`

```shell
pnpm install
```

## Build

| Command | Result |
|---------|--------|
| `pnpm check` | `cargo check` on the Rust FFI workspace |
| `pnpm build:napi` / `node scripts/build-napi.mjs` | Release `sqlite-napi` → matching `platforms/sqlite-<os>-<arch>/sqlite.<os>-<arch>.node` |
| `node scripts/build-wasm.mjs` | WASM package under `platforms/sqlite-unknown-wasm32/lib/` |
| `node scripts/build-pyo3.mjs` | PyO3 / maturin helper (wheel staging used by harness stages) |
| `pnpm --filter @yydb/sqlite build` | Compile the TypeScript facade to `dist/` |

Override the resolved native addon at runtime with `SQLITE_NATIVE=/absolute/path/to/sqlite.<platform>.node` when staging outside optional deps.

## Test entry points

Prefer the harness — CI and local share one implementation:

```shell
# build native binding, run TS + PY suites, platform stages
pnpm test
# equivalent:
node projects/sqlite.ts/packages/sqlite-harness/bin/cli.mjs test
node scripts/check-test-floor.mjs

pnpm test:rust          # cargo test --workspace (smoke only)
pnpm test:py            # unittest discover under projects/sqlite.py/packages/sqlite/tests
pnpm test:gate          # alias of check-test-floor.mjs
pnpm corpus             # differential corpus (see harness.md)
```

Examples (after a usable native binding and built facade):

```shell
pnpm examples:ts
pnpm examples:py
pnpm examples:benchmark
```

## Coverage layers

Suites are counted in three independent layers — never as one aggregate number:

| Layer | Meaning |
|-------|---------|
| `external` | Cross-engine conformance judged by peer engines (`better-sqlite3`, `node:sqlite`, `sql.js`, CPython `sqlite3`) |
| `storage` | This repository’s writer / reader / snapshot / platform / wheel primitives |
| `sql` | SQL text executed by this repository’s own engine |

Floors are env-overridable (`TS_EXTERNAL_FLOOR`, `TS_STORAGE_FLOOR`, `TS_SQL_FLOOR`, `PY_*`). The harness fails on suite failures, under-floor counts, skips, or suite sources that stop calling a real external oracle. Details: [harness.md](./harness.md).

Do not treat `skipped` / `unverified` as pass. Truth source is an external engine or official corpus — never this implementation as the expected value for itself.
