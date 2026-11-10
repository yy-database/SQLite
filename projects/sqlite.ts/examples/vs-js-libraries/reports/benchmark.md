# Benchmark report

Command: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
Defaults: `BENCH_ROWS=2000`, `BENCH_TXN=500`, `BENCH_PAGE=4096`, `BENCH_ROUNDS=3`, `BENCH_POINT=200`, `BENCH_RANGE=50`, `BENCH_MUTATE=200`, `BENCH_LIMIT=50`, `BENCH_AGG=5`, `BENCH_JOIN=5`, `BENCH_SYNCHRONOUS=off`
Baseline: `node:sqlite` (`DatabaseSync`) = `1.00x`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.

## Provenance

- node: `v24.18.0`
- rustc: `rustc 1.101.0-nightly (1c3a65069 2026-11-02)`
- repo rev: `7d0af24`
- binding rev (`database.rs` pin in `projects/sqlite.rs/Cargo.toml`): `0d688fe`
- data: `2000` rows (page `4096`), `BENCH_ROUNDS=3`, point/indexed `200`, range `50`, order_limit `50`, group_by `5`, join `5`, mutate `200`

## Relative to `node:sqlite`

| Workload | node:sqlite | @yydb/sqlite | better-sqlite3 | sql.js | @yydb/sqlite-unknown-wasm32 |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | **1.00x** | 5.03x | 3.64x | 15.08x | 23.84x |
| scan | **1.00x** | 1.15x | 1.45x | 2.42x | 3.74x |
| point | 1.00x | **0.27x** | 2.00x | 1.40x | n/a |
| point_sql | 1.00x | **0.72x** | 2.00x | 1.40x | 1.93x |
| point_uk | **1.00x** | 90.06x | 2.23x | 1.40x | n/a |
| range | **1.00x** | 2.12x | 2.80x | 7.92x | 38.67x |
| indexed | **1.00x** | 90.72x | 2.59x | 1.17x | n/a |
| order_limit | **1.00x** | 78.78x | 2.63x | 5.07x | 45.67x |
| group_by | **1.00x** | 13.57x | 1.88x | 6.38x | 13.37x |
| join | **1.00x** | 66.24x | 2.63x | 4.38x | 45.79x |
| update | **1.00x** | 30.63x | 2.49x | 4.55x | n/a |
| delete | 1.00x | 0.15x | 1.08x | **0.13x** | n/a |
| rollback | 1.00x | **0.87x** | 2.05x | 1.51x | n/a |
| open | **1.00x** | 1.02x | 2.51x | 1.96x | n/a |

## Absolute round timings (median / p95 ms)

| Workload | node:sqlite median / p95 (ms) | @yydb/sqlite median / p95 (ms) | better-sqlite3 median / p95 (ms) | sql.js median / p95 (ms) | @yydb/sqlite-unknown-wasm32 median / p95 (ms) |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | 1.30 / 1.53 | 6.54 / 6.81 | 4.73 / 5.13 | 19.60 / 54.43 | 30.98 / 61.63 |
| scan | 1.64 / 2.58 | 1.89 / 1.94 | 2.38 / 2.51 | 3.98 / 4.08 | 6.14 / 12.12 |
| point | 3.82 / 4.37 | 1.03 / 1.20 | 7.64 / 8.48 | 5.34 / 6.85 | n/a |
| point_sql | 3.82 / 4.37 | 2.76 / 3.49 | 7.64 / 8.48 | 5.34 / 6.85 | 7.39 / 10.47 |
| point_uk | 3.87 / 4.10 | 348.89 / 404.01 | 8.65 / 9.55 | 5.43 / 6.29 | n/a |
| range | 1.82 / 1.90 | 3.87 / 4.46 | 5.10 / 9.52 | 14.43 / 15.85 | 70.49 / 72.76 |
| indexed | 4.50 / 4.69 | 408.51 / 469.30 | 11.66 / 16.42 | 5.27 / 6.13 | n/a |
| order_limit | 1.73 / 2.43 | 136.13 / 157.88 | 4.54 / 5.14 | 8.75 / 10.57 | 78.92 / 80.51 |
| group_by | 1.82 / 1.99 | 24.70 / 25.93 | 3.43 / 5.75 | 11.61 / 13.63 | 24.33 / 25.90 |
| join | 0.44 / 0.46 | 28.88 / 39.92 | 1.15 / 1.28 | 1.91 / 1.98 | 19.97 / 19.97 |
| update | 0.26 / 6.80 | 7.90 / 10.41 | 0.64 / 8.51 | 1.18 / 1.73 | n/a |
| delete | 6.86 / 7.40 | 1.00 / 1.55 | 7.43 / 7.55 | 0.91 / 1.34 | n/a |
| rollback | 1.03 / 1.46 | 0.90 / 1.01 | 2.11 / 3.32 | 1.56 / 2.22 | n/a |
| open | 0.07 / 0.09 | 0.07 / 0.14 | 0.18 / 0.28 | 0.14 / 0.25 | n/a |

## Workloads

- `batch`: create table, 2000 rows in transactions of 500, save file. `BENCH_SYNCHRONOUS=on` moves every library to `synchronous=FULL`.
- `scan`: open + full table scan per round.
- `point`: reader `rowByRowid` vs each peer's prepared `get`.
- `point_sql`: our SQL engine `select ... where id = N` vs the same peer prepared `get` (peer cells reuse `point`).
- `point_uk`: point lookup through a **unique** index on `label`; our side runs `select ... where label = '...'` on an engine carrying `create unique index`, peers through their unique index (one untimed warmup round first).
- `range`: 50-row `between` windows, reader `range` vs peers' prepared range.
- `indexed`: equality on an indexed `label` column; our side runs through the SQL engine, peers through their index.
- `order_limit`: `select ... order by id limit 50` — repeated 50x per round; separates the key-order scan constant from the per-statement fixed cost.
- `group_by`: `select cast(score as integer), count(*) ... group by cast(score as integer)` (5 queries per round, 501 groups over 2000 rows).
- `join`: `select count(*) from items join items as b on b.id = items.id % 50` (5 queries per round, 1960 matched pairs) — exposes a nested full scan of the inner side.
- `update` / `delete`: 200 mutations in one transaction + save (our writer) vs peers' prepared mutation in a transaction.
- `rollback`: begin + 200 inserts + rollback (nothing persisted).
- `open`: open + close of the main file, no reads.
- `@yydb/sqlite-unknown-wasm32` is the in-memory SQL binding: it runs `batch` (inserts + snapshot export + file write), `scan`, `point_sql`, `range`, `order_limit`, `group_by` and `join` through `exec`; it has no reader point API, no UPDATE/DELETE/indexes and no file open, so the remaining cells are `n/a`.

## Intentional deltas

- Our writer is snapshot-based: `update`/`delete` include the full-image `save()`; peers write in place through their pager.
- sql.js peer scan rebuilds the WASM DB from the serialized image each round; peer batch/update/delete timings include `export()`.
- `point_sql` has no separate peer path — peers' prepared `get` is the reference.
- The wasm column reads the same in-memory image every round (`SELECT` re-scans the image; the binding has no seek), and its `batch` includes `snapshot()` + the file write.
- The four SQL-engine workloads (`point_uk`, `order_limit`, `group_by`, `join`) run one untimed warmup round before `BENCH_ROUNDS` timed rounds; median/p95 come from the harness `benchSummary`, not local stats.

Regenerate: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
