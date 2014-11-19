import assert from "node:assert/strict";
import test from "node:test";
import { createEngine } from "../src/index.ts";

function scalarEngine(): ReturnType<typeof createEngine> {
  const engine = createEngine();
  engine.exec(
    "create table v (id integer primary key, a integer, b integer, c real, s text); \
     insert into v (a, b, c, s) values (7, 2, 1.5, 'AbC'); \
     insert into v (a, b, c, s) values (-7, 0, null, 'xyz'); \
     insert into v (a, b, c, s) values (null, 4, 3.0, null);",
  );
  return engine;
}

test("projection arithmetic follows SQLite integer and overflow rules", () => {
  const engine = scalarEngine();

  const arithmetic = engine.execute("select a+b, a-b, a*b, a/b from v where id = 1");
  assert.deepEqual(arithmetic.columns, ["a+b", "a-b", "a*b", "a/b"]);

  // Qualifiers resolve references but never leak into a bare column header;
  // an expression keeps the exact source span as its label.
  assert.deepEqual(engine.execute("select v.a, v.a + 1 from v where id = 1").columns, ["a", "v.a + 1"]);
  assert.deepEqual(arithmetic.rows, [[9, 5, 14, 3]]);

  // Integer division truncates toward zero instead of producing a real.
  assert.deepEqual(engine.execute("select -7/2 from v where id = 1").rows, [[-3]]);

  // Grouping and a prefix minus, including a mixed integer/real sum.
  assert.deepEqual(engine.execute("select (a+b)*2, -a, a+c from v where id = 1").rows, [[18, -7, 8.5]]);

  // Integer overflow falls back to a real.
  assert.deepEqual(engine.execute("select typeof(9223372036854775807 + 1) from v where id = 1").rows, [["real"]]);

  // Division by zero is NULL, not an error and not a zero.
  assert.deepEqual(engine.execute("select a/b from v where id = 3").rows, [[null]]);

  // NULL in any arithmetic operand propagates.
  assert.deepEqual(engine.execute("select a+b, a*b from v where id = 3").rows, [[null, null]]);

  // Comparisons used as projection values yield 1/0/NULL.
  assert.deepEqual(engine.execute("select a>b from v where id = 1").rows, [[1]]);
  assert.deepEqual(engine.execute("select a>b from v where id = 3").rows, [[null]]);
  assert.deepEqual(engine.execute("select a = null from v where id = 1").rows, [[null]]);
  assert.deepEqual(engine.execute("select null = null from v where id = 1").rows, [[null]]);
});

test("scalar functions cover the supported set and reject bad arity", () => {
  const engine = scalarEngine();

  assert.deepEqual(engine.execute("select abs(a), abs(b), abs(c) from v where id = 2").rows, [[7, 0, null]]);
  assert.deepEqual(engine.execute("select coalesce(null, a, b, c, s), coalesce(s, 'fallback') from v where id = 3").rows, [
    [4, "fallback"],
  ]);
  assert.deepEqual(engine.execute("select length(s), length(a), length(null) from v where id = 1").rows, [[3, 1, null]]);
  assert.deepEqual(engine.execute("select typeof(a), typeof(c), typeof(s) from v where id = 1").rows, [
    ["integer", "real", "text"],
  ]);
  assert.deepEqual(engine.execute("select typeof(a) from v where id = 3").rows, [["null"]]);
  assert.deepEqual(engine.execute("select typeof(a) from v where id = 1").columns, ["typeof(a)"]);
  assert.deepEqual(engine.execute("select lower(s), upper(s) from v where id = 1").rows, [["abc", "ABC"]]);
  assert.deepEqual(engine.execute("select substr(s, 2, 2), substr(s, -2), substr(s, 3) from v where id = 1").rows, [
    ["bC", "bC", "C"],
  ]);
  assert.deepEqual(engine.execute("select round(c), round(1.2345, 2), round(7) from v where id = 1").rows, [
    [2, 1.23, 7],
  ]);

  const badArity = engine.tryExecute("select abs(1, 2) from v");
  assert.equal(badArity.ok, false);
  assert.equal(badArity.error?.code, "wrong-arguments");
  assert.match(badArity.error?.message ?? "", /wrong number of arguments to function abs\(\)/);

  const missing = engine.tryExecute("select nosuch(a) from v");
  assert.equal(missing.ok, false);
  assert.equal(missing.error?.code, "unknown-function");
  assert.match(missing.error?.message ?? "", /no such function: nosuch/);

  // Supported whole-result aggregates cover the common set.
  assert.deepEqual(engine.execute("select avg(a) from v").rows, [[0]]);
  assert.deepEqual(engine.execute("select sum(b), min(a), max(b) from v").rows, [[6, -7, 4]]);

  // `total()` is the real-valued sibling of `sum()` and keeps that type.
  assert.deepEqual(engine.execute("select total(a), typeof(total(a)), total(b) from v").rows, [[0, "real", 6]]);

  assert.deepEqual(engine.execute("select count(*) from v").rows, [[3]]);
});

