# 分歧台账

本文件由 `node scripts/gen-divergences.mjs --write` 生成，`--verify` 会重跑两侧并逐条比对。不要手改。

`direction` 取值：`ours-accepts-sqlite-rejects`、`sqlite-accepts-ours-rejects`、`same-statement-different-result`，以及 `none`（两侧一致，用于证明某条覆盖项不是分歧）。

- 真实 SQLite：CPython 3.12.10 的 `sqlite3` 3.49.1
- 本仓产物：@yydb/sqlite createEngine 引擎 3.45.0（Node v24.18.0），安装态运行
- 用例：37 条，`status` 一律为 `open`

## 按 direction 计数

| direction | 条数 |
|-----------|------|
| `sqlite-accepts-ours-rejects` | 27 |
| `none` | 10 |

## 按 class 计数

| class | 条数 |
|-------|------|
| `missing-feature` | 30 |
| `none` | 6 |
| `semantic-diff` | 1 |

## 按 direction × class 计数

| direction | class | 条数 |
|-----------|-------|------|
| `none` | `missing-feature` | 3 |
| `none` | `none` | 6 |
| `none` | `semantic-diff` | 1 |
| `sqlite-accepts-ours-rejects` | `missing-feature` | 27 |

## 明细

### `implicit.oid`

- direction：`none`
- class：`missing-feature`
- setup：`CREATE TABLE r(a INTEGER)`，`INSERT INTO r VALUES (10), (20)`
- sql：`SELECT oid FROM r`
- SQLite：`[[1],[2]]`
- 本仓：`[[1],[2]]`

### `implicit.rowid`

- direction：`none`
- class：`missing-feature`
- setup：`CREATE TABLE r(a INTEGER)`，`INSERT INTO r VALUES (10), (20)`
- sql：`SELECT rowid FROM r`
- SQLite：`[[1],[2]]`
- 本仓：`[[1],[2]]`

### `implicit.underscore-rowid`

- direction：`none`
- class：`missing-feature`
- setup：`CREATE TABLE r(a INTEGER)`，`INSERT INTO r VALUES (10), (20)`
- sql：`SELECT _rowid_ FROM r`
- SQLite：`[[1],[2]]`
- 本仓：`[[1],[2]]`

### `semantics.count-column-vs-star`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE n1(b INTEGER)`，`INSERT INTO n1 VALUES (NULL), (1), (2)`
- sql：`SELECT count(*), count(b) FROM n1`
- SQLite：`[[3,2]]`
- 本仓：`[[3,2]]`
- 备注：两侧 `count(*)` 与 `count(col)` 结果一致

### `semantics.null-order-asc`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE n1(b INTEGER)`，`INSERT INTO n1 VALUES (NULL), (1), (2)`
- sql：`SELECT b FROM n1 ORDER BY b`
- SQLite：`[[null],[1],[2]]`
- 本仓：`[[null],[1],[2]]`
- 备注：两侧都把 NULL 排在升序最前

### `semantics.null-order-desc`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE n1(b INTEGER)`，`INSERT INTO n1 VALUES (NULL), (1), (2)`
- sql：`SELECT b FROM n1 ORDER BY b DESC`
- SQLite：`[[2],[1],[null]]`
- 本仓：`[[2],[1],[null]]`
- 备注：两侧都把 NULL 排在降序最后

### `syntax.except-all`

- direction：`none`
- class：`none`
- setup：无
- sql：`SELECT 1 EXCEPT ALL SELECT 1`
- SQLite：`near "ALL": syntax error`
- 本仓：`syntax: expected `,` or `FROM` in the projection but found `EXCEPT``
- 备注：背景记录称本引擎接受 `EXCEPT ALL`，本产物在复合查询处直接拒绝，两侧均不接受该语句

### `syntax.ilike`

- direction：`none`
- class：`none`
- setup：无
- sql：`SELECT 'abc' ILIKE 'A%'`
- SQLite：`near "'A%'": syntax error`
- 本仓：`syntax: expected `,` or `FROM` in the projection but found `ILIKE``
- 备注：SQLite 与本引擎都不接受 `ILIKE`

