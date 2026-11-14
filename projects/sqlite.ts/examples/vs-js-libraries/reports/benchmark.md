# Benchmark report

Command: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
Defaults: `BENCH_ROWS=5000`, `BENCH_TXN=1000`, `BENCH_PAGE=4096`, `BENCH_ROUNDS=3`, `BENCH_POINT=1000`, `BENCH_RANGE=200`, `BENCH_MUTATE=1000`, `BENCH_LIMIT=200`, `BENCH_AGG=20`, `BENCH_JOIN=10`, `BENCH_DISTINCT=5`, `BENCH_SUBQUERY=20`, `BENCH_MULTI=10`, `BENCH_UPSERT=500`, `BENCH_SYNCHRONOUS=off`
Baseline: `node:sqlite` (`DatabaseSync`) = `1.00x`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.

## Provenance

- node: `v24.18.0`
- rustc: `rustc 1.101.0-nightly (1c3a65069 2026-11-02)`
- repo rev: `812405f`
- binding rev (`database.rs` pin in `projects/sqlite.rs/Cargo.toml`): `70aee1e`
- data: `5000` rows (page `4096`), `BENCH_ROUNDS=3`, point/indexed `1000`, range `200`, order_limit `200`, group_by `20`, join `10`, distinct `5`, subquery `20`, multi `10x100`, upsert `500`, mutate `1000`, projection `10`, join_indexed `10`

## Relative to `node:sqlite`

| Workload | node:sqlite | @yydb/sqlite | better-sqlite3 | sql.js | @yydb/sqlite-unknown-wasm32 |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | **1.00x** | 2.29x | 1.24x | 5.16x | 9.74x |
| batch_sql | **1.00x** | 11.30x | 1.96x | 2.54x | n/a |
| scan | 1.00x | 1.65x | **0.78x** | 1.65x | 2.20x |
| point | 1.00x | **0.24x** | 1.25x | 0.71x | n/a |
| point_sql | 1.00x | **0.62x** | 1.25x | 0.71x | 0.76x |
| point_param | 1.00x | **0.31x** | 1.25x | 0.71x | n/a |
| point_uk | 1.00x | 0.72x | 1.20x | **0.71x** | n/a |
| range | 1.00x | **0.89x** | 1.17x | 3.84x | 1.71x |
| indexed | 1.00x | 0.76x | 1.29x | **0.61x** | n/a |
| order_limit | **1.00x** | 1.04x | 1.10x | 2.42x | 1.33x |
| group_by | 1.00x | 1.73x | **0.80x** | 3.29x | 2.10x |
| join | **1.00x** | 4.96x | 1.14x | 3.43x | 9.07x |
| distinct | 1.00x | 2.49x | **0.82x** | n/a | n/a |
| aggregate | **1.00x** | 2.94x | 1.12x | n/a | n/a |
| subquery | 1.00x | 6.67x | **0.99x** | n/a | n/a |
| index_range | 1.00x | 3.78x | **0.69x** | n/a | n/a |
| insert_multi | 1.00x | 4.00x | **0.83x** | n/a | n/a |
| upsert | 1.00x | 13.29x | **0.97x** | n/a | n/a |
| upsert_param | 1.00x | 6.54x | **0.97x** | n/a | n/a |
| update | **1.00x** | 3.36x | 1.12x | 4.16x | n/a |
| update_sql | **1.00x** | 12.11x | 1.12x | 4.16x | n/a |
| update_idx | **1.00x** | 13.44x | 1.16x | 1.83x | n/a |
| delete | 1.00x | 0.47x | 0.94x | **0.30x** | n/a |
| delete_sql | 1.00x | 1.79x | 0.94x | **0.30x** | n/a |
| delete_idx | **1.00x** | 23.11x | 1.69x | 3.62x | n/a |
| txn | **1.00x** | 16.03x | 1.07x | 10.59x | n/a |
| rollback | 1.00x | **0.71x** | 0.88x | 1.83x | n/a |
| open | **1.00x** | 1.30x | 1.26x | 1.26x | n/a |
| in_list | **1.00x** | 2.12x | 1.20x | n/a | 5.94x |
| sort_mixed | **1.00x** | 1.83x | 1.68x | n/a | 2.39x |
| like_prefix | **1.00x** | 6.74x | 1.71x | n/a | 9.42x |
| delete_range | **1.00x** | 27.61x | 1.66x | n/a | n/a |
| update_expr | **1.00x** | 30.85x | 2.83x | n/a | n/a |
| projection_narrow | **1.00x** | 2.38x | 1.22x | 5.67x | 2.38x |
| projection_wide | **1.00x** | 1.99x | 1.38x | 6.56x | 2.64x |
| join_indexed | 1.00x | 61.80x | 0.82x | **0.59x** | n/a |
| delete_index_range | **1.00x** | 22.97x | 1.34x | 7.06x | n/a |
| or_filter | **1.00x** | 15.17x | 1.81x | 2.75x | 21.47x |

