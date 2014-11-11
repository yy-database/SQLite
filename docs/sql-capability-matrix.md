# SQL capability matrix

Measured against the pinned `database.rs` facade rev `d5a0e13` (`d5a0e13fad714d4be679215864cd710fa27457b6`,
`projects/facades/sqlite/src/sql`). Every row below was executed through this repository's own engine and
through both live oracles; the oracle value, not an internal expectation, decides whether a row is correct.

| Item | Value |
|------|-------|
| Engine under test | `sqlite.node` built from the pin, `createEngine()` |
| Oracle A | `better-sqlite3` 12.11.1 (SQLite 3.53.2) |
| Oracle B | CPython `sqlite3` (SQLite 3.49.1) |
| Probes | 120 statements/cases, one or more per cluster |
| Local facade override | None; Cargo resolved the pin directly |

Status legend:

- `gated` — implemented and asserted by the `sql` gate (`sql-engine.test.ts`, `sql-expression.test.ts`, `three-valued-logic.test.ts`).
- `uncovered` — implemented and oracle-matching, but no gate executed it before this change.
- `missing` — rejected with a structured error.

Cluster totals (107 feature rows): **65 gated / 0 uncovered / 42 missing** at the pin.

## DDL

| Feature | Probe | Status | Evidence |
|---------|-------|--------|----------|
| `CREATE TABLE` PK / NOT NULL / UNIQUE / DEFAULT / CHECK / AUTOINCREMENT | `create table ct (id integer primary key autoincrement, name text not null unique default 'x', score real check (score between 0 and 10))` | gated | rows equal both oracles |
| `CREATE INDEX` plain / composite / ASC / UNIQUE / IF NOT EXISTS | `create index pix on pi (a)` | gated | covered by `create index accepts ascending, composite, unique and if not exists forms` |
| `ALTER TABLE ... RENAME TO` / `RENAME COLUMN` | `alter table r1 rename to r2` | gated | rows equal both oracles |
| `ALTER TABLE ... ADD COLUMN` | `alter table ac add column b integer not null default 5` | gated | rows equal both oracles |
| `DROP TABLE` / `DROP INDEX` | `drop table t` | gated | covered by the engine gate |
| `CREATE TABLE ... WITHOUT ROWID` | `create table wr (a text primary key, b integer) without rowid` | missing | `unsupported-statement` at `without` |
| `CREATE TABLE ... STRICT` | `create table st (a integer) strict` | gated | affinity runs first, then a value whose storage class differs from the declared type fails with `constraint-datatype`; invalid declared types fail with `unknown-datatype`; `strict tables enforce declared storage classes like better-sqlite3` |
| `CREATE TEMP TABLE` | `create temp table tp (a integer)` | missing | `syntax`: expected `table` but found `temp` |
| `CREATE TABLE ... AS SELECT` | `create table dst as select a from src where a > 1` | missing | `syntax`: expected `(` but found `as` |
| Partial index (`... WHERE`) | `create index pix on pi (a) where a > 1` | missing | `unsupported-clause` `WHERE`; the gate pins this rejection |
| Expression index | `create index eix on ei (a + 1)` | missing | `syntax`: index column list stops at `+` |
| Index `COLLATE` | `create index cix on ci (s collate nocase)` | missing | `syntax`: index column list stops at `collate` |
| `CREATE VIEW` | `create view vv as select a from vt where a > 1` | gated | re-runs the stored query on every read, keeps `CREATE VIEW <name>` plus the verbatim rest in `sqlite_master.sql`, rejects writes and indexes with `readonly-view`, and survives a reopen; `views re-run their query and keep catalog rows like better-sqlite3` |
| `CREATE TRIGGER` / `DROP TRIGGER` | `create trigger trg after insert on tg begin insert into tlog values (new.a); end` | gated | runs `BEFORE` / `AFTER` bodies in order, a body statement fires the other triggers but never the trigger that is running (`recursive_triggers = OFF`), stores `CREATE TRIGGER <name>` plus the verbatim rest, and `DROP TABLE` / `DROP TRIGGER` remove the catalog rows; `triggers fire once without recursion and keep catalog rows like better-sqlite3` |
| Foreign key, column level `REFERENCES` | `create table fk2 (id integer primary key, pid integer references fk1 (id))` | gated | orphan insert, parent delete and parent update all fail with `SQLITE_CONSTRAINT_FOREIGNKEY` |
| Foreign key, table level `FOREIGN KEY` with an implicit parent primary key | `create table fk4 (..., foreign key (pid) references fk3 (id))` | gated | composite orphan and composite rollback covered by `composite foreign keys and statement rollback match better-sqlite3` |
| `ON DELETE CASCADE` / `ON UPDATE CASCADE` | `create table c1 (pid integer references parent (id) on delete cascade)` | missing | `unsupported-foreign-key-action` with clause `CASCADE`; separately asserted |
| `ON UPDATE SET NULL` / `ON UPDATE SET DEFAULT` | `create table c2 (pid integer references parent (id) on update set null)` | missing | `unsupported-foreign-key-action` with clause `SET NULL` / `SET DEFAULT`; separately asserted |
| `DEFERRABLE INITIALLY DEFERRED` | `create table c3 (pid integer references parent (id) deferrable initially deferred)` | missing | `unsupported-deferred-foreign-key` with clause `DEFERRABLE`; separately asserted |
| `ALTER TABLE ... ADD COLUMN ... REFERENCES` | `alter table plain add column pid integer references parent (id)` | gated | appends the definition verbatim, refuses a non-NULL default, keeps existing rows at NULL, and checks the parent on later inserts; `add column with REFERENCES enforces the parent like better-sqlite3` |
| `ALTER TABLE ... DROP COLUMN` | `alter table dc drop column b` | missing | `unsupported-clause` `DROP COLUMN`; the gate pins this rejection |

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
| `INSERT ... SELECT` | `insert into is2 (a) select a from is1 where a > 1` | missing | `syntax`: expected `values` but found `select` |
| `INSERT OR REPLACE` / `INSERT OR IGNORE` | `insert or replace into orr values (1,'b')` | missing | `syntax`: expected `into` but found `or` |
| UPSERT `ON CONFLICT DO UPDATE` | `insert into up values (1, 20) on conflict (id) do update set v = excluded.v` | missing | `unsupported-statement` at `on` |
| `REPLACE INTO` | `replace into rp values (1,'b')` | missing | `unsupported-statement` at `replace` |
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
| `GLOB` | `select 'abc' glob 'a*'` | missing | `syntax` at `glob` |
| `COLLATE` (column, expression, `ORDER BY`) | `select 'a' = 'A' collate nocase` | missing | `unsupported-column-constraint` `COLLATE`; expression form is `syntax` |
| `IS DISTINCT FROM` / `IS NOT DISTINCT FROM` | `select 1 is distinct from 2` | missing | `syntax` at `distinct` |
| `ORDER BY ... NULLS FIRST/LAST` | `select a from onf order by a asc nulls first` | missing | `unsupported-clause` at `nulls` |
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
| `group_concat ... ORDER BY` | `select group_concat(v, '|' order by v) from ago` | missing | `syntax`: argument list stops at `order` |
| `count(DISTINCT x)` | `select count(distinct v) from cd` | missing | `syntax`: argument list stops at `v` |
| Aggregate `FILTER (WHERE ...)` | `select sum(v) filter (where v > 1) from afi` | missing | `syntax` at `filter` |
| Multi-argument `min()` / `max()` | `select min(3, 1, 2), max(3, 1, 2)` | missing | `wrong-arguments` to `min()` |
| `trim` / `ltrim` / `rtrim` | `select trim('  x  '), ltrim('  x'), rtrim('x  ')` | missing | `unknown-function`: `trim` |
| `instr` | `select instr('abcabc', 'bc'), instr('abc', 'z'), instr('abc', '')` | gated | `instr, round and modulo follow the oracle exactly` |
| `replace` | `select replace('abcabc', 'b', 'X')` | missing | `unknown-function`: `replace` |
| `ifnull` / `nullif` | `select ifnull(null, 7), nullif(1, 1)` | missing | `unknown-function`: `ifnull` |
| `printf` / `format` / `char` / `unicode` / `soundex` | `select printf('%d', 7)` | missing | absent from `ScalarFunction::from_name` |
| Math functions (`sqrt`, `power`, `floor`, `ceil`, `log`, ...) | `select sqrt(9), power(2, 10), floor(2.7), ceil(2.1)` | missing | `unknown-function`: `sqrt` |
| Date/time functions (`date`, `time`, `datetime`, `julianday`, `unixepoch`, `strftime`, `timediff`) | `select date('2024-01-02 03:04:05'), strftime('%Y', '2024-01-02')` | missing | `unknown-function`: `date` |
| JSON functions (`json_extract`, `json_array`, `json_object`, `json_valid`, ...) and `->` / `->>` | `select json_extract('{"a":1}', '$.a'), json_array(1, 2)` | missing | `unknown-function`: `json_extract` |

