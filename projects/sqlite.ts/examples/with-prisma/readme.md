# with-prisma

Prisma driver adapter over `@yydb/sqlite` through the public `@prisma/driver-adapter-utils`
`SqlDriverAdapter` / `SqlMigrationAwareDriverAdapterFactory` contracts.

## Hook

`src/sqlite-driver-adapter.ts` implements the same adapter surface Prisma's official
`@prisma/adapter-better-sqlite3` targets. Wire it into Prisma Client as:

```ts
const factory = new SqliteDriverAdapterFactory();
const adapter = await factory.connect();
const prisma = new PrismaClient({ adapter });
```

No Prisma package patches. This example's smoke test exercises the adapter contract directly
(`queryRaw` / `executeRaw` / `executeScript` / `startTransaction` / shadow DB) without requiring
`prisma generate` or the query-engine binary download.

## Layout

- `src/` — `SqlDriverAdapter` + factory over `createEngine`
- `tests/adapter-roundtrip.ts` — adapter-level CRUD + transaction smoke

## Run

```shell
pnpm --dir projects/sqlite.ts/examples/with-prisma test
```

## Limits

Prisma Client model queries still go through Prisma's query engine and may emit SQL outside
this engine's gated subset. Use the adapter for driver-level integration; expand model coverage
only for statements the engine already gates.