## Absolute round timings (median / p95 ms)

| Workload | node:sqlite median / p95 (ms) | @yydb/sqlite median / p95 (ms) | better-sqlite3 median / p95 (ms) | sql.js median / p95 (ms) | @yydb/sqlite-unknown-wasm32 median / p95 (ms) |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | 6.71 / 6.83 | 15.33 / 15.67 | 8.30 / 9.26 | 34.62 / 61.29 | 65.33 / 96.89 |
| batch_sql | 4.27 / 4.32 | 48.22 / 56.84 | 8.36 / 9.88 | 10.86 / 11.08 | n/a |
| scan | 3.36 / 3.92 | 5.53 / 5.58 | 2.64 / 3.32 | 5.55 / 7.92 | 7.37 / 15.89 |
| point | 32.15 / 32.59 | 7.77 / 8.35 | 40.12 / 40.35 | 22.95 / 23.85 | n/a |
| point_sql | 32.15 / 32.59 | 19.94 / 22.51 | 40.12 / 40.35 | 22.95 / 23.85 | 24.38 / 34.90 |
| point_param | 32.15 / 32.59 | 10.10 / 10.85 | 40.12 / 40.35 | 22.95 / 23.85 | n/a |
| point_uk | 32.06 / 33.31 | 22.95 / 23.68 | 38.51 / 40.87 | 22.88 / 23.18 | n/a |
| range | 12.05 / 12.66 | 10.72 / 11.76 | 14.06 / 15.19 | 46.25 / 47.22 | 20.61 / 24.35 |
| indexed | 33.53 / 35.48 | 25.60 / 25.65 | 43.35 / 43.46 | 20.38 / 22.01 | n/a |
| order_limit | 12.61 / 12.84 | 13.13 / 13.34 | 13.82 / 15.70 | 30.47 / 30.62 | 16.81 / 16.82 |
| group_by | 28.47 / 33.58 | 49.21 / 53.24 | 22.83 / 23.88 | 93.57 / 100.80 | 59.71 / 61.61 |
| join | 2.85 / 2.94 | 14.15 / 14.90 | 3.24 / 3.28 | 9.79 / 10.00 | 25.85 / 27.88 |
| distinct | 9.11 / 9.87 | 22.70 / 25.73 | 7.51 / 9.11 | n/a | n/a |
| aggregate | 8.46 / 8.56 | 24.90 / 25.34 | 9.52 / 9.79 | n/a | n/a |
| subquery | 6.01 / 6.18 | 40.11 / 40.31 | 5.93 / 6.09 | n/a | n/a |
| index_range | 40.85 / 44.70 | 154.36 / 166.47 | 28.14 / 29.71 | n/a | n/a |
| insert_multi | 0.99 / 1.21 | 3.97 / 4.66 | 0.82 / 0.99 | n/a | n/a |
| upsert | 0.81 / 19.88 | 10.78 / 11.52 | 0.78 / 17.08 | n/a | n/a |
| upsert_param | 0.81 / 19.88 | 5.30 / 5.52 | 0.78 / 17.08 | n/a | n/a |
| update | 0.86 / 7.32 | 2.89 / 3.40 | 0.96 / 7.91 | 3.58 / 3.86 | n/a |
| update_sql | 0.86 / 7.32 | 10.42 / 11.04 | 0.96 / 7.91 | 3.58 / 3.86 | n/a |
| update_idx | 1.18 / 1.23 | 15.84 / 16.10 | 1.37 / 1.83 | 2.16 / 2.44 | n/a |
| delete | 7.95 / 8.41 | 3.71 / 3.82 | 7.50 / 8.84 | 2.35 / 4.31 | n/a |
| delete_sql | 7.95 / 8.41 | 14.25 / 16.27 | 7.50 / 8.84 | 2.35 / 4.31 | n/a |
| delete_idx | 1.10 / 1.20 | 25.45 / 25.90 | 1.86 / 2.07 | 3.98 / 4.36 | n/a |
| txn | 0.98 / 1.21 | 15.73 / 15.92 | 1.05 / 1.12 | 10.39 / 11.46 | n/a |
| rollback | 3.37 / 3.39 | 2.40 / 3.14 | 2.95 / 3.15 | 6.15 / 7.71 | n/a |
| open | 0.09 / 0.15 | 0.11 / 0.16 | 0.11 / 0.22 | 0.11 / 0.24 | n/a |
| in_list | 0.93 / 0.95 | 1.97 / 1.98 | 1.11 / 1.22 | n/a | 5.52 / 6.25 |
| sort_mixed | 18.93 / 20.58 | 34.66 / 36.09 | 31.74 / 32.12 | n/a | 45.24 / 46.59 |
| like_prefix | 4.37 / 4.38 | 29.48 / 31.13 | 7.46 / 7.66 | n/a | 41.17 / 43.62 |
| delete_range | 0.08 / 0.09 | 2.21 / 3.20 | 0.13 / 0.17 | n/a | n/a |
| update_expr | 0.43 / 0.46 | 13.15 / 14.23 | 1.21 / 1.25 | n/a | n/a |
| projection_narrow | 12.23 / 12.66 | 29.16 / 29.24 | 14.91 / 14.99 | 69.39 / 70.76 | 29.10 / 29.55 |
| projection_wide | 20.05 / 22.33 | 39.94 / 42.56 | 27.63 / 29.54 | 131.51 / 156.81 | 52.87 / 59.07 |
| join_indexed | 0.33 / 0.50 | 20.17 / 20.96 | 0.27 / 0.28 | 0.19 / 0.21 | n/a |
| delete_index_range | 0.03 / 0.06 | 0.64 / 3.75 | 0.04 / 0.05 | 0.20 / 0.22 | n/a |
| or_filter | 2.13 / 2.24 | 32.25 / 32.37 | 3.85 / 3.94 | 5.84 / 6.70 | 45.64 / 51.60 |

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
- `in_list`: `select count(*) ... where id in (<100 scattered rowids>)` (20 queries per round, 100 matches) — literal `IN` list planning and predicate dispatch.
- `sort_mixed`: `select ... order by score desc, id desc limit 50` (20 queries per round) — unindexed sort plus truncation.
- `like_prefix`: `select count(*) ... where label like 'row-1%'` (20 queries per round, 1111 matches) — prefix pattern over an unindexed full scan, with the row count asserted on every engine.
- `projection_narrow` / `projection_wide`: the same 5000-row scan projected to one column (`select id`) vs every column (`select *`), 10x per round. The pair isolates per-column decoding and row-copy cost from the scan itself.
- `join_indexed`: `select count(*) ... where a.id <= 20 join ... on b.label = a.label` (10 queries per round, 20 matches) — the equality join runs on an indexed `label` column on every engine, so it measures the index probe instead of the nested scan in `join`.
- `delete_index_range`: one `delete ... where label between 'row-1000' and 'row-1099'` in a transaction on an in-memory database carrying the `label` index (109 rows removed, the surviving count asserted), then the interval is re-inserted outside the timed window. This is the index-driven bulk delete path, against the rowid path in `delete_range`.
- `or_filter`: `select count(*) ... where id < 1000 or label > 'row-4500'` (20 queries per round, 1499 matches) — a cross-column `OR` where neither side can be answered by a single-column pushdown.
- `delete_range`: one `delete from items where id between 1000 and 1999` in a transaction on an in-memory database (1000 rows removed, the surviving count asserted), then the deleted interval is re-inserted outside the timed window. This is the bulk range-delete path rather than the per-rowid loop in `delete`/`delete_sql`.
- `update_expr`: one `update items set score = score + 1` over every row in a transaction (5000 rows updated, `score` of row 1 asserted to include every run), then the next round updates again. This pins the whole-table write path and its per-row conflict detection instead of a single-rowid update.
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
- `@yydb/sqlite-unknown-wasm32` is the in-memory SQL binding: it runs `batch` (inserts + snapshot export + file write), `scan`, `point_sql`, `range`, `order_limit`, `group_by`, `join`, `in_list`, `sort_mixed`, `like_prefix`, `projection_narrow`, `projection_wide` and `or_filter` through `exec`; it has no reader point API, no UPDATE/DELETE/indexes and no file open, so the remaining cells are `n/a`.

