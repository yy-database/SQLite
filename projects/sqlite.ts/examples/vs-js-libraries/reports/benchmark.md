# Benchmark report

Command: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
Defaults: `BENCH_ROWS=5000`, `BENCH_TXN=1000`, `BENCH_PAGE=4096`, `BENCH_ROUNDS=3`, `BENCH_POINT=1000`, `BENCH_RANGE=200`, `BENCH_MUTATE=1000`, `BENCH_LIMIT=200`, `BENCH_AGG=20`, `BENCH_JOIN=10`, `BENCH_DISTINCT=5`, `BENCH_SUBQUERY=20`, `BENCH_MULTI=10`, `BENCH_UPSERT=500`, `BENCH_SYNCHRONOUS=off`
Baseline: `node:sqlite` (`DatabaseSync`) = `1.00x`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.

## Provenance

- node: `v24.18.0`
- rustc: `rustc 1.101.0-nightly (1c3a65069 2026-11-02)`
- repo rev: `e7046f2`
- binding rev (`database.rs` pin in `projects/sqlite.rs/Cargo.toml`): `70aee1e`
- data: `5000` rows (page `4096`), `BENCH_ROUNDS=3`, point/indexed `1000`, range `200`, order_limit `200`, group_by `20`, join `10`, distinct `5`, subquery `20`, multi `10x100`, upsert `500`, mutate `1000`, projection `10`, join_indexed `10`

## Relative to `node:sqlite`

| Workload | node:sqlite | @yydb/sqlite | better-sqlite3 | sql.js | @yydb/sqlite-unknown-wasm32 |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | **1.00x** | 2.86x | 2.63x | 10.14x | 14.23x |
| batch_sql | **1.00x** | 14.10x | 3.48x | 2.70x | n/a |
| scan | **1.00x** | 1.48x | 1.30x | 2.35x | 1.59x |
| point | 1.00x | **0.22x** | 1.81x | 0.73x | n/a |
| point_sql | 1.00x | **0.70x** | 1.81x | 0.73x | 0.72x |
| point_param | 1.00x | **0.31x** | 1.81x | 0.73x | n/a |
| point_uk | 1.00x | **0.73x** | 1.93x | 0.88x | n/a |
| range | **1.00x** | 1.16x | 1.98x | 4.59x | 2.26x |
| indexed | 1.00x | **0.72x** | 1.88x | 0.79x | n/a |
| order_limit | **1.00x** | 1.21x | 1.55x | 3.46x | 1.75x |
| group_by | **1.00x** | 1.77x | 1.35x | 3.57x | 2.23x |
| join | **1.00x** | 4.34x | 1.06x | 2.28x | 6.93x |
| distinct | **1.00x** | 3.46x | 1.66x | n/a | n/a |
| aggregate | **1.00x** | 3.36x | 1.51x | n/a | n/a |
| subquery | **1.00x** | 7.67x | 1.82x | n/a | n/a |
| index_range | **1.00x** | 9.60x | 1.88x | n/a | n/a |
| insert_multi | **1.00x** | 6.94x | 2.17x | n/a | n/a |
| upsert | **1.00x** | 28.09x | 2.04x | n/a | n/a |
| upsert_param | **1.00x** | 15.08x | 2.04x | n/a | n/a |
| update | **1.00x** | 9.64x | 2.56x | 4.63x | n/a |
| update_sql | **1.00x** | 35.14x | 2.56x | 4.63x | n/a |
| update_idx | **1.00x** | 22.88x | 1.89x | 2.88x | n/a |
| delete | 1.00x | 0.67x | 1.71x | **0.32x** | n/a |
| delete_sql | 1.00x | 2.25x | 1.71x | **0.32x** | n/a |
| delete_idx | **1.00x** | 24.23x | 2.12x | 3.66x | n/a |
| txn | **1.00x** | 17.19x | 3.67x | 10.08x | n/a |
| rollback | 1.00x | **0.91x** | 2.51x | 2.15x | n/a |
| open | **1.00x** | 3.19x | 6.23x | 1.44x | n/a |
| in_list | **1.00x** | 2.28x | 2.48x | n/a | 6.43x |
| sort_mixed | **1.00x** | 1.86x | 1.89x | n/a | 2.51x |
| like_prefix | **1.00x** | 8.02x | 2.26x | n/a | 11.07x |
| delete_range | **1.00x** | 32.98x | 2.94x | n/a | n/a |
| update_expr | **1.00x** | 34.73x | 2.82x | n/a | n/a |
| projection_narrow | **1.00x** | 2.55x | 1.36x | 5.23x | 2.60x |
| projection_wide | **1.00x** | 2.25x | 2.05x | 9.70x | 3.02x |
| join_indexed | 1.00x | 1.51x | 1.76x | **0.93x** | n/a |
| delete_index_range | **1.00x** | 28.58x | 1.14x | 5.22x | n/a |
| or_filter | **1.00x** | 17.02x | 2.23x | 3.57x | 26.22x |
| insert_indexed | **1.00x** | 10.93x | 2.45x | 2.81x | n/a |
| update_expr_idx | **1.00x** | 8.42x | 1.95x | 3.63x | n/a |
| window_rank | **1.00x** | 1.64x | 1.73x | 5.75x | 1.57x |
| join_left | **1.00x** | 1.62x | 1.92x | 1.40x | 92.42x |
| exists_filter | **1.00x** | 37.52x | 2.12x | 2.57x | 344.16x |

