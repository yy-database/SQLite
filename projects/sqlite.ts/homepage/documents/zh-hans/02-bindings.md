# 绑定选择

三个绑定都构建自同一套纯 Rust 核心，页面布局、记录编码、页头校验只有一份实现。

| 维度 | `sqlite-napi` | `sqlite-pyo3` | `sqlite-wasm` |
|------|---------------|---------------|---------------|
| 宿主 | Node.js | CPython | 浏览器 / Node（WebAssembly） |
| 构建 | `scripts/build-napi.mjs` | `maturin build --release` | `cargo build --target wasm32-unknown-unknown` + `wasm-bindgen` |
| 文件 I/O | 有 | 有 | 无，纯内存 |
| 读取面 | 表、`WITHOUT ROWID`、索引、schema | 同左 | 无 |
| 写入面 | 表、索引、写入行、更新、删除、事务、保存 | 同左（不含事务） | 仅 `CREATE TABLE` / `INSERT` |
| SQL | 无 | 无 | 受限子集 |
| 错误载体 | `napi::Error` | `RuntimeError` | `JsError` |

选择建议：

- 需要事务、索引或写 WAL 前的完整写入能力：Node-API 或 PyO3。
- 需要在浏览器或沙箱里跑内存库并导出可被外部引擎打开的镜像：WebAssembly。
- 需要解析既有 `.sqlite3` 文件（含 `-wal` 与热 journal 回放、UTF-16）：Node-API 或 PyO3。

## 共同约定

- 行号（`rowid`）与 `INTEGER PRIMARY KEY` 别名不重复存储：payload 里该列为 `NULL`，身份由 `rowid` 承担。
- `maxRows` 传入时，读取超过上限会返回结构化错误，而不是静默截断。
- 文本编码按页头声明解释；写入侧固定 UTF-8。
