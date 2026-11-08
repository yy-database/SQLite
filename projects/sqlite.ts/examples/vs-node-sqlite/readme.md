# vs-node-sqlite

Cross-library **on-disk** interop and a side-by-side bench of `@yydb/sqlite` against
Node's built-in [`node:sqlite`](https://nodejs.org/api/sqlite.html) (`DatabaseSync`).
Requires Node.js ≥ 22.5 (this repo pins ≥ 24).

## Correctness (`test`)

1. Write with `@yydb/sqlite` → reopen → read with `DatabaseSync` (plus `PRAGMA integrity_check`).
2. Write with `DatabaseSync` → close → read with `@yydb/sqlite`.

```shell
pnpm --dir projects/sqlite.ts/examples/vs-node-sqlite test
```

## Benchmark (`bench`)

Batch load, full scan, and point select with median / p95 and rows-per-second.
Override with `BENCH_ROWS`, `BENCH_TXN`, `BENCH_PAGE`, `BENCH_ROUNDS`, `BENCH_POINT`.

```shell
pnpm --dir projects/sqlite.ts/examples/vs-node-sqlite bench
```

## Intentional deltas

- Point select benches `createEngine` SQL against a prepared `DatabaseSync` get (the
  format-3 reader has no point API).
- Peer batch load uses `synchronous=off` and `journal_mode=memory`.