## Window functions

| Feature | Probe | Status | Evidence |
|---------|-------|--------|----------|
| `row_number` / `rank` / `dense_rank`, `sum() OVER`, partitions, named windows, empty input | `select g, a, sum(a) over (partition by g order by a) from w` | gated | `window functions match better-sqlite3 across partitions and frames` |
| `percent_rank` / `cume_dist` / `ntile` | `select percent_rank() over (order by a), cume_dist() over (order by a), ntile(2) over (order by a) from w` | gated | oracle-matching with both oracles |
| `lag` / `lead` with offset and default | `select a, lag(a, 1, 99) over (order by a), lead(a, 1, -1) over (order by a) from w` | gated | oracle-matching with both oracles |
| `first_value` / `last_value` / `nth_value` | `select first_value(a) over (order by a), nth_value(a, 2) over (order by a) from w` | gated | oracle-matching with both oracles |
| `ROWS` frame with numeric offsets | `select sum(a) over (order by a rows between 1 preceding and 1 following) from w` | gated | oracle-matching with both oracles |
| `RANGE` frame with numeric offsets | `select sum(a) over (order by a range between 1 preceding and 1 following) from w` | gated | oracle-matching with both oracles |
| Aggregate over the whole result / `group_concat` as a window aggregate | `select count(*) over (), sum(a) over () from w` | gated | oracle-matching with both oracles |
| `GROUPS` frame unit | `select sum(a) over (order by a groups between 1 preceding and current row) from w` | missing | `unsupported-clause` `GROUPS` |
| Frame `EXCLUDE` clause | `select sum(a) over (order by a rows between 1 preceding and 1 following exclude ties) from w` | missing | parser rejects at `sql.rs:2499-2505` |

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
| `PRAGMA table_info(t)` | `pragma table_info(pt)` | missing | `unsupported-pragma` at `PRAGMA` |
| `PRAGMA user_version` | `pragma user_version` | missing | `unsupported-pragma` at `PRAGMA` |
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
| `ATTACH DATABASE` | `attach database ':memory:' as aux` | missing | `unsupported-statement` at `attach` |
| `DETACH DATABASE` | `detach database aux` | missing | `unsupported-statement` at `detach` |
| `VACUUM` / `VACUUM INTO` | `vacuum` | missing | `unsupported-statement` at `vacuum` |

