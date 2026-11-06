# SQL capability matrix

Measured against the pinned `database.rs` facade rev `2af4c32` (`2af4c325b02abce08a0d107dc90deb2d3e008121`,
`projects/facades/sqlite/src/sql`). Every row below was executed through this repository's own engine and
through both live oracles; the oracle value, not an internal expectation, decides whether a row is correct.

| Item | Value |
|------|-------|
| Engine under test | `sqlite.node` built from the pin, `createEngine()` |
| Oracle A | `better-sqlite3` 12.11.1 (SQLite 3.53.2) |
| Oracle B | CPython `sqlite3` (SQLite 3.49.1) |
| Probes | 115 statements/cases, one or more per cluster |
| Local facade override | None; Cargo resolved the pin directly |

Status legend:

- `gated` — implemented and asserted by the `sql` gate (`sql-engine.test.ts`, `sql-expression.test.ts`, `three-valued-logic.test.ts`).
- `uncovered` — implemented and oracle-matching, but no gate executed it before this change.
- `missing` — rejected with a structured error.

Cluster totals (103 feature rows): **52 gated / 0 uncovered / 51 missing** at the pin.

## DDL

| Feature | Probe | Status | Evidence |
|---------|-------|--------|----------|
| `CREATE TABLE` PK / NOT NULL / UNIQUE / DEFAULT / CHECK / AUTOINCREMENT | `create table ct (id integer primary key autoincrement, name text not null unique default 'x', score real check (score between 0 and 10))` | gated | rows equal both oracles |
| `CREATE INDEX` plain / composite / ASC / UNIQUE / IF NOT EXISTS | `create index pix on pi (a)` | gated | covered by `create index accepts ascending, composite, unique and if not exists forms` |
| `ALTER TABLE ... RENAME TO` / `RENAME COLUMN` | `alter table r1 rename to r2` | gated | rows equal both oracles |
| `ALTER TABLE ... ADD COLUMN` | `alter table ac add column b integer not null default 5` | gated | rows equal both oracles |
| `DROP TABLE` / `DROP INDEX` | `drop table t` | gated | covered by the engine gate |
| `CREATE TABLE ... WITHOUT ROWID` | `create table wr (a text primary key, b integer) without rowid` | missing | `unsupported-statement` at `without` |
| `CREATE TABLE ... STRICT` | `create table st (a integer) strict` | missing | `unsupported-statement` at `strict` |
| `CREATE TEMP TABLE` | `create temp table tp (a integer)` | missing | `syntax`: expected `table` but found `temp` |
| `CREATE TABLE ... AS SELECT` | `create table dst as select a from src where a > 1` | missing | `syntax`: expected `(` but found `as` |
| Partial index (`... WHERE`) | `create index pix on pi (a) where a > 1` | missing | `unsupported-clause` `WHERE`; the gate pins this rejection |
| Expression index | `create index eix on ei (a + 1)` | missing | `syntax`: index column list stops at `+` |
| Index `COLLATE` | `create index cix on ci (s collate nocase)` | missing | `syntax`: index column list stops at `collate` |
| `CREATE VIEW` | `create view vv as select a from vt where a > 1` | missing | `syntax`: expected `table` but found `view` |
| `CREATE TRIGGER` | `create trigger trg after insert on tg begin insert into tlog values (new.a); end` | missing | `syntax`: expected `table` but found `trigger` |
| Foreign key, column level `REFERENCES` | `create table fk2 (id integer primary key, pid integer references fk1 (id))` | gated | orphan insert, parent delete and parent update all fail with `SQLITE_CONSTRAINT_FOREIGNKEY` |
| Foreign key, table level `FOREIGN KEY` with an implicit parent primary key | `create table fk4 (..., foreign key (pid) references fk3 (id))` | gated | composite orphan and composite rollback covered by `composite foreign keys and statement rollback match better-sqlite3` |
| `ON DELETE CASCADE` / `ON UPDATE CASCADE` | `create table c1 (pid integer references parent (id) on delete cascade)` | missing | `unsupported-foreign-key-action` with clause `CASCADE`; separately asserted |
| `ON UPDATE SET NULL` / `ON UPDATE SET DEFAULT` | `create table c2 (pid integer references parent (id) on update set null)` | missing | `unsupported-foreign-key-action` with clause `SET NULL` / `SET DEFAULT`; separately asserted |
| `DEFERRABLE INITIALLY DEFERRED` | `create table c3 (pid integer references parent (id) deferrable initially deferred)` | missing | `unsupported-deferred-foreign-key` with clause `DEFERRABLE`; separately asserted |
| `ALTER TABLE ... ADD COLUMN ... REFERENCES` | `alter table plain add column pid integer references parent (id)` | missing | `unsupported-column-constraint` with clause `REFERENCES`; separately asserted |
| `ALTER TABLE ... DROP COLUMN` | `alter table dc drop column b` | missing | `unsupported-clause` `DROP COLUMN`; the gate pins this rejection |

