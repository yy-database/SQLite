# Benchmark report

Command: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
Defaults: `BENCH_ROWS=5000`, `BENCH_TXN=1000`, `BENCH_PAGE=4096`, `BENCH_ROUNDS=3`, `BENCH_POINT=1000`
Baseline: `node:sqlite` (`DatabaseSync`) = `1.00x`
Ratio: subject_time / baseline_time (smaller is faster). Fastest cell in each row is bold.

## Relative to `node:sqlite`

| Workload | node:sqlite | @yydb/sqlite | better-sqlite3 | sql.js |
|---------:|-------:|-------:|-------:|-------:|
| batch | **1.00x** | 37.27x | 2.94x | 11.89x |
| scan | 1.00x | 6.44x | **0.85x** | 1.55x |
| point | **1.00x** | 154.89x | 1.61x | 1.15x |

## Intentional deltas

- Format-3 reader has no point API; point select benches `createEngine` SQL against each peer's prepared get / step.
- Our writer has no `synchronous` switch; better-sqlite3 / node:sqlite batch load use `synchronous=off` and `journal_mode=memory`.
- sql.js peer scan rebuilds the WASM DB from the serialized image each round; peer batch timing includes `export()`.

Regenerate: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`
