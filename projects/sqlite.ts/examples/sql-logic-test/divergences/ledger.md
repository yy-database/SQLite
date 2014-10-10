# 分歧台账

本文件由 `node scripts/gen-divergences.mjs --write` 生成，`--verify` 会重跑两侧并逐条比对。不要手改。

`direction` 取值：`ours-accepts-sqlite-rejects`、`sqlite-accepts-ours-rejects`、`same-statement-different-result`，以及 `none`（两侧一致，用于证明某条覆盖项不是分歧）。

- 真实 SQLite：CPython 3.12.10 的 `sqlite3` 3.49.1
- 本仓产物：@yydb/sqlite createEngine 引擎 3.45.0（Node v24.18.0），安装态运行
- 用例：50 条，`status` 一律为 `open`

## 按 direction 计数

| direction | 条数 |
|-----------|------|
| `none` | 40 |
| `sqlite-accepts-ours-rejects` | 9 |
| `same-statement-different-result` | 1 |

## 按 class 计数

| class | 条数 |
|-------|------|
| `missing-feature` | 37 |
| `none` | 12 |
| `semantic-diff` | 1 |

## 按 direction × class 计数

| direction | class | 条数 |
|-----------|-------|------|
| `none` | `missing-feature` | 27 |
| `none` | `none` | 12 |
| `none` | `semantic-diff` | 1 |
| `same-statement-different-result` | `missing-feature` | 1 |
| `sqlite-accepts-ours-rejects` | `missing-feature` | 9 |

## 明细

### `implicit.group-concat`

- direction：`none`
- class：`missing-feature`
- setup：`CREATE TABLE t1(a INTEGER)`，`INSERT INTO t1 VALUES (1), (2)`
- sql：`SELECT group_concat(a) FROM t1`
- SQLite：`[["1,2"]]`
- 本仓：`[["1,2"]]`

### `implicit.group-concat-separator`

- direction：`none`
- class：`missing-feature`
- setup：`CREATE TABLE t1(a INTEGER)`，`INSERT INTO t1 VALUES (1), (2)`
- sql：`SELECT group_concat(a, '-') FROM t1`
- SQLite：`[["1-2"]]`
- 本仓：`[["1-2"]]`

### `implicit.hex-classes`

- direction：`none`
- class：`missing-feature`
- setup：无
- sql：`SELECT hex(255), hex(x'0102'), hex(NULL)`
- SQLite：`[["323535","0102",""]]`
- 本仓：`[["323535","0102",""]]`

### `implicit.hex-function`

- direction：`none`
- class：`missing-feature`
- setup：无
- sql：`SELECT hex('A')`
- SQLite：`[["41"]]`
- 本仓：`[["41"]]`

### `implicit.oid`

- direction：`none`
- class：`missing-feature`
- setup：`CREATE TABLE r(a INTEGER)`，`INSERT INTO r VALUES (10), (20)`
- sql：`SELECT oid FROM r`
- SQLite：`[[1],[2]]`
- 本仓：`[[1],[2]]`

### `implicit.quote-classes`

- direction：`none`
- class：`missing-feature`
- setup：无
- sql：`SELECT quote(NULL), quote(x'0102'), quote(1.5)`
- SQLite：`[["NULL","X'0102'","1.5"]]`
- 本仓：`[["NULL","X'0102'","1.5"]]`

### `implicit.quote-function`

- direction：`none`
- class：`missing-feature`
- setup：无
- sql：`SELECT quote('a')`
- SQLite：`[["'a'"]]`
- 本仓：`[["'a'"]]`

### `implicit.random-function`

- direction：`none`
- class：`missing-feature`
- setup：无
- sql：`SELECT typeof(random())`
- SQLite：`[["integer"]]`
- 本仓：`[["integer"]]`

### `implicit.rowid`

- direction：`none`
- class：`missing-feature`
- setup：`CREATE TABLE r(a INTEGER)`，`INSERT INTO r VALUES (10), (20)`
- sql：`SELECT rowid FROM r`
- SQLite：`[[1],[2]]`
- 本仓：`[[1],[2]]`

### `implicit.sqlite-master`

- direction：`none`
- class：`missing-feature`
- setup：无
- sql：`SELECT count(*) FROM sqlite_master`
- SQLite：`[[0]]`
- 本仓：`[[0]]`

### `implicit.sqlite-sequence`

- direction：`none`
- class：`missing-feature`
- setup：`CREATE TABLE auto(a INTEGER PRIMARY KEY AUTOINCREMENT)`，`INSERT INTO auto(a) VALUES (1)`
- sql：`SELECT count(*) FROM sqlite_sequence`
- SQLite：`[[1]]`
- 本仓：`[[1]]`
- 备注：本引擎在 setup 的 `AUTOINCREMENT` 处失败，`sqlite_sequence` 未触达

