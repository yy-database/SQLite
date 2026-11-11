# @yydb/sqlite-unknown-wasm32

WebAssembly build of the format-3 SQL engine. Exports `MemoryDatabase` plus the bundled `sqlite_wasm_bg.wasm` asset. Listed as an optional dependency of [`@yydb/sqlite`](https://www.npmjs.com/package/@yydb/sqlite), but **Node apps should keep using that package’s native sidecars** — import this package when you need in-browser (or explicit WASM) execution.

Prefer `@yydb/sqlite` on Node. Use this package for WASM glue, the `.wasm` asset, or hosts without a published `.node` sidecar.

## Install

```bash
pnpm add @yydb/sqlite-unknown-wasm32
```

The packaged glue loads `sqlite_wasm_bg.wasm` at import time (relative to the package). Ensure your bundler can resolve/copy sibling `.wasm` assets, or serve them next to the JS entry.

## Quick start

```ts
import { MemoryDatabase } from "@yydb/sqlite-unknown-wasm32";

const db = new MemoryDatabase(); // optional page size, default 4096
db.execute("create table account (id integer primary key, label text)");
db.execute("insert into account (id, label) values (1, 'alpha')");
const result = JSON.parse(db.execute("select id, label from account"));
console.log(result.rows); // [[1, "alpha"]] — integers as JSON numbers
db.free();
```

## API surface

| Member | Role |
|--------|------|
| `new MemoryDatabase(pageSize?)` | Blank in-memory image |
| `execute(sql)` | Exactly one statement → JSON **object** string |
| `exec(sql)` | One or more statements → JSON **array** of results |
| `executeBatch(statements[])` | Ordered list → JSON array |
| `tryExecute(sql)` | Non-throwing: `{ ok, result }` or `{ ok: false, error }` |
| `snapshot()` | Raw main-file bytes (`Uint8Array`) |
| `pageSize()` / `sqliteVersion()` / `ping()` | Image metadata / header check |
| `free()` / `[Symbol.dispose]()` | Release WASM resources |

Each result object looks like `{ statement, affected, columns, rows }`. Blobs encode as `{ "$blob": "<hex>" }`. Structured errors carry `code`, `message`, `statement`, `clause`, and `position`.

## Interop with Node

```ts
// WASM → Node facade
import { MemoryDatabase } from "@yydb/sqlite-unknown-wasm32";
import { SQLite } from "@yydb/sqlite";

const wasm = new MemoryDatabase();
wasm.execute("create table account (id integer primary key, label text)");
wasm.execute("insert into account (id, label) values (1, 'alpha')");
const bytes = wasm.snapshot();
wasm.free();

const db = new SQLite({ data: bytes });
console.log(db.get("select id, label from account where id = ?", [1n]));
// → { id: 1n, label: "alpha" }  (faithful bigint mapping on Node)
db.close();
```

`snapshot()` bytes are ordinary format-3 main files — readable by stock SQLite, `better-sqlite3`, and CPython `sqlite3`.

## Limitations

- **Fail-closed SQL:** the same engine surface as the Node build, including joins, subqueries, recursive CTEs, set
  operators, aggregates, window functions, JSON, date/time and math functions, transactions, `PRAGMA` and
  `VACUUM` / `VACUUM INTO`. Statements outside that surface return a structured error instead of being approximated.
- **Result path is JSON text:** `execute` / `exec` / `executeBatch` return JSON strings, not the Node `bigint` /
  `Uint8Array` facade. Decode and convert at the boundary when you need faithful types.
- **Journal / locking:** in-memory only, so there is no WAL, busy handler or concurrent-writer story.
- **UDF / aggregate / window registration:** no host-function registration surface.
- **In-memory only:** persist by writing `snapshot()` yourself.
- **Not a drop-in replacement** for `@yydb/sqlite`’s `SQLite` class API. All calls are synchronous.

## Related

| Package | Role |
|---------|------|
| [`@yydb/sqlite`](https://www.npmjs.com/package/@yydb/sqlite) | Node facade + native optional deps |
| `@yydb/sqlite-*-x64` / `darwin-arm64` | Native sidecars (do not import from apps) |

[Product overview](https://github.com/yy-database/SQLite/blob/dev/readme.md) · [examples](https://github.com/yy-database/SQLite/tree/dev/projects/sqlite.ts/examples) · [main package README](https://github.com/yy-database/SQLite/blob/dev/projects/sqlite.ts/packages/sqlite/readme.md)
