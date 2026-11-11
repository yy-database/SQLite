# @yydb/sqlite-darwin-arm64

Prebuilt N-API binding for **macOS Apple Silicon** (`os: darwin`, `cpu: arm64`). Ships the `sqlite.darwin-arm64.node` addon consumed by [`@yydb/sqlite`](https://www.npmjs.com/package/@yydb/sqlite).

**Not a public import target.** Application code always imports `@yydb/sqlite`. This package is an optional dependency that npm/pnpm/yarn installs automatically on matching hosts.

## When it loads

| Condition | Result |
|-----------|--------|
| `process.platform === "darwin"` and `process.arch === "arm64"` | `@yydb/sqlite` resolves this package via `require.resolve` |
| Other OS/arch | This package is skipped; another sidecar (or none) applies |
| Optional deps disabled / missing binary | Facade import fails until the binding is staged |

Override: set `SQLITE_NATIVE` to an absolute path of a compatible `.node` file when you build or relocate the addon yourself.

## Example

App code talks only to the facade — this artifact loads underneath:

```ts
import { SQLite } from "@yydb/sqlite";

const db = new SQLite({ filename: "app.sqlite" });
db.exec("create table account (id integer primary key, label text)");
db.run("insert into account (id, label) values (?, ?)", [1n, "alpha"]);
console.log(db.get("select id, label from account where id = ?", [1n]));
db.close();
```

## Related

| Package | Role |
|---------|------|
| [`@yydb/sqlite`](https://www.npmjs.com/package/@yydb/sqlite) | Public Node API (install this) |
| `@yydb/sqlite-win32-x64` / `linux-x64` / `darwin-x64` | Sibling native sidecars |
| [`@yydb/sqlite-unknown-wasm32`](https://www.npmjs.com/package/@yydb/sqlite-unknown-wasm32) | Browser / WASM (`MemoryDatabase`) |

[Product overview](https://github.com/yy-database/SQLite/blob/dev/readme.md) · [examples](https://github.com/yy-database/SQLite/tree/dev/projects/sqlite.ts/examples) · [main package README](https://github.com/yy-database/SQLite/blob/dev/projects/sqlite.ts/packages/sqlite/readme.md)