### `implicit.total-function`

- direction：`none`
- class：`missing-feature`
- setup：`CREATE TABLE t1(a INTEGER)`，`INSERT INTO t1 VALUES (1), (2)`
- sql：`SELECT total(a) FROM t1`
- SQLite：`[[3]]`
- 本仓：`[[3]]`

### `implicit.underscore-rowid`

- direction：`none`
- class：`missing-feature`
- setup：`CREATE TABLE r(a INTEGER)`，`INSERT INTO r VALUES (10), (20)`
- sql：`SELECT _rowid_ FROM r`
- SQLite：`[[1],[2]]`
- 本仓：`[[1],[2]]`

### `semantics.bitwise-and`

- direction：`none`
- class：`missing-feature`
- setup：无
- sql：`SELECT '2abc' & 3`
- SQLite：`[[2]]`
- 本仓：`[[2]]`

### `semantics.bitwise-not`

- direction：`none`
- class：`missing-feature`
- setup：无
- sql：`SELECT ~1 || 2`
- SQLite：`[["-22"]]`
- 本仓：`[["-22"]]`

### `semantics.bitwise-or`

- direction：`none`
- class：`missing-feature`
- setup：无
- sql：`SELECT 1 | 2`
- SQLite：`[[3]]`
- 本仓：`[[3]]`

### `semantics.compound-associativity`

- direction：`none`
- class：`missing-feature`
- setup：无
- sql：`SELECT 1 UNION SELECT 2 INTERSECT SELECT 2`
- SQLite：`[[2]]`
- 本仓：`[[2]]`
- 备注：复合查询整体被拒，结合顺序无法进入比较

### `semantics.integer-division`

- direction：`none`
- class：`missing-feature`
- setup：无
- sql：`SELECT 7 / 2`
- SQLite：`[[3]]`
- 本仓：`[[3]]`

### `semantics.integer-overflow`

- direction：`none`
- class：`missing-feature`
- setup：无
- sql：`SELECT 9223372036854775807 + 1`
- SQLite：`[[9223372036854776000]]`
- 本仓：`[[9223372036854776000]]`

### `semantics.text-primary-key`

- direction：`none`
- class：`missing-feature`
- setup：`CREATE TABLE tp(k TEXT PRIMARY KEY, v INTEGER)`，`INSERT INTO tp VALUES ('a', 1)`
- sql：`SELECT k, v FROM tp`
- SQLite：`[["a",1]]`
- 本仓：`[["a",1]]`

### `syntax.bitwise-xor`

- direction：`none`
- class：`missing-feature`
- setup：无
- sql：`SELECT 5 ^ 3`
- SQLite：`unrecognized token: "^"`
- 本仓：`syntax: expected `,` or `FROM` in the projection but found `^``

### `syntax.cast`

- direction：`none`
- class：`missing-feature`
- setup：无
- sql：`SELECT CAST('12' AS INTEGER)`
- SQLite：`[[12]]`
- 本仓：`[[12]]`

### `syntax.concat-operator`

- direction：`none`
- class：`missing-feature`
- setup：无
- sql：`SELECT 'a' || 'b'`
- SQLite：`[["ab"]]`
- 本仓：`[["ab"]]`

### `syntax.derived-table-without-alias`

- direction：`none`
- class：`missing-feature`
- setup：无
- sql：`SELECT * FROM (SELECT 1)`
- SQLite：`[[1]]`
- 本仓：`[[1]]`

### `syntax.is-true`

- direction：`none`
- class：`missing-feature`
- setup：无
- sql：`SELECT 1 IS TRUE`
- SQLite：`[[1]]`
- 本仓：`[[1]]`

### `syntax.like`

- direction：`none`
- class：`missing-feature`
- setup：无
- sql：`SELECT 'abc' LIKE 'A%'`
- SQLite：`[[1]]`
- 本仓：`[[1]]`

### `syntax.table-primary-key-multi`

- direction：`none`
- class：`missing-feature`
- setup：无
- sql：`CREATE TABLE pkab(a INTEGER, b INTEGER, PRIMARY KEY (a, b))`
- SQLite：`[]`
- 本仓：`[]`

### `implicit.autoincrement-ids`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE c(id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)`，`INSERT INTO c(v) VALUES ('x')`，`INSERT INTO c(v) VALUES ('y')`，`INSERT INTO c(id, v) VALUES (100, 'z')`，`INSERT INTO c(v) VALUES ('w')`
- sql：`SELECT id FROM c ORDER BY id`
- SQLite：`[[1],[2],[100],[101]]`
- 本仓：`[[1],[2],[100],[101]]`
- 备注：显式 100 之后的自动值从 101 起，不复用低位

