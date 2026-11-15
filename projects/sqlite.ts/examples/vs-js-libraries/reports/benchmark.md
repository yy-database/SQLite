# Benchmark report

Command: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
Defaults: `BENCH_ROWS=5000`, `BENCH_TXN=1000`, `BENCH_PAGE=4096`, `BENCH_ROUNDS=3`, `BENCH_POINT=1000`, `BENCH_RANGE=200`, `BENCH_MUTATE=1000`, `BENCH_LIMIT=200`, `BENCH_AGG=20`, `BENCH_JOIN=10`, `BENCH_DISTINCT=5`, `BENCH_SUBQUERY=20`, `BENCH_MULTI=10`, `BENCH_UPSERT=500`, `BENCH_SYNCHRONOUS=off`
Baseline: `node:sqlite` (`DatabaseSync`) = `1.00x`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.

## Provenance

- node: `v24.18.0`
- rustc: `rustc 1.101.0-nightly (1c3a65069 2026-11-02)`
- repo rev: `eb4f95c`
- binding rev (`database.rs` pin in `projects/sqlite.rs/Cargo.toml`): `70aee1e`
- data: `5000` rows (page `4096`), `BENCH_ROUNDS=3`, point/indexed `1000`, range `200`, order_limit `200`, group_by `20`, join `10`, distinct `5`, subquery `20`, multi `10x100`, upsert `500`, mutate `1000`, projection `10`, join_indexed `10`

## Relative to `node:sqlite`

| Workload | node:sqlite | @yydb/sqlite | better-sqlite3 | sql.js | @yydb/sqlite-unknown-wasm32 |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | 1.00x | 1.73x | **0.92x** | 3.70x | 5.44x |
| batch_sql | 1.00x | 9.04x | 1.19x | **0.94x** | n/a |
| scan | 1.00x | 1.47x | **0.41x** | 1.07x | 1.06x |
| point | 1.00x | **0.26x** | 0.96x | 0.53x | n/a |
| point_sql | 1.00x | 0.82x | 0.96x | **0.53x** | 0.59x |
| point_param | 1.00x | **0.37x** | 0.96x | 0.53x | n/a |
| point_uk | 1.00x | 0.86x | 0.99x | **0.58x** | n/a |
| range | 1.00x | 1.10x | **1.00x** | 2.82x | 1.34x |
| indexed | 1.00x | 0.70x | 0.87x | **0.37x** | n/a |
| order_limit | **1.00x** | 1.53x | 1.07x | 2.26x | 1.14x |
| group_by | 1.00x | 2.17x | **0.97x** | 2.64x | 2.00x |
| join | **1.00x** | 6.56x | 1.18x | 1.94x | 8.46x |
| distinct | 1.00x | 2.97x | **0.82x** | n/a | n/a |
| aggregate | **1.00x** | 3.47x | 1.18x | n/a | n/a |
| subquery | **1.00x** | 8.92x | 1.15x | n/a | n/a |
| index_range | **1.00x** | 5.37x | 1.17x | n/a | n/a |
| insert_multi | **1.00x** | 4.43x | 1.40x | n/a | n/a |
| upsert | 1.00x | 12.45x | **0.93x** | n/a | n/a |
| upsert_param | 1.00x | 6.74x | **0.93x** | n/a | n/a |
| update | **1.00x** | 8.53x | 1.31x | 3.94x | n/a |
| update_sql | **1.00x** | 23.88x | 1.31x | 3.94x | n/a |
| update_idx | **1.00x** | 15.25x | 1.28x | 1.35x | n/a |
| delete | 1.00x | 0.38x | 1.04x | **0.24x** | n/a |
| delete_sql | 1.00x | 1.16x | 1.04x | **0.24x** | n/a |
| delete_idx | **1.00x** | 13.31x | 1.35x | 1.58x | n/a |
| txn | **1.00x** | 15.79x | 1.55x | 10.33x | n/a |
| rollback | **1.00x** | 1.09x | 1.75x | 1.51x | n/a |
| open | 1.00x | 0.99x | 1.00x | **0.48x** | n/a |
| in_list | **1.00x** | 2.74x | 1.23x | n/a | 4.50x |
| sort_mixed | **1.00x** | 1.94x | 1.22x | n/a | 1.84x |
| like_prefix | **1.00x** | 3.79x | 1.47x | n/a | 5.90x |
| delete_range | 1.00x | 17.92x | **0.71x** | n/a | n/a |
| update_expr | **1.00x** | 32.98x | 1.25x | n/a | n/a |
| cte | **1.00x** | 9.06x | 1.12x | n/a | n/a |
| projection_narrow | 1.00x | 2.50x | **0.79x** | 2.98x | 1.35x |
| projection_wide | **1.00x** | 2.42x | 1.25x | 5.52x | 2.16x |
| join_indexed | 1.00x | 2.57x | 1.35x | **0.41x** | n/a |
| delete_index_range | 1.00x | 26.30x | **0.94x** | 5.03x | n/a |
| or_filter | **1.00x** | 12.15x | 1.82x | 2.60x | 17.79x |
| insert_indexed | **1.00x** | 10.72x | 1.37x | 1.40x | n/a |
| update_expr_idx | **1.00x** | 8.20x | 1.57x | 2.16x | n/a |
| window_rank | **1.00x** | 1.91x | 1.25x | 3.29x | 1.10x |
| join_left | **1.00x** | 2.10x | 1.06x | 1.01x | 75.05x |
| exists_filter | 1.00x | 36.82x | **0.98x** | 1.44x | 195.94x |

