# Benchmark report

Command: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
Defaults: `BENCH_ROWS=5000`, `BENCH_TXN=1000`, `BENCH_PAGE=4096`, `BENCH_ROUNDS=3`, `BENCH_POINT=1000`, `BENCH_RANGE=200`, `BENCH_MUTATE=1000`, `BENCH_LIMIT=200`, `BENCH_AGG=20`, `BENCH_JOIN=10`, `BENCH_DISTINCT=5`, `BENCH_SUBQUERY=20`, `BENCH_MULTI=10`, `BENCH_UPSERT=500`, `BENCH_SAVEPOINT=200`, `BENCH_REPLACE=500`, `BENCH_TRIGGER=500`, `BENCH_CASCADE=500`, `BENCH_SYNCHRONOUS=off`
Baseline: `node:sqlite` (`DatabaseSync`) = `1.00x`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.

## Provenance

- node: `v24.18.0`
- rustc: `rustc 1.101.0-nightly (1c3a65069 2026-11-02)`
- repo rev: `c9b8518`
- binding rev (`database.rs` pin in `projects/sqlite.rs/Cargo.toml`): `70aee1e`
- data: `5000` rows (page `4096`), `BENCH_ROUNDS=3`, point/indexed `1000`, range `200`, order_limit `200`, group_by `20`, join `10`, distinct `5`, subquery `20`, multi `10x100`, upsert `500`, mutate `1000`, projection `10`, join_indexed `10`, savepoint `200`, replace `500`, trigger `500`, cascade `500`

## Relative to `node:sqlite`

| Workload | node:sqlite | @yydb/sqlite | better-sqlite3 | sql.js | @yydb/sqlite-unknown-wasm32 |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | **1.00x** | 2.83x | 1.44x | 6.44x | 9.01x |
| batch_sql | **1.00x** | 13.65x | 1.74x | 1.35x | n/a |
| scan | 1.00x | 1.91x | **0.81x** | 1.26x | 1.53x |
| point | 1.00x | **0.26x** | 1.06x | 0.58x | n/a |
| point_sql | 1.00x | 0.73x | 1.06x | 0.58x | **0.56x** |
| point_param | 1.00x | **0.32x** | 1.06x | 0.58x | n/a |
| point_uk | 1.00x | 0.89x | 1.00x | **0.52x** | n/a |
| range | **1.00x** | 1.18x | 1.16x | 3.05x | 1.66x |
| indexed | 1.00x | 0.86x | 0.94x | **0.55x** | n/a |
| order_limit | 1.00x | 1.17x | 1.04x | 1.98x | **0.93x** |
| group_by | **1.00x** | 2.29x | 1.32x | 3.03x | 2.16x |
| join | **1.00x** | 6.71x | 1.63x | 2.70x | 10.50x |
| distinct | **1.00x** | 3.05x | 1.27x | n/a | n/a |
| aggregate | **1.00x** | 4.02x | 1.61x | n/a | n/a |
| subquery | **1.00x** | 8.64x | 1.57x | n/a | n/a |
| index_range | **1.00x** | 4.79x | 1.31x | n/a | n/a |
| insert_multi | **1.00x** | 3.57x | 1.62x | n/a | n/a |
| upsert | 1.00x | 10.47x | **0.99x** | n/a | n/a |
| upsert_param | 1.00x | 6.86x | **0.99x** | n/a | n/a |
| update | **1.00x** | 3.83x | 1.33x | 2.45x | n/a |
| update_sql | **1.00x** | 12.42x | 1.33x | 2.45x | n/a |
| update_idx | **1.00x** | 16.44x | 1.73x | 2.11x | n/a |
| delete | 1.00x | 0.43x | 1.31x | **0.25x** | n/a |
| delete_sql | 1.00x | 1.18x | 1.31x | **0.25x** | n/a |
| delete_idx | **1.00x** | 16.12x | 1.37x | 1.91x | n/a |
| txn | **1.00x** | 11.04x | 1.84x | 5.58x | n/a |
| rollback | **1.00x** | 1.04x | 1.71x | 1.66x | n/a |
| open | 1.00x | 1.23x | 2.08x | **0.98x** | n/a |
| in_list | **1.00x** | 2.69x | 1.38x | n/a | 5.89x |
| sort_mixed | **1.00x** | 1.86x | 1.55x | n/a | 1.62x |
| like_prefix | **1.00x** | 4.32x | 1.82x | n/a | 5.59x |
| delete_range | **1.00x** | 18.95x | 1.71x | n/a | n/a |
| update_expr | **1.00x** | 30.09x | 2.66x | n/a | n/a |
| cte | **1.00x** | 9.48x | 1.44x | n/a | n/a |
| projection_narrow | 1.00x | 2.45x | **0.98x** | 3.50x | 1.62x |
| projection_wide | **1.00x** | 2.21x | 1.32x | 5.97x | 2.25x |
| join_indexed | 1.00x | 1.73x | 1.04x | **0.45x** | n/a |
| delete_index_range | **1.00x** | 18.69x | 1.04x | 4.36x | n/a |
| or_filter | **1.00x** | 10.48x | 1.32x | 1.95x | 13.98x |
| insert_indexed | **1.00x** | 11.23x | 1.70x | 2.24x | n/a |
| update_expr_idx | **1.00x** | 8.40x | 1.37x | 2.56x | n/a |
| window_rank | **1.00x** | 1.86x | 1.76x | 3.79x | 1.27x |
| join_left | 1.00x | 2.84x | 1.40x | **0.89x** | 81.10x |
| exists_filter | **1.00x** | 10.21x | 1.41x | 1.77x | 216.34x |
| savepoint | **1.00x** | 13.15x | 2.09x | 2.54x | 6.54x |
| insert_replace | **1.00x** | 26.74x | 2.73x | 2.32x | 24.51x |
| trigger_insert | **1.00x** | 14.18x | 1.74x | 2.10x | 10.71x |
| fk_cascade | 1.00x | **0.46x** | 1.55x | 2.50x | 0.58x |
| view_select | **1.00x** | 11.12x | 1.57x | 1.99x | 8.60x |
| having | **1.00x** | 2.42x | 1.48x | 2.55x | 2.31x |

