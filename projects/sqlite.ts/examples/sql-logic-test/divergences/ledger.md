# 分歧台账

本文件由 `node scripts/gen-divergences.mjs --write` 生成，`--verify` 会重跑两侧并逐条比对。不要手改。

`direction` 取值：`ours-accepts-sqlite-rejects`、`sqlite-accepts-ours-rejects`、`same-statement-different-result`，以及 `none`（两侧一致，用于证明某条覆盖项不是分歧）。

- 真实 SQLite：CPython 3.12.10 的 `sqlite3` 3.49.1
- 本仓产物：@yydb/sqlite createEngine 引擎 3.45.0（Node v24.18.0），安装态运行
- 用例：83 条，`status` 一律为 `open`

## 按 direction 计数

| direction | 条数 |
|-----------|------|
| `none` | 77 |
| `sqlite-accepts-ours-rejects` | 5 |
| `same-statement-different-result` | 1 |

## 按 class 计数

| class | 条数 |
|-------|------|
| `none` | 45 |
| `missing-feature` | 36 |
| `intentional-divergence` | 1 |
| `semantic-diff` | 1 |

## 按 direction × class 计数

| direction | class | 条数 |
|-----------|-------|------|
| `none` | `missing-feature` | 31 |
| `none` | `none` | 45 |
| `none` | `semantic-diff` | 1 |
| `same-statement-different-result` | `missing-feature` | 1 |
| `sqlite-accepts-ours-rejects` | `intentional-divergence` | 1 |
| `sqlite-accepts-ours-rejects` | `missing-feature` | 4 |

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

### `syntax.join-full`

- direction：`none`
- class：`missing-feature`
- setup：`CREATE TABLE j1(a INTEGER, b INTEGER)`，`INSERT INTO j1 VALUES (1, 2), (2, 3)`，`CREATE TABLE j2(a INTEGER, c INTEGER)`，`INSERT INTO j2 VALUES (1, 4), (3, 5)`
- sql：`SELECT j1.a FROM j1 FULL JOIN j2 ON j1.a = j2.a`
- SQLite：`[[1],[2],[null]]`
- 本仓：`[[1],[2],[null]]`

### `syntax.join-natural`

- direction：`none`
- class：`missing-feature`
- setup：`CREATE TABLE j1(a INTEGER, b INTEGER)`，`INSERT INTO j1 VALUES (1, 2), (2, 3)`，`CREATE TABLE j2(a INTEGER, c INTEGER)`，`INSERT INTO j2 VALUES (1, 4), (3, 5)`
- sql：`SELECT a FROM j1 NATURAL JOIN j2`
- SQLite：`[[1]]`
- 本仓：`[[1]]`

### `syntax.join-right`

- direction：`none`
- class：`missing-feature`
- setup：`CREATE TABLE j1(a INTEGER, b INTEGER)`，`INSERT INTO j1 VALUES (1, 2), (2, 3)`，`CREATE TABLE j2(a INTEGER, c INTEGER)`，`INSERT INTO j2 VALUES (1, 4), (3, 5)`
- sql：`SELECT j1.a FROM j1 RIGHT JOIN j2 ON j1.a = j2.a`
- SQLite：`[[1],[null]]`
- 本仓：`[[1],[null]]`

### `syntax.join-using`

- direction：`none`
- class：`missing-feature`
- setup：`CREATE TABLE j1(a INTEGER, b INTEGER)`，`INSERT INTO j1 VALUES (1, 2), (2, 3)`，`CREATE TABLE j2(a INTEGER, c INTEGER)`，`INSERT INTO j2 VALUES (1, 4), (3, 5)`
- sql：`SELECT a FROM j1 JOIN j2 USING (a)`
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

### `implicit.join-chain`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE m1(a INTEGER, b INTEGER)`，`INSERT INTO m1 VALUES (1,2)`，`CREATE TABLE m2(a INTEGER, c INTEGER)`，`INSERT INTO m2 VALUES (1,3)`，`CREATE TABLE m3(b INTEGER, a INTEGER, d INTEGER)`，`INSERT INTO m3 VALUES (2,1,4)`
- sql：`SELECT * FROM m1 JOIN m2 USING(a) JOIN m3 USING(a)`
- SQLite：`[[1,2,3,2,4]]`
- 本仓：`[[1,2,3,2,4]]`
- 备注：链式 `USING` 把合并列继续传给下一次连接，左侧列按首次出现的表展开

