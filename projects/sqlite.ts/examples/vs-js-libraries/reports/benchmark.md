# Benchmark report

Command: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
Defaults: `BENCH_ROWS=5000`, `BENCH_TXN=1000`, `BENCH_PAGE=4096`, `BENCH_ROUNDS=3`, `BENCH_POINT=1000`, `BENCH_RANGE=200`, `BENCH_MUTATE=1000`, `BENCH_LIMIT=200`, `BENCH_AGG=20`, `BENCH_JOIN=10`, `BENCH_DISTINCT=5`, `BENCH_SUBQUERY=20`, `BENCH_MULTI=10`, `BENCH_UPSERT=500`, `BENCH_SYNCHRONOUS=off`
Baseline: `node:sqlite` (`DatabaseSync`) = `1.00x`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.

## Provenance

- node: `v24.18.0`
- rustc: `rustc 1.101.0-nightly (1c3a65069 2026-11-02)`
- repo rev: `ca3564f`
- binding rev (`database.rs` pin in `projects/sqlite.rs/Cargo.toml`): `70aee1e`
- data: `5000` rows (page `4096`), `BENCH_ROUNDS=3`, point/indexed `1000`, range `200`, order_limit `200`, group_by `20`, join `10`, distinct `5`, subquery `20`, multi `10x100`, upsert `500`, mutate `1000`

## Relative to `node:sqlite`

| Workload | node:sqlite | @yydb/sqlite | better-sqlite3 | sql.js | @yydb/sqlite-unknown-wasm32 |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | **1.00x** | 2.44x | 1.31x | 5.49x | 9.95x |
| batch_sql | **1.00x** | 20.13x | 1.62x | 1.89x | n/a |
| scan | 1.00x | 1.90x | **0.45x** | 1.60x | 1.49x |
| point | 1.00x | **0.35x** | 1.14x | 0.76x | n/a |
| point_sql | 1.00x | 0.98x | 1.14x | **0.76x** | 0.95x |
| point_param | 1.00x | **0.47x** | 1.14x | 0.76x | n/a |
| point_uk | 1.00x | 1.76x | 1.10x | **0.64x** | n/a |
| range | 1.00x | 4.66x | **0.96x** | 3.10x | 26.24x |
| indexed | 1.00x | 1.49x | 1.10x | **0.64x** | n/a |
| order_limit | 1.00x | 2.85x | 1.17x | 1.75x | **0.79x** |
| group_by | 1.00x | 2.90x | **0.97x** | 1.92x | 1.06x |
| join | 1.00x | 4.93x | **0.79x** | 1.00x | 3.43x |
| distinct | 1.00x | 2.80x | **0.79x** | n/a | n/a |
| aggregate | **1.00x** | 6.10x | 1.44x | n/a | n/a |
| subquery | 1.00x | 12.06x | **0.99x** | n/a | n/a |
| index_range | **1.00x** | 7.82x | 1.42x | n/a | n/a |
| insert_multi | **1.00x** | 5.05x | 1.49x | n/a | n/a |
| upsert | **1.00x** | 36.95x | 3.79x | n/a | n/a |
| upsert_param | **1.00x** | 20.48x | 3.79x | n/a | n/a |
| update | **1.00x** | 5.10x | 2.13x | 3.13x | n/a |
| update_sql | **1.00x** | 20.54x | 2.13x | 3.13x | n/a |
| update_idx | **1.00x** | 22.86x | 1.36x | 1.67x | n/a |
| delete | 1.00x | 0.85x | 1.12x | **0.42x** | n/a |
| delete_sql | 1.00x | 3.19x | 1.12x | **0.42x** | n/a |
| delete_idx | **1.00x** | 18.04x | 1.50x | 1.53x | n/a |
| txn | **1.00x** | 12.28x | 1.46x | 9.84x | n/a |
| rollback | **1.00x** | 1.43x | 1.35x | 1.12x | n/a |
| open | **1.00x** | 2.55x | 3.17x | 1.27x | n/a |
| in_list | **1.00x** | 2.59x | 1.70x | n/a | 195.85x |
| sort_mixed | **1.00x** | 2.52x | 1.35x | n/a | 1.48x |
| like_prefix | **1.00x** | 18.41x | 1.27x | n/a | 9.50x |
| delete_range | **1.00x** | 44.47x | 1.41x | n/a | n/a |
| update_expr | **1.00x** | 39.64x | 1.28x | n/a | n/a |

