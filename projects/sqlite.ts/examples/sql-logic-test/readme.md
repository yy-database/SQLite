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
fixtures/semantics/     语义层 fixtures，8 个文件 136 例
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

node scripts/run-fixtures.mjs                     # 136 条语义 fixture，TS + PY
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
| 查询语义 | `01-query.json` | 46 | 44 | 44 |
| 表达式 | `02-expressions.json` | 15 | 15 | 15 |
| 类型与亲和性 | `03-types.json` | 12 | 12 | 12 |
| 约束 | `04-constraints.json` | 12 | 12 | 12 |
| 索引 | `05-indexes.json` | 10 | 9 | 9 |
| NULL 三值逻辑 | `06-null-logic.json` | 10 | 10 | 10 |
| 边界 | `07-boundaries.json` | 10 | 10 | 10 |
| 多语句与错误 | `08-statements-errors.json` | 21 | 15 | 15 |
| 合计 | 8 个文件 | 136 | 127（93.4%） | 127（93.4%） |

- `gapLocked` 1（`index.desc_is_rejected`）
- `result-mismatch` 0、`runner-error` 0：9 条失败全是能力缺口（`unsupported-statement` 5、`unsupported-clause` 2、`unknown-column` 2）
- 两个执行器 8/8 文件逐例一致；`BETWEEN` 在两侧都已通过

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

本轮实测（CPython 3.12.10 的 `sqlite3` 3.49.1 对安装态 `@yydb/sqlite`）：81 条，`none` 74、`sqlite-accepts-ours-rejects` 6、`same-statement-different-result` 1、`ours-accepts-sqlite-rejects` 0。

复核结论：

- 仍接受而本仓拒绝（5 条，`missing-feature`）：表级 `FOREIGN KEY` / `CHECK`、`WITH RECURSIVE`、窗口函数、`LIMIT` 表达式。
- `INSERT … DEFAULT VALUES`：两侧都接受但结果不同，记为 `same-statement-different-result`。
- `sqlite_sequence` 可写：本仓按系统表只读拒绝（`semantics.sqlite-sequence-writable`，`intentional-divergence`）；理由是防止用户直接改自增计数器导致后续插入冲突或与 `AUTOINCREMENT` 语义不一致。
- `JOIN … USING` / `RIGHT` / `FULL` / `NATURAL` 已按 SQLite 3.49.1 语义实现，台账用 `implicit.join-*` / `syntax.join-*` 逐条记为 `none`；`USING` 与 `NATURAL` 的列名匹配实测均大小写不敏感，`t(i,j)` 与 `u(ID,J,k)` 报错是因为列名本身不同，而非大小写。

## 基线

语料 pin `515601a`，Node v24.18.0。本轮 TypeScript 侧安装态实测（`platforms/sqlite-win32-x64` 产物）：

| 文件 | records | pass | unsupported | result-mismatch | error-mismatch | runner-error | filtered |
|------|---------|------|-------------|-----------------|----------------|--------------|----------|
| select1 | 1031 | 1031 | 0 | 0 | 0 | 0 | 0 |
| select2 | 1031 | 1031 | 0 | 0 | 0 | 0 | 0 |
| select3 | 3351 | 3351 | 0 | 0 | 0 | 0 | 0 |
| select4 | 3857 | 3856 | 1 | 0 | 0 | 0 | 0 |
| select5 | 1436 | 1436 | 0 | 0 | 0 | 0 | 0 |

- 语句接受率：`1821 / 1822` = 99.9%
- query 结果符合率：`8884 / 8884` = 100.0%
- 全流程通过文件：`select1.test`、`select2.test`、`select3.test`、`select5.test`

拒绝码分布：仅剩 1 个 `unsupported`，为 `select4.test:3181` 的 `DESC` 索引键（`unsupported-clause`）；其余分类为 0。

Python 侧语料本轮未复跑；fixtures 两侧已逐例一致（见上表）。

## 已记录的实现问题

只记录，不在本目录修引擎。

| 位置 | 现象 |
|------|------|
| `01-query.json` | `LIMIT … OFFSET` 报 `unsupported-clause`；`ORDER BY` 别名报 `unknown-column` |
| `05-indexes.json` | `DROP INDEX` 报 `unsupported-statement`；`CREATE INDEX … (a DESC)` 按 gap lock 约定拒绝 |
| `08-statements-errors.json` | `UPDATE` / `DELETE` / `DROP TABLE` / `ALTER TABLE` 报 `unsupported-statement`；`OFFSET` 报 `unsupported-clause`；`AS` 别名后按别名排序报 `unknown-column` |

## 执行计划

已完成 P1（单表 `SELECT`：投影列、`WHERE`、`ORDER BY`、`LIMIT`，加 `CREATE TABLE` / `INSERT`）与 P2（`JOIN`：内连接、`USING`、`NATURAL`、`RIGHT`、`FULL`、链式连接；集合运算；投影表达式）。

按剩余拒绝码排序的下一步：

| 顺序 | 能力 | 本轮证据 |
|------|------|---------|
| 1 | 索引 `DESC` 键与 `DROP INDEX` | 语料 1 例 + fixtures 1 例 |
| 2 | `UPDATE` / `DELETE` / `DROP TABLE` / `ALTER TABLE` | fixtures 5 例（`unsupported-statement`） |
| 3 | `LIMIT … OFFSET` 与 `ORDER BY` 别名 | fixtures 3 例 |
| 4 | 表级约束、`WITH RECURSIVE`、窗口函数、`LIMIT` 表达式 | 台账 5 例（`missing-feature`） |

后续阶段：
- P3：`EXISTS` 相关子查询、视图、索引拨到 select1–3 全量。
- P4：TCL 测试套件（Fossil 而非 git 仓，需先导出成镜像仓）、`.selftest` 样本库、以 CPython `sqlite3` 为差分 oracle 的模糊测试。

每阶段验收口径：逐文件四分类数字 + TypeScript 与 Python 逐例一致 + 临时目录安装态运行；语义 fixtures 的 `--verify` 必须仍然通过。

## 边界

- 不改 `projects/sqlite.ts/packages/**`、`projects/sqlite.ts/platforms/**` 与 Rust 源码。
- 不发布任何包，`private: true`。
- 期望值不来自本实现。