## Unimplemented: top 5 by impact

Ranked by how many ordinary SQLite clients would break on the first statement they send. Foreign keys,
recursive CTEs, transaction control, `SELECT DISTINCT`, modulo and `instr` are no longer on this list: all
landed at this pin and are asserted by the gate.

| # | Gap | Impact | Upstream coordinates |
|---|-----|--------|---------------------|
| 1 | `INSERT ... SELECT`, `INSERT OR REPLACE` / `OR IGNORE`, UPSERT, `REPLACE INTO` | Data copy, idempotent seeds, conflict handling | `sql.rs:2787-2875` (`statement()` dispatch requires plain `insert`), `sql.rs:3593-3636` (after `INTO` only a `VALUES` list) |
| 2 | Window frames `GROUPS` and `EXCLUDE` | Analytics that group peers rather than rows | `sql.rs:2517-2612` (`window_spec`), `sql.rs:1037` (`window_spec_label`) |
| 3 | Date/time and common string functions (`trim`, `replace`, `ifnull`, `nullif`, `printf`) | Reports, formatting, NULL handling in almost every app query | `sql.rs:333-357` (`ScalarFunction`), `engine.rs:5640` (scalar dispatch) |
| 4 | `CREATE VIEW` / `CREATE TRIGGER`, `PRAGMA` / `EXPLAIN` / `ATTACH` / `VACUUM` | Schema tooling, introspection and maintenance scripts | `sql.rs:2787-2875` (statement dispatch), `engine.rs:401` (`run_statement`) |
| 5 | `GROUP_CONCAT ... ORDER BY`, aggregate `FILTER`, `count(DISTINCT x)`, multi-argument `min`/`max` | Aggregate shaping in reports | `sql.rs:333-357`, aggregate argument parser in `sql.rs:400-460`, `engine.rs:5640` |