## Absolute round timings (median / p95 ms)

| Workload | node:sqlite median / p95 (ms) | @yydb/sqlite median / p95 (ms) | better-sqlite3 median / p95 (ms) | sql.js median / p95 (ms) | @yydb/sqlite-unknown-wasm32 median / p95 (ms) |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | 8.09 / 9.60 | 19.71 / 23.34 | 10.57 / 11.27 | 44.40 / 74.78 | 80.51 / 130.20 |
| batch_sql | 5.24 / 5.91 | 105.46 / 105.70 | 8.49 / 8.63 | 9.91 / 10.36 | n/a |
| scan | 6.51 / 7.07 | 12.38 / 12.94 | 2.95 / 5.38 | 10.42 / 14.28 | 9.71 / 19.84 |
| point | 38.38 / 38.39 | 13.59 / 14.35 | 43.72 / 44.05 | 29.05 / 41.67 | n/a |
| point_sql | 38.38 / 38.39 | 37.54 / 38.15 | 43.72 / 44.05 | 29.05 / 41.67 | 36.60 / 43.47 |
| point_param | 38.38 / 38.39 | 18.07 / 20.32 | 43.72 / 44.05 | 29.05 / 41.67 | n/a |
| point_uk | 40.42 / 47.10 | 71.05 / 98.97 | 44.59 / 47.27 | 25.66 / 28.08 | n/a |
| range | 19.59 / 27.59 | 91.32 / 156.29 | 18.88 / 19.41 | 60.70 / 65.09 | 513.90 / 593.06 |
| indexed | 44.29 / 46.59 | 65.86 / 208.88 | 48.75 / 56.54 | 28.18 / 28.84 | n/a |
| order_limit | 23.35 / 23.75 | 66.47 / 67.01 | 27.31 / 27.54 | 40.92 / 53.74 | 18.50 / 19.68 |
| group_by | 56.57 / 72.28 | 164.04 / 182.22 | 54.61 / 57.97 | 108.40 / 112.11 | 59.91 / 62.10 |
| join | 7.71 / 8.76 | 37.97 / 46.19 | 6.12 / 6.30 | 7.73 / 7.99 | 26.42 / 27.64 |
| distinct | 24.71 / 29.71 | 69.23 / 71.02 | 19.62 / 22.88 | n/a | n/a |
| aggregate | 11.74 / 14.03 | 71.61 / 75.59 | 16.91 / 17.21 | n/a | n/a |
| subquery | 12.30 / 14.98 | 148.40 / 167.51 | 12.22 / 14.15 | n/a | n/a |
| index_range | 53.76 / 54.53 | 420.37 / 497.60 | 76.51 / 77.43 | n/a | n/a |
| insert_multi | 1.40 / 1.53 | 7.07 / 8.12 | 2.08 / 2.14 | n/a | n/a |
| upsert | 0.59 / 7.31 | 21.75 / 21.88 | 2.23 / 8.93 | n/a | n/a |
| upsert_param | 0.59 / 7.31 | 12.06 / 12.27 | 2.23 / 8.93 | n/a | n/a |
| update | 1.02 / 8.56 | 5.20 / 5.33 | 2.17 / 9.74 | 3.20 / 4.27 | n/a |
| update_sql | 1.02 / 8.56 | 20.96 / 22.86 | 2.17 / 9.74 | 3.20 / 4.27 | n/a |
| update_idx | 1.95 / 2.15 | 44.59 / 50.18 | 2.65 / 4.61 | 3.25 / 4.87 | n/a |
| delete | 7.67 / 8.92 | 6.50 / 6.65 | 8.62 / 9.45 | 3.20 / 3.44 | n/a |
| delete_sql | 7.67 / 8.92 | 24.48 / 39.24 | 8.62 / 9.45 | 3.20 / 3.44 | n/a |
| delete_idx | 1.72 / 2.32 | 30.99 / 37.17 | 2.58 / 3.04 | 2.62 / 4.03 | n/a |
| txn | 1.71 / 1.72 | 20.98 / 22.32 | 2.49 / 3.41 | 16.80 / 16.82 | n/a |
| rollback | 4.34 / 4.43 | 6.19 / 6.64 | 5.85 / 6.77 | 4.84 / 4.98 | n/a |
| open | 0.08 / 0.22 | 0.21 / 0.34 | 0.26 / 0.38 | 0.10 / 0.24 | n/a |
| in_list | 1.13 / 1.17 | 2.94 / 4.56 | 1.93 / 2.94 | n/a | 222.26 / 224.28 |
| sort_mixed | 32.25 / 34.94 | 81.25 / 84.36 | 43.44 / 43.48 | n/a | 47.77 / 48.55 |
| like_prefix | 7.22 / 7.57 | 133.03 / 138.60 | 9.20 / 9.81 | n/a | 68.63 / 71.70 |
| delete_range | 0.13 / 0.19 | 5.63 / 5.65 | 0.18 / 0.28 | n/a | n/a |
| update_expr | 0.82 / 1.01 | 32.52 / 35.30 | 1.05 / 1.53 | n/a | n/a |

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
- `@yydb/sqlite-unknown-wasm32` is the in-memory SQL binding: it runs `batch` (inserts + snapshot export + file write), `scan`, `point_sql`, `range`, `order_limit`, `group_by`, `join`, `in_list`, `sort_mixed` and `like_prefix` through `exec`; it has no reader point API, no UPDATE/DELETE/indexes and no file open, so the remaining cells are `n/a`.

