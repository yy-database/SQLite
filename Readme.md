# SQLite

Distribution shell for the SQLite format-3 product (snapshot import / export).

Rust codecs live in the aggregated [`database.rs`](https://github.com/oovm/database.rs) workspace
(`sqlite-formats`, `sqlite-storage`, `sqlite`). This repo owns FFI, packaging, and branding — same
shape as `yydb` / `yyds` / `iris-orm`.

SQL dialect over `.yydb` is **not** here; that surface is `yydb::sql::SqliteConnection`.

## Layout

| Path | Role |
|------|------|
| `projects/sqlite.rs/` | Rust FFI workspace (`sqlite-napi` produces `sqlite.node`) |
| `projects/sqlite.ts/` | TypeScript binding over `sqlite.node` plus the acceptance suite |
| `projects/sqlite.py/` | Python bridge (`bridge.mjs`) over `sqlite.node` plus the acceptance suite |
| `tests/fixtures/` | Shared binary fixtures (`blank.sqlite`) |
| `harness/run.mjs` | One-command acceptance harness (build, run both suites, gate) |

```shell
cargo check --manifest-path projects/sqlite.rs/Cargo.toml --workspace
```

Pinned toolchain: `projects/sqlite.rs/rust-toolchain.toml` (`nightly-2026-07-20`).

Core crates come from `database.rs` via git `rev` in `Cargo.toml`. Local absolute path overrides go
in `projects/sqlite.rs/.cargo/config.toml` (see `config.example.toml`).

## Test entry points

```shell
# build `sqlite.node`, run both suites, enforce the floor
node harness/run.mjs

# one suite at a time
cd projects/sqlite.ts && node --experimental-strip-types --test "tests/**/*.test.ts"
cd projects/sqlite.py && python -m unittest discover -v -s tests -t tests
```

`node scripts/check-test-floor.mjs` delegates to `harness/run.mjs`, so CI and local runs share one
implementation. The harness fails when either suite reports a failure, executes fewer than 30 cases,
or skips a case. It also reads the suite sources and fails if they stop calling a real external
engine (`better-sqlite3`, Python `sqlite3`, `PRAGMA integrity_check`). There is no JSON metadata and
no allowlist.

### `projects/sqlite.ts/tests`

| File | Cases | Coverage |
|------|-------|----------|
| `format3.test.ts` | 13 | header, splits, dividers, overflow, serial types, affinity, rowid alias, schema, indexes, update/delete/rollback, WITHOUT ROWID read, UTF-16 read, views/STRICT/virtual tables |
| `scenarios.test.ts` | 15 | end-to-end scenarios against `better-sqlite3` and Python `sqlite3` |
| `boundary.test.ts` | 6 | snapshot byte/limit boundaries, truncation, missing names, virtual tables, view depth, `decodeRecord` |
| `edge-cases.test.ts` | 4 | 65536 page size, composite PRIMARY KEY WITHOUT ROWID, exact page counts, catalog root pages |
| `differential.test.ts` | 3 | seeded insert/update/delete streams replayed against `better-sqlite3` and Python `sqlite3`, index scan parity |
| `corpus.test.ts` | 2 | externally written corpus (all storage classes, index/view/STRICT), UTF-16LE and UTF-16BE |
| `stress-matrix.test.ts` | 7 | 10k-row sequential/shuffled/bulk/hollow/overflow/index-churn loads, Python oracle |
| `wal-journal.test.ts` | 2 | committed WAL frames and hot rollback journal semantics |

### `projects/sqlite.py/tests`

| File | Cases | Coverage |
|------|-------|----------|
| `test_format3.py` | 13 | format-3 reader/writer parity |
| `test_scenarios.py` | 15 | end-to-end scenarios against Python `sqlite3` |
| `test_edges.py` | 5 | 65536 page size, composite WITHOUT ROWID, exact page counts, seeded differential stream, fixture and rejection boundaries |
| `test_wal_journal.py` | 2 | WAL and hot journal semantics |

## Branch

`dev` is the default branch and holds all work. `master` is kept only for the initial commit, so
clone normally:

```shell
git clone https://github.com/yy-database/SQLite.git
```
