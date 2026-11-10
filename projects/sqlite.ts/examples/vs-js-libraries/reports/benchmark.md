# Benchmark report

Command: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
Defaults: `BENCH_ROWS=5000`, `BENCH_TXN=1000`, `BENCH_PAGE=4096`, `BENCH_ROUNDS=3`, `BENCH_POINT=1000`, `BENCH_RANGE=200`, `BENCH_MUTATE=1000`, `BENCH_LIMIT=200`, `BENCH_AGG=20`, `BENCH_JOIN=10`, `BENCH_DISTINCT=5`, `BENCH_SUBQUERY=20`, `BENCH_MULTI=10`, `BENCH_UPSERT=500`, `BENCH_SYNCHRONOUS=off`
Baseline: `node:sqlite` (`DatabaseSync`) = `1.00x`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.

## Provenance

- node: `v24.18.0`
- rustc: `rustc 1.101.0-nightly (1c3a65069 2026-11-02)`
- repo rev: `8ebd091`
- binding rev (`database.rs` pin in `projects/sqlite.rs/Cargo.toml`): `690087f`
- data: `5000` rows (page `4096`), `BENCH_ROUNDS=3`, point/indexed `1000`, range `200`, order_limit `200`, group_by `20`, join `10`, distinct `5`, subquery `20`, multi `10x100`, upsert `500`, mutate `1000`

## Relative to `node:sqlite`

| Workload | node:sqlite | @yydb/sqlite | better-sqlite3 | sql.js | @yydb/sqlite-unknown-wasm32 |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | **1.00x** | 4.79x | 1.26x | 5.92x | 9.02x |
| scan | **1.00x** | 3.02x | 1.25x | 2.59x | 3.91x |
| point | 1.00x | **0.34x** | 1.02x | 0.69x | n/a |
| point_sql | 1.00x | 0.81x | 1.02x | **0.69x** | 0.77x |
| point_uk | 1.00x | 0.84x | 1.18x | **0.64x** | n/a |
| range | **1.00x** | 1.48x | 1.11x | 3.19x | 49.21x |
| indexed | 1.00x | 0.81x | 1.09x | **0.58x** | n/a |
| order_limit | 1.00x | 2.37x | **0.99x** | 2.65x | 1.40x |
| group_by | 1.00x | 6.26x | **0.96x** | 2.43x | 3.22x |
| join | **1.00x** | 53.41x | 1.11x | 2.04x | 24.84x |
| distinct | **1.00x** | 7.52x | 1.12x | n/a | n/a |
| aggregate | **1.00x** | 12.14x | 1.16x | n/a | n/a |
| subquery | **1.00x** | 27.74x | 1.09x | n/a | n/a |
| index_range | 1.00x | 23.97x | **0.86x** | n/a | n/a |
| insert_multi | **1.00x** | 5.31x | 1.22x | n/a | n/a |
| upsert | 1.00x | 1980.19x | **0.87x** | n/a | n/a |
| update | **1.00x** | 25.25x | 1.16x | 2.05x | n/a |
| delete | 1.00x | 0.39x | 1.19x | **0.17x** | n/a |
| rollback | 1.00x | 1.21x | 1.06x | **0.99x** | n/a |
| open | 1.00x | 1.76x | 3.12x | **0.97x** | n/a |

## Absolute round timings (median / p95 ms)

| Workload | node:sqlite median / p95 (ms) | @yydb/sqlite median / p95 (ms) | better-sqlite3 median / p95 (ms) | sql.js median / p95 (ms) | @yydb/sqlite-unknown-wasm32 median / p95 (ms) |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | 3.49 / 4.53 | 16.70 / 17.78 | 4.40 / 4.85 | 20.63 / 48.58 | 31.45 / 65.47 |
| scan | 1.63 / 3.34 | 4.92 / 5.54 | 2.03 / 2.05 | 4.22 / 4.30 | 6.36 / 10.54 |
| point | 18.43 / 18.73 | 6.24 / 6.27 | 18.79 / 20.34 | 12.79 / 14.97 | n/a |
| point_sql | 18.43 / 18.73 | 14.96 / 15.33 | 18.79 / 20.34 | 12.79 / 14.97 | 14.24 / 25.92 |
| point_uk | 18.35 / 20.11 | 15.34 / 15.50 | 21.70 / 23.48 | 11.78 / 12.76 | n/a |
| range | 7.07 / 8.03 | 10.47 / 11.46 | 7.87 / 8.27 | 22.59 / 25.08 | 348.12 / 348.48 |
| indexed | 19.01 / 19.53 | 15.34 / 17.78 | 20.79 / 21.38 | 10.98 / 13.28 | n/a |
| order_limit | 6.86 / 6.86 | 16.23 / 17.37 | 6.82 / 8.01 | 18.17 / 18.47 | 9.58 / 9.93 |
| group_by | 19.16 / 20.01 | 120.01 / 125.01 | 18.42 / 20.17 | 46.48 / 48.38 | 61.76 / 62.98 |
| join | 1.88 / 2.13 | 100.49 / 104.15 | 2.09 / 2.17 | 3.84 / 3.91 | 46.74 / 47.44 |
| distinct | 5.71 / 5.98 | 42.94 / 44.77 | 6.40 / 6.95 | n/a | n/a |
| aggregate | 6.12 / 6.25 | 74.29 / 76.30 | 7.11 / 7.19 | n/a | n/a |
| subquery | 4.37 / 4.46 | 121.25 / 124.08 | 4.77 / 4.99 | n/a | n/a |
| index_range | 26.68 / 26.84 | 639.45 / 642.22 | 22.99 / 23.21 | n/a | n/a |
| insert_multi | 0.63 / 0.67 | 3.37 / 3.50 | 0.78 / 1.24 | n/a | n/a |
| upsert | 1.09 / 17.32 | 2167.32 / 2173.40 | 0.95 / 7.80 | n/a | n/a |
| update | 0.90 / 7.47 | 22.74 / 23.91 | 1.04 / 7.78 | 1.84 / 2.05 | n/a |
| delete | 6.43 / 7.42 | 2.50 / 2.72 | 7.63 / 8.94 | 1.12 / 2.13 | n/a |
| rollback | 2.50 / 3.15 | 3.03 / 3.17 | 2.65 / 3.72 | 2.47 / 3.20 | n/a |
| open | 0.05 / 0.12 | 0.09 / 0.16 | 0.17 / 0.32 | 0.05 / 0.13 | n/a |

