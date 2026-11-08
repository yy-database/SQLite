# Benchmark report

Captured: 2026-11-08 15:36:25 +08:00  
Tree tip at capture: `f972a0a`  
Node: `v24.18.0`  
Command: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark`  
Defaults: `BENCH_ROWS=5000`, `BENCH_TXN=1000`, `BENCH_PAGE=4096`, `BENCH_ROUNDS=3`, `BENCH_POINT=1000`

## Summary

Side-by-side median / p95 / throughput for batch load, full scan, and point select.
`@yydb/sqlite` is competitive on format-3 batch/scan relative to intent, but point select uses `createEngine` SQL (reader has no point API) and is much slower than prepared peer gets.

| Peer | Batch peer thrpt | Scan peer thrpt | Point peer thrpt | File bytes (ours / peer) |
|------|------------------|-----------------|------------------|--------------------------|
| `better-sqlite3` | 972,157/s | 1,851,578/s | 52,273/s | 135168 / 126976 |
| `node:sqlite` | 1,553,133/s | 2,943,601/s | 34,151/s | 135168 / 126976 |
| `sql.js` | 130,829/s | 759,844/s | 47,423/s | 135168 / 126976 |

Ours (shared across peer sections): batch median **55.299 ms** (90,418/s), scan median **20.709 ms** (241,442/s), point median **2504.965 ms** (399/s).

## Raw output

```text
vs-js-libraries benchmark — better-sqlite3
workload                                             ours median        ours p95    ours thrpt  better-sqlite3 med  better-sqlite3 p95    peer thrpt
batch load 5000 (4096 page, 1000/txn)                  55.299 ms       55.806 ms      90,418/s            5.143 ms            8.002 ms     972,157/s
full scan 5000 (open+decode / select *)                20.709 ms       23.339 ms     241,442/s            2.700 ms            2.766 ms   1,851,578/s
point select 1000 (engine WHERE / prepared get)      2504.965 ms     2614.282 ms         399/s           19.130 ms           21.856 ms      52,273/s
files: ours 135168 bytes, better-sqlite3 126976 bytes

vs-js-libraries benchmark — node:sqlite
workload                                             ours median        ours p95    ours thrpt     node:sqlite med     node:sqlite p95    peer thrpt
batch load 5000 (4096 page, 1000/txn)                  55.299 ms       55.806 ms      90,418/s            3.219 ms            3.220 ms   1,553,133/s
full scan 5000 (open+decode / select *)                20.709 ms       23.339 ms     241,442/s            1.699 ms            2.380 ms   2,943,601/s
point select 1000 (engine WHERE / prepared get)      2504.965 ms     2614.282 ms         399/s           29.282 ms           33.553 ms      34,151/s
files: ours 135168 bytes, node:sqlite 126976 bytes

vs-js-libraries benchmark — sql.js
workload                                             ours median        ours p95    ours thrpt          sql.js med          sql.js p95    peer thrpt
batch load 5000 (4096 page, 1000/txn)                  55.299 ms       55.806 ms      90,418/s           38.218 ms           70.945 ms     130,829/s
full scan 5000 (open+decode / select *)                20.709 ms       23.339 ms     241,442/s            6.580 ms            7.271 ms     759,844/s
point select 1000 (engine WHERE / prepared get)      2504.965 ms     2614.282 ms         399/s           21.087 ms           24.965 ms      47,423/s
files: ours 135168 bytes, sql.js 126976 bytes

Notes: batch/scan use the format-3 writer/reader vs peer file I/O. Point select uses createEngine SQL on our side (reader has no point API). better-sqlite3 / node:sqlite batch use synchronous=off journal_mode=memory. sql.js peer batch includes export(); peer scan reloads bytes each round.
```

## Intentional deltas (same as README)

- Our format-3 reader has no point / range API; point select benches `createEngine` SQL against each peer's prepared get / step.
- Our writer has no `synchronous` switch; better-sqlite3 / node:sqlite batch load use `synchronous=off` and `journal_mode=memory`.
- sql.js peer scan includes WASM DB construction from the serialized image each round; peer batch timing includes `export()` to the shared file.

Regenerate: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries benchmark` then refresh this file from the console output.
