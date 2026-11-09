# Benchmark report

Command: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
Defaults: `BENCH_ROWS=5000`, `BENCH_TXN=1000`, `BENCH_PAGE=4096`, `BENCH_ROUNDS=3`, `BENCH_POINT=1000`, `BENCH_RANGE=200`, `BENCH_MUTATE=1000`, `BENCH_SYNCHRONOUS=off`
Baseline: `node:sqlite` (`DatabaseSync`) = `1.00x`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.

## Relative to `node:sqlite`

| Workload | node:sqlite | @yydb/sqlite | better-sqlite3 | sql.js | @yydb/sqlite-unknown-wasm32 |
|---------:|-------:|-------:|-------:|-------:|-------:|
| batch | **1.00x** | 4.41x | 2.16x | 7.09x | 12.05x |
| scan | 1.00x | 1.46x | **0.87x** | 1.42x | 1.87x |
| point | 1.00x | **0.32x** | 1.42x | 1.00x | n/a |
| point_sql | 1.00x | 119.38x | 1.42x | **1.00x** | 103.49x |
| range | 1.00x | 1.00x | **0.90x** | 3.14x | 42.66x |
| indexed | 1.00x | 157.80x | 1.30x | **0.79x** | n/a |
| update | **1.00x** | 33.25x | 1.40x | 2.51x | n/a |
| delete | 1.00x | 0.41x | 1.01x | **0.16x** | n/a |
| rollback | **1.00x** | 1.94x | 1.10x | 1.14x | n/a |
| open | **1.00x** | 1.40x | 1.77x | 1.11x | n/a |

## Workloads

- `batch`: create table, 5000 rows in transactions of 1000, save file. `BENCH_SYNCHRONOUS=on` moves every library to `synchronous=FULL`.
- `scan`: open + full table scan per round.
- `point`: reader `rowByRowid` vs each peer's prepared `get`.
- `point_sql`: our SQL engine `select ... where id = N` vs the same peer prepared `get` (peer cells reuse `point`).
- `range`: 50-row `between` windows, reader `range` vs peers' prepared range.
- `indexed`: equality on an indexed `label` column; our side runs through the SQL engine, peers through their index.
- `update` / `delete`: 1000 mutations in one transaction + save (our writer) vs peers' prepared mutation in a transaction.
- `rollback`: begin + 1000 inserts + rollback (nothing persisted).
- `open`: open + close of the main file, no reads.
- `@yydb/sqlite-unknown-wasm32` is the in-memory SQL binding: it runs `batch` (inserts + snapshot export + file write), `scan`, `point_sql` and `range` through `exec`; it has no reader point API, no UPDATE/DELETE/indexes and no file open, so the remaining cells are `n/a`.

## Intentional deltas

- Our writer is snapshot-based: `update`/`delete` include the full-image `save()`; peers write in place through their pager.
- sql.js peer scan rebuilds the WASM DB from the serialized image each round; peer batch/update/delete timings include `export()`.
- `point_sql` has no separate peer path — peers' prepared `get` is the reference.
- The wasm column reads the same in-memory image every round (`SELECT` re-scans the image; the binding has no seek), and its `batch` includes `snapshot()` + the file write.

Regenerate: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
