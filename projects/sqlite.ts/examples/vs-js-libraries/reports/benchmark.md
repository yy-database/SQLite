# Benchmark report

Command: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
Defaults: `BENCH_ROWS=5000`, `BENCH_TXN=1000`, `BENCH_PAGE=4096`, `BENCH_ROUNDS=3`, `BENCH_POINT=1000`, `BENCH_RANGE=200`, `BENCH_MUTATE=1000`, `BENCH_LIMIT=200`, `BENCH_AGG=20`, `BENCH_JOIN=10`, `BENCH_DISTINCT=5`, `BENCH_SUBQUERY=20`, `BENCH_MULTI=10`, `BENCH_UPSERT=500`, `BENCH_SYNCHRONOUS=off`
Baseline: `node:sqlite` (`DatabaseSync`) = `1.00x`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.

## Provenance

- node: `v24.18.0`
- rustc: `rustc 1.101.0-nightly (1c3a65069 2026-11-02)`
- repo rev: `4eb98fd`
- binding rev (`database.rs` pin in `projects/sqlite.rs/Cargo.toml`): `68e9468`
- data: `5000` rows (page `4096`), `BENCH_ROUNDS=3`, point/indexed `1000`, range `200`, order_limit `200`, group_by `20`, join `10`, distinct `5`, subquery `20`, multi `10x100`, upsert `500`, mutate `1000`

## Relative to `node:sqlite`

| Workload | node:sqlite | @yydb/sqlite | better-sqlite3 | sql.js | @yydb/sqlite-unknown-wasm32 |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | **1.00x** | 3.34x | 1.04x | 4.27x | 7.58x |
| scan | 1.00x | 2.66x | **0.78x** | 2.63x | 2.80x |
| point | 1.00x | **0.22x** | 0.99x | 0.43x | n/a |
| point_sql | 1.00x | 0.85x | 0.99x | **0.43x** | 0.60x |
| point_param | 1.00x | 0.44x | 0.99x | **0.43x** | n/a |
| point_uk | 1.00x | 0.87x | 1.02x | **0.41x** | n/a |
| range | 1.00x | 1.07x | **0.88x** | 2.59x | 28.96x |
| indexed | 1.00x | 0.88x | 1.01x | **0.43x** | n/a |
| order_limit | 1.00x | 1.39x | **0.94x** | 1.94x | 1.07x |
| group_by | 1.00x | 2.57x | **0.89x** | 2.35x | 1.88x |
| join | **1.00x** | 5.31x | 1.07x | 1.74x | 6.12x |
| distinct | 1.00x | 3.38x | **0.80x** | n/a | n/a |
| aggregate | **1.00x** | 4.36x | 1.18x | n/a | n/a |
| subquery | **1.00x** | 7.90x | 1.11x | n/a | n/a |
| index_range | 1.00x | 4.95x | **0.86x** | n/a | n/a |
| insert_multi | **1.00x** | 4.95x | 1.03x | n/a | n/a |
| upsert | **1.00x** | 17.22x | 1.45x | n/a | n/a |
| upsert_param | **1.00x** | 10.12x | 1.45x | n/a | n/a |
| update | **1.00x** | 7.75x | 2.03x | 3.30x | n/a |
| update_sql | **1.00x** | 29.77x | 2.03x | 3.30x | n/a |
| delete | 1.00x | 0.40x | 1.06x | **0.19x** | n/a |
| delete_sql | 1.00x | 1.83x | 1.06x | **0.19x** | n/a |
| rollback | **1.00x** | 1.44x | 1.14x | 1.02x | n/a |
| open | 1.00x | 0.51x | 0.53x | **0.26x** | n/a |

## Absolute round timings (median / p95 ms)