### `implicit.autoincrement-sequence`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE c(id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)`，`INSERT INTO c(v) VALUES ('x')`，`INSERT INTO c(v) VALUES ('y')`，`INSERT INTO c(id, v) VALUES (100, 'z')`
- sql：`SELECT name, seq FROM sqlite_sequence`
- SQLite：`[["c",100]]`
- 本仓：`[["c",100]]`
- 备注：显式写入更大值后 watermark 抬到 100

### `implicit.sqlite-master-order`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE a(x INTEGER, y TEXT)`，`CREATE INDEX ia ON a(x)`，`CREATE TABLE b(id INTEGER PRIMARY KEY, tag TEXT UNIQUE)`
- sql：`SELECT type, name, tbl_name, rootpage, sql FROM sqlite_master`
- SQLite：`[["table","a","a",2,"CREATE TABLE a(x INTEGER, y TEXT)"],["index","ia","a",3,"CREATE INDEX ia ON a(x)"],["table","b","b",4,"CREATE TABLE b(i...`
- 本仓：`[["table","a","a",2,"CREATE TABLE a(x INTEGER, y TEXT)"],["index","ia","a",3,"CREATE INDEX ia ON a(x)"],["table","b","b",4,"CREATE TABLE b(i...`
- 备注：行序按创建/rootpage 顺序；`sql` 为原始文本；autoindex 的 `sql` 为 NULL

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

### `syntax.autoincrement-non-integer`

- direction：`none`
- class：`none`
- setup：无
- sql：`CREATE TABLE z(a TEXT PRIMARY KEY AUTOINCREMENT)`
- SQLite：`AUTOINCREMENT is only allowed on an INTEGER PRIMARY KEY`
- 本仓：`autoincrement-integer-primary-key: AUTOINCREMENT is only allowed on an INTEGER PRIMARY KEY`
- 备注：AUTOINCREMENT 只允许 INTEGER PRIMARY KEY

### `syntax.except-all`

- direction：`none`
- class：`none`
- setup：无
- sql：`SELECT 1 EXCEPT ALL SELECT 1`
- SQLite：`near "ALL": syntax error`
- 本仓：`syntax: expected `select` but found `ALL``
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
- 本仓：`syntax: expected `select` but found `ALL``
- 备注：背景记录称本引擎接受 `INTERSECT ALL`，本产物在复合查询处直接拒绝，两侧均不接受该语句

### `syntax.reserved-object-name`

- direction：`none`
- class：`none`
- setup：无
- sql：`CREATE TABLE sqlite_foo(a INTEGER)`
- SQLite：`object name reserved for internal use: sqlite_foo`
- 本仓：`reserved-name: object name reserved for internal use: sqlite_foo`
- 备注：`sqlite_` 前缀为保留名；本仓报结构化错误码 `reserved-name`

### `syntax.sqlite-master-read-only`

- direction：`none`
- class：`none`
- setup：无
- sql：`INSERT INTO sqlite_master VALUES('table','x','x',10,'CREATE TABLE x(y)')`
- SQLite：`table sqlite_master may not be modified`
- 本仓：`readonly-system-table: table sqlite_master may not be modified`
- 备注：系统表只读；本仓报结构化错误码 `readonly-system-table`

### `semantics.limit-negative`

- direction：`none`
- class：`semantic-diff`
- setup：`CREATE TABLE t1(a INTEGER)`，`INSERT INTO t1 VALUES (1), (2)`
- sql：`SELECT a FROM t1 ORDER BY a LIMIT -2`
- SQLite：`[[1],[2]]`
- 本仓：`[[1],[2]]`

### `syntax.insert-default-values`

- direction：`same-statement-different-result`
- class：`missing-feature`
- setup：`CREATE TABLE dv(a INTEGER DEFAULT 5, b INTEGER)`
- sql：`INSERT INTO dv DEFAULT VALUES`
- SQLite：`[]`
- 本仓：`[[1]]`

### `semantics.limit-expression`

- direction：`sqlite-accepts-ours-rejects`
- class：`missing-feature`
- setup：`CREATE TABLE t1(a INTEGER)`，`INSERT INTO t1 VALUES (1), (2), (3)`
- sql：`SELECT a FROM t1 ORDER BY a LIMIT 1 + 1`
- SQLite：`[[1],[2]]`
- 本仓：`unsupported-clause: unsupported `SELECT` clause starting at `+`; this engine supports `FROM`, `WHERE`, `ORDER BY`, `LIMIT` and `UNION` / `IN...`
- 备注：`LIMIT` 表达式被拒绝，数值从未求值

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
- 本仓：`unsupported-clause: `WITH RECURSIVE` is not supported: CTE `cnt` references itself, and this engine evaluates each CTE once`