### `implicit.join-chain-right`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE m1(a INTEGER, b INTEGER)`，`INSERT INTO m1 VALUES (1,2)`，`CREATE TABLE m2(a INTEGER, c INTEGER)`，`INSERT INTO m2 VALUES (1,3)`，`CREATE TABLE m3(b INTEGER, a INTEGER, d INTEGER)`，`INSERT INTO m3 VALUES (2,1,4)`
- sql：`SELECT * FROM m1 JOIN m2 USING(a) RIGHT JOIN m3 USING(a)`
- SQLite：`[[1,2,3,2,4]]`
- 本仓：`[[1,2,3,2,4]]`
- 备注：链式中间换成 `RIGHT JOIN` 结果不变

### `implicit.join-full-count`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE l(id INTEGER, lv TEXT)`，`INSERT INTO l VALUES (1,'a'),(2,'b')`，`CREATE TABLE r(id INTEGER, rv TEXT)`，`INSERT INTO r VALUES (2,'B'),(3,'C')`
- sql：`SELECT count(*) FROM l FULL OUTER JOIN r USING(id)`
- SQLite：`[[3]]`
- 本仓：`[[3]]`
- 备注：`count(*)` 与行数一致

### `implicit.join-full-duplicate`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE d1(id INTEGER)`，`INSERT INTO d1 VALUES (1),(1)`，`CREATE TABLE d2(id INTEGER)`，`INSERT INTO d2 VALUES (1),(1)`
- sql：`SELECT id FROM d1 FULL JOIN d2 USING(id)`
- SQLite：`[[1],[1],[1],[1]]`
- 本仓：`[[1],[1],[1],[1]]`
- 备注：`FULL` 保留匹配重数：2×2 个匹配对共四行，不合并重复行

### `implicit.join-full-multiplicity`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE f1(id INTEGER)`，`INSERT INTO f1 VALUES (1),(1)`，`CREATE TABLE f2(id INTEGER)`，`INSERT INTO f2 VALUES (1),(1),(2)`
- sql：`SELECT id FROM f1 FULL JOIN f2 USING(id)`
- SQLite：`[[1],[1],[1],[1],[2]]`
- 本仓：`[[1],[1],[1],[1],[2]]`
- 备注：`FULL` 保留重复行重数：4 条匹配对 + 1 条未匹配右行，共 5 行，不做整行去重

### `implicit.join-full-order-by`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE l(id INTEGER, lv TEXT)`，`INSERT INTO l VALUES (1,'a'),(2,'b')`，`CREATE TABLE r(id INTEGER, rv TEXT)`，`INSERT INTO r VALUES (2,'B'),(3,'C')`
- sql：`SELECT id, lv, rv FROM l FULL JOIN r USING(id) ORDER BY id DESC`
- SQLite：`[[3,null,"C"],[2,"b","B"],[1,"a",null]]`
- 本仓：`[[3,null,"C"],[2,"b","B"],[1,"a",null]]`
- 备注：`FULL` 与 `ORDER BY` 组合按合并列排序，未匹配侧以 `NULL` 参与排序

### `implicit.join-full-outer-using`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE l(id INTEGER, lv TEXT)`，`INSERT INTO l VALUES (1,'a'),(2,'b')`，`CREATE TABLE r(id INTEGER, rv TEXT)`，`INSERT INTO r VALUES (2,'B'),(3,'C')`
- sql：`SELECT * FROM l FULL OUTER JOIN r USING(id)`
- SQLite：`[[1,"a",null],[2,"b","B"],[3,null,"C"]]`
- 本仓：`[[1,"a",null],[2,"b","B"],[3,null,"C"]]`
- 备注：`FULL` 是匹配对与两侧未匹配行的并集，不做整行去重

### `implicit.join-full-single`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE e1(id INTEGER)`，`INSERT INTO e1 VALUES (1),(1)`，`CREATE TABLE e2(id INTEGER)`，`INSERT INTO e2 VALUES (2)`
- sql：`SELECT id FROM e1 FULL JOIN e2 USING(id)`
- SQLite：`[[1],[1],[2]]`
- 本仓：`[[1],[1],[2]]`
- 备注：左表两条重复行都未匹配、右表一条未匹配：三行全部保留

