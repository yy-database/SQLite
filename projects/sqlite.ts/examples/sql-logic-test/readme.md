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
fixtures/semantics/     语义层 fixtures，8 个文件 110 例
fixtures/bindings/      绑定层待填表，只声明调用形状，不含实现
runner/ts/fixtures.ts   用 `@yydb/sqlite` 执行单个 fixtures 文件
runner/py/fixtures.py   与 TypeScript 版行为一致的 Python fixtures 执行器
scripts/run.mjs         pack、临时目录安装、并发跑两个 runner、聚合
scripts/run-fixtures.mjs 跑两个 fixtures 执行器并聚合
scripts/gen-fixtures.py 用 CPython `sqlite3` 锁定 fixture 期望值
scripts/prepare.mjs     两个脚本共用的安装态与 Python 环境准备
```

## 运行

前置：Node ≥ 24（`--experimental-strip-types`）、Python 3.12、`maturin`、`pnpm`、`npm`。

```
node scripts/run.mjs                              # select1–select5，TS + PY
node scripts/run.mjs --files select1,select2      # 指定文件
node scripts/run.mjs --only ts                    # 只跑 TS
node scripts/run.mjs --json report.json           # 保存完整报告
node scripts/run.mjs --file-timeout-ms 60000      # 单文件子进程硬超时

node scripts/run-fixtures.mjs                     # 110 条语义 fixture，TS + PY
node scripts/run-fixtures.mjs --only ts           # 只跑 TypeScript
node scripts/run-fixtures.mjs --files 01-query    # 只跑指定文件
python scripts/gen-fixtures.py --verify           # 校验期望值与 CPython sqlite3 一致
python scripts/gen-fixtures.py --write            # 从 CPython sqlite3 重写期望值

node scripts/gen-divergences.mjs --write          # 重跑两侧并写分歧台账
node scripts/gen-divergences.mjs --verify         # 校验台账未漂移
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

## 语义 fixtures

`fixtures/semantics/*.json` 只描述"给定建表与种子数据，某条 SQL 在 SQLite 里应该得到什么"，与调用方式无关：同一份数据文件由 TypeScript 与 Python 两个执行器各自解析，不各写一份。绑定层形状还在改，`fixtures/bindings/bindings.json` 只留待填表。

| 字段 | 含义 |
|------|------|
| `id` | 全目录唯一 |
| `setup` | 建表与种子语句。字符串表示必须成功；`{"sql": ..., "expect": "error"}` 表示该步必须失败且后续继续执行；`{"repeat": n, "sql": ..., "insert": ...}` 把 `{n}` 从 1 展开到 n |
| `sql` | 被测语句 |
| `expect` | `rows` 锁定期望行集；`error` 表示 SQLite 必须拒绝；`rejected` 是 gap lock，要求本引擎按指定 `code`/`clause` 拒绝 |

期望值只由 `scripts/gen-fixtures.py` 调 CPython `sqlite3` 生成并写入文件，`--verify` 重新计算后逐条比对。`--write` 遇到"该出行的用例被 SQLite 拒绝"或"该拒绝的用例被接受"会直接失败，不允许静默改写。`blob` 统一写成 `{"$blob": "<hex>"}`，数值比较带 1e-9 相对容差。

分类沿用同一套四分类，另加 `gapLocked`：`rejected` 用例按约定被拒绝时计通过并单独计数；引擎改口成别的 `code` 或开始接受该语句时记 `error-mismatch`。

| 分类 | 文件 | 用例 | TS 通过 | PY 通过 |
|------|------|------|---------|---------|
| 查询语义 | `01-query.json` | 20 | 17 | 16 |
| 表达式 | `02-expressions.json` | 15 | 5 | 5 |
| 类型与亲和性 | `03-types.json` | 12 | 12 | 12 |
| 约束 | `04-constraints.json` | 12 | 10 | 10 |
| 索引 | `05-indexes.json` | 10 | 9 | 9 |
| NULL 三值逻辑 | `06-null-logic.json` | 10 | 7 | 7 |
| 边界 | `07-boundaries.json` | 10 | 10 | 10 |
| 多语句与错误 | `08-statements-errors.json` | 21 | 14 | 13 |
| 合计 | 8 个文件 | 110 | 84（76.4%） | 82（74.5%） |

