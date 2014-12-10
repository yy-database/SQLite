# SQL capability matrix

Measured against the pinned `database.rs` facade rev `3bb849f` (`3bb849f5f696e938f27aefdd67f174c91f652cd8`,
`projects/facades/sqlite/src/sql`). Every row below was executed through this repository's own engine and
through both live oracles; the oracle value, not an internal expectation, decides whether a row is correct.

| Item | Value |
|------|-------|
| Engine under test | `sqlite.node` built from the pin, `createEngine()` |
| Oracle A | `better-sqlite3` 12.11.1 (SQLite 3.53.2) |
| Oracle B | CPython `sqlite3` (SQLite 3.49.1) |
| Probes | 182 statements/cases, one or more per cluster |
| Local facade override | None; Cargo resolved the pin directly |

Status legend:

- `gated` — implemented and asserted by the `sql` gate (`sql-engine.test.ts`, `sql-expression.test.ts`, `three-valued-logic.test.ts`).
- `uncovered` — implemented and oracle-matching, but no gate executed it before this change.
- `missing` — rejected with a structured error.

Cluster totals (121 feature rows): **109 gated / 0 uncovered / 12 missing** at the pin.

## DDL

| Feature | Probe | Status | Evidence |
|---------|-------|--------|----------|
| `CREATE TABLE` PK / NOT NULL / UNIQUE / DEFAULT / CHECK / AUTOINCREMENT | `create table ct (id integer primary key autoincrement, name text not null unique default 'x', score real check (score between 0 and 10))` | gated | rows equal both oracles; table-level `UNIQUE (a, b)` clauses also build `sqlite_autoindex_<table>_<n>` in written order with `origin = 'u'`, reject duplicate non-NULL keys, let every `NULL` key coexist, and survive a reopen while better-sqlite3 reports `integrity_check = ok`; `table-level UNIQUE constraints own automatic indexes in written order` |
| `CREATE INDEX` plain / composite / ASC / UNIQUE / IF NOT EXISTS | `create index pix on pi (a)` | gated | covered by `create index accepts ascending, composite, unique and if not exists forms` |
| `ALTER TABLE ... RENAME TO` / `RENAME COLUMN` | `alter table r1 rename to r2` | gated | rows equal both oracles |
| `ALTER TABLE ... ADD COLUMN` | `alter table ac add column b integer not null default 5` | gated | rows equal both oracles |
| `DROP TABLE` / `DROP INDEX` | `drop table t` | gated | covered by the engine gate |
| `CREATE TABLE ... WITHOUT ROWID` | `create table wr (a text primary key, b integer) without rowid` | gated | rows live in the primary-key index b-tree rooted at the schema `rootpage` (page types 10/2), key columns lead every stored record even when declared later, and no hidden `rowid` exists; a missing or duplicated key is rejected; better-sqlite3 opens the file, reports `integrity_check = ok` and inserts further rows into the tree; `without rowid tables are their own primary key b-tree` |
| `CREATE TABLE ... STRICT` | `create table st (a integer) strict` | gated | affinity runs first, then a value whose storage class differs from the declared type fails with `constraint-datatype`; invalid declared types fail with `unknown-datatype`; `strict tables enforce declared storage classes like better-sqlite3` |
| `CREATE TEMP TABLE` / `sqlite_temp_master` | `create temp table tp (a integer)` | gated | lives in its own schema that shadows an equally named main table, reports `type/name/tbl_name/rootpage/sql` from `sqlite_temp_master`, reuses freed root pages, removes the temp object first on `DROP TABLE`, and disappears with the connection; `temp tables shadow main and vanish with the connection like better-sqlite3` |
| `CREATE TABLE ... AS SELECT` | `create table dst as select a from src where a > 1` | gated | the query runs before the table exists, output labels become declared names (duplicates numbered `:1`, `:2`), a bare source column copies its affinity as `INT` / `TEXT` / `REAL` / `NUM` while expressions get no type, `CREATE TABLE ... AS` stores the generated compact definition, and the statement reports `affected = 0`; `create table as select derives declared types and rows like better-sqlite3` |
| Partial index (`... WHERE`) | `create index pix on pi (a) where a > 1` | gated | only rows satisfying the predicate enter the index b-tree, the membership is recomputed on every write so an update that fails the predicate removes the entry, a `UNIQUE ... WHERE` still rejects duplicates among covered rows, and better-sqlite3 opens the file with `integrity_check = ok`, answers a query through the partial index and keeps it consistent after its own insert; `expression and partial indexes maintain their own keys` |
| Expression index | `create index eix on ei (a + 1)` or `lower(name)` | gated | the engine evaluates each key term per row and hands the exact key/rowid pairs to the writer, a plain index keeps its column-derived keys, updates change the stored key, and better-sqlite3 opens the file with `integrity_check = ok` and answers an expression-indexed query; `expression and partial indexes maintain their own keys` |
| Index `COLLATE` | `create index cix on ci (s collate nocase)` | missing | `unsupported-clause` `COLLATE`: this engine compares keys with binary order, so a collated key would sort differently from better-sqlite3 and corrupt the tree; the gate pins this rejection |
| `CREATE VIEW` | `create view vv as select a from vt where a > 1` | gated | re-runs the stored query on every read, keeps `CREATE VIEW <name>` plus the verbatim rest in `sqlite_master.sql`, rejects writes and indexes with `readonly-view`, and survives a reopen; `views re-run their query and keep catalog rows like better-sqlite3` |
| View output naming | `create view e as select a + 1, a from t` | gated | unaliased expressions keep their exact source span (`a + 1`, `1.50`, `cast(a as text)`, `'x'`), a bare column reports the schema spelling (`select A` → `a`), and repeated names are suffixed `:1`, `:2` in views, derived tables and CTEs; `view output names follow better-sqlite3 for spans, aliases and duplicates` |
| Declared view column list arity | `create view short(x) as select a, b from t` | gated | creation succeeds and any read reports `expected 1 columns for 'short' but got 2`, repeated declared names are de-duplicated, and matching lists rename the output; `declared view column lists report oracle arity diagnostics` |
| View object namespace and `DROP VIEW` diagnostics | `drop view t` where `t` is a table | gated | views share the namespace with tables and indexes (`table t already exists`, `there is already an index named ix`, `view v already exists`), `DROP VIEW` reports `use DROP TABLE to delete table t` and `no such view: ix`, and `IF EXISTS` only silences missing views; `view namespace conflicts and DROP VIEW diagnostics follow better-sqlite3` |
| `ALTER TABLE RENAME` rewrites view text | `alter table t rename to t2` with `create view vq as select t.a from t` | gated | the stored query becomes `select "t2".a from "t2"` and still resolves after the rename, column renames rewrite every column reference while `expr AS alias` output names stay untouched; `ALTER TABLE renames rewrite stored view definitions like better-sqlite3` |
| `CREATE TEMP VIEW` / `sqlite_temp_master` | `create temp view v as select 2 as a` | gated | the temp view shadows a main namesake, appears in `sqlite_temp_master` with rootpage zero, unqualified `DROP VIEW` removes the temp one first, and the definition disappears with the connection; `temp views shadow main views and vanish with the engine like better-sqlite3` |
| `CREATE TRIGGER` `BEFORE` / `AFTER` timings | `create trigger bi before insert on t begin insert into log values (new.a); end` | gated | each row queues a `BEFORE` and an `AFTER` event so the observable order is `B1 A1 B2 A2`, same-event triggers fire newest first, `BEFORE` sees the defaulted row with `rowid = -1`, `AFTER` sees the stored rowid, and `UPDATE OF <cols>` only fires for the assigned columns; `trigger timings, WHEN clauses, order and rollback follow better-sqlite3` |
| `WHEN` clause and `NEW` / `OLD` references | `create trigger au after update on t when old.a > 5 begin insert into log values (new.a); end` | gated | `WHEN` filters per row, `new.x` / `old.x` resolve with and without a qualifier, a missing side reports `no such column: old.a` / `new.a`, and an unknown column reports `no such column: new.zzz`; same gate plus `trigger_when_clause_filters_rows` |
| `INSTEAD OF` triggers on views | `create trigger vi instead of insert on v begin insert into base (id, a) values (new.id, new.a); end` | gated | body runs on view DML, the outer statement reports `affected = 0` and `changes = 0`, `last_insert_rowid` is restored, the view still reads the base table, and plain view DML stays `cannot modify v because it is a view`; `INSTEAD OF triggers on views follow better-sqlite3` |
| Trigger failure rollback and creation diagnostics | `create trigger bad after insert on f begin insert into flog values (new.zzz); end` | gated | a failing body rolls back the entire statement including earlier rows, duplicate names report `trigger d already exists`, a missing target reports `no such table: main.missing`, `AFTER` / `BEFORE` on a view and `INSTEAD OF` on a table report the matching `cannot create ... trigger on ...` message, and a bare timing reports `near "on": syntax error`; `trigger creation, drop and runtime diagnostics match better-sqlite3` |
| Temp triggers and `DROP TRIGGER` | `create trigger temp.xt after insert on tp begin select 1; end` | gated | a temp or temp-table trigger lands in `sqlite_temp_master` with the text minus the `temp.` prefix, `DROP TABLE` removes its triggers, `DROP TRIGGER` searches triggers only (`no such trigger: t` for a table name), and `IF EXISTS` is a no-op; `temp triggers appear in sqlite_temp_master and fire like better-sqlite3` |
| Foreign key, column level `REFERENCES` | `create table fk2 (id integer primary key, pid integer references fk1 (id))` | gated | orphan insert, parent delete and parent update all fail with `SQLITE_CONSTRAINT_FOREIGNKEY` |
| Foreign key, table level `FOREIGN KEY` with an implicit parent primary key | `create table fk4 (..., foreign key (pid) references fk3 (id))` | gated | composite orphan and composite rollback covered by `composite foreign keys and statement rollback match better-sqlite3` |
| `ON DELETE CASCADE` / `ON UPDATE CASCADE` | `create table c1 (pid integer references parent (id) on delete cascade)` | gated | parent deletes remove the child rows, parent key rewrites move them through every cascade level, composite keys move both columns, a self-referencing table walks the whole subtree, the statement reports only the directly removed parent rows, and child `BEFORE` / `AFTER` triggers fire between the parent events in oracle order; `referential actions cascade, set null and set default like better-sqlite3` |
| `ON DELETE SET NULL` / `ON UPDATE SET NULL` / `SET DEFAULT` | `create table c2 (pid integer references parent (id) on update set null)` | gated | the child key becomes `NULL` or its declared default on both parent deletes and rewrites, a `NOT NULL` child aborts with `NOT NULL constraint failed: <table>.<column>` and rolls the whole statement back, a default that names no parent fails with `FOREIGN KEY constraint failed`, and the rewrites keep better-sqlite3 `integrity_check = ok` after a reopen; same gate |
| `DEFERRABLE INITIALLY DEFERRED` | `create table c3 (pid integer references parent (id) deferrable initially deferred)` | missing | `unsupported-deferred-foreign-key` with clause `DEFERRABLE`; `deferred foreign keys stay rejected` |
| `ALTER TABLE ... ADD COLUMN ... REFERENCES` | `alter table plain add column pid integer references parent (id)` | gated | appends the definition verbatim, refuses a non-NULL default, keeps existing rows at NULL, and checks the parent on later inserts; `add column with REFERENCES enforces the parent like better-sqlite3` |
| `ALTER TABLE ... DROP COLUMN` | `alter table dc drop column b` | gated | removes the definition and its value slot from every row, rewrites `sqlite_master.sql` byte for byte (inline constraints go with the column), and refuses PK / UNIQUE / indexed / view / trigger / table-check / table-FK readers exactly where `better-sqlite3` refuses them; `drop column rewrites rows and stored schema like better-sqlite3` |

