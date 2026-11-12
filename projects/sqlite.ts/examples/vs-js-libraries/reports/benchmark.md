# Benchmark report

Command: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
Defaults: `BENCH_ROWS=5000`, `BENCH_TXN=1000`, `BENCH_PAGE=4096`, `BENCH_ROUNDS=3`, `BENCH_POINT=1000`, `BENCH_RANGE=200`, `BENCH_MUTATE=1000`, `BENCH_LIMIT=200`, `BENCH_AGG=20`, `BENCH_JOIN=10`, `BENCH_DISTINCT=5`, `BENCH_SUBQUERY=20`, `BENCH_MULTI=10`, `BENCH_UPSERT=500`, `BENCH_SYNCHRONOUS=off`
Baseline: `node:sqlite` (`DatabaseSync`) = `1.00x`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.

## Provenance

- node: `v24.18.0`
- rustc: `rustc 1.101.0-nightly (1c3a65069 2026-11-02)`
- repo rev: `1d69962`
- binding rev (`database.rs` pin in `projects/sqlite.rs/Cargo.toml`): `7ab466d`
- data: `5000` rows (page `4096`), `BENCH_ROUNDS=3`, point/indexed `1000`, range `200`, order_limit `200`, group_by `20`, join `10`, distinct `5`, subquery `20`, multi `10x100`, upsert `500`, mutate `1000`

## Relative to `node:sqlite`

| Workload | node:sqlite | @yydb/sqlite | better-sqlite3 | sql.js | @yydb/sqlite-unknown-wasm32 |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | **1.00x** | 3.65x | 1.57x | 7.02x | 11.17x |
| scan | **1.00x** | 2.96x | 1.00x | 2.62x | 3.08x |
| point | 1.00x | **0.36x** | 1.16x | 0.71x | n/a |
| point_sql | 1.00x | 1.54x | 1.16x | **0.71x** | 1.15x |
| point_uk | 1.00x | 1.82x | 1.18x | **0.72x** | n/a |
| range | **1.00x** | 2.16x | 1.11x | 3.81x | 42.36x |
| indexed | 1.00x | 1.62x | 1.10x | **0.59x** | n/a |
| order_limit | **1.00x** | 2.63x | 1.03x | 2.41x | 1.71x |
| group_by | **1.00x** | 4.74x | 1.07x | 3.09x | 3.04x |
| join | **1.00x** | 7.45x | 1.40x | 1.99x | 7.07x |
| distinct | **1.00x** | 6.43x | 1.12x | n/a | n/a |
| aggregate | **1.00x** | 4.72x | 1.27x | n/a | n/a |
| subquery | **1.00x** | 12.44x | 1.43x | n/a | n/a |
| index_range | 1.00x | 7.33x | **1.00x** | n/a | n/a |
| insert_multi | 1.00x | 5.29x | **0.91x** | n/a | n/a |
| upsert | **1.00x** | 27.99x | 1.65x | n/a | n/a |
| update | **1.00x** | 13.90x | 1.35x | 1.19x | n/a |
| delete | 1.00x | 0.53x | 1.01x | **0.22x** | n/a |
| rollback | 1.00x | 2.26x | **1.00x** | 1.24x | n/a |
| open | **1.00x** | 2.88x | 3.07x | 1.11x | n/a |

## Absolute round timings (median / p95 ms)

