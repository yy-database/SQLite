# @yydb/sqlite-emulator

Read-only `sqlite3`-style command surface over the SQLite format-3 binding in
`@yydb/sqlite`. It reads the on-disk main-file bytes of a real `.sqlite` file
and prints inspection results. It does not execute SQL, open a live database,
or recover WAL sidecars.

## Scope

Supported:

- `.tables` for user tables and views, hiding `sqlite_` internals.
- `.schema` for every `CREATE` statement kept in the catalog.
- `.ping`, `.encoding` and `.version` health and metadata probes.
- `.dump TABLE` with the rowid and decoded storage classes.

Not supported:

- SQL statements of any kind, including `SELECT`, views, triggers, and virtual tables.
- Writes, journals, and WAL recovery. A read covers the main-file bytes at the moment of opening.
- Encrypted or non-format-3 files, and index B-tree scans such as `WITHOUT ROWID` tables.

## Testing

Run `pnpm build:napi` at the workspace root first. The cases spawn the real
`bin/sqlite3.mjs` against a main file written by `@yydb/sqlite`, so a passing
run covers the printed command bytes, not an in-process shortcut.
