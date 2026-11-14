# Benchmark report

Command: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
Defaults: `BENCH_ROWS=5000`, `BENCH_TXN=1000`, `BENCH_PAGE=4096`, `BENCH_ROUNDS=3`, `BENCH_POINT=1000`, `BENCH_RANGE=200`, `BENCH_MUTATE=1000`, `BENCH_LIMIT=200`, `BENCH_AGG=20`, `BENCH_JOIN=10`, `BENCH_DISTINCT=5`, `BENCH_SUBQUERY=20`, `BENCH_MULTI=10`, `BENCH_UPSERT=500`, `BENCH_SYNCHRONOUS=off`
Baseline: `node:sqlite` (`DatabaseSync`) = `1.00x`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.

## Provenance

- node: `v24.18.0`
- rustc: `rustc 1.101.0-nightly (1c3a65069 2026-11-02)`
- repo rev: `3e60280`
- binding rev (`database.rs` pin in `projects/sqlite.rs/Cargo.toml`): `ee57ada`
- data: `5000` rows (page `4096`), `BENCH_ROUNDS=3`, point/indexed `1000`, range `200`, order_limit `200`, group_by `20`, join `10`, distinct `5`, subquery `20`, multi `10x100`, upsert `500`, mutate `1000`

## Relative to `node:sqlite`

| Workload | node:sqlite | @yydb/sqlite | better-sqlite3 | sql.js | @yydb/sqlite-unknown-wasm32 |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | 1.00x | 1.61x | **0.81x** | 2.88x | 5.82x |
| batch_sql | 1.00x | 10.48x | **0.96x** | 1.03x | n/a |
| scan | 1.00x | 1.94x | **0.54x** | 1.27x | 2.02x |
| point | 1.00x | **0.27x** | 0.82x | 0.46x | n/a |
| point_sql | 1.00x | 0.93x | 0.82x | **0.46x** | 0.62x |
| point_param | 1.00x | 0.57x | 0.82x | **0.46x** | n/a |
| point_uk | 1.00x | 1.87x | 0.90x | **0.51x** | n/a |
| range | 1.00x | 1.51x | **0.82x** | 1.96x | 26.02x |
| indexed | 1.00x | 1.38x | 1.75x | **0.50x** | n/a |
| order_limit | 1.00x | 1.71x | **0.86x** | 1.89x | 1.07x |
| group_by | **1.00x** | 2.42x | 1.27x | 2.15x | 1.55x |
| join | **1.00x** | 8.88x | 1.31x | 2.16x | 7.06x |
| distinct | 1.00x | 2.93x | **0.77x** | n/a | n/a |
| aggregate | 1.00x | 2.90x | **0.97x** | n/a | n/a |
| subquery | 1.00x | 6.67x | **0.82x** | n/a | n/a |
| index_range | 1.00x | 6.22x | **0.82x** | n/a | n/a |
| insert_multi | **1.00x** | 9.27x | 1.05x | n/a | n/a |
| upsert | **1.00x** | 16.50x | 1.07x | n/a | n/a |
| upsert_param | **1.00x** | 9.02x | 1.07x | n/a | n/a |
| update | **1.00x** | 3.85x | 1.29x | 2.64x | n/a |
| update_sql | **1.00x** | 21.10x | 1.29x | 2.64x | n/a |
| update_idx | **1.00x** | 19.57x | 1.21x | 1.28x | n/a |
| delete | 1.00x | 0.35x | 1.17x | **0.19x** | n/a |
| delete_sql | 1.00x | 1.54x | 1.17x | **0.19x** | n/a |
| delete_idx | **1.00x** | 19.18x | 1.58x | 1.34x | n/a |
| txn | **1.00x** | 13.46x | 1.37x | 7.21x | n/a |
| rollback | 1.00x | 1.07x | 1.20x | **0.97x** | n/a |
| open | **1.00x** | 3.88x | 1.92x | 1.81x | n/a |

## Absolute round timings (median / p95 ms)