### `implicit.join-natural`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE l(id INTEGER, lv TEXT)`，`INSERT INTO l VALUES (1,'a'),(2,'b')`，`CREATE TABLE r(id INTEGER, rv TEXT)`，`INSERT INTO r VALUES (2,'B'),(3,'C')`
- sql：`SELECT * FROM l NATURAL JOIN r`
- SQLite：`[[2,"b","B"]]`
- 本仓：`[[2,"b","B"]]`
- 备注：`NATURAL` 只保留公共列一次；结果列为 `id,lv,rv`，未匹配行不出现

### `implicit.join-natural-case`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE t(a INTEGER, b TEXT)`，`INSERT INTO t VALUES (1,'x')`，`CREATE TABLE u(A INTEGER, B TEXT, c TEXT)`，`INSERT INTO u VALUES (1,'x','y')`
- sql：`SELECT * FROM t NATURAL JOIN u`
- SQLite：`[[1,"x","y"]]`
- 本仓：`[[1,"x","y"]]`
- 备注：实测 3.49.1 中 `NATURAL` 公共列按大小写不敏感匹配，保留左表列名

### `implicit.join-natural-columns`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE p(a INTEGER, b INTEGER, c TEXT)`，`INSERT INTO p VALUES (1,2,'p')`，`CREATE TABLE q(c TEXT, id INTEGER, b INTEGER, d TEXT)`，`INSERT INTO q VALUES ('p',9,2,'q')`
- sql：`SELECT * FROM p NATURAL JOIN q`
- SQLite：`[[1,2,"p",9,"q"]]`
- 本仓：`[[1,2,"p",9,"q"]]`
- 备注：`NATURAL` 公共列按大小写不敏感匹配；保留左表列序，右表非公共列按原序追加

### `implicit.join-natural-left`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE l(id INTEGER, lv TEXT)`，`INSERT INTO l VALUES (1,'a'),(2,'b')`，`CREATE TABLE r(id INTEGER, rv TEXT)`，`INSERT INTO r VALUES (2,'B'),(3,'C')`
- sql：`SELECT * FROM l NATURAL LEFT JOIN r`
- SQLite：`[[1,"a",null],[2,"b","B"]]`
- 本仓：`[[1,"a",null],[2,"b","B"]]`
- 备注：`NATURAL LEFT` 保留未匹配左行，右侧补 NULL

### `implicit.join-natural-product`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE n1(x INTEGER)`，`INSERT INTO n1 VALUES (1),(2)`，`CREATE TABLE n2(y INTEGER)`，`INSERT INTO n2 VALUES (10),(20)`
- sql：`SELECT * FROM n1 NATURAL JOIN n2`
- SQLite：`[[1,10],[1,20],[2,10],[2,20]]`
- 本仓：`[[1,10],[1,20],[2,10],[2,20]]`
- 备注：无公共列时 `NATURAL` 退化为笛卡尔积，两列四行

### `implicit.join-natural-right`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE l(id INTEGER, lv TEXT)`，`INSERT INTO l VALUES (1,'a'),(2,'b')`，`CREATE TABLE r(id INTEGER, rv TEXT)`，`INSERT INTO r VALUES (2,'B'),(3,'C')`
- sql：`SELECT * FROM l NATURAL RIGHT JOIN r`
- SQLite：`[[2,"b","B"],[3,null,"C"]]`
- 本仓：`[[2,"b","B"],[3,null,"C"]]`
- 备注：`NATURAL RIGHT` 丢弃未匹配左行，未匹配右行左侧补 NULL

### `implicit.join-right-no-on`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE l(id INTEGER, v TEXT)`，`INSERT INTO l VALUES (1,'a'),(2,'b')`，`CREATE TABLE r(id INTEGER, w TEXT)`，`INSERT INTO r VALUES (2,'B'),(1,'A')`
- sql：`SELECT * FROM l RIGHT JOIN r`
- SQLite：`[[1,"a",2,"B"],[1,"a",1,"A"],[2,"b",2,"B"],[2,"b",1,"A"]]`
- 本仓：`[[1,"a",2,"B"],[1,"a",1,"A"],[2,"b",2,"B"],[2,"b",1,"A"]]`
- 备注：缺 `ON`/`USING` 的 `RIGHT JOIN` 合法，退化为左表驱动的笛卡尔积