## Absolute round timings (median / p95 ms)

| Workload | node:sqlite median / p95 (ms) | @yydb/sqlite median / p95 (ms) | better-sqlite3 median / p95 (ms) | sql.js median / p95 (ms) | @yydb/sqlite-unknown-wasm32 median / p95 (ms) |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | 6.58 / 6.95 | 11.39 / 13.49 | 6.04 / 7.41 | 24.30 / 41.94 | 35.77 / 74.79 |
| batch_sql | 4.45 / 6.26 | 40.27 / 42.12 | 5.28 / 5.95 | 4.18 / 4.52 | n/a |
| scan | 3.56 / 4.26 | 5.23 / 5.75 | 1.44 / 1.73 | 3.81 / 5.08 | 3.79 / 10.85 |
| point | 24.85 / 26.06 | 6.37 / 6.58 | 23.98 / 24.01 | 13.15 / 18.27 | n/a |
| point_sql | 24.85 / 26.06 | 20.39 / 22.50 | 23.98 / 24.01 | 13.15 / 18.27 | 14.61 / 18.72 |
| point_param | 24.85 / 26.06 | 9.13 / 9.22 | 23.98 / 24.01 | 13.15 / 18.27 | n/a |
| point_uk | 24.38 / 26.57 | 20.99 / 21.68 | 24.08 / 26.70 | 14.03 / 16.54 | n/a |
| range | 9.45 / 9.62 | 10.41 / 15.17 | 9.41 / 9.51 | 26.70 / 33.14 | 12.67 / 15.42 |
| indexed | 30.97 / 32.94 | 21.64 / 24.89 | 27.10 / 29.94 | 11.51 / 14.00 | n/a |
| order_limit | 8.46 / 9.23 | 12.96 / 13.59 | 9.04 / 9.48 | 19.14 / 19.26 | 9.62 / 9.84 |
| group_by | 21.44 / 22.06 | 46.52 / 47.82 | 20.90 / 24.87 | 56.51 / 65.84 | 42.99 / 44.56 |
| join | 2.22 / 2.51 | 14.55 / 16.93 | 2.62 / 2.78 | 4.29 / 4.69 | 18.77 / 18.78 |
| distinct | 7.42 / 8.00 | 22.04 / 22.08 | 6.08 / 8.63 | n/a | n/a |
| aggregate | 6.86 / 7.83 | 23.82 / 25.31 | 8.09 / 8.19 | n/a | n/a |
| subquery | 4.40 / 5.45 | 39.27 / 43.65 | 5.06 / 5.75 | n/a | n/a |
| index_range | 30.45 / 30.54 | 163.55 / 179.94 | 35.74 / 41.26 | n/a | n/a |
| insert_multi | 0.79 / 0.85 | 3.51 / 5.26 | 1.11 / 1.23 | n/a | n/a |
| upsert | 0.91 / 9.44 | 11.33 / 13.70 | 0.85 / 17.26 | n/a | n/a |
| upsert_param | 0.91 / 9.44 | 6.13 / 6.58 | 0.85 / 17.26 | n/a | n/a |
| update | 0.52 / 7.69 | 4.42 / 4.48 | 0.68 / 7.04 | 2.05 / 2.05 | n/a |
| update_sql | 0.52 / 7.69 | 12.39 / 14.01 | 0.68 / 7.04 | 2.05 / 2.05 | n/a |
| update_idx | 0.88 / 1.56 | 13.47 / 15.65 | 1.13 / 1.59 | 1.20 / 1.61 | n/a |
| delete | 7.85 / 8.40 | 2.97 / 3.74 | 8.17 / 9.70 | 1.85 / 2.27 | n/a |
| delete_sql | 7.85 / 8.40 | 9.10 / 9.56 | 8.17 / 9.70 | 1.85 / 2.27 | n/a |
| delete_idx | 0.83 / 0.92 | 11.01 / 12.31 | 1.12 / 1.49 | 1.30 / 1.66 | n/a |
| txn | 0.65 / 0.67 | 10.26 / 12.75 | 1.01 / 1.39 | 6.71 / 6.83 | n/a |
| rollback | 2.05 / 2.14 | 2.23 / 2.25 | 3.58 / 3.63 | 3.10 / 3.38 | n/a |
| open | 0.11 / 0.11 | 0.11 / 0.16 | 0.11 / 0.22 | 0.05 / 0.13 | n/a |
| in_list | 0.66 / 0.67 | 1.81 / 1.99 | 0.81 / 0.86 | n/a | 2.97 / 3.87 |
| sort_mixed | 17.41 / 18.06 | 33.84 / 36.11 | 21.24 / 22.23 | n/a | 31.96 / 32.90 |
| like_prefix | 4.38 / 4.40 | 16.63 / 16.92 | 6.45 / 6.54 | n/a | 25.88 / 26.09 |
| delete_range | 0.10 / 0.13 | 1.78 / 1.80 | 0.07 / 0.09 | n/a | n/a |
| update_expr | 0.33 / 0.35 | 10.93 / 11.87 | 0.41 / 0.53 | n/a | n/a |
| cte | 3.42 / 4.49 | 31.00 / 31.50 | 3.85 / 4.17 | n/a | n/a |
| projection_narrow | 11.76 / 13.18 | 29.36 / 30.68 | 9.25 / 9.79 | 35.03 / 41.27 | 15.93 / 15.97 |
| projection_wide | 17.08 / 21.30 | 41.40 / 42.27 | 21.41 / 22.12 | 94.22 / 95.25 | 36.87 / 39.16 |
| join_indexed | 0.25 / 0.26 | 0.63 / 0.64 | 0.33 / 0.35 | 0.10 / 0.10 | n/a |
| delete_index_range | 0.02 / 0.04 | 0.60 / 1.16 | 0.02 / 0.05 | 0.12 / 0.21 | n/a |
| or_filter | 1.57 / 1.63 | 19.02 / 19.15 | 2.85 / 3.47 | 4.07 / 4.16 | 27.85 / 31.63 |
| insert_indexed | 1.86 / 2.41 | 19.94 / 21.10 | 2.55 / 2.76 | 2.60 / 4.26 | n/a |
| update_expr_idx | 1.98 / 4.14 | 16.24 / 25.38 | 3.11 / 3.35 | 4.27 / 6.36 | n/a |
| window_rank | 17.59 / 18.21 | 33.68 / 34.93 | 22.07 / 23.77 | 57.88 / 58.90 | 19.34 / 24.01 |
| join_left | 0.22 / 0.24 | 0.46 / 0.51 | 0.23 / 0.26 | 0.22 / 0.43 | 16.58 / 19.22 |
| exists_filter | 19.84 / 19.96 | 730.68 / 826.62 | 19.50 / 25.22 | 28.49 / 30.46 | 3888.49 / 4073.93 |

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
- sql.js does not run the SQL-feature workloads (`distinct`, `aggregate`, `subquery`, `cte`, `index_range`, `insert_multi`, `upsert`, `in_list`, `sort_mixed`, `like_prefix`, `delete_range`, `update_expr`), so those cells stay `n/a`; the wasm binding runs `in_list`, `sort_mixed`, `like_prefix`, `projection_narrow`, `projection_wide`, `or_filter`, `window_rank`, `join_left` and `exists_filter` but not the mutation/index ones.
- `insert_indexed`, `upsert`, `update_expr`, `update_expr_idx` and `delete_range` on our side run on an in-memory `new SQLite()`, while the two peer columns write through their pager; the row set is validated on both sides.
- `batch_sql`, `update_idx`, `delete_idx`, `txn`, `update_expr` and `delete_range` run on an in-memory database on every engine, so no pager publication or file I/O is included. sql.js runs the SQL ones through its prepared-statement API; the wasm binding has no UPDATE/DELETE/index support and stays `n/a`.
- The SQL-engine workloads (`point_param`, `point_uk`, `order_limit`, `group_by`, `join`, `distinct`, `aggregate`, `subquery`, `cte`, `in_list`, `sort_mixed`, `like_prefix`, `or_filter`, `projection_narrow`, `projection_wide`, `join_indexed`, `join_left`, `exists_filter`, `window_rank`, `insert_indexed`, `index_range`, `insert_multi`, `upsert`, `upsert_param`, `update_sql`, `delete_sql`, `update_expr`, `update_expr_idx`, `delete_range`, `delete_index_range`) run one untimed warmup round before `BENCH_ROUNDS` timed rounds; median/p95 come from the harness `benchSummary`, not local stats.
- `batch`, `scan`, `point`, `range`, `update`, `delete`, `rollback` and `open` still use the format-3 writer/reader primitives. The public `SQLite` entry does not expose raw record decoding, `rowByRowid`/`range` rowid windows, or the full-image `save()` that these timings are defined on.

## Capabilities still missing from the public API

- Direct rowid point read (`rowByRowid`) and inclusive rowid range read (`range`) without SQL parsing.
- Raw record decoding via a table cursor (`openDatabase(...).table(...)`) for `scan`.
- Writer-side `update`/`delete` slots and the explicit full-image `save()` that `update`/`delete`/`batch` include in their timings.
- Writer `begin`/`rollback` without SQL transaction control, used by `rollback`.
- A pure open/close handle over the main file with no statement preparation, used by `open`.

Regenerate: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
