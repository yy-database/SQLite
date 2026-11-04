# SQLLogicTest 运行器

用外部 SQLLogicTest 语料驱动 `@yydb/sqlite`。运行器只消费安装态公开 API，不修改引擎实现，也不拿引擎输出回填期望值。

## 语料

| 项 | 值 |
|----|----|
| 仓库 | `https://github.com/jzombie/sqlite-sqllogictest-corpus.git` |
| 挂载 | `corpus/`，git submodule |
| pinned commit | `515601a7f89e34b8c1d0325a521f314568eddc0d` |
| 拉取范围 | `--depth 1 --filter=blob:none --sparse`，sparse 路径 `/README.md` `/Dockerfile` `/test/select*.test` |
| 本轮文件 | `select1.test` 270 KB、`select2.test` 250 KB、`select3.test` 896 KB、`select4.test` 1.2 MB、`select5.test` 735 KB |

其他 subset（`random`、`index` 等）通过 `corpus` 内 `git sparse-checkout add` 按需拉取，不改 pinned commit。

## 目录

```
corpus/                 SQLLogicTest 语料 submodule
runner/ts/slt.ts        解析、值渲染、结果比对
runner/ts/run.ts        用 `@yydb/sqlite` 执行单个脚本并输出 JSON
runner/py/run.py        与 TypeScript runner 行为一致的 Python runner
scripts/run.mjs         pack、临时目录安装、并发跑两个 runner、聚合
```

## 运行

前置：Node ≥ 24（`--experimental-strip-types`）、Python 3.12、`maturin`、`pnpm`、`npm`。

```
node scripts/run.mjs                              # select1–select5，TS + PY
node scripts/run.mjs --files select1,select2      # 指定文件
node scripts/run.mjs --only ts                    # 只跑 TS
node scripts/run.mjs --json report.json           # 保存完整报告
node scripts/run.mjs --file-timeout-ms 60000      # 单文件子进程硬超时
```

每次运行都在系统临时目录完成：`pnpm pack` → 临时目录 `npm install` 两个 tarball → 从 `@yydb/sqlite` 公开入口 import，Python 侧用 `maturin build` + 独立 venv。运行结束打印临时目录路径，目录保留不删除。

单文件在独立子进程内执行并带硬超时，超时按 `runner-error` 记录（阻断行为 `file timeout`，退出码非 0），一个用例不会拖住整轮。

## 判定口径

块以空行结束，`#` 开头的行是注释。

支持的指令：`hash-threshold N`（默认 8）、`statement ok`、`statement error [message-pattern]`、`query <types> [nosort|rowsort|valuesort] [label]`、`skipif <engine>`、`onlyif <engine>`、`halt`。引擎判定为 `sqlite`。`require`、`control` 记 `runner-error`。

结果渲染：`I` 按十进制整数，`R` 按 `%.3f`，`T` 原样输出且空串记 `(empty)`，NULL 记 `NULL`。

排序：`nosort` 保持行内顺序，`rowsort` 按整行字符串排序，`valuesort` 按单值排序。期望块按**每个值一行**展开。

超出 `hash-threshold` 时，期望块是 `<N> values hashing to <md5>`；md5 的输入是每个渲染值后接一个换行符的拼接结果，`N` 是值的个数（行数 × 列数）。

期望值只来自语料自带的 `----` 之后内容，运行器不生成或回填期望值。

## 失败分类

| 分类 | 含义 |
|------|------|
| `unsupported` | 引擎拒绝且 `code` 为 `unsupported-statement`、`unsupported-clause`、`syntax` |
| `result-mismatch` | 执行成功但值与期望不符 |
| `error-mismatch` | 该失败却成功，或成功却失败，或错误类型不符 |
| `runner-error` | 解析器、环境或不支持的指令 |

`filtered` 是 `skipif` / `onlyif` 的引擎条件不适用而整条未执行，既不通过也不算失败，单独计数。任何失败都不计入 `filtered`。

## 基线

语料 pin `515601a`，Node v24.18.0。TypeScript 与 Python 两个 runner 逐文件计数一致。

