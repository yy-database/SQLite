# Benchmark report

Command: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
Defaults: `BENCH_ROWS=5000`, `BENCH_TXN=1000`, `BENCH_PAGE=4096`, `BENCH_ROUNDS=3`, `BENCH_POINT=1000`, `BENCH_RANGE=200`, `BENCH_MUTATE=1000`, `BENCH_LIMIT=200`, `BENCH_AGG=20`, `BENCH_JOIN=10`, `BENCH_DISTINCT=5`, `BENCH_SUBQUERY=20`, `BENCH_MULTI=10`, `BENCH_UPSERT=500`, `BENCH_SAVEPOINT=200`, `BENCH_REPLACE=500`, `BENCH_TRIGGER=500`, `BENCH_CASCADE=500`, `BENCH_SYNCHRONOUS=off`
Baseline: `node:sqlite` (`DatabaseSync`) = `1.00x`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.

## Provenance

- node: `v24.18.0`
- rustc: `rustc 1.101.0-nightly (1c3a65069 2026-11-02)`
- repo rev: `568f421`
- binding rev (`database.rs` pin in `projects/sqlite.rs/Cargo.toml`): `70aee1e`
- data: `5000` rows (page `4096`), `BENCH_ROUNDS=3`, point/indexed `1000`, range `200`, order_limit `200`, group_by `20`, join `10`, distinct `5`, subquery `20`, multi `10x100`, upsert `500`, mutate `1000`, projection `10`, join_indexed `10`, savepoint `200`, replace `500`, trigger `500`, cascade `500`

## Relative to `node:sqlite`

| Workload | node:sqlite | @yydb/sqlite | better-sqlite3 | sql.js | @yydb/sqlite-unknown-wasm32 |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | **1.00x** | 2.47x | 1.61x | 7.69x | 11.76x |
| batch_sql | **1.00x** | 14.25x | 2.63x | 2.84x | n/a |
| scan | **1.00x** | 2.92x | 2.03x | 3.71x | 3.00x |
| point | 1.00x | **0.29x** | 1.51x | 0.91x | n/a |
| point_sql | 1.00x | **0.86x** | 1.51x | 0.91x | 0.93x |
| point_param | 1.00x | **0.42x** | 1.51x | 0.91x | n/a |
| point_uk | 1.00x | 0.96x | 1.63x | **0.94x** | n/a |
| range | **1.00x** | 1.22x | 1.66x | 4.06x | 2.23x |
| indexed | 1.00x | 0.95x | 1.52x | **0.76x** | n/a |
| order_limit | **1.00x** | 1.50x | 1.46x | 3.29x | 1.72x |
| group_by | **1.00x** | 2.22x | 1.49x | 3.63x | 2.65x |
| join | **1.00x** | 6.62x | 1.75x | 3.20x | 10.84x |
| distinct | **1.00x** | 3.28x | 1.56x | n/a | n/a |
| aggregate | **1.00x** | 3.77x | 2.58x | n/a | n/a |
| subquery | **1.00x** | 8.10x | 1.71x | n/a | n/a |
| index_range | **1.00x** | 4.52x | 1.51x | n/a | n/a |
| insert_multi | **1.00x** | 3.35x | 1.70x | n/a | n/a |
| upsert | **1.00x** | 22.89x | 1.89x | n/a | n/a |
| upsert_param | **1.00x** | 11.30x | 1.89x | n/a | n/a |
| update | **1.00x** | 5.29x | 2.01x | 2.61x | n/a |
| update_sql | **1.00x** | 20.04x | 2.01x | 2.61x | n/a |
| update_idx | **1.00x** | 18.42x | 2.38x | 2.29x | n/a |
| delete | 1.00x | 0.51x | 1.10x | **0.27x** | n/a |
| delete_sql | 1.00x | 1.47x | 1.10x | **0.27x** | n/a |
| delete_idx | **1.00x** | 17.29x | 2.24x | 2.64x | n/a |
| txn | **1.00x** | 19.05x | 2.38x | 11.09x | n/a |
| rollback | 1.00x | **0.97x** | 2.03x | 2.01x | n/a |
| open | **1.00x** | 2.95x | 2.37x | 2.67x | n/a |
| in_list | **1.00x** | 2.51x | 2.47x | n/a | 5.83x |
| sort_mixed | **1.00x** | 1.75x | 1.73x | n/a | 2.31x |
| like_prefix | **1.00x** | 4.45x | 1.83x | n/a | 9.60x |
| delete_range | **1.00x** | 19.28x | 1.59x | n/a | n/a |
| update_expr | **1.00x** | 29.58x | 1.26x | n/a | n/a |
| cte | **1.00x** | 9.38x | 2.00x | n/a | n/a |
| projection_narrow | **1.00x** | 2.53x | 1.30x | 4.88x | 2.93x |
| projection_wide | **1.00x** | 2.10x | 1.43x | 7.09x | 2.65x |
| join_indexed | 1.00x | 1.71x | 1.53x | **0.85x** | n/a |
| delete_index_range | **1.00x** | 24.45x | 1.67x | 2.76x | n/a |
| or_filter | **1.00x** | 10.76x | 3.04x | 3.30x | 26.48x |
| insert_indexed | **1.00x** | 10.78x | 2.18x | 2.53x | n/a |
| update_expr_idx | **1.00x** | 5.04x | 1.48x | 2.46x | n/a |
| window_rank | **1.00x** | 1.89x | 1.96x | 4.46x | 1.75x |
| join_left | 1.00x | 1.69x | 2.05x | **0.89x** | 88.40x |
| exists_filter | **1.00x** | 8.61x | 1.76x | 2.22x | 279.39x |
| savepoint | **1.00x** | 8.68x | 2.23x | 2.43x | 12.89x |
| insert_replace | **1.00x** | 3204.22x | 3.95x | 3.23x | 5029.29x |
| trigger_insert | **1.00x** | 16.41x | 2.57x | 2.00x | 12.82x |
| fk_cascade | 1.00x | **0.53x** | 1.92x | 2.81x | 0.76x |
| view_select | **1.00x** | 16.13x | 1.99x | 2.71x | 13.21x |
| having | **1.00x** | 2.47x | 1.80x | 3.61x | 3.24x |

