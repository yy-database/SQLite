# Cross-read-write report

Captured: 2026-11-08 15:36:25 +08:00  
Tree tip at capture: `f972a0a`  
Node: `v24.18.0`  
Command: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries test`

## Result

**PASS** — all three peers, both directions (64 rows each).

| Peer | Ours → peer | Peer → ours | Notes |
|------|-------------|-------------|-------|
| `better-sqlite3` | ok | ok | `PRAGMA integrity_check = ok` on peer read |
| `node:sqlite` | ok | ok | `DatabaseSync`, Node ≥ 22.5 |
| `sql.js` | ok | ok | shared store is a serialized main-file image |

## Raw output

```text
ok cross-read-write better-sqlite3: 64 rows both directions
ok cross-read-write node-sqlite: 64 rows both directions
ok cross-read-write sql-js: 64 rows both directions (serialized main file)
```

## What each direction checks

1. Write with `@yydb/sqlite` (`createWriter` → `save`) → close → read with the peer (+ integrity check where available).
2. Write with the peer → close → read with `@yydb/sqlite` (`openDatabase`).

Regenerate: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries test` then refresh this file from the console output.
