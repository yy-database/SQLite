# vs-js-libraries

Cross-library **on-disk** write/read and a side-by-side benchmark of `@yydb/sqlite`
against four JavaScript SQLite peers, with Node's built-in
[`node:sqlite`](https://nodejs.org/api/sqlite.html) (`DatabaseSync`, Node ≥ 22.5)
as the **throughput baseline**:

- [`node:sqlite`](https://nodejs.org/api/sqlite.html) — baseline (`1.00x`)
- [`@yydb/sqlite`](../../packages/sqlite) — uplift/gap vs baseline
- [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3)
- [`sql.js`](https://sql.js.org/) (SQLite compiled to WASM; shared store is a serialized main-file image)
- [`@yydb/sqlite-unknown-wasm32`](../../platforms/sqlite-unknown-wasm32) — our in-memory WASM binding
  (`batch`/`scan`/`point_sql`/`range`/`order_limit`/`group_by`/`join` only; the rest is `n/a`)

## Layout

- `src/` — shared helpers, timing utilities, and `sql.js` loading
- `tests/` — per-peer cross-read-write checks and the single multi-peer `benchmark.ts`
- `reports/` — captured cross-read-write and benchmark results linked below

## Reports

- [Cross-read-write report](./reports/cross-read-write.md) — **PASS** on all three peers (both directions)
- [Benchmark report](./reports/benchmark.md) — time ratios vs ode:sqlite, fastest cell bold

## Correctness (`test`)

Each peer file runs both directions (close/reopen between writer and reader):

1. Write with `@yydb/sqlite` (`createWriter` → `save`) → read with the peer (+ `PRAGMA integrity_check`)
2. Write with the peer → read with `@yydb/sqlite` (`openDatabase`, plus the point/range
   reader API: `rowByRowid` hits/misses and a `range` window must match the peer's rows)

```shell
pnpm --dir projects/sqlite.ts/examples/vs-js-libraries test
pnpm --dir projects/sqlite.ts/examples/vs-js-libraries test:node-sqlite
pnpm --dir projects/sqlite.ts/examples/vs-js-libraries test:better-sqlite3
pnpm --dir projects/sqlite.ts/examples/vs-js-libraries test:sql-js
```

`sql.js` is resolved from the workspace `@yydb/sqlite-harness` dependency (same pin the
oracle suite uses).

## Benchmark (`benchmark`)

One file measures `node:sqlite`, `@yydb/sqlite`, `better-sqlite3`, and `sql.js` on fourteen
workloads — `batch`, `scan`, `point`, `point_sql`, `point_uk`, `range`, `indexed`,
`order_limit`, `group_by`, `join`, `update`, `delete`, `rollback`, `open` — then prints a
single relative table vs the `node:sqlite` baseline (`1.00x`, or `Nx` slower/faster), plus
absolute median/p95 round timings (harness `benchSummary`) and a provenance block (node,
rustc, repo rev, binding rev, data scale) in the report.
Defaults are lighter than the harness (`BENCH_ROWS=5000`);
override with `BENCH_ROWS`, `BENCH_TXN`, `BENCH_PAGE`, `BENCH_ROUNDS`, `BENCH_POINT`,
`BENCH_RANGE`, `BENCH_MUTATE`, `BENCH_LIMIT`, `BENCH_AGG`, `BENCH_JOIN`,
`BENCH_SYNCHRONOUS` (`off|on` — `on` puts every library on `synchronous=FULL`).

- `point` uses the reader's `rowByRowid` against each peer's prepared `get`;
  `point_sql` keeps the engine SQL path (peer cells reuse `point`).
- `point_uk` runs a point lookup through a **unique** index on `label` (one untimed
  warmup round, then `BENCH_ROUNDS` timed rounds).
- `range` uses the reader's `range` against each peer's prepared `between`.
- `indexed` runs an equality lookup on an indexed `label` column through the SQL engine
  vs each peer's index.
- `order_limit` repeats `select ... order by id limit 50` to separate the key-order scan
  constant from the per-statement fixed cost; `group_by` aggregates `cast(score as
  integer)` buckets; `join` counts a self-join on `b.id = items.id % 50` — all three run
  one untimed warmup round first and go through the SQL engine on our side.
- `update` / `delete` mutate in one transaction and save; `rollback` inserts then rolls
  back without persisting; `open` measures open + close.

```shell
pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark
```

### Ratio regression gate

The committed report is also an input to a standalone ratio gate. It is deliberately **not** part of `pnpm test`, so
CI never depends on absolute timing:

```shell
pnpm bench:check
```

The script reads `reports/benchmark.md` and fails when an `@yydb/sqlite / node:sqlite` time ratio exceeds **100x**.
Intentional, explained gaps are listed in `reports/benchmark-deltas.json` with a per-workload `maxRatio` and `reason`
(currently `upsert`). `--report`, `--ledger` and `--max-ratio` override the defaults. The gate measures nothing itself,
so it does not fluctuate with machine load.

The committed `reports/benchmark.md` snapshot is captured at `BENCH_ROWS=2000` (with reduced
`BENCH_POINT` / `BENCH_LIMIT` / `BENCH_AGG` / `BENCH_JOIN` / `BENCH_MUTATE`) so the
SQL-heavy workloads (`indexed` / `point_uk` full scans and the wasm column's full scans)
regenerate in a tractable time. The code defaults remain `BENCH_ROWS=5000`; regenerating
at the default takes several minutes because the SQL engine still materializes the whole
table per statement for the non-pinned workloads.

## Intentional deltas

- Our writer is snapshot-based: `update`/`delete` include the full-image `save()`; peers
  write in place through their pager.
- sql.js peer scan includes WASM DB construction from the serialized image each round;
  peer batch/update/delete timings include `export()` to the shared file.
- `BENCH_SYNCHRONOUS=on` aligns durability: our `setSynchronous(true)` vs peers'
  `synchronous=full` (native peers still keep `journal_mode=memory`).
