# SQLite

An embedded **SQLite format-3** engine: ordinary `.sqlite` files you can open in stock SQLite, plus a fail-closed SQL subset on Node, Python, and WebAssembly.

[![Check Rust](https://github.com/yy-database/SQLite/actions/workflows/check-rust.yml/badge.svg?branch=dev)](https://github.com/yy-database/SQLite/actions/workflows/check-rust.yml)
[![Check TypeScript](https://github.com/yy-database/SQLite/actions/workflows/check-typescript.yml/badge.svg?branch=dev)](https://github.com/yy-database/SQLite/actions/workflows/check-typescript.yml)
[![npm](https://img.shields.io/npm/v/@yydb/sqlite?label=%40yydb%2Fsqlite)](https://www.npmjs.com/package/@yydb/sqlite)
[![License](https://img.shields.io/badge/license-MPL--2.0-blue)](./License.md)

[`@yydb/sqlite`](https://www.npmjs.com/package/@yydb/sqlite) · [User guides (Chinese)](./projects/sqlite.ts/homepage/documents/zh-hans/index.md) · [Examples](./projects/sqlite.ts/examples) · [Maintainer docs](./documentation/README.md)

## 💡 What is SQLite?

This repository ships a **format-3 compatible** embedded database. Files written here are real SQLite main-database images: `better-sqlite3`, Node’s `node:sqlite`, CPython `sqlite3`, and the upstream CLI can open them. Images those engines write can be read back here.

It is **not** a drop-in replacement for the full SQLite C engine. SQL is a **fail-closed subset** of SQLite's dialect: DDL/DML, joins, subqueries, recursive CTEs, set operators, aggregates, window functions, JSON, date/time and math functions, transactions and savepoints, triggers, views, `ATTACH` and `VACUUM` / `VACUUM INTO` are covered; forms outside that surface reject with a structured error instead of being approximated. Journal mode supports `preserve`, `delete`, and `truncate` (still no WAL writer); file writers serialize on a cross-process lock with `busyTimeoutMs` retry, host UDF registration is unsupported, and results are materialized rather than streamed.

For a local schema-in-file store that is not SQLite format-3, see [YYDB](https://github.com/yy-database/yydb). For server-shaped Redis / PostgreSQL / MongoDB / MySQL compatibility lines, see the sibling `yy-database` repositories.

## 🚀 Getting started

### 1. Agent / prompt (recommended)

Paste into your coding agent:

```text
Install @yydb/sqlite (Node 18+). Open or create a format-3 file with `new SQLite({ filename })`.
Create an `account` table, insert one row with bigint ids, select it back, then close.
Prefer the `SQLite` class API. Treat unsupported SQL as a hard error, not something to work around.
Do not import `@yydb/sqlite-*` platform packages directly.
```

Package API depth: [`@yydb/sqlite` README](./projects/sqlite.ts/packages/sqlite/readme.md). Binding choice and limits: [homepage docs](./projects/sqlite.ts/homepage/documents/zh-hans/index.md).

### 2. Manual install

| You are using | Start with |
|---------------|------------|
| Node.js / TypeScript | [`@yydb/sqlite`](https://www.npmjs.com/package/@yydb/sqlite) |
| Browser / WASM | [`@yydb/sqlite-unknown-wasm32`](https://www.npmjs.com/package/@yydb/sqlite-unknown-wasm32) |
| Python | `sqlite-format3` wheel (maturin over the PyO3 binding) |

**Node.js**

```bash
pnpm add @yydb/sqlite
```

```ts
import {SQLite} from "@yydb/sqlite";

const db = new SQLite({filename: "app.sqlite"});
db.exec("create table account (id integer primary key, label text not null)");
db.run("insert into account (id, label) values (?, ?)", [1n, "alpha"]);
const row = db.get<{ id: bigint; label: string }>(
    "select id, label from account where id = ?",
    [1n],
);
console.log(row);
db.close();
```

Matching `@yydb/sqlite-<os>-<arch>` optional dependencies supply the native binding on supported hosts. Application code imports the facade only.

**Inspect without SQL**

```ts
import {openDatabase} from "@yydb/sqlite/inspect";

const reader = openDatabase("app.sqlite");
console.log(reader.schema(), reader.table("account"));
```

## ✨ Highlights

| Capability | What it means in practice |
|------------|---------------------------|
| **Format-3 files** | On-disk images are ordinary SQLite main databases — dual read/write with peer engines. |
| **Fail-closed SQL** | Unsupported statements error out; the engine does not pretend to run them. |
| **Sync Node API** | `prepare` / `run` / `get` / `all` / `transaction` on a connection that opens immediately. |
| **Faithful storage classes** | `INTEGER` → `bigint`, `BLOB` → `Uint8Array`, no silent Date/boolean coercion. |
| **Inspect path** | `@yydb/sqlite/inspect` reads schema and tables without opening a SQL connection. |
| **Several hosts** | Node native sidecars, Python wheel, and an in-memory WASM `MemoryDatabase`. |

## 📊 How it compares

| | This product | `better-sqlite3` / `node:sqlite` | `sql.js` |
|--|--------------|----------------------------------|---------|
| File format | SQLite format-3 | Upstream SQLite | In-memory / serialized image |
| SQL surface | Fail-closed subset | Full upstream engine | Full upstream (WASM) |
| Typical use | Embed + interop with stock SQLite files | App DB with full SQL | Browser / no native addon |
| Truth for acceptance | Peer engines + official corpora | Upstream itself | Upstream itself |

Cross-library on-disk checks and timings live under [vs-js-libraries](./projects/sqlite.ts/examples/vs-js-libraries).

## 📝 SQL surface

Accepted today (plain predicates only):

```sql
create table account (
    id integer primary key,
    label text not null
);

insert into account (id, label) values (1, 'alpha');

select id, label
from account
where id = 1
order by label
limit 10;
```

`WHERE` may use comparisons, `AND` / `OR` / `NOT`, `IS [NOT] NULL`, column references, and literals. Joins, `GROUP BY`, subqueries, CTEs, aggregates, window functions and `COLLATE` are part of the implemented surface; unsupported forms still reject with a structured error. The authoritative row-by-row matrix is [`sql-capability-matrix.md`](./projects/sqlite.ts/packages/sqlite-harness/gaps/sql-capability-matrix.md). Full API notes and error codes: [package README](./projects/sqlite.ts/packages/sqlite/readme.md).

## 🧪 Examples

| Example | What it shows |
|---------|----------------|
| [roundtrip.ts](./projects/sqlite.ts/examples/roundtrip.ts) | Minimal write / read path |
| [vs-js-libraries](./projects/sqlite.ts/examples/vs-js-libraries) | Cross-read/write vs `better-sqlite3`, `node:sqlite`, `sql.js` + benchmark |
| [with-drizzle-orm](./projects/sqlite.ts/examples/with-drizzle-orm) | Drizzle via `sqlite-proxy` |
| [with-type-orm](./projects/sqlite.ts/examples/with-type-orm) | TypeORM `better-sqlite3` driver hook |
| [with-prisma](./projects/sqlite.ts/examples/with-prisma) | Prisma driver-adapter contract smoke |
| [sql-logic-test](./projects/sqlite.ts/examples/sql-logic-test) | External SQLLogicTest corpus runners |

Python roundtrip: [`projects/sqlite.py/examples/roundtrip.py`](./projects/sqlite.py/examples/roundtrip.py).

## 📜 License

[Mozilla Public License 2.0](./License.md)