### `implicit.join-right-order`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE l(id INTEGER, v TEXT)`，`INSERT INTO l VALUES (1,'a'),(2,'b')`，`CREATE TABLE r(id INTEGER, w TEXT)`，`INSERT INTO r VALUES (2,'B'),(1,'A')`
- sql：`SELECT * FROM l RIGHT JOIN r ON l.id=r.id`
- SQLite：`[[1,"a",1,"A"],[2,"b",2,"B"]]`
- 本仓：`[[1,"a",1,"A"],[2,"b",2,"B"]]`
- 备注：`RIGHT JOIN` 按左表驱动输出，未匹配右行追加在末尾，列序仍左表在前

### `implicit.join-right-using-labels`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE l(id INTEGER, lv TEXT)`，`INSERT INTO l VALUES (1,'a'),(2,'b')`，`CREATE TABLE r(id INTEGER, rv TEXT)`，`INSERT INTO r VALUES (2,'B'),(3,'C')`
- sql：`SELECT id, lv, rv FROM l RIGHT JOIN r USING(id)`
- SQLite：`[[2,"b","B"],[3,null,"C"]]`
- 本仓：`[[2,"b","B"],[3,null,"C"]]`
- 备注：`USING` 列在结果里只出现一次且不带表前缀，列标签 `id,lv,rv`

### `implicit.join-right-using-qualified`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE l(id INTEGER, lv TEXT)`，`INSERT INTO l VALUES (1,'a'),(2,'b')`，`CREATE TABLE r(id INTEGER, rv TEXT)`，`INSERT INTO r VALUES (2,'B'),(3,'C')`
- sql：`SELECT l.id, r.id FROM l RIGHT JOIN r USING(id)`
- SQLite：`[[2,2],[null,3]]`
- 本仓：`[[2,2],[null,3]]`
- 备注：带表前缀引用时两侧各自可寻址：左行未匹配时 `l.id` 为 NULL，`r.id` 仍是右值

### `implicit.join-right-using-single`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE l(id INTEGER, lv TEXT)`，`INSERT INTO l VALUES (1,'a'),(2,'b')`，`CREATE TABLE r(id INTEGER, rv TEXT)`，`INSERT INTO r VALUES (2,'B'),(3,'C')`
- sql：`SELECT id FROM l RIGHT JOIN r USING(id)`
- SQLite：`[[2],[3]]`
- 本仓：`[[2],[3]]`
- 备注：未加前缀的 `USING` 列取合并值，未匹配右行显示右值

### `implicit.join-right-using-star`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE l(id INTEGER, lv TEXT)`，`INSERT INTO l VALUES (1,'a'),(2,'b')`，`CREATE TABLE r(id INTEGER, rv TEXT)`，`INSERT INTO r VALUES (2,'B'),(3,'C')`
- sql：`SELECT * FROM l RIGHT JOIN r USING(id)`
- SQLite：`[[2,"b","B"],[3,null,"C"]]`
- 本仓：`[[2,"b","B"],[3,null,"C"]]`
- 备注：`SELECT *` 不重复输出 `USING` 列，右侧其余列按原序追加

### `implicit.join-using-case-fold`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE t2(a INTEGER)`，`INSERT INTO t2 VALUES (1)`，`CREATE TABLE u2(A INTEGER)`，`INSERT INTO u2 VALUES (1)`
- sql：`SELECT * FROM t2 JOIN u2 USING(a)`
- SQLite：`[[1]]`
- 本仓：`[[1]]`
- 备注：实测 3.49.1 中 `USING` 名匹配大小写不敏感：`a` 与 `A` 视为同一列

### `implicit.join-using-dedupe`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE l(id INTEGER, lv TEXT)`，`INSERT INTO l VALUES (1,'a'),(2,'b'),(2,'c')`，`CREATE TABLE r(id INTEGER, rv TEXT)`，`INSERT INTO r VALUES (2,'B'),(3,'C'),(3,'D')`
- sql：`SELECT * FROM l RIGHT JOIN r USING(id)`
- SQLite：`[[2,"b","B"],[2,"c","B"],[3,null,"C"],[3,null,"D"]]`
- 本仓：`[[2,"b","B"],[2,"c","B"],[3,null,"C"],[3,null,"D"]]`
- 备注：`USING` 列在结果中只出现一次，取两侧合并值（未匹配右行取右值）；右表其余列按原序追加

