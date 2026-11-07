# 快速开始

## Node-API

```js
const binding = require("./projects/sqlite.rs/sqlite-napi/sqlite.node");
const writer = binding.SqliteWriter.create(4096);
writer.createTable("bench", JSON.stringify([
  { name: "id", declaredType: "INTEGER", primaryKey: true },
  { name: "label", declaredType: "TEXT", notNull: true },
]));
for (let index = 1; index <= 1000; index += 1) {
  writer.insert("bench", JSON.stringify([index, `row-${index}`]));
}
writer.save("/tmp/bench.sqlite3");

const database = binding.SqliteDatabase.open("/tmp/bench.sqlite3");
console.log(database.table("bench").length); // 1000
```

## PyO3

```python
from sqlite_format3 import SqliteDatabase, SqliteWriter

writer = SqliteWriter.create(4096)
writer.create_table("bench", [
    {"name": "id", "declaredType": "INTEGER", "primaryKey": True},
    {"name": "label", "declaredType": "TEXT", "notNull": True},
])
for index in range(1, 1001):
    writer.insert("bench", [index, f"row-{index}"])
writer.save("bench.sqlite3")

print(len(SqliteDatabase.open("bench.sqlite3").table("bench")))  # 1000
```

## WebAssembly

```js
const { MemoryDatabase } = require("@yydb/sqlite-unknown-wasm32");
const database = new MemoryDatabase(4096);
database.exec("create table bench (id integer primary key, label text not null)");
for (let index = 1; index <= 1000; index += 1) {
  database.exec(`insert into bench (id, label) values (${index}, 'row-${index}')`);
}
const counted = JSON.parse(database.exec("select count(*) from bench"));
console.log(counted[0].rows[0][0]); // 1000
fs.writeFileSync("bench.sqlite3", database.snapshot());
```

## 外部校验

所有示例的产物都能被 CPython 标准库直接读取：

```python
import sqlite3
connection = sqlite3.connect("bench.sqlite3")
print(connection.execute("PRAGMA integrity_check").fetchone()[0])  # ok
print(connection.execute("SELECT count(*) FROM bench").fetchone()[0])  # 1000
```

`stages/verify_sqlite.py` 把这两步封装成一条命令，Node 与 WebAssembly 的 smoke 都用它做外部真值。
