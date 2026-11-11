# 边界与限制

## WebAssembly

- 不打开文件、不写文件、不读取 `-wal` 或 `-journal`，纯内存运行；持久化由宿主保存 `snapshot()` 字节。
- SQL 与 Node 构建共用同一个引擎：DDL/DML、连接、子查询、递归 CTE、集合运算、聚合、窗口函数、JSON、日期时间与数学函数、事务与保存点、触发器、视图、`PRAGMA`、`VACUUM` / `VACUUM INTO` 都在范围内。范围外的语句返回结构化错误，不做近似执行。
- 结果通道是 JSON 文本，不是 Node 的 `bigint` / `Uint8Array` 面；需要忠实类型时在边界转换。
- 一次镜像只有一种文本编码，写入固定 UTF-8。
- 不提供宿主 UDF / 聚合 / 窗口注册面。

## Node-API 与 PyO3

- 文件 I/O、快照导出与 SQL 执行都在同一套 Rust 引擎上；SQL 语义只有一份实现。
- 写入侧不产生 `-wal` 或 `-journal` 文件；读取侧可以回放既有文件。
- 写入文本为 UTF-8；读取支持 UTF-8、UTF-16LE、UTF-16BE。
- 页面大小必须是 512 到 65536 之间的 2 的幂。
- `save` 会生成索引树并递增 change counter；直接取 `pages` 得到的镜像不包含尚未保存的索引数据。

## 跨进程并发

- 文件写连接在 `<db>.lock` 上持有一把实现内锁，直到 `close()` 或进程退出；`busyTimeoutMs` 只对同样走本实现的连接生效。同一实现的第二个写连接收到 `busy` / `SQLITE_BUSY`。
- 外部引擎（`sqlite3`、`node:sqlite`、`better-sqlite3` 等）不创建也不识别这把锁。本实现与外部引擎同时写同一文件**不在支持范围内**，可能产生损坏镜像；同一文件只应保留一个写入方，跨引擎也如此。
- 写入按“临时文件 + 原子改名”发布，按路径重新打开读取时只会看到某个已提交的完整镜像，不会读到半镜像。

## 共同限制

- 不提供宿主 UDF / 聚合 / 窗口注册；SQL 里写的窗口函数不受影响。
- journal 仅 `preserve` 模式；`wal` / `delete` 在选项校验时抛 `unsupported`，仍无 WAL 写入面。文件写连接支持 `busyTimeoutMs` 的跨进程写锁重试，但该锁只在上面“跨进程并发”的范围内有效。
- 查询结果整体物化，不是流式游标；`iterate()` 只是对已物化结果的 Iterator 协议，峰值内存随结果行数增长。需要流式消费时应在 SQL 侧分页。
- 同步 API：事务回调不能是异步函数。
- 不属于本项目的范围：上游 SQLite C 引擎、YYDB 存储、文件系统事务管理。

## 外部真值

任何写入结果的验收都以外部引擎为准：

- CPython 标准库 `sqlite3` 打开文件并执行 `PRAGMA integrity_check`。
- 行数与首行值必须与写入侧一致。

平台 smoke（`stages/node`、`platforms/sqlite-unknown-wasm32`、`stages/python`）都按这条规则断言。
