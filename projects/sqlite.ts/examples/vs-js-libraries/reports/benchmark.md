# Benchmark report

Command: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
Defaults: `BENCH_ROWS=5000`, `BENCH_TXN=1000`, `BENCH_PAGE=4096`, `BENCH_ROUNDS=3`, `BENCH_POINT=1000`, `BENCH_RANGE=200`, `BENCH_MUTATE=1000`, `BENCH_LIMIT=200`, `BENCH_AGG=20`, `BENCH_JOIN=10`, `BENCH_DISTINCT=5`, `BENCH_SUBQUERY=20`, `BENCH_MULTI=10`, `BENCH_UPSERT=500`, `BENCH_SYNCHRONOUS=off`
Baseline: `node:sqlite` (`DatabaseSync`) = `1.00x`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.

## Provenance

- node: `v24.18.0`
- rustc: `rustc 1.101.0-nightly (1c3a65069 2026-11-02)`
- repo rev: `e3dda38`
- binding rev (`database.rs` pin in `projects/sqlite.rs/Cargo.toml`): `2417849`
- data: `5000` rows (page `4096`), `BENCH_ROUNDS=3`, point/indexed `1000`, range `200`, order_limit `200`, group_by `20`, join `10`, distinct `5`, subquery `20`, multi `10x100`, upsert `500`, mutate `1000`

## Relative to `node:sqlite`

| Workload | node:sqlite | @yydb/sqlite | better-sqlite3 | sql.js | @yydb/sqlite-unknown-wasm32 |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | **1.00x** | 3.37x | 1.32x | 5.30x | 11.18x |
| scan | 1.00x | 2.63x | **0.88x** | 1.85x | 3.19x |
| point | 1.00x | **0.22x** | 1.21x | 0.55x | n/a |
| point_sql | 1.00x | 0.98x | 1.21x | **0.55x** | 0.79x |
| point_param | 1.00x | **0.45x** | 1.21x | 0.55x | n/a |
| point_uk | 1.00x | 0.91x | 1.30x | **0.57x** | n/a |
| range | 1.00x | **0.99x** | 1.06x | 3.10x | 29.56x |
| indexed | 1.00x | 1.12x | 1.11x | **0.46x** | n/a |
| order_limit | **1.00x** | 1.33x | 1.13x | 2.97x | 1.05x |
| group_by | 1.00x | 4.83x | **0.95x** | 2.90x | 2.39x |
| join | 1.00x | 5.76x | **0.87x** | 1.67x | 5.97x |
| distinct | 1.00x | 5.57x | **0.82x** | n/a | n/a |
| aggregate | **1.00x** | 6.29x | 1.41x | n/a | n/a |
| subquery | **1.00x** | 10.76x | 1.01x | n/a | n/a |
| index_range | 1.00x | 6.22x | **0.96x** | n/a | n/a |
| insert_multi | **1.00x** | 5.34x | 1.11x | n/a | n/a |
| upsert | **1.00x** | 26.92x | 1.23x | n/a | n/a |
| upsert_param | **1.00x** | 12.85x | 1.23x | n/a | n/a |
| update | **1.00x** | 5.87x | 1.38x | 3.17x | n/a |
| update_sql | **1.00x** | 23.80x | 1.38x | 3.17x | n/a |
| delete | 1.00x | 0.58x | 1.02x | **0.41x** | n/a |
| delete_sql | 1.00x | 2.84x | 1.02x | **0.41x** | n/a |
| rollback | **1.00x** | 1.57x | 1.13x | 1.50x | n/a |
| open | 1.00x | 0.93x | 1.56x | **0.55x** | n/a |

## Absolute round timings (median / p95 ms)

| Workload | node:sqlite median / p95 (ms) | @yydb/sqlite median / p95 (ms) | better-sqlite3 median / p95 (ms) | sql.js median / p95 (ms) | @yydb/sqlite-unknown-wasm32 median / p95 (ms) |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | 7.24 / 7.90 | 24.37 / 26.48 | 9.55 / 10.80 | 38.34 / 77.24 | 80.95 / 120.89 |
| scan | 3.34 / 7.64 | 8.78 / 10.19 | 2.95 / 4.29 | 6.18 / 8.62 | 10.65 / 19.32 |
| point | 44.30 / 45.24 | 9.76 / 10.01 | 53.76 / 56.10 | 24.55 / 30.50 | n/a |
| point_sql | 44.30 / 45.24 | 43.53 / 44.13 | 53.76 / 56.10 | 24.55 / 30.50 | 34.84 / 44.11 |
| point_param | 44.30 / 45.24 | 19.85 / 21.49 | 53.76 / 56.10 | 24.55 / 30.50 | n/a |
| point_uk | 43.99 / 51.23 | 40.00 / 40.01 | 57.09 / 57.73 | 24.99 / 26.12 | n/a |
| range | 17.79 / 22.41 | 17.63 / 20.65 | 18.92 / 20.65 | 55.15 / 58.61 | 525.65 / 557.25 |
| indexed | 48.94 / 56.99 | 54.72 / 58.82 | 54.21 / 56.26 | 22.44 / 23.91 | n/a |
| order_limit | 17.41 / 17.53 | 23.13 / 24.20 | 19.65 / 20.28 | 51.77 / 54.07 | 18.24 / 18.30 |
| group_by | 37.25 / 38.60 | 180.00 / 184.99 | 35.53 / 36.70 | 108.12 / 112.02 | 88.91 / 88.95 |
| join | 4.21 / 4.21 | 24.22 / 26.13 | 3.67 / 4.67 | 7.04 / 7.58 | 25.11 / 25.26 |
| distinct | 14.19 / 20.42 | 79.08 / 80.95 | 11.61 / 13.76 | n/a | n/a |
| aggregate | 10.19 / 12.93 | 64.13 / 73.53 | 14.37 / 14.47 | n/a | n/a |
| subquery | 8.02 / 9.31 | 86.31 / 92.51 | 8.11 / 10.37 | n/a | n/a |
| index_range | 53.92 / 59.46 | 335.46 / 353.20 | 51.80 / 59.24 | n/a | n/a |
| insert_multi | 1.18 / 1.24 | 6.33 / 8.62 | 1.32 / 1.86 | n/a | n/a |
| upsert | 0.82 / 8.32 | 22.11 / 22.75 | 1.01 / 18.09 | n/a | n/a |
| upsert_param | 0.82 / 8.32 | 10.56 / 11.12 | 1.01 / 18.09 | n/a | n/a |
| update | 1.16 / 8.07 | 6.83 / 7.91 | 1.61 / 10.44 | 3.69 / 4.10 | n/a |
| update_sql | 1.16 / 8.07 | 27.72 / 29.57 | 1.61 / 10.44 | 3.69 / 4.10 | n/a |
| delete | 7.83 / 8.23 | 4.53 / 5.28 | 7.96 / 9.14 | 3.24 / 3.56 | n/a |
| delete_sql | 7.83 / 8.23 | 22.22 / 24.55 | 7.96 / 9.14 | 3.24 / 3.56 | n/a |
| rollback | 3.85 / 3.86 | 6.05 / 7.10 | 4.34 / 4.63 | 5.76 / 6.83 | n/a |
| open | 0.21 / 0.24 | 0.20 / 0.36 | 0.33 / 0.48 | 0.12 / 0.41 | n/a |

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