## Absolute round timings (median / p95 ms)

| Workload | node:sqlite median / p95 (ms) | @yydb/sqlite median / p95 (ms) | better-sqlite3 median / p95 (ms) | sql.js median / p95 (ms) | @yydb/sqlite-unknown-wasm32 median / p95 (ms) |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | 3.57 / 4.88 | 10.12 / 10.94 | 5.14 / 5.94 | 23.02 / 44.68 | 32.18 / 57.39 |
| batch_sql | 2.55 / 4.49 | 34.74 / 36.02 | 4.44 / 4.92 | 3.43 / 6.94 | n/a |
| scan | 2.62 / 4.50 | 5.00 / 5.62 | 2.11 / 2.28 | 3.29 / 4.99 | 4.01 / 10.55 |
| point | 24.96 / 28.95 | 6.45 / 6.82 | 26.53 / 27.18 | 14.41 / 15.94 | n/a |
| point_sql | 24.96 / 28.95 | 18.25 / 20.08 | 26.53 / 27.18 | 14.41 / 15.94 | 14.04 / 14.82 |
| point_param | 24.96 / 28.95 | 7.96 / 7.99 | 26.53 / 27.18 | 14.41 / 15.94 | n/a |
| point_uk | 23.30 / 24.33 | 20.69 / 20.77 | 23.29 / 23.56 | 12.00 / 14.98 | n/a |
| range | 8.53 / 9.77 | 10.08 / 10.39 | 9.88 / 10.35 | 26.00 / 31.75 | 14.17 / 15.99 |
| indexed | 24.83 / 25.07 | 21.44 / 23.50 | 23.44 / 24.39 | 13.76 / 15.26 | n/a |
| order_limit | 10.23 / 11.76 | 11.98 / 12.88 | 10.62 / 10.66 | 20.27 / 24.90 | 9.56 / 10.12 |
| group_by | 19.17 / 19.94 | 43.93 / 44.60 | 25.37 / 26.54 | 58.18 / 64.67 | 41.45 / 42.07 |
| join | 1.90 / 1.91 | 12.75 / 12.81 | 3.09 / 3.16 | 5.13 / 5.24 | 19.96 / 20.84 |
| distinct | 6.54 / 6.58 | 19.97 / 20.18 | 8.29 / 8.72 | n/a | n/a |
| aggregate | 5.94 / 6.50 | 23.85 / 24.47 | 9.53 / 9.55 | n/a | n/a |
| subquery | 4.11 / 4.26 | 35.48 / 39.75 | 6.44 / 7.11 | n/a | n/a |
| index_range | 27.23 / 28.14 | 130.54 / 130.72 | 35.60 / 42.59 | n/a | n/a |
| insert_multi | 0.71 / 0.86 | 2.54 / 2.66 | 1.16 / 1.28 | n/a | n/a |
| upsert | 1.18 / 17.52 | 12.41 / 12.46 | 1.17 / 11.64 | n/a | n/a |
| upsert_param | 1.18 / 17.52 | 8.13 / 8.28 | 1.17 / 11.64 | n/a | n/a |
| update | 0.86 / 6.37 | 3.28 / 3.58 | 1.14 / 10.07 | 2.10 / 3.17 | n/a |
| update_sql | 0.86 / 6.37 | 10.64 / 10.69 | 1.14 / 10.07 | 2.10 / 3.17 | n/a |
| update_idx | 0.85 / 0.98 | 13.95 / 14.95 | 1.47 / 2.36 | 1.79 / 1.84 | n/a |
| delete | 7.22 / 8.04 | 3.12 / 3.60 | 9.42 / 11.73 | 1.82 / 2.05 | n/a |
| delete_sql | 7.22 / 8.04 | 8.54 / 9.20 | 9.42 / 11.73 | 1.82 / 2.05 | n/a |
| delete_idx | 0.83 / 0.91 | 13.33 / 13.52 | 1.14 / 1.62 | 1.58 / 2.15 | n/a |
| txn | 0.96 / 1.15 | 10.65 / 11.83 | 1.77 / 1.85 | 5.38 / 6.96 | n/a |
| rollback | 2.08 / 3.23 | 2.16 / 2.21 | 3.56 / 3.69 | 3.44 / 4.01 | n/a |
| open | 0.07 / 0.18 | 0.09 / 0.20 | 0.14 / 0.27 | 0.07 / 0.15 | n/a |
| in_list | 0.61 / 0.62 | 1.64 / 1.83 | 0.84 / 1.05 | n/a | 3.60 / 4.51 |
| sort_mixed | 17.40 / 17.58 | 32.42 / 33.55 | 26.89 / 27.88 | n/a | 28.22 / 29.55 |
| like_prefix | 3.77 / 4.65 | 16.29 / 16.57 | 6.86 / 6.94 | n/a | 21.08 / 22.08 |
| delete_range | 0.06 / 0.12 | 1.20 / 1.22 | 0.11 / 0.14 | n/a | n/a |
| update_expr | 0.33 / 0.34 | 9.84 / 10.39 | 0.87 / 0.92 | n/a | n/a |
| cte | 3.11 / 3.12 | 29.48 / 31.35 | 4.48 / 4.71 | n/a | n/a |
| projection_narrow | 10.64 / 11.09 | 26.09 / 30.30 | 10.38 / 10.86 | 37.23 / 37.42 | 17.24 / 17.60 |
| projection_wide | 15.81 / 17.40 | 34.86 / 35.13 | 20.94 / 21.60 | 94.37 / 98.28 | 35.62 / 35.70 |
| join_indexed | 0.22 / 0.23 | 0.37 / 0.44 | 0.22 / 0.30 | 0.10 / 0.10 | n/a |
| delete_index_range | 0.02 / 0.03 | 0.41 / 0.56 | 0.02 / 0.04 | 0.09 / 0.22 | n/a |
| or_filter | 1.62 / 2.43 | 17.02 / 17.31 | 2.14 / 2.62 | 3.16 / 3.81 | 22.69 / 24.64 |
| insert_indexed | 1.70 / 1.79 | 19.04 / 20.10 | 2.89 / 3.99 | 3.80 / 4.02 | n/a |
| update_expr_idx | 2.08 / 3.19 | 17.45 / 22.20 | 2.85 / 4.11 | 5.32 / 7.29 | n/a |
| window_rank | 16.08 / 17.24 | 29.85 / 30.57 | 28.29 / 30.33 | 60.88 / 60.99 | 20.45 / 22.85 |
| join_left | 0.21 / 0.23 | 0.61 / 0.62 | 0.30 / 0.30 | 0.19 / 0.23 | 17.28 / 17.34 |
| exists_filter | 17.39 / 17.68 | 177.54 / 184.58 | 24.44 / 25.28 | 30.70 / 31.13 | 3761.80 / 3777.94 |
| savepoint | 0.42 / 0.47 | 5.46 / 5.75 | 0.87 / 0.94 | 1.06 / 1.13 | 2.72 / 4.58 |
| insert_replace | 0.25 / 0.27 | 6.77 / 6.81 | 0.69 / 1.02 | 0.59 / 0.67 | 6.20 / 6.54 |
| trigger_insert | 0.63 / 0.68 | 9.00 / 9.08 | 1.10 / 1.29 | 1.33 / 1.98 | 6.79 / 7.35 |
| fk_cascade | 5.05 / 7.06 | 2.32 / 2.45 | 7.82 / 8.22 | 12.64 / 13.35 | 2.94 / 5.17 |
| view_select | 3.05 / 3.98 | 33.96 / 37.54 | 4.81 / 5.21 | 6.06 / 6.39 | 26.25 / 30.43 |
| having | 19.46 / 20.51 | 47.08 / 51.04 | 28.74 / 30.46 | 49.61 / 52.63 | 44.95 / 45.59 |

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
- `cte`: `with c as (select id, label, score from items where score > 1000) select count(*) from c` (20 queries per round, 1000 rows materialized) — non-recursive CTE materialization.
- `having`: `select cast(score as integer), sum(score) ... group by cast(score as integer) having sum(score) > 1000` (20 queries per round, 1001 groups kept) — the aggregate rows are filtered after grouping.
- `view_select`: `create view item_view as select ... where score > 1000`, then `select count(*) from item_view` (20 queries per round, 1000 rows) — the view body is re-run on every read.
- `in_list`: `select count(*) ... where id in (<100 scattered rowids>)` (20 queries per round, 100 matches) — literal `IN` list planning and predicate dispatch.
- `sort_mixed`: `select ... order by score desc, id desc limit 50` (20 queries per round) — unindexed sort plus truncation.
- `like_prefix`: `select count(*) ... where label like 'row-1%'` (20 queries per round, 1111 matches) — prefix pattern over an unindexed full scan, with the row count asserted on every engine.
- `projection_narrow` / `projection_wide`: the same 5000-row scan projected to one column (`select id`) vs every column (`select *`), 10x per round. The pair isolates per-column decoding and row-copy cost from the scan itself.
- `join_indexed`: `select count(*) ... where a.id <= 20 join ... on b.label = a.label` (10 queries per round, 20 matches) — the equality join runs on an indexed `label` column on every engine, so it measures the index probe instead of the nested scan in `join`.
- `delete_index_range`: one `delete ... where label between 'row-1000' and 'row-1099'` in a transaction on an in-memory database carrying the `label` index (109 rows removed, the surviving count asserted), then the interval is re-inserted outside the timed window. This is the index-driven bulk delete path, against the rowid path in `delete_range`.
- `or_filter`: `select count(*) ... where id < 1000 or label > 'row-4500'` (20 queries per round, 1499 matches) — a cross-column `OR` where neither side can be answered by a single-column pushdown.
- `insert_indexed`: 2000 prepared INSERTs into an in-memory table carrying a `label` index, one transaction (the secondary index has to be maintained per row), then the row count and one index lookup are asserted.
- `update_expr_idx`: one `update items set label = 'u-' || id` over every row of an indexed table in a transaction — every secondary key changes, so it pins index maintenance rather than the plain table write in `update_expr`.
- `window_rank`: `select id, row_number() over (partition by cast(score as integer) order by id) from items` (5 queries per round, 5000 rows in 1251 partitions) — window partitioning and ordering.
- `join_left`: the `join_indexed` equality as a `LEFT JOIN` (10 queries per round, 20 matched left rows) — the outer path has to keep unmatched left rows instead of dropping them.
- `exists_filter`: `select count(*) ... where exists (select 1 from items b where b.label = a.label and b.id <= 100)` (20 queries per round, 100 matches) — a correlated `EXISTS` probed once per outer row.
- `delete_range`: one `delete from items where id between 1000 and 1999` in a transaction on an in-memory database (1000 rows removed, the surviving count asserted), then the deleted interval is re-inserted outside the timed window. This is the bulk range-delete path rather than the per-rowid loop in `delete`/`delete_sql`.
- `update_expr`: one `update items set score = score + 1` over every row in a transaction (5000 rows updated, `score` of row 1 asserted to include every run), then the next round updates again. This pins the whole-table write path and its per-row conflict detection instead of a single-rowid update.
- `index_range`: `select id from items where label between 'row-1000' and 'row-1499' order by label` (200 queries per round, 553 rows) — range predicate on an indexed column.
- `insert_multi`: 10 statements of 100 literal rows in one transaction (1000 rows total).
- `upsert`: 500 `insert ... on conflict(id) do update` statements in one transaction.
- `upsert_param`: the same upsert through a prepared statement with bound values; peer cells reuse `upsert`. `upsert` re-parses interpolated SQL text, so the pair shows the parse cost separately from execution.
- `insert_replace`: 500 `insert or replace` statements in one transaction over the seeded rows (row count and the rewritten `score` asserted) — the delete-then-insert conflict path instead of `ON CONFLICT`.
- `trigger_insert`: 500 prepared INSERTs into an in-memory table carrying an `AFTER INSERT` trigger that writes one audit row each (both row counts asserted) — per-row trigger dispatch and the nested audit write.
- `fk_cascade`: `delete from cascade_parent where id <= 500` on a database with foreign keys on and 500 parent/child pairs (both tables asserted empty) — `ON DELETE CASCADE` child removal per parent row.
- `savepoint`: begin + 200 iterations of `savepoint sp1` / one INSERT / `rollback to sp1` / `release sp1` + commit, asserting nothing persists — savepoint bookkeeping separate from the plain `rollback`.
- `update` / `delete`: 1000 mutations in one transaction + save (our writer) vs peers' prepared mutation in a transaction.
- `update_sql` / `delete_sql`: 1000 prepared SQL mutations by bound rowid in one transaction on `new SQLite()`; peer cells reuse `update` / `delete`. These exercise the SQL write path (rowid narrowing) rather than the writer primitives.
- `update_idx` / `delete_idx`: 1000 prepared mutations by an **indexed** `label` column in one transaction, on an in-memory database with the same index on every engine. This covers the indexed write path (probe candidates instead of a full decode) and has no peer-cell reuse.
- `txn`: 1000 prepared INSERTs split into transactions of 10 (100 commits), on an in-memory database, so transaction boundaries rather than row count dominate.
- `rollback`: begin + 1000 inserts + rollback (nothing persisted).
- `open`: open + close of the main file, no reads.
- `@yydb/sqlite-unknown-wasm32` is the in-memory SQL binding: it runs `batch` (inserts + snapshot export + file write), `scan`, `point_sql`, `range`, `order_limit`, `group_by`, `join`, `in_list`, `sort_mixed`, `like_prefix`, `projection_narrow`, `projection_wide`, `or_filter`, `view_select`, `having`, `savepoint`, `insert_replace`, `trigger_insert` and `fk_cascade` through `exec`; it has no reader point API, no file open and no index-driven primitives, so the remaining cells are `n/a`.

