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