## DML

| Feature | Probe | Status | Evidence |
|---------|-------|--------|----------|
| `INSERT` with several `VALUES` tuples and a column subset | `insert into im (v) values ('a'), ('b') returning id, v` | gated | rows equal both oracles |
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
| Modulo `%` | `select 7 % 3, -7 % 3, 7.5 % 2` | missing | `syntax` at `%` |
| `GLOB` | `select 'abc' glob 'a*'` | missing | `syntax` at `glob` |
| `COLLATE` (column, expression, `ORDER BY`) | `select 'a' = 'A' collate nocase` | missing | `unsupported-column-constraint` `COLLATE`; expression form is `syntax` |
| `IS DISTINCT FROM` / `IS NOT DISTINCT FROM` | `select 1 is distinct from 2` | missing | `syntax` at `distinct` |
| `ORDER BY ... NULLS FIRST/LAST` | `select a from onf order by a asc nulls first` | missing | `unsupported-clause` at `nulls` |
| `SELECT DISTINCT` | `select distinct a from sd order by a` | missing | `syntax` in the projection |
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
| `replace` / `instr` | `select replace('abcabc', 'b', 'X'), instr('abcabc', 'bc')` | missing | `unknown-function`: `replace` |
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
| `BEGIN [DEFERRED|IMMEDIATE|EXCLUSIVE]` | `begin immediate` | missing | `unsupported-statement` at `begin` |
| `COMMIT` / `ROLLBACK` | `commit` | missing | `unsupported-statement` at `commit` |
| `SAVEPOINT` / `RELEASE` / `ROLLBACK TO` | `savepoint sp1` | missing | `unsupported-statement` at `savepoint` |

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

Ranked by how many ordinary SQLite clients would break on the first statement they send. Foreign keys and
recursive CTEs are no longer on this list: both landed at this pin and are asserted by the gate.

| # | Gap | Impact | Upstream coordinates |
|---|-----|--------|---------------------|
| 1 | Transaction statements (`BEGIN` / `COMMIT` / `ROLLBACK` / `SAVEPOINT`) | Every client that opens an explicit transaction, every framework migration | `sql.rs:2728-2769` (`statement()` accepts only create/insert/update/delete/drop/alter/select/with), `engine.rs:401` (`run_statement`) |
| 2 | `SELECT DISTINCT` | Ordinary de-duplication queries | `sql.rs:3488-3537` (`select_core` projection has no `DISTINCT` branch), `engine.rs:1226` (`select`) |
| 3 | Modulo `%` | Any arithmetic/parity expression in `SELECT`, `WHERE`, `GROUP BY` | `sql.rs:262-289` (`BinaryOp` has no modulo), `sql.rs:2097-2111` (`multiplicative_expr` accepts only `*` and `/`) |
| 4 | `INSERT ... SELECT`, `INSERT OR REPLACE` / `OR IGNORE`, UPSERT, `REPLACE INTO` | Data copy, idempotent seeds, conflict handling | `sql.rs:2742-2745` (dispatch requires plain `insert`), `sql.rs:3235-3276` (after `INTO` only a `VALUES` list of literals) |
| 5 | Date/time and common string functions (`trim`, `replace`, `instr`, `ifnull`, `nullif`, `printf`) | Reports, formatting, NULL handling in almost every app query | `sql.rs:342-357` (`ScalarFunction::from_name`), `engine.rs:4773` (dispatch) |

Next tier, lower blast radius but still visible: `CREATE VIEW` / `CREATE TRIGGER` (`sql.rs:2730-2740`),
`PRAGMA` / `EXPLAIN` / `ATTACH` / `VACUUM` (`sql.rs:2769-2775`), `COLLATE` and `GLOB`
(`sql.rs:3488-3537`, no operator in `BinaryOp`), `count(DISTINCT x)` and aggregate `FILTER`
(`sql.rs:417`, aggregate argument parser), JSON functions and `->` (`sql.rs:342-357`, `BinaryOp`).

## Landed at this pin