## Intentional deltas

- Our writer is snapshot-based: `update`/`delete` include the full-image `save()`; peers write in place through their pager.
- sql.js peer scan rebuilds the WASM DB from the serialized image each round; peer batch/update/delete timings include `export()`.
- `point_sql` has no separate peer path — peers' prepared `get` is the reference.
- The wasm column reads the same in-memory image every round (`SELECT` re-scans the image; the binding has no seek), and its `batch` includes `snapshot()` + the file write.
- sql.js does not run the SQL-feature workloads (`distinct`, `aggregate`, `subquery`, `index_range`, `insert_multi`, `upsert`, `in_list`, `sort_mixed`, `like_prefix`, `delete_range`, `update_expr`), so those cells stay `n/a`; the wasm binding runs `in_list`, `sort_mixed`, `like_prefix`, `projection_narrow`, `projection_wide` and `or_filter` but not the mutation/index ones.
- `insert_multi`, `upsert`, `update_expr` and `delete_range` on our side run on an in-memory `new SQLite()`, while the two peer columns write through their pager; the row set is validated on both sides.
- `batch_sql`, `update_idx`, `delete_idx`, `txn`, `update_expr` and `delete_range` run on an in-memory database on every engine, so no pager publication or file I/O is included. sql.js runs the SQL ones through its prepared-statement API; the wasm binding has no UPDATE/DELETE/index support and stays `n/a`.
- The SQL-engine workloads (`point_param`, `point_uk`, `order_limit`, `group_by`, `join`, `distinct`, `aggregate`, `subquery`, `in_list`, `sort_mixed`, `like_prefix`, `or_filter`, `projection_narrow`, `projection_wide`, `join_indexed`, `index_range`, `insert_multi`, `upsert`, `upsert_param`, `update_sql`, `delete_sql`, `update_expr`, `delete_range`, `delete_index_range`) run one untimed warmup round before `BENCH_ROUNDS` timed rounds; median/p95 come from the harness `benchSummary`, not local stats.
- `batch`, `scan`, `point`, `range`, `update`, `delete`, `rollback` and `open` still use the format-3 writer/reader primitives. The public `SQLite` entry does not expose raw record decoding, `rowByRowid`/`range` rowid windows, or the full-image `save()` that these timings are defined on.

## Capabilities still missing from the public API

- Direct rowid point read (`rowByRowid`) and inclusive rowid range read (`range`) without SQL parsing.
- Raw record decoding via a table cursor (`openDatabase(...).table(...)`) for `scan`.
- Writer-side `update`/`delete` slots and the explicit full-image `save()` that `update`/`delete`/`batch` include in their timings.
- Writer `begin`/`rollback` without SQL transaction control, used by `rollback`.
- A pure open/close handle over the main file with no statement preparation, used by `open`.

Regenerate: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