test("CASE supports searched, simple and missing-ELSE forms", () => {
  const engine = scalarEngine();

  const searched = engine.execute(
    "select case when a > 0 then 'pos' when a < 0 then 'neg' else 'unknown' end from v order by id",
  );
  assert.deepEqual(searched.rows, [["pos"], ["neg"], ["unknown"]]);
  // The label is the written span, not a normalised rendering.
  assert.deepEqual(searched.columns, [
    "case when a > 0 then 'pos' when a < 0 then 'neg' else 'unknown' end",
  ]);

  // The simple form compares the operand with each WHEN value.
  const simple = engine.execute("select case b when 2 then 'two' when 0 then 'zero' end from v order by id");
  assert.deepEqual(simple.rows, [["two"], ["zero"], [null]]);

  // A NULL operand never equals a WHEN value, so ELSE (or NULL) applies.
  assert.deepEqual(engine.execute("select case a when null then 'n' else 'e' end from v where id = 3").rows, [["e"]]);

  // The same evaluator serves WHERE.
  assert.deepEqual(engine.execute("select id from v where case when a is null then 1 else 0 end = 1").rows, [[3]]);
});

test("IN and NOT IN keep SQL three-valued NULL semantics", () => {
  const engine = scalarEngine();

  // A miss with a NULL candidate is unknown, not false.
  assert.deepEqual(engine.execute("select 5 in (1, 2, null) from v where id = 1").rows, [[null]]);
  // A hit wins even when a later candidate is NULL.
  assert.deepEqual(engine.execute("select 1 in (1, 2, null) from v where id = 1").rows, [[1]]);
  // A NULL probe is always unknown.
  assert.deepEqual(engine.execute("select null in (1, 2) from v where id = 1").rows, [[null]]);
  // NOT IN negates the hit but preserves unknown.
  assert.deepEqual(engine.execute("select 5 not in (1, 2, null) from v where id = 1").rows, [[null]]);
  assert.deepEqual(engine.execute("select 5 not in (1, 2) from v where id = 1").rows, [[1]]);

  // Column probes: 7 matches, -7 misses, NULL is unknown.
  assert.deepEqual(engine.execute("select a in (7, 9) from v order by id").rows, [[1], [0], [null]]);

  // WHERE must discard unknown rows: a NULL a is neither IN nor NOT IN.
  assert.deepEqual(engine.execute("select id from v where a in (7)").rows, [[1]]);
  assert.deepEqual(engine.execute("select id from v where a not in (7)").rows, [[2]]);

  assert.deepEqual(engine.execute("select id from v where a in (7, null)").rows, [[1]]);
  assert.deepEqual(engine.execute("select id from v where a not in (7, null)").rows, []);
});

