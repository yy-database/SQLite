# Benchmark report

Command: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
Defaults: `BENCH_ROWS=5000`, `BENCH_TXN=1000`, `BENCH_PAGE=4096`, `BENCH_ROUNDS=3`, `BENCH_POINT=1000`, `BENCH_RANGE=200`, `BENCH_MUTATE=1000`, `BENCH_LIMIT=200`, `BENCH_AGG=20`, `BENCH_JOIN=10`, `BENCH_DISTINCT=5`, `BENCH_SUBQUERY=20`, `BENCH_MULTI=10`, `BENCH_UPSERT=500`, `BENCH_SYNCHRONOUS=off`
Baseline: `node:sqlite` (`DatabaseSync`) = `1.00x`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.

## Provenance

- node: `v24.18.0`
- rustc: `rustc 1.101.0-nightly (1c3a65069 2026-11-02)`
- repo rev: `3dc8f93`
- binding rev (`database.rs` pin in `projects/sqlite.rs/Cargo.toml`): `d07cb5d`
- data: `5000` rows (page `4096`), `BENCH_ROUNDS=3`, point/indexed `1000`, range `200`, order_limit `200`, group_by `20`, join `10`, distinct `5`, subquery `20`, multi `10x100`, upsert `500`, mutate `1000`

## Relative to `node:sqlite`

| Workload | node:sqlite | @yydb/sqlite | better-sqlite3 | sql.js | @yydb/sqlite-unknown-wasm32 |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | **1.00x** | 4.08x | 1.14x | 4.76x | 10.87x |
| scan | **1.00x** | 2.63x | 1.31x | 2.80x | 2.87x |
| point | 1.00x | **0.24x** | 1.15x | 0.74x | n/a |
| point_sql | 1.00x | 0.94x | 1.15x | 0.74x | **0.74x** |
| point_param | 1.00x | **0.49x** | 1.15x | 0.74x | n/a |
| point_uk | 1.00x | 1.31x | 1.06x | **0.52x** | n/a |
| range | 1.00x | 1.47x | **0.92x** | 2.27x | 27.88x |
| indexed | 1.00x | 0.90x | 1.01x | **0.52x** | n/a |
| order_limit | 1.00x | 1.08x | 1.09x | 1.58x | **0.87x** |
| group_by | 1.00x | 2.98x | **0.93x** | 2.66x | 2.18x |
| join | 1.00x | 5.40x | **0.98x** | 1.74x | 6.23x |
| distinct | 1.00x | 3.52x | **0.86x** | n/a | n/a |
| aggregate | **1.00x** | 4.20x | 1.34x | n/a | n/a |
| subquery | **1.00x** | 8.25x | 1.05x | n/a | n/a |
| index_range | 1.00x | 5.32x | **0.86x** | n/a | n/a |
| insert_multi | 1.00x | 4.51x | **0.91x** | n/a | n/a |
| upsert | 1.00x | 12.66x | **0.69x** | n/a | n/a |
| upsert_param | 1.00x | 6.98x | **0.69x** | n/a | n/a |
| update | 1.00x | 3.95x | **0.93x** | 1.28x | n/a |
| update_sql | 1.00x | 14.45x | **0.93x** | 1.28x | n/a |
| delete | 1.00x | 0.32x | 1.02x | **0.23x** | n/a |
| delete_sql | 1.00x | 1.43x | 1.02x | **0.23x** | n/a |
| rollback | **1.00x** | 1.22x | 1.19x | 1.28x | n/a |
| open | **1.00x** | 1.18x | 2.02x | 1.30x | n/a |

## Absolute round timings (median / p95 ms)