| Workload | node:sqlite median / p95 (ms) | @yydb/sqlite median / p95 (ms) | better-sqlite3 median / p95 (ms) | sql.js median / p95 (ms) | @yydb/sqlite-unknown-wasm32 median / p95 (ms) |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | 6.84 / 7.91 | 11.00 / 13.13 | 5.53 / 8.50 | 19.69 / 35.12 | 39.82 / 68.17 |
| batch_sql | 4.06 / 6.26 | 42.59 / 46.28 | 3.92 / 3.94 | 4.18 / 4.28 | n/a |
| scan | 2.65 / 3.96 | 5.13 / 5.47 | 1.42 / 2.75 | 3.36 / 4.15 | 5.34 / 11.96 |
| point | 26.31 / 37.93 | 7.08 / 7.24 | 21.57 / 22.25 | 11.97 / 13.98 | n/a |
| point_sql | 26.31 / 37.93 | 24.52 / 25.18 | 21.57 / 22.25 | 11.97 / 13.98 | 16.24 / 20.58 |
| point_param | 26.31 / 37.93 | 14.89 / 15.78 | 21.57 / 22.25 | 11.97 / 13.98 | n/a |
| point_uk | 23.17 / 24.26 | 43.38 / 57.04 | 20.82 / 21.67 | 11.86 / 12.54 | n/a |
| range | 10.26 / 10.69 | 15.53 / 16.36 | 8.37 / 9.06 | 20.11 / 20.37 | 266.81 / 299.10 |
| indexed | 22.11 / 22.67 | 30.57 / 33.95 | 38.68 / 43.98 | 11.11 / 11.98 | n/a |
| order_limit | 8.62 / 8.92 | 14.73 / 14.77 | 7.42 / 11.53 | 16.29 / 17.22 | 9.22 / 9.63 |
| group_by | 22.33 / 23.78 | 54.05 / 62.10 | 28.25 / 39.10 | 47.94 / 49.04 | 34.69 / 35.75 |
| join | 2.02 / 2.33 | 17.93 / 18.06 | 2.65 / 2.65 | 4.37 / 4.49 | 14.25 / 14.43 |
| distinct | 8.82 / 10.39 | 25.86 / 26.28 | 6.78 / 7.08 | n/a | n/a |
| aggregate | 8.85 / 9.85 | 25.63 / 25.89 | 8.63 / 12.69 | n/a | n/a |
| subquery | 6.98 / 7.19 | 46.53 / 50.06 | 5.76 / 5.88 | n/a | n/a |
| index_range | 32.74 / 36.82 | 203.67 / 217.97 | 26.79 / 27.44 | n/a | n/a |
| insert_multi | 0.72 / 0.74 | 6.67 / 9.19 | 0.75 / 1.09 | n/a | n/a |
| upsert | 0.64 / 6.78 | 10.63 / 11.27 | 0.69 / 6.08 | n/a | n/a |
| upsert_param | 0.64 / 6.78 | 5.81 / 6.00 | 0.69 / 6.08 | n/a | n/a |
| update | 0.78 / 7.85 | 3.00 / 3.39 | 1.01 / 7.68 | 2.05 / 2.17 | n/a |
| update_sql | 0.78 / 7.85 | 16.44 / 17.71 | 1.01 / 7.68 | 2.05 / 2.17 | n/a |
| update_idx | 1.02 / 1.18 | 19.97 / 20.90 | 1.24 / 2.48 | 1.30 / 1.40 | n/a |
| delete | 7.55 / 8.21 | 2.68 / 3.22 | 8.83 / 12.00 | 1.42 / 1.58 | n/a |
| delete_sql | 7.55 / 8.21 | 11.63 / 12.19 | 8.83 / 12.00 | 1.42 / 1.58 | n/a |
| delete_idx | 0.89 / 1.03 | 16.98 / 17.22 | 1.40 / 1.51 | 1.19 / 1.92 | n/a |
| txn | 0.66 / 0.67 | 8.91 / 10.84 | 0.90 / 0.98 | 4.77 / 5.01 | n/a |
| rollback | 2.33 / 2.62 | 2.50 / 3.09 | 2.80 / 3.22 | 2.27 / 2.71 | n/a |
| open | 0.05 / 0.11 | 0.20 / 0.21 | 0.10 / 0.21 | 0.09 / 0.22 | n/a |

## Workloads