Next tier, lower blast radius but still visible: `COLLATE` and `GLOB` (`sql.rs:3846-4020`, no operator in
`BinaryOp`), JSON functions and `->` (`sql.rs:333-357`, `BinaryOp`), expression indexes and partial indexes
(`sql.rs:3125`).

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
| Foreign keys (column/table `REFERENCES`, `PRAGMA foreign_keys`, orphan/delete/update checks, composite keys, statement rollback) | `sql.rs:2939`, `sql.rs:3098-3110`, `engine.rs:403` | `foreign keys enforce orphan, delete and update checks per session pragma`, `composite foreign keys and statement rollback match better-sqlite3` |
| `ALTER TABLE ... ADD COLUMN ... REFERENCES`: non-NULL defaults refused, existing rows stay NULL, later inserts check the parent | `sql.rs:1473` (`AlterAction::AddColumn`), `engine.rs:1370-1411` | `add column with REFERENCES enforces the parent like better-sqlite3` |
| Canonical `CREATE TABLE` / `CREATE INDEX` / `CREATE VIEW` prefix in `sqlite_master.sql` (verbatim tail, `IF NOT EXISTS` dropped) | `sql.rs:3279-3291` (`canonical_create_sql`) | `sqlite_master lists schema objects in creation order and stays read-only`, view gate |
| Self-referencing recursive CTE (keyword optional, `UNION ALL` duplicates, `UNION` fixed-point de-duplication, outer `LIMIT` truncation) | `engine.rs:2229` | `recursive CTEs match better-sqlite3 without and with the keyword` |

The three foreign key shapes still missing at this pin (`ON DELETE CASCADE`, `ON UPDATE SET NULL` / `SET DEFAULT`,
`DEFERRABLE INITIALLY DEFERRED`) are listed in the DDL table and asserted as structured rejections by
`unsupported foreign key shapes keep structured rejections`.

## Differential corpus

`npm run corpus -- --seed 20261106 --count 200` generates the corpus and runs every case on the same fixture
through this engine and both live oracles. Seed and count fully determine the result; the digest for this run is
`e3d6c1d1baf823086965286e4725e7921b79e6406ec29e72a96d03b08c1456b1`, unchanged because the generators did
not change.

Distribution: DDL 40, DML 40, expressions 40, aggregates 30, windows 30, transactions 20. Result: 151 passed,
39 mismatched, 10 discarded because `better-sqlite3` and CPython `sqlite3` disagreed with each other. The
baseline holds 49 entries: 39 mismatches (23 structured rejections and 16 not-implemented rejections)
and 10 discarded oracle disagreements.

All 39 mismatches are structured rejections against two successful oracles, all already listed in the cluster
tables:

| Cluster | Cases | Shapes |
|---------|-------|--------|
| DDL | 15 | expression index 4, trigger 3, temp table 2, partial index 2, `WITHOUT ROWID` 2, `DROP COLUMN` 1, view 1 |
| DML | 10 | `INSERT OR REPLACE` 3, `INSERT ... SELECT` 3, UPSERT 2, `REPLACE INTO` 2 |
| Expressions | 4 | `IS DISTINCT FROM` 2, `GLOB` 1, `NULLS FIRST` 1 |
| Aggregates | 4 | `group_concat` with `ORDER BY` 1, `FILTER` 1, `count(DISTINCT)` 1, multi-argument `min`/`max` 1 |
| Windows | 6 | `GROUPS` frame 3, `EXCLUDE` 3 |
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

`readme.md` still describes the early `SELECT`-only subset; this file is the current surface description.
