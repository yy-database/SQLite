# vs-better-sqlite3

Cross-library **on-disk** interop and a side-by-side bench of `@yydb/sqlite` against
[`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3).

## Correctness (`test`)

1. Write with `@yydb/sqlite` (`createWriter` → `save`) → reopen → read with `better-sqlite3`
   (plus `PRAGMA integrity_check`).
2. Write with `better-sqlite3` → close → read with `@yydb/sqlite` (`openDatabase`).

```shell
pnpm --dir projects/sqlite.ts/examples/vs-better-sqlite3 test
```

## Benchmark (`bench`)

Same scenarios on both sides: batch load, full scan, point select. Prints median / p95
and rows-per-second. Defaults are lighter than the harness (`BENCH_ROWS=5000`); override
with `BENCH_ROWS`, `BENCH_TXN`, `BENCH_PAGE`, `BENCH_ROUNDS`, `BENCH_POINT`.

```shell
pnpm --dir projects/sqlite.ts/examples/vs-better-sqlite3 bench
```

## Intentional deltas

- Our format-3 reader has no point / range API; point select benches `createEngine` SQL
  against a prepared `better-sqlite3` get.
- Our writer has no `synchronous` switch; peer batch load uses `synchronous=off` and
  `journal_mode=memory` (favourable to the peer).
