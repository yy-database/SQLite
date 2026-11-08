# with-type-orm

TypeORM over `@yydb/sqlite` through the public `better-sqlite3` DataSource `driver` option.

## Hook

TypeORM's `BetterSqlite3Driver` loads `options.driver` when set (otherwise `require("better-sqlite3")`).
`src/yydb-better-sqlite3.ts` is a duck-typed Database/Statement facade over `createEngine` /
`createEngineFromSnapshot`, passed as:

```ts
new DataSource({
  type: "better-sqlite3",
  database: path,
  driver: YydbBetterSqlite3,
  // ...
})
```

No TypeORM package patches.

## Layout

- `src/` — better-sqlite3 facade, entity schema, DataSource factory
- `tests/roundtrip.ts` — synchronize + repository save / find / update / delete

## Run

```shell
pnpm --dir projects/sqlite.ts/examples/with-type-orm test
```

## Limits

`synchronize: true` must emit SQL the engine accepts. Unsupported pragmas TypeORM may request
in optional modes (for example `journal_mode=WAL` via `enableWAL`) are left off. Stick to the
gated SQL subset.
