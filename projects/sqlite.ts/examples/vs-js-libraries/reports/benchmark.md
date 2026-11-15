# Benchmark report

Command: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
Defaults: `BENCH_ROWS=5000`, `BENCH_TXN=1000`, `BENCH_PAGE=4096`, `BENCH_ROUNDS=1`, `BENCH_POINT=1000`, `BENCH_RANGE=200`, `BENCH_MUTATE=1000`, `BENCH_LIMIT=200`, `BENCH_AGG=20`, `BENCH_JOIN=10`, `BENCH_DISTINCT=5`, `BENCH_SUBQUERY=20`, `BENCH_MULTI=10`, `BENCH_UPSERT=500`, `BENCH_SYNCHRONOUS=off`
Baseline: `node:sqlite` (`DatabaseSync`) = `1.00x`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.

## Provenance

- node: `v24.18.0`
- rustc: `rustc 1.101.0-nightly (1c3a65069 2026-11-02)`
- repo rev: `909bfe6`
- binding rev (`database.rs` pin in `projects/sqlite.rs/Cargo.toml`): `70aee1e`
- data: `5000` rows (page `4096`), `BENCH_ROUNDS=1`, point/indexed `1000`, range `200`, order_limit `200`, group_by `20`, join `10`, distinct `5`, subquery `20`, multi `10x100`, upsert `500`, mutate `1000`, projection `10`, join_indexed `10`

## Relative to `node:sqlite`

| Workload | node:sqlite | @yydb/sqlite | better-sqlite3 | sql.js | @yydb/sqlite-unknown-wasm32 |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | **1.00x** | 4.10x | 2.75x | 12.36x | 16.70x |
| batch_sql | **1.00x** | 14.91x | 1.79x | 2.16x | n/a |
| scan | **1.00x** | 3.61x | 2.46x | 5.28x | 9.27x |
| point | 1.00x | **0.26x** | 1.68x | 0.95x | n/a |
| point_sql | 1.00x | 0.96x | 1.68x | 0.95x | **0.83x** |
| point_param | 1.00x | **0.34x** | 1.68x | 0.95x | n/a |
| point_uk | 1.00x | 0.75x | 1.37x | **0.55x** | n/a |
| range | 1.00x | **0.88x** | 1.13x | 3.92x | 1.86x |
| indexed | 1.00x | **0.61x** | 1.43x | 0.63x | n/a |
| order_limit | **1.00x** | 1.42x | 1.64x | 3.16x | 1.20x |
| group_by | **1.00x** | 3.14x | 1.76x | 3.71x | 2.53x |
| join | **1.00x** | 10.04x | 2.67x | 2.91x | 13.71x |
| distinct | **1.00x** | 4.14x | 1.59x | n/a | n/a |
| aggregate | **1.00x** | 4.49x | 2.01x | n/a | n/a |
| subquery | **1.00x** | 11.97x | 1.98x | n/a | n/a |
| index_range | **1.00x** | 2.44x | 1.28x | n/a | n/a |
| insert_multi | **1.00x** | 3.31x | 1.66x | n/a | n/a |
| upsert | **1.00x** | 1.10x | 1.00x | n/a | n/a |
| upsert_param | 1.00x | **0.63x** | 1.00x | n/a | n/a |
| update | 1.00x | **0.43x** | 1.13x | 0.47x | n/a |
| update_sql | 1.00x | 2.13x | 1.13x | **0.47x** | n/a |
| update_idx | 1.00x | 10.89x | 1.06x | **0.99x** | n/a |
| delete | 1.00x | 0.73x | 1.19x | **0.32x** | n/a |
| delete_sql | 1.00x | 2.02x | 1.19x | **0.32x** | n/a |
| delete_idx | **1.00x** | 12.70x | 1.46x | 2.82x | n/a |
| txn | **1.00x** | 20.62x | 3.71x | 16.31x | n/a |
| rollback | **1.00x** | 1.66x | 1.84x | 1.68x | n/a |
| open | **1.00x** | 1.78x | 2.89x | 1.81x | n/a |
| in_list | 1.00x | 1.62x | **0.76x** | n/a | 3.72x |
| sort_mixed | **1.00x** | 1.93x | 1.54x | n/a | 1.88x |
| like_prefix | **1.00x** | 5.02x | 3.03x | n/a | 9.56x |
| delete_range | 1.00x | 14.98x | **0.84x** | n/a | n/a |
| update_expr | **1.00x** | 28.27x | 1.63x | n/a | n/a |
| projection_narrow | 1.00x | 1.79x | **0.95x** | 3.30x | 1.66x |
| projection_wide | **1.00x** | 1.91x | 1.33x | 6.34x | 2.59x |
| join_indexed | 1.00x | 1.15x | 0.99x | **0.36x** | n/a |
| delete_index_range | **1.00x** | 42.55x | 1.26x | 10.48x | n/a |
| or_filter | **1.00x** | 5.87x | 1.43x | 1.62x | 12.99x |
| insert_indexed | **1.00x** | 6.86x | 1.98x | 2.12x | n/a |
| update_expr_idx | **1.00x** | 7.95x | 2.14x | 3.06x | n/a |
| window_rank | **1.00x** | 1.77x | 1.44x | 3.84x | 1.55x |
| join_left | **1.00x** | 1.45x | 1.96x | 1.02x | 68.90x |
| exists_filter | **1.00x** | 33.42x | 1.70x | 2.23x | 267.43x |

