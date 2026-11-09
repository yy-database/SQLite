# sqlite-wasm

In-memory SQLite format-3 database for WebAssembly. It owns no file I/O: the
whole image lives in memory and is exported as raw pages. Page writing and
record encoding come from the pure-Rust `sqlite` facade, so this crate adds only
a small fail-closed SQL front end.

## SQL subset

| Statement | Accepted form |
|-----------|---------------|
| `CREATE TABLE` | column list with `PRIMARY KEY`, `NOT NULL`, `UNIQUE`, `DEFAULT` |
| `INSERT` | optional column list, one or more `VALUES` tuples |
| `SELECT` | `count(*)`, `*`, or explicit columns, with optional `WHERE`, `ORDER BY` and `LIMIT` |

`JOIN`, `GROUP BY`, `HAVING`, `UPDATE`, `DELETE`, `ALTER`, `DROP`,
table-level constraints, views, triggers, and indexes are rejected with a
message. `WHERE` accepts plain predicates only: comparisons, `AND` / `OR` /
`NOT`, `IS [NOT] NULL`, column references and literals. Indexes are excluded on
purpose: index trees are materialized by the file-writing path, which this crate
does not have.

## Build

```powershell
cargo build -p sqlite-wasm --target wasm32-unknown-unknown --release
wasm-bindgen --target nodejs --out-dir projects/sqlite.ts/platforms/sqlite-unknown-wasm32/lib --out-name sqlite_wasm projects/sqlite.rs/target/wasm32-unknown-unknown/release/sqlite_wasm.wasm
```

`../../../scripts/build-wasm.mjs` runs both steps and scopes the generated glue to
CommonJS; the smoke check lives in the platform package at
`tests/smoke.mjs`. `wasm-opt -Oz` is optional; the reported size below was measured
with `binaryen` release `version_123`.

## Host contract

```js
const { MemoryDatabase } = require("@yydb/sqlite-unknown-wasm32");
const database = new MemoryDatabase(4096);
database.exec("create table bench (id integer primary key, label text)");
for (let index = 1; index <= 1000; index += 1) {
  database.exec(`insert into bench values (${index}, 'row-${index}')`);
}
const counted = JSON.parse(database.exec("select count(*) from bench"));
// counted[0].rows[0][0] === 1000
fs.writeFileSync("bench.sqlite3", database.snapshot());
```

`exec` returns a JSON array of `{"statement","affected","columns","rows"}`.
Integers are JSON numbers, text is a JSON string, blobs are
`{"$blob":"<hex>"}`. `snapshot()` returns the main-file bytes; `pageSize()`,
`sqliteVersion()`, and `ping()` expose the header.

## Size

| Stage | Bytes |
|-------|-------|
| `cargo build --release` (`wasm32-unknown-unknown`) | 370 031 |
| `wasm-bindgen --target nodejs` | 347 640 |
| `wasm-opt -Oz` | 266 829 |

## Limits

- No file I/O, no WAL, no rollback journal, no indexes.
- `SELECT` reads the whole table image before applying `LIMIT`.
- One text encoding per image; the wasm surface always writes UTF-8.