## DML

| Feature | Probe | Status | Evidence |
|---------|-------|--------|----------|
| `INSERT` with several `VALUES` tuples and a column subset | `insert into im (v) values ('a'), ('b') returning id, v` | gated | rows equal both oracles |
| Positional `?` placeholders in `INSERT ... VALUES` and `WHERE` | `insert into p (name, score) values (?, ?)` | gated | `bound parameters fill placeholders on insert and select` compares rows and `affected` with `better-sqlite3` |
| `INSERT ... DEFAULT VALUES` | `insert into idv default values returning a, b, c` | gated | rows equal both oracles |
| `INSERT ... RETURNING` (single row) | `insert into ir (v) values ('a') returning id, v` | gated | covered by `returning reports new values for update and old values for delete` |
| `UPDATE` assignments / `WHERE` / ascending row order / constraint rollback | `update t set v = v + 1 where id >= 2 returning id, v` | gated | covered by the update gate |
| `UPDATE ... RETURNING` (including `*`) | `update t set v = v where id = 1 returning *` | gated | covered by the update gate |
| `DELETE ... RETURNING` | `delete from dr where id = 2 returning id, v` | gated | rows equal both oracles |
| Multi-row `INSERT ... RETURNING` | `insert into mr (v) values ('a'), ('b') returning id, v` | gated | oracle-matching with both oracles |
| `DELETE FROM ... AS alias` | `delete from da as x where x.a = 2 returning a` | gated | oracle-matching with both oracles |
| `INSERT ... SELECT` | `insert into is2 (a) select a from is1 where a > 1` | gated | the query is evaluated before any row is written, so a self-referencing insert reads the original rows and then hits the primary key; a column subset follows the `VALUES` mapping, arity errors report `table t has N columns but M values were supplied` / `N values for M columns`, and `ON CONFLICT` / `RETURNING` trail the query; `insert select and replace follow better-sqlite3` |
| `INSERT OR REPLACE` | `insert or replace into orr values (1,'b')` | gated | every stored row that conflicts on any unique key (including a rowid alias) is deleted before the new row is written, so one row can displace several; the message wording and statement-level rollback on a later `NOT NULL` failure match better-sqlite3; `insert select and replace follow better-sqlite3` |
| `INSERT OR IGNORE` | `insert or ignore into orr values (1,'b')` | missing | `unsupported-clause` `OR` |
| UPSERT `ON CONFLICT DO NOTHING` / `DO UPDATE` | `insert into up values (1, 20) on conflict (id) do update set v = excluded.v` | gated | targets match a rowid alias, a column key, a table-level `UNIQUE`, or a partial unique index whose `WHERE` text equals the target's, `excluded.<column>` reads the supplied tuple while a bare column reads the stored row, a false `DO UPDATE ... WHERE` leaves the row alone, a target naming no uniqueness constraint reports `ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint` (including a partial-index table addressed without `WHERE` or with a different predicate), `excluded` in the target predicate reports `no such column: excluded.a` while `p.a` resolves, a supplied row outside the partial predicate inserts even when the target names that index, a full and partial index on the same column resolve through the one the target's `WHERE` selects, two same-column partial indexes resolve only the selected one while a row violating the other still aborts with `UNIQUE constraint failed: r.a`, skipped rows report `affected = 0` and no `RETURNING` row, rewritten rows survive a reopen and better-sqlite3 `integrity_check = ok`, a `DO UPDATE` rewrite fires `BEFORE INSERT` / `BEFORE UPDATE` / `AFTER UPDATE` with the rewritten values while `WHEN` and `UPDATE OF` follow the assignment list, and parent-side and child-side reference failures match `SQLITE_CONSTRAINT_FOREIGNKEY`; `upsert DO NOTHING and DO UPDATE follow better-sqlite3`, `upsert targets partial unique indexes by their predicate like better-sqlite3`, `upsert DO UPDATE fires update triggers like better-sqlite3`, `upsert DO UPDATE runs foreign key checks like better-sqlite3` |
| `REPLACE INTO` | `replace into rp values (1,'b')` | gated | same conflict-resolution path as `INSERT OR REPLACE`, also accepting a `SELECT` source; `DELETE` triggers stay silent unless `recursive_triggers` is on, foreign-key `ON DELETE` actions still run, and an insert that then violates `NOT NULL` rolls the whole statement back; `replace only fires delete triggers with recursive_triggers and applies foreign keys` |
| Expression inside a `VALUES` tuple | `insert into ie values (1 + 1)` | missing | `syntax`: `VALUES` tuple only accepts literals |
| `UPDATE ... FROM` | `update ua set v = ub.w from ub where ua.id = ub.id` | missing | `unsupported-clause` after `UPDATE` |
| Row-value assignment `SET (a, b) = (...)` | `update rv set (a, b) = (1, 2)` | missing | `unsupported-clause` (deliberate rejection) |

