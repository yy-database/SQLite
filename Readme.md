# SQLite

Distribution shell for the SQLite format-3 product (snapshot import / export).

Rust codecs live in the aggregated [`database.rs`](https://github.com/oovm/database.rs) workspace
(`sqlite-formats`, `sqlite-storage`, `sqlite`). This repo owns FFI, packaging, and branding —
same shape as `yydb` / `yyds` / `iris-orm`.

SQL dialect over `.yydb` is **not** here; that surface is `yydb::sql::SqliteConnection`.

## Layout

| Path | Role |
|------|------|
| `projects/sqlite.rs/` | Rust FFI workspace |
| `projects/sqlite.rs/sqlite-napi` | Node-API bindings |

```shell
cargo check --manifest-path projects/sqlite.rs/Cargo.toml --workspace
```

Pinned toolchain: `projects/sqlite.rs/rust-toolchain.toml` (`nightly-2026-07-20`).

Core crates come from `database.rs` via git `rev` in `Cargo.toml`. Local absolute path overrides go in `projects/sqlite.rs/.cargo/config.toml` (see `config.example.toml`).

## Branch

Work happens on `dev`. The `master` branch only holds the initial commit, so a plain clone lands on an empty shell:

```shell
git clone --branch dev https://github.com/yy-database/SQLite.git
```

## Contract gate

`node scripts/check-test-floor.mjs` builds `sqlite.node` and runs both `sqlite.ts` and `sqlite.py`. Each suite must execute at least 15 cases and report zero skips. Every case must also declare its external truth source and direction in `scripts/external-truth.json`, and each capability must be proven in both directions against Python `sqlite3`, `better-sqlite3` or `PRAGMA integrity_check`. CI runs the same script in `.github/workflows/contract.yml`, and it asserts the checkout has no prebuilt `sqlite.node` before the build step.

