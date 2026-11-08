# vs-js-libraries

Cross-library **on-disk** write/read and a side-by-side benchmark of `@yydb/sqlite`
against three JavaScript SQLite peers, with Node's built-in
[`node:sqlite`](https://nodejs.org/api/sqlite.html) (`DatabaseSync`, Node ≥ 22.5)
as the **throughput baseline**:

- [`node:sqlite`](https://nodejs.org/api/sqlite.html) — baseline (`1.00x`)
- [`@yydb/sqlite`](../../packages/sqlite) — uplift/gap vs baseline
- [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3)
- [`sql.js`](https://sql.js.org/) (SQLite compiled to WASM; shared store is a serialized main-file image)

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
2. Write with the peer → read with `@yydb/sqlite` (`openDatabase`)

```shell
pnpm --dir projects/sqlite.ts/examples/vs-js-libraries test
pnpm --dir projects/sqlite.ts/examples/vs-js-libraries test:node-sqlite
pnpm --dir projects/sqlite.ts/examples/vs-js-libraries test:better-sqlite3
pnpm --dir projects/sqlite.ts/examples/vs-js-libraries test:sql-js
```

`sql.js` is resolved from the workspace `@yydb/sqlite-harness` dependency (same pin the
oracle suite uses).

## Benchmark (`benchmark`)

One file measures `node:sqlite`, `@yydb/sqlite`, `better-sqlite3`, and `sql.js` on batch
load, full scan, and point select, then prints a single relative table vs the
`node:sqlite` baseline (`1.00x`, or `Nx` slower/faster). Defaults are lighter than the
harness (`BENCH_ROWS=5000`); override with `BENCH_ROWS`, `BENCH_TXN`, `BENCH_PAGE`,
`BENCH_ROUNDS`, `BENCH_POINT`.

```shell
pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark
```

## Intentional deltas

- Our format-3 reader has no point / range API; point select benches `createEngine` SQL
  against each peer's prepared get / step.
- Our writer has no `synchronous` switch; better-sqlite3 / node:sqlite batch load use
  `synchronous=off` and `journal_mode=memory` (favourable to those native peers).
- sql.js peer scan includes WASM DB construction from the serialized image each round;
  peer batch timing includes `export()` to the shared file.