## Expressions, type affinity and NULL semantics

| Feature | Probe | Status | Evidence |
|---------|-------|--------|----------|
| Arithmetic, precedence, `||`, unary minus | `select 1 + 2 * 3, 10 - 2 - 3` | gated | rows equal both oracles |
| Bitwise `&` `|` `~` `<<` `>>` | `select ~5, 5 & 3, 5 | 2, 5 << 1, -8 >> 1` | gated | covered by `bitwise and inspection functions follow sqlite` |
| Decimal/exponent literals | `select 1e3` | gated | covered by `cast follows sqlite conversions` |
| `LIKE ... ESCAPE` | `select 'a_b' like 'a!_b' escape '!'` | gated | covered by `like follows sqlite wildcard and case rules` |
| `CAST` to INTEGER/REAL/TEXT/BLOB/NUMERIC | `select cast('12abc' as integer), cast(1.9 as integer)` | gated | covered by `cast follows sqlite conversions` |
| `ORDER BY` expression / ordinal / alias semantics | `select a+b from v order by a+b desc` | gated | covered by `ORDER BY reuses the evaluator and accepts output ordinals` |
| `HAVING` over an aggregate | `select a, count(*) from hv group by a having count(*) > 1` | gated | rows equal both oracles |
| Three-valued NULL logic | `select 2 between 1 and 2, null = null, null is null` | gated | `three-valued-logic.test.ts` |
| Subqueries / `EXISTS` / `IN (SELECT ...)` / correlated | `select a from t where a in (select x from c)` | gated | `sql-expression.test.ts` |
| Join variants (`USING`, `NATURAL`, `LEFT`, `FULL`, `RIGHT`) | `select * from l join r using (k)` | gated | `sql-engine.test.ts` |
| Set operators (`UNION`/`INTERSECT`/`EXCEPT`) | `select 1 union select 2` | gated | `sql-engine.test.ts` |
| Non-recursive CTE | `with c(x, y) as (select a, b + 10 from t) select x, y from c order by x` | gated | `sql-engine.test.ts` |
| Column affinity applied on insert | `insert into af values ('12', '1.5', '3.0', 5)` | gated | covered by `bracketed column types keep SQLite affinity` |
| Storage-class comparison (`'10' < 9`) and mixed `ORDER BY` | `select typeof(v) from mt order by v` | gated | oracle-matching with both oracles |
| Hex integer literal | `select 0x1f` | gated | oracle-matching with both oracles |
| `TRUE` / `FALSE` literals | `select true, false, true = 1, false = 0` | gated | oracle-matching with both oracles |
| `BETWEEN` / `NOT BETWEEN` with NULL | `select 2 between 1 and 3, null between 1 and 2` | gated | oracle-matching with both oracles |
| `ORDER BY` an output alias | `select a as x from ob2 order by x desc` | gated | oracle-matching with both oracles |
| `GROUP BY` an expression | `select a + 1 as k, count(*) from gb group by a + 1 order by k` | gated | oracle-matching with both oracles |
| Modulo `%` | `select 7 % 3, -7 % 3, 7.5 % 2, 7 % 2.5, 5 % 0` | gated | truncates both operands to integers, keeps the dividend's sign, returns a real when either operand was real, `NULL` for a zero divisor; `instr, round and modulo follow the oracle exactly` |
| `GLOB` / `NOT GLOB` | `select 'abc' glob 'a*'` | gated | case sensitive, `*` matches any run, `?` exactly one character, `[a-c]` is a range, `^` negates a class, a leading `]` is a member, an unclosed `[` never matches, numbers are compared as text, a blob operand never matches and `NULL` propagates; `glob follows sqlite class and case rules` |
| `COLLATE` (column, expression, `ORDER BY`) | `select 'a' = 'A' collate nocase` | missing | `unsupported-column-constraint` `COLLATE`; expression form is `syntax` |
| `IS DISTINCT FROM` / `IS NOT DISTINCT FROM` | `select 1 is distinct from 2` | gated | `NULL` is an ordinary value (`NULL` versus `NULL` is not distinct, `NULL` versus anything else is), non-null operands keep the storage-class ordering so `1` and `1.0` are equal while `1` and `'1'` are not, and `AND` binds looser; `is distinct from treats null as a value like better-sqlite3` |
| `ORDER BY ... NULLS FIRST/LAST` | `select a from onf order by a asc nulls first` | gated | each key carries its own placement, the default keeps `NULL` below every value (first for `ASC`, last for `DESC`), the placement also drives the sort order a window frame reads; `order by nulls first and last override the default placement` |
| `SELECT DISTINCT` | `select distinct a from sd order by a` | gated | collapses duplicates before `ORDER BY` and `LIMIT`; `select distinct collapses duplicates before order by and limit` |
| Self-referencing `WITH RECURSIVE` (keyword optional), `UNION ALL` duplicates, `UNION` fixed-point de-duplication, outer `LIMIT` truncation | `with c(x) as (select 1 union all select x + 1 from c where x < 3) select x from c` | gated | six oracle-backed shapes in `recursive CTEs match better-sqlite3 without and with the keyword` |