| Workload | node:sqlite median / p95 (ms) | @yydb/sqlite median / p95 (ms) | better-sqlite3 median / p95 (ms) | sql.js median / p95 (ms) | @yydb/sqlite-unknown-wasm32 median / p95 (ms) |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | 4.50 / 5.50 | 15.05 / 15.90 | 4.70 / 5.67 | 19.23 / 33.54 | 34.11 / 55.45 |
| scan | 1.67 / 2.57 | 4.43 / 4.94 | 1.29 / 1.44 | 4.39 / 4.80 | 4.67 / 10.17 |
| point | 27.32 / 28.87 | 6.04 / 6.66 | 26.97 / 27.16 | 11.76 / 12.11 | n/a |
| point_sql | 27.32 / 28.87 | 23.18 / 23.60 | 26.97 / 27.16 | 11.76 / 12.11 | 16.50 / 18.45 |
| point_param | 27.32 / 28.87 | 11.99 / 12.64 | 26.97 / 27.16 | 11.76 / 12.11 | n/a |
| point_uk | 26.16 / 26.77 | 22.64 / 23.63 | 26.67 / 27.34 | 10.65 / 11.42 | n/a |
| range | 9.12 / 10.67 | 9.72 / 10.98 | 8.04 / 10.07 | 23.62 / 25.79 | 263.98 / 264.39 |
| indexed | 26.41 / 27.25 | 23.14 / 25.44 | 26.76 / 26.81 | 11.46 / 12.49 | n/a |
| order_limit | 8.67 / 11.48 | 12.06 / 13.44 | 8.19 / 10.09 | 16.85 / 19.25 | 9.25 / 9.31 |
| group_by | 20.01 / 20.28 | 51.43 / 53.17 | 17.82 / 18.62 | 47.03 / 49.29 | 37.65 / 37.73 |
| join | 2.15 / 2.21 | 11.43 / 11.76 | 2.29 / 2.50 | 3.75 / 3.90 | 13.18 / 13.27 |
| distinct | 7.05 / 7.42 | 23.81 / 24.79 | 5.65 / 6.03 | n/a | n/a |
| aggregate | 6.13 / 6.52 | 26.72 / 27.17 | 7.25 / 7.39 | n/a | n/a |
| subquery | 4.55 / 4.81 | 35.91 / 36.98 | 5.06 / 5.10 | n/a | n/a |
| index_range | 30.21 / 30.60 | 149.46 / 153.09 | 26.09 / 26.45 | n/a | n/a |
| insert_multi | 0.71 / 0.73 | 3.52 / 3.84 | 0.73 / 0.76 | n/a | n/a |
| upsert | 0.58 / 8.00 | 9.96 / 10.53 | 0.84 / 8.45 | n/a | n/a |
| upsert_param | 0.58 / 8.00 | 5.85 / 6.25 | 0.84 / 8.45 | n/a | n/a |
| update | 0.50 / 7.40 | 3.91 / 4.22 | 1.02 / 7.58 | 1.66 / 3.49 | n/a |
| update_sql | 0.50 / 7.40 | 15.02 / 15.06 | 1.02 / 7.58 | 1.66 / 3.49 | n/a |
| delete | 6.41 / 7.73 | 2.59 / 2.77 | 6.81 / 8.48 | 1.20 / 1.47 | n/a |
| delete_sql | 6.41 / 7.73 | 11.72 / 12.23 | 6.81 / 8.48 | 1.20 / 1.47 | n/a |
| rollback | 2.05 / 2.21 | 2.95 / 3.11 | 2.33 / 2.44 | 2.08 / 2.69 | n/a |
| open | 0.22 / 0.49 | 0.12 / 0.16 | 0.12 / 0.20 | 0.06 / 0.11 | n/a |

## Workloads

- `batch`: create table, 5000 rows in transactions of 1000, save file. `BENCH_SYNCHRONOUS=on` moves every library to `synchronous=FULL`.
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
- `index_range`: `select id from items where label between 'row-1000' and 'row-1499' order by label` (200 queries per round, 553 rows) — range predicate on an indexed column.
- `insert_multi`: 10 statements of 100 literal rows in one transaction (1000 rows total).
- `upsert`: 500 `insert ... on conflict(id) do update` statements in one transaction.
- `upsert_param`: the same upsert through a prepared statement with bound values; peer cells reuse `upsert`. `upsert` re-parses interpolated SQL text, so the pair shows the parse cost separately from execution.
- `update` / `delete`: 1000 mutations in one transaction + save (our writer) vs peers' prepared mutation in a transaction.
- `update_sql` / `delete_sql`: 1000 prepared SQL mutations by bound rowid in one transaction on `new SQLite()`; peer cells reuse `update` / `delete`. These exercise the SQL write path (rowid narrowing) rather than the writer primitives.
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
- The SQL-engine workloads (`point_param`, `point_uk`, `order_limit`, `group_by`, `join`, `distinct`, `aggregate`, `subquery`, `index_range`, `insert_multi`, `upsert`, `upsert_param`, `update_sql`, `delete_sql`) run one untimed warmup round before `BENCH_ROUNDS` timed rounds; median/p95 come from the harness `benchSummary`, not local stats.
- `batch`, `scan`, `point`, `range`, `update`, `delete`, `rollback` and `open` still use the format-3 writer/reader primitives. The public `SQLite` entry does not expose raw record decoding, `rowByRowid`/`range` rowid windows, or the full-image `save()` that these timings are defined on.

## Capabilities still missing from the public API

- Direct rowid point read (`rowByRowid`) and inclusive rowid range read (`range`) without SQL parsing.
- Raw record decoding via a table cursor (`openDatabase(...).table(...)`) for `scan`.
- Writer-side `update`/`delete` slots and the explicit full-image `save()` that `update`/`delete`/`batch` include in their timings.
- Writer `begin`/`rollback` without SQL transaction control, used by `rollback`.
- A pure open/close handle over the main file with no statement preparation, used by `open`.

Regenerate: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
