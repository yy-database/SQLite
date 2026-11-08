# with-drizzle-orm

Drizzle ORM over `@yydb/sqlite` through the public [`drizzle-orm/sqlite-proxy`](https://orm.drizzle.team/docs/connect-drizzle-proxy) hook.

## Hook

`src/sqlite-proxy.ts` adapts `createEngine` / `executeWithParameters` to the async
`(sql, params, method) => { rows }` callback that `drizzle()` from `drizzle-orm/sqlite-proxy`
accepts. No Drizzle package patches.

## Layout

- `src/` — proxy adapter, Drizzle schema, database factory
- `tests/roundtrip.ts` — insert / select / update / delete via Drizzle query builder

## Run

```shell
pnpm --dir projects/sqlite.ts/examples/with-drizzle-orm test
```

## Limits

The underlying engine is fail-closed: only SQL it already gates will succeed. This example
sticks to that subset (`CREATE TABLE`, `INSERT`, `SELECT`, `UPDATE`, `DELETE`). Drizzle
features that emit unsupported SQL will reject at the engine, not at the proxy boundary.