test("three-valued logic is independent of NULL-as-boolean shortcuts", () => {
  const engine = scalarEngine();

  // AND: the NULL row must stay unknown, never collapse to false.
  assert.deepEqual(engine.execute("select a < 0 and a is null from v order by id").rows, [[0], [0], [null]]);
  // OR: true wins over unknown.
  assert.deepEqual(engine.execute("select a < 0 or a is null from v order by id").rows, [[0], [1], [1]]);
  // NOT: unknown stays unknown.
  assert.deepEqual(engine.execute("select not (a < 0) from v order by id").rows, [[1], [0], [null]]);

  // WHERE must filter unknown, not treat it as true or false.
  assert.deepEqual(engine.execute("select id from v where not (a < 0)").rows, [[1]]);
  assert.deepEqual(engine.execute("select id from v where a < 0 or a is null").rows, [[2], [3]]);

  // A neat in the predicate keeps the NULL row out even though the other
  // conjunct would be true for it.
  assert.deepEqual(engine.execute("select id from v where a is null and a in (7)").rows, []);
});

test("ORDER BY reuses the evaluator and accepts output ordinals", () => {
  const engine = scalarEngine();

  // Expression key, descending.
  assert.deepEqual(engine.execute("select a+b from v where id < 3 order by a+b desc").rows, [[9], [-7]]);
  // Ordinal key points at the second output column.
  assert.deepEqual(engine.execute("select a+b, a-b from v where id < 3 order by 2 desc").rows, [
    [9, 5],
    [-7, -7],
  ]);
  // NULL sorts lowest, so DESC puts it last.
  assert.deepEqual(engine.execute("select id, a from v order by a desc").rows, [
    [1, 7],
    [2, -7],
    [3, null],
  ]);

  const outOfRange = engine.tryExecute("select a from v order by 2");
  assert.equal(outOfRange.ok, false);
  assert.equal(outOfRange.error?.code, "order-term-out-of-range");
  assert.match(outOfRange.error?.message ?? "", /ORDER BY term out of range/);
});

function setEngine(): ReturnType<typeof createEngine> {
  const engine = createEngine();
  engine.exec(
    "create table l (x integer); insert into l values (1),(2),(2),(2),(3),(null); \
     create table r (y integer); insert into r values (2),(2),(4),(null); \
     create table c (z integer); insert into c values (3); \
     create table w (p integer, q integer);",
  );
  return engine;
}

test("set operators follow SQLite multiplicity and NULL deduplication", () => {
  const engine = setEngine();

  // UNION removes duplicates on both sides; the two NULLs collapse to one.
  assert.deepEqual(engine.execute("select x from l union select y from r order by 1").rows, [
    [null],
    [1],
    [2],
    [3],
    [4],
  ]);
  // UNION ALL keeps every occurrence on both sides.
  assert.equal(engine.execute("select x from l union all select y from r").rows.length, 10);

  // INTERSECT keeps one copy; SQLite has no `INTERSECT ALL`.
  assert.deepEqual(engine.execute("select x from l intersect select y from r order by 1").rows, [[null], [2]]);
  assert.equal(engine.tryExecute("select x from l intersect all select y from r").error?.code, "syntax");

  // EXCEPT subtracts a presence; SQLite has no `EXCEPT ALL`.
  assert.deepEqual(engine.execute("select x from l except select y from r order by 1").rows, [[1], [3]]);
  assert.equal(engine.tryExecute("select x from l except all select y from r").error?.code, "syntax");

  // The result takes its labels from the leftmost core.
  assert.deepEqual(engine.execute("select x from l union select y from r").columns, ["x"]);
});