### `implicit.join-using-multi`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE p(a INTEGER, b INTEGER, c TEXT)`，`INSERT INTO p VALUES (1,2,'p')`，`CREATE TABLE q(c TEXT, id INTEGER, b INTEGER, d TEXT)`，`INSERT INTO q VALUES ('p',9,2,'q')`
- sql：`SELECT * FROM p JOIN q USING(b,c)`
- SQLite：`[[1,2,"p",9,"q"]]`
- 本仓：`[[1,2,"p",9,"q"]]`
- 备注：多列 `USING` 按公共列等值匹配，结果列按左表列序输出

### `implicit.join-using-multi-order`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE p(a INTEGER, b INTEGER, c TEXT)`，`INSERT INTO p VALUES (1,2,'p')`，`CREATE TABLE q(c TEXT, id INTEGER, b INTEGER, d TEXT)`，`INSERT INTO q VALUES ('p',9,2,'q')`
- sql：`SELECT * FROM p JOIN q USING(c,b)`
- SQLite：`[[1,2,"p",9,"q"]]`
- 本仓：`[[1,2,"p",9,"q"]]`
- 备注：`USING` 列出顺序不影响结果，列标签仍是 `a,b,c,id,d`

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

### `semantics.limit-expression`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE t1(a INTEGER)`，`INSERT INTO t1 VALUES (1), (2), (3)`
- sql：`SELECT a FROM t1 ORDER BY a LIMIT 1 + 1`
- SQLite：`[[1],[2]]`
- 本仓：`[[1],[2]]`
- 备注：`LIMIT`/`OFFSET` 已按表达式求值（算术、函数、子查询、文本/实数的 SQLite 转换规则）；`?`/`:name` 参数占位符仍报结构化 `unsupported-parameter`

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

### `syntax.join-natural-on`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE one(x INTEGER)`，`INSERT INTO one VALUES (1)`，`CREATE TABLE two(x INTEGER)`，`INSERT INTO two VALUES (1)`
- sql：`SELECT * FROM one NATURAL JOIN two ON one.x=two.x`
- SQLite：`a NATURAL join may not have an ON or USING clause`
- 本仓：`syntax: a NATURAL join may not have an ON or USING clause`
- 备注：`NATURAL` 不得同时写 `ON` 或 `USING`

### `syntax.join-natural-using`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE one(x INTEGER)`，`INSERT INTO one VALUES (1)`，`CREATE TABLE two(x INTEGER)`，`INSERT INTO two VALUES (1)`
- sql：`SELECT * FROM one NATURAL JOIN two USING(x)`
- SQLite：`a NATURAL join may not have an ON or USING clause`
- 本仓：`syntax: a NATURAL join may not have an ON or USING clause`
- 备注：`NATURAL` 不得同时写 `ON` 或 `USING`

### `syntax.join-using-empty`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE one(x INTEGER)`，`INSERT INTO one VALUES (1)`，`CREATE TABLE two(x INTEGER)`，`INSERT INTO two VALUES (1)`
- sql：`SELECT * FROM one JOIN two USING()`
- SQLite：`near ")": syntax error`
- 本仓：`syntax: near ")": syntax error`
- 备注：真实 SQLite 对空 `USING()` 报 `near ")": syntax error`，本仓同样拒绝

### `syntax.join-using-missing-column`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE one(x INTEGER)`，`INSERT INTO one VALUES (1)`，`CREATE TABLE two(x INTEGER)`，`INSERT INTO two VALUES (1)`
- sql：`SELECT * FROM one JOIN two USING(nope)`
- SQLite：`cannot join using column nope - column not present in both tables`
- 本仓：`unknown-column: cannot join using column nope - column not present in both tables`
- 备注：`USING` 列必须两侧都存在；不存在的列报 `cannot join using column ...`

### `syntax.join-using-name-mismatch`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE t(i INTEGER, j TEXT)`，`INSERT INTO t VALUES (1,'y')`，`CREATE TABLE u(ID INTEGER, J TEXT, k TEXT)`，`INSERT INTO u VALUES (1,'y','z')`
- sql：`SELECT * FROM t JOIN u USING(i,j)`
- SQLite：`cannot join using column i - column not present in both tables`
- 本仓：`unknown-column: cannot join using column i - column not present in both tables`
- 备注：`USING` 列必须两侧都存在：`i`/`j` 与 `ID`/`J` 名字不同，即使大小写折叠也不相等