## Scalar and aggregate functions

| Feature | Probe | Status | Evidence |
|---------|-------|--------|----------|
| `abs`, `coalesce`, `length`, `lower`, `upper`, `substr`, `round`, `typeof`, `hex`, `quote`, `random`, `randomblob` | `select hex('abc'), quote('a''b'), quote(null), quote(1.5)` | gated | `sql-expression.test.ts`, `bitwise and inspection functions follow sqlite` |
| `group_concat` with a custom separator and NULL skipping | `select group_concat(v, '|') from ag` | gated | `bitwise and inspection functions follow sqlite` |
| `count` / `avg` / `sum` / `total` / `min` / `max` | `select avg(v), sum(v), total(v), min(v), max(v), count(v) from ae` | gated | `whole-result aggregates cover count, avg, sum, min and max` |
| `substr` bounds (`0`, `-n`, past end) | `select substr('abcdef', 0, 2), substr('abcdef', 2, 99)` | gated | oracle-matching with both oracles |
| `round` tie behaviour (`±2.5`) | `select round(2.5), round(-2.5)` | gated | oracle-matching with both oracles |
| Aggregates over an empty table | `select avg(v), min(v), max(v), count(v) from empty` | gated | oracle-matching with both oracles |
| `group_concat ... ORDER BY` | `select group_concat(v, '|' order by v) from ago` | gated | the argument list carries its own `ORDER BY`, `group_concat(DISTINCT v)` sorts by value before joining and rejects a separator (`DISTINCT aggregates must have exactly one argument`), and `count(DISTINCT v, w)` reports `wrong number of arguments to function count()`; `aggregate filter, distinct and argument order follow better-sqlite3` |
| `count(DISTINCT x)` | `select count(distinct v) from cd` | gated | `DISTINCT` de-duplicates by value with `NULL` counted once, `count` then ignores `NULL`, and every `sum` / `avg` / `total` / `count` form accepts it; same gate |
| Aggregate `FILTER (WHERE ...)` | `select sum(v) filter (where v > 1) from afi` | gated | the filter runs before the aggregate sees a row, so an empty input reports `count = 0` and `sum` / `group_concat` `NULL`, it composes with `DISTINCT` and works on window aggregates, while `DISTINCT` and argument `ORDER BY` on a window aggregate are rejected with SQLite's wording; same gate |
| Multi-argument `min()` / `max()` | `select min(3, 1, 2), max(3, 1, 2)` | gated | 门禁 `multi-argument min and max follow the oracle tie rules`：两个及以上参数走标量路径，单参数仍是聚合；任一参数为 `NULL` 返回 `NULL`；打平时 `min` 取后一个、`max` 保留前一个，因此 `typeof(min(1, 1.0))` 是 `real` 而 `typeof(max(1, 1.0))` 是 `integer` |
| `trim` / `ltrim` / `rtrim` | `select trim('  x  '), ltrim('  x'), rtrim('x  ')` | gated | `trim, replace, ifnull, nullif follow the oracle exactly`: 第二个参数是按字符集合裁剪，缺省只裁剪空格，空集合原样返回，`NULL` 传播，非文本先转文本 |
| `instr` | `select instr('abcabc', 'bc'), instr('abc', 'z'), instr('abc', '')` | gated | `instr, round and modulo follow the oracle exactly` |
| `replace` | `select replace('abcabc', 'b', 'X')` | gated | 同一门禁：空模式原样返回，任一参数为 `NULL` 时返回 `NULL`，数字与 blob 先转文本 |
| `ifnull` / `nullif` | `select ifnull(null, 7), nullif(1, 1)` | gated | 同一门禁：`nullif` 复用 `=` 的比较语义，数字之间相等即返回 `NULL`，文本与数字不相等 |
| `printf` / `format` / `char` / `unicode` / `soundex` | `select printf('%d', 7)` | gated | 门禁 `printf, char, unicode and soundex follow the oracle exactly`：`%d/%i/%u/%x/%X/%o` 含 `#` 前缀与零填充，`%f/%e/%g` 按十进制四舍五入且 `%.0e` 不带小数点，`%c` 取文本首字符且精度表示重复次数，`%q/%Q/%w` 先按精度截断再转义，`%p` 是大写十六进制，`%n` 不消费参数，`%z` 把 `NULL` 变空串，未知转换终止解析且空输出返回 `NULL`；`char` 越界码点变 U+FFFD，`unicode('')` 为 `NULL`，`soundex` 按 SQLite 分组补零
| Math functions (`sqrt`, `power`, `floor`, `ceil`, `log`, ...) | `select sqrt(9), power(2, 10), floor(2.7), ceil(2.1)` | gated | 门禁 `math scalars follow the oracle exactly`：`abs` 文本入参恒为实数、整数取整保持整数，文本套用 numeric affinity 且整段必须可解析（`'2abc'` 为 `NULL`），`NaN` 记 `NULL` 而无穷保留实数，`ln`/`log` 的非正入参与底数不大于 1 返回 `NULL`，`sign` 恒为整数 |
| Date/time functions (`date`, `time`, `datetime`, `julianday`, `unixepoch`, `strftime`, `timediff`) | `select date('2024-01-02 03:04:05'), strftime('%Y', '2024-01-02')` | gated | 门禁 `date, time and strftime follow the oracle exactly`：日期/时间/时区解析与 `24:00:00`、非法日历日规范化，`start of`、`weekday`、月年进位与小数折算，时区修饰符按 24 小时取模，`unixepoch`/`julianday`/`auto` 入参解释，`strftime` 全部指令（含 ISO 周与星期日/星期一两种周口径），以及 `timediff` 的借位分解 |
| JSON functions (`json_extract`, `json_array`, `json_object`, `json_valid`, ...) and `->` / `->>` | `select json_extract('{"a":1}', '$.a'), json_array(1, 2)` | missing | `unknown-function`: `json_extract` |

