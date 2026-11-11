# Benchmark report

Command: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
Defaults: `BENCH_ROWS=5000`, `BENCH_TXN=1000`, `BENCH_PAGE=4096`, `BENCH_ROUNDS=3`, `BENCH_POINT=1000`, `BENCH_RANGE=200`, `BENCH_MUTATE=1000`, `BENCH_LIMIT=200`, `BENCH_AGG=20`, `BENCH_JOIN=10`, `BENCH_DISTINCT=5`, `BENCH_SUBQUERY=20`, `BENCH_MULTI=10`, `BENCH_UPSERT=500`, `BENCH_SYNCHRONOUS=off`
Baseline: `node:sqlite` (`DatabaseSync`) = `1.00x`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.

## Provenance

- node: `v24.18.0`
- rustc: `rustc 1.101.0-nightly (1c3a65069 2026-11-02)`
- repo rev: `0abc61b`
- binding rev (`database.rs` pin in `projects/sqlite.rs/Cargo.toml`): `da7366e`
- data: `5000` rows (page `4096`), `BENCH_ROUNDS=3`, point/indexed `1000`, range `200`, order_limit `200`, group_by `20`, join `10`, distinct `5`, subquery `20`, multi `10x100`, upsert `500`, mutate `1000`

## Relative to `node:sqlite`

| Workload | node:sqlite | @yydb/sqlite | better-sqlite3 | sql.js | @yydb/sqlite-unknown-wasm32 |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | **1.00x** | 5.68x | 1.34x | 6.61x | 13.75x |
| scan | 1.00x | 2.32x | **0.81x** | 1.74x | 2.53x |
| point | 1.00x | **0.38x** | 1.12x | 0.80x | n/a |
| point_sql | 1.00x | 0.85x | 1.12x | **0.80x** | 1.07x |
| point_uk | 1.00x | 1.01x | 1.21x | **0.74x** | n/a |
| range | 1.00x | 1.29x | **0.94x** | 3.80x | 43.19x |
| indexed | 1.00x | 1.08x | 1.08x | **0.60x** | n/a |
| order_limit | **1.00x** | 3.21x | 1.27x | 2.88x | 1.69x |
| group_by | **1.00x** | 5.12x | 1.16x | 3.36x | 3.02x |
| join | **1.00x** | 9.07x | 1.38x | 1.87x | 8.30x |
| distinct | **1.00x** | 6.06x | 1.15x | n/a | n/a |
| aggregate | **1.00x** | 5.28x | 1.16x | n/a | n/a |
| subquery | **1.00x** | 18.98x | 1.22x | n/a | n/a |
| index_range | **1.00x** | 8.43x | 1.27x | n/a | n/a |
| insert_multi | 1.00x | 3.91x | **0.97x** | n/a | n/a |
| upsert | **1.00x** | 22.95x | 1.78x | n/a | n/a |
| update | **1.00x** | 17.90x | 1.32x | 1.91x | n/a |
| delete | 1.00x | 0.35x | 1.13x | **0.23x** | n/a |
| rollback | **1.00x** | 1.91x | 1.42x | 1.23x | n/a |
| open | 1.00x | 1.62x | 2.45x | **0.90x** | n/a |

## Absolute round timings (median / p95 ms)

| Workload | node:sqlite median / p95 (ms) | @yydb/sqlite median / p95 (ms) | better-sqlite3 median / p95 (ms) | sql.js median / p95 (ms) | @yydb/sqlite-unknown-wasm32 median / p95 (ms) |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | 3.61 / 4.61 | 20.47 / 20.88 | 4.84 / 5.54 | 23.83 / 45.37 | 49.58 / 75.79 |
| scan | 2.40 / 2.81 | 5.56 / 7.46 | 1.95 / 2.23 | 4.16 / 5.99 | 6.05 / 13.01 |
| point | 20.98 / 23.67 | 7.89 / 9.38 | 23.56 / 25.55 | 16.87 / 17.64 | n/a |
| point_sql | 20.98 / 23.67 | 17.83 / 18.21 | 23.56 / 25.55 | 16.87 / 17.64 | 22.50 / 30.10 |
| point_uk | 20.36 / 21.16 | 20.62 / 25.14 | 24.54 / 25.11 | 14.99 / 15.40 | n/a |
| range | 8.60 / 10.64 | 11.13 / 12.57 | 8.05 / 8.18 | 32.67 / 35.73 | 371.60 / 421.97 |
| indexed | 21.54 / 22.05 | 23.29 / 24.06 | 23.15 / 27.01 | 12.88 / 14.52 | n/a |
| order_limit | 7.75 / 8.27 | 24.85 / 26.45 | 9.80 / 11.75 | 22.30 / 24.18 | 13.09 / 14.47 |
| group_by | 20.15 / 20.54 | 103.27 / 106.00 | 23.45 / 29.14 | 67.74 / 69.21 | 60.83 / 65.39 |
| join | 2.05 / 2.06 | 18.62 / 20.87 | 2.83 / 3.08 | 3.84 / 3.87 | 17.03 / 19.96 |
| distinct | 6.57 / 7.47 | 39.82 / 42.61 | 7.58 / 9.12 | n/a | n/a |
| aggregate | 7.00 / 7.05 | 36.98 / 40.19 | 8.15 / 8.63 | n/a | n/a |
| subquery | 4.71 / 4.84 | 89.43 / 98.30 | 5.76 / 6.16 | n/a | n/a |
| index_range | 28.00 / 31.35 | 236.08 / 239.34 | 35.59 / 36.71 | n/a | n/a |
| insert_multi | 0.78 / 1.17 | 3.04 / 3.22 | 0.75 / 0.79 | n/a | n/a |
| upsert | 0.46 / 10.62 | 10.47 / 14.60 | 0.81 / 8.06 | n/a | n/a |
| update | 0.89 / 8.22 | 15.89 / 16.37 | 1.17 / 8.33 | 1.70 / 2.05 | n/a |
| delete | 6.79 / 7.66 | 2.40 / 4.28 | 7.67 / 8.63 | 1.59 / 1.98 | n/a |
| rollback | 2.89 / 3.01 | 5.51 / 5.59 | 4.09 / 4.35 | 3.53 / 3.67 | n/a |
| open | 0.07 / 0.15 | 0.11 / 0.22 | 0.16 / 0.37 | 0.06 / 0.13 | n/a |

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