| Gap | Upstream coordinates | Gate |
|-----|---------------------|------|
| Foreign keys (column/table `REFERENCES`, `PRAGMA foreign_keys`, orphan/delete/update checks, composite keys, statement rollback) | `sql.rs:2939`, `sql.rs:3098-3110`, `engine.rs:403` | `foreign keys enforce orphan, delete and update checks per session pragma`, `composite foreign keys and statement rollback match better-sqlite3` |
| Self-referencing recursive CTE (keyword optional, `UNION ALL` duplicates, `UNION` fixed-point de-duplication, outer `LIMIT` truncation) | `engine.rs:2229` | `recursive CTEs match better-sqlite3 without and with the keyword` |

The four foreign key shapes still missing at this pin (`ON DELETE CASCADE`, `ON UPDATE SET NULL` / `SET DEFAULT`,
`DEFERRABLE INITIALLY DEFERRED`, `ALTER TABLE ... ADD COLUMN ... REFERENCES`) are listed in the DDL table and
asserted as structured rejections by `unsupported foreign key shapes keep structured rejections`.

## Known drift (implemented but not oracle-equal)

| Item | This engine | Both oracles | Coordinates |
|------|-------------|--------------|-------------|
| `round(1.2345, 3)` | `1.235` | `1.234` | `engine.rs:5540-5565` (scale/round path at 5554-5561) |
| `round(123.456, -1)` | `120` | `123` (SQLite clamps `n` to `>= 0`) | `engine.rs:5540-5565` (scale/round path at 5554-5561) |
| `round(2.675, 2)` | `2.68` | `2.67` | `engine.rs:5540-5565` (scale/round path at 5554-5561) |

The gate pins these three as known differences in `known differential drift pins round ties and negative
precision`, asserting both this engine's current value and both oracles' value. The tie forms (`round(±2.5)`)
and `round(1.2345, 2)` match both oracles and are asserted without any drift.

## Differential corpus

`npm run corpus -- --seed 20261106 --count 200` generates the corpus and runs every case on the same fixture
through this engine and both live oracles. Seed and count fully determine the result; the digest for this run is
`e3d6c1d1baf823086965286e4725e7921b79e6406ec29e72a96d03b08c1456b1`.

Distribution: DDL 40, DML 40, expressions 40, aggregates 30, windows 30, transactions 20. Result: 139 passed,
51 mismatched, 10 discarded because `better-sqlite3` and CPython `sqlite3` disagreed with each other.

The only value-level differences are the `round` rows above. The other 45 mismatches are structured rejections
against two successful oracles, all already listed in the cluster tables:

| Cluster | Cases | Shapes |
|---------|-------|--------|
| DDL | 16 | expression index 4, trigger 3, temp table 2, partial index 2, `WITHOUT ROWID` 2, `DROP COLUMN` 1, view 1, `STRICT` 1 |
| DML | 10 | `INSERT OR REPLACE` 3, `INSERT ... SELECT` 3, UPSERT 2, `REPLACE INTO` 2 |
| Expressions | 5 | `IS DISTINCT FROM` 2, modulo 1, `GLOB` 1, `NULLS FIRST` 1 |
| Aggregates | 4 | `group_concat` with `ORDER BY` 1, `FILTER` 1, `count(DISTINCT)` 1, multi-argument `min`/`max` 1 |
| Windows | 6 | `GROUPS` frame 3, `EXCLUDE` 3 |
| Transactions | 4 | `SAVEPOINT` 4 |

The 10 discarded cases are all transaction statements. CPython's default isolation keeps an implicit transaction
open after the fixture inserts, while `better-sqlite3` stays in autocommit, so `BEGIN` / `COMMIT` / `ROLLBACK`
disagree between the two oracles and are never compared with this engine. `SAVEPOINT` and its release forms agree
between the oracles, which is why the transaction mismatches above are `SAVEPOINT` rejections.

## How this was measured

1. Cargo has no local facade override, so it compiled the pinned rev directly, then `node scripts/build-napi.mjs`
   rebuilt `sqlite.node`.
2. Each case ran in a fresh in-memory engine; the same setup and statement ran in `better-sqlite3` and in
   CPython `sqlite3`; rows came back as JSON and were compared value by value. CPython keeps foreign keys
   disabled by default, so the oracle turns them on explicitly for every foreign key case.
3. The gate cases added by this change and the known-drift test use the live `better-sqlite3` oracle
   (`withOracle`) exactly like the existing window and CTE cases.

`readme.md` still describes the early `SELECT`-only subset; this file is the current surface description.