## Window functions

| Feature | Probe | Status | Evidence |
|---------|-------|--------|----------|
| `row_number` / `rank` / `dense_rank`, `sum() OVER`, partitions, named windows, empty input | `select g, a, sum(a) over (partition by g order by a) from w` | gated | `window functions match better-sqlite3 across partitions and frames` |
| `percent_rank` / `cume_dist` / `ntile` | `select percent_rank() over (order by a), cume_dist() over (order by a), ntile(2) over (order by a) from w` | gated | oracle-matching with both oracles |
| `lag` / `lead` with offset and default | `select a, lag(a, 1, 99) over (order by a), lead(a, 1, -1) over (order by a) from w` | gated | oracle-matching with both oracles |
| `first_value` / `last_value` / `nth_value` | `select first_value(a) over (order by a), nth_value(a, 2) over (order by a) from w` | gated | oracle-matching with both oracles |
| `ROWS` frame with numeric offsets | `select sum(a) over (order by a rows between 1 preceding and 1 following) from w` | gated | oracle-matching with both oracles |
| `RANGE` frame with numeric offsets | `select sum(a) over (order by a range between 1 preceding and 1 following) from w` | gated | oracle-matching with both oracles; an unbounded edge remains position-based, so it spans rows whose key has no numeric form (`NULL` included from the partition start) |
| Aggregate over the whole result / `group_concat` as a window aggregate | `select count(*) over (), sum(a) over () from w` | gated | oracle-matching with both oracles |
| `GROUPS` frame unit | `select sum(a) over (order by a groups between 1 preceding and current row) from w` | gated | peer groups instead of rows bound the frame, `CURRENT ROW` spans the whole peer group, an edge beyond either end yields an empty frame, and `GROUPS` works without an `ORDER BY`; `window groups frames and exclude clauses follow better-sqlite3` |
| Frame `EXCLUDE` clause | `select sum(a) over (order by a rows between 1 preceding and 1 following exclude ties) from w` | gated | `NO OTHERS` / `CURRENT ROW` / `GROUP` / `TIES` drop rows from the computed frame for aggregates and `first_value` / `last_value` / `nth_value`, and `EXCLUDE` is accepted only after a frame unit like SQLite's grammar; same gate |