| 文件 | records | pass | unsupported | result-mismatch | error-mismatch | runner-error | filtered |
|------|---------|------|-------------|-----------------|----------------|--------------|----------|
| select1 | 1031 | 31 | 1000 | 0 | 0 | 0 | 0 |
| select2 | 1031 | 49 | 982 | 0 | 0 | 0 | 0 |
| select3 | 3351 | 48 | 3303 | 0 | 0 | 0 | 0 |
| select4 | 3857 | 0 | 2839 | 0 | 1018 | 0 | 0 |
| select5 | 1436 | 0 | 796 | 0 | 640 | 0 | 0 |

- 语句接受率：`93 / 1822` = 5.1%
- query 结果符合率：`35 / 8884` = 0.4%
- 全流程通过文件：0

拒绝码分布：`syntax` 6956、`unsupported-clause` 1964、`unknown-table` 1658。其中 clause 细分：`,` 904、`IN` 566、`UNION` 216、`INTERSECT` 115、`EXCEPT` 103、`NOT` 28、`+` 17、`BETWEEN` 12、`(` 3。

## 已记录的实现问题

只记录，不在本目录修引擎。

| 位置 | 现象 |
|------|------|
| `corpus/test/select5.test:1488` | `INSERT INTO t41 ...` 报 `storage: corrupt YYDB file: sqlite b-tree content boundary invalid` |
| `corpus/test/select5.test:1518` 起 | 之后每张表 `CREATE TABLE` 都报同一个 `storage` 错误，其 INSERT 退化为 `unknown-table` |
| `corpus/test/select4.test:3136` | `CREATE INDEX t1i0 ON t1(...)` 报 `syntax: expected table but found INDEX` |
| select4 / select5 的 `CREATE TABLE` | `VARCHAR(30)`、`DECIMAL(10,2)` 等带括号列类型报 `syntax` |

存储错误的最小复现：连续 `CREATE TABLE tN(a INTEGER, b INTEGER, x VARCHAR)` 并各插入一行，第 50 张表的 INSERT 即报同一 `storage` 错误。

## 执行计划

本轮（P1）：单表 `SELECT`（投影列、`WHERE`、`ORDER BY`、`LIMIT`）+ `CREATE TABLE` + `INSERT` 的可用面，`select1`–`select5` 全量跑完并给出四分类。

按当前阻断计数排序的下一步：

| 顺序 | 能力 | 可直接解锁 |
|------|------|-----------|
| 1 | `CREATE TABLE` 接受带括号列类型 | 89 条 CREATE + 1640 条级联 `unknown-table` 的 INSERT |
| 2 | 存储层 b-tree 边界错误 | 第 41 张表之后的 263 条语句（依赖 1） |
| 3 | 逗号连接 `FROM t1, t2` | select4 的 1814 条、select5 的全部 732 条查询可进入执行 |
| 4 | 投影表达式（`+` `-` `*`、`abs()`、`CASE WHEN`、函数调用） | select1–4 中 4270 条查询的首个阻断 |
| 5 | `IN`、`UNION`、`INTERSECT`、`EXCEPT` | 1000 条查询的首个阻断 |
| 6 | `EXISTS` 相关子查询 | select1–3 中 2351 条查询的首个阻断（`.` 定位） |

后续阶段：

- P2：`JOIN`、`IN`、集合运算、投影表达式。验收：对应文件的可执行查询数与 `result-mismatch` 归零，期望值保持语料原值。
- P3：`EXISTS` 相关子查询、视图、索引拨到 select1–3 全量。
- P4：TCL 测试套件（Fossil 而非 git 仓，需先导出成镜像仓）、`.selftest` 样本库、以 CPython `sqlite3` 为差分 oracle 的模糊测试。

每阶段验收口径：逐文件四分类数字 + TypeScript 与 Python 逐例一致 + 临时目录安装态运行。

## 边界

- 不改 `projects/sqlite.ts/packages/**`、`projects/sqlite.ts/platforms/**` 与 Rust 源码。
- 不发布任何包，`private: true`。
- 期望值不来自本实现。