## Absolute round timings (median / p95 ms)

| Workload | node:sqlite median / p95 (ms) | @yydb/sqlite median / p95 (ms) | better-sqlite3 median / p95 (ms) | sql.js median / p95 (ms) | @yydb/sqlite-unknown-wasm32 median / p95 (ms) |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | 3.38 / 4.49 | 13.83 / 22.19 | 9.30 / 10.12 | 41.75 / 62.36 | 56.41 / 90.57 |
| batch_sql | 4.01 / 4.01 | 59.76 / 59.76 | 7.16 / 7.16 | 8.67 / 8.67 | n/a |
| scan | 1.64 / 1.64 | 5.93 / 5.93 | 4.04 / 4.04 | 8.67 / 8.67 | 15.23 / 15.23 |
| point | 31.14 / 31.14 | 7.97 / 7.97 | 52.24 / 52.24 | 29.58 / 29.58 | n/a |
| point_sql | 31.14 / 31.14 | 30.05 / 30.05 | 52.24 / 52.24 | 29.58 / 29.58 | 25.96 / 25.96 |
| point_param | 31.14 / 31.14 | 10.50 / 10.50 | 52.24 / 52.24 | 29.58 / 29.58 | n/a |
| point_uk | 38.55 / 38.55 | 28.86 / 28.86 | 52.94 / 52.94 | 21.26 / 21.26 | n/a |
| range | 14.39 / 14.39 | 12.61 / 12.61 | 16.20 / 16.20 | 56.38 / 56.38 | 26.79 / 26.79 |
| indexed | 36.90 / 36.90 | 22.68 / 22.68 | 52.62 / 52.62 | 23.24 / 23.24 | n/a |
| order_limit | 12.49 / 12.49 | 17.71 / 17.71 | 20.44 / 20.44 | 39.46 / 39.46 | 14.99 / 14.99 |
| group_by | 23.59 / 23.59 | 73.97 / 73.97 | 41.44 / 41.44 | 87.64 / 87.64 | 59.72 / 59.72 |
| join | 2.08 / 2.08 | 20.84 / 20.84 | 5.55 / 5.55 | 6.04 / 6.04 | 28.46 / 28.46 |
| distinct | 9.01 / 9.01 | 37.30 / 37.30 | 14.30 / 14.30 | n/a | n/a |
| aggregate | 6.92 / 6.92 | 31.05 / 31.05 | 13.93 / 13.93 | n/a | n/a |
| subquery | 5.18 / 5.18 | 62.00 / 62.00 | 10.27 / 10.27 | n/a | n/a |
| index_range | 51.21 / 51.21 | 125.00 / 125.00 | 65.65 / 65.65 | n/a | n/a |
| insert_multi | 0.85 / 0.85 | 2.81 / 2.81 | 1.41 / 1.41 | n/a | n/a |
| upsert | 8.04 / 8.04 | 8.88 / 8.88 | 8.05 / 8.05 | n/a | n/a |
| upsert_param | 8.04 / 8.04 | 5.06 / 5.06 | 8.05 / 8.05 | n/a | n/a |
| update | 8.29 / 8.29 | 3.56 / 3.56 | 9.36 / 9.36 | 3.89 / 3.89 | n/a |
| update_sql | 8.29 / 8.29 | 17.65 / 17.65 | 9.36 / 9.36 | 3.89 / 3.89 | n/a |
| update_idx | 2.03 / 2.03 | 22.16 / 22.16 | 2.15 / 2.15 | 2.01 / 2.01 | n/a |
| delete | 7.42 / 7.42 | 5.39 / 5.39 | 8.82 / 8.82 | 2.40 / 2.40 | n/a |
| delete_sql | 7.42 / 7.42 | 14.95 / 14.95 | 8.82 / 8.82 | 2.40 / 2.40 | n/a |
| delete_idx | 1.59 / 1.59 | 20.19 / 20.19 | 2.33 / 2.33 | 4.48 / 4.48 | n/a |
| txn | 0.72 / 0.72 | 14.80 / 14.80 | 2.66 / 2.66 | 11.71 / 11.71 | n/a |
| rollback | 2.25 / 2.25 | 3.73 / 3.73 | 4.13 / 4.13 | 3.78 / 3.78 | n/a |
| open | 0.12 / 0.12 | 0.21 / 0.21 | 0.35 / 0.35 | 0.22 / 0.22 | n/a |
| in_list | 1.83 / 1.83 | 2.96 / 2.96 | 1.39 / 1.39 | n/a | 6.80 / 6.80 |
| sort_mixed | 23.48 / 23.48 | 45.25 / 45.25 | 36.21 / 36.21 | n/a | 44.07 / 44.07 |
| like_prefix | 3.97 / 3.97 | 19.97 / 19.97 | 12.06 / 12.06 | n/a | 37.99 / 37.99 |
| delete_range | 0.15 / 0.15 | 2.31 / 2.31 | 0.13 / 0.13 | n/a | n/a |
| update_expr | 0.45 / 0.45 | 12.79 / 12.79 | 0.74 / 0.74 | n/a | n/a |
| projection_narrow | 15.65 / 15.65 | 28.05 / 28.05 | 14.80 / 14.80 | 51.67 / 51.67 | 25.96 / 25.96 |
| projection_wide | 22.05 / 22.05 | 42.15 / 42.15 | 29.31 / 29.31 | 139.72 / 139.72 | 57.16 / 57.16 |
| join_indexed | 0.52 / 0.52 | 0.60 / 0.60 | 0.52 / 0.52 | 0.19 / 0.19 | n/a |
| delete_index_range | 0.06 / 0.06 | 2.65 / 2.65 | 0.08 / 0.08 | 0.65 / 0.65 | n/a |
| or_filter | 3.20 / 3.20 | 18.76 / 18.76 | 4.57 / 4.57 | 5.19 / 5.19 | 41.52 / 41.52 |
| insert_indexed | 2.85 / 2.85 | 19.54 / 19.54 | 5.64 / 5.64 | 6.04 / 6.04 | n/a |
| update_expr_idx | 3.33 / 3.33 | 26.46 / 26.46 | 7.11 / 7.11 | 10.18 / 10.18 | n/a |
| window_rank | 21.95 / 21.95 | 38.77 / 38.77 | 31.67 / 31.67 | 84.23 / 84.23 | 34.07 / 34.07 |
| join_left | 0.34 / 0.34 | 0.49 / 0.49 | 0.67 / 0.67 | 0.35 / 0.35 | 23.43 / 23.43 |
| exists_filter | 22.53 / 22.53 | 752.96 / 752.96 | 38.19 / 38.19 | 50.26 / 50.26 | 6024.30 / 6024.30 |

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
- sql.js does not run the SQL-feature workloads (`distinct`, `aggregate`, `subquery`, `index_range`, `insert_multi`, `upsert`, `in_list`, `sort_mixed`, `like_prefix`, `delete_range`, `update_expr`), so those cells stay `n/a`; the wasm binding runs `in_list`, `sort_mixed`, `like_prefix`, `projection_narrow`, `projection_wide`, `or_filter`, `window_rank`, `join_left` and `exists_filter` but not the mutation/index ones.
- `insert_indexed`, `upsert`, `update_expr`, `update_expr_idx` and `delete_range` on our side run on an in-memory `new SQLite()`, while the two peer columns write through their pager; the row set is validated on both sides.
- `batch_sql`, `update_idx`, `delete_idx`, `txn`, `update_expr` and `delete_range` run on an in-memory database on every engine, so no pager publication or file I/O is included. sql.js runs the SQL ones through its prepared-statement API; the wasm binding has no UPDATE/DELETE/index support and stays `n/a`.
- The SQL-engine workloads (`point_param`, `point_uk`, `order_limit`, `group_by`, `join`, `distinct`, `aggregate`, `subquery`, `in_list`, `sort_mixed`, `like_prefix`, `or_filter`, `projection_narrow`, `projection_wide`, `join_indexed`, `join_left`, `exists_filter`, `window_rank`, `insert_indexed`, `index_range`, `insert_multi`, `upsert`, `upsert_param`, `update_sql`, `delete_sql`, `update_expr`, `update_expr_idx`, `delete_range`, `delete_index_range`) run one untimed warmup round before `BENCH_ROUNDS` timed rounds; median/p95 come from the harness `benchSummary`, not local stats.
- `batch`, `scan`, `point`, `range`, `update`, `delete`, `rollback` and `open` still use the format-3 writer/reader primitives. The public `SQLite` entry does not expose raw record decoding, `rowByRowid`/`range` rowid windows, or the full-image `save()` that these timings are defined on.

## Capabilities still missing from the public API

- Direct rowid point read (`rowByRowid`) and inclusive rowid range read (`range`) without SQL parsing.
- Raw record decoding via a table cursor (`openDatabase(...).table(...)`) for `scan`.
- Writer-side `update`/`delete` slots and the explicit full-image `save()` that `update`/`delete`/`batch` include in their timings.
- Writer `begin`/`rollback` without SQL transaction control, used by `rollback`.
- A pure open/close handle over the main file with no statement preparation, used by `open`.

Regenerate: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