## Transactions and savepoints

| Feature | Probe | Status | Evidence |
|---------|-------|--------|----------|
| Single-statement atomicity and constraint-failure rollback | `update t set v = v - 10` | gated | `update rolls back every row when a constraint fails` |
| Snapshot import/export as the durability path | `engine.snapshot()` written and reopened by `better-sqlite3` | gated | storage and platform suites |
| `BEGIN [DEFERRED|IMMEDIATE|EXCLUSIVE]` | `begin immediate` | gated | `explicit transactions roll back rows and schema exactly as better-sqlite3`; a nested `BEGIN` reports `transaction-active` |
| `COMMIT` / `END` / `ROLLBACK` | `commit` | gated | same gate; committing or rolling back outside a transaction reports `transaction-missing` with SQLite's message |
| `SAVEPOINT` / `RELEASE` / `ROLLBACK TO` | `savepoint sp1` | gated | same gate covers `ROLLBACK TO`, `RELEASE`, name lookup (case insensitive) and the missing-savepoint error |

## Engine surface

| Feature | Probe | Status | Evidence |
|---------|-------|--------|----------|
| `Engine::from_writer` / `createEngineFromSnapshot` reopens a main-file image with its catalog | `Engine::from_writer(SqliteWriter::from_pages(bytes))` | gated | `fromSnapshot reopens an image with its catalog and rejects a broken header` (also `SqliteWriter::from_pages`) |
| `last_insert_rowid` across commits, rollbacks and reopen | `engine.lastInsertRowid()` | gated | `explicit transactions roll back rows and schema exactly as better-sqlite3` and the bound-parameter gate compare it with SQLite |

## PRAGMA

| Feature | Probe | Status | Evidence |
|---------|-------|--------|----------|
| `PRAGMA foreign_keys` read-back and session toggle | `pragma foreign_keys` / `pragma foreign_keys = off` | gated | defaults to `1`, reads back `0` after `off`; enforcement behaviour asserted |
| `PRAGMA recursive_triggers` re-entry switch | `pragma recursive_triggers` / `pragma recursive_triggers = on` | gated | defaults to `0` and reads back the session value, a running trigger is skipped while other tables still fire, and a loop with the pragma on stops at `too many levels of trigger recursion` and rolls the statement back; `recursive_triggers_pragma_allows_loops_until_the_depth_limit` plus `recursive_triggers pragma switches re-entry like better-sqlite3` |
| `PRAGMA database_list` | `pragma database_list` | gated | reports `seq/name/file` for `main`, `temp` once it exists, then each attached schema in attach order with its absolute file path; `attach, qualified names and detach follow better-sqlite3` |
| `PRAGMA table_info` / `table_xinfo` | `pragma table_info(a)` | gated | `cid/name/type/notnull/dflt_value/pk` plus `hidden` for `table_xinfo`, the four storage-class type names upper-cased and every other declared type echoed as written, composite keys numbered `1..n`, the written `DEFAULT` text (`1.50` stays `1.50`), temp tables included and unknown names returning an empty row set; `table, index and foreign key pragmas follow better-sqlite3` |
| `PRAGMA index_list` / `index_info` | `pragma index_list(a)` / `pragma index_info(sqlite_autoindex_p2_1)` | gated | explicit indexes newest first then each automatic constraint index in reverse numbering order, `origin` set to `c` / `pk` / `u`, `partial` always `0`, and `index_info` reporting `seqno/cid/name` in key order; `table, index and foreign key pragmas follow better-sqlite3` |
| `PRAGMA foreign_key_list` | `pragma foreign_key_list(fk)` | gated | `id/seq/table/from/to/on_update/on_delete/match`, newest key first (`foreign key (b, c)` before the earlier column `REFERENCES`), an implicit parent key reported as `NULL` in `to`, and actions spelled `NO ACTION` / `RESTRICT`; `table, index and foreign key pragmas follow better-sqlite3` |
| `PRAGMA user_version` / `application_id` | `pragma user_version = 7` | gated | both read back as a single integer row defaulting to `0`, write header bytes 60 and 68, and survive a reopen of the snapshot; `user_version and application_id round-trip through the header` |
| `PRAGMA integrity_check` | `pragma integrity_check` | missing | `unsupported-pragma` at `PRAGMA` (the gate only calls it on external files) |

