# Benchmark report

Command: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
Defaults: `BENCH_ROWS=5000`, `BENCH_TXN=1000`, `BENCH_PAGE=4096`, `BENCH_ROUNDS=3`, `BENCH_POINT=1000`, `BENCH_RANGE=200`, `BENCH_MUTATE=1000`, `BENCH_LIMIT=200`, `BENCH_AGG=20`, `BENCH_JOIN=10`, `BENCH_SYNCHRONOUS=off`
Baseline: `node:sqlite` (`DatabaseSync`) = `1.00x`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.

## Provenance

- node: `v24.18.0`
- rustc: `rustc 1.101.0-nightly (1c3a65069 2026-11-02)`
- repo rev: `b2ba324`
- binding rev (`database.rs` pin in `projects/sqlite.rs/Cargo.toml`): `a6c10ae`
- data: `5000` rows (page `4096`), `BENCH_ROUNDS=3`, point/indexed `1000`, range `200`, order_limit `200`, group_by `20`, join `10`, mutate `1000`

## Relative to `node:sqlite`

| Workload | node:sqlite | @yydb/sqlite | better-sqlite3 | sql.js | @yydb/sqlite-unknown-wasm32 |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | **1.00x** | 3.49x | 1.11x | 3.80x | 6.74x |
| scan | **1.00x** | 2.73x | 1.17x | 2.02x | 2.51x |
| point | 1.00x | **0.29x** | 0.88x | 0.60x | n/a |
| point_sql | 1.00x | 0.68x | 0.88x | **0.60x** | 0.65x |
| point_uk | 1.00x | 1.50x | 1.07x | **0.52x** | n/a |
| range | 1.00x | 2.14x | **0.94x** | 2.24x | 37.03x |
| indexed | 1.00x | 0.74x | 0.92x | **0.58x** | n/a |
| order_limit | **1.00x** | 2.46x | 1.07x | 2.03x | 1.35x |
| group_by | **1.00x** | 6.40x | 1.01x | 2.19x | 3.15x |
| join | 1.00x | 44.57x | **0.99x** | 1.63x | 21.40x |
| update | **1.00x** | 56.03x | 1.57x | 1.72x | n/a |
| delete | 1.00x | 0.35x | 1.11x | **0.16x** | n/a |
| rollback | 1.00x | 2.00x | 0.93x | **0.73x** | n/a |
| open | 1.00x | 1.29x | 1.30x | **0.74x** | n/a |

## Absolute round timings (median / p95 ms)

| Workload | node:sqlite median / p95 (ms) | @yydb/sqlite median / p95 (ms) | better-sqlite3 median / p95 (ms) | sql.js median / p95 (ms) | @yydb/sqlite-unknown-wasm32 median / p95 (ms) |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | 5.05 / 5.39 | 17.64 / 24.07 | 5.62 / 6.28 | 19.17 / 32.50 | 34.03 / 55.06 |
| scan | 2.18 / 3.47 | 5.96 / 7.54 | 2.56 / 3.25 | 4.40 / 5.64 | 5.48 / 12.52 |
| point | 24.42 / 24.84 | 7.01 / 7.13 | 21.55 / 25.20 | 14.74 / 17.16 | n/a |
| point_sql | 24.42 / 24.84 | 16.57 / 18.69 | 21.55 / 25.20 | 14.74 / 17.16 | 15.91 / 33.81 |
| point_uk | 21.41 / 22.26 | 32.02 / 37.45 | 22.82 / 22.83 | 11.06 / 11.11 | n/a |
| range | 10.21 / 13.42 | 21.85 / 22.41 | 9.60 / 11.34 | 22.86 / 23.54 | 377.88 / 387.48 |
| indexed | 22.65 / 22.89 | 16.70 / 18.89 | 20.73 / 23.58 | 13.15 / 14.49 | n/a |
| order_limit | 7.76 / 7.99 | 19.10 / 21.54 | 8.27 / 8.91 | 15.78 / 16.18 | 10.52 / 10.61 |
| group_by | 21.38 / 22.80 | 136.78 / 136.94 | 21.53 / 21.76 | 46.73 / 55.93 | 67.42 / 73.32 |
| join | 2.33 / 2.78 | 103.87 / 120.09 | 2.32 / 2.92 | 3.80 / 3.86 | 49.87 / 49.99 |
| update | 0.73 / 8.10 | 41.08 / 620.97 | 1.15 / 106.78 | 1.26 / 1.86 | n/a |
| delete | 7.03 / 7.72 | 2.48 / 2.62 | 7.81 / 7.99 | 1.15 / 1.81 | n/a |
| rollback | 3.12 / 3.85 | 6.25 / 6.32 | 2.92 / 2.93 | 2.28 / 2.89 | n/a |
| open | 0.07 / 0.15 | 0.10 / 0.17 | 0.10 / 0.23 | 0.05 / 0.14 | n/a |

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
- `update` / `delete`: 1000 mutations in one transaction + save (our writer) vs peers' prepared mutation in a transaction.
- `rollback`: begin + 1000 inserts + rollback (nothing persisted).
- `open`: open + close of the main file, no reads.
- `@yydb/sqlite-unknown-wasm32` is the in-memory SQL binding: it runs `batch` (inserts + snapshot export + file write), `scan`, `point_sql`, `range`, `order_limit`, `group_by` and `join` through `exec`; it has no reader point API, no UPDATE/DELETE/indexes and no file open, so the remaining cells are `n/a`.

## Intentional deltas

- Our writer is snapshot-based: `update`/`delete` include the full-image `save()`; peers write in place through their pager.
- sql.js peer scan rebuilds the WASM DB from the serialized image each round; peer batch/update/delete timings include `export()`.
- `point_sql` has no separate peer path — peers' prepared `get` is the reference.
- The wasm column reads the same in-memory image every round (`SELECT` re-scans the image; the binding has no seek), and its `batch` includes `snapshot()` + the file write.
- The four SQL-engine workloads (`point_uk`, `order_limit`, `group_by`, `join`) run one untimed warmup round before `BENCH_ROUNDS` timed rounds; median/p95 come from the harness `benchSummary`, not local stats.

Regenerate: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
