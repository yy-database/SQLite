# Cross-read-write report

Command: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries test`
Node: `v24.18.0`

## Result

**PASS** - all three peers, both directions (64 rows each), including the reader
point/range API checks on every peer-written file.

| Peer | @yydb/sqlite -> peer | Peer -> @yydb/sqlite | Notes |
|------|----------------------|----------------------|-------|
| `better-sqlite3` | ok | ok | `PRAGMA integrity_check = ok` on peer read; `rowByRowid` + `range` verified |
| `node:sqlite` | ok | ok | `DatabaseSync`, Node >= 22.5; `rowByRowid` + `range` verified |
| `sql.js` | ok | ok | shared store is a serialized main-file image; `rowByRowid` + `range` verified |

## Raw output

```text
ok cross-read-write better-sqlite3: 64 rows both directions
ok cross-read-write node-sqlite: 64 rows both directions
ok cross-read-write sql-js: 64 rows both directions (serialized main file)
```

## What each direction checks

1. Write with `@yydb/sqlite` (`createWriter` -> `save`) -> close -> read with the peer (+ integrity check where available).
2. Write with the peer -> close -> read with `@yydb/sqlite` (`openDatabase`), then the
   point/range reader API: `rowByRowid` must hit first/middle/last rows with matching
   cells, miss an absent rowid, and `range` must return an ordered six-row window.

Regenerate: `pnpm --dir projects/sqlite.ts/examples/vs-js-libraries test` then refresh this file from the console output.