### `syntax.intersect-all`

- direction：`none`
- class：`none`
- setup：无
- sql：`SELECT 1 INTERSECT ALL SELECT 1`
- SQLite：`near "ALL": syntax error`
- 本仓：`syntax: expected `,` or `FROM` in the projection but found `INTERSECT``
- 备注：背景记录称本引擎接受 `INTERSECT ALL`，本产物在复合查询处直接拒绝，两侧均不接受该语句

### `semantics.limit-negative`

- direction：`none`
- class：`semantic-diff`
- setup：`CREATE TABLE t1(a INTEGER)`，`INSERT INTO t1 VALUES (1), (2)`
- sql：`SELECT a FROM t1 ORDER BY a LIMIT -2`
- SQLite：`[[1],[2]]`
- 本仓：`[[1],[2]]`

### `implicit.group-concat`

- direction：`sqlite-accepts-ours-rejects`
- class：`missing-feature`
- setup：`CREATE TABLE t1(a INTEGER)`，`INSERT INTO t1 VALUES (1), (2)`
- sql：`SELECT group_concat(a) FROM t1`
- SQLite：`[["1,2"]]`
- 本仓：`unsupported-clause: aggregate function `group_concat(...)` is not supported, except `count(*)` over the whole result`

### `implicit.hex-function`

- direction：`sqlite-accepts-ours-rejects`
- class：`missing-feature`
- setup：无
- sql：`SELECT hex('A')`
- SQLite：`[["41"]]`
- 本仓：`unknown-function: no such function: hex`

### `implicit.quote-function`

- direction：`sqlite-accepts-ours-rejects`
- class：`missing-feature`
- setup：无
- sql：`SELECT quote('a')`
- SQLite：`[["'a'"]]`
- 本仓：`unknown-function: no such function: quote`

### `implicit.random-function`

- direction：`sqlite-accepts-ours-rejects`
- class：`missing-feature`
- setup：无
- sql：`SELECT typeof(random())`
- SQLite：`[["integer"]]`
- 本仓：`unknown-function: no such function: random`

### `implicit.sqlite-master`

- direction：`sqlite-accepts-ours-rejects`
- class：`missing-feature`
- setup：无
- sql：`SELECT count(*) FROM sqlite_master`
- SQLite：`[[0]]`
- 本仓：`unknown-table: unknown table `sqlite_master``

### `implicit.sqlite-sequence`

- direction：`sqlite-accepts-ours-rejects`
- class：`missing-feature`
- setup：`CREATE TABLE auto(a INTEGER PRIMARY KEY AUTOINCREMENT)`，`INSERT INTO auto(a) VALUES (1)`
- sql：`SELECT count(*) FROM sqlite_sequence`
- SQLite：`[[1]]`
- 本仓：`syntax: expected `,` or `)` after a column definition but found `AUTOINCREMENT``
- 备注：本引擎在 setup 的 `AUTOINCREMENT` 处失败，`sqlite_sequence` 未触达

### `implicit.total-function`

- direction：`sqlite-accepts-ours-rejects`
- class：`missing-feature`
- setup：`CREATE TABLE t1(a INTEGER)`，`INSERT INTO t1 VALUES (1), (2)`
- sql：`SELECT total(a) FROM t1`
- SQLite：`[[3]]`
- 本仓：`unsupported-clause: aggregate function `total(...)` is not supported, except `count(*)` over the whole result`

### `semantics.compound-associativity`

- direction：`sqlite-accepts-ours-rejects`
- class：`missing-feature`
- setup：无
- sql：`SELECT 1 UNION SELECT 2 INTERSECT SELECT 2`
- SQLite：`[[2]]`
- 本仓：`syntax: expected `,` or `FROM` in the projection but found `UNION``
- 备注：复合查询整体被拒，结合顺序无法进入比较

### `semantics.integer-division`