- `gapLocked` 1（`index.desc_is_rejected`）
- `result-mismatch` 0、`runner-error` 0：失败全部是能力缺口（`syntax` 16、`unsupported-statement` 5、`unsupported-clause` 3、`unknown-column` 1、`storage` 1）
- 两个执行器 6/8 文件逐例一致；`BETWEEN` 在 TS 侧已随安装的 `platforms/sqlite-win32-x64` 产物通过，在 Python 侧由当前 Rust 源码构建的产物仍拒绝（2 例）

绑定层待填表（`fixtures/bindings/bindings.json`）：

| 字段 | 含义 |
|------|------|
| `id` | 绑定用例 id |
| `semanticCaseId` | 对应的语义 fixture，`run-fixtures.mjs` 会校验存在性 |
| `status` | 现阶段全部 `todo` |
| `shapes` | 需要的调用形状 |
| `params` / `expect` | 该形状下的入参与预期说明，不含实现 |

形状词表：`prepared-parameters`、`cursor-iterate`、`transaction`、`exec-multi-statement`、`affected-count`、`error-detail`、`typed-columns`。当前 14 条待填，API 契约冻结后再补具体调用。

## 分歧台账

`divergences/ledger.json` 记录真实 SQLite 与本仓安装态产物的实测差异，`divergences/ledger.md` 是按 `direction` 与 `class` 汇总的人读版本。两者都由脚本生成，`--verify` 会重跑两侧并逐条比对，任何漂移直接失败。

每条记录：`id`、`direction`、`setup`（最小建表与种子语句）、`sql`、`sqlite`（真实 SQLite 的逐字输出或错误）、`ours`（本仓输出或错误码与消息）、`class`、`evidence`（两侧版本与生成方式）、`status`（本轮全部 `open`）。

| direction | 含义 |
|-----------|------|
| `ours-accepts-sqlite-rejects` | 本仓接受、SQLite 拒绝 |
| `sqlite-accepts-ours-rejects` | SQLite 接受、本仓拒绝 |
| `same-statement-different-result` | 两侧都执行但结果不同 |
| `none` | 覆盖项复核后两侧一致，用来证明它不构成分歧 |

| class | 含义 |
|-------|------|
| `extension` | 本仓独有的扩展行为 |
| `missing-feature` | 本仓缺少的 SQLite 能力 |
| `semantic-diff` | 两侧都可达但语义不同 |
| `none` | 已复核一致 |

本轮实测（CPython 3.12.10 的 `sqlite3` 3.49.1 对安装态 `@yydb/sqlite`）：37 条，`sqlite-accepts-ours-rejects` 31、`none` 6，另外两类为 0。

复核结论与任务背景的差异：

- `INTERSECT ALL` / `EXCEPT ALL`：背景称本引擎能跑，本产物在复合查询处直接拒绝（`syntax`/`unsupported-clause`），两侧都不接受，按 `none` 记录。
- 复合 `SELECT` 结合顺序：本仓整体拒绝复合查询，结合顺序无法进入比较，`class` 记为 `missing-feature`。
- SQLite 接受而本仓拒绝的：`INSERT … DEFAULT VALUES`、表级 `PRIMARY KEY (a,b)`/`FOREIGN KEY`/`CHECK`、`WITH RECURSIVE`、无别名派生表、`JOIN … USING`/`RIGHT`/`FULL`/`NATURAL`、窗口函数、`CAST`、`IS TRUE`、`||`、`LIKE`、隐式 `rowid`/`_rowid_`/`oid`、`sqlite_master`/`sqlite_sequence`、`total`/`group_concat`/`hex`/`quote`/`random`、`TEXT PRIMARY KEY`、整数除法与溢出、`LIMIT` 表达式。
- 已与 SQLite 一致：`ORDER BY` 的 `NULL` 位次（升序最前、降序最后）与 `count(col)`。

## 基线

语料 pin `515601a`，Node v24.18.0。本轮 TypeScript 侧安装态实测（`platforms/sqlite-win32-x64` 产物）：