| Workload | node:sqlite median / p95 (ms) | @yydb/sqlite median / p95 (ms) | better-sqlite3 median / p95 (ms) | sql.js median / p95 (ms) | @yydb/sqlite-unknown-wasm32 median / p95 (ms) |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | 3.88 / 4.07 | 15.82 / 18.94 | 4.42 / 5.69 | 18.45 / 49.47 | 42.15 / 81.54 |
| scan | 1.85 / 2.87 | 4.86 / 5.73 | 2.42 / 2.86 | 5.17 / 11.36 | 5.30 / 11.86 |
| point | 25.75 / 27.28 | 6.21 / 6.34 | 29.73 / 32.57 | 19.02 / 20.79 | n/a |
| point_sql | 25.75 / 27.28 | 24.33 / 27.02 | 29.73 / 32.57 | 19.02 / 20.79 | 18.97 / 33.40 |
| point_param | 25.75 / 27.28 | 12.52 / 13.76 | 29.73 / 32.57 | 19.02 / 20.79 | n/a |
| point_uk | 25.73 / 27.50 | 33.61 / 33.94 | 27.17 / 29.50 | 13.32 / 13.80 | n/a |
| range | 9.07 / 9.31 | 13.30 / 14.89 | 8.37 / 11.22 | 20.61 / 34.21 | 252.92 / 255.61 |
| indexed | 25.18 / 25.47 | 22.78 / 25.37 | 25.32 / 26.48 | 13.09 / 14.42 | n/a |
| order_limit | 10.45 / 10.99 | 11.29 / 11.29 | 11.38 / 12.87 | 16.54 / 16.65 | 9.13 / 10.19 |
| group_by | 20.68 / 20.91 | 61.55 / 61.78 | 19.23 / 19.37 | 55.06 / 57.75 | 44.99 / 45.47 |
| join | 2.11 / 2.12 | 11.36 / 13.95 | 2.07 / 2.45 | 3.66 / 4.04 | 13.11 / 13.26 |
| distinct | 7.09 / 7.29 | 24.97 / 28.62 | 6.08 / 6.26 | n/a | n/a |
| aggregate | 6.63 / 6.64 | 27.82 / 29.08 | 8.88 / 10.19 | n/a | n/a |
| subquery | 4.71 / 4.79 | 38.82 / 43.66 | 4.96 / 5.10 | n/a | n/a |
| index_range | 28.80 / 33.54 | 153.08 / 176.04 | 24.77 / 25.03 | n/a | n/a |
| insert_multi | 0.73 / 0.77 | 3.28 / 3.70 | 0.66 / 0.93 | n/a | n/a |
| upsert | 0.82 / 7.16 | 10.40 / 10.51 | 0.56 / 17.28 | n/a | n/a |
| upsert_param | 0.82 / 7.16 | 5.73 / 5.81 | 0.56 / 17.28 | n/a | n/a |
| update | 1.01 / 6.41 | 3.99 / 4.22 | 0.94 / 7.53 | 1.30 / 2.03 | n/a |
| update_sql | 1.01 / 6.41 | 14.59 / 15.40 | 0.94 / 7.53 | 1.30 / 2.03 | n/a |
| delete | 7.86 / 8.05 | 2.51 / 2.62 | 7.99 / 8.52 | 1.80 / 4.29 | n/a |
| delete_sql | 7.86 / 8.05 | 11.20 / 11.84 | 7.99 / 8.52 | 1.80 / 4.29 | n/a |
| rollback | 2.33 / 2.35 | 2.84 / 2.97 | 2.77 / 2.88 | 2.97 / 3.06 | n/a |
| open | 0.08 / 0.17 | 0.10 / 0.11 | 0.17 / 0.28 | 0.11 / 0.18 | n/a |

## Workloads

- `batch`: create table, 5000 rows in transactions of 1000, save file. `BENCH_SYNCHRONOUS=on` moves every library to `synchronous=FULL`.
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
- The SQL-engine workloads (`point_param`, `point_uk`, `order_limit`, `group_by`, `join`, `distinct`, `aggregate`, `subquery`, `index_range`, `insert_multi`, `upsert`, `upsert_param`, `update_sql`, `delete_sql`) run one untimed warmup round before `BENCH_ROUNDS` timed rounds; median/p95 come from the harness `benchSummary`, not local stats.
- `batch`, `scan`, `point`, `range`, `update`, `delete`, `rollback` and `open` still use the format-3 writer/reader primitives. The public `SQLite` entry does not expose raw record decoding, `rowByRowid`/`range` rowid windows, or the full-image `save()` that these timings are defined on.

## Capabilities still missing from the public API

- Direct rowid point read (`rowByRowid`) and inclusive rowid range read (`range`) without SQL parsing.
- Raw record decoding via a table cursor (`openDatabase(...).table(...)`) for `scan`.
- Writer-side `update`/`delete` slots and the explicit full-image `save()` that `update`/`delete`/`batch` include in their timings.
- Writer `begin`/`rollback` without SQL transaction control, used by `rollback`.
- A pure open/close handle over the main file with no statement preparation, used by `open`.

Regenerate: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