- `batch`: create table, 5000 rows in transactions of 1000, save file. `BENCH_SYNCHRONOUS=on` moves every library to `synchronous=FULL`.
- `batch_sql`: the same row set through the public `new SQLite()` entry — one prepared INSERT inside one transaction on an in-memory database, against the peers' equivalent. This is the bulk-insert path users actually call, separate from the writer primitive in `batch`.
- `scan`: open + full table scan per round.
- `point`: reader `rowByRowid` vs each peer's prepared `get`.
- `point_sql`: our public `new SQLite()` `select ... where id = N` vs the same peer prepared `get` (peer cells reuse `point`).
- `point_param`: the same point lookup through a prepared statement with a **bound** key (`where id = ?`); peer cells reuse `point`. This separates the literal pushdown in `point_sql` from the bound-parameter pushdown.
- `point_uk`: point lookup through a **unique** index on `label`; our side runs `select ... where label = '...'` on `new SQLite()` carrying `create unique index`, peers through their unique index (one untimed warmup round first).
- `range`: 50-row `between` windows, reader `range` vs peers' prepared range.
- `indexed`: equality on an indexed `label` column; our side runs through `new SQLite()`, peers through their index.
- `order_limit`: `select ... order by id limit 50` — repeated 200x per round; separates the key-order scan constant from the per-statement fixed cost.
- `group_by`: `select cast(score as integer), count(*) ... group by cast(score as integer)` (20 queries per round, 1251 groups over 5000 rows).
- `join`: `select count(*) from items join items as b on b.id = items.id % 50` (10 queries per round, 4900 matched pairs) — exposes a nested full scan of the inner side.
- `distinct`: `select distinct label from items` (5 queries per round, 5000 distinct labels) — worst case for the dedup structure because nothing collapses.
- `aggregate`: `select count(*), sum(score), min(score), max(score) from items` (20 queries per round) — single-pass aggregate without grouping.
- `subquery`: `select count(*) ... where id in (select id from items where score > 1000)` (20 queries per round, 1000 matches) — uncorrelated `IN` subquery.
- `index_range`: `select id from items where label between 'row-1000' and 'row-1499' order by label` (200 queries per round, 553 rows) — range predicate on an indexed column.
- `insert_multi`: 10 statements of 100 literal rows in one transaction (1000 rows total).
- `upsert`: 500 `insert ... on conflict(id) do update` statements in one transaction.
- `upsert_param`: the same upsert through a prepared statement with bound values; peer cells reuse `upsert`. `upsert` re-parses interpolated SQL text, so the pair shows the parse cost separately from execution.
- `update` / `delete`: 1000 mutations in one transaction + save (our writer) vs peers' prepared mutation in a transaction.
- `update_sql` / `delete_sql`: 1000 prepared SQL mutations by bound rowid in one transaction on `new SQLite()`; peer cells reuse `update` / `delete`. These exercise the SQL write path (rowid narrowing) rather than the writer primitives.
- `update_idx` / `delete_idx`: 1000 prepared mutations by an **indexed** `label` column in one transaction, on an in-memory database with the same index on every engine. This covers the indexed write path (probe candidates instead of a full decode) and has no peer-cell reuse.
- `txn`: 1000 prepared INSERTs split into transactions of 10 (100 commits), on an in-memory database, so transaction boundaries rather than row count dominate.
- `rollback`: begin + 1000 inserts + rollback (nothing persisted).
- `open`: open + close of the main file, no reads.
- `@yydb/sqlite-unknown-wasm32` is the in-memory SQL binding: it runs `batch` (inserts + snapshot export + file write), `scan`, `point_sql`, `range`, `order_limit`, `group_by` and `join` through `exec`; it has no reader point API, no UPDATE/DELETE/indexes and no file open, so the remaining cells are `n/a`.

## Intentional deltas

- Our writer is snapshot-based: `update`/`delete` include the full-image `save()`; peers write in place through their pager.
- sql.js peer scan rebuilds the WASM DB from the serialized image each round; peer batch/update/delete timings include `export()`.
- `point_sql` has no separate peer path — peers' prepared `get` is the reference.
- The wasm column reads the same in-memory image every round (`SELECT` re-scans the image; the binding has no seek), and its `batch` includes `snapshot()` + the file write.
- sql.js and the wasm binding do not run the six SQL-feature workloads (`distinct`, `aggregate`, `subquery`, `index_range`, `insert_multi`, `upsert`), so those cells stay `n/a`; they are compared only on `node:sqlite` and `better-sqlite3`.
- `insert_multi` and `upsert` on our side run on an in-memory `new SQLite()`, while the two peer columns write through their file pager; the row set is validated on both sides.
- `batch_sql`, `update_idx`, `delete_idx` and `txn` run on an in-memory database on every engine, so no pager publication or file I/O is included. sql.js runs the same four through its prepared-statement API; the wasm binding has no UPDATE/DELETE/index support and stays `n/a`.
- The SQL-engine workloads (`point_param`, `point_uk`, `order_limit`, `group_by`, `join`, `distinct`, `aggregate`, `subquery`, `index_range`, `insert_multi`, `upsert`, `upsert_param`, `update_sql`, `delete_sql`) run one untimed warmup round before `BENCH_ROUNDS` timed rounds; median/p95 come from the harness `benchSummary`, not local stats.
- `batch`, `scan`, `point`, `range`, `update`, `delete`, `rollback` and `open` still use the format-3 writer/reader primitives. The public `SQLite` entry does not expose raw record decoding, `rowByRowid`/`range` rowid windows, or the full-image `save()` that these timings are defined on.

## Capabilities still missing from the public API

- Direct rowid point read (`rowByRowid`) and inclusive rowid range read (`range`) without SQL parsing.
- Raw record decoding via a table cursor (`openDatabase(...).table(...)`) for `scan`.
- Writer-side `update`/`delete` slots and the explicit full-image `save()` that `update`/`delete`/`batch` include in their timings.
- Writer `begin`/`rollback` without SQL transaction control, used by `rollback`.
- A pure open/close handle over the main file with no statement preparation, used by `open`.

Regenerate: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