| 文件 | records | pass | unsupported | result-mismatch | error-mismatch | runner-error | filtered |
|------|---------|------|-------------|-----------------|----------------|--------------|----------|
| select1 | 1031 | 357 | 674 | 0 | 0 | 0 | 0 |
| select2 | 1031 | 379 | 652 | 0 | 0 | 0 | 0 |
| select3 | 3351 | 895 | 2456 | 0 | 0 | 0 | 0 |
| select4 | 3857 | 2856 | 1001 | 0 | 0 | 0 | 0 |
| select5 | 1436 | 1436 | 0 | 0 | 0 | 0 | 0 |

- 语句接受率：`1821 / 1822` = 99.9%
- query 结果符合率：`4102 / 8884` = 46.2%
- 全流程通过文件：`select5.test`

拒绝码分布：`syntax` 2789、`unsupported-clause` 1994。clause 细分：`BETWEEN` 662、`UNION` 519、`NOT` 331、`EXCEPT` 249、`INTERSECT` 232、`DESC` 1。`unknown-table`、`storage` 与 `()` 列类型错误在本轮为 0。

Python 侧需另行复跑 `node scripts/run.mjs`；本轮 fixtures 复跑显示两面在 `BETWEEN` 上仍有差异，见下节。

## 已记录的实现问题

只记录，不在本目录修引擎。

| 位置 | 现象 |
|------|------|
| `02-expressions.json` | 投影里的常量算术与 `ABS`/`LENGTH`/`SUBSTR`/`ROUND`/`TYPEOF` 报 `syntax: select projection is incomplete`；`COALESCE`、`CASE`、列间算术已可用 |
| `06-null-logic.json` | `count(col)` 按 `,` 拒绝；`SELECT NULL = NULL` 这类无 `FROM` 的常量投影同样被拒 |
| `04-constraints.json` | `SELECT rowid` 报 `unknown-column`；`TEXT PRIMARY KEY` 报 `storage: sqlite non-INTEGER PRIMARY KEY is not supported` |
| `05-indexes.json` | `CREATE INDEX ... (a DESC)` 按 `unsupported-clause`/`DESC` 拒绝；`DROP INDEX` 报 `unsupported-statement` |
| TypeScript 与 Python 安装面 | 同一 fixture `where.between` 在 TS 产物通过，在 Python 侧由当前 Rust 源码构建的产物被拒 |

语料里 `BETWEEN` 仍被拒的用例带表达式边界（如 `c BETWEEN b-2 AND d+2`），与 fixtures 里的字面量边界不是同一形态。

## 执行计划

本轮（P1）：单表 `SELECT`（投影列、`WHERE`、`ORDER BY`、`LIMIT`）+ `CREATE TABLE` + `INSERT` 的可用面，`select1`–`select5` 全量跑完并给出四分类。

按本轮拒绝码排序的下一步：

| 顺序 | 能力 | 本轮证据 |
|------|------|---------|
| 1 | 投影表达式与标量函数 | `syntax` 2789 |
| 2 | `BETWEEN` / `NOT` 的表达式边界 | `unsupported-clause` 993 |
| 3 | `UNION` / `INTERSECT` / `EXCEPT` | `unsupported-clause` 1000 |
| 4 | 索引 `DESC` 键与 `DROP INDEX` | fixtures 与 select4 的 1 例 |

后续阶段：

- P2：`JOIN`、集合运算、投影表达式。验收：对应文件的可执行查询数与 `result-mismatch` 归零，期望值保持语料原值。
- P3：`EXISTS` 相关子查询、视图、索引拨到 select1–3 全量。
- P4：TCL 测试套件（Fossil 而非 git 仓，需先导出成镜像仓）、`.selftest` 样本库、以 CPython `sqlite3` 为差分 oracle 的模糊测试。

每阶段验收口径：逐文件四分类数字 + TypeScript 与 Python 逐例一致 + 临时目录安装态运行；语义 fixtures 的 `--verify` 必须仍然通过。

## 边界

- 不改 `projects/sqlite.ts/packages/**`、`projects/sqlite.ts/platforms/**` 与 Rust 源码。
- 不发布任何包，`private: true`。
- 期望值不来自本实现。