## Workloads

- `batch`: create table, 5000 rows in transactions of 1000, save file. `BENCH_SYNCHRONOUS=on` moves every library to `synchronous=FULL`.
- `scan`: open + full table scan per round.
- `point`: reader `rowByRowid` vs each peer's prepared `get`.
- `point_sql`: our SQL engine `select ... where id = N` vs the same peer prepared `get` (peer cells reuse `point`).
- `point_uk`: point lookup through a **unique** index on `label`; our side runs `select ... where label = '...'` on an engine carrying `create unique index`, peers through their unique index (one untimed warmup round first).
- `range`: 50-row `between` windows, reader `range` vs peers' prepared range.
- `indexed`: equality on an indexed `label` column; our side runs through the SQL engine, peers through their index.
- `order_limit`: `select ... order by id limit 50` — repeated 200x per round; separates the key-order scan constant from the per-statement fixed cost.
- `group_by`: `select cast(score as integer), count(*) ... group by cast(score as integer)` (20 queries per round, 1251 groups over 5000 rows).
- `join`: `select count(*) from items join items as b on b.id = items.id % 50` (10 queries per round, 4900 matched pairs) — exposes a nested full scan of the inner side.
- `distinct`: `select distinct label from items` (5 queries per round, 5000 distinct labels) — worst case for the dedup structure because nothing collapses.
- `aggregate`: `select count(*), sum(score), min(score), max(score) from items` (20 queries per round) — single-pass aggregate without grouping.
- `subquery`: `select count(*) ... where id in (select id from items where score > 1000)` (20 queries per round, 1000 matches) — uncorrelated `IN` subquery.
- `index_range`: `select id from items where label between 'row-1000' and 'row-1499' order by label` (200 queries per round, 553 rows) — range predicate on an indexed column.
- `insert_multi`: 10 statements of 100 literal rows in one transaction (1000 rows total).
- `upsert`: 500 `insert ... on conflict(id) do update` statements in one transaction.
- `update` / `delete`: 1000 mutations in one transaction + save (our writer) vs peers' prepared mutation in a transaction.
- `rollback`: begin + 1000 inserts + rollback (nothing persisted).
- `open`: open + close of the main file, no reads.
- `@yydb/sqlite-unknown-wasm32` is the in-memory SQL binding: it runs `batch` (inserts + snapshot export + file write), `scan`, `point_sql`, `range`, `order_limit`, `group_by` and `join` through `exec`; it has no reader point API, no UPDATE/DELETE/indexes and no file open, so the remaining cells are `n/a`.

## Intentional deltas

- Our writer is snapshot-based: `update`/`delete` include the full-image `save()`; peers write in place through their pager.
- sql.js peer scan rebuilds the WASM DB from the serialized image each round; peer batch/update/delete timings include `export()`.
- `point_sql` has no separate peer path — peers' prepared `get` is the reference.
- The wasm column reads the same in-memory image every round (`SELECT` re-scans the image; the binding has no seek), and its `batch` includes `snapshot()` + the file write.
- sql.js and the wasm binding do not run the six SQL-feature workloads (`distinct`, `aggregate`, `subquery`, `index_range`, `insert_multi`, `upsert`), so those cells stay `n/a`; they are compared only on `node:sqlite` and `better-sqlite3`.
- `insert_multi` and `upsert` on our side run on the in-memory SQL engine, while the two peer columns write through their file pager; the row set is validated on both sides.
- The ten SQL-engine workloads (`point_uk`, `order_limit`, `group_by`, `join`, `distinct`, `aggregate`, `subquery`, `index_range`, `insert_multi`, `upsert`) run one untimed warmup round before `BENCH_ROUNDS` timed rounds; median/p95 come from the harness `benchSummary`, not local stats.

Regenerate: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
