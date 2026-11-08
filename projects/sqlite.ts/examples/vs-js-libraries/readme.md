# vs-js-libraries

Cross-library **on-disk** write/read and a side-by-side benchmark of `@yydb/sqlite`
against three JavaScript SQLite peers:

- [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3)
- Node's built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html) (`DatabaseSync`, Node ≥ 22.5)
- [`sql.js`](https://sql.js.org/) (SQLite compiled to WASM; shared store is a serialized main-file image)

## Layout

- `src/` — shared helpers, timing utilities, and `sql.js` loading
- `tests/` — per-peer cross-read-write checks and the single multi-peer `benchmark.ts`

## Correctness (`test`)

Each peer file runs both directions (close/reopen between writer and reader):

1. Write with `@yydb/sqlite` (`createWriter` → `save`) → read with the peer (+ `PRAGMA integrity_check`)
2. Write with the peer → read with `@yydb/sqlite` (`openDatabase`)

```shell
pnpm --dir projects/sqlite.ts/examples/vs-js-libraries test
pnpm --dir projects/sqlite.ts/examples/vs-js-libraries test:better-sqlite3
pnpm --dir projects/sqlite.ts/examples/vs-js-libraries test:node-sqlite
pnpm --dir projects/sqlite.ts/examples/vs-js-libraries test:sql-js
```

`sql.js` is resolved from the workspace `@yydb/sqlite-harness` dependency (same pin the
oracle suite uses).

## Benchmark (`benchmark`)

One file covers all peers vs `@yydb/sqlite`: batch load, full scan, point select.
Prints median / p95 and rows-per-second per peer section. Defaults are lighter than the
harness (`BENCH_ROWS=5000`); override with `BENCH_ROWS`, `BENCH_TXN`, `BENCH_PAGE`,
`BENCH_ROUNDS`, `BENCH_POINT`.

```shell
pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark
```

## Intentional deltas

- Our format-3 reader has no point / range API; point select benches `createEngine` SQL
  against each peer's prepared get / step.
- Our writer has no `synchronous` switch; better-sqlite3 / node:sqlite batch load use
  `synchronous=off` and `journal_mode=memory` (favourable to those peers).
- sql.js peer scan includes WASM DB construction from the serialized image each round;
  peer batch timing includes `export()` to the shared file.
