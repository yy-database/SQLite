# with-type-orm

**Skipped — out of scope for this repository's public surface.**

TypeORM's SQLite drivers (`sqlite` / `better-sqlite3` / `sqljs`) are concrete Driver
implementations inside the ORM bundle. `@yydb/sqlite` is not API-compatible with those
drivers, and teaching TypeORM to use it would mean shipping a forked or full custom
Driver — not a normal public adapter wiring.

No stub integration is kept here on purpose. Prefer the `vs-*` examples for on-disk
interop and throughput against real SQLite libraries.