## EXPLAIN

| Feature | Probe | Status | Evidence |
|---------|-------|--------|----------|
| `EXPLAIN <select>` | `explain select a from ex where a = 1` | missing | `unsupported-statement` at `explain` |
| `EXPLAIN QUERY PLAN <select>` | `explain query plan select a from eq where a = 1` | missing | `unsupported-statement` at `explain` |

## Attached databases and export

| Feature | Probe | Status | Evidence |
|---------|-------|--------|----------|
| `snapshot()` byte export | `engine.snapshot()` | gated | storage and platform suites |
| `ATTACH DATABASE` | `attach database ':memory:' as aux` | gated | accepts `:memory:` / `''` and file paths, creates a missing file empty and materializes it on the first write, opens an existing image with its catalog, caps at ten attached databases, and resolves `aux.tbl`, `main.tbl`, `temp.tbl`, cross-schema joins, unqualified fall-through and triggers through the owning schema; `attach, qualified names and detach follow better-sqlite3` plus `attached_databases_resolve_qualified_names_and_list_themselves`, `main_and_temp_qualifiers_pin_the_schema`, `attached_files_are_created_and_keep_their_rows_across_reattach` |
| `DETACH DATABASE` | `detach database aux` | gated | flushes the attached image, removes the schema, refuses `main` / `temp` with `cannot detach database <name>` and an unknown name with `no such database: <name>`; same gates |
| `VACUUM` / `VACUUM INTO` | `vacuum` | missing | `unsupported-statement` at `vacuum` |

## Unimplemented: top 2 by impact

Ranked by how many ordinary SQLite clients would break on the first statement they send. Date/time and math
functions, `trim`, `replace`, `ifnull`, `nullif`, `printf`, multi-argument `min` / `max`, foreign keys,
recursive CTEs, transaction control, `SELECT DISTINCT`, modulo, `instr`, `CREATE TABLE ... AS SELECT`,
`INSERT ... SELECT`, `REPLACE`, `IS DISTINCT FROM`, `GLOB`, `NULLS FIRST|LAST`, aggregate `FILTER` / `DISTINCT` /
argument `ORDER BY` and window `GROUPS` / `EXCLUDE` are no longer on this list: all landed at this pin and are
asserted by the gate.

| # | Gap | Impact | Upstream coordinates |
|---|-----|--------|---------------------|
| 1 | `COLLATE` (column, expression, `ORDER BY`) | Case-insensitive comparisons and sorted output | `sql.rs`, no collation hook in the key comparators |
| 2 | JSON functions and `->` / `->>` | Structured payloads stored as text | `sql.rs:333-357` (`ScalarFunction`), `BinaryOp` |

Next tier, lower blast radius but still visible: `PRAGMA integrity_check`, `EXPLAIN`, `VACUUM`,
`INSERT OR IGNORE`, `UPDATE ... FROM`, row-value assignment and expression tuples inside `VALUES`.

## Landed at this pin

