# SQLite

Distribution shell for the SQLite format-3 product (snapshot import / export).

Rust codecs live in the aggregated [`database.rs`](https://github.com/oovm/database.rs) workspace
(`sqlite-formats`, `sqlite-storage`, `sqlite`). This repo owns FFI, packaging, and branding — same
shape as `yydb` / `yyds` / `iris-orm`.

A fail-closed SQL subset (`CREATE TABLE`, `INSERT`, `SELECT` with optional `WHERE`, `ORDER BY` and
`LIMIT`) runs over this repository's own format-3 writer in the `sqlite` facade
(`projects/facades/sqlite/src/sql` in the aggregated `database.rs` workspace) and is
exposed by the Node-API, PyO3 and WebAssembly bindings. `WHERE` accepts plain predicates (comparisons,
`AND` / `OR` / `NOT`, `IS [NOT] NULL`, column references and literals). Richer SQL (joins, `GROUP BY`,
aggregates beyond `count(*)`, subqueries) is rejected with a structured error and is **not** here.

## Layout

| Path | Role |
|------|------|
| `projects/sqlite.rs/` | Rust FFI workspace (`sqlite-napi` produces `sqlite.node`, shared SQL core comes from the `sqlite` facade) |
| `projects/sqlite.ts/` | TypeScript packages, platform packages, homepage and acceptance suite |
| `projects/sqlite.ts/packages/sqlite/` | TypeScript binding over `sqlite.node` |
| `projects/sqlite.ts/packages/sqlite-harness/` | Self-improvement toolbox: `test`, `bench`, `conformance`, `fixtures`, `oracle` |
| `projects/sqlite.ts/packages/sqlite-fixtures/` | Binary fixtures written by external engines |
| `projects/sqlite.ts/platforms/` | Node platform packages plus the WebAssembly package |
| `projects/sqlite.ts/homepage/` | Capability and binding documents |
| `projects/sqlite.py/packages/sqlite/` | PyO3 packaging metadata plus the Python acceptance suite for the `sqlite-format3` wheel |

```shell
cargo check --manifest-path projects/sqlite.rs/Cargo.toml --workspace
```

Toolchain: `projects/sqlite.rs/rust-toolchain.toml` (`nightly`).

Core crates come from `database.rs` via git `rev` in `Cargo.toml`. Local absolute path overrides go
in `projects/sqlite.rs/.cargo/config.toml` (see `config.example.toml`).

## Test entry points

```shell
# build `sqlite.node`, run both suites and all three platform smokes
node projects/sqlite.ts/packages/sqlite-harness/bin/cli.mjs test

# one suite at a time
cd projects/sqlite.ts/packages/sqlite && node --experimental-strip-types --test "tests/**/*.test.ts"
cd projects/sqlite.py/packages/sqlite && python -m unittest discover -v -s tests -t tests

# Rust keeps a single smoke: it compiles, opens a database and round-trips one row
cargo test --release --workspace
```

`node scripts/check-test-floor.mjs` delegates to `projects/sqlite.ts/packages/sqlite-harness`, so CI and local runs share one
implementation. Coverage is reported as three independent layers, never as one aggregate:

| Layer | What it counts | Current floor |
|-------|----------------|---------------|
| `external` | Cross-engine conformance judged by `better-sqlite3`, `node:sqlite`, `sql.js` and the CPython `sqlite3` module. Reported but not repository coverage | 283 TS + 265 PY |
| `storage` | This repository's writer / reader / snapshot primitives, platform packages and the installed wheel | 62 TS + 35 PY + 31 stage assertions |
| `sql` | SQL text executed by this repository's own engine | 8 TS + 0 PY + 56 stage assertions |

The Python SQL acceptance runs against the installed wheel inside `platforms/python`, so it is
reported by the stage rather than counted again as a Python suite case.

The floors are overridable through `TS_EXTERNAL_FLOOR`, `TS_STORAGE_FLOOR`, `TS_SQL_FLOOR`,
`PY_EXTERNAL_FLOOR`, `PY_STORAGE_FLOOR` and `PY_SQL_FLOOR`. The harness fails when a suite reports
a failure, executes fewer cases than its layer floor, or skips a case. Platform stages report
assertion counts and keep the written row count in a separate `rows` (data volume) field, with a
separate SQL assertion floor per stage. It also reads the suite sources and fails if they stop
calling a real external engine (`better-sqlite3`, Python `sqlite3`, `PRAGMA integrity_check`).
There is no JSON metadata and no allowlist.

### `projects/sqlite.ts/packages/sqlite/tests`

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
| `sql-semantics.test.ts` | 283 | `sql-*.json` corpus judged by three external builds at once (`better-sqlite3`, `node:sqlite`, `sql.js`) |
| `sql-engine.test.ts` | 8 | this repository's SQL engine: statement envelopes, batches, structured rejections, blobs, and a snapshot read by `better-sqlite3` |

### `projects/sqlite.py/packages/sqlite/tests`

| File | Cases | Coverage |
|------|-------|----------|
| `test_format3.py` | 13 | format-3 reader/writer parity |
| `test_scenarios.py` | 15 | end-to-end scenarios against Python `sqlite3` |
| `test_edges.py` | 5 | 65536 page size, composite WITHOUT ROWID, exact page counts, seeded differential stream, fixture and rejection boundaries |
| `test_wal_journal.py` | 2 | WAL and hot journal semantics |
| `test_sql_semantics.py` | 265 | the shared `sql-*.json` corpus replayed on Python's standard-library `sqlite3` |

## Branch

`dev` is the default branch and holds all work. `master` is kept only for the initial commit, so
clone normally:

```shell
git clone https://github.com/yy-database/SQLite.git
```