### `syntax.join-using-on`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE l(id INTEGER, lv TEXT)`，`INSERT INTO l VALUES (1,'a'),(2,'b')`，`CREATE TABLE r(id INTEGER, rv TEXT)`，`INSERT INTO r VALUES (2,'B'),(3,'C')`
- sql：`SELECT * FROM l JOIN r USING(id) ON l.id = r.id`
- SQLite：`near "ON": syntax error`
- 本仓：`syntax: near "ON": syntax error`
- 备注：`USING` 与 `ON` 不能同时写，真实 SQLite 报 `near "on": syntax error`

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

### `syntax.table-check`

- direction：`none`
- class：`none`
- setup：无
- sql：`CREATE TABLE chk(a INTEGER CHECK (a > 0))`
- SQLite：`[]`
- 本仓：`[]`
- 备注：表级、列级与 `CONSTRAINT name CHECK (...)` 三种写法均已支持；插入违反时报结构化 `constraint-failed`，NULL 通过，未知列在建表期报 `unknown-column`

### `syntax.window-function`

- direction：`none`
- class：`none`
- setup：`CREATE TABLE wf(a INTEGER)`，`INSERT INTO wf VALUES (1), (2)`
- sql：`SELECT row_number() OVER (ORDER BY a) FROM wf`
- SQLite：`[[1],[2]]`
- 本仓：`[[1],[2]]`
- 备注：窗口函数已支持（`row_number`/`rank`/`dense_rank`/`ntile`/`percent_rank`/`cume_dist`、聚合默认帧、显式 `ROWS`/`RANGE` 帧、`lag`/`lead`/`first_value`/`last_value`/`nth_value`、命名窗口）；`GROUPS`/`EXCLUDE` 仍明确拒绝，见 `syntax.window-groups`、`syntax.window-exclude`

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

### `semantics.sqlite-sequence-writable`

- direction：`sqlite-accepts-ours-rejects`
- class：`intentional-divergence`
- setup：`CREATE TABLE c(id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)`
- sql：`INSERT INTO sqlite_sequence(name, seq) VALUES ('c', 5)`
- SQLite：`[]`
- 本仓：`readonly-system-table: table sqlite_sequence may not be modified`
- 备注：真实 SQLite 允许直接改自增水位；本仓选择只读（`readonly-system-table`），避免用户直接改自增计数器导致后续插入冲突或与 AUTOINCREMENT 语义不一致。若将来放开，改这一条即可

### `syntax.table-foreign-key`

- direction：`sqlite-accepts-ours-rejects`
- class：`missing-feature`
- setup：`CREATE TABLE parent(a INTEGER PRIMARY KEY)`
- sql：`CREATE TABLE child(a INTEGER REFERENCES parent(a))`
- SQLite：`[]`
- 本仓：`unsupported-column-constraint: unsupported column constraint in `a``

### `syntax.window-exclude`

- direction：`sqlite-accepts-ours-rejects`
- class：`missing-feature`
- setup：`CREATE TABLE we(a INTEGER)`，`INSERT INTO we VALUES (1), (2), (3)`
- sql：`SELECT sum(a) OVER (ORDER BY a ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW EXCLUDE CURRENT ROW) FROM we`
- SQLite：`[[null],[1],[3]]`
- 本仓：`unsupported-clause: window frame `EXCLUDE` is not supported; frames always include every row between their edges`
- 备注：`EXCLUDE` 子句尚未实现，解析期报 `unsupported-clause`（clause `EXCLUDE`），不静默忽略

### `syntax.window-groups`

- direction：`sqlite-accepts-ours-rejects`
- class：`missing-feature`
- setup：`CREATE TABLE wg(a INTEGER)`，`INSERT INTO wg VALUES (1), (2), (3)`
- sql：`SELECT sum(a) OVER (ORDER BY a GROUPS 2 PRECEDING) FROM wg`
- SQLite：`[[1],[3],[6]]`
- 本仓：`unsupported-clause: window frame unit `GROUPS` is not supported`
- 备注：`GROUPS` 帧单位尚未实现，解析期报 `unsupported-clause`（clause `GROUPS`），不静默忽略

### `syntax.with-recursive`

- direction：`sqlite-accepts-ours-rejects`
- class：`missing-feature`
- setup：无
- sql：`WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < 5) SELECT x FROM cnt`
- SQLite：`[[1],[2],[3],[4],[5]]`
- 本仓：`unsupported-clause: `WITH RECURSIVE` is not supported: CTE `cnt` references itself, and this engine evaluates each CTE once`