| Gap | Upstream coordinates | Gate |
|-----|---------------------|------|
| Explicit transactions: `BEGIN` / `COMMIT` / `END` / `ROLLBACK`, nested scopes, catalog reload after rollback | `sql.rs:2787-2875` (`statement()`), `sql.rs:2877-2920` (transaction parsing), `engine.rs:640-735` (transaction execution), `database.storage/src/sqlite/writer.rs:196-260` (snapshot stack) | `explicit transactions roll back rows and schema exactly as better-sqlite3` |
| `SAVEPOINT` / `RELEASE` / `ROLLBACK TO` including names, case-insensitive lookup and missing-savepoint errors | same coordinates | same gate |
| `SELECT DISTINCT` collapsed before `ORDER BY` and `LIMIT` | `sql.rs:3846-3860` (`select_core`), `engine.rs:1300-1330`, `engine.rs:1810-1860` | `select distinct collapses duplicates before order by and limit` |
| Modulo `%` with integer truncation, real promotion, sign and zero-divisor rules | `sql.rs:287-300` (`BinaryOp`), `sql.rs:2195-2230` (`multiplicative_expr`), `engine.rs:5455-5470` | `instr, round and modulo follow the oracle exactly` |
| `instr` (substring position, empty needle `1`, missing needle `0`, case sensitive) | `sql.rs:333-357`, `engine.rs:5640` | `instr, round and modulo follow the oracle exactly` |
| `round` at ties and negative precision, through the stored double like SQLite | `engine.rs:5510-5545` (`round_cell`) | `rounding matches both oracles at ties and negative precision` |
| Positional `?` placeholders in `INSERT ... VALUES` and `WHERE` | `engine.rs:520-545` (`execute_with_parameters`), `sql.rs:3554-3591` (`insert_value`) | `bound parameters fill placeholders on insert and select` |
| `Engine::from_writer` plus `SqliteWriter::from_pages` for byte images | `engine.rs:355`, `database.storage/src/sqlite/writer.rs:186-215` | `fromSnapshot reopens an image with its catalog and rejects a broken header` |
| `last_insert_rowid` tracked per connection and untouched by rollback | `engine.rs:598`, `engine.rs:620` | transaction and bound-parameter gates |
| `STRICT` table option: declared types limited to `INT` / `INTEGER` / `REAL` / `TEXT` / `BLOB` / `ANY`, affinity applied before the storage-class check, `constraint-datatype` on violation | `sql.rs:3146-3157` (table options), `engine.rs:500-521` (`catalog_table`), `engine.rs:749-760` (insert guard), `engine.rs:956-964` (update guard), `engine.rs:6134` (`strict_value_violation`) | `strict tables enforce declared storage classes like better-sqlite3` |
| Foreign keys (column/table `REFERENCES`, `PRAGMA foreign_keys`, orphan/delete/update checks, composite keys, statement rollback, `ON DELETE` / `ON UPDATE` cascade, set null, set default and child-table triggers) | `sql.rs:2943-2962`, `sql.rs:3098-3110`, `engine.rs:403`, `engine.rs` (`apply_foreign_key_actions`) | `foreign keys enforce orphan, delete and update checks per session pragma`, `composite foreign keys and statement rollback match better-sqlite3`, `referential actions cascade, set null and set default like better-sqlite3` |
| `ALTER TABLE ... ADD COLUMN ... REFERENCES`: non-NULL defaults refused, existing rows stay NULL, later inserts check the parent | `sql.rs:1473` (`AlterAction::AddColumn`), `engine.rs:1370-1411` | `add column with REFERENCES enforces the parent like better-sqlite3` |
| Canonical `CREATE TABLE` / `CREATE INDEX` / `CREATE VIEW` prefix in `sqlite_master.sql` (verbatim tail, `IF NOT EXISTS` dropped) | `sql.rs:3279-3291` (`canonical_create_sql`) | `sqlite_master lists schema objects in creation order and stays read-only`, view gate |
| Self-referencing recursive CTE (keyword optional, `UNION ALL` duplicates, `UNION` fixed-point de-duplication, outer `LIMIT` truncation) | `engine.rs:2229` | `recursive CTEs match better-sqlite3 without and with the keyword` |
| UPSERT `ON CONFLICT DO NOTHING` / `DO UPDATE` with `excluded` columns, column and constraint targets, `RETURNING` and per-statement row visibility | `sql.rs` (`conflict_clause`), `engine.rs` (`prepare_upsert`, `apply_upsert`) | `upsert DO NOTHING and DO UPDATE follow better-sqlite3` |
| `IS DISTINCT FROM` / `GLOB` / `ORDER BY ... NULLS FIRST` / `NULLS LAST` | `sql.rs` (`comparison_expr`, `order_key`), `engine.rs` (`glob_match`, `SortDirection`) | `is distinct from treats null as a value like better-sqlite3`, `glob follows sqlite class and case rules`, `order by nulls first and last override the default placement` |
| Aggregate `FILTER` / `DISTINCT` / argument `ORDER BY`, window `GROUPS` frames and `EXCLUDE` clauses | `sql.rs` (`function_expr`, `window_function`, `frame`), `engine.rs` (`compute_aggregate`, `shape_aggregate_inputs`, `evaluate_frame_aggregate`, `groups_edge`, `frame_row_excluded`) | `aggregate filter, distinct and argument order follow better-sqlite3`, `window groups frames and exclude clauses follow better-sqlite3` |

The one foreign key shape still missing at this pin (`DEFERRABLE INITIALLY DEFERRED`) is listed in the DDL
table and asserted as a structured rejection by `deferred foreign keys stay rejected`.

## Differential corpus

`npm run corpus -- --seed 20261106 --count 200` generates the corpus and runs every case on the same fixture
through this engine and both live oracles. Seed and count fully determine the result; the digest for this run is
`e3d6c1d1baf823086965286e4725e7921b79e6406ec29e72a96d03b08c1456b1`, unchanged because the generators did
not change.

Distribution: DDL 40, DML 40, expressions 40, aggregates 30, windows 30, transactions 20. Result: 190 passed,
0 mismatched, 10 discarded because `better-sqlite3` and CPython `sqlite3` disagreed with each other. The
baseline holds 10 entries, all discarded oracle disagreements.

Every cluster now agrees with both oracles. The DDL cases left the baseline once `WITHOUT ROWID`, partial and
expression indexes were implemented, the two UPSERT cases left it once `ON CONFLICT` landed, the eight DML cases
left it once `CREATE TABLE ... AS SELECT`, `INSERT ... SELECT` and `REPLACE` landed, the four expression cases
left it once `IS DISTINCT FROM`, `GLOB` and `NULLS FIRST` / `NULLS LAST` landed, the four aggregate cases and the
six window cases left it once aggregate `FILTER` / `DISTINCT` / argument `ORDER BY` and window `GROUPS` /
`EXCLUDE` landed, and the last aggregate mismatch left it once multi-argument `min` / `max` landed:

| Cluster | Cases | Shapes |
|---------|-------|--------|
| DDL | 0 | none |
| DML | 0 | none |
| Expressions | 0 | none |
| Aggregates | 0 | none |
| Windows | 0 | none |
| Transactions | 0 | none |

The 10 discarded cases are all transaction statements. CPython's default isolation keeps an implicit transaction
open after the fixture inserts, while `better-sqlite3` stays in autocommit, so `BEGIN` / `COMMIT` / `ROLLBACK`
disagree between the two oracles and are never compared with this engine. The `SAVEPOINT` shapes, which the
oracles agree on, now pass and left the baseline together with the six `round` drift rows and the modulo case.

## How this was measured

1. Cargo has no local facade override, so it compiled the pinned rev directly, then `node scripts/build-napi.mjs`
   rebuilt `sqlite.node`.
2. Each case ran in a fresh in-memory engine; the same setup and statement ran in `better-sqlite3` and in
   CPython `sqlite3`; rows came back as JSON and were compared value by value. CPython keeps foreign keys
   disabled by default, so the oracle turns them on explicitly for every foreign key case.
3. The gate cases added by this change use the live `better-sqlite3` oracle (`withOracle`) exactly like the
   existing window and CTE cases.

`../../../../../readme.md` still describes the early `SELECT`-only subset; this file is the current surface description.
