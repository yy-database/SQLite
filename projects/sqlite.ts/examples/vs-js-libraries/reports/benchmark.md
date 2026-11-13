# Benchmark report

Command: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
Defaults: `BENCH_ROWS=5000`, `BENCH_TXN=1000`, `BENCH_PAGE=4096`, `BENCH_ROUNDS=3`, `BENCH_POINT=1000`, `BENCH_RANGE=200`, `BENCH_MUTATE=1000`, `BENCH_LIMIT=200`, `BENCH_AGG=20`, `BENCH_JOIN=10`, `BENCH_DISTINCT=5`, `BENCH_SUBQUERY=20`, `BENCH_MULTI=10`, `BENCH_UPSERT=500`, `BENCH_SYNCHRONOUS=off`
Baseline: `node:sqlite` (`DatabaseSync`) = `1.00x`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.

## Provenance

- node: `v24.18.0`
- rustc: `rustc 1.101.0-nightly (1c3a65069 2026-11-02)`
- repo rev: `fe60c7f`
- binding rev (`database.rs` pin in `projects/sqlite.rs/Cargo.toml`): `68e9468`
- data: `5000` rows (page `4096`), `BENCH_ROUNDS=3`, point/indexed `1000`, range `200`, order_limit `200`, group_by `20`, join `10`, distinct `5`, subquery `20`, multi `10x100`, upsert `500`, mutate `1000`

## Relative to `node:sqlite`

| Workload | node:sqlite | @yydb/sqlite | better-sqlite3 | sql.js | @yydb/sqlite-unknown-wasm32 |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | **1.00x** | 4.01x | 1.22x | 7.33x | 9.44x |
| scan | 1.00x | 2.58x | **0.82x** | 2.12x | 2.55x |
| point | 1.00x | **0.22x** | 1.00x | 0.46x | n/a |
| point_sql | 1.00x | 0.89x | 1.00x | **0.46x** | 0.52x |
| point_param | 1.00x | **0.44x** | 1.00x | 0.46x | n/a |
| point_uk | 1.00x | 0.73x | 0.94x | **0.46x** | n/a |
| range | **1.00x** | 1.17x | 1.37x | 2.22x | 29.38x |
| indexed | 1.00x | 0.93x | 1.09x | **0.39x** | n/a |
| order_limit | **1.00x** | 1.55x | 1.07x | 1.69x | 1.07x |
| group_by | 1.00x | 2.25x | **0.94x** | 2.33x | 1.73x |
| join | **1.00x** | 5.94x | 1.15x | 1.90x | 6.88x |
| distinct | **1.00x** | 3.17x | 1.00x | n/a | n/a |
| aggregate | **1.00x** | 3.30x | 1.21x | n/a | n/a |
| subquery | **1.00x** | 8.96x | 1.22x | n/a | n/a |
| index_range | 1.00x | 4.95x | **0.89x** | n/a | n/a |
| insert_multi | **1.00x** | 5.13x | 1.21x | n/a | n/a |
| upsert | 1.00x | 12.79x | **0.98x** | n/a | n/a |
| upsert_param | 1.00x | 7.47x | **0.98x** | n/a | n/a |
| update | **1.00x** | 5.99x | 1.53x | 1.58x | n/a |
| update_sql | **1.00x** | 19.79x | 1.53x | 1.58x | n/a |
| delete | 1.00x | 0.32x | 1.00x | **0.18x** | n/a |
| delete_sql | 1.00x | 1.34x | 1.00x | **0.18x** | n/a |
| rollback | 1.00x | 1.30x | 1.38x | **0.89x** | n/a |
| open | 1.00x | 1.06x | 1.05x | **0.38x** | n/a |

## Absolute round timings (median / p95 ms)

| Workload | node:sqlite median / p95 (ms) | @yydb/sqlite median / p95 (ms) | better-sqlite3 median / p95 (ms) | sql.js median / p95 (ms) | @yydb/sqlite-unknown-wasm32 median / p95 (ms) |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | 3.59 / 4.57 | 14.41 / 15.95 | 4.40 / 5.66 | 26.35 / 31.38 | 33.92 / 51.55 |
| scan | 1.73 / 3.52 | 4.47 / 5.69 | 1.43 / 2.24 | 3.68 / 3.98 | 4.42 / 8.77 |
| point | 27.07 / 28.38 | 5.86 / 5.95 | 27.15 / 27.79 | 12.56 / 14.84 | n/a |
| point_sql | 27.07 / 28.38 | 23.96 / 27.45 | 27.15 / 27.79 | 12.56 / 14.84 | 14.16 / 18.96 |
| point_param | 27.07 / 28.38 | 11.81 / 12.37 | 27.15 / 27.79 | 12.56 / 14.84 | n/a |
| point_uk | 30.65 / 31.73 | 22.52 / 22.81 | 28.88 / 30.39 | 14.10 / 16.24 | n/a |
| range | 8.70 / 9.02 | 10.20 / 10.96 | 11.91 / 12.64 | 19.32 / 19.81 | 255.64 / 257.96 |
| indexed | 26.75 / 29.78 | 24.83 / 26.30 | 29.12 / 30.02 | 10.46 / 10.72 | n/a |
| order_limit | 8.58 / 9.91 | 13.28 / 13.98 | 9.14 / 13.30 | 14.52 / 14.97 | 9.16 / 9.26 |
| group_by | 18.89 / 20.78 | 42.44 / 42.98 | 17.68 / 18.30 | 44.08 / 47.74 | 32.76 / 34.62 |
| join | 1.94 / 1.96 | 11.51 / 12.31 | 2.22 / 2.24 | 3.68 / 3.73 | 13.32 / 14.59 |
| distinct | 6.22 / 6.60 | 19.73 / 23.09 | 6.23 / 6.71 | n/a | n/a |
| aggregate | 6.08 / 6.24 | 20.10 / 20.44 | 7.37 / 7.98 | n/a | n/a |
| subquery | 4.23 / 4.64 | 37.91 / 37.96 | 5.16 / 5.20 | n/a | n/a |
| index_range | 28.65 / 30.90 | 141.66 / 152.28 | 25.64 / 26.17 | n/a | n/a |
| insert_multi | 0.67 / 0.73 | 3.42 / 3.61 | 0.81 / 0.81 | n/a | n/a |
| upsert | 0.79 / 17.36 | 10.07 / 10.45 | 0.77 / 8.62 | n/a | n/a |
| upsert_param | 0.79 / 17.36 | 5.88 / 6.27 | 0.77 / 8.62 | n/a | n/a |
| update | 0.71 / 7.01 | 4.25 / 4.86 | 1.09 / 7.02 | 1.12 / 1.66 | n/a |
| update_sql | 0.71 / 7.01 | 14.05 / 14.77 | 1.09 / 7.02 | 1.12 / 1.66 | n/a |
| delete | 7.58 / 8.00 | 2.40 / 2.50 | 7.59 / 8.38 | 1.39 / 1.42 | n/a |
| delete_sql | 7.58 / 8.00 | 10.14 / 11.33 | 7.59 / 8.38 | 1.39 / 1.42 | n/a |
| rollback | 2.39 / 2.67 | 3.11 / 3.29 | 3.30 / 3.33 | 2.12 / 2.80 | n/a |
| open | 0.13 / 0.17 | 0.14 / 0.27 | 0.14 / 0.31 | 0.05 / 0.13 | n/a |

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