## Absolute round timings (median / p95 ms)

| Workload | node:sqlite median / p95 (ms) | @yydb/sqlite median / p95 (ms) | better-sqlite3 median / p95 (ms) | sql.js median / p95 (ms) | @yydb/sqlite-unknown-wasm32 median / p95 (ms) |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | 3.80 / 5.18 | 10.86 / 11.54 | 9.98 / 10.38 | 38.54 / 67.77 | 54.10 / 92.18 |
| batch_sql | 2.87 / 3.53 | 40.48 / 44.53 | 10.00 / 10.20 | 7.77 / 9.58 | n/a |
| scan | 3.26 / 3.48 | 4.82 / 4.87 | 4.24 / 4.40 | 7.64 / 10.32 | 5.19 / 13.01 |
| point | 28.49 / 30.01 | 6.33 / 6.52 | 51.63 / 54.98 | 20.92 / 30.05 | n/a |
| point_sql | 28.49 / 30.01 | 20.01 / 20.91 | 51.63 / 54.98 | 20.92 / 30.05 | 20.53 / 27.42 |
| point_param | 28.49 / 30.01 | 8.87 / 8.93 | 51.63 / 54.98 | 20.92 / 30.05 | n/a |
| point_uk | 27.89 / 27.97 | 20.22 / 20.23 | 53.78 / 58.92 | 24.63 / 26.17 | n/a |
| range | 9.15 / 9.17 | 10.62 / 11.36 | 18.16 / 18.72 | 42.01 / 49.18 | 20.73 / 25.48 |
| indexed | 27.56 / 37.83 | 19.96 / 20.40 | 51.73 / 56.68 | 21.78 / 25.00 | n/a |
| order_limit | 10.17 / 12.91 | 12.31 / 12.32 | 15.73 / 16.08 | 35.16 / 39.87 | 17.77 / 19.46 |
| group_by | 26.42 / 26.74 | 46.70 / 48.43 | 35.74 / 39.55 | 94.32 / 101.35 | 58.90 / 66.97 |
| join | 3.36 / 3.41 | 14.57 / 20.06 | 3.55 / 4.62 | 7.66 / 8.13 | 23.29 / 24.76 |
| distinct | 6.84 / 8.12 | 23.65 / 26.97 | 11.37 / 12.51 | n/a | n/a |
| aggregate | 7.21 / 7.85 | 24.24 / 25.10 | 10.92 / 16.58 | n/a | n/a |
| subquery | 5.50 / 6.42 | 42.16 / 46.20 | 10.01 / 12.95 | n/a | n/a |
| index_range | 30.91 / 32.91 | 296.65 / 301.15 | 58.13 / 68.50 | n/a | n/a |
| insert_multi | 0.76 / 0.77 | 5.30 / 6.20 | 1.66 / 1.73 | n/a | n/a |
| upsert | 0.65 / 10.16 | 18.31 / 20.12 | 1.33 / 14.88 | n/a | n/a |
| upsert_param | 0.65 / 10.16 | 9.83 / 10.50 | 1.33 / 14.88 | n/a | n/a |
| update | 0.56 / 6.96 | 5.38 / 5.86 | 1.43 / 12.03 | 2.58 / 4.21 | n/a |
| update_sql | 0.56 / 6.96 | 19.61 / 20.03 | 1.43 / 12.03 | 2.58 / 4.21 | n/a |
| update_idx | 1.00 / 1.03 | 22.99 / 30.55 | 1.90 / 2.11 | 2.90 / 3.39 | n/a |
| delete | 7.40 / 7.80 | 4.96 / 5.27 | 12.66 / 13.48 | 2.35 / 3.19 | n/a |
| delete_sql | 7.40 / 7.80 | 16.65 / 19.85 | 12.66 / 13.48 | 2.35 / 3.19 | n/a |
| delete_idx | 0.92 / 1.30 | 22.27 / 24.30 | 1.95 / 2.71 | 3.37 / 3.96 | n/a |
| txn | 0.76 / 0.77 | 12.98 / 17.26 | 2.77 / 2.84 | 7.61 / 11.42 | n/a |
| rollback | 2.28 / 2.33 | 2.08 / 2.21 | 5.73 / 7.43 | 4.91 / 5.14 | n/a |
| open | 0.06 / 0.13 | 0.20 / 0.26 | 0.39 / 0.39 | 0.09 / 0.18 | n/a |
| in_list | 0.85 / 0.93 | 1.95 / 1.96 | 2.12 / 2.16 | n/a | 5.49 / 6.32 |
| sort_mixed | 17.68 / 22.45 | 32.89 / 33.03 | 33.43 / 33.60 | n/a | 44.29 / 44.34 |
| like_prefix | 3.65 / 4.13 | 29.22 / 29.99 | 8.25 / 9.13 | n/a | 40.35 / 41.39 |
| delete_range | 0.06 / 0.07 | 2.13 / 2.39 | 0.19 / 0.22 | n/a | n/a |
| update_expr | 0.35 / 0.36 | 12.09 / 12.18 | 0.98 / 1.03 | n/a | n/a |
| projection_narrow | 10.64 / 10.88 | 27.11 / 28.63 | 14.52 / 16.76 | 55.67 / 61.14 | 27.68 / 30.53 |
| projection_wide | 17.07 / 17.56 | 38.46 / 39.40 | 35.04 / 36.62 | 165.55 / 180.29 | 51.50 / 58.39 |
| join_indexed | 0.30 / 0.30 | 0.45 / 0.45 | 0.52 / 0.53 | 0.28 / 0.28 | n/a |
| delete_index_range | 0.02 / 0.05 | 0.66 / 0.74 | 0.03 / 0.09 | 0.12 / 0.27 | n/a |
| or_filter | 1.76 / 1.86 | 30.01 / 35.72 | 3.93 / 4.23 | 6.30 / 6.67 | 46.22 / 46.51 |
| insert_indexed | 1.77 / 1.79 | 19.40 / 21.97 | 4.35 / 4.84 | 4.98 / 6.29 | n/a |
| update_expr_idx | 2.14 / 3.41 | 18.03 / 25.88 | 4.17 / 7.18 | 7.76 / 10.45 | n/a |
| window_rank | 18.50 / 20.12 | 30.31 / 39.11 | 32.07 / 36.64 | 106.41 / 107.23 | 28.98 / 29.81 |
| join_left | 0.29 / 0.29 | 0.47 / 0.50 | 0.56 / 0.56 | 0.41 / 0.44 | 26.77 / 27.87 |
| exists_filter | 18.45 / 19.01 | 692.11 / 880.32 | 39.09 / 40.11 | 47.47 / 50.39 | 6348.41 / 6371.82 |

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