test("compound SELECTs report arity, clause position and left-to-right folds", () => {
  const engine = setEngine();

  const mismatch = engine.tryExecute("select x from l union select p, q from w");
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error?.code, "arity-mismatch");
  assert.match(mismatch.error?.message ?? "", /same number of result columns/);
  assert.equal(typeof mismatch.error?.position, "number");

  // The trailing ORDER BY / LIMIT apply to the whole compound.
  assert.deepEqual(engine.execute("select x from l union select y from r order by 1 desc limit 2").rows, [[4], [3]]);
  // An output label picks the same column as its ordinal.
  assert.deepEqual(engine.execute("select x from l union select y from r order by x").rows, [
    [null],
    [1],
    [2],
    [3],
    [4],
  ]);

  // ORDER BY may not split a compound query.
  const misplaced = engine.tryExecute("select x from l order by 1 union select y from r");
  assert.equal(misplaced.ok, false);
  assert.equal(misplaced.error?.code, "syntax");
  assert.match(misplaced.error?.message ?? "", /ORDER BY` clause should come after UNION not before/);

  // SQLite folds strictly left to right: (l EXCEPT r) INTERSECT c keeps 3.
  assert.deepEqual(engine.execute("select x from l except select y from r intersect select z from c").rows, [[3]]);
});

function subqueryEngine(): ReturnType<typeof createEngine> {
  const engine = createEngine();
  engine.exec(
    "create table o (a integer); insert into o values (1),(2),(9); \
     create table i (a integer, b integer); insert into i values (1,100),(2,200); \
     create table t (x integer, y integer); insert into t values (1,10),(2,20),(3,null);",
  );
  return engine;
}

test("scalar subqueries follow SQLite row selection in every position", () => {
  const engine = subqueryEngine();

  // One row: its only value. No row: NULL. Many rows: the first row, without
  // an error, exactly as SQLite 3.49.1 was measured to behave.
  assert.deepEqual(engine.execute("select (select x from t where x = 2) from o where a = 1").rows, [[2]]);
  assert.deepEqual(engine.execute("select (select x from t where x = 9) from o where a = 1").rows, [[null]]);
  assert.deepEqual(engine.execute("select (select x from t) from o where a = 1").rows, [[1]]);
  assert.deepEqual(engine.execute("select (select x from t order by x desc) from o where a = 1").rows, [[3]]);

  // The same evaluator serves WHERE, ORDER BY and function arguments.
  assert.deepEqual(engine.execute("select a from o where a > (select x from t)").rows, [[2], [9]]);
  assert.deepEqual(engine.execute("select a from o order by (select max(0 - a) from t where t.x = 1)").rows, [
    [9],
    [2],
    [1],
  ]);
  assert.deepEqual(engine.execute("select abs((select -x from t)) from o where a = 1").rows, [[1]]);

  // A scalar subquery must yield exactly one column.
  const wide = engine.tryExecute("select (select x, y from t) from o where a = 1");
  assert.equal(wide.ok, false);
  assert.equal(wide.error?.code, "arity-mismatch");
  assert.match(wide.error?.message ?? "", /sub-select returns 2 columns - expected 1/);
});

test("EXISTS and NOT EXISTS are two-valued even when the subquery returns nothing", () => {
  const engine = subqueryEngine();

  assert.deepEqual(engine.execute("select a from o where exists(select 1 from i where i.a = o.a)").rows, [[1], [2]]);
  assert.deepEqual(engine.execute("select a from o where not exists(select 1 from i where i.a = o.a)").rows, [[9]]);
  assert.deepEqual(engine.execute("select exists(select 1 from t where 0) from o where a = 1").rows, [[0]]);
  assert.deepEqual(engine.execute("select not exists(select 1 from t where 0) from o where a = 1").rows, [[1]]);

  // A NULL comparison inside the subquery still leaves the outer test defined.
  assert.deepEqual(engine.execute("select not exists(select 1 from t where x = null) from o where a = 1").rows, [[1]]);
});

test("IN and NOT IN subqueries keep NULL-candidate three-valued logic", () => {
  const engine = subqueryEngine();

  // y contains one NULL, so a miss is unknown rather than false.
  assert.deepEqual(engine.execute("select 5 in (select y from t) from o where a = 1").rows, [[null]]);
  assert.deepEqual(engine.execute("select 5 not in (select y from t) from o where a = 1").rows, [[null]]);
  // A hit wins over the NULL candidate.
  assert.deepEqual(engine.execute("select 20 in (select y from t) from o where a = 1").rows, [[1]]);
  // An empty subquery makes NOT IN true.
  assert.deepEqual(engine.execute("select 5 not in (select x from t where 0) from o where a = 1").rows, [[1]]);

  // Column probes: 1 and 2 match, 9 misses.
  assert.deepEqual(engine.execute("select a in (select a from i) from o").rows, [[1], [1], [0]]);
  assert.deepEqual(engine.execute("select a not in (select a from i) from o").rows, [[0], [0], [1]]);
});

test("correlated subqueries resolve outer columns with inner-name shadowing", () => {
  const engine = subqueryEngine();

  // The outer row is pushed into the inner scope, so `o.a` binds per row.
  assert.deepEqual(engine.execute("select a, (select b from i where i.a = o.a) from o").rows, [
    [1, 100],
    [2, 200],
    [9, null],
  ]);

  // An unqualified inner name resolves inside `i` first and shadows `o.a`.
  assert.deepEqual(engine.execute("select (select a from i where a = 1) from o where a = 9").rows, [[1]]);
  // A qualified outer reference is still reachable from that inner scope.
  assert.deepEqual(engine.execute("select (select b from i where i.a = o.a) from o where a = 2").rows, [[200]]);

  // Nested correlation adds a second enclosing scope without changing values.
  assert.deepEqual(engine.execute("select (select (select max(x) from t) from o where o.a = 1) from o where a = 1").rows, [
    [3],
  ]);
});

test("whole-result aggregates cover count, avg, sum, min and max", () => {
  const engine = subqueryEngine();

  assert.deepEqual(engine.execute("select count(*) from t").rows, [[3]]);
  assert.deepEqual(engine.execute("select count(y) from t").rows, [[2]]);
  assert.deepEqual(engine.execute("select avg(y) from t").rows, [[15]]);
  assert.deepEqual(engine.execute("select sum(x) from t").rows, [[6]]);
  assert.deepEqual(engine.execute("select min(y), max(y) from t").rows, [[10, 20]]);

  // An empty input gives 0 for count and NULL for every other aggregate.
  assert.deepEqual(engine.execute("select count(*) from t where 0").rows, [[0]]);
  assert.deepEqual(engine.execute("select avg(x), sum(x), min(x), max(x) from t where 0").rows, [[null, null, null, null]]);

  // An aggregate may feed a larger expression or a scalar subquery.
  assert.deepEqual(engine.execute("select (select max(y) + 1 from t) from o where a = 1").rows, [[21]]);
  assert.deepEqual(engine.execute("select (select avg(x) from t) + 1 from o where a = 1").rows, [[3]]);

  // Aggregates outside a whole-result projection are rejected, not guessed.
  const misplaced = engine.tryExecute("select x from t where avg(y) > 1");
  assert.equal(misplaced.ok, false);
  assert.equal(misplaced.error?.code, "misuse-of-aggregate");
  assert.match(misplaced.error?.message ?? "", /misuse of aggregate function avg\(\)/);
});

function joinEngine(): ReturnType<typeof createEngine> {
  const engine = createEngine();
  engine.exec(
    "create table l (a integer, b integer); insert into l values (1,10),(2,20),(3,30); \
     create table r (a integer, c integer); insert into r values (1,100),(1,101),(3,300),(4,400);",
  );
  return engine;
}

test("INNER and LEFT JOIN pair rows the way SQLite does", () => {
  const engine = joinEngine();

  assert.deepEqual(engine.execute("select l.a, r.c from l inner join r on l.a = r.a").rows, [
    [1, 100],
    [1, 101],
    [3, 300],
  ]);
  // An unmatched left row survives with NULL on the right, in left-row order.
  assert.deepEqual(engine.execute("select l.a, r.c from l left join r on l.a = r.a").rows, [
    [1, 100],
    [1, 101],
    [2, null],
    [3, 300],
  ]);
  // When any pair matches, no NULL-padded copy is added.
  assert.deepEqual(engine.execute("select l.a, r.c from l left join r on l.a = r.a and r.c > 100").rows, [
    [1, 101],
    [2, null],
    [3, 300],
  ]);
  // Three sources and a WHERE after the joins.
  assert.deepEqual(engine.execute("select l.a, r.c from l join r on l.a = r.a where r.c > 200").rows, [[3, 300]]);
  // CROSS JOIN is the same product as a comma.
  assert.deepEqual(engine.execute("select count(*) from l cross join r").rows, [[12]]);
});

test("GROUP BY and HAVING aggregate per group", () => {
  const engine = joinEngine();

  // Groups appear in first-seen order; `count(*)` is per group.
  assert.deepEqual(engine.execute("select a, count(*) from r group by a").rows, [
    [1, 2],
    [3, 1],
    [4, 1],
  ]);
  assert.deepEqual(engine.execute("select a, sum(c), avg(c) from r group by a").rows, [
    [1, 201, 100.5],
    [3, 300, 300],
    [4, 400, 400],
  ]);
  // A one-based ordinal may stand for a projection expression.
  assert.deepEqual(engine.execute("select a, count(*) from r group by 1 order by 1 desc").rows, [
    [4, 1],
    [3, 1],
    [1, 2],
  ]);
  // HAVING may use an aggregate that the projection omits.
  assert.deepEqual(engine.execute("select a from r group by a having count(*) > 1").rows, [[1]]);
  // A group over an empty input produces no row at all.
  assert.deepEqual(engine.execute("select a, count(*) from r where 0 group by a").rows, []);
  // Without GROUP BY the aggregate still yields exactly one row.
  assert.deepEqual(engine.execute("select avg(c), min(c), max(c) from r").rows, [[225.25, 100, 400]]);
});

function derivedEngine(): ReturnType<typeof createEngine> {
  const engine = createEngine();
  engine.exec(
    "create table t (a integer, b integer); insert into t values (1,10),(2,20),(3,30); \
     create table c (a integer); insert into c values (99);",
  );
  return engine;
}

test("derived tables expose projection labels and join like base tables", () => {
  const engine = derivedEngine();

  // SQLite does not require an alias on a FROM subquery.
  assert.deepEqual(engine.execute("select * from (select a from t)").rows, [[1], [2], [3]]);
  assert.deepEqual(engine.execute("select * from (select a from t) as q").rows, [[1], [2], [3]]);
  assert.deepEqual(engine.execute("select q.a, q.b from (select a, b from t) q").rows, [
    [1, 10],
    [2, 20],
    [3, 30],
  ]);

  // Two derived tables on either side of a join, then a whole-result aggregate.
  assert.deepEqual(
    engine.execute("select x.a, y.b from (select a from t) x join (select a, b from t) y on x.a = y.a").rows,
    [[1, 10], [2, 20], [3, 30]],
  );
  assert.deepEqual(engine.execute("select count(*), sum(d.b) from (select a, b from t where a < 3) d").rows, [[2, 30]]);

  // Nesting keeps the inner labels; a derived body may group.
  assert.deepEqual(engine.execute("select a from (select a from (select a from t where a > 1) inner_q where a < 3) outer_q").rows, [
    [2],
  ]);
  assert.deepEqual(engine.execute("select a, total_b from (select a, sum(b) as total_b from t group by a) d").rows, [
    [1, 10],
    [2, 20],
    [3, 30],
  ]);

  // A derived table can sit inside `IN (SELECT ...)`, and its body keeps the
  // full evaluator: joins and correlated subqueries both work inside it.
  assert.deepEqual(engine.execute("select a from t where a in (select a from (select a from t where a = 1) d)").rows, [[1]]);
  assert.deepEqual(
    engine.execute("select * from (select x.a, y.b from t x join t y on x.a = y.a where x.a = 2) d").rows,
    [[2, 20]],
  );
  assert.deepEqual(
    engine.execute(
      "select * from (select a from t where exists(select 1 from t u where u.a = t.a and u.b = 10)) d",
    ).rows,
    [[1]],
  );

  // An unaliased derived table has no qualifier. SQLite says
  // `no such column: t.a`; this engine has always reported an
  // unknown qualifier as `unknown-table`, so the contract is kept.
  const anonymous = engine.tryExecute("select t.a from (select a from t)");
  assert.equal(anonymous.ok, false);
  assert.equal(anonymous.error?.code, "unknown-table");
  // Duplicate output labels keep both positions and resolve to the first, as
  // SQLite does inside one source.
  assert.deepEqual(engine.execute("select a from (select a, a from t) d").rows, [[1], [2], [3]]);
});

test("CTEs evaluate once and shadow base tables with the same name", () => {
  const engine = derivedEngine();

  assert.deepEqual(engine.execute("with c as (select a from t) select * from c").rows, [[1], [2], [3]]);
  // The CTE wins over the real table `c`.
  assert.deepEqual(engine.execute("with c as (select a from t) select a from c where a = 1").rows, [[1]]);

  // A later CTE may read an earlier one; declared names rename the outputs.
  assert.deepEqual(engine.execute("with c(x) as (select a from t), d as (select x from c where x > 1) select * from d").rows, [
    [2],
    [3],
  ]);
  assert.deepEqual(engine.execute("with c as (select a, sum(b) as s from t group by a) select a, s from c").rows, [
    [1, 10],
    [2, 20],
    [3, 30],
  ]);

  // CTEs stay visible inside subqueries and joins of the statement.
  assert.deepEqual(engine.execute("with c as (select a from t) select (select count(*) from c) from t where a = 1").rows, [
    [3],
  ]);
  assert.deepEqual(engine.execute("with c as (select a from t) select c.a, t.b from c join t on c.a = t.a").rows, [
    [1, 10],
    [2, 20],
    [3, 30],
  ]);

  // A column list that disagrees with the body is rejected, not truncated.
  const arity = engine.tryExecute("with c(x, y) as (select a from t) select * from c");
  assert.equal(arity.ok, false);
  assert.equal(arity.error?.code, "arity-mismatch");
  assert.equal(arity.error?.clause, "WITH");

  const duplicate = engine.tryExecute("with c as (select a from t), c as (select b from t) select * from c");
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error?.code, "duplicate-table");
  assert.equal(duplicate.error?.clause, "WITH");
});

test("right joins and USING execute while non-aggregate HAVING reports a structured error", () => {
  const engine = joinEngine();

  assert.deepEqual(engine.execute("select l.a from l right join r on l.a = r.a").rows, [[1], [1], [3], [null]]);
  assert.deepEqual(engine.execute("select count(*) from l join r using (a)").rows, [[3]]);
  const having = engine.tryExecute("select a from l having a > 1");
  assert.equal(having.ok, false);
  assert.equal(having.error?.code, "misuse-of-aggregate");
  assert.equal(having.error?.clause, "HAVING");
  assert.match(having.error?.message ?? "", /HAVING clause on a non-aggregate query/);
});

test("instr, round and modulo follow the oracle exactly", () => {
  const engine = createEngine();
  assert.deepEqual(
    engine.execute("select instr('abcabc', 'bc'), instr('abc', 'z'), instr('abc', ''), instr('AbC', 'b')").rows,
    [[2, 0, 1, 2]],
  );
  // Rounding is fixed-point like SQLite: a half rounds away from zero on the
  // stored double, so `2.675` rounds down while `1.2345` rounds down too.
  assert.deepEqual(
    engine.execute("select round(1.2345, 3), round(123.456, -1), round(2.675, 2), round(1.005, 2)").rows,
    [[1.234, 123, 2.67, 1]],
  );
  // `%` truncates both operands to integers, keeps the dividend's sign, and
  // returns a real whenever either operand was real.
  assert.deepEqual(engine.execute("select 7 % 3, -7 % 3, 7.5 % 2, 7 % 2.5, 5 % 0").rows, [[1, -1, 1, 1, null]]);
  assert.deepEqual(engine.execute("select typeof(7.5 % 2), typeof(7 % 3)").rows, [["real", "integer"]]);
});

test("select distinct collapses duplicates before order by and limit", () => {
  const engine = createEngine();
  engine.exec("create table d (a integer, b text); insert into d values (1, 'x'), (1, 'x'), (2, 'y'), (null, 'z')");
  assert.deepEqual(engine.execute("select distinct a from d order by a").rows, [[null], [1], [2]]);
  assert.deepEqual(engine.execute("select distinct a from d order by a limit 2").rows, [[null], [1]]);
  assert.deepEqual(engine.execute("select distinct b, a from d order by a").rows, [["z", null], ["x", 1], ["y", 2]]);
  assert.deepEqual(engine.execute("select distinct 1 from d").rows, [[1]]);
});