## Intentional deltas

- Our writer is snapshot-based: `update`/`delete` include the full-image `save()`; peers write in place through their pager.
- sql.js peer scan rebuilds the WASM DB from the serialized image each round; peer batch/update/delete timings include `export()`.
- `point_sql` has no separate peer path — peers' prepared `get` is the reference.
- The wasm column reads the same in-memory image every round (`SELECT` re-scans the image; the binding has no seek), and its `batch` includes `snapshot()` + the file write.
- sql.js does not run the SQL-feature workloads (`distinct`, `aggregate`, `subquery`, `index_range`, `insert_multi`, `upsert`, `in_list`, `sort_mixed`, `like_prefix`, `delete_range`, `update_expr`), so those cells stay `n/a`; the wasm binding runs `in_list`, `sort_mixed` and `like_prefix` but not the mutation/index ones.
- `insert_multi`, `upsert`, `update_expr` and `delete_range` on our side run on an in-memory `new SQLite()`, while the two peer columns write through their pager; the row set is validated on both sides.
- `batch_sql`, `update_idx`, `delete_idx`, `txn`, `update_expr` and `delete_range` run on an in-memory database on every engine, so no pager publication or file I/O is included. sql.js runs the SQL ones through its prepared-statement API; the wasm binding has no UPDATE/DELETE/index support and stays `n/a`.
- The SQL-engine workloads (`point_param`, `point_uk`, `order_limit`, `group_by`, `join`, `distinct`, `aggregate`, `subquery`, `in_list`, `sort_mixed`, `like_prefix`, `index_range`, `insert_multi`, `upsert`, `upsert_param`, `update_sql`, `delete_sql`, `update_expr`, `delete_range`) run one untimed warmup round before `BENCH_ROUNDS` timed rounds; median/p95 come from the harness `benchSummary`, not local stats.
- `batch`, `scan`, `point`, `range`, `update`, `delete`, `rollback` and `open` still use the format-3 writer/reader primitives. The public `SQLite` entry does not expose raw record decoding, `rowByRowid`/`range` rowid windows, or the full-image `save()` that these timings are defined on.

## Capabilities still missing from the public API

- Direct rowid point read (`rowByRowid`) and inclusive rowid range read (`range`) without SQL parsing.
- Raw record decoding via a table cursor (`openDatabase(...).table(...)`) for `scan`.
- Writer-side `update`/`delete` slots and the explicit full-image `save()` that `update`/`delete`/`batch` include in their timings.
- Writer `begin`/`rollback` without SQL transaction control, used by `rollback`.
- A pure open/close handle over the main file with no statement preparation, used by `open`.

Regenerate: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
