# vs-sql-js

Cross-library interop and a side-by-side bench of `@yydb/sqlite` against
[`sql.js`](https://sql.js.org/) (SQLite compiled to WASM).

`sql.js` is memory-first. The shared store is a **serialized main-file image**:
`createWriter.save` / `openDatabase` on disk for `@yydb/sqlite`, and
`Database.export()` / `new Database(bytes)` for `sql.js`.

## Correctness (`test`)

1. Write with `@yydb/sqlite` → load file bytes into `sql.js` → verify rows + `integrity_check`.
2. Write with `sql.js` → `export()` to disk → read with `@yydb/sqlite`.

`sql.js` is resolved from the workspace `@yydb/sqlite-harness` dependency (same pin the
oracle suite uses).

```shell
pnpm --dir projects/sqlite.ts/examples/vs-sql-js test
```

## Benchmark (`bench`)

Batch load (peer timing includes `export()`), full scan (peer reloads bytes each round),
and point select. Override with `BENCH_ROWS`, `BENCH_TXN`, `BENCH_PAGE`, `BENCH_ROUNDS`,
`BENCH_POINT`.

```shell
pnpm --dir projects/sqlite.ts/examples/vs-sql-js bench
```

## Intentional deltas

- Peer scan includes WASM DB construction from the serialized image each round.
- Point select benches `createEngine` SQL against a `sql.js` prepared statement.