## Intentional deltas

- Our writer is snapshot-based: `update`/`delete` include the full-image `save()`; peers write in place through their pager.
- sql.js peer scan rebuilds the WASM DB from the serialized image each round; peer batch/update/delete timings include `export()`.
- `point_sql` has no separate peer path — peers' prepared `get` is the reference.
- The wasm column reads the same in-memory image every round (`SELECT` re-scans the image; the binding has no seek), and its `batch` includes `snapshot()` + the file write.
- sql.js does not run the SQL-feature workloads (`distinct`, `aggregate`, `subquery`, `cte`, `index_range`, `insert_multi`, `upsert`, `in_list`, `sort_mixed`, `like_prefix`, `delete_range`, `update_expr`), so those cells stay `n/a`; the wasm binding runs `in_list`, `sort_mixed`, `like_prefix`, `projection_narrow`, `projection_wide`, `or_filter`, `window_rank`, `join_left`, `exists_filter`, `view_select`, `having`, `savepoint`, `insert_replace`, `trigger_insert` and `fk_cascade`, but not the index-driven mutation primitives (`insert_indexed`, `update_expr_idx`, `delete_index_range`).
- `insert_indexed`, `upsert`, `update_expr`, `update_expr_idx`, `delete_range`, `savepoint`, `insert_replace`, `trigger_insert` and `fk_cascade` on our side run on an in-memory `new SQLite()`, while the two peer columns write through their pager; the row set is validated on both sides.
- `batch_sql`, `update_idx`, `delete_idx`, `txn`, `update_expr` and `delete_range` run on an in-memory database on every engine, so no pager publication or file I/O is included. sql.js runs the SQL ones through its prepared-statement API; the wasm binding has no UPDATE/DELETE/index support and stays `n/a`.
- The SQL-engine workloads (`point_param`, `point_uk`, `order_limit`, `group_by`, `join`, `distinct`, `aggregate`, `subquery`, `cte`, `having`, `view_select`, `in_list`, `sort_mixed`, `like_prefix`, `or_filter`, `projection_narrow`, `projection_wide`, `join_indexed`, `join_left`, `exists_filter`, `window_rank`, `insert_indexed`, `index_range`, `insert_multi`, `upsert`, `upsert_param`, `insert_replace`, `trigger_insert`, `fk_cascade`, `savepoint`, `update_sql`, `delete_sql`, `update_expr`, `update_expr_idx`, `delete_range`, `delete_index_range`) run one untimed warmup round before `BENCH_ROUNDS` timed rounds; median/p95 come from the harness `benchSummary`, not local stats.
- `batch`, `scan`, `point`, `range`, `update`, `delete`, `rollback` and `open` still use the format-3 writer/reader primitives. The public `SQLite` entry does not expose raw record decoding, `rowByRowid`/`range` rowid windows, or the full-image `save()` that these timings are defined on.

## Capabilities still missing from the public API

- Direct rowid point read (`rowByRowid`) and inclusive rowid range read (`range`) without SQL parsing.
- Raw record decoding via a table cursor (`openDatabase(...).table(...)`) for `scan`.
- Writer-side `update`/`delete` slots and the explicit full-image `save()` that `update`/`delete`/`batch` include in their timings.
- Writer `begin`/`rollback` without SQL transaction control, used by `rollback`.
- A pure open/close handle over the main file with no statement preparation, used by `open`.

Regenerate: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
