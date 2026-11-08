# with-drizzle-orm

**Skipped — out of scope for this repository's public surface.**

`@yydb/sqlite` exposes a format-3 writer / reader plus a fail-closed SQL engine. It is
not a drop-in `better-sqlite3` / `libsql` / `bun:sqlite` connection.

Drizzle's SQLite packages (`drizzle-orm/better-sqlite3`, `drizzle-orm/libsql`, …) are
hard-wired to those drivers. Shipping a working example would require either forking a
Drizzle driver package or inventing a full custom session that still cannot cover the
SQL Drizzle emits against this engine's subset.

No stub integration is kept here on purpose. Prefer the `vs-*` examples for on-disk
interop and throughput against real SQLite libraries.
