# 边界与限制

## WebAssembly

- 不打开文件、不写文件、不读取 `-wal` 或 `-journal`。
- SQL 仅接受 `CREATE TABLE`、`INSERT`、`SELECT`（`count(*)`、`*`、列投影，附带可选 `WHERE`、`ORDER BY`、`LIMIT`）。
- `WHERE` 只接受朴素谓词：比较运算、`AND` / `OR` / `NOT`、`IS [NOT] NULL`、列引用与字面量。
- `JOIN`、`GROUP BY`、`HAVING`、`UPDATE`、`DELETE`、`ALTER`、`DROP`、表级约束、视图、触发器、索引都会被拒绝并给出消息。
- 不支持建索引：索引树由文件保存路径生成，而 wasm 构建没有文件系统。拒绝建索引，而不是导出半成品镜像。
- 一次镜像只有一种文本编码，写入固定 UTF-8。
- `SELECT` 先读取整张表再应用 `LIMIT`。

## Node-API 与 PyO3

- 存储原语（页面与记录操作）按显式 API 进行，不经过 SQL；SQL 由 `SqliteEngine` 执行。
- 写入侧不产生 `-wal` 或 `-journal` 文件；读取侧可以回放既有文件。
- 写入文本为 UTF-8；读取支持 UTF-8、UTF-16LE、UTF-16BE。
- 页面大小必须是 512 到 65536 之间的 2 的幂。
- `save` 会生成索引树并递增 change counter；直接取 `pages` 得到的镜像不包含尚未保存的索引数据。

## 共同限制

- 不校验业务约束（`UNIQUE` 冲突、`CHECK`、外键）；这些是数据库语义，不是格式层的职责。
- 不提供增量写入或并发控制。
- 不属于本项目的范围：上游 SQLite C 引擎、YYDB 存储、文件系统事务管理。

## 外部真值

任何写入结果的验收都以外部引擎为准：

- CPython 标准库 `sqlite3` 打开文件并执行 `PRAGMA integrity_check`。
- 行数与首行值必须与写入侧一致。

平台 smoke（`stages/node`、`platforms/sqlite-unknown-wasm32`、`stages/python`）都按这条规则断言。