## Absolute round timings (median / p95 ms)

| Workload | node:sqlite median / p95 (ms) | @yydb/sqlite median / p95 (ms) | better-sqlite3 median / p95 (ms) | sql.js median / p95 (ms) | @yydb/sqlite-unknown-wasm32 median / p95 (ms) |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | 4.41 / 4.65 | 10.91 / 11.90 | 7.09 / 9.58 | 33.92 / 58.57 | 51.86 / 92.21 |
| batch_sql | 2.49 / 2.82 | 35.47 / 37.58 | 6.56 / 7.45 | 7.06 / 7.41 | n/a |
| scan | 1.73 / 3.39 | 5.05 / 5.42 | 3.52 / 4.51 | 6.43 / 7.74 | 5.20 / 12.69 |
| point | 20.68 / 21.47 | 5.93 / 6.22 | 31.28 / 33.40 | 18.75 / 23.93 | n/a |
| point_sql | 20.68 / 21.47 | 17.88 / 18.71 | 31.28 / 33.40 | 18.75 / 23.93 | 19.18 / 20.22 |
| point_param | 20.68 / 21.47 | 8.64 / 9.06 | 31.28 / 33.40 | 18.75 / 23.93 | n/a |
| point_uk | 20.56 / 22.01 | 19.71 / 21.18 | 33.60 / 38.60 | 19.29 / 20.31 | n/a |
| range | 8.07 / 8.51 | 9.85 / 9.86 | 13.41 / 14.40 | 32.73 / 36.14 | 17.95 / 21.83 |
| indexed | 21.85 / 22.72 | 20.68 / 20.91 | 33.16 / 33.26 | 16.71 / 17.73 | n/a |
| order_limit | 7.97 / 8.00 | 11.93 / 12.46 | 11.67 / 12.18 | 26.18 / 26.36 | 13.73 / 15.71 |
| group_by | 19.83 / 20.08 | 43.98 / 44.21 | 29.61 / 31.14 | 72.03 / 74.90 | 52.61 / 53.29 |
| join | 2.02 / 2.12 | 13.36 / 14.49 | 3.54 / 4.17 | 6.45 / 6.54 | 21.88 / 22.88 |
| distinct | 6.21 / 6.76 | 20.39 / 23.89 | 9.66 / 9.81 | n/a | n/a |
| aggregate | 5.93 / 6.51 | 22.38 / 22.60 | 15.33 / 15.73 | n/a | n/a |
| subquery | 4.39 / 4.39 | 35.54 / 36.23 | 7.48 / 7.49 | n/a | n/a |
| index_range | 26.44 / 29.59 | 119.50 / 120.06 | 39.97 / 40.91 | n/a | n/a |
| insert_multi | 0.69 / 0.97 | 2.30 / 2.70 | 1.17 / 1.39 | n/a | n/a |
| upsert | 0.38 / 17.31 | 8.62 / 9.36 | 0.71 / 7.18 | n/a | n/a |
| upsert_param | 0.38 / 17.31 | 4.25 / 4.51 | 0.71 / 7.18 | n/a | n/a |
| update | 0.78 / 8.21 | 4.13 / 5.29 | 1.57 / 9.17 | 2.04 / 4.02 | n/a |
| update_sql | 0.78 / 8.21 | 15.66 / 16.45 | 1.57 / 9.17 | 2.04 / 4.02 | n/a |
| update_idx | 0.89 / 0.91 | 16.41 / 16.62 | 2.12 / 3.15 | 2.04 / 2.09 | n/a |
| delete | 7.86 / 8.09 | 4.04 / 4.20 | 8.66 / 9.73 | 2.15 / 2.60 | n/a |
| delete_sql | 7.86 / 8.09 | 11.51 / 15.52 | 8.66 / 9.73 | 2.15 / 2.60 | n/a |
| delete_idx | 0.89 / 0.95 | 15.41 / 15.46 | 2.00 / 2.33 | 2.36 / 2.81 | n/a |
| txn | 0.66 / 0.66 | 12.54 / 13.15 | 1.57 / 1.89 | 7.30 / 11.98 | n/a |
| rollback | 2.05 / 2.23 | 1.98 / 2.05 | 4.16 / 5.21 | 4.12 / 4.90 | n/a |
| open | 0.07 / 0.19 | 0.21 / 0.40 | 0.17 / 0.36 | 0.19 / 0.24 | n/a |
| in_list | 0.64 / 0.75 | 1.61 / 1.65 | 1.59 / 1.79 | n/a | 3.74 / 4.19 |
| sort_mixed | 18.02 / 18.71 | 31.59 / 31.68 | 31.19 / 31.74 | n/a | 41.71 / 45.33 |
| like_prefix | 3.52 / 3.92 | 15.68 / 15.86 | 6.43 / 7.10 | n/a | 33.81 / 38.90 |
| delete_range | 0.07 / 0.08 | 1.28 / 1.30 | 0.11 / 0.14 | n/a | n/a |
| update_expr | 0.35 / 0.37 | 10.27 / 11.41 | 0.44 / 0.70 | n/a | n/a |
| cte | 3.06 / 4.19 | 28.74 / 29.69 | 6.13 / 7.25 | n/a | n/a |
| projection_narrow | 9.60 / 9.67 | 24.33 / 24.87 | 12.49 / 13.14 | 46.83 / 47.22 | 28.10 / 28.73 |
| projection_wide | 16.52 / 17.95 | 34.75 / 35.20 | 23.61 / 24.29 | 117.06 / 117.58 | 43.84 / 45.44 |
| join_indexed | 0.23 / 0.29 | 0.39 / 0.40 | 0.35 / 0.42 | 0.20 / 0.24 | n/a |
| delete_index_range | 0.02 / 0.04 | 0.55 / 0.66 | 0.04 / 0.07 | 0.06 / 0.15 | n/a |
| or_filter | 1.55 / 1.64 | 16.64 / 16.86 | 4.70 / 5.11 | 5.11 / 5.23 | 40.95 / 42.88 |
| insert_indexed | 1.71 / 1.73 | 18.44 / 18.86 | 3.73 / 3.79 | 4.34 / 6.27 | n/a |
| update_expr_idx | 2.73 / 3.32 | 13.78 / 21.53 | 4.05 / 7.59 | 6.74 / 8.11 | n/a |
| window_rank | 15.62 / 17.13 | 29.55 / 29.86 | 30.56 / 30.88 | 69.69 / 73.71 | 27.38 / 28.97 |
| join_left | 0.25 / 0.27 | 0.43 / 0.46 | 0.52 / 0.52 | 0.22 / 0.27 | 22.27 / 23.19 |
| exists_filter | 18.47 / 18.54 | 158.90 / 163.08 | 32.50 / 34.34 | 41.05 / 43.50 | 5159.06 / 5193.67 |
| savepoint | 0.46 / 0.62 | 3.97 / 4.04 | 1.02 / 1.32 | 1.11 / 2.31 | 5.89 / 6.66 |
| insert_replace | 0.27 / 0.27 | 853.28 / 863.65 | 1.05 / 1.18 | 0.86 / 1.12 | 1339.30 / 1350.36 |
| trigger_insert | 0.68 / 0.71 | 11.14 / 11.25 | 1.74 / 2.00 | 1.36 / 1.87 | 8.70 / 8.97 |
| fk_cascade | 5.21 / 5.48 | 2.75 / 3.59 | 9.99 / 10.76 | 14.62 / 15.52 | 3.98 / 5.45 |
| view_select | 3.11 / 3.27 | 50.14 / 54.38 | 6.20 / 6.53 | 8.43 / 8.67 | 41.07 / 41.96 |
| having | 18.90 / 19.41 | 46.70 / 47.48 | 33.93 / 36.89 | 68.25 / 70.95 | 61.28 / 61.83 |

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
