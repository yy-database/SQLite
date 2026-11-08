# with-prisma

**Skipped — out of scope for this repository's public surface.**

Prisma's SQLite support is bundled inside the Prisma query engine and schema datasource
stack. There is no public hook to plug `@yydb/sqlite` (format-3 writer / reader / SQL
engine) in place of Prisma's own driver without forking Prisma's engine binary or the
generated client.

No stub integration is kept here on purpose. Prefer the `vs-*` examples for on-disk
interop and throughput against real SQLite libraries.