| Workload | node:sqlite median / p95 (ms) | @yydb/sqlite median / p95 (ms) | better-sqlite3 median / p95 (ms) | sql.js median / p95 (ms) | @yydb/sqlite-unknown-wasm32 median / p95 (ms) |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | 4.12 / 4.19 | 15.03 / 15.60 | 6.47 / 6.49 | 28.91 / 45.42 | 45.98 / 76.31 |
| scan | 1.87 / 3.47 | 5.55 / 5.60 | 1.88 / 3.22 | 4.91 / 5.91 | 5.76 / 14.96 |
| point | 18.45 / 19.50 | 6.55 / 6.62 | 21.34 / 24.94 | 13.15 / 16.04 | n/a |
| point_sql | 18.45 / 19.50 | 28.49 / 31.20 | 21.34 / 24.94 | 13.15 / 16.04 | 21.27 / 25.11 |
| point_uk | 20.35 / 20.46 | 37.08 / 43.95 | 23.99 / 24.73 | 14.55 / 14.76 | n/a |
| range | 7.91 / 9.20 | 17.09 / 18.46 | 8.78 / 10.26 | 30.13 / 31.13 | 334.84 / 337.30 |
| indexed | 19.70 / 21.52 | 31.97 / 33.31 | 21.64 / 24.34 | 11.70 / 11.76 | n/a |
| order_limit | 7.39 / 7.41 | 19.45 / 19.95 | 7.58 / 7.82 | 17.83 / 17.97 | 12.66 / 13.09 |
| group_by | 20.23 / 20.23 | 95.78 / 97.95 | 21.70 / 23.81 | 62.45 / 68.07 | 61.40 / 66.20 |
| join | 2.15 / 2.20 | 16.04 / 20.27 | 3.01 / 3.93 | 4.29 / 5.64 | 15.23 / 17.74 |
| distinct | 6.36 / 7.30 | 40.92 / 43.99 | 7.15 / 7.42 | n/a | n/a |
| aggregate | 6.55 / 6.86 | 30.89 / 33.30 | 8.35 / 8.50 | n/a | n/a |
| subquery | 4.39 / 4.99 | 54.56 / 56.72 | 6.29 / 8.05 | n/a | n/a |
| index_range | 28.14 / 29.26 | 206.31 / 212.66 | 28.01 / 37.54 | n/a | n/a |
| insert_multi | 0.77 / 0.87 | 4.08 / 4.10 | 0.70 / 0.72 | n/a | n/a |
| upsert | 0.57 / 7.30 | 16.02 / 17.85 | 0.94 / 19.24 | n/a | n/a |
| update | 1.00 / 7.63 | 13.90 / 14.36 | 1.36 / 7.87 | 1.19 / 2.40 | n/a |
| delete | 7.68 / 7.71 | 4.09 / 4.12 | 7.73 / 8.39 | 1.66 / 1.97 | n/a |
| rollback | 2.37 / 2.71 | 5.34 / 5.71 | 2.37 / 3.31 | 2.95 / 3.13 | n/a |
| open | 0.05 / 0.10 | 0.14 / 0.15 | 0.15 / 0.31 | 0.05 / 0.12 | n/a |

## Workloads

- `batch`: create table, 5000 rows in transactions of 1000, save file. `BENCH_SYNCHRONOUS=on` moves every library to `synchronous=FULL`.
- `scan`: open + full table scan per round.
- `point`: reader `rowByRowid` vs each peer's prepared `get`.
- `point_sql`: our public `new SQLite()` `select ... where id = N` vs the same peer prepared `get` (peer cells reuse `point`).
- `point_uk`: point lookup through a **unique** index on `label`; our side runs `select ... where label = '...'` on `new SQLite()` carrying `create unique index`, peers through their unique index (one untimed warmup round first).
- `range`: 50-row `between` windows, reader `range` vs peers' prepared range.
- `indexed`: equality on an indexed `label` column; our side runs through `new SQLite()`, peers through their index.
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
- `insert_multi` and `upsert` on our side run on an in-memory `new SQLite()`, while the two peer columns write through their file pager; the row set is validated on both sides.
- The ten SQL-engine workloads (`point_uk`, `order_limit`, `group_by`, `join`, `distinct`, `aggregate`, `subquery`, `index_range`, `insert_multi`, `upsert`) run one untimed warmup round before `BENCH_ROUNDS` timed rounds; median/p95 come from the harness `benchSummary`, not local stats.
- `batch`, `scan`, `point`, `range`, `update`, `delete`, `rollback` and `open` still use the format-3 writer/reader primitives. The public `SQLite` entry does not expose raw record decoding, `rowByRowid`/`range` rowid windows, or the full-image `save()` that these timings are defined on.

## Capabilities still missing from the public API

- Direct rowid point read (`rowByRowid`) and inclusive rowid range read (`range`) without SQL parsing.
- Raw record decoding via a table cursor (`openDatabase(...).table(...)`) for `scan`.
- Writer-side `update`/`delete` slots and the explicit full-image `save()` that `update`/`delete`/`batch` include in their timings.
- Writer `begin`/`rollback` without SQL transaction control, used by `rollback`.
- A pure open/close handle over the main file with no statement preparation, used by `open`.

Regenerate: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
