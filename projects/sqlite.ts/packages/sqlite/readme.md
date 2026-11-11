# @yydb/sqlite

Sync Node facade over a SQLite format-3 engine: `new SQLite()` opens a usable connection, a fail-closed SQL subset runs
immediately, and storage classes map faithfully (`INTEGER` → `bigint`, `BLOB` → `Uint8Array`). Matching
`@yydb/sqlite-<platform>` optional dependencies supply the `.node` binding — app code never imports them.

This is **not** full SQLite feature parity and **not** a browser package. For WebAssembly use [
`@yydb/sqlite-unknown-wasm32`](https://www.npmjs.com/package/@yydb/sqlite-unknown-wasm32). Product
overview: [repository README](https://github.com/yy-database/SQLite/blob/dev/readme.md).

## Install

Requires **Node.js 18+**. Install the facade only — platform packages resolve as optional dependencies on supported
hosts:

```bash
pnpm add @yydb/sqlite
# npm i @yydb/sqlite · yarn add @yydb/sqlite
```

If the host has no matching optional package (unsupported `os`/`cpu`, or optional deps disabled), loading fails at
import time. Override the binary path with `SQLITE_NATIVE=/absolute/path/to/sqlite.<platform>.node` when you stage a
binding yourself.

## Quick start

```ts
import {SQLite} from "@yydb/sqlite";

const db = new SQLite({filename: "app.sqlite"});
db.exec("create table account (id integer primary key, label text not null)");
db.run("insert into account (id, label) values (?, ?)", [1n, "alpha"]);
const row = db.get<{ id: bigint; label: string }>(
    "select id, label from account where id = ?",
    [1n],
);
db.close();
```

In-memory: `new SQLite()`. Restore a private copy from bytes: `new SQLite({ data })` (does not write back into the
buffer).

## Exports

| Import                 | Role                                                                  |
|------------------------|-----------------------------------------------------------------------|
| `@yydb/sqlite`         | `SQLite`, `Statement`, `TransactionScope`, `SQLiteError`, value types |
| `@yydb/sqlite/inspect` | Read-only format-3 inspection + snapshot/writer helpers               |

Transitional JSON primitives (`createEngine`, `executeSql`, `bindings`, …) are still re-exported from the root for ORM
adapters and harnesses that have not migrated. New application code should use `SQLite` and `@yydb/sqlite/inspect` only.

## Core API

### `SQLite` connection

| Member                                                             | Notes                                                                |
|--------------------------------------------------------------------|----------------------------------------------------------------------|
| `new SQLite(options?)`                                             | Opens immediately (sync). See options below.                         |
| `prepare` / `run` / `get` / `all` / `iterate`                      | One statement; params optional when the SQL has no placeholders      |
| `exec(script)`                                                     | Multi-statement script, returns `void` (no implicit transaction)     |
| `transaction(cb)`                                                  | Sync closure: success commits, throw rolls back; nested → savepoints |
| `pragma(name, { scalar?, value? })`                                | Read or set; `{ scalar: true }` returns the first cell               |
| `serialize()`                                                      | Consistent format-3 image (`Uint8Array`)                             |
| `backup(path)`                                                     | Storage-layer file backup; refuses inside a transaction              |
| `close()` / `[Symbol.dispose]()`                                   | Idempotent close                                                     |
| `filename`, `isOpen`, `readOnly`, `inTransaction`, `sqliteVersion` | Connection state                                                     |

```ts
const db = new SQLite({filename: "app.sqlite", foreignKeys: true});
db.pragma("user_version", {value: 3});
console.log(db.pragma("user_version", {scalar: true})); // 3n or number from engine
const image = db.serialize();
db.backup("app.backup.sqlite");
```

**Options** (`SQLiteOptions`):

| Option                     | Default      | Behavior                                                     |
|----------------------------|--------------|--------------------------------------------------------------|
| `filename`                 | —            | Path or `URL`; mutually exclusive with `data`                |
| `data`                     | —            | Open a private in-memory copy of a format-3 image            |
| `create`                   | `true`       | Create file when missing (`false` requires an existing file) |
| `readOnly`                 | `false`      | Reject writes; never mutate the file                         |
| `foreignKeys`              | `true`       | Applied via `PRAGMA foreign_keys` on open                    |
| `pageSize`                 | `4096`       | Page size for **new** databases                              |
| `synchronous`              | `true`       | `false` skips durable flush on commit                        |
| `journalMode`              | `"preserve"` | Only `"preserve"` is supported; `"wal"` / `"delete"` throw   |
| `busyTimeoutMs`            | `0`          | Milliseconds to retry the cross-process write lock (`busy`)  |
| `limits`                   | —            | Unsupported — passing it throws `unsupported`                |

A file write connection takes an OS advisory lock on `<db>.lock` and holds it until `close()` (or process exit). Another
writer from **this package** on the same file is rejected with `code: "busy"` and a `SQLITE_BUSY` message;
`busyTimeoutMs` retries for that many milliseconds first. `0` attempts once. Read-only and in-memory connections never
take the write lock. External engines (`sqlite3`, `node:sqlite`, `better-sqlite3`) do not create or check this lock, so
concurrent writes from another engine are **outside the contract** — keep a single writer per file, including across
engines.

### `Statement`

Prepared handles share one native statement. Views (`raw` / `pluck`) share lifecycle with the parent.

```ts
const insert = db.prepare("insert into account (id, label) values (@id, @label)");
insert.run({id: 2n, label: "beta"}); // bare keys or :/@/$ prefixes all match

const byId = db.prepare<{ id: bigint; label: string }, readonly [bigint]>(
    "select id, label from account where id = ?",
);
byId.get([2n]);
byId.raw().get([2n]);     // SQLiteValue[]
byId.pluck().get([2n]);   // first column only
byId.close();
```

- Positional `?` placeholders require an **array**; named (`:name` / `@name` / `$name`) require an **object**.
- `undefined` is not bindable — use explicit `null` for SQL NULL.
- `boolean`, `Date`, plain objects, and nested arrays are rejected (`param-type`); convert at the call site.
- `bigint` must fit signed 64-bit INTEGER.
- `columns()` returns the result header captured at **prepare** time for row-set statements; statements without a result set return `[]`, and `columns-pending` only surfaces for a row-set statement whose header the engine cannot resolve until the first execution.
- An active `iterate()` cursor blocks re-execution until exhausted, `return()`d, or closed (`cursor-active`).

### Transactions

```ts
db.transaction((tx) => {
    tx.run("insert into account (id, label) values (?, ?)", [3n, "gamma"]);
    tx.exec("update account set label = 'gamma!' where id = 3");
});
```

Callbacks must be **synchronous** — a returned `Promise` rolls back and throws `async-callback`. Inside `transaction()`,
do not issue `BEGIN` / `COMMIT` / `ROLLBACK` by hand (`transaction-ownership`). Nesting uses savepoints; only
`mode: "deferred"` is accepted.

### Value mapping

| SQLite  | JavaScript                                         |
|---------|----------------------------------------------------|
| NULL    | `null`                                             |
| INTEGER | `bigint` (including `changes` / `lastInsertRowid`) |
| REAL    | `number`                                           |
| TEXT    | `string`                                           |
| BLOB    | `Uint8Array`                                       |

There is no automatic `Date` / boolean coercion and no “integers as number” mode.

### `@yydb/sqlite/inspect`

SQL-free format-3 readers and builders. Prefer these when you need schema/table dumps without opening a SQL connection.

```ts
import {openDatabase, openSnapshot, createWriter} from "@yydb/sqlite/inspect";

const reader = openDatabase("app.sqlite");
console.log(reader.schema(), reader.table("account"));

const snap = openSnapshot(db.serialize());
console.log(snap.tableDecoded("account"));

const writer = createWriter(4096);
writer.createTable("account", JSON.stringify([
    {name: "id", declaredType: "INTEGER", primaryKey: true},
    {name: "label", declaredType: "TEXT", notNull: true},
]));
writer.insert("account", JSON.stringify([1, "alpha"]));
writer.save("built.sqlite");
```

Also: `openInMemoryDatabase()`, `openWriter(path)`, `decodeRecord(payload)`.

## Platform matrix

| Package                       | Host                | Role                             |
|-------------------------------|---------------------|----------------------------------|
| `@yydb/sqlite-win32-x64`      | Windows x64         | Native `.node` sidecar           |
| `@yydb/sqlite-linux-x64`      | Linux x64           | Native `.node` sidecar           |
| `@yydb/sqlite-darwin-x64`     | macOS Intel         | Native `.node` sidecar           |
| `@yydb/sqlite-darwin-arm64`   | macOS Apple Silicon | Native `.node` sidecar           |
| `@yydb/sqlite-unknown-wasm32` | Browser / WASM      | `MemoryDatabase` + `.wasm` asset |

Native sidecars are **not** public import targets. The facade resolves `@yydb/sqlite-${platform}-${arch}` at load time.
Other OS/arch combinations are unsupported unless you set `SQLITE_NATIVE`.

## Interop

Written files are ordinary SQLite format-3 databases:

- Images from `serialize()` / `backup()` / inspect writers open in stock SQLite, `better-sqlite3`, Node `node:sqlite`,
  and CPython `sqlite3`.
- External engines can write fixtures that this package’s readers and SQL engine consume (integrity and corpus suites do
  exactly that).
- WASM `MemoryDatabase.snapshot()` produces the same main-file bytes; feed them to `new SQLite({ data })` or
  `openSnapshot` on Node.

ORM demos (adapter-level, transitional
primitives): [with-drizzle-orm](https://github.com/yy-database/SQLite/tree/dev/projects/sqlite.ts/examples/with-drizzle-orm), [with-prisma](https://github.com/yy-database/SQLite/tree/dev/projects/sqlite.ts/examples/with-prisma), [with-type-orm](https://github.com/yy-database/SQLite/tree/dev/projects/sqlite.ts/examples/with-type-orm).

## Errors

Failures surface as `SQLiteError` with a stable `code` string and optional `cause`. Engine rejections arrive as a JSON
envelope on the native error message and are unpacked into `code` / `message`.

| Code (examples)                                                                | When                                                                  |
|--------------------------------------------------------------------------------|-----------------------------------------------------------------------|
| `unsupported`                                                                  | Requested option/API not implemented (`wal`, UDF, `limits`, …)        |
| `busy`                                                                         | The file write lock is held elsewhere past `busyTimeoutMs`            |
| `option-invalid` / `option-conflict`                                           | Bad pragma name, invalid `busyTimeoutMs`, or conflicting options      |
| `param-*`                                                                      | Missing / extra / wrong-shape / wrong-type / out-of-range binds       |
| `db-closed` / `statement-closed` / `cursor-active`                             | Lifecycle misuse                                                      |
| `transaction-ownership` / `async-callback` / `commit-failed` / `scope-escaped` | Transaction control flow                                              |
| `backup-in-transaction`                                                        | `backup()` while `inTransaction`                                      |
| `duplicate-column`                                                             | Object-row projection hit duplicate labels — use `AS` or `.raw()`     |
| `engine`                                                                       | Unstructured binding/native failure                                   |

```ts
import {SQLite, SQLiteError} from "@yydb/sqlite";

try {
    new SQLite({filename: "app.sqlite", journalMode: "wal"});
} catch (error) {
    if (error instanceof SQLiteError) console.error(error.code, error.message);
}
```

## Limitations

- **Fail-closed SQL:** the implemented surface covers `CREATE TABLE` (`WITHOUT ROWID`, `STRICT`, foreign keys), indexes
  (composite, partial, expression and `COLLATE`), views, triggers, `INSERT` / `UPDATE` / `DELETE` with `RETURNING` and
  UPSERT, joins, subqueries, recursive CTEs, set operators, aggregates, window functions, JSON, date/time and math
  functions, transactions and savepoints, `ATTACH` / `DETACH`, `PRAGMA` and `VACUUM` / `VACUUM INTO`. Statements outside
  that surface reject with a structured `SQLiteError` instead of being approximated.
- **Journal / locking:** only `journalMode: "preserve"`; no WAL write surface. File writers using this package serialize
  on a cross-process lock with `busyTimeoutMs` retry. That lock is not SQLite's byte-range/journal lock and is invisible
  to external engines, so it does not make concurrent external SQLite writes safe.
- **UDF / aggregate / window registration:** `function()` / `aggregate()` / `window()` always throw `unsupported`.
  Window functions written in SQL are supported; the host registration APIs are not.
- **Result materialization:** query results are fully materialized arrays, not a streaming cursor. `iterate()` is an
  Iterator protocol over an already-materialized native result, so peak memory grows with the result row count.
- **Hosts:** Node native sidecars for the four platforms above; browsers use the WASM package. No published binding for
  other arches yet.
- **Sync-only API:** no Promise-based query surface; transaction callbacks cannot be async.

## Links

- [Repository README](https://github.com/yy-database/SQLite/blob/dev/readme.md)
- [Examples](https://github.com/yy-database/SQLite/tree/dev/projects/sqlite.ts/examples)
- [Homepage / capability docs](https://github.com/yy-database/SQLite/tree/dev/projects/sqlite.ts/homepage)
- npm: [`@yydb/sqlite`](https://www.npmjs.com/package/@yydb/sqlite)
