# sqlite-format3 文档

读写 SQLite format-3 主文件与原始页快照。三个绑定（Node-API、PyO3、WebAssembly）共用同一套纯 Rust 页面与记录层。

| 页面 | 内容 |
|------|------|
| [01-quickstart.md](01-quickstart.md) | 写库、读库、导出与外部校验 |
| [02-bindings.md](02-bindings.md) | 三个绑定的作者面与选择建议 |
| [03-limits.md](03-limits.md) | 明确的边界、拒绝行为与未覆盖能力 |

## 版本

| 项 | 值 |
|----|----|
| 包版本 | `0.2.0` |
| 文件格式 | SQLite format-3 |
| 镜像头版本 | `3.45.0` |
| 合同版本 | `/v0` |

## 能力速览

| 能力 | Node-API | PyO3 | WebAssembly |
|------|----------|------|-------------|
| 读取表 / 索引 / 视图 / 触发器 | 是 | 是 | 是 |
| `WITHOUT ROWID` 读取 | 是 | 是 | 是 |
| UTF-16 读取 | 是 | 是 | 是 |
| `-wal` / 热 journal 回放 | 是 | 是 | 否 |
| 写入表、索引、增删改、事务 | 是 | 是 | 是（内存） |
| SQL 执行 | 是 | 是 | 是（结果 JSON 文本） |
| 页快照导出 | 是 | 是 | 是 |