- direction：`sqlite-accepts-ours-rejects`
- class：`missing-feature`
- setup：无
- sql：`SELECT 7 / 2`
- SQLite：`[[3]]`
- 本仓：`syntax: select projection is incomplete`

### `semantics.integer-overflow`

- direction：`sqlite-accepts-ours-rejects`
- class：`missing-feature`
- setup：无
- sql：`SELECT 9223372036854775807 + 1`
- SQLite：`[[9223372036854776000]]`
- 本仓：`syntax: select projection is incomplete`

### `semantics.limit-expression`

- direction：`sqlite-accepts-ours-rejects`
- class：`missing-feature`
- setup：`CREATE TABLE t1(a INTEGER)`，`INSERT INTO t1 VALUES (1), (2), (3)`
- sql：`SELECT a FROM t1 ORDER BY a LIMIT 1 + 1`
- SQLite：`[[1],[2]]`
- 本仓：`unsupported-clause: unsupported `SELECT` clause starting at `+`; this engine supports `FROM`, `WHERE`, `ORDER BY`, `LIMIT` and `UNION` / `IN...`
- 备注：`LIMIT` 表达式被拒绝，数值从未求值

### `semantics.text-primary-key`

- direction：`sqlite-accepts-ours-rejects`
- class：`missing-feature`
- setup：`CREATE TABLE tp(k TEXT PRIMARY KEY, v INTEGER)`，`INSERT INTO tp VALUES ('a', 1)`
- sql：`SELECT k, v FROM tp`
- SQLite：`[["a",1]]`
- 本仓：`storage: unsupported: sqlite non-INTEGER PRIMARY KEY is not supported`

### `syntax.cast`

- direction：`sqlite-accepts-ours-rejects`
- class：`missing-feature`
- setup：无
- sql：`SELECT CAST('12' AS INTEGER)`
- SQLite：`[[12]]`
- 本仓：`syntax: expected `,` or `)` in the argument list but found `AS``

### `syntax.concat-operator`

- direction：`sqlite-accepts-ours-rejects`
- class：`missing-feature`
- setup：无
- sql：`SELECT 'a' || 'b'`
- SQLite：`[["ab"]]`
- 本仓：`syntax: expected `,` or `FROM` in the projection but found `|``

### `syntax.derived-table-without-alias`

- direction：`sqlite-accepts-ours-rejects`
- class：`missing-feature`
- setup：无
- sql：`SELECT * FROM (SELECT 1)`
- SQLite：`[[1]]`
- 本仓：`syntax: expected `,` or `FROM` in the projection but found `)``

### `syntax.insert-default-values`

- direction：`sqlite-accepts-ours-rejects`
- class：`missing-feature`
- setup：`CREATE TABLE dv(a INTEGER DEFAULT 5, b INTEGER)`
- sql：`INSERT INTO dv DEFAULT VALUES`
- SQLite：`[]`
- 本仓：`syntax: expected `values` but found `DEFAULT``

### `syntax.is-true`

- direction：`sqlite-accepts-ours-rejects`
- class：`missing-feature`
- setup：无
- sql：`SELECT 1 IS TRUE`
- SQLite：`[[1]]`
- 本仓：`syntax: expected `null` but found `TRUE``

### `syntax.join-full`

- direction：`sqlite-accepts-ours-rejects`
- class：`missing-feature`
- setup：`CREATE TABLE j1(a INTEGER, b INTEGER)`，`INSERT INTO j1 VALUES (1, 2), (2, 3)`，`CREATE TABLE j2(a INTEGER, c INTEGER)`，`INSERT INTO j2 VALUES (1, 4), (3, 5)`
- sql：`SELECT j1.a FROM j1 FULL JOIN j2 ON j1.a = j2.a`
- SQLite：`[[1],[2],[null]]`
- 本仓：`unsupported-clause: `full` joins are not supported; use `[INNER] JOIN` or `LEFT JOIN``

### `syntax.join-natural`

- direction：`sqlite-accepts-ours-rejects`
- class：`missing-feature`
- setup：`CREATE TABLE j1(a INTEGER, b INTEGER)`，`INSERT INTO j1 VALUES (1, 2), (2, 3)`，`CREATE TABLE j2(a INTEGER, c INTEGER)`，`INSERT INTO j2 VALUES (1, 4), (3, 5)`
- sql：`SELECT a FROM j1 NATURAL JOIN j2`
- SQLite：`[[1]]`
- 本仓：`unsupported-clause: `natural` joins are not supported; use `[INNER] JOIN` or `LEFT JOIN``

### `syntax.join-right`

- direction：`sqlite-accepts-ours-rejects`
- class：`missing-feature`
- setup：`CREATE TABLE j1(a INTEGER, b INTEGER)`，`INSERT INTO j1 VALUES (1, 2), (2, 3)`，`CREATE TABLE j2(a INTEGER, c INTEGER)`，`INSERT INTO j2 VALUES (1, 4), (3, 5)`
- sql：`SELECT j1.a FROM j1 RIGHT JOIN j2 ON j1.a = j2.a`
- SQLite：`[[1],[null]]`
- 本仓：`unsupported-clause: `right` joins are not supported; use `[INNER] JOIN` or `LEFT JOIN``

### `syntax.join-using`

- direction：`sqlite-accepts-ours-rejects`
- class：`missing-feature`
- setup：`CREATE TABLE j1(a INTEGER, b INTEGER)`，`INSERT INTO j1 VALUES (1, 2), (2, 3)`，`CREATE TABLE j2(a INTEGER, c INTEGER)`，`INSERT INTO j2 VALUES (1, 4), (3, 5)`
- sql：`SELECT a FROM j1 JOIN j2 USING (a)`
- SQLite：`[[1]]`
- 本仓：`unsupported-clause: `JOIN ... USING` is not supported; write an explicit `ON` predicate`

### `syntax.like`

- direction：`sqlite-accepts-ours-rejects`
- class：`missing-feature`
- setup：无
- sql：`SELECT 'abc' LIKE 'A%'`
- SQLite：`[[1]]`
- 本仓：`syntax: expected `,` or `FROM` in the projection but found `LIKE``

### `syntax.table-check`

- direction：`sqlite-accepts-ours-rejects`
- class：`missing-feature`
- setup：无
- sql：`CREATE TABLE chk(a INTEGER CHECK (a > 0))`
- SQLite：`[]`
- 本仓：`unsupported-column-constraint: unsupported column constraint in `a``

### `syntax.table-foreign-key`

- direction：`sqlite-accepts-ours-rejects`
- class：`missing-feature`
- setup：`CREATE TABLE parent(a INTEGER PRIMARY KEY)`
- sql：`CREATE TABLE child(a INTEGER REFERENCES parent(a))`
- SQLite：`[]`
- 本仓：`unsupported-column-constraint: unsupported column constraint in `a``

### `syntax.table-primary-key-multi`

- direction：`sqlite-accepts-ours-rejects`
- class：`missing-feature`
- setup：无
- sql：`CREATE TABLE pkab(a INTEGER, b INTEGER, PRIMARY KEY (a, b))`
- SQLite：`[]`
- 本仓：`syntax: expected a numeric type parameter but found `a``

### `syntax.window-function`

- direction：`sqlite-accepts-ours-rejects`
- class：`missing-feature`
- setup：`CREATE TABLE wf(a INTEGER)`，`INSERT INTO wf VALUES (1), (2)`
- sql：`SELECT row_number() OVER (ORDER BY a) FROM wf`
- SQLite：`[[1],[2]]`
- 本仓：`unknown-function: no such function: row_number`

### `syntax.with-recursive`

- direction：`sqlite-accepts-ours-rejects`
- class：`missing-feature`
- setup：无
- sql：`WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < 5) SELECT x FROM cnt`
- SQLite：`[[1],[2],[3],[4],[5]]`
- 本仓：`syntax: expected `,` or `FROM` in the projection but found `UNION``
